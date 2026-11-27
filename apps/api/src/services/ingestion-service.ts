import {
  DEFAULT_STALE_JOB_THRESHOLD_MS,
  classifyDbError,
  isEmptyJsTsRepository,
  type IngestionRepository,
  type RepositoryStatus,
  type RepositoryWithJob,
} from '@archon/db';
import { parseGitHubRepoUrl, type Logger } from '@archon/shared';
import { AppApiError } from '../errors.js';
import type { GitHubPrecheckClient } from '../github/precheck.js';
import type { IngestionJobEnqueuer } from '../queue/enqueuer.js';

export interface IngestRepositoryInput {
  readonly githubUrl: string;
  /** Internal-only option for Phase 11 sample seeding (never exposed on public POST /repos). */
  readonly pinnedSha?: string;
  /** Internal-only option for Phase 11 sample seeding. */
  readonly isSample?: boolean;
}

export interface IngestRepositoryOutput {
  readonly httpStatus: 200 | 202;
  readonly body: {
    readonly repoId: string;
    readonly jobId: string;
    readonly status: RepositoryStatus;
    readonly reused: boolean;
  };
}

export interface JobStatusOutput {
  readonly jobId: string;
  readonly repoId: string;
  readonly status: RepositoryStatus;
  readonly progressPct: number;
  readonly stats: {
    readonly fileCount: number;
    readonly skippedFilesCount: number;
    readonly emptyJsTs: boolean;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface IngestionServiceDependencies {
  readonly repository: IngestionRepository;
  readonly githubPrecheck: Pick<GitHubPrecheckClient, 'precheckRepository'>;
  readonly enqueuer: IngestionJobEnqueuer;
  readonly logger: Pick<Logger, 'warn' | 'error'>;
  readonly staleJobThresholdMs?: number;
  readonly now?: () => Date;
}

export interface IngestionService {
  ingestRepository(input: IngestRepositoryInput): Promise<IngestRepositoryOutput>;
  getJobStatus(jobId: string): Promise<JobStatusOutput>;
}

function isTerminalStatus(status: RepositoryStatus): boolean {
  return status === 'ready' || status === 'failed' || status === 'superseded';
}

function formatJobStatus(record: RepositoryWithJob): JobStatusOutput {
  const base: JobStatusOutput = {
    jobId: record.job.id,
    repoId: record.repository.id,
    status: record.repository.status,
    progressPct: record.job.progressPct,
    stats: {
      fileCount: record.repository.fileCount,
      skippedFilesCount: record.repository.skippedFilesCount,
      emptyJsTs: isEmptyJsTsRepository(record.repository),
    },
  };

  if (record.repository.status === 'failed') {
    return {
      ...base,
      error: {
        code: record.repository.errorCode ?? 'INGESTION_FAILED',
        message: record.repository.errorMessage ?? 'Repository ingestion failed.',
      },
    };
  }

  return base;
}

export function createIngestionService(deps: IngestionServiceDependencies): IngestionService {
  const staleJobThresholdMs = deps.staleJobThresholdMs ?? DEFAULT_STALE_JOB_THRESHOLD_MS;
  const explicitNow = (): Date | undefined => deps.now?.();

  function triggerBestEffortExpiryCleanup(now: Date): void {
    void deps.repository.deleteExpiredRepositories(now).catch((err: unknown) => {
      const dbClass = classifyDbError(err);
      deps.logger.warn(
        {
          dbCategory: dbClass.category,
          commitOutcomeUncertain: dbClass.commitOutcomeUncertain,
        },
        'Best-effort cleanup of expired repositories failed',
      );
    });
  }

  async function ingestRepository(input: IngestRepositoryInput): Promise<IngestRepositoryOutput> {
    const parsedUrl = parseGitHubRepoUrl(input.githubUrl);
    const now = explicitNow() ?? new Date();

    const early: { match: RepositoryWithJob | null } = { match: null };
    const precheck = await deps.githubPrecheck.precheckRepository(parsedUrl, {
      pinnedSha: input.pinnedSha,
      shouldSkipTreeCheck: async (head) => {
        const existing = await deps.repository.findActiveByOwnerNameSha(
          head.owner,
          head.name,
          head.commitSha,
        );
        if (existing) {
          early.match = existing;
          return true;
        }
        return false;
      },
    });

    triggerBestEffortExpiryCleanup(now);

    const matched = early.match;
    if (!precheck.treeChecked && matched !== null) {
      if (matched.repository.status === 'ready' && !matched.repository.isSample) {
        await deps.repository.bumpRepositoryExpiry(
          matched.repository.id,
          deps.now !== undefined ? { now } : {},
        );
      }

      return {
        httpStatus: matched.repository.status === 'ready' ? 200 : 202,
        body: {
          repoId: matched.repository.id,
          jobId: matched.job.id,
          status: matched.repository.status,
          reused: true,
        },
      };
    }

    const supportedFileCount = precheck.treeChecked ? precheck.supportedFileCount : 0;
    const isEmptyJsTs = precheck.treeChecked ? precheck.emptyJsTs : false;

    const result = await deps.repository.createOrGetActive({
      githubUrl: precheck.head.canonicalUrl,
      owner: precheck.head.owner,
      name: precheck.head.name,
      defaultBranch: precheck.head.defaultBranch,
      commitSha: precheck.head.commitSha,
      sizeKb: precheck.head.sizeKb,
      fileCount: supportedFileCount,
      isSample: input.isSample ?? false,
      initialStatus: isEmptyJsTs ? 'ready' : 'queued',
      ...(deps.now !== undefined ? { now } : {}),
    });

    if (result.created && result.repository.status === 'queued') {
      let enqueued: { readonly bullmqJobId: string | null };
      try {
        enqueued = await deps.enqueuer.enqueue({
          repoId: result.repository.id,
          jobId: result.job.id,
          owner: result.repository.owner,
          name: result.repository.name,
          commitSha: result.repository.commitSha,
        });
      } catch {
        deps.logger.error(
          {
            repoId: result.repository.id,
            jobId: result.job.id,
            errorCode: 'QUEUE_ENQUEUE_FAILED',
          },
          'Failed to enqueue ingestion job',
        );
        try {
          const enqueueFailureOutcome = await deps.repository.failQueuedJobOnEnqueueError({
            repoId: result.repository.id,
            jobId: result.job.id,
            errorCode: 'QUEUE_ENQUEUE_FAILED',
            errorMessage: 'Failed to enqueue ingestion job. Please try again.',
            errorDetail: 'QUEUE_ENQUEUE_FAILED',
            ...(deps.now !== undefined ? { now: deps.now() } : {}),
          });
          if (!enqueueFailureOutcome.applied) {
            deps.logger.warn(
              {
                repoId: result.repository.id,
                jobId: result.job.id,
                enqueueFailureOutcome: enqueueFailureOutcome.outcome,
              },
              'Skipped marking queued job failed after enqueue error',
            );
          }
        } catch (dbErr) {
          const dbClass = classifyDbError(dbErr);
          deps.logger.error(
            {
              repoId: result.repository.id,
              jobId: result.job.id,
              dbCategory: dbClass.category,
              commitOutcomeUncertain: dbClass.commitOutcomeUncertain,
            },
            'Failed to record enqueue failure in PostgreSQL',
          );
        }
        throw new AppApiError({
          code: 'QUEUE_UNAVAILABLE',
          statusCode: 503,
          message: 'Failed to enqueue ingestion job. Please try again.',
        });
      }

      if (enqueued.bullmqJobId !== null) {
        try {
          const attached = await deps.repository.attachBullMqJobId(
            result.job.id,
            enqueued.bullmqJobId,
          );
          switch (attached.outcome) {
            case 'attached':
            case 'already_attached':
              break;
            case 'identity_mismatch':
              deps.logger.error(
                {
                  repoId: result.repository.id,
                  jobId: result.job.id,
                  attachOutcome: attached.outcome,
                  reason: attached.reason,
                },
                'BullMQ job ID attachment rejected due to identity mismatch',
              );
              break;
            case 'terminal':
              deps.logger.warn(
                {
                  repoId: result.repository.id,
                  jobId: result.job.id,
                  attachOutcome: attached.outcome,
                  status: attached.status,
                },
                'Skipped BullMQ job ID attachment because repository is already terminal',
              );
              break;
            case 'missing':
              deps.logger.warn(
                {
                  repoId: result.repository.id,
                  jobId: result.job.id,
                  attachOutcome: attached.outcome,
                },
                'Skipped BullMQ job ID attachment because ingestion job row was missing',
              );
              break;
          }
        } catch (dbErr) {
          const dbClass = classifyDbError(dbErr);
          deps.logger.warn(
            {
              repoId: result.repository.id,
              jobId: result.job.id,
              dbCategory: dbClass.category,
              commitOutcomeUncertain: dbClass.commitOutcomeUncertain,
            },
            'Failed to persist BullMQ job ID after successful enqueue; worker will backfill on claim',
          );
        }
      }
    }
    const reused = !result.created;
    const httpStatus: 200 | 202 = reused && result.repository.status === 'ready' ? 200 : 202;

    return {
      httpStatus,
      body: {
        repoId: result.repository.id,
        jobId: result.job.id,
        status: result.repository.status,
        reused,
      },
    };
  }

  async function getJobStatus(jobId: string): Promise<JobStatusOutput> {
    let record = await deps.repository.findJobWithRepository(jobId);
    if (!record) {
      throw new AppApiError({
        code: 'JOB_NOT_FOUND',
        statusCode: 404,
        message: 'Ingestion job not found.',
      });
    }

    if (!isTerminalStatus(record.repository.status)) {
      const swept = await deps.repository.sweepStaleJobs({
        repoId: record.repository.id,
        staleThresholdMs: staleJobThresholdMs,
        ...(deps.now !== undefined ? { now: deps.now() } : {}),
      });
      if (swept.count > 0) {
        const refreshed = await deps.repository.findJobWithRepository(jobId);
        if (refreshed) {
          record = refreshed;
        }
      }
    }

    return formatJobStatus(record);
  }

  return {
    ingestRepository,
    getJobStatus,
  };
}
