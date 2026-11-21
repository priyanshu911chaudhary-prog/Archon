import {
  DEFAULT_STALE_JOB_THRESHOLD_MS,
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
  return status === 'ready' || status === 'failed';
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
  const nowFn = deps.now ?? (() => new Date());

  function triggerBestEffortExpiryCleanup(now: Date): void {
    void deps.repository.deleteExpiredRepositories(now).catch((err: unknown) => {
      deps.logger.warn({ err }, 'Best-effort cleanup of expired repositories failed');
    });
  }

  async function ingestRepository(input: IngestRepositoryInput): Promise<IngestRepositoryOutput> {
    const parsedUrl = parseGitHubRepoUrl(input.githubUrl);
    const now = nowFn();

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
        await deps.repository.bumpRepositoryExpiry(matched.repository.id, { now });
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
      now,
    });

    if (result.created && result.repository.status === 'queued') {
      try {
        const enqueued = await deps.enqueuer.enqueue({
          repoId: result.repository.id,
          jobId: result.job.id,
          owner: result.repository.owner,
          name: result.repository.name,
          commitSha: result.repository.commitSha,
        });

        if (enqueued.bullmqJobId !== null) {
          await deps.repository.attachBullMqJobId(result.job.id, enqueued.bullmqJobId);
        }
      } catch (err) {
        deps.logger.error(
          { err, repoId: result.repository.id, jobId: result.job.id },
          'Failed to enqueue ingestion job',
        );
        await deps.repository.transitionJobStage({
          repoId: result.repository.id,
          jobId: result.job.id,
          toStatus: 'failed',
          progressPct: 0,
          errorCode: 'QUEUE_ENQUEUE_FAILED',
          errorMessage: 'Failed to enqueue ingestion job. Please try again.',
          errorDetail: err instanceof Error ? err.message : 'Enqueue error',
          now: nowFn(),
        });
        throw new AppApiError({
          code: 'QUEUE_UNAVAILABLE',
          statusCode: 503,
          message: 'Failed to enqueue ingestion job. Please try again.',
          cause: err,
        });
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
      const now = nowFn();
      const swept = await deps.repository.sweepStaleJobs({
        repoId: record.repository.id,
        staleThresholdMs: staleJobThresholdMs,
        now,
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
