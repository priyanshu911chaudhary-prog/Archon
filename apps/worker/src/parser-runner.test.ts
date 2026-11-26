import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { analyzeRepository } from '@archon/core';
import {
  MIN_IPC_RESPONSE_BYTES,
  PARSER_IPC_PROTOCOL_VERSION,
  SAFE_IPC_ERROR_MESSAGES,
  type AnalysisOutput,
  type ParserIpcRequestV1,
  type ParserIpcResponseV1,
  type ParserIpcSuccessResponseV1,
} from '@archon/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoundedUtf8TailBuffer,
  ParserRunnerError,
  buildMinimalChildEnv,
  createParserRunner,
  createParserRunnerForTesting,
  isCorroboratedHeapExhaustion,
  type ParserChildProcessLike,
  type ParserRunnerFatalEvent,
  type ParserSpawnArgs,
} from './parser-runner.js';

const REAL_CHILD_TEST_TIMEOUT_MS = 25_000;
const VALID_SHA256 = 'a'.repeat(64);

class FakeChildProcess extends EventEmitter implements ParserChildProcessLike {
  pid: number | undefined;
  connected = true;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sentRequests: ParserIpcRequestV1[] = [];
  readonly killSignals: (NodeJS.Signals | number | undefined)[] = [];
  disconnectCalls = 0;

  private readonly onSendImpl: (
    message: ParserIpcRequestV1,
    callback: (error: Error | null) => void,
  ) => boolean;
  private readonly onKillImpl?: (signal?: NodeJS.Signals | number) => boolean;

  constructor(
    options: {
      readonly pid?: number | undefined;
      readonly connected?: boolean;
      readonly onSend?: (
        message: ParserIpcRequestV1,
        callback: (error: Error | null) => void,
      ) => boolean;
      readonly onKill?: (signal?: NodeJS.Signals | number) => boolean;
    } = {},
  ) {
    super();
    this.pid = 'pid' in options ? options.pid : 42_424;
    this.connected = options.connected ?? true;
    this.onSendImpl =
      options.onSend ??
      ((_msg, cb) => {
        cb(null);
        return true;
      });
    if (options.onKill !== undefined) {
      this.onKillImpl = options.onKill;
    }
  }

  send(message: ParserIpcRequestV1, callback: (error: Error | null) => void): boolean {
    this.sentRequests.push(message);
    return this.onSendImpl(message, callback);
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (this.onKillImpl !== undefined) {
      return this.onKillImpl(signal);
    }
    return true;
  }

  closeAllResources(): void {
    if (this.connected) {
      this.connected = false;
      this.emit('disconnect');
    }
    this.stdout.end();
    this.stderr.end();
    this.stdout.emit('close');
    this.stderr.emit('close');
  }

  finish(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.closeAllResources();
    this.emit('exit', exitCode, signal);
    this.emit('close', exitCode, signal);
  }
}

function makeEmptyOutput(): AnalysisOutput {
  return {
    nodes: [],
    edges: [],
    warnings: [],
    stats: {
      discoveredFilesCount: 0,
      parsedFilesCount: 0,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 0,
      folderNodeCount: 0,
      fileNodeCount: 0,
      functionNodeCount: 0,
      classNodeCount: 0,
      symbolNodeCount: 0,
      importsEdgeCount: 0,
      callsEdgeCount: 0,
      totalBytesRead: 0,
      truncatedWarningsCount: 0,
    },
  };
}

function makeSuccessResponse(
  requestId: string,
  output: AnalysisOutput = makeEmptyOutput(),
): ParserIpcSuccessResponseV1 {
  return {
    protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
    type: 'ANALYZE_SUCCESS',
    requestId,
    output,
    metrics: {
      durationMs: 5.5,
      baselineHeapUsedBytes: 1_000,
      postHeapUsedBytes: 2_000,
      baselineRssBytes: 3_000,
      postRssBytes: 4_000,
      maxRssKiB: 5_000,
    },
  };
}

describe('ParserRunner (Batch 4.3B.2 hardened)', () => {
  const tempDirs: string[] = [];
  const activeLeasedDirs = new Set<string>();
  const quarantinedDirs = new Set<string>();

  const registerTempDir = (dir: string): string => {
    tempDirs.push(dir);
    return dir;
  };

  const acquireWorkspaceLease = (dir: string): void => {
    activeLeasedDirs.add(dir);
  };

  const releaseWorkspaceLease = (dir: string): void => {
    activeLeasedDirs.delete(dir);
  };

  const quarantineWorkspace = (dir: string): void => {
    quarantinedDirs.add(dir);
  };

  afterEach(async () => {
    const remaining: string[] = [];
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir === undefined) {
        continue;
      }
      // Never delete a workspace while a child lease is active or termination is unconfirmed
      if (activeLeasedDirs.has(dir) || quarantinedDirs.has(dir)) {
        remaining.push(dir);
        continue;
      }
      await rm(dir, { recursive: true, force: true });
    }
    for (const dir of remaining) {
      tempDirs.push(dir);
    }
  });

  async function createMiniRepo(): Promise<string> {
    const dir = registerTempDir(await mkdtemp(path.join(os.tmpdir(), 'archon-runner-repo-')));
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'src', 'service.ts'),
      [
        'export class RepoService {',
        '  fetch(): number { return 1; }',
        '}',
        'export function getSync(): RepoService {',
        '  return new RepoService();',
        '}',
        'export async function getAsync(): Promise<RepoService> {',
        '  return new RepoService();',
        '}',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'src', 'entry.ts'),
      [
        "import { RepoService, getAsync, getSync } from './service';",
        'export async function run(list: Array<RepoService>): Promise<number> {',
        '  const direct = getSync().fetch();',
        '  const awaited = (await getAsync()).fetch();',
        '  const mapped = list.map((item) => item.fetch());',
        '  return direct + awaited + mapped.length;',
        '}',
      ].join('\n'),
      'utf8',
    );
    return dir;
  }

  async function createStubChildScript(scriptBody: string): Promise<{
    readonly dir: string;
    readonly scriptPath: string;
  }> {
    const dir = registerTempDir(await mkdtemp(path.join(os.tmpdir(), 'archon-stub-child-')));
    const scriptPath = path.join(dir, 'stub-child.js');
    await writeFile(scriptPath, scriptBody, 'utf8');
    return { dir, scriptPath };
  }

  // === NORMAL OPERATION (REAL COMPILED CHILD) ===

  it(
    'executes real compiled child with libraries enabled by default, exact parity with direct analyzeRepository, clean exit, and metrics',
    async () => {
      const rootDir = await createMiniRepo();
      acquireWorkspaceLease(rootDir);
      const runner = createParserRunner({
        parserTimeoutMs: 20_000,
        onFatalState: () => {
          quarantineWorkspace(rootDir);
        },
      });

      const directOutput = await analyzeRepository({
        rootDir,
        supportedFiles: ['src/service.ts', 'src/entry.ts'],
        configFiles: [],
        skipLoadingLibFiles: false,
      });

      try {
        const result = await runner.run({
          rootDir,
          supportedFiles: ['src/service.ts', 'src/entry.ts'],
          configFiles: [],
        });

        expect(result.output).toEqual(directOutput);
        expect(result.output.stats.callsEdgeCount).toBe(7);
        expect(result.output.stats.importsEdgeCount).toBe(1);
        expect(result.metrics.exitCode).toBe(0);
        expect(result.metrics.signal).toBeNull();
        expect(result.metrics.endToEndDurationMs).toBeGreaterThanOrEqual(0);
        expect(result.metrics.childAnalysisDurationMs).toBeGreaterThanOrEqual(0);
        expect(result.metrics.serializedResponseBytes).toBeGreaterThan(0);
        expect(result.metrics.parentValidationDurationMs).toBeGreaterThanOrEqual(0);
        expect(result.metrics.parentMemory.postRssBytes).toBeGreaterThan(0);
        expect(runner.getState()).toBe('IDLE');
        expect(runner.hasActiveChild()).toBe(false);
      } finally {
        if (!runner.isFatal() && !runner.hasActiveChild()) {
          releaseWorkspaceLease(rootDir);
        }
      }
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  it(
    'maps clean-exit child CORE_ANALYSIS_ERROR to typed non-retryable ParserRunnerError',
    async () => {
      const rootDir = await createMiniRepo();
      acquireWorkspaceLease(rootDir);
      const runner = createParserRunner({
        parserTimeoutMs: 20_000,
        onFatalState: () => {
          quarantineWorkspace(rootDir);
        },
      });

      try {
        await expect(
          runner.run({
            rootDir,
            supportedFiles: ['src/service.ts', 'src/entry.ts'],
            configFiles: [],
            maxTotalBytes: 10,
            skipLoadingLibFiles: true,
          }),
        ).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof ParserRunnerError &&
            err.code === 'CORE_ANALYSIS_ERROR' &&
            err.coreErrorCode === 'SIZE_LIMIT_EXCEEDED' &&
            !err.retryable &&
            err.exitCode === 0,
        );

        expect(runner.getState()).toBe('IDLE');
      } finally {
        if (!runner.isFatal() && !runner.hasActiveChild()) {
          releaseWorkspaceLease(rootDir);
        }
      }
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  it(
    'supports sequential invocations on one runner and rejects overlapping concurrent invocations',
    async () => {
      const rootDir = await createMiniRepo();
      acquireWorkspaceLease(rootDir);
      const runner = createParserRunner({
        parserTimeoutMs: 20_000,
        skipLoadingLibFiles: true,
        onFatalState: () => {
          quarantineWorkspace(rootDir);
        },
      });

      try {
        const firstPromise = runner.run({
          rootDir,
          supportedFiles: ['src/service.ts'],
          configFiles: [],
        });

        await expect(
          runner.run({
            rootDir,
            supportedFiles: ['src/service.ts'],
            configFiles: [],
          }),
        ).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof ParserRunnerError &&
            err.code === 'CONCURRENT_RUN_REJECTED' &&
            !err.retryable,
        );

        const firstResult = await firstPromise;
        expect(firstResult.output.stats.fileNodeCount).toBe(1);

        const secondResult = await runner.run({
          rootDir,
          supportedFiles: ['src/service.ts', 'src/entry.ts'],
          configFiles: [],
        });
        expect(secondResult.output.stats.fileNodeCount).toBe(2);
        expect(secondResult.requestId).not.toBe(firstResult.requestId);
        expect(runner.getState()).toBe('IDLE');
      } finally {
        if (!runner.isFatal() && !runner.hasActiveChild()) {
          releaseWorkspaceLease(rootDir);
        }
      }
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  // === CONFIGURATION, REQUEST VALIDATION & STARTUP FAILURES ===

  it('rejects invalid runner config, invalid requests before spawn, and missing compiled entrypoints', async () => {
    expect(() => createParserRunner({ parserTimeoutMs: 10 })).toThrow(ParserRunnerError);
    expect(() => createParserRunner({ maxOldSpaceSizeMb: 1.5 })).toThrow(ParserRunnerError);
    expect(() => createParserRunner({ maxResponseBytes: 64 })).toThrow(ParserRunnerError);

    let spawnCount = 0;
    const fakeRunner = createParserRunnerForTesting(
      {},
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          spawnCount += 1;
          return new FakeChildProcess();
        },
      },
    );

    await expect(
      fakeRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: ['../escape.ts'],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'INVALID_REQUEST' && !err.retryable,
    );
    expect(spawnCount).toBe(0);

    const missingDir = registerTempDir(
      await mkdtemp(path.join(os.tmpdir(), 'archon-missing-entry-')),
    );
    const missingEntryRunner = createParserRunnerForTesting(
      {},
      {
        entrypointPathOverride: path.join(missingDir, 'parser-child.js'),
        trustedDirOverride: missingDir,
      },
    );
    await expect(
      missingEntryRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError &&
        err.code === 'MISSING_ENTRYPOINT' &&
        err.startupFailure &&
        !err.retryable,
    );
  });

  it('handles synchronous fork() throw, pre-PID spawn error, secondary late error/close events, and pending send callbacks safely', async () => {
    // 1. Synchronous fork throw
    const syncThrowRunner = createParserRunnerForTesting(
      {},
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          throw new Error('EAGAIN');
        },
      },
    );
    await expect(
      syncThrowRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'SPAWN_FAILED' && err.retryable,
    );
    expect(syncThrowRunner.getState()).toBe('IDLE');

    // 2. Pre-PID spawn error followed by secondary error, late send callback, and late close
    let lateSendCb: ((err: Error | null) => void) | undefined;
    let failedFake: FakeChildProcess | undefined;
    const abortCtrl = new AbortController();

    const prePidRunner = createParserRunnerForTesting(
      {},
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            pid: undefined,
            onSend: (_msg, cb) => {
              lateSendCb = cb;
              queueMicrotask(() => {
                fake.emit('error', new Error('ENOENT'));
              });
              return false;
            },
          });
          failedFake = fake;
          return fake;
        },
      },
    );

    await expect(
      prePidRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
        signal: abortCtrl.signal,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'SPAWN_FAILED' && err.retryable,
    );
    expect(prePidRunner.getState()).toBe('IDLE');
    expect(prePidRunner.hasActiveChild()).toBe(false);

    // Secondary error event, late send callback, abort, and late close MUST NOT throw unhandled
    expect(() => {
      failedFake?.emit('error', new Error('secondary EPIPE'));
      lateSendCb?.(new Error('ERR_IPC_CHANNEL_CLOSED'));
      abortCtrl.abort();
      failedFake?.emit('close', null, null);
    }).not.toThrow();
    expect(failedFake?.listenerCount('error')).toBe(0);
    expect(failedFake?.listenerCount('close')).toBe(0);
  });

  // === IPC PROTOCOL, STRICT REQUEST-ID CORRELATION & SEND CHANNEL ===

  it('rejects wrong requestId (success & error), null error requestId, wrong protocolVersion, malformed/undefined payload, invalid graph, and request-inconsistent file nodes', async () => {
    const runWithChildMessage = async (
      buildMsg: (req: ParserIpcRequestV1) => unknown,
      expectedCode: ParserRunnerError['code'],
    ): Promise<void> => {
      const runner = createParserRunnerForTesting(
        { terminateGraceMs: 25, killConfirmationMs: 50 },
        {
          skipEntrypointValidation: true,
          spawnChild: () => {
            const fake = new FakeChildProcess({
              onSend: (req, cb) => {
                cb(null);
                queueMicrotask(() => {
                  fake.emit('message', buildMsg(req));
                });
                return true;
              },
              onKill: () => {
                queueMicrotask(() => {
                  fake.finish(null, 'SIGTERM');
                });
                return true;
              },
            });
            return fake;
          },
        },
      );

      await expect(
        runner.run({
          rootDir: path.resolve('tmp-repo'),
          supportedFiles: ['src/a.ts'],
          configFiles: [],
        }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ParserRunnerError && err.code === expectedCode && !err.retryable,
      );
      expect(runner.getState()).toBe('IDLE');
    };

    // Wrong requestId on ANALYZE_SUCCESS
    await runWithChildMessage(
      () => makeSuccessResponse('99999999-9999-4999-8999-999999999999'),
      'REQUEST_ID_MISMATCH',
    );

    // Strict correlation: ANALYZE_ERROR with requestId === null MUST be rejected
    await runWithChildMessage(
      () => ({
        protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
        type: 'ANALYZE_ERROR',
        requestId: null,
        error: {
          kind: 'INVALID_REQUEST',
          code: 'INVALID_IPC_REQUEST',
          message: SAFE_IPC_ERROR_MESSAGES.INVALID_IPC_REQUEST,
        },
      }),
      'REQUEST_ID_MISMATCH',
    );

    // Strict correlation: ANALYZE_ERROR with wrong UUID MUST be rejected
    await runWithChildMessage(
      () => ({
        protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
        type: 'ANALYZE_ERROR',
        requestId: '99999999-9999-4999-8999-999999999999',
        error: {
          kind: 'CORE_ANALYSIS_ERROR',
          code: 'INVALID_WORKSPACE',
          message: 'Invalid workspace.',
        },
      }),
      'REQUEST_ID_MISMATCH',
    );

    // Wrong protocolVersion
    await runWithChildMessage(
      (req) => ({ ...makeSuccessResponse(req.requestId), protocolVersion: 2 }),
      'INVALID_RESPONSE',
    );

    // Malformed non-object payload & undefined (where JSON.stringify returns undefined)
    await runWithChildMessage(() => 'not-an-object', 'INVALID_RESPONSE');
    await runWithChildMessage(() => undefined, 'INVALID_RESPONSE');

    // Invalid graph (missing edge endpoint)
    await runWithChildMessage(
      (req) =>
        makeSuccessResponse(req.requestId, {
          ...makeEmptyOutput(),
          edges: [
            {
              sourceQualifiedName: 'file:src/a.ts',
              targetQualifiedName: 'file:src/missing.ts',
              edgeType: 'IMPORTS',
              callSiteLine: null,
              callSiteSnippet: null,
            },
          ],
          stats: { ...makeEmptyOutput().stats, importsEdgeCount: 1 },
        }),
      'INVALID_RESPONSE',
    );

    // Request-inconsistent file node (file not in requested supportedFiles)
    await runWithChildMessage(
      (req) =>
        makeSuccessResponse(req.requestId, {
          nodes: [
            {
              nodeType: 'file',
              name: 'other.ts',
              qualifiedName: 'file:src/other.ts',
              filePath: 'src/other.ts',
              parentQualifiedName: null,
              isExported: false,
              startLine: 1,
              endLine: 1,
              contentHash: VALID_SHA256,
              snippet: '',
            },
          ],
          edges: [],
          warnings: [],
          stats: {
            ...makeEmptyOutput().stats,
            discoveredFilesCount: 1,
            parsedFilesCount: 1,
            fileNodeCount: 1,
          },
        }),
      'INVALID_RESPONSE',
    );
  });

  it('rejects duplicate responses, parent-observed oversized responses, and clean exit with missing response', async () => {
    const dupRunner = createParserRunnerForTesting(
      { terminateGraceMs: 25, killConfirmationMs: 50 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              cb(null);
              queueMicrotask(() => {
                fake.emit('message', makeSuccessResponse(req.requestId));
                fake.emit('message', makeSuccessResponse(req.requestId));
              });
              return true;
            },
            onKill: () => {
              queueMicrotask(() => {
                fake.finish(1);
              });
              return true;
            },
          });
          return fake;
        },
      },
    );
    await expect(
      dupRunner.run({ rootDir: path.resolve('tmp-repo'), supportedFiles: [], configFiles: [] }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'DUPLICATE_RESPONSE' && !err.retryable,
    );

    const oversizedRunner = createParserRunnerForTesting(
      { maxResponseBytes: MIN_IPC_RESPONSE_BYTES, terminateGraceMs: 25, killConfirmationMs: 50 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              cb(null);
              queueMicrotask(() => {
                fake.emit('message', makeSuccessResponse(req.requestId));
              });
              return true;
            },
            onKill: () => {
              queueMicrotask(() => {
                fake.finish(null, 'SIGTERM');
              });
              return true;
            },
          });
          return fake;
        },
      },
    );
    await expect(
      oversizedRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'RESPONSE_TOO_LARGE' && !err.retryable,
    );

    const missingRespRunner = createParserRunnerForTesting(
      {},
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (_req, cb) => {
              cb(null);
              queueMicrotask(() => {
                fake.finish(0);
              });
              return true;
            },
          });
          return fake;
        },
      },
    );
    await expect(
      missingRespRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'MISSING_RESPONSE' && !err.retryable,
    );
  });

  it('handles send backpressure (false return with async cb(null)), async send failure, and sync send throw', async () => {
    const bpRunner = createParserRunnerForTesting(
      {},
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              setTimeout(() => {
                cb(null);
                fake.emit('message', makeSuccessResponse(req.requestId));
                fake.finish(0);
              }, 10);
              return false;
            },
          });
          return fake;
        },
      },
    );
    const bpResult = await bpRunner.run({
      rootDir: path.resolve('tmp-repo'),
      supportedFiles: [],
      configFiles: [],
    });
    expect(bpResult.output.nodes).toEqual([]);

    const asyncFailRunner = createParserRunnerForTesting(
      { terminateGraceMs: 25, killConfirmationMs: 50 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (_req, cb) => {
              queueMicrotask(() => {
                cb(new Error('EPIPE'));
              });
              return false;
            },
            onKill: () => {
              queueMicrotask(() => {
                fake.finish(1);
              });
              return true;
            },
          });
          return fake;
        },
      },
    );
    await expect(
      asyncFailRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'IPC_SEND_FAILED' && err.retryable,
    );

    const syncFailRunner = createParserRunnerForTesting(
      { terminateGraceMs: 25, killConfirmationMs: 50 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: () => {
              throw new Error('ERR_IPC_CHANNEL_CLOSED');
            },
            onKill: () => {
              queueMicrotask(() => {
                fake.finish(1);
              });
              return true;
            },
          });
          return fake;
        },
      },
    );
    await expect(
      syncFailRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'IPC_SEND_FAILED' && err.retryable,
    );
  });

  it('waits for pending IPC send callback after ordinary close: accepts late success, rejects late send failure, and preserves earlier cancellation precedence', async () => {
    // 1. Valid ANALYZE_SUCCESS + close(0, null) BEFORE send callback -> settles only on late cb(null)
    let lateSuccessCb: ((err: Error | null) => void) | undefined;
    const successRunner = createParserRunnerForTesting(
      { killConfirmationMs: 200 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              lateSuccessCb = cb;
              queueMicrotask(() => {
                fake.emit('message', makeSuccessResponse(req.requestId));
                fake.finish(0);
              });
              return false;
            },
          });
          return fake;
        },
      },
    );

    let settledBeforeCb = false;
    const successPromise = successRunner.run({
      rootDir: path.resolve('tmp-repo'),
      supportedFiles: [],
      configFiles: [],
    });
    void successPromise.then(
      () => {
        settledBeforeCb = true;
      },
      () => {
        settledBeforeCb = true;
      },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(settledBeforeCb).toBe(false);
    expect(successRunner.getState()).toBe('EXITED_AWAITING_CLEANUP');
    expect(successRunner.isFatal()).toBe(false);

    lateSuccessCb?.(null);
    const successRes = await successPromise;
    expect(successRes.output.nodes).toEqual([]);
    expect(successRes.metrics.exitCode).toBe(0);
    expect(successRunner.getState()).toBe('IDLE');

    // 2. Valid ANALYZE_SUCCESS + close(0, null) BEFORE send callback -> late cb(err) MUST reject, never accept success
    let lateErrCb: ((err: Error | null) => void) | undefined;
    const failRunner = createParserRunnerForTesting(
      { killConfirmationMs: 200 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              lateErrCb = cb;
              queueMicrotask(() => {
                fake.emit('message', makeSuccessResponse(req.requestId));
                fake.finish(0);
              });
              return false;
            },
          });
          return fake;
        },
      },
    );

    const failPromise = failRunner.run({
      rootDir: path.resolve('tmp-repo'),
      supportedFiles: [],
      configFiles: [],
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(failRunner.getState()).toBe('EXITED_AWAITING_CLEANUP');

    lateErrCb?.(new Error('EPIPE'));
    await expect(failPromise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'IPC_SEND_FAILED' && err.retryable,
    );
    expect(failRunner.getState()).toBe('IDLE');

    // 3. Cancellation wins precedence over late send error after close
    const abortCtrl = new AbortController();
    let cancelSendCb: ((err: Error | null) => void) | undefined;
    const cancelRunner = createParserRunnerForTesting(
      { terminateGraceMs: 25, killConfirmationMs: 200 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (_req, cb) => {
              cancelSendCb = cb;
              queueMicrotask(() => {
                abortCtrl.abort();
                fake.finish(0);
              });
              return false;
            },
          });
          return fake;
        },
      },
    );

    const cancelPromise = cancelRunner.run({
      rootDir: path.resolve('tmp-repo'),
      supportedFiles: [],
      configFiles: [],
      signal: abortCtrl.signal,
    });

    await new Promise((r) => setTimeout(r, 20));
    cancelSendCb?.(new Error('EPIPE'));
    await expect(cancelPromise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'PARSER_CANCELLED' && err.retryable,
    );
    expect(cancelRunner.getState()).toBe('IDLE');
  });

  it('latches FATAL_CLEANUP_UNCONFIRMED when ordinary close finishes but IPC send callback never completes, preserving workspace lease until deferred callback', async () => {
    const workspaceDir = registerTempDir(
      await mkdtemp(path.join(os.tmpdir(), 'archon-send-hang-')),
    );
    acquireWorkspaceLease(workspaceDir);

    const fatalEvents: ParserRunnerFatalEvent[] = [];
    let neverCalledSendCb: ((err: Error | null) => void) | undefined;

    const runner = createParserRunnerForTesting(
      {
        killConfirmationMs: 40,
        onFatalState: (event) => {
          fatalEvents.push(event);
        },
      },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              neverCalledSendCb = cb;
              queueMicrotask(() => {
                fake.emit('message', makeSuccessResponse(req.requestId));
                fake.finish(0);
              });
              return false;
            },
          });
          return fake;
        },
      },
    );

    let leaseReleased = false;
    const leasePromise = (async () => {
      try {
        await runner.run({
          rootDir: workspaceDir,
          supportedFiles: [],
          configFiles: [],
        });
      } finally {
        leaseReleased = true;
      }
    })();

    // Wait beyond killConfirmationMs while send callback remains pending
    await new Promise((r) => setTimeout(r, 120));

    expect(runner.isFatal()).toBe(true);
    expect(runner.getState()).toBe('FATAL_CLEANUP_UNCONFIRMED');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0]?.error.code).toBe('FATAL_CLEANUP_UNCONFIRMED');
    expect(fatalEvents[0]?.processExited).toBe(true);
    expect(leaseReleased).toBe(false);
    expect(existsSync(workspaceDir)).toBe(true);

    // Further runs are blocked on the fatally latched runner
    await expect(
      runner.run({
        rootDir: workspaceDir,
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError &&
        err.code === 'FATAL_CLEANUP_UNCONFIRMED' &&
        err.fatal &&
        !err.retryable,
    );

    // Deferred send callback finally arrives -> settles original promise with FATAL_CLEANUP_UNCONFIRMED
    neverCalledSendCb?.(null);
    await expect(leasePromise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'FATAL_CLEANUP_UNCONFIRMED' && err.fatal,
    );
    expect(leaseReleased).toBe(true);
    expect(runner.isFatal()).toBe(true);
    expect(runner.getState()).toBe('FATAL_CLEANUP_UNCONFIRMED');
    releaseWorkspaceLease(workspaceDir);
  });

  // === CRASHES, HEAP EXHAUSTION, PRECEDENCE & CANCELLATION ===

  it('rejects ANALYZE_SUCCESS followed by nonzero exit, refuses bare SIGABRT/134 as OOM, and detects corroborated V8 heap exhaustion', async () => {
    expect(isCorroboratedHeapExhaustion('', 134, 'SIGABRT')).toBe(false);
    expect(isCorroboratedHeapExhaustion('', null, 'SIGKILL')).toBe(false);
    expect(
      isCorroboratedHeapExhaustion(
        'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
        134,
        null,
      ),
    ).toBe(true);

    const successThenCrashRunner = createParserRunnerForTesting(
      {},
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              cb(null);
              queueMicrotask(() => {
                fake.emit('message', makeSuccessResponse(req.requestId));
                fake.finish(1);
              });
              return true;
            },
          });
          return fake;
        },
      },
    );
    await expect(
      successThenCrashRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError &&
        err.code === 'UNEXPECTED_CHILD_EXIT' &&
        err.retryable &&
        err.exitCode === 1,
    );

    const bareAbortRunner = createParserRunnerForTesting(
      {},
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (_req, cb) => {
              cb(null);
              queueMicrotask(() => {
                fake.stderr.write('Aborted by native assert\n');
                fake.finish(134, 'SIGABRT');
              });
              return true;
            },
          });
          return fake;
        },
      },
    );
    await expect(
      bareAbortRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'UNEXPECTED_CHILD_EXIT' && err.retryable,
    );

    const oomRunner = createParserRunnerForTesting(
      {},
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (_req, cb) => {
              cb(null);
              queueMicrotask(() => {
                fake.stderr.write(
                  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n',
                );
                fake.finish(134, null);
              });
              return true;
            },
          });
          return fake;
        },
      },
    );
    await expect(
      oomRunner.run({ rootDir: path.resolve('tmp-repo'), supportedFiles: [], configFiles: [] }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError &&
        err.code === 'CONFIRMED_HEAP_EXHAUSTION' &&
        !err.retryable,
    );
  });

  it('enforces explicit precedence when child sends correlated ANALYZE_ERROR with clean vs abnormal exit', async () => {
    const runChildErr = async (
      errorPayload: Extract<ParserIpcResponseV1, { type: 'ANALYZE_ERROR' }>['error'],
      exitCode: number,
    ) => {
      const runner = createParserRunnerForTesting(
        {},
        {
          skipEntrypointValidation: true,
          spawnChild: () => {
            const fake = new FakeChildProcess({
              onSend: (req, cb) => {
                cb(null);
                queueMicrotask(() => {
                  fake.emit('message', {
                    protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
                    type: 'ANALYZE_ERROR',
                    requestId: req.requestId,
                    error: errorPayload,
                  });
                  fake.finish(exitCode);
                });
                return true;
              },
            });
            return fake;
          },
        },
      );
      return runner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
      });
    };

    await expect(
      runChildErr(
        {
          kind: 'PROTOCOL_ERROR',
          code: 'IPC_PROTOCOL_ERROR',
          message: SAFE_IPC_ERROR_MESSAGES.DUPLICATE_REQUEST,
        },
        1,
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'INVALID_RESPONSE' && !err.retryable,
    );

    await expect(
      runChildErr(
        {
          kind: 'INTERNAL_ERROR',
          code: 'PARSER_INTERNAL_ERROR',
          message: SAFE_IPC_ERROR_MESSAGES.PARSER_INTERNAL_ERROR,
        },
        0,
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'CHILD_INTERNAL_ERROR' && !err.retryable,
    );

    await expect(
      runChildErr(
        {
          kind: 'CORE_ANALYSIS_ERROR',
          code: 'INVALID_WORKSPACE',
          message: 'Invalid workspace.',
        },
        0,
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError &&
        err.code === 'CORE_ANALYSIS_ERROR' &&
        err.coreErrorCode === 'INVALID_WORKSPACE' &&
        !err.retryable,
    );

    await expect(
      runChildErr(
        {
          kind: 'CORE_ANALYSIS_ERROR',
          code: 'INVALID_WORKSPACE',
          message: 'Invalid workspace.',
        },
        1,
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'UNEXPECTED_CHILD_EXIT' && err.retryable,
    );
  });

  it('handles already-aborted signal, AbortSignal registration race during spawn (zero IPC requests sent), active cancellation, and ignores late ANALYZE_SUCCESS', async () => {
    // 1. Already aborted before spawn
    let preAbortSpawnCount = 0;
    const preAbortRunner = createParserRunnerForTesting(
      {},
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          preAbortSpawnCount += 1;
          return new FakeChildProcess();
        },
      },
    );

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      preAbortRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
        signal: alreadyAborted.signal,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'PARSER_CANCELLED' && err.retryable,
    );
    expect(preAbortSpawnCount).toBe(0);

    // 2. Abort occurs synchronously inside spawnChild() before returning the child
    const spawnRaceAbort = new AbortController();
    let spawnRaceFake: FakeChildProcess | undefined;
    const spawnRaceRunner = createParserRunnerForTesting(
      { terminateGraceMs: 25, killConfirmationMs: 50 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onKill: () => {
              queueMicrotask(() => {
                fake.finish(null, 'SIGTERM');
              });
              return true;
            },
          });
          spawnRaceFake = fake;
          spawnRaceAbort.abort(); // Aborts before listener registration
          return fake;
        },
      },
    );

    await expect(
      spawnRaceRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
        signal: spawnRaceAbort.signal,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'PARSER_CANCELLED' && err.retryable,
    );
    expect(spawnRaceFake?.sentRequests).toHaveLength(0);
    expect(spawnRaceFake?.disconnectCalls).toBe(0);
    expect(spawnRaceFake?.killSignals.length).toBeGreaterThanOrEqual(1);
    expect(spawnRaceRunner.getState()).toBe('IDLE');

    // 3. Active cancellation + late ANALYZE_SUCCESS arriving before close
    const activeAbort = new AbortController();
    let capturedFake: FakeChildProcess | undefined;
    const cancelRunner = createParserRunnerForTesting(
      { terminateGraceMs: 25, killConfirmationMs: 50 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              cb(null);
              setTimeout(() => {
                activeAbort.abort();
                fake.emit('message', makeSuccessResponse(req.requestId));
                fake.finish(null, 'SIGTERM');
              }, 10);
              return true;
            },
          });
          capturedFake = fake;
          return fake;
        },
      },
    );

    await expect(
      cancelRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
        signal: activeAbort.signal,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'PARSER_CANCELLED' && err.retryable,
    );
    expect(capturedFake?.disconnectCalls).toBe(0);
    expect(capturedFake?.killSignals.length).toBeGreaterThanOrEqual(1);
    expect(cancelRunner.getState()).toBe('IDLE');
  });

  it('escalates SIGTERM to SIGKILL on POSIX without proactive disconnect when IPC disconnects and child ignores SIGTERM', async () => {
    let capturedFake: FakeChildProcess | undefined;
    const escalationRunner = createParserRunnerForTesting(
      { terminateGraceMs: 25, killConfirmationMs: 100 },
      {
        platform: 'linux',
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (_req, cb) => {
              cb(null);
              queueMicrotask(() => {
                fake.connected = false;
                fake.emit('disconnect');
              });
              return true;
            },
            onKill: (sig) => {
              if (sig === 'SIGKILL') {
                queueMicrotask(() => {
                  fake.finish(null, 'SIGKILL');
                });
              }
              return true;
            },
          });
          capturedFake = fake;
          return fake;
        },
      },
    );

    await expect(
      escalationRunner.run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError &&
        err.code === 'UNEXPECTED_CHILD_EXIT' &&
        err.signal === 'SIGKILL',
    );

    expect(capturedFake?.disconnectCalls).toBe(0);
    expect(capturedFake?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(escalationRunner.getState()).toBe('IDLE');
  });

  // === EXIT VS CLOSE EVENT-ORDERING REGRESSIONS ===

  it('distinguishes exit from close across exit-before-close, streams-before-exit, exit-without-close fallback, and exit-with-open-resources fatal cleanup latch', async () => {
    // 1. exit before close (normal path): enters EXITED_AWAITING_CLEANUP, never sends SIGKILL, settles on close
    let stateAfterExit: string | undefined;
    let exitBeforeCloseFake: FakeChildProcess | undefined;
    const runner1 = createParserRunnerForTesting(
      { terminateGraceMs: 30, killConfirmationMs: 100 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              cb(null);
              queueMicrotask(() => {
                fake.emit('message', makeSuccessResponse(req.requestId));
                fake.emit('exit', 0, null);
                stateAfterExit = runner1Ref.getState();
                fake.closeAllResources();
                fake.emit('close', 0, null);
              });
              return true;
            },
          });
          exitBeforeCloseFake = fake;
          return fake;
        },
      },
    );
    const runner1Ref = runner1;
    const res1 = await runner1.run({
      rootDir: path.resolve('tmp-repo'),
      supportedFiles: [],
      configFiles: [],
    });
    expect(stateAfterExit).toBe('EXITED_AWAITING_CLEANUP');
    expect(res1.metrics.exitCode).toBe(0);
    expect(exitBeforeCloseFake?.killSignals).toEqual([]);
    expect(runner1.getState()).toBe('IDLE');

    // 2. stdout/stderr close BEFORE exit, followed by close
    const runner2 = createParserRunnerForTesting(
      {},
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              cb(null);
              queueMicrotask(() => {
                fake.emit('message', makeSuccessResponse(req.requestId));
                fake.stdout.end();
                fake.stderr.end();
                fake.stdout.emit('close');
                fake.stderr.emit('close');
                fake.connected = false;
                fake.emit('disconnect');
                fake.emit('exit', 0, null);
                fake.emit('close', 0, null);
              });
              return true;
            },
          });
          return fake;
        },
      },
    );
    const res2 = await runner2.run({
      rootDir: path.resolve('tmp-repo'),
      supportedFiles: [],
      configFiles: [],
    });
    expect(res2.output.nodes).toEqual([]);
    expect(runner2.getState()).toBe('IDLE');

    // 3. exit observed WITHOUT aggregate close, but stdout, stderr, IPC, and send ALL closed -> safe fallback, NO SIGKILL, NO fatal latch
    let noCloseFake: FakeChildProcess | undefined;
    const runner3 = createParserRunnerForTesting(
      { parserTimeoutMs: 50, terminateGraceMs: 25, killConfirmationMs: 120 },
      {
        platform: 'linux',
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (_req, cb) => {
              cb(null);
              return true;
            },
            onKill: () => {
              queueMicrotask(() => {
                fake.closeAllResources();
                fake.emit('exit', null, 'SIGTERM');
                // Deliberately NEVER emit 'close'
              });
              return true;
            },
          });
          noCloseFake = fake;
          return fake;
        },
      },
    );
    await expect(
      runner3.run({ rootDir: path.resolve('tmp-repo'), supportedFiles: [], configFiles: [] }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError &&
        err.code === 'PARSER_TIMEOUT' &&
        !err.fatal &&
        err.signal === 'SIGTERM',
    );
    expect(noCloseFake?.killSignals).toEqual(['SIGTERM']); // NO redundant SIGKILL after confirmed exit
    expect(runner3.isFatal()).toBe(false);
    expect(runner3.getState()).toBe('IDLE');

    // 4. exit observed while stdout/stderr REMAIN OPEN -> latches FATAL_CLEANUP_UNCONFIRMED (not FATAL_TERMINATION_UNCONFIRMED), NO SIGKILL
    const cleanupFatalEvents: ParserRunnerFatalEvent[] = [];
    let openResourceFake: FakeChildProcess | undefined;
    const runner4 = createParserRunnerForTesting(
      {
        parserTimeoutMs: 50,
        terminateGraceMs: 25,
        killConfirmationMs: 40,
        onFatalState: (event) => {
          cleanupFatalEvents.push(event);
        },
      },
      {
        platform: 'linux',
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (_req, cb) => {
              cb(null);
              return true;
            },
            onKill: () => {
              queueMicrotask(() => {
                // Process exits, but stdout/stderr & IPC stay open and 'close' never fires
                fake.emit('exit', null, 'SIGTERM');
              });
              return true;
            },
          });
          openResourceFake = fake;
          return fake;
        },
      },
    );

    const openResPromise = runner4.run({
      rootDir: path.resolve('tmp-repo'),
      supportedFiles: [],
      configFiles: [],
    });
    await new Promise((r) => setTimeout(r, 180));

    expect(runner4.isFatal()).toBe(true);
    expect(runner4.getState()).toBe('FATAL_CLEANUP_UNCONFIRMED');
    expect(openResourceFake?.killSignals).toEqual(['SIGTERM']); // NEVER escalated to SIGKILL on dead process
    expect(cleanupFatalEvents).toHaveLength(1);
    expect(cleanupFatalEvents[0]?.error.code).toBe('FATAL_CLEANUP_UNCONFIRMED');
    expect(cleanupFatalEvents[0]?.processExited).toBe(true);

    // Deferred resource closure finally arrives -> settles pending promise with FATAL_CLEANUP_UNCONFIRMED
    openResourceFake?.closeAllResources();
    await expect(openResPromise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError && err.code === 'FATAL_CLEANUP_UNCONFIRMED' && err.fatal,
    );
    expect(runner4.isFatal()).toBe(true);
    expect(runner4.getState()).toBe('FATAL_CLEANUP_UNCONFIRMED');
  });

  // === REAL HANGING STUB CHILDREN (INDEPENDENTLY SYNCHRONIZED) ===

  it(
    'terminates a real hanging stub child on timeout after confirming it received the request without responding',
    async () => {
      const workspaceDir = registerTempDir(await mkdtemp(path.join(os.tmpdir(), 'archon-hang-a-')));
      acquireWorkspaceLease(workspaceDir);

      const hangRunning = await createStubChildScript(
        [
          'process.on("message", () => {',
          '  process.stdout.write("HANG_A_READY\\n");',
          '  setInterval(() => {}, 10_000);',
          '});',
        ].join('\n'),
      );

      let sawReadyMarker = false;
      let sawChildClose = false;
      const runner = createParserRunnerForTesting(
        {
          parserTimeoutMs: 1_200,
          terminateGraceMs: 500,
          killConfirmationMs: 2_000,
          onFatalState: () => {
            quarantineWorkspace(workspaceDir);
            quarantineWorkspace(hangRunning.dir);
          },
        },
        {
          entrypointPathOverride: hangRunning.scriptPath,
          trustedDirOverride: hangRunning.dir,
          trustedCwdOverride: hangRunning.dir,
          spawnChild: (args) => {
            const child = fork(args.entrypointPath, [], {
              execPath: args.execPath,
              execArgv: [...args.execArgv],
              cwd: args.cwd,
              env: { ...args.env },
              serialization: 'json',
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
            child.stdout?.on('data', (chunk: Buffer | string) => {
              if (chunk.toString().includes('HANG_A_READY')) {
                sawReadyMarker = true;
              }
            });
            child.on('close', () => {
              sawChildClose = true;
            });
            return child;
          },
        },
      );

      try {
        await expect(
          runner.run({
            rootDir: workspaceDir,
            supportedFiles: [],
            configFiles: [],
          }),
        ).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof ParserRunnerError &&
            err.code === 'PARSER_TIMEOUT' &&
            !err.retryable &&
            !err.fatal,
        );

        expect(sawReadyMarker).toBe(true);
        expect(sawChildClose).toBe(true);
        expect(runner.isFatal()).toBe(false);
        expect(runner.getState()).toBe('IDLE');
        expect(runner.hasActiveChild()).toBe(false);
      } finally {
        if (!runner.isFatal() && !runner.hasActiveChild()) {
          releaseWorkspaceLease(workspaceDir);
        }
      }
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  it(
    'terminates a real hanging stub child on timeout after observing a valid ANALYZE_SUCCESS response while the child remains alive',
    async () => {
      const workspaceDir = registerTempDir(await mkdtemp(path.join(os.tmpdir(), 'archon-hang-b-')));
      acquireWorkspaceLease(workspaceDir);

      const hangAfterSuccess = await createStubChildScript(
        [
          'process.on("message", (req) => {',
          '  process.send({',
          '    protocolVersion: 1,',
          '    type: "ANALYZE_SUCCESS",',
          '    requestId: req.requestId,',
          '    output: {',
          '      nodes: [], edges: [], warnings: [],',
          '      stats: {',
          '        discoveredFilesCount: 0, parsedFilesCount: 0, skippedSyntaxErrorFilesCount: 0,',
          '        skippedOversizedFilesCount: 0, configFilesCount: 0, folderNodeCount: 0,',
          '        fileNodeCount: 0, functionNodeCount: 0, classNodeCount: 0, symbolNodeCount: 0,',
          '        importsEdgeCount: 0, callsEdgeCount: 0, totalBytesRead: 0, truncatedWarningsCount: 0,',
          '      },',
          '    },',
          '    metrics: { durationMs: 1, baselineHeapUsedBytes: 1, postHeapUsedBytes: 1, baselineRssBytes: 1, postRssBytes: 1, maxRssKiB: 1 },',
          '  }, () => {',
          '    process.stdout.write("HANG_B_SENT_AND_ALIVE\\n");',
          '  });',
          '  setInterval(() => {}, 10_000);',
          '});',
        ].join('\n'),
      );

      let sawSuccessMessage = false;
      let sawAliveAfterSend = false;
      let stateAfterResponse: string | undefined;
      let sawChildClose = false;

      const runner = createParserRunnerForTesting(
        {
          parserTimeoutMs: 1_500,
          terminateGraceMs: 500,
          killConfirmationMs: 2_000,
          onFatalState: () => {
            quarantineWorkspace(workspaceDir);
            quarantineWorkspace(hangAfterSuccess.dir);
          },
        },
        {
          entrypointPathOverride: hangAfterSuccess.scriptPath,
          trustedDirOverride: hangAfterSuccess.dir,
          trustedCwdOverride: hangAfterSuccess.dir,
          spawnChild: (args) => {
            const child = fork(args.entrypointPath, [], {
              execPath: args.execPath,
              execArgv: [...args.execArgv],
              cwd: args.cwd,
              env: { ...args.env },
              serialization: 'json',
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
            child.on('message', (msg: unknown) => {
              if (
                typeof msg === 'object' &&
                msg !== null &&
                'type' in msg &&
                (msg as { readonly type?: unknown }).type === 'ANALYZE_SUCCESS'
              ) {
                sawSuccessMessage = true;
              }
            });
            child.stdout?.on('data', (chunk: Buffer | string) => {
              if (chunk.toString().includes('HANG_B_SENT_AND_ALIVE')) {
                sawAliveAfterSend = true;
                stateAfterResponse = runnerRef.getState();
              }
            });
            child.on('close', () => {
              sawChildClose = true;
            });
            return child;
          },
        },
      );
      const runnerRef = runner;

      try {
        await expect(
          runner.run({
            rootDir: workspaceDir,
            supportedFiles: [],
            configFiles: [],
          }),
        ).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof ParserRunnerError &&
            err.code === 'PARSER_TIMEOUT' &&
            !err.retryable &&
            !err.fatal,
        );

        expect(sawSuccessMessage).toBe(true);
        expect(sawAliveAfterSend).toBe(true);
        expect(stateAfterResponse).toBe('RESPONSE_RECEIVED_AWAITING_EXIT');
        expect(sawChildClose).toBe(true);
        expect(runner.isFatal()).toBe(false);
        expect(runner.getState()).toBe('IDLE');
        expect(runner.hasActiveChild()).toBe(false);
      } finally {
        if (!runner.isFatal() && !runner.hasActiveChild()) {
          releaseWorkspaceLease(workspaceDir);
        }
      }
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  // === FATAL UNCONFIRMED TERMINATION & COMPETING EVENTS ===

  it('latches FATAL_TERMINATION_UNCONFIRMED, prevents premature workspace deletion, blocks further runs, and completes deferred cleanup on late close', async () => {
    const workspaceDir = registerTempDir(
      await mkdtemp(path.join(os.tmpdir(), 'archon-fatal-lease-')),
    );
    acquireWorkspaceLease(workspaceDir);

    const fatalEvents: ParserRunnerFatalEvent[] = [];
    let unresponsiveChild: FakeChildProcess | undefined;

    const runner = createParserRunnerForTesting(
      {
        parserTimeoutMs: 50,
        terminateGraceMs: 25,
        killConfirmationMs: 35,
        onFatalState: (event) => {
          fatalEvents.push(event);
        },
      },
      {
        platform: 'linux',
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (_req, cb) => {
              cb(null);
              return true;
            },
            onKill: () => true,
          });
          unresponsiveChild = fake;
          return fake;
        },
      },
    );

    let workspaceDeleted = false;
    const leasePromise = (async () => {
      try {
        await runner.run({
          rootDir: workspaceDir,
          supportedFiles: [],
          configFiles: [],
        });
      } finally {
        workspaceDeleted = true;
      }
    })();

    await new Promise((r) => setTimeout(r, 180));

    expect(runner.isFatal()).toBe(true);
    expect(runner.getState()).toBe('FATAL_TERMINATION_UNCONFIRMED');
    expect(runner.hasActiveChild()).toBe(true);
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0]?.error.code).toBe('FATAL_TERMINATION_UNCONFIRMED');
    expect(fatalEvents[0]?.processExited).toBe(false);
    expect(workspaceDeleted).toBe(false);
    expect(existsSync(workspaceDir)).toBe(true);

    await expect(
      runner.run({
        rootDir: workspaceDir,
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError &&
        err.code === 'FATAL_TERMINATION_UNCONFIRMED' &&
        err.fatal &&
        !err.retryable,
    );

    unresponsiveChild?.finish(null, 'SIGKILL');
    await expect(leasePromise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError &&
        err.code === 'FATAL_TERMINATION_UNCONFIRMED' &&
        err.fatal,
    );
    expect(workspaceDeleted).toBe(true);
    expect(runner.isFatal()).toBe(true);
    expect(runner.getState()).toBe('FATAL_TERMINATION_UNCONFIRMED');
    expect(runner.hasActiveChild()).toBe(false);
    releaseWorkspaceLease(workspaceDir);
  });

  it('settles exactly once under competing message, error, disconnect, exit, close, and abort events', async () => {
    const abortCtrl = new AbortController();
    let settlementCount = 0;

    const runner = createParserRunnerForTesting(
      { terminateGraceMs: 25, killConfirmationMs: 50 },
      {
        skipEntrypointValidation: true,
        spawnChild: () => {
          const fake = new FakeChildProcess({
            onSend: (req, cb) => {
              cb(null);
              queueMicrotask(() => {
                fake.emit('message', makeSuccessResponse(req.requestId));
                abortCtrl.abort();
                fake.emit('error', new Error('post-spawn race error'));
                fake.emit('disconnect');
                fake.finish(0);
                fake.emit('message', makeSuccessResponse(req.requestId));
                fake.emit('close', 1, 'SIGKILL');
              });
              return true;
            },
          });
          return fake;
        },
      },
    );

    await runner
      .run({
        rootDir: path.resolve('tmp-repo'),
        supportedFiles: [],
        configFiles: [],
        signal: abortCtrl.signal,
      })
      .then(
        () => {
          settlementCount += 1;
        },
        (err: unknown) => {
          settlementCount += 1;
          expect(err).toBeInstanceOf(ParserRunnerError);
          if (err instanceof ParserRunnerError) {
            expect(err.code).toBe('PARSER_CANCELLED');
          }
        },
      );

    expect(settlementCount).toBe(1);
    expect(runner.getState()).toBe('IDLE');
  });

  // === BOUNDED DIAGNOSTIC ALLOCATION & SECURITY ISOLATION ===

  it('bounds retained diagnostic stream memory via dedicated unpooled allocations for small and oversized chunks', () => {
    const capBytes = 256;
    const tail = new BoundedUtf8TailBuffer(capBytes);

    // Empty initial state holds zero backing bytes
    expect(tail.getByteLength()).toBe(0);
    expect(tail.getBackingArrayBufferByteLength()).toBe(0);

    // Small chunks use dedicated allocations strictly bounded by current size (<= capBytes, never 8 KiB pool)
    tail.append(Buffer.from('alpha-', 'utf8'));
    tail.append(Buffer.from('beta', 'utf8'));
    expect(tail.getByteLength()).toBe(10);
    expect(tail.getBackingArrayBufferByteLength()).toBe(10);
    expect(tail.getBackingArrayBufferByteLength()).toBeLessThanOrEqual(capBytes);
    expect(tail.toUtf8String()).toBe('alpha-beta');

    // Oversized incoming chunk (128 KiB) retains only exact 256-byte tail and exact 256-byte backing ArrayBuffer
    const hugeSlab = Buffer.alloc(128 * 1024, 0x61);
    hugeSlab.write('END_MARKER', hugeSlab.byteLength - 10, 'utf8');
    tail.append(hugeSlab);
    expect(tail.getByteLength()).toBe(capBytes);
    expect(tail.getBackingArrayBufferByteLength()).toBe(capBytes);
    expect(tail.toUtf8String().endsWith('END_MARKER')).toBe(true);

    // Subsequent small append keeps exact 256-byte tail and 256-byte backing allocation
    tail.append(Buffer.from('_NEXT', 'utf8'));
    expect(tail.getByteLength()).toBe(capBytes);
    expect(tail.getBackingArrayBufferByteLength()).toBe(capBytes);
    expect(tail.toUtf8String().endsWith('END_MARKER_NEXT')).toBe(true);
  });

  it(
    'excludes parent credentials and NODE_OPTIONS, avoids Windows duplicate env keys, isolates execArgv/cwd, and passes approved --max-old-space-size',
    async () => {
      const winEnv = buildMinimalChildEnv(
        {
          Path: 'C:\\lower',
          PATH: 'C:\\upper',
          SystemRoot: 'C:\\Windows',
          GITHUB_TOKEN: 'SENTINEL_GH_TOKEN',
          GEMINI_API_KEY: 'SENTINEL_GEMINI_KEY',
          DATABASE_URL: 'postgres://sentinel',
          REDIS_URL: 'redis://sentinel',
          NODE_OPTIONS: '--require /sentinel.cjs',
        },
        'win32',
      );
      expect(winEnv.PATH).toBe('C:\\upper');
      expect(winEnv.Path).toBeUndefined();
      expect(winEnv.SYSTEMROOT).toBe('C:\\Windows');
      expect(winEnv.GITHUB_TOKEN).toBeUndefined();
      expect(winEnv.GEMINI_API_KEY).toBeUndefined();
      expect(winEnv.DATABASE_URL).toBeUndefined();
      expect(winEnv.REDIS_URL).toBeUndefined();
      expect(winEnv.NODE_OPTIONS).toBeUndefined();

      const targetWorkspace = registerTempDir(
        await mkdtemp(path.join(os.tmpdir(), 'archon-sec-target-')),
      );
      acquireWorkspaceLease(targetWorkspace);

      const probeStub = await createStubChildScript(
        [
          'process.on("message", (req) => {',
          '  const snapshot = JSON.stringify({',
          '    hasGh: "GITHUB_TOKEN" in process.env,',
          '    hasGemini: "GEMINI_API_KEY" in process.env,',
          '    hasDb: "DATABASE_URL" in process.env,',
          '    hasRedis: "REDIS_URL" in process.env,',
          '    hasNodeOptions: "NODE_OPTIONS" in process.env,',
          '    execArgv: process.execArgv,',
          '    cwd: process.cwd(),',
          '  });',
          '  process.send({',
          '    protocolVersion: 1,',
          '    type: "ANALYZE_SUCCESS",',
          '    requestId: req.requestId,',
          '    output: {',
          '      nodes: [{',
          '        nodeType: "file", name: "probe.ts", qualifiedName: "file:probe.ts",',
          '        filePath: "probe.ts", parentQualifiedName: null, isExported: false,',
          `        startLine: 1, endLine: 1, contentHash: "${VALID_SHA256}", snippet: snapshot,`,
          '      }],',
          '      edges: [], warnings: [],',
          '      stats: {',
          '        discoveredFilesCount: 1, parsedFilesCount: 1, skippedSyntaxErrorFilesCount: 0,',
          '        skippedOversizedFilesCount: 0, configFilesCount: 0, folderNodeCount: 0,',
          '        fileNodeCount: 1, functionNodeCount: 0, classNodeCount: 0, symbolNodeCount: 0,',
          '        importsEdgeCount: 0, callsEdgeCount: 0, totalBytesRead: 1, truncatedWarningsCount: 0,',
          '      },',
          '    },',
          '    metrics: { durationMs: 1, baselineHeapUsedBytes: 1, postHeapUsedBytes: 1, baselineRssBytes: 1, postRssBytes: 1, maxRssKiB: 1 },',
          '  }, () => process.exit(0));',
          '});',
        ].join('\n'),
      );

      let observedSpawnArgs: ParserSpawnArgs | undefined;
      const runner = createParserRunnerForTesting(
        {
          maxOldSpaceSizeMb: 192,
          parserTimeoutMs: 15_000,
          onFatalState: () => {
            quarantineWorkspace(targetWorkspace);
            quarantineWorkspace(probeStub.dir);
          },
        },
        {
          entrypointPathOverride: probeStub.scriptPath,
          trustedDirOverride: probeStub.dir,
          trustedCwdOverride: probeStub.dir,
          sourceEnv: {
            ...process.env,
            GITHUB_TOKEN: 'SENTINEL_GH_TOKEN_999',
            GEMINI_API_KEY: 'SENTINEL_GEMINI_KEY_999',
            DATABASE_URL: 'postgres://sentinel:sentinel@localhost:5432/sentinel',
            REDIS_URL: 'redis://localhost:6380',
            NODE_OPTIONS: '--require /definitely-nonexistent-preload-sentinel.cjs',
          },
          spawnChild: (args) => {
            observedSpawnArgs = args;
            return fork(args.entrypointPath, [], {
              execPath: args.execPath,
              execArgv: [...args.execArgv],
              cwd: args.cwd,
              env: { ...args.env },
              serialization: 'json',
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
          },
        },
      );

      try {
        const res = await runner.run({
          rootDir: targetWorkspace,
          supportedFiles: ['probe.ts'],
          configFiles: [],
        });

        const observed = JSON.parse(res.output.nodes[0]?.snippet ?? '{}') as {
          readonly hasGh: boolean;
          readonly hasGemini: boolean;
          readonly hasDb: boolean;
          readonly hasRedis: boolean;
          readonly hasNodeOptions: boolean;
          readonly execArgv: readonly string[];
          readonly cwd: string;
        };

        expect(observed.hasGh).toBe(false);
        expect(observed.hasGemini).toBe(false);
        expect(observed.hasDb).toBe(false);
        expect(observed.hasRedis).toBe(false);
        expect(observed.hasNodeOptions).toBe(false);
        expect(observed.execArgv).toEqual(['--max-old-space-size=192']);
        expect(path.resolve(observed.cwd)).not.toBe(path.resolve(targetWorkspace));
        expect(observedSpawnArgs?.execArgv).toEqual(['--max-old-space-size=192']);
      } finally {
        if (!runner.isFatal() && !runner.hasActiveChild()) {
          releaseWorkspaceLease(targetWorkspace);
        }
      }
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );
});
