import type { IngestionRepository } from '@archon/db';
import type { Logger } from '@archon/shared';
import { UnrecoverableError } from 'bullmq';
import { TarballExtractionError } from './extractor/errors.js';
import {
  withExtractedRepo,
  type ExtractGitHubTarballOptions,
  type ExtractedRepoWorkspace,
} from './extractor/github-tarball.js';
import type { IngestionQueueJobData } from './queue.js';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export const STAGE_PROGRESS = {
  cloning: 20,
  parsing: 60,
  buildingGraph: 85,
  ready: 100,
} as const;

/**
 * Subclass of BullMQ's UnrecoverableError that preserves the underlying `cause`
 * while keeping `name === 'UnrecoverableError'` and `instanceof UnrecoverableError === true`.
 */
export class NonRetryableIngestionError extends UnrecoverableError {
  constructor(message: string, options: { readonly cause: unknown }) {
    super(message);
    this.name = 'UnrecoverableError';
    this.cause = options.cause;
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

export type ParseWorkspaceFn = (
  workspace: ExtractedRepoWorkspace,
  payload: IngestionQueueJobData,
) => Promise<void>;

export interface ClassifiedIngestionError {
  readonly retryable: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly errorDetail: string;
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
  /** Placeholder hook until Phase 4 plugs in the forked heap-capped ts-morph parser. */
  readonly parseWorkspace?: ParseWorkspaceFn;
  readonly now?: () => Date;
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
      case 'TARBALL_RATE_LIMITED':
      case 'TARBALL_UPSTREAM_ERROR':
        retryable = true;
        break;
    }

    return {
      retryable,
      errorCode: err.code,
      errorMessage: err.message,
      errorDetail: err.message,
    };
  }

  return {
    retryable: true,
    errorCode: 'WORKER_ERROR',
    errorMessage: 'An unexpected error occurred during repository ingestion.',
    errorDetail: err instanceof Error ? err.message : String(err),
  };
}

export function createIngestionJobProcessor(
  deps: CreateIngestionProcessorDependencies,
): (job: IngestionProcessorJob) => Promise<void> {
  const extractRepo = deps.extractRepo ?? withExtractedRepo;
  const parseWorkspace: ParseWorkspaceFn = deps.parseWorkspace ?? (() => Promise.resolve());
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const nowFn = deps.now ?? (() => new Date());

  return async function processIngestionJob(job: IngestionProcessorJob): Promise<void> {
    const payload = job.data;
    const progressState = { currentPct: 0 };
    const heartbeatState = {
      active: true,
      inFlight: false,
      timer: undefined as ReturnType<typeof setInterval> | undefined,
    };

    const stopHeartbeat = (): void => {
      heartbeatState.active = false;
      if (heartbeatState.timer !== undefined) {
        clearInterval(heartbeatState.timer);
        heartbeatState.timer = undefined;
      }
    };

    const runHeartbeatTick = async (): Promise<void> => {
      if (!heartbeatState.active || heartbeatState.inFlight) {
        return;
      }
      heartbeatState.inFlight = true;
      try {
        const result = await deps.repository.touchJobHeartbeat(payload.repoId, nowFn());
        if (!result.updated) {
          stopHeartbeat();
        }
      } catch (err) {
        deps.logger.warn(
          { err, repoId: payload.repoId, jobId: payload.jobId },
          'Failed to touch ingestion job heartbeat',
        );
      } finally {
        heartbeatState.inFlight = false;
      }
    };

    const startHeartbeat = (): void => {
      if (heartbeatIntervalMs <= 0) {
        return;
      }
      heartbeatState.timer = setInterval(() => {
        void runHeartbeatTick();
      }, heartbeatIntervalMs);
      heartbeatState.timer.unref();
    };

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
          { err: dbErr, repoId: payload.repoId, jobId: payload.jobId },
          'Failed to persist failed ingestion status in PostgreSQL',
        );
      }
    };

    try {
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
        },
        async (workspace) => {
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
            stopHeartbeat();
            return;
          }
          progressState.currentPct = STAGE_PROGRESS.parsing;

          // Phase 3 placeholder hook; Phase 4 plugs in the forked heap-capped ts-morph parser
          await parseWorkspace(workspace, payload);

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
              'Stopping ingestion before building_graph because repository became terminal',
            );
            stopHeartbeat();
            return;
          }
          progressState.currentPct = STAGE_PROGRESS.buildingGraph;

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
          stopHeartbeat();
        },
      );
    } catch (err) {
      stopHeartbeat();
      const classified = classifyIngestionError(err);

      if (!classified.retryable) {
        deps.logger.warn(
          {
            repoId: payload.repoId,
            jobId: payload.jobId,
            errorCode: classified.errorCode,
            attemptsMade: job.attemptsMade,
          },
          'Non-retryable ingestion failure; marking repository failed immediately',
        );
        await markFailedSafe(classified);
        throw new NonRetryableIngestionError(classified.errorMessage, { cause: err });
      }

      if (isFinalJobAttempt(job)) {
        deps.logger.error(
          {
            err,
            repoId: payload.repoId,
            jobId: payload.jobId,
            errorCode: classified.errorCode,
            attemptsMade: job.attemptsMade,
          },
          'Retryable ingestion failure exhausted all attempts; marking repository failed',
        );
        await markFailedSafe(classified);
      } else {
        deps.logger.warn(
          {
            repoId: payload.repoId,
            jobId: payload.jobId,
            errorCode: classified.errorCode,
            attemptsMade: job.attemptsMade,
          },
          'Retryable ingestion failure; leaving repository non-terminal for BullMQ retry',
        );
      }

      throw err;
    } finally {
      stopHeartbeat();
    }
  };
}
