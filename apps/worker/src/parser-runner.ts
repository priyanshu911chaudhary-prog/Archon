import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
  DEFAULT_MAX_CONFIG_FILES,
  DEFAULT_MAX_EXTENDS_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILE_SNIPPET_CHARS,
  DEFAULT_MAX_IPC_RESPONSE_BYTES,
  DEFAULT_MAX_SUPPORTED_FILES,
  DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_WARNINGS,
  MIN_IPC_RESPONSE_BYTES,
  PARSER_IPC_PROTOCOL_VERSION,
  SAFE_IPC_ERROR_MESSAGES,
  getSafeCoreAnalysisErrorMessage,
  parseParserIpcRequest,
  parseParserIpcResponse,
  type AnalysisOutput,
  type CoreAnalysisErrorCode,
  type ParserIpcErrorResponseV1,
  type ParserIpcRequestV1,
  type ParserIpcSuccessResponseV1,
} from '@archon/shared';

export const DEFAULT_PARSER_TIMEOUT_MS = 60_000;
export const MIN_PARSER_TIMEOUT_MS = 50;
export const MAX_PARSER_TIMEOUT_MS = 600_000;

/**
 * Preliminary V8 old-space heap limit candidate (256 MiB).
 * Explicitly does NOT cap total child RSS (native allocations, code space, and IPC buffers add overhead).
 */
export const DEFAULT_PARSER_MAX_OLD_SPACE_MB = 256;
export const MIN_PARSER_MAX_OLD_SPACE_MB = 32;
export const MAX_PARSER_MAX_OLD_SPACE_MB = 4_096;

export const DEFAULT_PARSER_TERMINATE_GRACE_MS = 2_000;
export const MIN_PARSER_TERMINATE_GRACE_MS = 10;
export const MAX_PARSER_TERMINATE_GRACE_MS = 30_000;

export const DEFAULT_PARSER_KILL_CONFIRMATION_MS = 3_000;
export const MIN_PARSER_KILL_CONFIRMATION_MS = 10;
export const MAX_PARSER_KILL_CONFIRMATION_MS = 30_000;

/** Bounded UTF-8 byte capture retained per child stream (`stdout` and `stderr`). */
export const DEFAULT_PARSER_MAX_DIAGNOSTIC_BYTES = 8_192;
export const MIN_PARSER_MAX_DIAGNOSTIC_BYTES = 256;
export const MAX_PARSER_MAX_DIAGNOSTIC_BYTES = 65_536;

/** Short window allowing Node's aggregate `close` event to fire first once `exit` + all resources have closed. */
const MAX_POST_EXIT_CLOSE_GRACE_MS = 50;

export const PARSER_RUNNER_ERROR_CODES = [
  'INVALID_RUNNER_CONFIG',
  'INVALID_REQUEST',
  'MISSING_ENTRYPOINT',
  'CONCURRENT_RUN_REJECTED',
  'SPAWN_FAILED',
  'IPC_SEND_FAILED',
  'INVALID_RESPONSE',
  'REQUEST_ID_MISMATCH',
  'DUPLICATE_RESPONSE',
  'RESPONSE_TOO_LARGE',
  'MISSING_RESPONSE',
  'CORE_ANALYSIS_ERROR',
  'CHILD_INTERNAL_ERROR',
  'UNEXPECTED_CHILD_EXIT',
  'CONFIRMED_HEAP_EXHAUSTION',
  'PARSER_TIMEOUT',
  'PARSER_CANCELLED',
  'FATAL_TERMINATION_UNCONFIRMED',
  'FATAL_CLEANUP_UNCONFIRMED',
] as const;

export type ParserRunnerErrorCode = (typeof PARSER_RUNNER_ERROR_CODES)[number];

export type ParserRunnerState =
  | 'IDLE'
  | 'VALIDATING'
  | 'SPAWNING'
  | 'RUNNING'
  | 'RESPONSE_RECEIVED_AWAITING_EXIT'
  | 'TERMINATING_GRACE'
  | 'TERMINATING_FORCED'
  | 'EXITED_AWAITING_CLEANUP'
  | 'FATAL_TERMINATION_UNCONFIRMED'
  | 'FATAL_CLEANUP_UNCONFIRMED';

export interface ParserRunnerErrorInit {
  readonly code: ParserRunnerErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly fatal?: boolean;
  readonly startupFailure?: boolean;
  readonly coreErrorCode?: CoreAnalysisErrorCode;
  readonly requestId?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly cause?: unknown;
}

export class ParserRunnerError extends Error {
  readonly code: ParserRunnerErrorCode;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly startupFailure: boolean;
  readonly coreErrorCode?: CoreAnalysisErrorCode;
  readonly requestId?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;

  constructor(init: ParserRunnerErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'ParserRunnerError';
    this.code = init.code;
    this.retryable = init.retryable;
    this.fatal = init.fatal ?? false;
    this.startupFailure = init.startupFailure ?? false;
    if (init.coreErrorCode !== undefined) {
      this.coreErrorCode = init.coreErrorCode;
    }
    if (init.requestId !== undefined) {
      this.requestId = init.requestId;
    }
    if (init.exitCode !== undefined) {
      this.exitCode = init.exitCode;
    }
    if (init.signal !== undefined) {
      this.signal = init.signal;
    }
  }
}

export interface ParserRunnerFatalEvent {
  readonly error: ParserRunnerError;
  readonly requestId: string;
  readonly pid: number | undefined;
  readonly processExited: boolean;
}

export interface ParserRunnerOptions {
  /** Wall-clock timeout covering spawn, analysis, IPC, and clean child exit (default 60,000 ms). */
  readonly parserTimeoutMs?: number;
  /** V8 old-space heap cap passed via `--max-old-space-size` (default 256 MiB; does NOT cap total RSS). */
  readonly maxOldSpaceSizeMb?: number;
  /** Maximum serialized UTF-8 IPC response byte size (default 32 MiB). */
  readonly maxResponseBytes?: number;
  /** Grace window before escalating to forced SIGKILL (default 2,000 ms). */
  readonly terminateGraceMs?: number;
  /** Observation window after SIGKILL / post-exit before latching fatal state (default 3,000 ms). */
  readonly killConfirmationMs?: number;
  /** Bounded UTF-8 bytes retained per drained child stream (default 8,192 bytes). */
  readonly maxDiagnosticStreamBytes?: number;
  /** Default `false`: bundled TypeScript standard libraries enabled by default. */
  readonly skipLoadingLibFiles?: boolean;
  /** Invoked immediately if the runner latches into a fatal termination or cleanup state. */
  readonly onFatalState?: (event: ParserRunnerFatalEvent) => void;
}

export interface ParserRunInput {
  readonly rootDir: string;
  readonly supportedFiles: readonly string[];
  readonly configFiles: readonly string[];
  readonly maxSupportedFiles?: number;
  readonly maxConfigFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileSnippetChars?: number;
  readonly maxSymbolSnippetChars?: number;
  readonly maxCallSiteSnippetChars?: number;
  readonly maxWarnings?: number;
  readonly maxExtendsDepth?: number;
  readonly skipLoadingLibFiles?: boolean;
  readonly signal?: AbortSignal;
}

export interface ParserRunMetrics {
  /** End-to-end parent runner wall-clock duration (ms) from spawn to confirmed cleanup. */
  readonly endToEndDurationMs: number;
  /** Child-reported `analyzeRepository` duration (ms). */
  readonly childAnalysisDurationMs: number;
  /**
   * Child-reported memory observations taken before IPC send.
   * Explicitly does NOT capture subsequent JSON serialization or parent deserialization peaks.
   */
  readonly childPreSendMemory: {
    readonly baselineHeapUsedBytes: number;
    readonly postHeapUsedBytes: number;
    readonly baselineRssBytes: number;
    readonly postRssBytes: number;
    readonly maxRssKiB: number;
  };
  /** Serialized UTF-8 JSON byte length measured after Node IPC deserialization. */
  readonly serializedResponseBytes: number;
  /** Parent-side IPC schema + semantic graph-integrity validation duration (ms). */
  readonly parentValidationDurationMs: number;
  /** Point-in-time parent process memory samples (NOT process-lifetime peak RSS). */
  readonly parentMemory: {
    readonly baselineHeapUsedBytes: number;
    readonly postHeapUsedBytes: number;
    readonly baselineRssBytes: number;
    readonly postRssBytes: number;
  };
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ParserRunResult {
  readonly requestId: string;
  readonly output: AnalysisOutput;
  readonly metrics: ParserRunMetrics;
}

export interface ParserRunner {
  readonly run: (input: ParserRunInput) => Promise<ParserRunResult>;
  readonly getState: () => ParserRunnerState;
  readonly isFatal: () => boolean;
  readonly hasActiveChild: () => boolean;
}

/**
 * Internal structural child-process contract used by the runner state machine and
 * deterministic fault-injection tests (not exported from `apps/worker/src/index.ts`).
 */
export interface ParserChildProcessLike extends EventEmitter {
  readonly pid?: number | undefined;
  readonly connected: boolean;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  send: (message: ParserIpcRequestV1, callback: (error: Error | null) => void) => boolean;
  disconnect: () => void;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

export interface ParserSpawnArgs {
  readonly entrypointPath: string;
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ParserRunnerTestHooks {
  readonly entrypointPathOverride?: string;
  readonly trustedDirOverride?: string;
  readonly trustedCwdOverride?: string;
  readonly skipEntrypointValidation?: boolean;
  readonly spawnChild?: (args: ParserSpawnArgs) => ParserChildProcessLike;
  readonly platform?: NodeJS.Platform;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
}

interface ValidatedRunnerConfig {
  readonly parserTimeoutMs: number;
  readonly maxOldSpaceSizeMb: number;
  readonly maxResponseBytes: number;
  readonly terminateGraceMs: number;
  readonly killConfirmationMs: number;
  readonly maxDiagnosticStreamBytes: number;
  readonly skipLoadingLibFiles: boolean;
  readonly onFatalState?: (event: ParserRunnerFatalEvent) => void;
}

/**
 * Minimal OS/Node runtime environment allowlist for the parser child.
 * Explicitly excludes credentials (`GITHUB_TOKEN`, `GEMINI_API_KEY`, `DATABASE_URL`,
 * `REDIS_URL`), `NODE_OPTIONS`, and arbitrary loader/preload variables.
 */
const CHILD_ENV_ALLOWLIST_CANONICAL: readonly string[] = [
  'NODE_ENV',
  'TZ',
  'LANG',
  'LC_ALL',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'COMSPEC',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
];

const CHILD_ENV_ALLOWLIST_UPPER = new Set(CHILD_ENV_ALLOWLIST_CANONICAL);

const HEAP_OOM_STDERR_SIGNATURES: readonly string[] = [
  'FATAL ERROR: Reached heap limit',
  'JavaScript heap out of memory',
  'Allocation failed - JavaScript heap out of memory',
  'FATAL ERROR: Ineffective mark-compacts near heap limit',
];

const SAFE_PARENT_MESSAGES: Readonly<Record<ParserRunnerErrorCode, string>> = {
  INVALID_RUNNER_CONFIG: 'Invalid parser runner configuration.',
  INVALID_REQUEST: SAFE_IPC_ERROR_MESSAGES.INVALID_IPC_REQUEST,
  MISSING_ENTRYPOINT: 'Compiled parser child entrypoint is missing or invalid.',
  CONCURRENT_RUN_REJECTED: 'Parser runner already has an active child process.',
  SPAWN_FAILED: 'Failed to spawn parser child process.',
  IPC_SEND_FAILED: 'Failed to send analysis request over parser IPC channel.',
  INVALID_RESPONSE: SAFE_IPC_ERROR_MESSAGES.INVALID_IPC_RESPONSE,
  REQUEST_ID_MISMATCH: 'Parser response requestId does not match the active request.',
  DUPLICATE_RESPONSE: 'Parser child emitted duplicate IPC responses.',
  RESPONSE_TOO_LARGE: SAFE_IPC_ERROR_MESSAGES.IPC_RESPONSE_TOO_LARGE,
  MISSING_RESPONSE: 'Parser child exited cleanly without returning an analysis response.',
  CORE_ANALYSIS_ERROR: 'Static analysis rejected workspace input.',
  CHILD_INTERNAL_ERROR: SAFE_IPC_ERROR_MESSAGES.PARSER_INTERNAL_ERROR,
  UNEXPECTED_CHILD_EXIT: 'Parser child process exited unexpectedly.',
  CONFIRMED_HEAP_EXHAUSTION: 'Parser child exhausted its V8 heap memory limit.',
  PARSER_TIMEOUT: 'Parser child process exceeded its execution timeout.',
  PARSER_CANCELLED: 'Parser execution was cancelled.',
  FATAL_TERMINATION_UNCONFIRMED:
    'Parser child termination could not be confirmed after forced kill; runner latched fatal.',
  FATAL_CLEANUP_UNCONFIRMED:
    'Parser child exited, but stdio or IPC resource cleanup did not complete; runner latched fatal.',
};

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Bounded UTF-8 tail buffer backed by copied allocations (`<= maxBytes`) so retaining a
 * diagnostic tail can never pin a larger incoming `Buffer` slab in memory.
 */
/**
 * Bounded UTF-8 tail buffer backed by dedicated unpooled copied allocations (`<= maxBytes`)
 * so retaining a diagnostic tail never pins an oversized incoming slab or Node's 8 KiB buffer pool.
 * Note: this bounds diagnostic stream storage only, not total process RSS.
 */
export class BoundedUtf8TailBuffer {
  private buffer: Buffer = Buffer.allocUnsafeSlow(0);
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, maxBytes);
  }

  append(chunk: Buffer): void {
    if (chunk.byteLength === 0 || this.maxBytes === 0) {
      return;
    }
    if (chunk.byteLength >= this.maxBytes) {
      const tail = Buffer.allocUnsafeSlow(this.maxBytes);
      chunk.copy(tail, 0, chunk.byteLength - this.maxBytes, chunk.byteLength);
      this.buffer = tail;
      return;
    }
    const combinedLen = this.buffer.byteLength + chunk.byteLength;
    if (combinedLen <= this.maxBytes) {
      const next = Buffer.allocUnsafeSlow(combinedLen);
      this.buffer.copy(next, 0);
      chunk.copy(next, this.buffer.byteLength);
      this.buffer = next;
      return;
    }
    const drop = combinedLen - this.maxBytes;
    const keptLen = this.buffer.byteLength - drop;
    const next = Buffer.allocUnsafeSlow(this.maxBytes);
    this.buffer.copy(next, 0, drop, this.buffer.byteLength);
    chunk.copy(next, keptLen);
    this.buffer = next;
  }

  toUtf8String(): string {
    return this.buffer.toString('utf8');
  }

  getByteLength(): number {
    return this.buffer.byteLength;
  }

  getBackingArrayBufferByteLength(): number {
    return this.buffer.buffer.byteLength;
  }
}

function validateSafeIntOption(
  name: string,
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ParserRunnerError({
      code: 'INVALID_RUNNER_CONFIG',
      message: `Invalid parser runner option "${name}": expected safe integer in [${String(min)}, ${String(max)}].`,
      retryable: false,
      startupFailure: true,
    });
  }
  return value;
}

function validateRunnerOptions(options: ParserRunnerOptions): ValidatedRunnerConfig {
  if (
    options.skipLoadingLibFiles !== undefined &&
    typeof options.skipLoadingLibFiles !== 'boolean'
  ) {
    throw new ParserRunnerError({
      code: 'INVALID_RUNNER_CONFIG',
      message: 'Invalid parser runner option "skipLoadingLibFiles": expected boolean.',
      retryable: false,
      startupFailure: true,
    });
  }

  return {
    parserTimeoutMs: validateSafeIntOption(
      'parserTimeoutMs',
      options.parserTimeoutMs,
      DEFAULT_PARSER_TIMEOUT_MS,
      MIN_PARSER_TIMEOUT_MS,
      MAX_PARSER_TIMEOUT_MS,
    ),
    maxOldSpaceSizeMb: validateSafeIntOption(
      'maxOldSpaceSizeMb',
      options.maxOldSpaceSizeMb,
      DEFAULT_PARSER_MAX_OLD_SPACE_MB,
      MIN_PARSER_MAX_OLD_SPACE_MB,
      MAX_PARSER_MAX_OLD_SPACE_MB,
    ),
    maxResponseBytes: validateSafeIntOption(
      'maxResponseBytes',
      options.maxResponseBytes,
      DEFAULT_MAX_IPC_RESPONSE_BYTES,
      MIN_IPC_RESPONSE_BYTES,
      DEFAULT_MAX_IPC_RESPONSE_BYTES,
    ),
    terminateGraceMs: validateSafeIntOption(
      'terminateGraceMs',
      options.terminateGraceMs,
      DEFAULT_PARSER_TERMINATE_GRACE_MS,
      MIN_PARSER_TERMINATE_GRACE_MS,
      MAX_PARSER_TERMINATE_GRACE_MS,
    ),
    killConfirmationMs: validateSafeIntOption(
      'killConfirmationMs',
      options.killConfirmationMs,
      DEFAULT_PARSER_KILL_CONFIRMATION_MS,
      MIN_PARSER_KILL_CONFIRMATION_MS,
      MAX_PARSER_KILL_CONFIRMATION_MS,
    ),
    maxDiagnosticStreamBytes: validateSafeIntOption(
      'maxDiagnosticStreamBytes',
      options.maxDiagnosticStreamBytes,
      DEFAULT_PARSER_MAX_DIAGNOSTIC_BYTES,
      MIN_PARSER_MAX_DIAGNOSTIC_BYTES,
      MAX_PARSER_MAX_DIAGNOSTIC_BYTES,
    ),
    skipLoadingLibFiles: options.skipLoadingLibFiles ?? false,
    ...(options.onFatalState !== undefined ? { onFatalState: options.onFatalState } : {}),
  };
}

/**
 * Builds a minimal, conflict-free child environment from an explicit OS/Node runtime allowlist.
 * On Windows, resolves case-insensitive duplicates (e.g. `Path` vs `PATH`) into a single
 * canonical uppercase key so child environments never contain duplicate keys or leaked secrets.
 */
export function buildMinimalChildEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const result: Record<string, string> = {};
  const exactMatches = new Set<string>();

  for (const [rawKey, value] of Object.entries(sourceEnv)) {
    if (value === undefined) {
      continue;
    }
    const upperKey = rawKey.toUpperCase();
    if (!CHILD_ENV_ALLOWLIST_UPPER.has(upperKey)) {
      continue;
    }

    if (platform === 'win32') {
      const isExact = rawKey === upperKey;
      if (result[upperKey] === undefined || (isExact && !exactMatches.has(upperKey))) {
        result[upperKey] = value;
        if (isExact) {
          exactMatches.add(upperKey);
        }
      }
    } else if (rawKey === upperKey) {
      result[upperKey] = value;
    }
  }

  return result;
}

/**
 * Resolves the compiled worker package root, trusted `dist` directory, and fixed
 * `apps/worker/dist/parser-child.js` path relative to `import.meta.url` (works both from
 * compiled `apps/worker/dist/` and source `apps/worker/src/` under Vitest / `tsx`).
 */
export function resolveCompiledParserChildPath(moduleUrl: string = import.meta.url): {
  readonly workerPackageRoot: string;
  readonly trustedDistDir: string;
  readonly entrypointPath: string;
} {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const workerPackageRoot = path.resolve(moduleDir, '..');
  const trustedDistDir =
    path.basename(moduleDir) === 'dist' ? moduleDir : path.join(workerPackageRoot, 'dist');
  const entrypointPath = path.join(trustedDistDir, 'parser-child.js');
  return { workerPackageRoot, trustedDistDir, entrypointPath };
}

function isInsideTrustedDirectory(canonicalDir: string, canonicalFile: string): boolean {
  const normalizedDir = canonicalDir.endsWith(path.sep)
    ? canonicalDir
    : `${canonicalDir}${path.sep}`;
  if (process.platform === 'win32') {
    return canonicalFile.toLowerCase().startsWith(normalizedDir.toLowerCase());
  }
  return canonicalFile.startsWith(normalizedDir);
}

/**
 * Verifies the compiled parser child entrypoint exists, is a regular non-symlink `.js` file,
 * and resolves inside the trusted compiled `dist` directory before spawning.
 */
export async function validateCompiledParserEntrypoint(
  entrypointPath: string,
  trustedDistDir: string,
): Promise<string> {
  if (!entrypointPath.toLowerCase().endsWith('.js')) {
    throw new ParserRunnerError({
      code: 'MISSING_ENTRYPOINT',
      message: SAFE_PARENT_MESSAGES.MISSING_ENTRYPOINT,
      retryable: false,
      startupFailure: true,
    });
  }

  try {
    const [canonicalDist, entryStat] = await Promise.all([
      realpath(trustedDistDir),
      lstat(entrypointPath),
    ]);
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
      throw new ParserRunnerError({
        code: 'MISSING_ENTRYPOINT',
        message: SAFE_PARENT_MESSAGES.MISSING_ENTRYPOINT,
        retryable: false,
        startupFailure: true,
      });
    }
    const canonicalEntry = await realpath(entrypointPath);
    if (!isInsideTrustedDirectory(canonicalDist, canonicalEntry)) {
      throw new ParserRunnerError({
        code: 'MISSING_ENTRYPOINT',
        message: SAFE_PARENT_MESSAGES.MISSING_ENTRYPOINT,
        retryable: false,
        startupFailure: true,
      });
    }
    return canonicalEntry;
  } catch (err: unknown) {
    if (err instanceof ParserRunnerError) {
      throw err;
    }
    throw new ParserRunnerError({
      code: 'MISSING_ENTRYPOINT',
      message: SAFE_PARENT_MESSAGES.MISSING_ENTRYPOINT,
      retryable: false,
      startupFailure: true,
      cause: err,
    });
  }
}

/**
 * Conservative heap-exhaustion detector: requires corroborating V8 heap-limit stderr
 * evidence AND abnormal termination. Bare `SIGABRT`, exit code `134`, or `SIGKILL` without
 * heap-limit evidence is NOT misclassified as OOM.
 */
export function isCorroboratedHeapExhaustion(
  stderrTail: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): boolean {
  if (exitCode === 0 && signal === null) {
    return false;
  }
  return HEAP_OOM_STDERR_SIGNATURES.some((sig) => stderrTail.includes(sig));
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateGraphAgainstRequest(output: AnalysisOutput, request: ParserIpcRequestV1): boolean {
  const allowedSources = new Set(request.input.supportedFiles);

  if (output.stats.discoveredFilesCount > request.input.supportedFiles.length) {
    return false;
  }
  if (
    output.stats.discoveredFilesCount + output.stats.skippedOversizedFilesCount >
    request.input.supportedFiles.length
  ) {
    return false;
  }
  if (output.stats.configFilesCount > request.input.configFiles.length) {
    return false;
  }
  if (output.stats.totalBytesRead > request.input.maxTotalBytes) {
    return false;
  }

  for (const node of output.nodes) {
    if (node.nodeType === 'file' && !allowedSources.has(node.filePath)) {
      return false;
    }
  }
  return true;
}

function mapChildErrorToParentError(
  childErr: ParserIpcErrorResponseV1,
  requestId: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string,
): ParserRunnerError {
  const cleanExit = exitCode === 0 && signal === null;
  const payload = childErr.error;

  if (payload.kind === 'PROTOCOL_ERROR') {
    return new ParserRunnerError({
      code: 'INVALID_RESPONSE',
      message: SAFE_PARENT_MESSAGES.INVALID_RESPONSE,
      retryable: false,
      requestId,
      exitCode,
      signal,
    });
  }

  if (payload.kind === 'RESPONSE_TOO_LARGE') {
    return new ParserRunnerError({
      code: 'RESPONSE_TOO_LARGE',
      message: SAFE_PARENT_MESSAGES.RESPONSE_TOO_LARGE,
      retryable: false,
      requestId,
      exitCode,
      signal,
    });
  }

  if (payload.kind === 'INVALID_REQUEST') {
    return new ParserRunnerError({
      code: 'INVALID_REQUEST',
      message: SAFE_PARENT_MESSAGES.INVALID_REQUEST,
      retryable: false,
      requestId,
      exitCode,
      signal,
    });
  }

  if (!cleanExit) {
    if (isCorroboratedHeapExhaustion(stderrTail, exitCode, signal)) {
      return new ParserRunnerError({
        code: 'CONFIRMED_HEAP_EXHAUSTION',
        message: SAFE_PARENT_MESSAGES.CONFIRMED_HEAP_EXHAUSTION,
        retryable: false,
        requestId,
        exitCode,
        signal,
      });
    }
    return new ParserRunnerError({
      code: 'UNEXPECTED_CHILD_EXIT',
      message: SAFE_PARENT_MESSAGES.UNEXPECTED_CHILD_EXIT,
      retryable: true,
      requestId,
      exitCode,
      signal,
    });
  }

  if (payload.kind === 'CORE_ANALYSIS_ERROR') {
    return new ParserRunnerError({
      code: 'CORE_ANALYSIS_ERROR',
      message: getSafeCoreAnalysisErrorMessage(payload.code),
      retryable: false,
      coreErrorCode: payload.code,
      requestId,
      exitCode,
      signal,
    });
  }

  return new ParserRunnerError({
    code: 'CHILD_INTERNAL_ERROR',
    message: SAFE_PARENT_MESSAGES.CHILD_INTERNAL_ERROR,
    retryable: false,
    requestId,
    exitCode,
    signal,
  });
}

function defaultSpawnChild(args: ParserSpawnArgs): ParserChildProcessLike {
  const child = fork(args.entrypointPath, [], {
    execPath: args.execPath,
    execArgv: [...args.execArgv],
    cwd: args.cwd,
    env: { ...args.env },
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return child;
}

function safeReleaseStream(stream: Readable | null): void {
  if (stream === null) {
    return;
  }
  try {
    stream.destroy();
  } catch {
    // Ignore synchronous stream destroy failures during failed-spawn cleanup
  }
}

function createRunnerInternal(
  rawOptions: ParserRunnerOptions,
  testHooks: ParserRunnerTestHooks | undefined,
): ParserRunner {
  const config = validateRunnerOptions(rawOptions);
  const platform = testHooks?.platform ?? process.platform;
  const resolvedPaths = resolveCompiledParserChildPath();
  const entrypointPath = testHooks?.entrypointPathOverride ?? resolvedPaths.entrypointPath;
  const trustedDistDir = testHooks?.trustedDirOverride ?? resolvedPaths.trustedDistDir;
  const trustedCwd = testHooks?.trustedCwdOverride ?? resolvedPaths.workerPackageRoot;
  const spawnChild = testHooks?.spawnChild ?? defaultSpawnChild;

  const instance = {
    state: 'IDLE' as ParserRunnerState,
    activeChild: null as ParserChildProcessLike | null,
    fatalLatched: false,
  };

  const run = async (input: ParserRunInput): Promise<ParserRunResult> => {
    if (
      instance.fatalLatched ||
      instance.state === 'FATAL_TERMINATION_UNCONFIRMED' ||
      instance.state === 'FATAL_CLEANUP_UNCONFIRMED'
    ) {
      const fatalCode =
        instance.state === 'FATAL_CLEANUP_UNCONFIRMED'
          ? 'FATAL_CLEANUP_UNCONFIRMED'
          : 'FATAL_TERMINATION_UNCONFIRMED';
      throw new ParserRunnerError({
        code: fatalCode,
        message: SAFE_PARENT_MESSAGES[fatalCode],
        retryable: false,
        fatal: true,
      });
    }

    if (instance.state !== 'IDLE' || instance.activeChild !== null) {
      throw new ParserRunnerError({
        code: 'CONCURRENT_RUN_REJECTED',
        message: SAFE_PARENT_MESSAGES.CONCURRENT_RUN_REJECTED,
        retryable: false,
      });
    }

    instance.state = 'VALIDATING';
    const requestId = randomUUID();

    if (isAbortRequested(input.signal)) {
      instance.state = 'IDLE';
      throw new ParserRunnerError({
        code: 'PARSER_CANCELLED',
        message: SAFE_PARENT_MESSAGES.PARSER_CANCELLED,
        retryable: true,
        requestId,
      });
    }

    const candidateRequest: ParserIpcRequestV1 = {
      protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
      type: 'ANALYZE_REQUEST',
      requestId,
      input: {
        rootDir: input.rootDir,
        supportedFiles: input.supportedFiles,
        configFiles: input.configFiles,
        maxSupportedFiles: input.maxSupportedFiles ?? DEFAULT_MAX_SUPPORTED_FILES,
        maxConfigFiles: input.maxConfigFiles ?? DEFAULT_MAX_CONFIG_FILES,
        maxFileBytes: input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
        maxTotalBytes: input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
        maxFileSnippetChars: input.maxFileSnippetChars ?? DEFAULT_MAX_FILE_SNIPPET_CHARS,
        maxSymbolSnippetChars: input.maxSymbolSnippetChars ?? DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
        maxCallSiteSnippetChars:
          input.maxCallSiteSnippetChars ?? DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
        maxWarnings: input.maxWarnings ?? DEFAULT_MAX_WARNINGS,
        maxExtendsDepth: input.maxExtendsDepth ?? DEFAULT_MAX_EXTENDS_DEPTH,
        skipLoadingLibFiles: input.skipLoadingLibFiles ?? config.skipLoadingLibFiles,
      },
      maxResponseBytes: config.maxResponseBytes,
    };

    const parsedReq = parseParserIpcRequest(candidateRequest);
    if (!parsedReq.ok) {
      instance.state = 'IDLE';
      throw new ParserRunnerError({
        code: 'INVALID_REQUEST',
        message: parsedReq.message,
        retryable: false,
        requestId,
      });
    }
    const validatedRequest = parsedReq.data;

    let verifiedEntrypoint: string;
    try {
      verifiedEntrypoint =
        testHooks?.skipEntrypointValidation === true
          ? entrypointPath
          : await validateCompiledParserEntrypoint(entrypointPath, trustedDistDir);
    } catch (err: unknown) {
      instance.state = 'IDLE';
      throw err;
    }

    if (isAbortRequested(input.signal)) {
      instance.state = 'IDLE';
      throw new ParserRunnerError({
        code: 'PARSER_CANCELLED',
        message: SAFE_PARENT_MESSAGES.PARSER_CANCELLED,
        retryable: true,
        requestId,
      });
    }

    instance.state = 'SPAWNING';
    const parentBaselineMem = process.memoryUsage();
    const runStartMs = performance.now();
    const childEnv = buildMinimalChildEnv(testHooks?.sourceEnv ?? process.env, platform);
    const execArgv = [`--max-old-space-size=${String(config.maxOldSpaceSizeMb)}`];

    let child: ParserChildProcessLike;
    try {
      child = spawnChild({
        entrypointPath: verifiedEntrypoint,
        execPath: process.execPath,
        execArgv,
        cwd: trustedCwd,
        env: childEnv,
      });
    } catch (err: unknown) {
      instance.state = 'IDLE';
      throw new ParserRunnerError({
        code: 'SPAWN_FAILED',
        message: SAFE_PARENT_MESSAGES.SPAWN_FAILED,
        retryable: true,
        requestId,
        cause: err,
      });
    }

    instance.activeChild = child;
    instance.state = 'RUNNING';

    return await new Promise<ParserRunResult>((resolve, reject) => {
      const stdoutTail = new BoundedUtf8TailBuffer(config.maxDiagnosticStreamBytes);
      const stderrTail = new BoundedUtf8TailBuffer(config.maxDiagnosticStreamBytes);

      const runState = {
        settled: false,
        hasSpawned: child.pid !== undefined,
        processExited: false,
        closeObserved: false,
        stdoutClosed: child.stdout === null,
        stderrClosed: child.stderr === null,
        ipcDisconnected: !child.connected,
        sendSettled: true,
        postSpawnError: null as Error | null,
        receivedMessageCount: 0,
        validSuccess: null as ParserIpcSuccessResponseV1 | null,
        validChildError: null as ParserIpcErrorResponseV1 | null,
        serializedResponseBytes: 0,
        parentValidationDurationMs: 0,
        latchedFailure: null as ParserRunnerError | null,
        exitCode: null as number | null,
        signal: null as NodeJS.Signals | null,
        terminating: false,
        overallTimer: undefined as NodeJS.Timeout | undefined,
        disconnectTimer: undefined as NodeJS.Timeout | undefined,
        graceTimer: undefined as NodeJS.Timeout | undefined,
        killConfirmTimer: undefined as NodeJS.Timeout | undefined,
        cleanupConfirmTimer: undefined as NodeJS.Timeout | undefined,
        postExitFallbackTimer: undefined as NodeJS.Timeout | undefined,
      };

      const clearTimer = (timer: NodeJS.Timeout | undefined): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };

      const clearAllTimers = (): void => {
        clearTimer(runState.overallTimer);
        runState.overallTimer = undefined;
        clearTimer(runState.disconnectTimer);
        runState.disconnectTimer = undefined;
        clearTimer(runState.graceTimer);
        runState.graceTimer = undefined;
        clearTimer(runState.killConfirmTimer);
        runState.killConfirmTimer = undefined;
        clearTimer(runState.cleanupConfirmTimer);
        runState.cleanupConfirmTimer = undefined;
        clearTimer(runState.postExitFallbackTimer);
        runState.postExitFallbackTimer = undefined;
      };

      const detachAllListeners = (): void => {
        if (input.signal !== undefined) {
          input.signal.removeEventListener('abort', onAbort);
        }
        child.stdout?.removeListener('data', onStdout);
        child.stdout?.removeListener('close', onStdoutClose);
        child.stderr?.removeListener('data', onStderr);
        child.stderr?.removeListener('close', onStderrClose);
        child.removeListener('spawn', onSpawn);
        child.removeListener('message', onMessage);
        child.removeListener('disconnect', onDisconnect);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        child.removeListener('close', onClose);
      };

      const finalizeCleanup = (): void => {
        clearAllTimers();
        detachAllListeners();
        if (instance.activeChild === child) {
          instance.activeChild = null;
        }
        if (!instance.fatalLatched) {
          instance.state = 'IDLE';
        }
      };

      const settleSuccess = (result: ParserRunResult): void => {
        if (runState.settled) {
          return;
        }
        runState.settled = true;
        finalizeCleanup();
        resolve(result);
      };

      const settleFailure = (err: ParserRunnerError): void => {
        if (runState.settled) {
          return;
        }
        runState.settled = true;
        finalizeCleanup();
        reject(err);
      };

      const safeKillChild = (sig?: NodeJS.Signals): void => {
        if (runState.processExited || (!runState.hasSpawned && child.pid === undefined)) {
          return;
        }
        try {
          if (sig !== undefined) {
            child.kill(sig);
          } else {
            child.kill();
          }
        } catch {
          // Ignore synchronous kill errors (e.g. ESRCH if already exited)
        }
      };

      const areRequiredResourcesClosed = (): boolean =>
        runState.processExited &&
        runState.stdoutClosed &&
        runState.stderrClosed &&
        (runState.ipcDisconnected || !child.connected) &&
        runState.sendSettled;

      const finalizeOutcome = (
        finalExitCode: number | null,
        finalSignal: NodeJS.Signals | null,
      ): void => {
        if (runState.settled) {
          return;
        }
        const stderrText = stderrTail.toUtf8String();

        // 1. Latched parent failure (timeout, cancel, protocol violation, fatal latch, send error) wins
        if (runState.latchedFailure !== null) {
          const prior = runState.latchedFailure;
          settleFailure(
            new ParserRunnerError({
              code: prior.code,
              message: prior.message,
              retryable: prior.retryable,
              fatal: prior.fatal,
              startupFailure: prior.startupFailure,
              ...(prior.coreErrorCode !== undefined ? { coreErrorCode: prior.coreErrorCode } : {}),
              requestId,
              exitCode: finalExitCode,
              signal: finalSignal,
              ...(prior.cause !== undefined ? { cause: prior.cause } : {}),
            }),
          );
          return;
        }

        // 2. Valid ANALYZE_SUCCESS requires clean exitCode === 0, signal === null, and no post-spawn error
        if (runState.validSuccess !== null) {
          if (finalExitCode !== 0 || finalSignal !== null || runState.postSpawnError !== null) {
            if (isCorroboratedHeapExhaustion(stderrText, finalExitCode, finalSignal)) {
              settleFailure(
                new ParserRunnerError({
                  code: 'CONFIRMED_HEAP_EXHAUSTION',
                  message: SAFE_PARENT_MESSAGES.CONFIRMED_HEAP_EXHAUSTION,
                  retryable: false,
                  requestId,
                  exitCode: finalExitCode,
                  signal: finalSignal,
                }),
              );
              return;
            }
            settleFailure(
              new ParserRunnerError({
                code: 'UNEXPECTED_CHILD_EXIT',
                message: SAFE_PARENT_MESSAGES.UNEXPECTED_CHILD_EXIT,
                retryable: true,
                requestId,
                exitCode: finalExitCode,
                signal: finalSignal,
                ...(runState.postSpawnError !== null ? { cause: runState.postSpawnError } : {}),
              }),
            );
            return;
          }

          const parentPostMem = process.memoryUsage();
          const endToEndDurationMs = Number(Math.max(0, performance.now() - runStartMs).toFixed(2));
          const childMetrics = runState.validSuccess.metrics;

          settleSuccess({
            requestId: validatedRequest.requestId,
            output: runState.validSuccess.output,
            metrics: {
              endToEndDurationMs,
              childAnalysisDurationMs: childMetrics.durationMs,
              childPreSendMemory: {
                baselineHeapUsedBytes: childMetrics.baselineHeapUsedBytes,
                postHeapUsedBytes: childMetrics.postHeapUsedBytes,
                baselineRssBytes: childMetrics.baselineRssBytes,
                postRssBytes: childMetrics.postRssBytes,
                maxRssKiB: childMetrics.maxRssKiB,
              },
              serializedResponseBytes: runState.serializedResponseBytes,
              parentValidationDurationMs: runState.parentValidationDurationMs,
              parentMemory: {
                baselineHeapUsedBytes: parentBaselineMem.heapUsed,
                postHeapUsedBytes: parentPostMem.heapUsed,
                baselineRssBytes: parentBaselineMem.rss,
                postRssBytes: parentPostMem.rss,
              },
              exitCode: finalExitCode,
              signal: finalSignal,
            },
          });
          return;
        }

        // 3. Valid ANALYZE_ERROR mapped with explicit precedence
        if (runState.validChildError !== null) {
          settleFailure(
            mapChildErrorToParentError(
              runState.validChildError,
              requestId,
              finalExitCode,
              finalSignal,
              stderrText,
            ),
          );
          return;
        }

        // 4. No response received before confirmed exit + cleanup
        if (isCorroboratedHeapExhaustion(stderrText, finalExitCode, finalSignal)) {
          settleFailure(
            new ParserRunnerError({
              code: 'CONFIRMED_HEAP_EXHAUSTION',
              message: SAFE_PARENT_MESSAGES.CONFIRMED_HEAP_EXHAUSTION,
              retryable: false,
              requestId,
              exitCode: finalExitCode,
              signal: finalSignal,
            }),
          );
          return;
        }

        if (finalExitCode === 0 && finalSignal === null && runState.postSpawnError === null) {
          settleFailure(
            new ParserRunnerError({
              code: 'MISSING_RESPONSE',
              message: SAFE_PARENT_MESSAGES.MISSING_RESPONSE,
              retryable: false,
              requestId,
              exitCode: finalExitCode,
              signal: finalSignal,
            }),
          );
          return;
        }

        settleFailure(
          new ParserRunnerError({
            code: 'UNEXPECTED_CHILD_EXIT',
            message: SAFE_PARENT_MESSAGES.UNEXPECTED_CHILD_EXIT,
            retryable: true,
            requestId,
            exitCode: finalExitCode,
            signal: finalSignal,
            ...(runState.postSpawnError !== null ? { cause: runState.postSpawnError } : {}),
          }),
        );
      };

      /**
       * Controlled fallback when `exit` and all required resource closures (stdout, stderr,
       * IPC disconnect, send completion) have been confirmed, yet Node's aggregate `close`
       * event has not arrived. Waits a brief grace window so real `close` still handles the
       * ordinary path first.
       */
      const maybeSchedulePostExitFallback = (): void => {
        if (
          runState.settled ||
          runState.closeObserved ||
          runState.postExitFallbackTimer !== undefined ||
          !areRequiredResourcesClosed()
        ) {
          return;
        }
        const closeGraceMs = Math.min(config.terminateGraceMs, MAX_POST_EXIT_CLOSE_GRACE_MS);
        runState.postExitFallbackTimer = setTimeout(() => {
          runState.postExitFallbackTimer = undefined;
          if (!runState.settled && !runState.closeObserved && areRequiredResourcesClosed()) {
            finalizeOutcome(runState.exitCode, runState.signal);
          }
        }, closeGraceMs);
      };

      const latchFatalState = (
        fatalCode: 'FATAL_TERMINATION_UNCONFIRMED' | 'FATAL_CLEANUP_UNCONFIRMED',
        priorFailure: ParserRunnerError | null,
      ): void => {
        if (runState.settled || instance.fatalLatched) {
          return;
        }
        instance.fatalLatched = true;
        instance.state = fatalCode;
        const fatalErr = new ParserRunnerError({
          code: fatalCode,
          message: SAFE_PARENT_MESSAGES[fatalCode],
          retryable: false,
          fatal: true,
          requestId,
          ...(runState.processExited
            ? { exitCode: runState.exitCode, signal: runState.signal }
            : {}),
          ...(priorFailure !== null ? { cause: priorFailure } : {}),
        });
        runState.latchedFailure = fatalErr;
        if (config.onFatalState !== undefined) {
          try {
            config.onFatalState({
              error: fatalErr,
              requestId,
              pid: child.pid,
              processExited: runState.processExited,
            });
          } catch {
            // Fatal hook exceptions must not disrupt deferred listener retention
          }
        }
      };

      /**
       * Kill-first termination policy (never calls proactive `child.disconnect()` before kill,
       * avoiding missing aggregate `close` events observed on Windows Node 24 when disconnecting
       * immediately before terminating). Never issues `SIGKILL` against an already exited child.
       */
      const initiateTermination = (failure: ParserRunnerError): void => {
        if (runState.settled) {
          return;
        }
        runState.latchedFailure ??= failure;
        if (runState.terminating || runState.processExited) {
          return;
        }
        runState.terminating = true;
        clearTimer(runState.overallTimer);
        runState.overallTimer = undefined;
        clearTimer(runState.disconnectTimer);
        runState.disconnectTimer = undefined;

        if (!instance.fatalLatched) {
          instance.state = 'TERMINATING_GRACE';
        }

        safeKillChild(platform === 'win32' ? undefined : 'SIGTERM');

        runState.graceTimer = setTimeout(() => {
          runState.graceTimer = undefined;
          if (runState.settled || runState.processExited) {
            return;
          }
          if (!instance.fatalLatched) {
            instance.state = 'TERMINATING_FORCED';
          }
          safeKillChild('SIGKILL');

          runState.killConfirmTimer = setTimeout(() => {
            runState.killConfirmTimer = undefined;
            if (runState.settled || runState.processExited) {
              return;
            }
            // OS process exit is genuinely unconfirmed -> latch fatal without settling promise
            // (preserving workspace lease and deferred listeners; never unref).
            latchFatalState('FATAL_TERMINATION_UNCONFIRMED', runState.latchedFailure);
          }, config.killConfirmationMs);
        }, config.terminateGraceMs);
      };

      const onSpawn = (): void => {
        runState.hasSpawned = true;
      };

      const onStdout = (chunk: Buffer | string): void => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        stdoutTail.append(buf);
      };

      const onStdoutClose = (): void => {
        runState.stdoutClosed = true;
        maybeSchedulePostExitFallback();
      };

      const onStderr = (chunk: Buffer | string): void => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        stderrTail.append(buf);
      };

      const onStderrClose = (): void => {
        runState.stderrClosed = true;
        maybeSchedulePostExitFallback();
      };

      const onAbort = (): void => {
        if (runState.settled) {
          return;
        }
        initiateTermination(
          new ParserRunnerError({
            code: 'PARSER_CANCELLED',
            message: SAFE_PARENT_MESSAGES.PARSER_CANCELLED,
            retryable: true,
            requestId,
          }),
        );
      };

      const onMessage = (rawMessage: unknown): void => {
        if (runState.settled || runState.latchedFailure !== null) {
          return;
        }

        runState.receivedMessageCount += 1;
        if (runState.receivedMessageCount > 1) {
          runState.validSuccess = null;
          runState.validChildError = null;
          initiateTermination(
            new ParserRunnerError({
              code: 'DUPLICATE_RESPONSE',
              message: SAFE_PARENT_MESSAGES.DUPLICATE_RESPONSE,
              retryable: false,
              requestId,
            }),
          );
          return;
        }

        const validationStartMs = performance.now();

        let serialized: unknown;
        try {
          serialized = JSON.stringify(rawMessage);
        } catch (err: unknown) {
          initiateTermination(
            new ParserRunnerError({
              code: 'INVALID_RESPONSE',
              message: SAFE_PARENT_MESSAGES.INVALID_RESPONSE,
              retryable: false,
              requestId,
              cause: err,
            }),
          );
          return;
        }

        if (typeof serialized !== 'string') {
          initiateTermination(
            new ParserRunnerError({
              code: 'INVALID_RESPONSE',
              message: SAFE_PARENT_MESSAGES.INVALID_RESPONSE,
              retryable: false,
              requestId,
            }),
          );
          return;
        }

        const responseBytes = Buffer.byteLength(serialized, 'utf8');
        runState.serializedResponseBytes = responseBytes;
        if (responseBytes > config.maxResponseBytes) {
          initiateTermination(
            new ParserRunnerError({
              code: 'RESPONSE_TOO_LARGE',
              message: SAFE_PARENT_MESSAGES.RESPONSE_TOO_LARGE,
              retryable: false,
              requestId,
            }),
          );
          return;
        }

        if (!isPlainRecord(rawMessage)) {
          initiateTermination(
            new ParserRunnerError({
              code: 'INVALID_RESPONSE',
              message: SAFE_PARENT_MESSAGES.INVALID_RESPONSE,
              retryable: false,
              requestId,
            }),
          );
          return;
        }

        if (rawMessage.protocolVersion !== PARSER_IPC_PROTOCOL_VERSION) {
          initiateTermination(
            new ParserRunnerError({
              code: 'INVALID_RESPONSE',
              message: SAFE_PARENT_MESSAGES.INVALID_RESPONSE,
              retryable: false,
              requestId,
            }),
          );
          return;
        }

        // Parent runner always sends a validated UUID requestId -> require exact correlation
        // on BOTH ANALYZE_SUCCESS and ANALYZE_ERROR (reject null or mismatched requestIds).
        if (
          (rawMessage.type === 'ANALYZE_SUCCESS' || rawMessage.type === 'ANALYZE_ERROR') &&
          rawMessage.requestId !== validatedRequest.requestId
        ) {
          initiateTermination(
            new ParserRunnerError({
              code: 'REQUEST_ID_MISMATCH',
              message: SAFE_PARENT_MESSAGES.REQUEST_ID_MISMATCH,
              retryable: false,
              requestId,
            }),
          );
          return;
        }

        const parsedResp = parseParserIpcResponse(rawMessage, {
          maxFileSnippetChars: validatedRequest.input.maxFileSnippetChars,
          maxSymbolSnippetChars: validatedRequest.input.maxSymbolSnippetChars,
          maxCallSiteSnippetChars: validatedRequest.input.maxCallSiteSnippetChars,
          maxWarnings: validatedRequest.input.maxWarnings,
        });

        runState.parentValidationDurationMs = Number(
          Math.max(0, performance.now() - validationStartMs).toFixed(2),
        );

        if (!parsedResp.ok) {
          initiateTermination(
            new ParserRunnerError({
              code: 'INVALID_RESPONSE',
              message: parsedResp.message,
              retryable: false,
              requestId,
            }),
          );
          return;
        }

        if (parsedResp.data.type === 'ANALYZE_SUCCESS') {
          if (!validateGraphAgainstRequest(parsedResp.data.output, validatedRequest)) {
            initiateTermination(
              new ParserRunnerError({
                code: 'INVALID_RESPONSE',
                message: SAFE_PARENT_MESSAGES.INVALID_RESPONSE,
                retryable: false,
                requestId,
              }),
            );
            return;
          }
          runState.validSuccess = parsedResp.data;
        } else {
          runState.validChildError = parsedResp.data;
        }

        if (!instance.fatalLatched && !runState.terminating && !runState.processExited) {
          instance.state = 'RESPONSE_RECEIVED_AWAITING_EXIT';
        }
      };

      const onDisconnect = (): void => {
        runState.ipcDisconnected = true;
        if (runState.settled) {
          return;
        }
        if (runState.processExited) {
          maybeSchedulePostExitFallback();
          return;
        }
        if (
          !runState.terminating &&
          runState.validSuccess === null &&
          runState.validChildError === null
        ) {
          runState.disconnectTimer = setTimeout(() => {
            runState.disconnectTimer = undefined;
            if (runState.settled || runState.terminating || runState.processExited) {
              return;
            }
            initiateTermination(
              new ParserRunnerError({
                code: 'UNEXPECTED_CHILD_EXIT',
                message: SAFE_PARENT_MESSAGES.UNEXPECTED_CHILD_EXIT,
                retryable: true,
                requestId,
              }),
            );
          }, config.terminateGraceMs);
        }
      };

      const onError = (err: Error): void => {
        if (runState.settled) {
          return;
        }
        runState.postSpawnError ??= err;

        // Confirmed no-process spawn failure (never spawned, pid === undefined)
        if (!runState.hasSpawned && child.pid === undefined) {
          safeReleaseStream(child.stdout);
          safeReleaseStream(child.stderr);
          const swallowLateError = (): void => {
            // Absorb any secondary late error event on a failed-to-spawn handle
          };
          settleFailure(
            new ParserRunnerError({
              code: 'SPAWN_FAILED',
              message: SAFE_PARENT_MESSAGES.SPAWN_FAILED,
              retryable: true,
              requestId,
              cause: err,
            }),
          );
          child.on('error', swallowLateError);
          child.once('close', () => {
            child.removeListener('error', swallowLateError);
          });
          return;
        }

        // Post-spawn error on a live child is NOT proof of termination
        initiateTermination(
          new ParserRunnerError({
            code: 'UNEXPECTED_CHILD_EXIT',
            message: SAFE_PARENT_MESSAGES.UNEXPECTED_CHILD_EXIT,
            retryable: true,
            requestId,
            cause: err,
          }),
        );
      };

      const ensureCleanupConfirmTimer = (): void => {
        runState.cleanupConfirmTimer ??= setTimeout(() => {
          runState.cleanupConfirmTimer = undefined;
          if (runState.settled) {
            return;
          }
          if (areRequiredResourcesClosed()) {
            finalizeOutcome(runState.exitCode, runState.signal);
            return;
          }
          latchFatalState('FATAL_CLEANUP_UNCONFIRMED', runState.latchedFailure);
        }, config.killConfirmationMs);
      };

      const onExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (runState.settled) {
          return;
        }
        runState.processExited = true;
        runState.exitCode = exitCode;
        runState.signal = signal;

        // Confirmed OS process exit -> cancel running/kill escalation timers immediately;
        // never issue further SIGKILL requests against an already exited child.
        clearTimer(runState.overallTimer);
        runState.overallTimer = undefined;
        clearTimer(runState.disconnectTimer);
        runState.disconnectTimer = undefined;
        clearTimer(runState.graceTimer);
        runState.graceTimer = undefined;
        clearTimer(runState.killConfirmTimer);
        runState.killConfirmTimer = undefined;

        if (!child.connected) {
          runState.ipcDisconnected = true;
        }

        if (!instance.fatalLatched) {
          instance.state = 'EXITED_AWAITING_CLEANUP';
        }

        ensureCleanupConfirmTimer();
        maybeSchedulePostExitFallback();
      };

      const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (runState.settled) {
          return;
        }
        runState.closeObserved = true;
        runState.processExited = true;
        runState.stdoutClosed = true;
        runState.stderrClosed = true;
        runState.ipcDisconnected = true;
        runState.exitCode = exitCode ?? runState.exitCode;
        runState.signal = signal ?? runState.signal;

        clearTimer(runState.overallTimer);
        runState.overallTimer = undefined;
        clearTimer(runState.disconnectTimer);
        runState.disconnectTimer = undefined;
        clearTimer(runState.graceTimer);
        runState.graceTimer = undefined;
        clearTimer(runState.killConfirmTimer);
        runState.killConfirmTimer = undefined;
        clearTimer(runState.postExitFallbackTimer);
        runState.postExitFallbackTimer = undefined;

        // Do not accept success or finalize while the IPC send callback is still unresolved
        if (!runState.sendSettled) {
          if (!instance.fatalLatched) {
            instance.state = 'EXITED_AWAITING_CLEANUP';
          }
          ensureCleanupConfirmTimer();
          return;
        }

        finalizeOutcome(runState.exitCode, runState.signal);
      };

      // 1. Attach all child lifecycle & stream listeners first
      child.stdout?.on('data', onStdout);
      child.stdout?.on('close', onStdoutClose);
      child.stderr?.on('data', onStderr);
      child.stderr?.on('close', onStderrClose);
      child.on('spawn', onSpawn);
      child.on('message', onMessage);
      child.on('disconnect', onDisconnect);
      child.on('error', onError);
      child.on('exit', onExit);
      child.on('close', onClose);

      // 2. Register abort listener AND immediately recheck abort state to eliminate
      //    any cancellation race during synchronous spawnChild().
      if (input.signal !== undefined) {
        input.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (isAbortRequested(input.signal)) {
        initiateTermination(
          new ParserRunnerError({
            code: 'PARSER_CANCELLED',
            message: SAFE_PARENT_MESSAGES.PARSER_CANCELLED,
            retryable: true,
            requestId,
          }),
        );
        return;
      }

      // 3. Start overall timeout covering analysis, IPC, and normal child exit
      runState.overallTimer = setTimeout(() => {
        runState.overallTimer = undefined;
        if (runState.settled || runState.processExited) {
          return;
        }
        initiateTermination(
          new ParserRunnerError({
            code: 'PARSER_TIMEOUT',
            message: SAFE_PARENT_MESSAGES.PARSER_TIMEOUT,
            retryable: false,
            requestId,
          }),
        );
      }, config.parserTimeoutMs);

      if (!child.connected) {
        initiateTermination(
          new ParserRunnerError({
            code: 'IPC_SEND_FAILED',
            message: SAFE_PARENT_MESSAGES.IPC_SEND_FAILED,
            retryable: true,
            requestId,
          }),
        );
        return;
      }

      runState.sendSettled = false;
      try {
        // A `false` return indicates IPC kernel buffer backpressure, NOT failure;
        // completion or error is reported asynchronously via callback.
        child.send(validatedRequest, (err) => {
          runState.sendSettled = true;

          if (runState.settled) {
            return;
          }

          if (err !== null) {
            if (!runState.processExited) {
              initiateTermination(
                new ParserRunnerError({
                  code: 'IPC_SEND_FAILED',
                  message: SAFE_PARENT_MESSAGES.IPC_SEND_FAILED,
                  retryable: true,
                  requestId,
                  cause: err,
                }),
              );
            } else if (runState.exitCode === 0 && runState.signal === null) {
              runState.latchedFailure ??= new ParserRunnerError({
                code: 'IPC_SEND_FAILED',
                message: SAFE_PARENT_MESSAGES.IPC_SEND_FAILED,
                retryable: true,
                requestId,
                cause: err,
              });
            }
          }

          if (runState.closeObserved) {
            finalizeOutcome(runState.exitCode, runState.signal);
            return;
          }

          maybeSchedulePostExitFallback();
        });
      } catch (err: unknown) {
        runState.sendSettled = true;
        initiateTermination(
          new ParserRunnerError({
            code: 'IPC_SEND_FAILED',
            message: SAFE_PARENT_MESSAGES.IPC_SEND_FAILED,
            retryable: true,
            requestId,
            cause: err,
          }),
        );
      }
    });
  };

  return {
    run,
    getState: () => instance.state,
    isFatal: () => instance.fatalLatched,
    hasActiveChild: () => instance.activeChild !== null,
  };
}

/**
 * Production parent-side parser runner factory.
 * Always executes the fixed compiled `apps/worker/dist/parser-child.js` entrypoint with
 * fixed approved `execArgv` and minimal allowlisted child environment.
 */
export function createParserRunner(options: ParserRunnerOptions = {}): ParserRunner {
  return createRunnerInternal(options, undefined);
}

/**
 * Internal test-only factory exposing deterministic child-process fault-injection seams.
 * Must NOT be exported from `apps/worker/src/index.ts`.
 */
export function createParserRunnerForTesting(
  options: ParserRunnerOptions,
  testHooks: ParserRunnerTestHooks,
): ParserRunner {
  return createRunnerInternal(options, testHooks);
}
