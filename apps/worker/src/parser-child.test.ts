import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '@archon/core';
import {
  DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
  DEFAULT_MAX_CONFIG_FILES,
  DEFAULT_MAX_EXTENDS_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILE_SNIPPET_CHARS,
  DEFAULT_MAX_SUPPORTED_FILES,
  DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_WARNINGS,
  MIN_IPC_RESPONSE_BYTES,
  PARSER_IPC_PROTOCOL_VERSION,
  SAFE_IPC_ERROR_MESSAGES,
  parseParserIpcResponse,
  validateAnalysisGraph,
  type ParserIpcRequestV1,
  type ParserIpcResponseV1,
} from '@archon/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createParserChildController, executeValidatedRequest } from './parser-child.js';

const WORKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPILED_CHILD_PATH = path.join(WORKER_ROOT, 'dist', 'parser-child.js');
const MAX_CAPTURED_STREAM_CHARS = 8192;
const HELPER_TIMEOUT_MS = 15_000;
const HELPER_KILL_GRACE_MS = 1_500;
const HELPER_KILL_CONFIRM_MS = 3_000;
const REAL_CHILD_TEST_TIMEOUT_MS = 25_000;

function buildMinimalChildEnv(): NodeJS.ProcessEnv {
  const allowKeys = [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'ComSpec',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
  ];
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of allowKeys) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  return env;
}

function appendBoundedTail(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= MAX_CAPTURED_STREAM_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - MAX_CAPTURED_STREAM_CHARS);
}

interface TestChildProcessLike extends EventEmitter {
  readonly pid?: number | undefined;
  readonly connected: boolean;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  disconnect: () => void;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

interface ChildRunOutcome {
  readonly messages: readonly unknown[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly sendErrors: readonly string[];
}

interface SafeTestChildOptions {
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly killConfirmMs?: number;
  readonly workspaceDir?: string;
  readonly onUnconfirmedTermination?: (workspaceDir: string | undefined, reason: string) => void;
}

function safeKill(
  child: TestChildProcessLike,
  signal: NodeJS.Signals | undefined,
  errors: string[],
): void {
  try {
    if (signal !== undefined) {
      child.kill(signal);
    } else {
      child.kill();
    }
  } catch (err: unknown) {
    errors.push(err instanceof Error ? err.message : 'Synchronous kill error.');
  }
}

/**
 * Focused test-child lifecycle helper:
 * - Drains stdout and stderr into bounded buffers.
 * - Uses kill-first termination (never proactively calls `disconnect()` before `kill()`).
 * - Never sends `SIGKILL` after `'exit'` is confirmed, and never treats `kill()` returning
 *   `true` as confirmed termination.
 * - On final unconfirmed termination deadline, notifies caller to quarantine the test
 *   workspace, retains error/close listeners for deferred cleanup (never unrefs), and only
 *   settles once termination is observed.
 */
async function runChildWithSafeLifecycle(
  child: TestChildProcessLike,
  messagesToSend: readonly unknown[],
  options: SafeTestChildOptions = {},
): Promise<ChildRunOutcome> {
  const timeoutMs = options.timeoutMs ?? HELPER_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? HELPER_KILL_GRACE_MS;
  const killConfirmMs = options.killConfirmMs ?? HELPER_KILL_CONFIRM_MS;

  return await new Promise<ChildRunOutcome>((resolve, reject) => {
    const received: unknown[] = [];
    const sendErrors: string[] = [];
    const state = {
      stdout: '',
      stderr: '',
      settled: false,
      timedOut: false,
      processExited: false,
      quarantined: false,
      graceTimer: undefined as NodeJS.Timeout | undefined,
      confirmTimer: undefined as NodeJS.Timeout | undefined,
    };

    const cleanupAll = (): void => {
      clearTimeout(runTimer);
      if (state.graceTimer !== undefined) {
        clearTimeout(state.graceTimer);
      }
      if (state.confirmTimer !== undefined) {
        clearTimeout(state.confirmTimer);
      }
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
    };

    const settleResolve = (outcome: ChildRunOutcome): void => {
      if (state.settled) {
        return;
      }
      state.settled = true;
      cleanupAll();
      resolve(outcome);
    };

    const settleReject = (err: Error): void => {
      if (state.settled) {
        return;
      }
      state.settled = true;
      cleanupAll();
      reject(err);
    };

    const onStdout = (chunk: Buffer | string): void => {
      state.stdout = appendBoundedTail(state.stdout, chunk.toString());
    };
    const onStderr = (chunk: Buffer | string): void => {
      state.stderr = appendBoundedTail(state.stderr, chunk.toString());
    };
    const onMessage = (msg: unknown): void => {
      received.push(msg);
    };

    const onError = (err: Error): void => {
      if (child.pid === undefined) {
        settleReject(
          new Error(`Failed to spawn compiled parser child: ${err.message}`, { cause: err }),
        );
        return;
      }
      sendErrors.push(err.message);
    };

    const onExit = (): void => {
      state.processExited = true;
      if (state.graceTimer !== undefined) {
        clearTimeout(state.graceTimer);
        state.graceTimer = undefined;
      }
      if (state.confirmTimer !== undefined) {
        clearTimeout(state.confirmTimer);
        state.confirmTimer = undefined;
      }
    };

    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (state.quarantined) {
        settleReject(
          new Error(
            `Compiled parser child terminated after quarantine (exitCode=${String(exitCode)}, signal=${String(signal)}).`,
          ),
        );
        return;
      }
      if (state.timedOut) {
        settleReject(
          new Error(
            `Compiled parser child timed out after ${String(timeoutMs)} ms (terminated: exitCode=${String(exitCode)}, signal=${String(signal)}).`,
          ),
        );
        return;
      }
      settleResolve({
        messages: received,
        exitCode,
        signal,
        stdout: state.stdout,
        stderr: state.stderr,
        sendErrors,
      });
    };

    const runTimer = setTimeout(() => {
      if (state.settled || state.processExited) {
        return;
      }
      state.timedOut = true;
      safeKill(child, process.platform === 'win32' ? undefined : 'SIGTERM', sendErrors);

      state.graceTimer = setTimeout(() => {
        if (state.settled || state.processExited) {
          return;
        }
        safeKill(child, 'SIGKILL', sendErrors);

        state.confirmTimer = setTimeout(() => {
          if (state.settled || state.processExited) {
            return;
          }
          state.quarantined = true;
          const reason = `Compiled parser child did not confirm termination within ${String(killConfirmMs)} ms after SIGKILL; workspace quarantined.`;
          options.onUnconfirmedTermination?.(options.workspaceDir, reason);
        }, killConfirmMs);
      }, killGraceMs);
    }, timeoutMs);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('close', onClose);

    for (const msg of messagesToSend) {
      if (!child.connected) {
        sendErrors.push('IPC channel disconnected before send.');
        break;
      }
      try {
        child.send(msg, (err) => {
          if (err !== null) {
            sendErrors.push(err.message);
          }
        });
      } catch (err: unknown) {
        sendErrors.push(err instanceof Error ? err.message : 'Synchronous send error.');
      }
    }
  });
}

async function runCompiledChild(
  messagesToSend: readonly unknown[],
  options: SafeTestChildOptions = {},
): Promise<ChildRunOutcome> {
  if (!existsSync(COMPILED_CHILD_PATH)) {
    throw new Error(
      `Compiled child entrypoint missing at ${COMPILED_CHILD_PATH}. Run "npm run build" before running subprocess tests.`,
    );
  }

  const child = fork(COMPILED_CHILD_PATH, [], {
    cwd: WORKER_ROOT,
    env: buildMinimalChildEnv(),
    execArgv: [],
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  return await runChildWithSafeLifecycle(
    child as unknown as TestChildProcessLike,
    messagesToSend,
    options,
  );
}

function buildRequest(
  rootDir: string,
  overrides: Partial<ParserIpcRequestV1['input']> = {},
  extra: { readonly requestId?: string; readonly maxResponseBytes?: number } = {},
): ParserIpcRequestV1 {
  return {
    protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
    type: 'ANALYZE_REQUEST',
    requestId: extra.requestId ?? randomUUID(),
    input: {
      rootDir,
      supportedFiles: ['src/service.ts', 'src/entry.ts'],
      configFiles: [],
      maxSupportedFiles: DEFAULT_MAX_SUPPORTED_FILES,
      maxConfigFiles: DEFAULT_MAX_CONFIG_FILES,
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
      maxFileSnippetChars: DEFAULT_MAX_FILE_SNIPPET_CHARS,
      maxSymbolSnippetChars: DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
      maxCallSiteSnippetChars: DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
      maxWarnings: DEFAULT_MAX_WARNINGS,
      maxExtendsDepth: DEFAULT_MAX_EXTENDS_DEPTH,
      skipLoadingLibFiles: false,
      ...overrides,
    },
    ...(extra.maxResponseBytes !== undefined ? { maxResponseBytes: extra.maxResponseBytes } : {}),
  };
}

describe('compiled parser-child IPC execution (Batch 4.3B.1 hardened)', () => {
  const tempDirs: string[] = [];
  const quarantinedDirs = new Set<string>();
  const quarantineEvents: string[] = [];

  const markQuarantined = (workspaceDir: string | undefined, reason: string): void => {
    quarantineEvents.push(reason);
    if (workspaceDir !== undefined) {
      quarantinedDirs.add(workspaceDir);
    }
  };

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined && !quarantinedDirs.has(dir)) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  /**
   * Deterministic fixture that meaningfully exercises bundled TypeScript library inference
   * (`Promise<RepoService>` awaited + `Array<RepoService>.map(...)`), matching core regression patterns.
   */
  async function createLibParityFixture(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-parser-child-'));
    tempDirs.push(dir);
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

  it.each([false, true])(
    'executes real analysis in a fresh compiled child with exact parity to direct analyzeRepository (skipLoadingLibFiles=%s)',
    async (skipLoadingLibFiles) => {
      const rootDir = await createLibParityFixture();
      const request = buildRequest(rootDir, { skipLoadingLibFiles });

      const directOutput = await analyzeRepository(request.input);
      const outcome = await runCompiledChild([request], {
        workspaceDir: rootDir,
        onUnconfirmedTermination: markQuarantined,
      });

      expect(outcome.exitCode).toBe(0);
      expect(outcome.signal).toBeNull();
      expect(outcome.messages).toHaveLength(1);

      const parsed = parseParserIpcResponse(outcome.messages[0]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.data.type !== 'ANALYZE_SUCCESS') {
        throw new Error('Expected ANALYZE_SUCCESS response.');
      }

      expect(parsed.data.requestId).toBe(request.requestId);
      expect(parsed.data.output).toEqual(directOutput);
      expect(validateAnalysisGraph(parsed.data.output)).toEqual({ valid: true, violations: [] });
      expect(parsed.data.metrics.durationMs).toBeGreaterThanOrEqual(0);
      expect(parsed.data.metrics.postRssBytes).toBeGreaterThan(0);

      // Confirm bundled lib mode meaningfully resolves Promise/Array.map `.fetch()` calls (7 CALLS vs 5 CALLS)
      if (!skipLoadingLibFiles) {
        expect(parsed.data.output.stats.callsEdgeCount).toBe(7);
      } else {
        expect(parsed.data.output.stats.callsEdgeCount).toBe(5);
      }
      expect(parsed.data.output.stats.importsEdgeCount).toBe(1);
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  it(
    'rejects invalid IPC requests without echoing sensitive sentinels or unrecognized keys, using null requestId when untrusted',
    async () => {
      const sentinelValue = 'SENTINEL_SECRET_REQ_VALUE_101';
      const sentinelKey = 'SENTINEL_SECRET_KEY_202';

      // Missing/non-UUID requestId -> response requestId is null
      const badIdOutcome = await runCompiledChild([
        {
          protocolVersion: 1,
          type: 'ANALYZE_REQUEST',
          [sentinelKey]: sentinelValue,
        },
      ]);
      expect(badIdOutcome.exitCode).toBe(0);
      expect(badIdOutcome.messages).toHaveLength(1);
      const badIdJson = JSON.stringify(badIdOutcome.messages[0]);
      expect(badIdJson).not.toContain(sentinelValue);
      expect(badIdJson).not.toContain(sentinelKey);

      const parsedBadId = parseParserIpcResponse(badIdOutcome.messages[0]);
      expect(parsedBadId.ok).toBe(true);
      if (!parsedBadId.ok || parsedBadId.data.type !== 'ANALYZE_ERROR') {
        throw new Error('Expected ANALYZE_ERROR response.');
      }
      expect(parsedBadId.data.requestId).toBeNull();
      expect(parsedBadId.data.error.kind).toBe('INVALID_REQUEST');
      expect(parsedBadId.data.error.code).toBe('INVALID_IPC_REQUEST');

      // Valid UUID with malformed input containing sentinel value -> echoes UUID, never leaks sentinel
      const reqId = randomUUID();
      const badInputOutcome = await runCompiledChild([
        {
          protocolVersion: 1,
          type: 'ANALYZE_REQUEST',
          requestId: reqId,
          input: { rootDir: sentinelValue },
        },
      ]);
      expect(badInputOutcome.exitCode).toBe(0);
      expect(JSON.stringify(badInputOutcome.messages[0])).not.toContain(sentinelValue);

      const parsedBadInput = parseParserIpcResponse(badInputOutcome.messages[0]);
      expect(parsedBadInput.ok).toBe(true);
      if (!parsedBadInput.ok || parsedBadInput.data.type !== 'ANALYZE_ERROR') {
        throw new Error('Expected ANALYZE_ERROR response.');
      }
      expect(parsedBadInput.data.requestId).toBe(reqId);
      expect(parsedBadInput.data.error.kind).toBe('INVALID_REQUEST');
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  it(
    'returns typed CORE_ANALYSIS_ERROR for missing workspaces without leaking sensitive workspace path sentinels',
    async () => {
      const pathSentinel = 'SENTINEL_PRIVATE_WORKSPACE_303';
      const missingRoot = path.join(os.tmpdir(), `${pathSentinel}-${randomUUID()}`);
      const request = buildRequest(missingRoot, {
        supportedFiles: [],
        configFiles: [],
        skipLoadingLibFiles: true,
      });

      const outcome = await runCompiledChild([request], {
        workspaceDir: missingRoot,
        onUnconfirmedTermination: markQuarantined,
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.messages).toHaveLength(1);
      expect(JSON.stringify(outcome.messages[0])).not.toContain(pathSentinel);

      const parsed = parseParserIpcResponse(outcome.messages[0]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.data.type !== 'ANALYZE_ERROR') {
        throw new Error('Expected ANALYZE_ERROR response.');
      }
      expect(parsed.data.requestId).toBe(request.requestId);
      expect(parsed.data.error.kind).toBe('CORE_ANALYSIS_ERROR');
      expect(parsed.data.error.code).toBe('INVALID_WORKSPACE');
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  it(
    'returns typed CORE_ANALYSIS_ERROR on deterministic SIZE_LIMIT_EXCEEDED rejection',
    async () => {
      const rootDir = await createLibParityFixture();
      const request = buildRequest(rootDir, { maxTotalBytes: 10, skipLoadingLibFiles: true });

      const outcome = await runCompiledChild([request], {
        workspaceDir: rootDir,
        onUnconfirmedTermination: markQuarantined,
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.messages).toHaveLength(1);

      const parsed = parseParserIpcResponse(outcome.messages[0]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.data.type !== 'ANALYZE_ERROR') {
        throw new Error('Expected ANALYZE_ERROR response.');
      }
      expect(parsed.data.error.kind).toBe('CORE_ANALYSIS_ERROR');
      expect(parsed.data.error.code).toBe('SIZE_LIMIT_EXCEEDED');
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  it(
    'returns RESPONSE_TOO_LARGE within the byte budget when serialized output exceeds maxResponseBytes cap',
    async () => {
      const rootDir = await createLibParityFixture();
      const request = buildRequest(
        rootDir,
        { skipLoadingLibFiles: true },
        { maxResponseBytes: MIN_IPC_RESPONSE_BYTES },
      );

      const outcome = await runCompiledChild([request], {
        workspaceDir: rootDir,
        onUnconfirmedTermination: markQuarantined,
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.messages).toHaveLength(1);

      const replacementBytes = Buffer.byteLength(JSON.stringify(outcome.messages[0]), 'utf8');
      expect(replacementBytes).toBeLessThanOrEqual(MIN_IPC_RESPONSE_BYTES);

      const parsed = parseParserIpcResponse(outcome.messages[0]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.data.type !== 'ANALYZE_ERROR') {
        throw new Error('Expected ANALYZE_ERROR response.');
      }
      expect(parsed.data.requestId).toBe(request.requestId);
      expect(parsed.data.error.kind).toBe('RESPONSE_TOO_LARGE');
      expect(parsed.data.error.code).toBe('IPC_RESPONSE_TOO_LARGE');
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  it(
    'enforces strict single-response protocol on pre-commit duplicate requests (one PROTOCOL_ERROR correlated to primary requestId, no success, abnormal exit)',
    async () => {
      const rootDir = await createLibParityFixture();
      const req1 = buildRequest(rootDir, { skipLoadingLibFiles: false });
      const req2 = buildRequest(rootDir, { skipLoadingLibFiles: false });
      const req3 = buildRequest(rootDir, { skipLoadingLibFiles: false });

      const outcome = await runCompiledChild([req1, req2, req3]);

      // Abnormal termination + at most ONE terminal response emitted (never a success, never unbounded errors)
      expect(outcome.exitCode).toBe(1);
      expect(outcome.messages).toHaveLength(1);

      const parsed = parseParserIpcResponse(outcome.messages[0]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.data.type !== 'ANALYZE_ERROR') {
        throw new Error('Expected single ANALYZE_ERROR (PROTOCOL_ERROR) response.');
      }
      expect(parsed.data.requestId).toBe(req1.requestId);
      expect(parsed.data.error.kind).toBe('PROTOCOL_ERROR');
      expect(parsed.data.error.code).toBe('IPC_PROTOCOL_ERROR');
      expect(parsed.data.error.message).toBe(SAFE_IPC_ERROR_MESSAGES.DUPLICATE_REQUEST);
    },
    REAL_CHILD_TEST_TIMEOUT_MS,
  );

  it('controller: duplicate received after response send started emits no second message and forces abnormal exit code 1', async () => {
    const rootDir = path.resolve('tmp-controller-test');
    const req1 = buildRequest(rootDir, { supportedFiles: [], configFiles: [] });
    const req2 = buildRequest(rootDir, { supportedFiles: [], configFiles: [] });

    const sentMessages: ParserIpcResponseV1[] = [];
    const sendCallbacks: ((err: Error | null) => void)[] = [];
    const exitCodes: number[] = [];

    const controller = createParserChildController({
      ipc: {
        isConnected: () => true,
        send: (msg, cb) => {
          sentMessages.push(msg);
          sendCallbacks.push(cb);
          return true;
        },
      },
      analyze: (req) =>
        Promise.resolve({
          protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
          type: 'ANALYZE_SUCCESS',
          requestId: req.requestId,
          output: {
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
          },
          metrics: {
            durationMs: 1,
            baselineHeapUsedBytes: 1,
            postHeapUsedBytes: 2,
            baselineRssBytes: 3,
            postRssBytes: 4,
            maxRssKiB: 5,
          },
        }),
      exit: (code) => {
        exitCodes.push(code);
      },
    });

    controller.handleMessage(req1);
    await Promise.resolve(); // allow analyze promise to commit response send

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.type).toBe('ANALYZE_SUCCESS');
    expect(exitCodes).toEqual([]);

    // Duplicate arrives AFTER transmission started, before flush callback completes
    controller.handleMessage(req2);
    expect(sentMessages).toHaveLength(1); // MUST NOT send a second message

    // Complete flush callback -> abnormal exit code 1 MUST be observable
    sendCallbacks[0]?.(null);
    expect(exitCodes).toEqual([1]);
  });

  it('controller: preserves backpressure semantics (false send return), send failures, and IPC disconnect', async () => {
    const rootDir = path.resolve('tmp-controller-bp');
    const req = buildRequest(rootDir, { supportedFiles: [], configFiles: [] });

    // 1. Backpressure (`send` returns false) -> waits for callback, exits cleanly with 0
    const bpExits: number[] = [];
    const bpCallbacks: ((err: Error | null) => void)[] = [];
    const bpController = createParserChildController({
      ipc: {
        isConnected: () => true,
        send: (_msg, cb) => {
          bpCallbacks.push(cb);
          return false; // backpressure, NOT failure
        },
      },
      analyze: (r) =>
        Promise.resolve({
          protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
          type: 'ANALYZE_ERROR',
          requestId: r.requestId,
          error: {
            kind: 'CORE_ANALYSIS_ERROR',
            code: 'INVALID_WORKSPACE',
            message: 'Invalid or unreadable analysis workspace.',
          },
        }),
      exit: (code) => {
        bpExits.push(code);
      },
    });

    bpController.handleMessage(req);
    await Promise.resolve();
    expect(bpExits).toEqual([]);
    bpCallbacks[0]?.(null);
    expect(bpExits).toEqual([0]);

    // 2. Send callback error -> abnormal exit code 1
    const errExits: number[] = [];
    const errController = createParserChildController({
      ipc: {
        isConnected: () => true,
        send: (_msg, cb) => {
          cb(new Error('EPIPE'));
          return false;
        },
      },
      analyze: (r) =>
        Promise.resolve({
          protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
          type: 'ANALYZE_ERROR',
          requestId: r.requestId,
          error: {
            kind: 'INTERNAL_ERROR',
            code: 'PARSER_INTERNAL_ERROR',
            message: SAFE_IPC_ERROR_MESSAGES.PARSER_INTERNAL_ERROR,
          },
        }),
      exit: (code) => {
        errExits.push(code);
      },
    });
    errController.handleMessage(req);
    await Promise.resolve();
    expect(errExits).toEqual([1]);

    // 3. Disconnect before response -> abnormal exit code 1
    const discExits: number[] = [];
    const discController = createParserChildController({
      ipc: {
        isConnected: () => true,
        send: () => true,
      },
      analyze: () => new Promise<ParserIpcResponseV1>(() => undefined),
      exit: (code) => {
        discExits.push(code);
      },
    });
    discController.handleMessage(req);
    discController.handleDisconnect();
    expect(discExits).toEqual([1]);
  });

  it('controller: never leaks sensitive internal exception messages or stack traces through ANALYZE_ERROR', async () => {
    const secretSentinel = 'SENTINEL_INTERNAL_DB_CRED_555';
    const rootDir = path.resolve('tmp-controller-secret');
    const req = buildRequest(rootDir, { supportedFiles: [], configFiles: [] });

    const sent: ParserIpcResponseV1[] = [];
    const exits: number[] = [];
    const controller = createParserChildController({
      ipc: {
        isConnected: () => true,
        send: (msg, cb) => {
          sent.push(msg);
          cb(null);
          return true;
        },
      },
      analyze: () =>
        Promise.reject(new Error(`Fatal crash with ${secretSentinel} at C:\\secret\\file.ts:42`)),
      exit: (code) => {
        exits.push(code);
      },
    });

    controller.handleMessage(req);
    await Promise.resolve();
    await Promise.resolve();

    expect(exits).toEqual([0]);
    expect(sent).toHaveLength(1);
    const serialized = JSON.stringify(sent[0]);
    expect(serialized).not.toContain(secretSentinel);
    expect(serialized).not.toContain('C:\\secret\\file.ts');
    expect(sent[0]?.type).toBe('ANALYZE_ERROR');
    if (sent[0]?.type === 'ANALYZE_ERROR') {
      expect(sent[0].error.kind).toBe('INTERNAL_ERROR');
      expect(sent[0].error.message).toBe(SAFE_IPC_ERROR_MESSAGES.PARSER_INTERNAL_ERROR);
    }
  });

  it('controller: rejects invalid tiny request budgets and fits serialization-failure replacement error within the 256-byte minimum budget', async () => {
    const rootDir = path.resolve('tmp-controller-budget');
    const req = buildRequest(rootDir, { supportedFiles: [], configFiles: [] });
    // Force an invalid tiny budget via direct controller invocation to verify defensive guard
    const tinyBudgetReq: ParserIpcRequestV1 = { ...req, maxResponseBytes: 32 };

    const sent: ParserIpcResponseV1[] = [];
    const exits: number[] = [];
    const controller = createParserChildController({
      ipc: {
        isConnected: () => true,
        send: (msg, cb) => {
          sent.push(msg);
          cb(null);
          return true;
        },
      },
      analyze: (r) => executeValidatedRequest(r),
      exit: (code) => {
        exits.push(code);
      },
    });

    // Request with maxResponseBytes: 32 is rejected by schema, and the controller still uses default budget
    // so test direct replacement-exceeds-budget by returning an unserializable response under MIN_IPC_RESPONSE_BYTES
    const unserializableSent: ParserIpcResponseV1[] = [];
    const unserializableExits: number[] = [];
    const controller2 = createParserChildController({
      ipc: {
        isConnected: () => true,
        send: (msg, cb) => {
          unserializableSent.push(msg);
          cb(null);
          return true;
        },
      },
      analyze: () => {
        const circular = {
          protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
          type: 'ANALYZE_SUCCESS',
          requestId: req.requestId,
        } as unknown as Record<string, unknown>;
        circular.self = circular;
        return Promise.resolve(circular as unknown as ParserIpcResponseV1);
      },
      exit: (code) => {
        unserializableExits.push(code);
      },
    });

    controller.handleMessage(tinyBudgetReq);
    controller2.handleMessage({ ...req, maxResponseBytes: MIN_IPC_RESPONSE_BYTES });
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(exits).toEqual([0]);

    expect(unserializableSent).toHaveLength(1);
    expect(unserializableExits).toEqual([0]);
    const replacementBytes = Buffer.byteLength(JSON.stringify(unserializableSent[0]), 'utf8');
    expect(replacementBytes).toBeLessThanOrEqual(MIN_IPC_RESPONSE_BYTES);
    expect(unserializableSent[0]?.type).toBe('ANALYZE_ERROR');
    if (unserializableSent[0]?.type === 'ANALYZE_ERROR') {
      expect(unserializableSent[0].error.code).toBe('PARSER_INTERNAL_ERROR');
      expect(unserializableSent[0].error.message).toBe(
        SAFE_IPC_ERROR_MESSAGES.SERIALIZATION_FAILED,
      );
    }
  });
  it('test helper quarantines workspace without premature rejection when SIGKILL termination is unconfirmed, then completes deferred cleanup on late close', async () => {
    const fakeWorkspace = await mkdtemp(path.join(os.tmpdir(), 'archon-quarantine-test-'));
    tempDirs.push(fakeWorkspace);

    class StubUnresponsiveChild extends EventEmitter implements TestChildProcessLike {
      readonly pid = 999_999;
      connected = true;
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly killCalls: (NodeJS.Signals | number | undefined)[] = [];
      disconnectCalls = 0;

      send(_message: unknown, callback?: (error: Error | null) => void): boolean {
        callback?.(null);
        return true;
      }

      disconnect(): void {
        this.disconnectCalls += 1;
        this.connected = false;
      }

      kill(signal?: NodeJS.Signals | number): boolean {
        this.killCalls.push(signal);
        return true; // kill() returning true MUST NOT be treated as confirmed exit
      }
    }

    const fakeChild = new StubUnresponsiveChild();
    let quarantineCallbackFired = false;
    let settledPrematurely = false;

    const runPromise = runChildWithSafeLifecycle(fakeChild, [{ dummy: true }], {
      timeoutMs: 25,
      killGraceMs: 25,
      killConfirmMs: 35,
      workspaceDir: fakeWorkspace,
      onUnconfirmedTermination: (dir, reason) => {
        quarantineCallbackFired = true;
        markQuarantined(dir, reason);
      },
    });
    runPromise.then(
      () => {
        settledPrematurely = true;
      },
      () => {
        settledPrematurely = true;
      },
    );

    // Wait past timeout + grace + killConfirm deadlines
    await new Promise((r) => setTimeout(r, 150));

    expect(quarantineCallbackFired).toBe(true);
    expect(quarantinedDirs.has(fakeWorkspace)).toBe(true);
    expect(quarantineEvents.length).toBeGreaterThanOrEqual(1);
    expect(fakeChild.killCalls).toContain('SIGKILL');
    expect(fakeChild.disconnectCalls).toBe(0);
    expect(settledPrematurely).toBe(false);
    expect(existsSync(fakeWorkspace)).toBe(true);

    // Deferred OS close finally arrives -> promise now rejects cleanly and listeners detach
    fakeChild.emit('close', null, 'SIGKILL');
    await expect(runPromise).rejects.toThrow(/terminated after quarantine/);
    expect(fakeChild.listenerCount('close')).toBe(0);
    expect(fakeChild.listenerCount('error')).toBe(0);

    // Clean up our synthetic temp directory after deferred termination is confirmed
    quarantinedDirs.delete(fakeWorkspace);
    await rm(fakeWorkspace, { recursive: true, force: true });
  });
});
