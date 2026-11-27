import {
  DbError,
  GraphPersistenceValidationError,
  GraphPublicationAbortedError,
  classifyDbError,
  type IngestionAttemptOwnership,
  type IngestionRepository,
} from '@archon/db';
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
  readonly attemptsStarted: number;
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
   * True when a database error has uncertain commit resolution; callers must NOT
   * assume rollback and must reconcile before making terminal failure decisions.
   */
  readonly commitOutcomeUncertain: boolean;
  readonly isInfrastructureFailure: boolean;
  readonly fatal: boolean;
  readonly startupFailure: boolean;
}

export interface CreateIngestionProcessorDependencies {
  readonly repository: Pick<
    IngestionRepository,
    | 'claimIngestionAttempt'
    | 'transitionJobStage'
    | 'touchJobHeartbeat'
    | 'publishRepositoryGraph'
    | 'reconcilePublishedAttempt'
  >;
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
  /**
   * Optional pre-publication observation/test hook invoked AFTER `building_graph` and
   * strictly BEFORE mandatory atomic `repository.publishRepositoryGraph(...)`.
   * Cannot bypass atomic graph publication.
   */
  readonly beforeGraphPublish?: AnalysisResultHandoff;
  /** Lifecycle shutdown cancellation signal propagated to extraction, parsing, and pre-publish hook. */
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
      retryable: isInfrastructureFailure ? true : err.retryable,
      errorCode: err.persistedCode,
      errorMessage: err.message,
      errorDetail: err.errorDetail,
      isParserError: true,
      isCancellation: err.disposition === 'cancelled',
      commitOutcomeUncertain: false,
      isInfrastructureFailure,
      fatal: err.fatal,
      startupFailure: err.startupFailure,
    };
  }

  if (err instanceof IngestionCancelledError || err instanceof GraphPublicationAbortedError) {
    return {
      retryable: true,
      errorCode: 'INGESTION_CANCELLED',
      errorMessage: SAFE_INGESTION_CANCELLED_MESSAGE,
      errorDetail: 'INGESTION_CANCELLED',
      isParserError: false,
      isCancellation: true,
      commitOutcomeUncertain: false,
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
      commitOutcomeUncertain: false,
      isInfrastructureFailure: false,
      fatal: false,
      startupFailure: false,
    };
  }

  if (err instanceof GraphPersistenceValidationError) {
    return {
      retryable: false,
      errorCode: 'GRAPH_VALIDATION_ERROR',
      errorMessage: 'Static analysis produced an invalid repository graph.',
      errorDetail: err.reasonCode,
      isParserError: false,
      isCancellation: false,
      commitOutcomeUncertain: false,
      isInfrastructureFailure: false,
      fatal: false,
      startupFailure: false,
    };
  }

  const dbClass = classifyDbError(err);
  if (
    err instanceof DbError ||
    dbClass.category !== 'non_retryable' ||
    dbClass.pgCode !== undefined
  ) {
    return {
      retryable: dbClass.retryable,
      errorCode: 'DATABASE_ERROR',
      errorMessage: 'Database temporarily unavailable during repository ingestion.',
      errorDetail: dbClass.category,
      isParserError: false,
      isCancellation: false,
      commitOutcomeUncertain: dbClass.commitOutcomeUncertain,
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
    commitOutcomeUncertain: false,
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
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const explicitNow = (): Date | undefined => deps.now?.();

  return async function processIngestionJob(job: IngestionProcessorJob): Promise<void> {
    // Capture delivery generation and immutable job identity synchronously before any await
    const payload = job.data;
    const deliveryGeneration = job.attemptsStarted;
    const runtimeBullmqJobId = job.id;

    const jobAbortController = new AbortController();
    const ownershipState: {
      current: IngestionAttemptOwnership | null;
      lostReason: 'ownership_lost' | 'terminal' | 'missing' | 'identity_mismatch' | null;
      publicationDispatched: boolean;
    } = {
      current: null,
      lostReason: null,
      publicationDispatched: false,
    };

    const onShutdownAbort = (): void => {
      if (!jobAbortController.signal.aborted) {
        jobAbortController.abort();
      }
    };
    if (deps.shutdownSignal !== undefined) {
      if (isSignalAborted(deps.shutdownSignal)) {
        jobAbortController.abort();
      } else {
        deps.shutdownSignal.addEventListener('abort', onShutdownAbort, { once: true });
      }
    }

    const triggerPerJobOwnershipCancellation = (
      reason: 'ownership_lost' | 'terminal' | 'missing' | 'identity_mismatch',
    ): void => {
      ownershipState.lostReason ??= reason;
      if (!jobAbortController.signal.aborted) {
        jobAbortController.abort();
      }
    };

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

    const runHeartbeatTick = (ownership: IngestionAttemptOwnership): void => {
      if (!heartbeatState.active || heartbeatState.inFlightPromise !== null) {
        return;
      }
      const tickPromise = Promise.resolve().then(async (): Promise<void> => {
        try {
          const result = await deps.repository.touchJobHeartbeat(ownership, explicitNow());
          if (result.outcome === 'updated' || result.outcome === 'busy') {
            return;
          }
          stopHeartbeatScheduling();
          triggerPerJobOwnershipCancellation(result.outcome);
          safeLog(
            'info',
            {
              repoId: ownership.repoId,
              jobId: ownership.jobId,
              attemptGeneration: ownership.attemptGeneration,
              heartbeatOutcome: result.outcome,
            },
            'Heartbeat observed ownership loss or non-active repository; cancelling obsolete attempt',
          );
        } catch (err) {
          const dbClass = classifyDbError(err);
          safeLog(
            'warn',
            {
              repoId: ownership.repoId,
              jobId: ownership.jobId,
              attemptGeneration: ownership.attemptGeneration,
              dbCategory: dbClass.category,
            },
            'Failed to touch ingestion job heartbeat',
          );
        } finally {
          heartbeatState.inFlightPromise = null;
        }
      });
      heartbeatState.inFlightPromise = tickPromise;
    };

    const startHeartbeat = (ownership: IngestionAttemptOwnership): void => {
      if (heartbeatIntervalMs <= 0 || !heartbeatState.active) {
        return;
      }
      heartbeatState.timer = setInterval(() => {
        runHeartbeatTick(ownership);
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
      if (ownershipState.lostReason !== null) {
        throw new IngestionCancelledError();
      }
    };

    const onFatalSignal = (): void => {
      stopHeartbeatScheduling();
    };
    if (deps.fatalSignal !== undefined) {
      if (isSignalAborted(deps.fatalSignal)) {
        stopHeartbeatScheduling();
      } else {
        deps.fatalSignal.addEventListener('abort', onFatalSignal, { once: true });
      }
    }

    const markFailedSafe = async (
      ownership: IngestionAttemptOwnership,
      classified: ClassifiedIngestionError,
    ): Promise<void> => {
      try {
        const res = await deps.repository.transitionJobStage(ownership, {
          toStatus: 'failed',
          progressPct: progressState.currentPct,
          errorCode: classified.errorCode,
          errorMessage: classified.errorMessage,
          errorDetail: classified.errorDetail,
          ...(deps.now !== undefined ? { now: deps.now() } : {}),
        });
        if (!res.applied) {
          safeLog(
            'info',
            {
              repoId: ownership.repoId,
              jobId: ownership.jobId,
              attemptGeneration: ownership.attemptGeneration,
              transitionOutcome: res.outcome,
            },
            'Skipped persisting failed status because attempt no longer owns repository',
          );
        }
      } catch (dbErr) {
        const dbClass = classifyDbError(dbErr);
        safeLog(
          'error',
          {
            repoId: ownership.repoId,
            jobId: ownership.jobId,
            attemptGeneration: ownership.attemptGeneration,
            dbCategory: dbClass.category,
          },
          'Failed to persist failed ingestion status in PostgreSQL',
        );
      }
    };

    try {
      // 1. Check shutdown/fatal before claiming DB ownership
      assertNotCancelledOrFatal();

      const claimResult = await deps.repository.claimIngestionAttempt({
        repoId: payload.repoId,
        jobId: payload.jobId,
        bullmqJobId: runtimeBullmqJobId,
        commitSha: payload.commitSha,
        attemptGeneration: deliveryGeneration,
        progressPct: STAGE_PROGRESS.cloning,
        ...(deps.now !== undefined ? { now: deps.now() } : {}),
      });

      if (claimResult.outcome !== 'claimed') {
        if (
          claimResult.outcome === 'stale_generation' ||
          claimResult.outcome === 'already_terminal'
        ) {
          safeLog(
            'info',
            {
              repoId: payload.repoId,
              jobId: payload.jobId,
              attemptGeneration: deliveryGeneration,
              claimOutcome: claimResult.outcome,
            },
            'Skipping ingestion job because delivery claim was superseded or repository is terminal',
          );
          return;
        }

        safeLog(
          'warn',
          {
            repoId: payload.repoId,
            jobId: payload.jobId,
            attemptGeneration: deliveryGeneration,
            claimOutcome: claimResult.outcome,
          },
          'Rejecting ingestion job with invalid or missing ownership identity',
        );
        throw new NonRetryableIngestionError(
          'Ingestion job rejected due to invalid or missing ownership identity.',
        );
      }

      const ownership = claimResult.ownership;
      ownershipState.current = ownership;
      progressState.currentPct = STAGE_PROGRESS.cloning;

      // 2. Check cancellation before entering extraction
      assertNotCancelledOrFatal();

      startHeartbeat(ownership);

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
          signal: jobAbortController.signal,
        },
        async (workspace) => {
          // 3. Check cancellation before dispatching parsing transition
          assertNotCancelledOrFatal();

          const parsingTransition = await deps.repository.transitionJobStage(ownership, {
            toStatus: 'parsing',
            progressPct: STAGE_PROGRESS.parsing,
            fileCount: workspace.stats.supportedFilesCount,
            skippedFilesCount: workspace.stats.skippedFilesCount,
            ...(deps.now !== undefined ? { now: deps.now() } : {}),
          });

          if (!parsingTransition.applied) {
            ownershipState.lostReason ??= parsingTransition.outcome;
            safeLog(
              'info',
              {
                repoId: ownership.repoId,
                jobId: ownership.jobId,
                attemptGeneration: ownership.attemptGeneration,
                transitionOutcome: parsingTransition.outcome,
              },
              'Stopping ingestion before parsing because attempt no longer owns repository',
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
            { signal: jobAbortController.signal },
          );

          // 5. Check cancellation after parsing completes and before dispatching building_graph
          assertNotCancelledOrFatal();

          const graphTransition = await deps.repository.transitionJobStage(ownership, {
            toStatus: 'building_graph',
            progressPct: STAGE_PROGRESS.buildingGraph,
            ...(deps.now !== undefined ? { now: deps.now() } : {}),
          });

          if (!graphTransition.applied) {
            ownershipState.lostReason ??= graphTransition.outcome;
            safeLog(
              'info',
              {
                repoId: ownership.repoId,
                jobId: ownership.jobId,
                attemptGeneration: ownership.attemptGeneration,
                transitionOutcome: graphTransition.outcome,
              },
              'Stopping ingestion before graph publication because attempt no longer owns repository',
            );
            await stopAndDrainHeartbeat();
            return;
          }
          progressState.currentPct = STAGE_PROGRESS.buildingGraph;

          // 6. Optional pre-publish observation hook (cannot bypass atomic graph publication)
          assertNotCancelledOrFatal();
          if (deps.beforeGraphPublish !== undefined) {
            await deps.beforeGraphPublish({
              repositoryId: ownership.repoId,
              jobId: ownership.jobId,
              commitSha: ownership.commitSha,
              result: analysisResult,
              signal: jobAbortController.signal,
            });
          }

          // 7. Cancellation cutoff immediately before dispatching atomic graph publication
          assertNotCancelledOrFatal();

          ownershipState.publicationDispatched = true;
          const publishResult = await deps.repository.publishRepositoryGraph(ownership, {
            output: analysisResult.output,
            signal: jobAbortController.signal,
            ...(deps.now !== undefined ? { now: deps.now() } : {}),
          });

          if (publishResult.outcome === 'published') {
            progressState.currentPct = STAGE_PROGRESS.ready;
            safeLog(
              'info',
              {
                repoId: ownership.repoId,
                jobId: ownership.jobId,
                attemptGeneration: ownership.attemptGeneration,
                persistedNodeCount: publishResult.persistedNodeCount,
                persistedEdgeCount: publishResult.persistedEdgeCount,
                nodeBatches: publishResult.nodeBatches,
                edgeBatches: publishResult.edgeBatches,
              },
              'Published repository graph atomically',
            );
          } else {
            ownershipState.lostReason ??= publishResult.outcome;
            safeLog(
              'info',
              {
                repoId: ownership.repoId,
                jobId: ownership.jobId,
                attemptGeneration: ownership.attemptGeneration,
                publishOutcome: publishResult.outcome,
              },
              'Skipped atomic graph publication because attempt no longer owns repository',
            );
          }
          await stopAndDrainHeartbeat();
        },
      );
    } catch (err) {
      stopHeartbeatScheduling();

      // Already-classified non-retryable claim rejection (never mutates DB)
      if (err instanceof NonRetryableIngestionError) {
        await stopAndDrainHeartbeat();
        throw err;
      }

      const classified = classifyIngestionError(err);

      if (err instanceof ParserIntegrationError && classified.isInfrastructureFailure) {
        try {
          deps.onInfrastructureFailure?.(err);
        } catch {
          // Supervision callback errors must not skip heartbeat draining or failure handling
        }
      }

      await stopAndDrainHeartbeat();

      // Per-job ownership-loss cancellation (not worker shutdown): exit cleanly without failing
      // the repository or retrying the obsolete attempt.
      if (
        ownershipState.lostReason !== null &&
        classified.isCancellation &&
        !isSignalAborted(deps.shutdownSignal)
      ) {
        safeLog(
          'info',
          {
            repoId: payload.repoId,
            jobId: payload.jobId,
            attemptGeneration: deliveryGeneration,
            ownershipLossReason: ownershipState.lostReason,
          },
          'Obsolete ingestion attempt cancelled cleanly after losing ownership',
        );
        return;
      }

      const safeLogContext =
        err instanceof ParserIntegrationError
          ? {
              repoId: payload.repoId,
              jobId: payload.jobId,
              attemptGeneration: deliveryGeneration,
              errorCode: classified.errorCode,
              attemptsMade: job.attemptsMade,
              parserError: err.toSafeLogObject(),
            }
          : {
              repoId: payload.repoId,
              jobId: payload.jobId,
              attemptGeneration: deliveryGeneration,
              errorCode: classified.errorCode,
              errorDetail: classified.errorDetail,
              attemptsMade: job.attemptsMade,
              commitOutcomeUncertain: classified.commitOutcomeUncertain,
            };

      const activeOwnership = ownershipState.current;

      // Authoritative locked reconciliation when atomic graph publication failed with uncertain COMMIT
      if (
        ownershipState.publicationDispatched &&
        activeOwnership !== null &&
        classified.commitOutcomeUncertain
      ) {
        try {
          const reconciled = await deps.repository.reconcilePublishedAttempt(activeOwnership);
          if (reconciled.outcome === 'published_by_owner') {
            safeLog(
              'info',
              safeLogContext,
              'Reconciled uncertain graph publication as committed under current ownership',
            );
            return;
          }
          if (reconciled.outcome !== 'still_owned_unpublished') {
            safeLog(
              'info',
              { ...safeLogContext, reconcileOutcome: reconciled.outcome },
              'Reconciled uncertain graph publication as superseded or terminal; exiting cleanly',
            );
            return;
          }
          // Authoritatively confirmed rolled back while still owned by this attempt
          if (isFinalJobAttempt(job)) {
            safeLog(
              'error',
              safeLogContext,
              'Confirmed uncertain graph publication rolled back on final attempt; marking failed',
            );
            await markFailedSafe(activeOwnership, classified);
          } else {
            safeLog(
              'warn',
              safeLogContext,
              'Confirmed uncertain graph publication rolled back; leaving non-terminal for retry',
            );
          }
          // eslint-disable-next-line preserve-caught-error -- Deliberately discard untrusted raw cause at the BullMQ security boundary.
          throw new Error(classified.errorMessage);
        } catch (reconcileErr) {
          if (
            reconcileErr instanceof Error &&
            reconcileErr.message === classified.errorMessage &&
            !(reconcileErr instanceof DbError)
          ) {
            throw reconcileErr;
          }
          const reconcileClass = classifyDbError(reconcileErr);
          safeLog(
            'warn',
            { ...safeLogContext, reconcileDbCategory: reconcileClass.category },
            'Could not reconcile uncertain graph publication; preserving non-terminal state',
          );
          // eslint-disable-next-line preserve-caught-error -- Deliberately discard untrusted raw cause at the BullMQ security boundary.
          throw new Error(classified.errorMessage);
        }
      }

      if (!classified.retryable) {
        safeLog(
          'warn',
          safeLogContext,
          'Non-retryable ingestion failure; marking repository failed when ownership is held',
        );
        if (activeOwnership !== null && !classified.commitOutcomeUncertain) {
          await markFailedSafe(activeOwnership, classified);
        }
        if (err instanceof ParserIntegrationError) {
          throw new NonRetryableIngestionError(classified.errorMessage);
        }
        if (err instanceof TarballExtractionError) {
          throw new NonRetryableIngestionError(classified.errorMessage, { cause: err });
        }
        throw new NonRetryableIngestionError(classified.errorMessage);
      }

      if (classified.commitOutcomeUncertain) {
        safeLog(
          'warn',
          safeLogContext,
          'Uncertain database commit outcome; preserving non-terminal state without unfenced failure write',
        );
      } else if (isFinalJobAttempt(job)) {
        safeLog(
          'error',
          safeLogContext,
          'Retryable ingestion failure exhausted all attempts; marking repository failed when ownership is held',
        );
        if (activeOwnership !== null) {
          await markFailedSafe(activeOwnership, classified);
        }
      } else {
        safeLog(
          'warn',
          safeLogContext,
          classified.isCancellation
            ? 'Ingestion interrupted during shutdown; leaving repository non-terminal for BullMQ retry'
            : 'Retryable ingestion failure; leaving repository non-terminal for BullMQ retry',
        );
      }

      if (err instanceof GraphPublicationAbortedError) {
        throw new IngestionCancelledError();
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
      deps.shutdownSignal?.removeEventListener('abort', onShutdownAbort);
      deps.fatalSignal?.removeEventListener('abort', onFatalSignal);
      await stopAndDrainHeartbeat();
    }
  };
}
