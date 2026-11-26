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
  getSafeCoreAnalysisErrorMessage,
  type AnalysisOutput,
  type CoreAnalysisErrorCode,
} from '@archon/shared';
import {
  DEFAULT_PARSER_KILL_CONFIRMATION_MS,
  DEFAULT_PARSER_MAX_OLD_SPACE_MB,
  DEFAULT_PARSER_TERMINATE_GRACE_MS,
  DEFAULT_PARSER_TIMEOUT_MS,
  ParserRunnerError,
  createParserRunner,
  resolveCompiledParserChildPath,
  validateCompiledParserEntrypoint,
  type ParserRunMetrics,
  type ParserRunner,
  type ParserRunnerErrorCode,
  type ParserRunnerFatalEvent,
  type ParserRunnerOptions,
  type ParserRunnerState,
} from './parser-runner.js';

const BYTES_PER_MIB = 1024 * 1024;
const MAX_REPO_SIZE_MB = DEFAULT_MAX_TOTAL_BYTES / BYTES_PER_MIB;

/**
 * Benchmarked production parser configuration locked in Batch 4.3C.5.
 * Applied explicitly at the worker integration boundary while preserving
 * `skipLoadingLibFiles: false` defaults on `@archon/core` and `createParserRunner()`.
 *
 * Note: `maxOldSpaceSizeMb` (256 MiB) caps V8 old-space only, NOT total process RSS
 * or container cgroup memory. Automatic library-enabled fallback is intentionally disabled.
 */
export const PRODUCTION_PARSER_CONFIG = {
  skipLoadingLibFiles: true,
  parserTimeoutMs: DEFAULT_PARSER_TIMEOUT_MS,
  maxOldSpaceSizeMb: DEFAULT_PARSER_MAX_OLD_SPACE_MB,
  maxResponseBytes: DEFAULT_MAX_IPC_RESPONSE_BYTES,
  terminateGraceMs: DEFAULT_PARSER_TERMINATE_GRACE_MS,
  killConfirmationMs: DEFAULT_PARSER_KILL_CONFIRMATION_MS,
  concurrency: 1,
  maxSupportedFiles: DEFAULT_MAX_SUPPORTED_FILES,
  maxConfigFiles: DEFAULT_MAX_CONFIG_FILES,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  maxFileSnippetChars: DEFAULT_MAX_FILE_SNIPPET_CHARS,
  maxSymbolSnippetChars: DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
  maxCallSiteSnippetChars: DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
  maxWarnings: DEFAULT_MAX_WARNINGS,
  maxExtendsDepth: DEFAULT_MAX_EXTENDS_DEPTH,
} as const;

export const PARSER_PERSISTED_ERROR_CODES = [
  'PARSER_FILE_LIMIT_EXCEEDED',
  'PARSER_SIZE_LIMIT_EXCEEDED',
  'PARSER_INVALID_WORKSPACE',
  'PARSER_PATH_TRAVERSAL',
  'PARSER_ANALYSIS_REJECTED',
  'PARSER_HEAP_EXHAUSTED',
  'PARSER_TIMEOUT',
  'PARSER_RESPONSE_TOO_LARGE',
  'PARSER_INVALID_REQUEST',
  'PARSER_PROTOCOL_ERROR',
  'PARSER_INTERNAL_ERROR',
  'PARSER_CONCURRENCY_ERROR',
  'PARSER_SPAWN_FAILED',
  'PARSER_IPC_SEND_FAILED',
  'PARSER_CHILD_CRASHED',
  'PARSER_CANCELLED',
  'PARSER_MISCONFIGURED',
  'PARSER_ENTRYPOINT_MISSING',
  'PARSER_FATAL_TERMINATION',
  'PARSER_FATAL_CLEANUP',
] as const;

export type ParserPersistedErrorCode = (typeof PARSER_PERSISTED_ERROR_CODES)[number];

export type ParserFailureDisposition =
  'non_retryable' | 'retryable' | 'cancelled' | 'startup_failure' | 'fatal';

export interface ParserWorkspaceInput {
  readonly rootDir: string;
  readonly supportedFiles: readonly string[];
  readonly configFiles: readonly string[];
}

export interface ProductionParserLimits {
  readonly maxSupportedFiles?: number;
  readonly maxConfigFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileSnippetChars?: number;
  readonly maxSymbolSnippetChars?: number;
  readonly maxCallSiteSnippetChars?: number;
  readonly maxWarnings?: number;
  readonly maxExtendsDepth?: number;
}

export interface ResolvedProductionParserLimits {
  readonly maxSupportedFiles: number;
  readonly maxConfigFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFileSnippetChars: number;
  readonly maxSymbolSnippetChars: number;
  readonly maxCallSiteSnippetChars: number;
  readonly maxWarnings: number;
  readonly maxExtendsDepth: number;
}

export interface ValidatedAnalysisSummary {
  readonly requestId: string;
  readonly discoveredFilesCount: number;
  readonly parsedFilesCount: number;
  readonly skippedSyntaxErrorFilesCount: number;
  readonly skippedOversizedFilesCount: number;
  readonly configFilesCount: number;
  readonly folderNodeCount: number;
  readonly fileNodeCount: number;
  readonly functionNodeCount: number;
  readonly classNodeCount: number;
  readonly symbolNodeCount: number;
  readonly importsEdgeCount: number;
  readonly callsEdgeCount: number;
  readonly totalBytesRead: number;
  readonly warningsCount: number;
  readonly truncatedWarningsCount: number;
  readonly childAnalysisDurationMs: number;
  readonly endToEndDurationMs: number;
  readonly parentValidationDurationMs: number;
  readonly serializedResponseBytes: number;
  readonly skipLoadingLibFiles: boolean;
}

export interface ValidatedAnalysisResult {
  readonly requestId: string;
  readonly output: AnalysisOutput;
  readonly metrics: ParserRunMetrics;
  readonly summary: ValidatedAnalysisSummary;
}

export interface AnalysisResultHandoffContext {
  readonly repositoryId: string;
  readonly jobId: string;
  readonly commitSha: string;
  readonly result: ValidatedAnalysisResult;
  readonly signal?: AbortSignal;
}

/**
 * Explicit Phase 5 graph-persistence handoff seam.
 * Invoked by the ingestion processor AFTER a successful conditional `building_graph`
 * DB transition and BEFORE committing `ready`.
 * Step 4.3 does not persist graphs or retain them in worker memory.
 */
export type AnalysisResultHandoff = (context: AnalysisResultHandoffContext) => Promise<void>;

export const noopAnalysisResultHandoff: AnalysisResultHandoff = async () => {
  // Phase 5 graph persistence is intentionally not implemented in Step 4.3.
};

export interface SafeParserErrorLogRecord {
  readonly persistedCode: ParserPersistedErrorCode;
  readonly runnerCode: ParserRunnerErrorCode;
  readonly coreErrorCode: CoreAnalysisErrorCode | null;
  readonly disposition: ParserFailureDisposition;
  readonly safeMessage: string;
  readonly errorDetail: string;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly startupFailure: boolean;
  readonly requestId: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SafeParserFatalNotification {
  readonly persistedCode: 'PARSER_FATAL_TERMINATION' | 'PARSER_FATAL_CLEANUP';
  readonly runnerCode: 'FATAL_TERMINATION_UNCONFIRMED' | 'FATAL_CLEANUP_UNCONFIRMED';
  readonly safeMessage: string;
  readonly requestId: string;
  readonly pid: number | null;
  readonly processExited: boolean;
}

export type ProductionParserLogEvent =
  | { readonly type: 'analysis_completed'; readonly summary: ValidatedAnalysisSummary }
  | { readonly type: 'analysis_failed'; readonly error: SafeParserErrorLogRecord }
  | { readonly type: 'parser_fatal_state'; readonly fatal: SafeParserFatalNotification };

export interface ClassifiedParserError {
  readonly persistedCode: ParserPersistedErrorCode;
  readonly runnerCode: ParserRunnerErrorCode;
  readonly coreErrorCode: CoreAnalysisErrorCode | null;
  readonly disposition: ParserFailureDisposition;
  readonly safeMessage: string;
  /** Bounded fixed enum code safe for PostgreSQL `error_detail` (never raw stderr/paths/cause). */
  readonly errorDetail: string;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly startupFailure: boolean;
  readonly requestId: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Sanitized integration-boundary error safe for PostgreSQL persistence, structured logs,
 * and BullMQ failure messages. Deliberately omits raw child stderr, stack traces, absolute
 * workspace paths, source snippets, credentials, and untrusted `cause` values.
 */
export class ParserIntegrationError extends Error {
  readonly persistedCode: ParserPersistedErrorCode;
  readonly runnerCode: ParserRunnerErrorCode;
  readonly coreErrorCode: CoreAnalysisErrorCode | null;
  readonly disposition: ParserFailureDisposition;
  readonly errorDetail: string;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly startupFailure: boolean;
  readonly requestId: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(classified: ClassifiedParserError) {
    super(classified.safeMessage);
    this.name = 'ParserIntegrationError';
    this.persistedCode = classified.persistedCode;
    this.runnerCode = classified.runnerCode;
    this.coreErrorCode = classified.coreErrorCode;
    this.disposition = classified.disposition;
    this.errorDetail = classified.errorDetail;
    this.retryable = classified.retryable;
    this.fatal = classified.fatal;
    this.startupFailure = classified.startupFailure;
    this.requestId = classified.requestId;
    this.exitCode = classified.exitCode;
    this.signal = classified.signal;
  }

  toSafeLogObject(): SafeParserErrorLogRecord {
    return {
      persistedCode: this.persistedCode,
      runnerCode: this.runnerCode,
      coreErrorCode: this.coreErrorCode,
      disposition: this.disposition,
      safeMessage: this.message,
      errorDetail: this.errorDetail,
      retryable: this.retryable,
      fatal: this.fatal,
      startupFailure: this.startupFailure,
      requestId: this.requestId,
      exitCode: this.exitCode,
      signal: this.signal,
    };
  }
}

const CORE_ERROR_CLASSIFICATION: Readonly<
  Record<
    CoreAnalysisErrorCode,
    {
      readonly persistedCode: ParserPersistedErrorCode;
      readonly safeMessage: string;
    }
  >
> = {
  INVALID_WORKSPACE: {
    persistedCode: 'PARSER_INVALID_WORKSPACE',
    safeMessage: getSafeCoreAnalysisErrorMessage('INVALID_WORKSPACE'),
  },
  PATH_TRAVERSAL_REJECTED: {
    persistedCode: 'PARSER_PATH_TRAVERSAL',
    safeMessage: getSafeCoreAnalysisErrorMessage('PATH_TRAVERSAL_REJECTED'),
  },
  FILE_LIMIT_EXCEEDED: {
    persistedCode: 'PARSER_FILE_LIMIT_EXCEEDED',
    safeMessage: getSafeCoreAnalysisErrorMessage('FILE_LIMIT_EXCEEDED'),
  },
  SIZE_LIMIT_EXCEEDED: {
    persistedCode: 'PARSER_SIZE_LIMIT_EXCEEDED',
    safeMessage: getSafeCoreAnalysisErrorMessage('SIZE_LIMIT_EXCEEDED'),
  },
};

const RUNNER_ERROR_CLASSIFICATION: Readonly<
  Record<
    Exclude<ParserRunnerErrorCode, 'CORE_ANALYSIS_ERROR'>,
    {
      readonly persistedCode: ParserPersistedErrorCode;
      readonly disposition: ParserFailureDisposition;
      readonly safeMessage: string;
    }
  >
> = {
  INVALID_RUNNER_CONFIG: {
    persistedCode: 'PARSER_MISCONFIGURED',
    disposition: 'startup_failure',
    safeMessage: 'Parser runtime configuration is invalid.',
  },
  MISSING_ENTRYPOINT: {
    persistedCode: 'PARSER_ENTRYPOINT_MISSING',
    disposition: 'startup_failure',
    safeMessage: 'Compiled parser child entrypoint is missing or invalid.',
  },
  INVALID_REQUEST: {
    persistedCode: 'PARSER_INVALID_REQUEST',
    disposition: 'non_retryable',
    safeMessage: 'Static analysis request failed validation.',
  },
  CONCURRENT_RUN_REJECTED: {
    persistedCode: 'PARSER_CONCURRENCY_ERROR',
    disposition: 'non_retryable',
    safeMessage: 'Parser concurrency invariant violated.',
  },
  SPAWN_FAILED: {
    persistedCode: 'PARSER_SPAWN_FAILED',
    disposition: 'retryable',
    safeMessage: 'Transient static analysis process startup failure.',
  },
  IPC_SEND_FAILED: {
    persistedCode: 'PARSER_IPC_SEND_FAILED',
    disposition: 'retryable',
    safeMessage: 'Transient static analysis IPC communication failure.',
  },
  INVALID_RESPONSE: {
    persistedCode: 'PARSER_PROTOCOL_ERROR',
    disposition: 'non_retryable',
    safeMessage: 'Static analysis failed due to an internal protocol error.',
  },
  REQUEST_ID_MISMATCH: {
    persistedCode: 'PARSER_PROTOCOL_ERROR',
    disposition: 'non_retryable',
    safeMessage: 'Static analysis failed due to an internal protocol error.',
  },
  DUPLICATE_RESPONSE: {
    persistedCode: 'PARSER_PROTOCOL_ERROR',
    disposition: 'non_retryable',
    safeMessage: 'Static analysis failed due to an internal protocol error.',
  },
  MISSING_RESPONSE: {
    persistedCode: 'PARSER_PROTOCOL_ERROR',
    disposition: 'non_retryable',
    safeMessage: 'Static analysis failed due to an internal protocol error.',
  },
  RESPONSE_TOO_LARGE: {
    persistedCode: 'PARSER_RESPONSE_TOO_LARGE',
    disposition: 'non_retryable',
    safeMessage: 'Static analysis output exceeded maximum IPC size.',
  },
  CHILD_INTERNAL_ERROR: {
    persistedCode: 'PARSER_INTERNAL_ERROR',
    disposition: 'non_retryable',
    safeMessage: 'Static analysis failed due to an internal parser error.',
  },
  UNEXPECTED_CHILD_EXIT: {
    persistedCode: 'PARSER_CHILD_CRASHED',
    disposition: 'retryable',
    safeMessage: 'Transient static analysis process failure.',
  },
  CONFIRMED_HEAP_EXHAUSTION: {
    persistedCode: 'PARSER_HEAP_EXHAUSTED',
    disposition: 'non_retryable',
    safeMessage: 'Static analysis exceeded parser memory limit.',
  },
  PARSER_TIMEOUT: {
    persistedCode: 'PARSER_TIMEOUT',
    disposition: 'non_retryable',
    safeMessage: 'Static analysis timed out.',
  },
  PARSER_CANCELLED: {
    persistedCode: 'PARSER_CANCELLED',
    disposition: 'cancelled',
    safeMessage: 'Repository analysis interrupted during worker shutdown.',
  },
  FATAL_TERMINATION_UNCONFIRMED: {
    persistedCode: 'PARSER_FATAL_TERMINATION',
    disposition: 'fatal',
    safeMessage: 'Parser termination could not be confirmed; worker requires restart.',
  },
  FATAL_CLEANUP_UNCONFIRMED: {
    persistedCode: 'PARSER_FATAL_CLEANUP',
    disposition: 'fatal',
    safeMessage: 'Parser resource cleanup could not be confirmed; worker requires restart.',
  },
};

/**
 * Exhaustively classifies any `ParserRunnerError` into a fixed safe persisted code,
 * fixed safe message, and explicit disposition while preserving the runner's authoritative
 * `retryable`, `fatal`, and `startupFailure` properties.
 */
export function classifyParserRunnerError(err: ParserRunnerError): ClassifiedParserError {
  if (err.code === 'CORE_ANALYSIS_ERROR') {
    const coreInfo =
      err.coreErrorCode !== undefined
        ? CORE_ERROR_CLASSIFICATION[err.coreErrorCode]
        : {
            persistedCode: 'PARSER_ANALYSIS_REJECTED' as const,
            safeMessage: 'Static analysis rejected workspace input.',
          };
    return {
      persistedCode: coreInfo.persistedCode,
      runnerCode: err.code,
      coreErrorCode: err.coreErrorCode ?? null,
      disposition: 'non_retryable',
      safeMessage: coreInfo.safeMessage,
      errorDetail: err.coreErrorCode ?? err.code,
      retryable: err.retryable,
      fatal: err.fatal,
      startupFailure: err.startupFailure,
      requestId: err.requestId ?? null,
      exitCode: err.exitCode ?? null,
      signal: err.signal ?? null,
    };
  }

  const mapped = RUNNER_ERROR_CLASSIFICATION[err.code];
  return {
    persistedCode: mapped.persistedCode,
    runnerCode: err.code,
    coreErrorCode: null,
    disposition: mapped.disposition,
    safeMessage: mapped.safeMessage,
    errorDetail: err.code,
    retryable: err.retryable,
    fatal: err.fatal,
    startupFailure: err.startupFailure,
    requestId: err.requestId ?? null,
    exitCode: err.exitCode ?? null,
    signal: err.signal ?? null,
  };
}

function classifyUnexpectedParserException(): ClassifiedParserError {
  const mapped = RUNNER_ERROR_CLASSIFICATION.CHILD_INTERNAL_ERROR;
  return {
    persistedCode: mapped.persistedCode,
    runnerCode: 'CHILD_INTERNAL_ERROR',
    coreErrorCode: null,
    disposition: 'non_retryable',
    safeMessage: mapped.safeMessage,
    errorDetail: 'UNEXPECTED_PARSER_EXCEPTION',
    retryable: false,
    fatal: false,
    startupFailure: false,
    requestId: null,
    exitCode: null,
    signal: null,
  };
}

function validateSafeIntBound(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ParserIntegrationError({
      persistedCode: 'PARSER_MISCONFIGURED',
      runnerCode: 'INVALID_RUNNER_CONFIG',
      coreErrorCode: null,
      disposition: 'startup_failure',
      safeMessage: RUNNER_ERROR_CLASSIFICATION.INVALID_RUNNER_CONFIG.safeMessage,
      errorDetail: 'INVALID_RUNNER_CONFIG',
      retryable: false,
      fatal: false,
      startupFailure: true,
      requestId: null,
      exitCode: null,
      signal: null,
    });
  }
  return value;
}

/**
 * Validates optional caller-supplied analysis limits against the parser IPC ceilings
 * without ever silently clamping out-of-range values.
 */
export function validateProductionParserLimits(
  limits: ProductionParserLimits = {},
): ResolvedProductionParserLimits {
  return {
    maxSupportedFiles: validateSafeIntBound(
      limits.maxSupportedFiles,
      PRODUCTION_PARSER_CONFIG.maxSupportedFiles,
      1,
      PRODUCTION_PARSER_CONFIG.maxSupportedFiles,
    ),
    maxConfigFiles: validateSafeIntBound(
      limits.maxConfigFiles,
      PRODUCTION_PARSER_CONFIG.maxConfigFiles,
      1,
      PRODUCTION_PARSER_CONFIG.maxConfigFiles,
    ),
    maxFileBytes: validateSafeIntBound(
      limits.maxFileBytes,
      PRODUCTION_PARSER_CONFIG.maxFileBytes,
      1,
      PRODUCTION_PARSER_CONFIG.maxFileBytes,
    ),
    maxTotalBytes: validateSafeIntBound(
      limits.maxTotalBytes,
      PRODUCTION_PARSER_CONFIG.maxTotalBytes,
      1,
      PRODUCTION_PARSER_CONFIG.maxTotalBytes,
    ),
    maxFileSnippetChars: validateSafeIntBound(
      limits.maxFileSnippetChars,
      PRODUCTION_PARSER_CONFIG.maxFileSnippetChars,
      0,
      PRODUCTION_PARSER_CONFIG.maxFileSnippetChars,
    ),
    maxSymbolSnippetChars: validateSafeIntBound(
      limits.maxSymbolSnippetChars,
      PRODUCTION_PARSER_CONFIG.maxSymbolSnippetChars,
      0,
      PRODUCTION_PARSER_CONFIG.maxSymbolSnippetChars,
    ),
    maxCallSiteSnippetChars: validateSafeIntBound(
      limits.maxCallSiteSnippetChars,
      PRODUCTION_PARSER_CONFIG.maxCallSiteSnippetChars,
      0,
      PRODUCTION_PARSER_CONFIG.maxCallSiteSnippetChars,
    ),
    maxWarnings: validateSafeIntBound(
      limits.maxWarnings,
      PRODUCTION_PARSER_CONFIG.maxWarnings,
      0,
      PRODUCTION_PARSER_CONFIG.maxWarnings,
    ),
    maxExtendsDepth: validateSafeIntBound(
      limits.maxExtendsDepth,
      PRODUCTION_PARSER_CONFIG.maxExtendsDepth,
      0,
      PRODUCTION_PARSER_CONFIG.maxExtendsDepth,
    ),
  };
}

/**
 * Derives validated production parser limits directly from shared `AppEnv` fields
 * (`MAX_SUPPORTED_FILES`, `MAX_REPO_SIZE_MB`) without silent clamping.
 */
export function resolveProductionParserLimitsFromEnv(env: {
  readonly MAX_SUPPORTED_FILES: number;
  readonly MAX_REPO_SIZE_MB: number;
}): ResolvedProductionParserLimits {
  const repoSizeMb = validateSafeIntBound(
    env.MAX_REPO_SIZE_MB,
    MAX_REPO_SIZE_MB,
    1,
    MAX_REPO_SIZE_MB,
  );
  return validateProductionParserLimits({
    maxSupportedFiles: env.MAX_SUPPORTED_FILES,
    maxTotalBytes: repoSizeMb * BYTES_PER_MIB,
  });
}

/**
 * Reusable startup preflight reusing `parser-runner.ts`'s authoritative compiled-entrypoint
 * validator (`apps/worker/dist/parser-child.js`) before claiming production ingestion jobs.
 * Preserves per-run validation inside `ParserRunner.run()`.
 */
export async function preflightProductionParserEntrypoint(): Promise<string> {
  const { entrypointPath, trustedDistDir } = resolveCompiledParserChildPath();
  try {
    return await validateCompiledParserEntrypoint(entrypointPath, trustedDistDir);
  } catch (err: unknown) {
    if (err instanceof ParserRunnerError) {
      throw new ParserIntegrationError(classifyParserRunnerError(err));
    }
    throw new ParserIntegrationError(classifyUnexpectedParserException());
  }
}

export interface ProductionParserAdapterOptions {
  readonly limits?: ProductionParserLimits;
  readonly logger?: (event: ProductionParserLogEvent) => void;
  readonly onFatalState?: (event: SafeParserFatalNotification) => void;
  /** Optional runner factory for deterministic unit tests (defaults to production `createParserRunner`). */
  readonly runnerFactory?: (options: ParserRunnerOptions) => ParserRunner;
}

export interface ParseWorkspaceRunOptions {
  readonly signal?: AbortSignal;
}

export interface ProductionParserAdapter {
  readonly parseWorkspace: (
    workspace: ParserWorkspaceInput,
    options?: ParseWorkspaceRunOptions,
  ) => Promise<ValidatedAnalysisResult>;
  readonly getState: () => ParserRunnerState;
  readonly isFatal: () => boolean;
  readonly hasActiveChild: () => boolean;
  readonly getResolvedLimits: () => ResolvedProductionParserLimits;
}

function buildValidatedAnalysisSummary(
  requestId: string,
  output: AnalysisOutput,
  metrics: ParserRunMetrics,
): ValidatedAnalysisSummary {
  const { stats } = output;
  return {
    requestId,
    discoveredFilesCount: stats.discoveredFilesCount,
    parsedFilesCount: stats.parsedFilesCount,
    skippedSyntaxErrorFilesCount: stats.skippedSyntaxErrorFilesCount,
    skippedOversizedFilesCount: stats.skippedOversizedFilesCount,
    configFilesCount: stats.configFilesCount,
    folderNodeCount: stats.folderNodeCount,
    fileNodeCount: stats.fileNodeCount,
    functionNodeCount: stats.functionNodeCount,
    classNodeCount: stats.classNodeCount,
    symbolNodeCount: stats.symbolNodeCount,
    importsEdgeCount: stats.importsEdgeCount,
    callsEdgeCount: stats.callsEdgeCount,
    totalBytesRead: stats.totalBytesRead,
    warningsCount: output.warnings.length,
    truncatedWarningsCount: stats.truncatedWarningsCount,
    childAnalysisDurationMs: metrics.childAnalysisDurationMs,
    endToEndDurationMs: metrics.endToEndDurationMs,
    parentValidationDurationMs: metrics.parentValidationDurationMs,
    serializedResponseBytes: metrics.serializedResponseBytes,
    skipLoadingLibFiles: PRODUCTION_PARSER_CONFIG.skipLoadingLibFiles,
  };
}

function toSafeFatalNotification(event: ParserRunnerFatalEvent): SafeParserFatalNotification {
  const runnerCode =
    event.error.code === 'FATAL_CLEANUP_UNCONFIRMED'
      ? 'FATAL_CLEANUP_UNCONFIRMED'
      : 'FATAL_TERMINATION_UNCONFIRMED';
  const mapped = RUNNER_ERROR_CLASSIFICATION[runnerCode];
  return {
    persistedCode:
      runnerCode === 'FATAL_CLEANUP_UNCONFIRMED'
        ? 'PARSER_FATAL_CLEANUP'
        : 'PARSER_FATAL_TERMINATION',
    runnerCode,
    safeMessage: mapped.safeMessage,
    requestId: event.requestId,
    pid: event.pid ?? null,
    processExited: event.processExited,
  };
}

/**
 * Creates a production parser adapter owning one reusable `ParserRunner` configured with
 * the Batch 4.3C.5 benchmarked settings (`skipLoadingLibFiles: true`, 256 MiB old-space,
 * 60 s timeout, 32 MiB IPC cap, concurrency 1).
 *
 * - Returns the validated `AnalysisOutput` without performing DB writes or stage transitions.
 * - Retains zero in-memory graph cache across jobs.
 * - Logs safe scalar counts and timings only (never snippets, paths, or credentials).
 * - Never artificially settles a pending `runner.run()` promise when `onFatalState` fires.
 */
export function createProductionParserAdapter(
  options: ProductionParserAdapterOptions = {},
): ProductionParserAdapter {
  const resolvedLimits = validateProductionParserLimits(options.limits);
  const runnerFactory = options.runnerFactory ?? createParserRunner;

  const emitLog = (event: ProductionParserLogEvent): void => {
    try {
      options.logger?.(event);
    } catch {
      // Logging failures must not alter parser outcomes
      // or interfere with fatal supervision.
    }
  };

  const runnerOptions: ParserRunnerOptions = {
    parserTimeoutMs: PRODUCTION_PARSER_CONFIG.parserTimeoutMs,
    maxOldSpaceSizeMb: PRODUCTION_PARSER_CONFIG.maxOldSpaceSizeMb,
    maxResponseBytes: PRODUCTION_PARSER_CONFIG.maxResponseBytes,
    terminateGraceMs: PRODUCTION_PARSER_CONFIG.terminateGraceMs,
    killConfirmationMs: PRODUCTION_PARSER_CONFIG.killConfirmationMs,
    skipLoadingLibFiles: PRODUCTION_PARSER_CONFIG.skipLoadingLibFiles,
    onFatalState: (event: ParserRunnerFatalEvent) => {
      const safeFatal = toSafeFatalNotification(event);

      try {
        options.onFatalState?.(safeFatal);
      } finally {
        emitLog({ type: 'parser_fatal_state', fatal: safeFatal });
      }
    },
  };

  let runner: ParserRunner;
  try {
    runner = runnerFactory(runnerOptions);
  } catch (err: unknown) {
    if (err instanceof ParserRunnerError) {
      throw new ParserIntegrationError(classifyParserRunnerError(err));
    }
    throw new ParserIntegrationError(classifyUnexpectedParserException());
  }

  const parseWorkspace = async (
    workspace: ParserWorkspaceInput,
    runOptions: ParseWorkspaceRunOptions = {},
  ): Promise<ValidatedAnalysisResult> => {
    try {
      const runResult = await runner.run({
        rootDir: workspace.rootDir,
        supportedFiles: workspace.supportedFiles,
        configFiles: workspace.configFiles,
        maxSupportedFiles: resolvedLimits.maxSupportedFiles,
        maxConfigFiles: resolvedLimits.maxConfigFiles,
        maxFileBytes: resolvedLimits.maxFileBytes,
        maxTotalBytes: resolvedLimits.maxTotalBytes,
        maxFileSnippetChars: resolvedLimits.maxFileSnippetChars,
        maxSymbolSnippetChars: resolvedLimits.maxSymbolSnippetChars,
        maxCallSiteSnippetChars: resolvedLimits.maxCallSiteSnippetChars,
        maxWarnings: resolvedLimits.maxWarnings,
        maxExtendsDepth: resolvedLimits.maxExtendsDepth,
        skipLoadingLibFiles: PRODUCTION_PARSER_CONFIG.skipLoadingLibFiles,
        ...(runOptions.signal !== undefined ? { signal: runOptions.signal } : {}),
      });

      const summary = buildValidatedAnalysisSummary(
        runResult.requestId,
        runResult.output,
        runResult.metrics,
      );
      emitLog({ type: 'analysis_completed', summary });

      return {
        requestId: runResult.requestId,
        output: runResult.output,
        metrics: runResult.metrics,
        summary,
      };
    } catch (err: unknown) {
      const integrationErr =
        err instanceof ParserRunnerError
          ? new ParserIntegrationError(classifyParserRunnerError(err))
          : new ParserIntegrationError(classifyUnexpectedParserException());
      emitLog({
        type: 'analysis_failed',
        error: integrationErr.toSafeLogObject(),
      });
      throw integrationErr;
    }
  };

  return {
    parseWorkspace,
    getState: () => runner.getState(),
    isFatal: () => runner.isFatal(),
    hasActiveChild: () => runner.hasActiveChild(),
    getResolvedLimits: () => resolvedLimits,
  };
}
