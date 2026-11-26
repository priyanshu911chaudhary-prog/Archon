import { createWriteStream, existsSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TarballExtractionError } from './errors.js';
import { withExtractedRepo, type ExtractGitHubTarballOptions } from './github-tarball.js';
import { buildGzippedUstar, type UstarFixtureEntry } from './tar-test-utils.js';
import { gzipSync } from 'node:zlib';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();

  return {
    ...actual,
    createWriteStream: vi.fn(actual.createWriteStream),
  };
});

type FetchInput = Parameters<typeof globalThis.fetch>[0];

const OWNER = 'pmndrs';
const NAME = 'zustand';
const SHA = '9fed2eb2f3af672da9f7bf694b996df3831fc207';
const PREFIX = 'pmndrs-zustand-9fed2eb';
const API_URL = `https://api.github.com/repos/${OWNER}/${NAME}/tarball/${SHA}`;
const CODELOAD_URL = `https://codeload.github.com/${OWNER}/${NAME}/legacy.tar.gz/${SHA}`;
const TEST_TOKEN = 'github_pat_unit_test_secret_token';

function extractUrl(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function getHeader(headers: RequestInit['headers'], name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return match?.[1];
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

interface RecordedCall {
  readonly url: string;
  readonly redirect?: RequestInit['redirect'];
  readonly authorization?: string;
}

function createTarballMockFetch(
  archive: Buffer,
  options: {
    readonly redirectLocation?: string;
    readonly redirectStatus?: number;
    readonly codeloadStatus?: number;
    readonly codeloadContentType?: string | null;
    readonly codeloadLocation?: string;
    readonly calls?: RecordedCall[];
  } = {},
): typeof globalThis.fetch {
  return (input, init) => {
    const url = extractUrl(input);
    options.calls?.push({
      url,
      redirect: init?.redirect,
      authorization: getHeader(init?.headers, 'authorization'),
    });

    if (url === API_URL) {
      const status = options.redirectStatus ?? 302;
      const headers: Record<string, string> = {};
      if (options.redirectLocation !== undefined) {
        headers.location = options.redirectLocation;
      } else if (status >= 300 && status < 400) {
        headers.location = CODELOAD_URL;
      }
      return Promise.resolve(new Response(null, { status, headers }));
    }

    if (url === (options.redirectLocation ?? CODELOAD_URL)) {
      const status = options.codeloadStatus ?? 200;
      const headers: Record<string, string> = {};
      if (options.codeloadContentType !== null) {
        headers['content-type'] = options.codeloadContentType ?? 'application/x-gzip';
      }
      if (options.codeloadLocation) {
        headers.location = options.codeloadLocation;
      }
      const body = status === 200 ? new Uint8Array(archive) : null;
      return Promise.resolve(new Response(body, { status, headers }));
    }

    return Promise.resolve(new Response(null, { status: 404 }));
  };
}

async function expectTarballError(
  promise: Promise<unknown>,
  expectedCode: TarballExtractionError['code'],
): Promise<TarballExtractionError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TarballExtractionError);
    if (err instanceof TarballExtractionError) {
      expect(err.code).toBe(expectedCode);
      return err;
    }
  }
  throw new Error(`Expected TarballExtractionError(${expectedCode}) to be thrown`);
}

describe('withExtractedRepo (safe GitHub tarball extractor)', () => {
  let tempBaseDir = '';

  beforeEach(async () => {
    tempBaseDir = await mkdtemp(path.join(os.tmpdir(), 'archon-extractor-test-base-'));
  });

  afterEach(async () => {
    if (tempBaseDir) {
      await rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  function baseOptions(
    fetchImpl: typeof globalThis.fetch,
    overrides: Partial<ExtractGitHubTarballOptions> = {},
  ): ExtractGitHubTarballOptions {
    return {
      owner: OWNER,
      name: NAME,
      commitSha: SHA,
      token: TEST_TOKEN,
      tempBaseDir,
      fetchImpl,
      ...overrides,
    };
  }

  it('strips top-level prefix, writes only supported + config files, skips non-code/ignored/Windows-reserved skipped files, never forwards token, and purges temp dir', async () => {
    const entries: UstarFixtureEntry[] = [
      { path: `${PREFIX}/`, typeFlag: '5' },
      { path: `${PREFIX}/src/`, typeFlag: '5' },
      { path: `${PREFIX}/src/index.ts`, content: 'export const ok = true;\n' },
      { path: `${PREFIX}/src/util.tsx`, content: 'export const UI = () => null;\n' },
      { path: `${PREFIX}/tsconfig.json`, content: '{"compilerOptions":{"strict":true}}\n' },
      { path: `${PREFIX}/package.json`, content: '{"name":"sample"}\n' },
      // Skipped non-code, ignored dirs, declaration files, and Windows-reserved skipped files (amendment c)
      { path: `${PREFIX}/README.md`, content: '# readme\n' },
      { path: `${PREFIX}/docs/CON.md`, content: 'skipped doc with reserved name\n' },
      { path: `${PREFIX}/docs/foo./notes.txt`, content: 'skipped trailing dot dir\n' },
      { path: `${PREFIX}/src/types.d.ts`, content: 'export type T = string;\n' },
      { path: `${PREFIX}/node_modules/pkg/index.js`, content: 'module.exports = 1;\n' },
      { path: `${PREFIX}/dist/index.js`, content: 'export {};\n' },
    ];
    const archive = buildGzippedUstar(entries);
    const calls: RecordedCall[] = [];
    let capturedRootDir = '';

    const callbackResult = await withExtractedRepo(
      baseOptions(createTarballMockFetch(archive, { calls })),
      async (workspace) => {
        capturedRootDir = workspace.rootDir;
        expect(workspace.topLevelPrefix).toBe(PREFIX);
        expect(workspace.supportedFiles).toEqual(['src/index.ts', 'src/util.tsx']);
        expect(workspace.configFiles).toEqual(['package.json', 'tsconfig.json']);
        expect(workspace.stats.supportedFilesCount).toBe(2);
        expect(workspace.stats.configFilesCount).toBe(2);
        expect(workspace.stats.skippedFilesCount).toBe(6);
        expect(workspace.stats.oversizedSkippedFilesCount).toBe(0);

        const content = await readFile(path.join(workspace.rootDir, 'src', 'index.ts'), 'utf8');
        expect(content).toBe('export const ok = true;\n');
        expect(existsSync(path.join(workspace.rootDir, 'README.md'))).toBe(false);
        expect(existsSync(path.join(workspace.rootDir, 'docs'))).toBe(false);
        return 'done';
      },
    );

    expect(callbackResult).toBe('done');
    // Redirect & token checks: API call carries Bearer PAT; codeload call carries NO Authorization
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(API_URL);
    expect(calls[0]?.redirect).toBe('manual');
    expect(calls[0]?.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(calls[1]?.url).toBe(CODELOAD_URL);
    expect(calls[1]?.redirect).toBe('manual');
    expect(calls[1]?.authorization).toBeUndefined();

    // Unconditional cleanup verified via injectable tempBaseDir
    expect(existsSync(capturedRootDir)).toBe(false);
    expect(await readdir(tempBaseDir)).toEqual([]);
  });

  it('marks truncated gzip downloads as retryable TARBALL_PARSE_ERROR and corrupt/empty tar archives as non-retryable', async () => {
    // 1. Truncated gzipped archive -> gunzip fails mid-stream -> retryable: true
    const validArchive = buildGzippedUstar([
      { path: `${PREFIX}/src/a.ts`, content: 'export const value = "hello world";\n'.repeat(20) },
    ]);
    const truncatedArchive = validArchive.subarray(0, Math.floor(validArchive.length / 2));

    const truncatedErr = await expectTarballError(
      withExtractedRepo(baseOptions(createTarballMockFetch(truncatedArchive)), () =>
        Promise.resolve(),
      ),
      'TARBALL_PARSE_ERROR',
    );
    expect(truncatedErr.retryable).toBe(true);
    expect(await readdir(tempBaseDir)).toEqual([]);

    // 2. Valid gzip wrapping corrupt tar header bytes -> tar Parser fails -> retryable: false
    const corruptTarHeader = gzipSync(Buffer.alloc(1024, 0x41));
    const corruptErr = await expectTarballError(
      withExtractedRepo(baseOptions(createTarballMockFetch(corruptTarHeader)), () =>
        Promise.resolve(),
      ),
      'TARBALL_PARSE_ERROR',
    );
    expect(corruptErr.retryable).toBe(false);
    expect(await readdir(tempBaseDir)).toEqual([]);

    // 3. Valid gzip wrapping empty tar archive (EOF zero blocks only) -> retryable: false
    const emptyTarArchive = gzipSync(Buffer.alloc(1024, 0));
    const emptyErr = await expectTarballError(
      withExtractedRepo(baseOptions(createTarballMockFetch(emptyTarArchive)), () =>
        Promise.resolve(),
      ),
      'TARBALL_PARSE_ERROR',
    );
    expect(emptyErr.retryable).toBe(false);
    expect(await readdir(tempBaseDir)).toEqual([]);
  });

  it('rejects zip-slip, traversal, absolute paths, backslashes, and multiple top-level folders', async () => {
    const maliciousCases: readonly (readonly UstarFixtureEntry[])[] = [
      [{ path: `${PREFIX}/../evil.ts`, content: 'bad' }],
      [{ path: '/etc/passwd', content: 'bad' }],
      [{ path: `${PREFIX}/src/../a.ts`, content: 'bad' }],
      [
        { path: `${PREFIX}/src/a.ts`, content: 'ok' },
        { path: 'other-root/src/b.ts', content: 'outside single top-level folder' },
      ],
    ];

    for (const entries of maliciousCases) {
      const archive = buildGzippedUstar(entries);
      await expectTarballError(
        withExtractedRepo(baseOptions(createTarballMockFetch(archive)), () =>
          Promise.resolve('unreachable'),
        ),
        'TARBALL_SECURITY_VIOLATION',
      );
      expect(await readdir(tempBaseDir)).toEqual([]);
    }
  });

  it('strictly rejects symlinks, hardlinks, and device/FIFO entries', async () => {
    const specialCases: readonly UstarFixtureEntry[] = [
      { path: `${PREFIX}/src/sym.ts`, typeFlag: '2', linkName: '/etc/passwd' },
      { path: `${PREFIX}/src/hard.ts`, typeFlag: '1', linkName: `${PREFIX}/src/a.ts` },
      { path: `${PREFIX}/docs/fifo`, typeFlag: '6' },
      { path: `${PREFIX}/docs/chrdev`, typeFlag: '3' },
    ];

    for (const badEntry of specialCases) {
      const archive = buildGzippedUstar([
        { path: `${PREFIX}/src/a.ts`, content: 'export const a = 1;\n' },
        badEntry,
      ]);
      await expectTarballError(
        withExtractedRepo(baseOptions(createTarballMockFetch(archive)), () =>
          Promise.resolve('unreachable'),
        ),
        'TARBALL_SECURITY_VIOLATION',
      );
      expect(await readdir(tempBaseDir)).toEqual([]);
    }
  });

  it('rejects Windows-reserved names and trailing dots on paths we would write', async () => {
    const badWritePaths = [
      `${PREFIX}/src/CON.ts`,
      `${PREFIX}/aux/index.ts`,
      `${PREFIX}/src/nul.js`,
      `${PREFIX}/src/foo./index.ts`,
      `${PREFIX}/src/bar /index.ts`,
    ];

    for (const badPath of badWritePaths) {
      const archive = buildGzippedUstar([{ path: badPath, content: 'export const x = 1;\n' }]);
      await expectTarballError(
        withExtractedRepo(baseOptions(createTarballMockFetch(archive)), () =>
          Promise.resolve('unreachable'),
        ),
        'TARBALL_SECURITY_VIOLATION',
      );
      expect(await readdir(tempBaseDir)).toEqual([]);
    }
  });

  it('skips files exceeding maxFileBytes (amendment a) while failing when total written bytes exceed maxWrittenBytes', async () => {
    // Oversize single file is skipped and counted
    const skipArchive = buildGzippedUstar([
      { path: `${PREFIX}/src/small.ts`, content: 'export const ok = 1;\n' },
      { path: `${PREFIX}/src/bundle.js`, content: 'x'.repeat(200) },
    ]);

    await withExtractedRepo(
      baseOptions(createTarballMockFetch(skipArchive), {
        maxFileBytes: 100,
        maxWrittenBytes: 500,
      }),
      (workspace) => {
        expect(workspace.supportedFiles).toEqual(['src/small.ts']);
        expect(workspace.stats.skippedFilesCount).toBe(1);
        expect(workspace.stats.oversizedSkippedFilesCount).toBe(1);
        return Promise.resolve();
      },
    );

    // Multiple small files whose cumulative size exceeds maxWrittenBytes fail the whole extraction
    const totalOverflowArchive = buildGzippedUstar([
      { path: `${PREFIX}/src/a.ts`, content: 'a'.repeat(80) },
      { path: `${PREFIX}/src/b.ts`, content: 'b'.repeat(80) },
    ]);
    await expectTarballError(
      withExtractedRepo(
        baseOptions(createTarballMockFetch(totalOverflowArchive), {
          maxFileBytes: 100,
          maxWrittenBytes: 120,
        }),
        () => Promise.resolve(),
      ),
      'TARBALL_SIZE_LIMIT_EXCEEDED',
    );
    expect(await readdir(tempBaseDir)).toEqual([]);
  });

  it('enforces compressed byte cap and decompressed stream cap (tar/gzip bomb guard)', async () => {
    // Highly compressible 64 KiB zeroed file compresses to <500 bytes, triggers decompressed stream cap
    const bombArchive = buildGzippedUstar([
      { path: `${PREFIX}/docs/huge.txt`, content: '0'.repeat(64 * 1024) },
    ]);
    expect(bombArchive.length).toBeLessThan(2048);

    await expectTarballError(
      withExtractedRepo(
        baseOptions(createTarballMockFetch(bombArchive), {
          maxCompressedBytes: 100 * 1024,
          maxDecompressedBytes: 8 * 1024,
        }),
        () => Promise.resolve(),
      ),
      'TARBALL_SIZE_LIMIT_EXCEEDED',
    );

    // Compressed byte cap rejection
    await expectTarballError(
      withExtractedRepo(
        baseOptions(createTarballMockFetch(bombArchive), {
          maxCompressedBytes: 32,
        }),
        () => Promise.resolve(),
      ),
      'TARBALL_SIZE_LIMIT_EXCEEDED',
    );
    expect(await readdir(tempBaseDir)).toEqual([]);
  });

  it('enforces maxSupportedFiles and maxConfigFiles limits', async () => {
    const tooManySupported = buildGzippedUstar([
      { path: `${PREFIX}/src/a.ts`, content: 'export const a = 1;' },
      { path: `${PREFIX}/src/b.ts`, content: 'export const b = 2;' },
      { path: `${PREFIX}/src/c.ts`, content: 'export const c = 3;' },
    ]);
    await expectTarballError(
      withExtractedRepo(
        baseOptions(createTarballMockFetch(tooManySupported), { maxSupportedFiles: 2 }),
        () => Promise.resolve(),
      ),
      'TARBALL_FILE_LIMIT_EXCEEDED',
    );

    const tooManyConfigs = buildGzippedUstar([
      { path: `${PREFIX}/package.json`, content: '{}' },
      { path: `${PREFIX}/tsconfig.json`, content: '{}' },
      { path: `${PREFIX}/jsconfig.json`, content: '{}' },
    ]);
    await expectTarballError(
      withExtractedRepo(
        baseOptions(createTarballMockFetch(tooManyConfigs), { maxConfigFiles: 2 }),
        () => Promise.resolve(),
      ),
      'TARBALL_FILE_LIMIT_EXCEEDED',
    );
    expect(await readdir(tempBaseDir)).toEqual([]);
  });

  it('rejects disallowed redirect hosts, non-HTTPS redirects, secondary redirects, non-200 codeload, and bad Content-Type (amendment d)', async () => {
    const archive = buildGzippedUstar([{ path: `${PREFIX}/src/a.ts`, content: 'export {};' }]);

    const badRedirects = [
      'https://evil.example.com/archive.tar.gz',
      'https://codeload.github.com.evil.com/archive.tar.gz',
      'http://codeload.github.com/pmndrs/zustand/legacy.tar.gz/abc',
      'https://codeload.github.com:444/pmndrs/zustand/legacy.tar.gz/abc',
      'https://user:pass@codeload.github.com/pmndrs/zustand/legacy.tar.gz/abc',
    ];
    for (const loc of badRedirects) {
      await expectTarballError(
        withExtractedRepo(
          baseOptions(createTarballMockFetch(archive, { redirectLocation: loc })),
          () => Promise.resolve(),
        ),
        'TARBALL_REDIRECT_REJECTED',
      );
    }

    // Secondary redirect from codeload
    await expectTarballError(
      withExtractedRepo(
        baseOptions(
          createTarballMockFetch(archive, {
            codeloadStatus: 302,
            codeloadLocation: 'https://codeload.github.com/other',
          }),
        ),
        () => Promise.resolve(),
      ),
      'TARBALL_REDIRECT_REJECTED',
    );

    // Non-200 from codeload
    await expectTarballError(
      withExtractedRepo(baseOptions(createTarballMockFetch(archive, { codeloadStatus: 500 })), () =>
        Promise.resolve(),
      ),
      'TARBALL_UPSTREAM_ERROR',
    );

    // Unexpected Content-Type (e.g. text/html error page with 200)
    await expectTarballError(
      withExtractedRepo(
        baseOptions(createTarballMockFetch(archive, { codeloadContentType: 'text/html' })),
        () => Promise.resolve(),
      ),
      'TARBALL_UPSTREAM_ERROR',
    );

    expect(await readdir(tempBaseDir)).toEqual([]);
  });

  it('aborts on timeout and unconditionally cleans up temp dir when callback throws', async () => {
    // 1. Timeout via AbortSignal
    const hangingFetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    await expectTarballError(
      withExtractedRepo(baseOptions(hangingFetch, { timeoutMs: 40 }), () => Promise.resolve()),
      'TARBALL_TIMEOUT',
    );
    expect(await readdir(tempBaseDir)).toEqual([]);

    // 2. Callback throws -> tempDir still purged in try/finally
    const archive = buildGzippedUstar([{ path: `${PREFIX}/src/a.ts`, content: 'export {};' }]);
    let capturedDir = '';

    await expect(
      withExtractedRepo(baseOptions(createTarballMockFetch(archive)), (workspace) => {
        capturedDir = workspace.rootDir;
        expect(existsSync(capturedDir)).toBe(true);
        return Promise.reject(new Error('Simulated parser failure'));
      }),
    ).rejects.toThrow('Simulated parser failure');

    expect(existsSync(capturedDir)).toBe(false);
    expect(await readdir(tempBaseDir)).toEqual([]);
  });
  it('classifies external AbortSignal cancellation as TARBALL_CANCELLED with fixed safe message before fetch, during fetch, between fetches, and before callback', async () => {
    const rawSecretReason = 'RAW_EXTERNAL_ABORT_REASON_SECRET_123';

    // 1. Already aborted before extraction starts -> zero fetch calls, zero temp dirs left
    let fetchCalls = 0;
    const countingFetch: typeof globalThis.fetch = () => {
      fetchCalls += 1;
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const preAborted = new AbortController();
    preAborted.abort(new Error(rawSecretReason));

    const preErr = await expectTarballError(
      withExtractedRepo(baseOptions(countingFetch, { signal: preAborted.signal }), () =>
        Promise.resolve(),
      ),
      'TARBALL_CANCELLED',
    );
    expect(preErr.retryable).toBe(true);
    expect(preErr.message).not.toContain(rawSecretReason);
    expect(fetchCalls).toBe(0);
    expect(await readdir(tempBaseDir)).toEqual([]);

    // 2. External abort fires during hanging fetch -> TARBALL_CANCELLED (not TARBALL_TIMEOUT)
    const duringFetchAbort = new AbortController();
    const slowFetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
        setTimeout(() => {
          duringFetchAbort.abort(new Error(rawSecretReason));
        }, 15);
      });

    const fetchErr = await expectTarballError(
      withExtractedRepo(
        baseOptions(slowFetch, { timeoutMs: 5_000, signal: duringFetchAbort.signal }),
        () => Promise.resolve(),
      ),
      'TARBALL_CANCELLED',
    );
    expect(fetchErr.retryable).toBe(true);
    expect(fetchErr.message).not.toContain(rawSecretReason);
    expect(await readdir(tempBaseDir)).toEqual([]);

    // 3. External abort fires between redirect response and codeload fetch
    const betweenFetchAbort = new AbortController();
    const archive = buildGzippedUstar([{ path: `${PREFIX}/src/a.ts`, content: 'export {};\n' }]);
    const betweenFetch: typeof globalThis.fetch = (input) => {
      const url = extractUrl(input);
      if (url === API_URL) {
        betweenFetchAbort.abort(new Error(rawSecretReason));
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: CODELOAD_URL } }),
        );
      }
      return Promise.resolve(
        new Response(new Uint8Array(archive), {
          status: 200,
          headers: { 'content-type': 'application/x-gzip' },
        }),
      );
    };

    const betweenErr = await expectTarballError(
      withExtractedRepo(
        baseOptions(betweenFetch, { timeoutMs: 5_000, signal: betweenFetchAbort.signal }),
        () => Promise.resolve(),
      ),
      'TARBALL_CANCELLED',
    );
    expect(betweenErr.message).not.toContain(rawSecretReason);
    expect(await readdir(tempBaseDir)).toEqual([]);
  });

  it('does not allow subsequent external cancellation to overwrite a prior deterministic TARBALL_SECURITY_VIOLATION', async () => {
    const abortCtrl = new AbortController();

    const maliciousArchive = buildGzippedUstar([
      {
        path: `${PREFIX}/src/evil.ts`,
        typeFlag: '2',
        linkName: '/etc/passwd',
      },
    ]);

    let observedSecurityFailure = false;
    let callbackInvoked = false;

    const mockFetch: typeof globalThis.fetch = (input, init) => {
      const url = extractUrl(input);

      if (url === API_URL) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: CODELOAD_URL },
          }),
        );
      }

      const internalSignal = init?.signal;

      if (!internalSignal) {
        throw new Error('Expected internal extraction AbortSignal');
      }

      internalSignal.addEventListener(
        'abort',
        () => {
          const reason: unknown = internalSignal.reason;

          if (
            reason instanceof TarballExtractionError &&
            reason.code === 'TARBALL_SECURITY_VIOLATION'
          ) {
            observedSecurityFailure = true;

            // Cancel externally only AFTER the extractor has
            // established the deterministic security failure.
            abortCtrl.abort(new Error('late shutdown'));
          }
        },
        { once: true },
      );

      return Promise.resolve(
        new Response(new Uint8Array(maliciousArchive), {
          status: 200,
          headers: {
            'content-type': 'application/x-gzip',
          },
        }),
      );
    };

    const err = await expectTarballError(
      withExtractedRepo(
        baseOptions(mockFetch, {
          signal: abortCtrl.signal,
        }),
        () => {
          callbackInvoked = true;
          return Promise.resolve();
        },
      ),
      'TARBALL_SECURITY_VIOLATION',
    );

    expect(observedSecurityFailure).toBe(true);
    expect(abortCtrl.signal.aborted).toBe(true);
    expect(callbackInvoked).toBe(false);
    expect(err.retryable).toBe(false);
    expect(await readdir(tempBaseDir)).toEqual([]);
  });

  it('keeps extracted workspace alive until callback settles even when external signal aborts during callback, then purges on settlement', async () => {
    const abortCtrl = new AbortController();
    const archive = buildGzippedUstar([
      { path: `${PREFIX}/src/a.ts`, content: 'export const a = 1;\n' },
    ]);
    let releaseCallback: (() => void) | undefined;
    let workspaceDir = '';

    const extractPromise = withExtractedRepo(
      baseOptions(createTarballMockFetch(archive), { signal: abortCtrl.signal }),
      async (workspace) => {
        workspaceDir = workspace.rootDir;
        await new Promise<void>((resolve) => {
          releaseCallback = resolve;
        });
        // Workspace MUST still exist right up until callback settles
        expect(existsSync(workspaceDir)).toBe(true);
        return 'settled';
      },
    );

    // Wait until callback is active
    while (releaseCallback === undefined) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // External signal aborts while callback (e.g. parser child) is still active
    abortCtrl.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(workspaceDir)).toBe(true);

    // Release callback -> workspace is purged cleanly in finally
    releaseCallback();
    await expect(extractPromise).resolves.toBe('settled');
    expect(existsSync(workspaceDir)).toBe(false);
    expect(await readdir(tempBaseDir)).toEqual([]);
  });
  it('cancels with an open file write stream, awaits stream closure, and purges the temp directory without leaving locked files', async () => {
    const abortCtrl = new AbortController();

    const archive = buildGzippedUstar([
      {
        path: `${PREFIX}/src/large.ts`,
        content: `export const s = "${'a'.repeat(128 * 1024)}";\n`,
      },
    ]);

    const actualFs = await vi.importActual<typeof NodeFs>('node:fs');

    const streamMock = vi.mocked(createWriteStream);

    let openedBeforeFinish = false;
    let streamClosed = false;
    let fileExistedAtClose = false;
    let callbackInvoked = false;

    streamMock.mockImplementationOnce((filePath, options) => {
      const out = actualFs.createWriteStream(filePath, options);

      out.once('close', () => {
        streamClosed = true;
        fileExistedAtClose = existsSync(filePath);
      });

      out.once('open', () => {
        openedBeforeFinish = !out.writableFinished && !out.destroyed;

        // Cancel only after the actual file handle has opened.
        abortCtrl.abort(new Error('shutdown during write'));
      });

      return out;
    });

    try {
      const err = await expectTarballError(
        withExtractedRepo(
          baseOptions(createTarballMockFetch(archive), {
            timeoutMs: 10_000,
            signal: abortCtrl.signal,
          }),
          () => {
            callbackInvoked = true;
            return Promise.resolve();
          },
        ),
        'TARBALL_CANCELLED',
      );

      expect(openedBeforeFinish).toBe(true);
      expect(abortCtrl.signal.aborted).toBe(true);
      expect(streamClosed).toBe(true);
      expect(fileExistedAtClose).toBe(true);
      expect(err.retryable).toBe(true);
      expect(callbackInvoked).toBe(false);
      expect(await readdir(tempBaseDir)).toEqual([]);
    } finally {
      streamMock.mockReset();
      streamMock.mockImplementation(actualFs.createWriteStream);
    }
  });

  it('preserves TARBALL_TIMEOUT precedence when external cancellation arrives after the internal extraction deadline', async () => {
    const externalAbort = new AbortController();
    let observedInternalTimeout = false;

    const slowFetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const reason: unknown = init.signal?.reason;
          if (reason instanceof TarballExtractionError && reason.code === 'TARBALL_TIMEOUT') {
            observedInternalTimeout = true;
            // Fire external cancellation AFTER internal timeout has already latched
            externalAbort.abort(new Error('late shutdown'));
          }
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    await expectTarballError(
      withExtractedRepo(
        baseOptions(slowFetch, { timeoutMs: 30, signal: externalAbort.signal }),
        () => Promise.resolve(),
      ),
      'TARBALL_TIMEOUT',
    );
    expect(observedInternalTimeout).toBe(true);
    expect(externalAbort.signal.aborted).toBe(true);
    expect(await readdir(tempBaseDir)).toEqual([]);
  });
});
