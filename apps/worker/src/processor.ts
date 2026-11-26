import type { IngestionRepository } from '@archon/db';
import type { Logger } from '@archon/shared';
import { UnrecoverableError } from 'bullmq';
import { TarballExtractionError } from './extractor/errors.js';
import {
  withExtractedRepo,
  type ExtractGitHubTarballOptions,
  type ExtractedRepoWorkspace,
} from './extractor/github-tarball.js';
import {
  ParserIntegrationError,
  classifyParserRunnerError,
  noopAnalysisResultHandoff,
  type AnalysisResultHandoff,
  type ProductionParserAdapter,
} from './parser-integration.js';
import { ParserRunnerError } from './parser-runner.js';
import type { IngestionQueueJobData } from './queue.js';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export const STAGE_PROGRESS = {
  cloning: 20,
  parsing: 60,
  buildingGraph: 85,
  ready: 100,
} as const;

export const SAFE_INGESTION_CANCELLED_MESSAGE =
  'Repository ingestion interrupted during worker shutdown.';

/**
 * Safe fixed-message cancellation error thrown at processor stage boundaries when
 * worker shutdown cancellation is observed before a stage transition is dispatched.
 */
export class IngestionCancelledError extends Error {
  readonly code = 'INGESTION_CANCELLED' as const;

  constructor() {
    super(SAFE_INGESTION_CANCELLED_MESSAGE);
    this.name = 'IngestionCancelledError';
  }
}

/**
 * Subclass of BullMQ's UnrecoverableError that preserves optional safe `cause`
 * while keeping `name === 'UnrecoverableError'` and `instanceof UnrecoverableError === true`.
 */
export class NonRetryableIngestionError extends UnrecoverableError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = 'UnrecoverableError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface IngestionProcessorJob {
  readonly id?: string;
  readonly data: IngestionQueueJobData;
  readonly attemptsMade: number;
  readonly opts: {
    readonly attempts?: number;
  };
}

export type ExtractRepoFn = <T>(
  options: ExtractGitHubTarballOptions,
  callback: (workspace: ExtractedRepoWorkspace) => Promise<T>,
) => Promise<T>;

export type IngestionParserAdapter = Pick<
  ProductionParserAdapter,
  'parseWorkspace' | 'isFatal' | 'getState'
>;

export interface ClassifiedIngestionError {
  readonly retryable: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly errorDetail: string;
  readonly isParserError: boolean;
  readonly isCancellation: boolean;
  /**
   * True for startup misconfiguration or fatal parser quarantine incidents.
   * Distinct from the lower-level runner's own `retryable: false` flag:
   * the affected worker shuts down and never reuses the runner, while a cleanly
   * settled active attempt may be retried by a healthy replacement worker within
   * BullMQ's existing bounded attempt limit.
   */
  readonly isInfrastructureFailure: boolean;
  readonly fatal: boolean;
  readonly startupFailure: boolean;
}

export interface CreateIngestionProcessorDependencies {
  readonly repository: Pick<IngestionRepository, 'transitionJobStage' | 'touchJobHeartbeat'>;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly githubToken?: string;
  readonly maxSupportedFiles: number;
  readonly maxRepoSizeMb: number;
  readonly heartbeatIntervalMs?: number;
  readonly tempBaseDir?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly extractRepo?: ExtractRepoFn;
  /** Explicitly required parser adapter (no silent no-op fallback in production). */
  readonly parserAdapter: IngestionParserAdapter;
  /** Phase 5 persistence seam invoked after `building_graph` succeeds and before `ready`. */
  readonly analysisResultHandoff?: AnalysisResultHandoff;
  /** Lifecycle shutdown cancellation signal propagated to extraction, parsing, and handoff. */
  readonly shutdownSignal?: AbortSignal;
  /** Synchronous fatal-quarantine signal used to stop DB heartbeat scheduling immediately. */
  readonly fatalSignal?: AbortSignal;
  /** Optional worker-level fatal check evaluated before starting work or transitions. */
  readonly isFatalState?: () => boolean;
  /** Synchronous supervision notification when a startup/fatal infrastructure error surfaces. */
  readonly onInfrastructureFailure?: (error: ParserIntegrationError) => void;
  readonly now?: () => Date;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * BullMQ exposes 0-indexed `job.attemptsMade` inside the processor function
 * (0 on attempt 1, 1 on attempt 2, etc.).
 */
export function isFinalJobAttempt(
  job: Pick<IngestionProcessorJob, 'attemptsMade' | 'opts'>,
): boolean {
  const maxAttempts = Math.max(1, job.opts.attempts ?? 1);
  return job.attemptsMade + 1 >= maxAttempts;
}

export function classifyIngestionError(err: unknown): ClassifiedIngestionError {
  if (err instanceof ParserIntegrationError) {
    const isInfrastructureFailure = err.fatal || err.startupFailure;
    return {
      // Lower-level runner marks fatal/startupFailure non-retryable on that runner instance.
      // At the worker integration layer, a cleanly settled attempt may be retried on a
      // healthy replacement worker (bounded by BullMQ attempts) while this worker shuts down.
      retryable: isInfrastructureFailure ? true : err.retryable,
      errorCode: err.persistedCode,
      errorMessage: err.message,
      errorDetail: err.errorDetail,
      isParserError: true,
      isCancellation: err.disposition === 'cancelled',
      isInfrastructureFailure,
      fatal: err.fatal,
      startupFailure: err.startupFailure,
    };
  }

  if (err instanceof IngestionCancelledError) {
    return {
      retryable: true,
      errorCode: err.code,
      errorMessage: err.message,
      errorDetail: err.code,
      isParserError: false,
      isCancellation: true,
      isInfrastructureFailure: false,
      fatal: false,
      startupFailure: false,
    };
  }

  if (err instanceof TarballExtractionError) {
    let retryable: boolean;
    switch (err.code) {
      case 'TARBALL_SECURITY_VIOLATION':
      case 'TARBALL_SIZE_LIMIT_EXCEEDED':
      case 'TARBALL_FILE_LIMIT_EXCEEDED':
      case 'TARBALL_REDIRECT_REJECTED':
        retryable = false;
        break;
      case 'TARBALL_PARSE_ERROR':
        retryable = err.retryable;
        break;
      case 'TARBALL_TIMEOUT':
      case 'TARBALL_CANCELLED':
      case 'TARBALL_RATE_LIMITED':
      case 'TARBALL_UPSTREAM_ERROR':
        retryable = true;
        break;
    }

    return {
      retryable,
      errorCode: err.code,
      errorMessage: err.message,
      errorDetail: err.code === 'TARBALL_CANCELLED' ? 'TARBALL_CANCELLED' : err.message,
      isParserError: false,
      isCancellation: err.code === 'TARBALL_CANCELLED',
      isInfrastructureFailure: false,
      fatal: false,
      startupFailure: false,
    };
  }

  return {
    retryable: true,
    errorCode: 'WORKER_ERROR',
    errorMessage: 'An unexpected error occurred during repository ingestion.',
    errorDetail: 'WORKER_ERROR',
    isParserError: false,
    isCancellation: false,
    isInfrastructureFailure: false,
    fatal: false,
    startupFailure: false,
  };
}

function buildLatchedFatalError(adapter: IngestionParserAdapter): ParserIntegrationError {
  const runnerCode =
    adapter.getState() === 'FATAL_CLEANUP_UNCONFIRMED'
      ? 'FATAL_CLEANUP_UNCONFIRMED'
      : 'FATAL_TERMINATION_UNCONFIRMED';
  const runnerErr = new ParserRunnerError({
    code: runnerCode,
    message: 'Parser lifecycle latched fatal.',
    retryable: false,
    fatal: true,
  });
  return new ParserIntegrationError(classifyParserRunnerError(runnerErr));
}

export function createIngestionJobProcessor(
  deps: CreateIngestionProcessorDependencies,
): (job: IngestionProcessorJob) => Promise<void> {
  const extractRepo = deps.extractRepo ?? withExtractedRepo;
  const analysisResultHandoff = deps.analysisResultHandoff ?? noopAnalysisResultHandoff;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const nowFn = deps.now ?? (() => new Date());

  return async function processIngestionJob(job: IngestionProcessorJob): Promise<void> {
    const payload = job.data;
    const progressState = { currentPct: 0 };
    const heartbeatState: {
      active: boolean;
      timer: ReturnType<typeof setInterval> | undefined;
      inFlightPromise: Promise<void> | null;
    } = {
      active: true,
      timer: undefined,
      inFlightPromise: null,
    };

    const stopHeartbeatScheduling = (): void => {
      heartbeatState.active = false;
      if (heartbeatState.timer !== undefined) {
        clearInterval(heartbeatState.timer);
        heartbeatState.timer = undefined;
      }
    };

    const stopAndDrainHeartbeat = async (): Promise<void> => {
      stopHeartbeatScheduling();
      const pending = heartbeatState.inFlightPromise;
      if (pending !== null) {
        await pending;
      }
    };

    const safeLog = (
      level: 'info' | 'warn' | 'error',
      obj: Record<string, unknown>,
      msg: string,
    ): void => {
      try {
        deps.logger[level](obj, msg);
      } catch {
        // Logger exceptions must never break heartbeat draining or error classification
      }
    };

    const runHeartbeatTick = (): void => {
      if (!heartbeatState.active || heartbeatState.inFlightPromise !== null) {
        return;
      }
      const tickPromise = Promise.resolve().then(async (): Promise<void> => {
        try {
          const result = await deps.repository.touchJobHeartbeat(payload.repoId, nowFn());
          if (!result.updated) {
            stopHeartbeatScheduling();
          }
        } catch (err) {
          safeLog(
            'warn',
            {
              repoId: payload.repoId,
              jobId: payload.jobId,
              errorMessage: err instanceof Error ? err.message : 'Heartbeat update failed',
            },
            'Failed to touch ingestion job heartbeat',
          );
        } finally {
          heartbeatState.inFlightPromise = null;
        }
      });
      heartbeatState.inFlightPromise = tickPromise;
    };

    const startHeartbeat = (): void => {
      if (heartbeatIntervalMs <= 0 || !heartbeatState.active) {
        return;
      }
      heartbeatState.timer = setInterval(() => {
        runHeartbeatTick();
      }, heartbeatIntervalMs);
      heartbeatState.timer.unref();
    };

    const assertNotCancelledOrFatal = (): void => {
      if (
        deps.isFatalState?.() === true ||
        deps.parserAdapter.isFatal() ||
        isSignalAborted(deps.fatalSignal)
      ) {
        throw buildLatchedFatalError(deps.parserAdapter);
      }
      if (isSignalAborted(deps.shutdownSignal)) {
        throw new IngestionCancelledError();
      }
    };

    const onFatalSignal = (): void => {
      // Stop scheduling additional DB heartbeats synchronously during fatal pending quarantine
      // without settling the pending parser promise or releasing workspace ownership.
      stopHeartbeatScheduling();
    };
    if (deps.fatalSignal !== undefined) {
      if (isSignalAborted(deps.fatalSignal)) {
        stopHeartbeatScheduling();
      } else {
        deps.fatalSignal.addEventListener('abort', onFatalSignal, { once: true });
      }
    }

    const markFailedSafe = async (classified: ClassifiedIngestionError): Promise<void> => {
      try {
        await deps.repository.transitionJobStage({
          repoId: payload.repoId,
          jobId: payload.jobId,
          toStatus: 'failed',
          progressPct: progressState.currentPct,
          errorCode: classified.errorCode,
          errorMessage: classified.errorMessage,
          errorDetail: classified.errorDetail,
          now: nowFn(),
        });
      } catch (dbErr) {
        deps.logger.error(
          {
            repoId: payload.repoId,
            jobId: payload.jobId,
            errorMessage: dbErr instanceof Error ? dbErr.message : 'Database update failed',
          },
          'Failed to persist failed ingestion status in PostgreSQL',
        );
      }
    };

    try {
      // 1. Check cancellation / fatal latch before starting new work
      assertNotCancelledOrFatal();

      const cloningTransition = await deps.repository.transitionJobStage({
        repoId: payload.repoId,
        jobId: payload.jobId,
        toStatus: 'cloning',
        progressPct: STAGE_PROGRESS.cloning,
        ...(job.id !== undefined ? { bullmqJobId: job.id } : {}),
        now: nowFn(),
      });

      if (!cloningTransition.applied) {
        deps.logger.info(
          { repoId: payload.repoId, jobId: payload.jobId },
          'Skipping ingestion job because repository is already in a terminal state',
        );
        return;
      }
      progressState.currentPct = STAGE_PROGRESS.cloning;

      // 2. Check cancellation before entering extraction
      assertNotCancelledOrFatal();

      startHeartbeat();

      await extractRepo(
        {
          owner: payload.owner,
          name: payload.name,
          commitSha: payload.commitSha,
          token: deps.githubToken,
          maxSupportedFiles: deps.maxSupportedFiles,
          maxRepoSizeMb: deps.maxRepoSizeMb,
          tempBaseDir: deps.tempBaseDir,
          fetchImpl: deps.fetchImpl,
          signal: deps.shutdownSignal,
        },
        async (workspace) => {
          // 3. Check cancellation before dispatching parsing transition
          assertNotCancelledOrFatal();

          const parsingTransition = await deps.repository.transitionJobStage({
            repoId: payload.repoId,
            jobId: payload.jobId,
            toStatus: 'parsing',
            progressPct: STAGE_PROGRESS.parsing,
            fileCount: workspace.stats.supportedFilesCount,
            skippedFilesCount: workspace.stats.skippedFilesCount,
            now: nowFn(),
          });

          if (!parsingTransition.applied) {
            deps.logger.info(
              { repoId: payload.repoId, jobId: payload.jobId },
              'Stopping ingestion before parsing because repository became terminal',
            );
            await stopAndDrainHeartbeat();
            return;
          }
          progressState.currentPct = STAGE_PROGRESS.parsing;

          // 4. Check cancellation right before invoking isolated parser
          assertNotCancelledOrFatal();

          const analysisResult = await deps.parserAdapter.parseWorkspace(
            {
              rootDir: workspace.rootDir,
              supportedFiles: workspace.supportedFiles,
              configFiles: workspace.configFiles,
            },
            deps.shutdownSignal !== undefined ? { signal: deps.shutdownSignal } : undefined,
          );

          // 5. Check cancellation after parsing completes and before dispatching building_graph
          assertNotCancelledOrFatal();

          const graphTransition = await deps.repository.transitionJobStage({
            repoId: payload.repoId,
            jobId: payload.jobId,
            toStatus: 'building_graph',
            progressPct: STAGE_PROGRESS.buildingGraph,
            now: nowFn(),
          });

          if (!graphTransition.applied) {
            deps.logger.info(
              { repoId: payload.repoId, jobId: payload.jobId },
              'Stopping ingestion before building_graph handoff because repository became terminal',
            );
            await stopAndDrainHeartbeat();
            return;
          }
          progressState.currentPct = STAGE_PROGRESS.buildingGraph;

          // 6. Check cancellation before invoking Phase 5 handoff seam
          assertNotCancelledOrFatal();

          await analysisResultHandoff({
            repositoryId: payload.repoId,
            jobId: payload.jobId,
            commitSha: payload.commitSha,
            result: analysisResult,
            ...(deps.shutdownSignal !== undefined ? { signal: deps.shutdownSignal } : {}),
          });

          // 7. Linearization point: check cancellation immediately before dispatching ready.
          // Once the ready transition is dispatched/committed, cancellation cannot roll it back.
          assertNotCancelledOrFatal();

          const readyTransition = await deps.repository.transitionJobStage({
            repoId: payload.repoId,
            jobId: payload.jobId,
            toStatus: 'ready',
            progressPct: STAGE_PROGRESS.ready,
            now: nowFn(),
          });

          if (readyTransition.applied) {
            progressState.currentPct = STAGE_PROGRESS.ready;
          }
          await stopAndDrainHeartbeat();
        },
      );
    } catch (err) {
      // Stop scheduling new heartbeats and notify infrastructure supervision SYNCHRONOUSLY
      // before awaiting potentially pending heartbeat I/O.
      stopHeartbeatScheduling();
      const classified = classifyIngestionError(err);

      if (err instanceof ParserIntegrationError && classified.isInfrastructureFailure) {
        try {
          deps.onInfrastructureFailure?.(err);
        } catch {
          // Supervision callback errors must not skip heartbeat draining or failure handling
        }
      }

      await stopAndDrainHeartbeat();

      const safeLogContext =
        err instanceof ParserIntegrationError
          ? {
              repoId: payload.repoId,
              jobId: payload.jobId,
              errorCode: classified.errorCode,
              attemptsMade: job.attemptsMade,
              parserError: err.toSafeLogObject(),
            }
          : {
              repoId: payload.repoId,
              jobId: payload.jobId,
              errorCode: classified.errorCode,
              attemptsMade: job.attemptsMade,
            };

      if (!classified.retryable) {
        safeLog(
          'warn',
          safeLogContext,
          'Non-retryable ingestion failure; marking repository failed immediately',
        );
        await markFailedSafe(classified);
        if (err instanceof ParserIntegrationError) {
          throw new NonRetryableIngestionError(classified.errorMessage);
        }
        throw new NonRetryableIngestionError(classified.errorMessage, { cause: err });
      }

      if (isFinalJobAttempt(job)) {
        safeLog(
          'error',
          safeLogContext,
          'Retryable ingestion failure exhausted all attempts; marking repository failed',
        );
        await markFailedSafe(classified);
      } else {
        safeLog(
          'warn',
          safeLogContext,
          classified.isCancellation
            ? 'Ingestion interrupted during shutdown; leaving repository non-terminal for BullMQ retry'
            : 'Retryable ingestion failure; leaving repository non-terminal for BullMQ retry',
        );
      }

      if (
        err instanceof TarballExtractionError ||
        err instanceof ParserIntegrationError ||
        err instanceof IngestionCancelledError
      ) {
        throw err;
      }
      // eslint-disable-next-line preserve-caught-error -- Deliberately discard untrusted raw cause at the BullMQ security boundary.
      throw new Error(classified.errorMessage);
    } finally {
      deps.fatalSignal?.removeEventListener('abort', onFatalSignal);
      await stopAndDrainHeartbeat();
    }
  };
}
