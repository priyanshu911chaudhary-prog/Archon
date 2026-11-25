import { lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverWorkspaceFiles,
  validateRepoRelativePath,
  type ReadableFileHandle,
  type WorkspaceFsAdapter,
} from './discovery.js';
import { CoreAnalysisError } from './errors.js';

describe('discoverWorkspaceFiles and validateRepoRelativePath', () => {
  let rootDir = '';
  let outsideDir = '';

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'archon-discovery-root-'));
    outsideDir = await mkdtemp(path.join(os.tmpdir(), 'archon-discovery-outside-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('rejects absolute paths, Windows drive paths, and traversal segments', () => {
    const invalidPaths = [
      '',
      '/etc/passwd',
      '\\windows\\system32\\a.ts',
      'C:\\dev\\a.ts',
      '../secret.ts',
      'src/../secret.ts',
      'src/./a.ts',
      'src//a.ts',
      'src/bad\u0000.ts',
    ];

    for (const p of invalidPaths) {
      expect(() => validateRepoRelativePath(p), `Expected rejection for ${p}`).toThrow(
        CoreAnalysisError,
      );
    }

    expect(validateRepoRelativePath('src\\lib\\util.ts')).toBe('src/lib/util.ts');
  });

  it('deduplicates normalized input paths and enforces file-count and actual byte-read limits', async () => {
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    await writeFile(path.join(rootDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(path.join(rootDir, 'src', 'b.ts'), 'export const b = "1234567890";\n', 'utf8');

    const deduped = await discoverWorkspaceFiles({
      rootDir,
      supportedFiles: ['src/a.ts', 'src\\a.ts', 'src/b.ts'],
    });
    expect(deduped.sourceFiles.map((f) => f.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);

    // Per-file byte limit skips oversized file without failing workspace
    const perFileLimited = await discoverWorkspaceFiles({
      rootDir,
      maxFileBytes: 22,
    });
    expect(perFileLimited.sourceFiles.map((f) => f.relativePath)).toEqual(['src/a.ts']);
    expect(perFileLimited.skippedOversizedFilesCount).toBe(1);
    expect(perFileLimited.warnings.some((w) => w.code === 'OVERSIZED_FILE_SKIPPED')).toBe(true);

    // Total bytes read cap fails closed
    await expect(
      discoverWorkspaceFiles({
        rootDir,
        maxTotalBytes: 25,
      }),
    ).rejects.toThrow(CoreAnalysisError);

    // Supported file count cap fails closed
    await expect(
      discoverWorkspaceFiles({
        rootDir,
        maxSupportedFiles: 1,
      }),
    ).rejects.toThrow(CoreAnalysisError);
  });

  it('skips unsafe directory symlinks/junctions escaping the workspace and never leaks host paths', async (ctx) => {
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    await writeFile(path.join(rootDir, 'src', 'safe.ts'), 'export const safe = true;\n', 'utf8');
    await writeFile(path.join(outsideDir, 'secret.ts'), 'export const secret = "nope";\n', 'utf8');

    const linkPath = path.join(rootDir, 'src', 'escape-link');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const unsupportedLinkErrorCodes = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP']);

    try {
      await symlink(outsideDir, linkPath, linkType);
    } catch (err) {
      const errCode =
        err instanceof Error && 'code' in err && typeof err.code === 'string'
          ? err.code
          : undefined;
      if (errCode !== undefined && unsupportedLinkErrorCodes.has(errCode)) {
        ctx.skip(`Symlink/junction creation unavailable in this environment (${errCode})`);
        return;
      }
      throw err;
    }

    const discovered = await discoverWorkspaceFiles({ rootDir });
    expect(discovered.sourceFiles.map((f) => f.relativePath)).toEqual(['src/safe.ts']);
    expect(discovered.warnings.some((w) => w.code === 'UNSAFE_SYMLINK_SKIPPED')).toBe(true);

    // Ensure no absolute host path leaks in warnings
    for (const warning of discovered.warnings) {
      expect(warning.message).not.toContain(rootDir);
      expect(warning.message).not.toContain(outsideDir);
      expect(warning.filePath).not.toContain(rootDir);
    }

    // Explicit input pointing through an unsafe symlink must be rejected
    await expect(
      discoverWorkspaceFiles({
        rootDir,
        supportedFiles: ['src/escape-link/secret.ts'],
      }),
    ).rejects.toThrow(CoreAnalysisError);
  });
  function createInstrumentedFsAdapter(
    options: {
      readonly reportedStatSizeByBasename?: Readonly<Record<string, number>>;
      readonly overrideContentByBasename?: Readonly<Record<string, Buffer>>;
      readonly maxBytesPerRead?: number;
    } = {},
  ) {
    const openedBasenames: string[] = [];
    const closedBasenames: string[] = [];
    const readMetrics = {
      totalActualBytesRead: 0,
      maxSingleReadRequest: 0,
    };

    const adapter: WorkspaceFsAdapter = {
      lstat: async (targetPath: string) => {
        const real = await lstat(targetPath);
        const base = path.basename(targetPath);
        const overrideSize = options.reportedStatSizeByBasename?.[base];
        if (overrideSize === undefined) {
          return real;
        }
        return {
          size: overrideSize,
          isDirectory: () => real.isDirectory(),
          isSymbolicLink: () => real.isSymbolicLink(),
          isFile: () => real.isFile(),
        };
      },
      realpath: (targetPath: string) => realpath(targetPath),
      open: async (targetPath: string, flags: string): Promise<ReadableFileHandle> => {
        const base = path.basename(targetPath);
        openedBasenames.push(base);

        const overrideBuf = options.overrideContentByBasename?.[base];
        if (overrideBuf !== undefined) {
          let cursor = 0;
          return {
            read: (buffer, offset, length) => {
              readMetrics.maxSingleReadRequest = Math.max(readMetrics.maxSingleReadRequest, length);
              const cap =
                options.maxBytesPerRead !== undefined
                  ? Math.min(length, options.maxBytesPerRead)
                  : length;
              const remaining = Math.max(0, overrideBuf.byteLength - cursor);
              const toCopy = Math.min(cap, remaining);
              if (toCopy > 0) {
                overrideBuf.copy(buffer, offset, cursor, cursor + toCopy);
                cursor += toCopy;
                readMetrics.totalActualBytesRead += toCopy;
              }
              return Promise.resolve({ bytesRead: toCopy });
            },
            stat: () => Promise.resolve({ size: overrideBuf.byteLength }),
            close: () => {
              closedBasenames.push(base);
              return Promise.resolve();
            },
          };
        }

        const realHandle = await open(targetPath, flags);
        return {
          read: async (buffer, offset, length, position) => {
            readMetrics.maxSingleReadRequest = Math.max(readMetrics.maxSingleReadRequest, length);
            const cap =
              options.maxBytesPerRead !== undefined
                ? Math.min(length, options.maxBytesPerRead)
                : length;
            const res = await realHandle.read(buffer, offset, cap, position);
            readMetrics.totalActualBytesRead += res.bytesRead;
            return res;
          },
          stat: () => realHandle.stat(),
          close: async () => {
            try {
              await realHandle.close();
            } finally {
              closedBasenames.push(base);
            }
          },
        };
      },
    };

    return { adapter, openedBasenames, closedBasenames, readMetrics };
  }

  it('enforces exact per-file and global budget boundaries and skips metadata-oversized files with zero bytes read', async () => {
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    // Exactly 10 bytes each
    await writeFile(path.join(rootDir, 'src', 'exact1.ts'), '0123456789', 'utf8');
    await writeFile(path.join(rootDir, 'src', 'exact2.ts'), 'abcdefghij', 'utf8');
    // 11 bytes (> maxFileBytes: 10) -> rejected by metadata before open()
    await writeFile(path.join(rootDir, 'src', 'big.ts'), '0123456789X', 'utf8');

    const instrumented = createInstrumentedFsAdapter();
    const exactFit = await discoverWorkspaceFiles({
      rootDir,
      maxFileBytes: 10,
      maxTotalBytes: 20,
      fsAdapter: instrumented.adapter,
    });

    expect(exactFit.sourceFiles.map((f) => f.relativePath)).toEqual([
      'src/exact1.ts',
      'src/exact2.ts',
    ]);
    expect(exactFit.skippedOversizedFilesCount).toBe(1);
    expect(exactFit.totalBytesRead).toBe(20);
    expect(instrumented.readMetrics.totalActualBytesRead).toBe(20);
    // big.ts was rejected from metadata and never opened or read
    expect(instrumented.openedBasenames).toEqual(['exact1.ts', 'exact2.ts']);
    expect(instrumented.closedBasenames).toEqual(['exact1.ts', 'exact2.ts']);

    // Lowering maxTotalBytes by 1 byte (19) causes exact2.ts to fail without ever reading byte #20
    const tight = createInstrumentedFsAdapter();
    await expect(
      discoverWorkspaceFiles({
        rootDir,
        maxFileBytes: 10,
        maxTotalBytes: 19,
        fsAdapter: tight.adapter,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });

    expect(tight.readMetrics.totalActualBytesRead).toBeLessThanOrEqual(19);
    expect(tight.closedBasenames).toEqual(tight.openedBasenames);
  });

  it('counts bytes consumed from files detected as oversized during reading and blocks cumulative bypass via repeated oversized reads', async () => {
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    // Placeholder files on disk; deterministic fsAdapter reports lstat.size = 8 while actual content is 15 bytes
    await writeFile(path.join(rootDir, 'src', 'g1.ts'), '12345678', 'utf8');
    await writeFile(path.join(rootDir, 'src', 'g2.ts'), '12345678', 'utf8');
    await writeFile(path.join(rootDir, 'src', 'g3.ts'), '12345678', 'utf8');
    await writeFile(path.join(rootDir, 'src', 'ok.ts'), '12345', 'utf8');

    const grown15 = Buffer.from('0123456789ABCDE', 'utf8');

    // Case 1: Single grown oversized file read and skipped -> its 11 consumed bytes count toward totalBytesRead
    const singleRun = createInstrumentedFsAdapter({
      reportedStatSizeByBasename: { 'g1.ts': 8 },
      overrideContentByBasename: { 'g1.ts': grown15 },
    });
    const singleOut = await discoverWorkspaceFiles({
      rootDir,
      supportedFiles: ['src/g1.ts', 'src/ok.ts'],
      maxFileBytes: 10,
      maxTotalBytes: 16, // 11 bytes consumed from g1.ts + 5 bytes from ok.ts = 16 exact fit
      fsAdapter: singleRun.adapter,
    });

    expect(singleOut.sourceFiles.map((f) => f.relativePath)).toEqual(['src/ok.ts']);
    expect(singleOut.skippedOversizedFilesCount).toBe(1);
    expect(singleOut.totalBytesRead).toBe(16);
    expect(singleRun.readMetrics.totalActualBytesRead).toBe(16);
    expect(singleRun.closedBasenames).toEqual(singleRun.openedBasenames);

    // Case 2: Repeated oversized files cannot bypass maxTotalBytes (11 + 11 + 3 = 25 -> stops at 25 without overshooting)
    const repeatedRun = createInstrumentedFsAdapter({
      reportedStatSizeByBasename: { 'g1.ts': 8, 'g2.ts': 8, 'g3.ts': 8 },
      overrideContentByBasename: { 'g1.ts': grown15, 'g2.ts': grown15, 'g3.ts': grown15 },
    });
    await expect(
      discoverWorkspaceFiles({
        rootDir,
        supportedFiles: ['src/g1.ts', 'src/g2.ts', 'src/g3.ts'],
        maxFileBytes: 10,
        maxTotalBytes: 25,
        fsAdapter: repeatedRun.adapter,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });

    expect(repeatedRun.readMetrics.totalActualBytesRead).toBeLessThanOrEqual(25);
    expect(repeatedRun.closedBasenames).toEqual(repeatedRun.openedBasenames);
  });

  it('shares one global byte budget across source files and config files', async () => {
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    await writeFile(path.join(rootDir, 'src', 'a.ts'), '0123456789', 'utf8'); // 10 bytes
    await writeFile(path.join(rootDir, 'tsconfig.json'), '{"a":1234}', 'utf8'); // 10 bytes

    // Exact fit: 10 (source) + 10 (config) = 20
    const fit = await discoverWorkspaceFiles({
      rootDir,
      maxFileBytes: 20,
      maxTotalBytes: 20,
    });
    expect(fit.sourceFiles).toHaveLength(1);
    expect(fit.configFiles).toHaveLength(1);
    expect(fit.totalBytesRead).toBe(20);

    // Budget 19 -> config file read trips global budget without exceeding 19 bytes read
    const instrumented = createInstrumentedFsAdapter();
    await expect(
      discoverWorkspaceFiles({
        rootDir,
        maxFileBytes: 20,
        maxTotalBytes: 19,
        fsAdapter: instrumented.adapter,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });

    expect(instrumented.readMetrics.totalActualBytesRead).toBeLessThanOrEqual(19);
    expect(instrumented.closedBasenames).toEqual(instrumented.openedBasenames);
  });

  it('handles deterministic partial reads and file growth across exact and overflow boundaries without exceeding maxTotalBytes', async () => {
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    await writeFile(path.join(rootDir, 'src', 'p1.ts'), '0123456789', 'utf8'); // 10 bytes
    await writeFile(path.join(rootDir, 'src', 'p2.ts'), 'abcdefghij', 'utf8'); // 10 bytes

    // Partial reads (3 bytes per call) fitting exact global budget (20 bytes)
    const partialFit = createInstrumentedFsAdapter({ maxBytesPerRead: 3 });
    const out = await discoverWorkspaceFiles({
      rootDir,
      maxFileBytes: 10,
      maxTotalBytes: 20,
      fsAdapter: partialFit.adapter,
    });
    expect(out.sourceFiles.map((f) => f.content)).toEqual(['0123456789', 'abcdefghij']);
    expect(out.totalBytesRead).toBe(20);
    expect(partialFit.readMetrics.totalActualBytesRead).toBe(20);
    expect(partialFit.readMetrics.maxSingleReadRequest).toBeLessThanOrEqual(11);
    expect(partialFit.closedBasenames).toEqual(['p1.ts', 'p2.ts']);

    // Partial reads (3 bytes per call) on a file that grew from 5 to 11 bytes with global cap 10 (< maxFileBytes 15)
    const partialOverflow = createInstrumentedFsAdapter({
      reportedStatSizeByBasename: { 'p1.ts': 5 },
      overrideContentByBasename: { 'p1.ts': Buffer.from('0123456789X', 'utf8') },
      maxBytesPerRead: 3,
    });
    await expect(
      discoverWorkspaceFiles({
        rootDir,
        supportedFiles: ['src/p1.ts'],
        maxFileBytes: 15,
        maxTotalBytes: 10,
        fsAdapter: partialOverflow.adapter,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });

    expect(partialOverflow.readMetrics.totalActualBytesRead).toBe(10);
    expect(partialOverflow.readMetrics.maxSingleReadRequest).toBeLessThanOrEqual(10);
    expect(partialOverflow.closedBasenames).toEqual(['p1.ts']);
  });
});
