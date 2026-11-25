import { lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeSourceBuffer,
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
  it('decodes ordinary UTF-8, UTF-8 BOM, UTF-16LE BOM, and UTF-16BE BOM source buffers while stripping BOMs', () => {
    const sampleText = "export const label = 'café 🚀';\r\nexport const n = 1;\r\n";

    // 1. Ordinary UTF-8 baseline control
    const utf8Buf = Buffer.from(sampleText, 'utf8');
    expect(decodeSourceBuffer(utf8Buf)).toEqual({
      ok: true,
      content: sampleText,
      encoding: 'utf-8',
    });

    // 2. UTF-8 BOM
    const utf8BomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8Buf]);
    const utf8BomRes = decodeSourceBuffer(utf8BomBuf);
    expect(utf8BomRes).toEqual({
      ok: true,
      content: sampleText,
      encoding: 'utf-8-bom',
    });
    expect(utf8BomRes.ok && utf8BomRes.content.startsWith('\uFEFF')).toBe(false);

    // 3. UTF-16LE BOM
    const utf16LePayload = Buffer.from(sampleText, 'utf16le');
    const utf16LeBuf = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16LePayload]);
    const utf16LeRes = decodeSourceBuffer(utf16LeBuf);
    expect(utf16LeRes).toEqual({
      ok: true,
      content: sampleText,
      encoding: 'utf-16le-bom',
    });

    // 4. UTF-16BE BOM (swap 16-bit code units of UTF-16LE payload)
    const utf16BePayload = Buffer.from(utf16LePayload);
    utf16BePayload.swap16();
    const utf16BeBuf = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BePayload]);
    const utf16BeRes = decodeSourceBuffer(utf16BeBuf);
    expect(utf16BeRes).toEqual({
      ok: true,
      content: sampleText,
      encoding: 'utf-16be-bom',
    });
    // Ensure input buffer was not mutated by swap16
    expect(utf16BeBuf.subarray(2).equals(utf16BePayload)).toBe(true);
  });

  it('rejects malformed, truncated, unpaired-surrogate, and unsupported-BOM inputs without silently repairing text and preserves actual-byte accounting', async () => {
    const invalidCases: readonly { readonly name: string; readonly bytes: Buffer }[] = [
      { name: 'trunc-utf16le.ts', bytes: Buffer.from([0xff, 0xfe, 0x65]) }, // odd payload
      { name: 'trunc-utf16be.ts', bytes: Buffer.from([0xfe, 0xff, 0x00]) }, // odd payload
      { name: 'lone-surrogate-le.ts', bytes: Buffer.from([0xff, 0xfe, 0x3d, 0xd8]) }, // lone high surrogate U+D83D
      { name: 'lone-surrogate-be.ts', bytes: Buffer.from([0xfe, 0xff, 0xd8, 0x3d]) }, // lone high surrogate U+D83D
      { name: 'bad-utf8-bom.ts', bytes: Buffer.from([0xef, 0xbb, 0xbf, 0xc3]) }, // truncated UTF-8 after BOM
      { name: 'bad-utf8-raw.ts', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]) }, // BOM-less binary bytes
      {
        name: 'utf32le.ts',
        bytes: Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]),
      },
      {
        name: 'utf32be.ts',
        bytes: Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61]),
      },
    ];

    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    let expectedRawBytes = 0;

    for (const testCase of invalidCases) {
      expect(decodeSourceBuffer(testCase.bytes).ok, `Expected failure for ${testCase.name}`).toBe(
        false,
      );
      await writeFile(path.join(rootDir, 'src', testCase.name), testCase.bytes);
      expectedRawBytes += testCase.bytes.byteLength;
    }

    const validContent = 'export const ok = 1;\n';
    const validBuf = Buffer.from(validContent, 'utf8');
    await writeFile(path.join(rootDir, 'src', 'valid.ts'), validBuf);
    expectedRawBytes += validBuf.byteLength;

    const instrumented = createInstrumentedFsAdapter();
    const discovered = await discoverWorkspaceFiles({
      rootDir,
      fsAdapter: instrumented.adapter,
    });

    // Only valid.ts enters sourceFiles; malformed files are never emitted with repaired text
    expect(discovered.sourceFiles.map((f) => f.relativePath)).toEqual(['src/valid.ts']);
    expect(discovered.warnings).toHaveLength(invalidCases.length);
    for (const warning of discovered.warnings) {
      expect(warning.code).toBe('UNREADABLE_FILE');
    }
    // Every raw byte read from malformed files is still accounted for in totalBytesRead
    expect(discovered.totalBytesRead).toBe(expectedRawBytes);
    expect(instrumented.readMetrics.totalActualBytesRead).toBe(expectedRawBytes);
    expect(instrumented.closedBasenames).toEqual(instrumented.openedBasenames);
  });

  it('enforces raw byte limits, single-read semantics, and partial reads accurately on UTF-16LE BOM files', async () => {
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    const text = 'export const a = 1;\n'; // 20 ASCII chars -> 2 + 40 = 42 raw UTF-16LE BOM bytes
    const rawUtf16Le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(rawUtf16Le.byteLength).toBe(42);
    await writeFile(path.join(rootDir, 'src', 'utf16.ts'), rawUtf16Le);

    // Exact raw-byte fit with partial reads (7 bytes per chunk) -> decoded cleanly in one open/close
    const exactFit = createInstrumentedFsAdapter({ maxBytesPerRead: 7 });
    const discovered = await discoverWorkspaceFiles({
      rootDir,
      maxFileBytes: 42,
      maxTotalBytes: 42,
      fsAdapter: exactFit.adapter,
    });
    expect(discovered.sourceFiles).toEqual([
      {
        relativePath: 'src/utf16.ts',
        content: text,
        byteLength: 42, // raw file bytes, NOT decoded char length (20)
      },
    ]);
    expect(discovered.totalBytesRead).toBe(42);
    expect(exactFit.readMetrics.totalActualBytesRead).toBe(42);
    expect(exactFit.openedBasenames).toEqual(['utf16.ts']);
    expect(exactFit.closedBasenames).toEqual(['utf16.ts']);

    // Per-file limit of 41 (< 42 raw bytes, even though > 20 decoded chars) rejects from metadata with 0 reads
    const perFileTight = createInstrumentedFsAdapter();
    const skipped = await discoverWorkspaceFiles({
      rootDir,
      maxFileBytes: 41,
      maxTotalBytes: 100,
      fsAdapter: perFileTight.adapter,
    });
    expect(skipped.sourceFiles).toEqual([]);
    expect(skipped.skippedOversizedFilesCount).toBe(1);
    expect(skipped.totalBytesRead).toBe(0);
    expect(perFileTight.openedBasenames).toEqual([]);

    // Global limit of 41 (< 42 raw bytes) trips SIZE_LIMIT_EXCEEDED without exceeding 41 bytes read
    const globalTight = createInstrumentedFsAdapter({ maxBytesPerRead: 7 });
    await expect(
      discoverWorkspaceFiles({
        rootDir,
        maxFileBytes: 100,
        maxTotalBytes: 41,
        fsAdapter: globalTight.adapter,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });
    expect(globalTight.readMetrics.totalActualBytesRead).toBeLessThanOrEqual(41);
    expect(globalTight.closedBasenames).toEqual(globalTight.openedBasenames);
  });
});
