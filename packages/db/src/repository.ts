import { and, desc, eq, inArray, lt, notInArray } from 'drizzle-orm';
import type { ArchonDatabase } from './client.js';
import { DbError, extractPgErrorInfo, isPgUniqueViolation } from './errors.js';
import {
  ACTIVE_REPOSITORY_STATUSES,
  TERMINAL_REPOSITORY_STATUSES,
  ingestionJobs,
  repositories,
  type IngestionJobRecord,
  type RepositoryRecord,
  type RepositoryStatus,
} from './schema.js';

export const DEFAULT_REPO_TTL_DAYS = 7;
export const DEFAULT_STALE_JOB_THRESHOLD_MS = 10 * 60 * 1000;
export const ACTIVE_REPO_UNIQUE_INDEX = 'idx_repos_active_owner_name_sha' as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RepositoryWithJob {
  readonly repository: RepositoryRecord;
  readonly job: IngestionJobRecord;
}

export interface CreateOrGetActiveRepoInput {
  readonly githubUrl: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly commitSha: string;
  readonly sizeKb: number;
  readonly fileCount?: number;
  readonly isSample?: boolean;
  /**
   * Use `'ready'` only for immediate-completion cases such as `emptyJsTs` (0 TS/JS files).
   * Defaults to `'queued'`.
   */
  readonly initialStatus?: 'queued' | 'ready';
  readonly ttlDays?: number;
  readonly now?: Date;
}

export interface CreateOrGetActiveRepoResult extends RepositoryWithJob {
  readonly created: boolean;
}

export interface TransitionJobStageInput {
  readonly repoId: string;
  readonly jobId: string;
  readonly toStatus: RepositoryStatus;
  readonly progressPct: number;
  readonly bullmqJobId?: string;
  readonly fileCount?: number;
  readonly skippedFilesCount?: number;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly errorDetail?: string | null;
  readonly now?: Date;
}

export type TransitionJobStageResult =
  | { readonly applied: false }
  | {
      readonly applied: true;
      readonly repository: RepositoryRecord;
      readonly job: IngestionJobRecord;
    };

export interface TouchHeartbeatResult {
  readonly updated: boolean;
  readonly updatedAt?: Date;
}

export interface SweepStaleJobsInput {
  readonly staleThresholdMs?: number;
  readonly repoId?: string;
  readonly now?: Date;
}

export interface SweepStaleJobsResult {
  readonly sweptRepoIds: readonly string[];
  readonly count: number;
}

export interface IngestionRepository {
  findActiveByOwnerNameSha(
    owner: string,
    name: string,
    commitSha: string,
  ): Promise<RepositoryWithJob | null>;
  findJobWithRepository(jobId: string): Promise<RepositoryWithJob | null>;
  createOrGetActive(input: CreateOrGetActiveRepoInput): Promise<CreateOrGetActiveRepoResult>;
  transitionJobStage(input: TransitionJobStageInput): Promise<TransitionJobStageResult>;
  attachBullMqJobId(jobId: string, bullmqJobId: string): Promise<boolean>;
  touchJobHeartbeat(repoId: string, now?: Date): Promise<TouchHeartbeatResult>;
  bumpRepositoryExpiry(
    repoId: string,
    options?: { readonly ttlDays?: number; readonly now?: Date },
  ): Promise<RepositoryRecord | null>;
  sweepStaleJobs(input?: SweepStaleJobsInput): Promise<SweepStaleJobsResult>;
  deleteExpiredRepositories(now?: Date): Promise<readonly string[]>;
}

export function computeExpiresAt(now: Date, ttlDays: number, isSample: boolean): Date | null {
  if (isSample) {
    return null;
  }
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new DbError('DB_VALIDATION_ERROR', `ttlDays must be positive (received ${ttlDays}).`);
  }
  return new Date(now.getTime() + ttlDays * MS_PER_DAY);
}

function isTerminalStatus(status: RepositoryStatus): boolean {
  return status === 'ready' || status === 'failed';
}

export function createIngestionRepository(db: ArchonDatabase): IngestionRepository {
  async function findLatestJobForRepo(
    executor: Pick<ArchonDatabase, 'select'>,
    repoId: string,
  ): Promise<IngestionJobRecord | null> {
    const rows = await executor
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.repoId, repoId))
      .orderBy(desc(ingestionJobs.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async function findActiveByOwnerNameSha(
    owner: string,
    name: string,
    commitSha: string,
  ): Promise<RepositoryWithJob | null> {
    const normalizedOwner = owner.toLowerCase();
    const normalizedName = name.toLowerCase();

    const repoRows = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.owner, normalizedOwner),
          eq(repositories.name, normalizedName),
          eq(repositories.commitSha, commitSha),
          inArray(repositories.status, [...ACTIVE_REPOSITORY_STATUSES]),
        ),
      )
      .limit(1);

    const repository = repoRows[0];
    if (!repository) {
      return null;
    }

    const job = await findLatestJobForRepo(db, repository.id);
    if (!job) {
      return null;
    }

    return { repository, job };
  }

  async function bumpRepositoryExpiry(
    repoId: string,
    options: { readonly ttlDays?: number; readonly now?: Date } = {},
  ): Promise<RepositoryRecord | null> {
    const now = options.now ?? new Date();
    const ttlDays = options.ttlDays ?? DEFAULT_REPO_TTL_DAYS;
    const nextExpiresAt = computeExpiresAt(now, ttlDays, false);

    const updated = await db
      .update(repositories)
      .set({
        expiresAt: nextExpiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(repositories.id, repoId),
          eq(repositories.status, 'ready'),
          eq(repositories.isSample, false),
        ),
      )
      .returning();

    return updated[0] ?? null;
  }

  async function reuseExistingIfReady(
    existing: RepositoryWithJob,
    ttlDays: number,
    now: Date,
  ): Promise<CreateOrGetActiveRepoResult> {
    if (existing.repository.status === 'ready' && !existing.repository.isSample) {
      const bumped = await bumpRepositoryExpiry(existing.repository.id, { ttlDays, now });
      if (bumped) {
        return {
          created: false,
          repository: bumped,
          job: existing.job,
        };
      }
    }

    return {
      created: false,
      repository: existing.repository,
      job: existing.job,
    };
  }

  async function createOrGetActive(
    input: CreateOrGetActiveRepoInput,
  ): Promise<CreateOrGetActiveRepoResult> {
    const now = input.now ?? new Date();
    const ttlDays = input.ttlDays ?? DEFAULT_REPO_TTL_DAYS;
    const isSample = input.isSample ?? false;
    const initialStatus = input.initialStatus ?? 'queued';
    const normalizedOwner = input.owner.toLowerCase();
    const normalizedName = input.name.toLowerCase();
    const expiresAt = computeExpiresAt(now, ttlDays, isSample);

    // Fast path: reuse an already active or ready snapshot
    const existing = await findActiveByOwnerNameSha(
      normalizedOwner,
      normalizedName,
      input.commitSha,
    );
    if (existing) {
      return reuseExistingIfReady(existing, ttlDays, now);
    }

    try {
      const createdPair = await db.transaction(async (tx) => {
        const insertedRepos = await tx
          .insert(repositories)
          .values({
            githubUrl: input.githubUrl,
            owner: normalizedOwner,
            name: normalizedName,
            defaultBranch: input.defaultBranch,
            commitSha: input.commitSha,
            status: initialStatus,
            isSample,
            fileCount: input.fileCount ?? 0,
            skippedFilesCount: 0,
            sizeKb: input.sizeKb,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const repository = insertedRepos[0];
        if (!repository) {
          throw new DbError('DB_QUERY_ERROR', 'Insert into repositories returned no row.');
        }

        const isImmediateReady = initialStatus === 'ready';
        const insertedJobs = await tx
          .insert(ingestionJobs)
          .values({
            repoId: repository.id,
            stage: initialStatus,
            progressPct: isImmediateReady ? 100 : 0,
            startedAt: isImmediateReady ? now : null,
            finishedAt: isImmediateReady ? now : null,
            durationMs: isImmediateReady ? 0 : null,
            createdAt: now,
          })
          .returning();

        const job = insertedJobs[0];
        if (!job) {
          throw new DbError('DB_QUERY_ERROR', 'Insert into ingestion_jobs returned no row.');
        }

        return { repository, job };
      });

      return {
        created: true,
        repository: createdPair.repository,
        job: createdPair.job,
      };
    } catch (err) {
      if (isPgUniqueViolation(err, ACTIVE_REPO_UNIQUE_INDEX)) {
        const winner = await findActiveByOwnerNameSha(
          normalizedOwner,
          normalizedName,
          input.commitSha,
        );
        if (winner) {
          return reuseExistingIfReady(winner, ttlDays, now);
        }
        throw new DbError(
          'DB_CONFLICT_UNRESOLVED',
          'Active repository conflict occurred, but no active row could be loaded.',
          { cause: err, pgCode: '23505' },
        );
      }

      const pgInfo = extractPgErrorInfo(err);
      throw new DbError('DB_QUERY_ERROR', 'Failed to create repository ingestion record.', {
        cause: err,
        pgCode: pgInfo.code,
      });
    }
  }

  async function findJobWithRepository(jobId: string): Promise<RepositoryWithJob | null> {
    const rows = await db
      .select({
        job: ingestionJobs,
        repository: repositories,
      })
      .from(ingestionJobs)
      .innerJoin(repositories, eq(ingestionJobs.repoId, repositories.id))
      .where(eq(ingestionJobs.id, jobId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      job: row.job,
      repository: row.repository,
    };
  }

  async function transitionJobStage(
    input: TransitionJobStageInput,
  ): Promise<TransitionJobStageResult> {
    if (!Number.isInteger(input.progressPct) || input.progressPct < 0 || input.progressPct > 100) {
      throw new DbError(
        'DB_VALIDATION_ERROR',
        `progressPct must be an integer between 0 and 100 (received ${input.progressPct}).`,
      );
    }

    const now = input.now ?? new Date();

    return db.transaction(async (tx) => {
      const repoUpdate: {
        status: RepositoryStatus;
        updatedAt: Date;
        fileCount?: number;
        skippedFilesCount?: number;
        errorCode?: string | null;
        errorMessage?: string | null;
      } = {
        status: input.toStatus,
        updatedAt: now,
      };

      if (input.fileCount !== undefined) {
        repoUpdate.fileCount = input.fileCount;
      }
      if (input.skippedFilesCount !== undefined) {
        repoUpdate.skippedFilesCount = input.skippedFilesCount;
      }
      if (input.errorCode !== undefined) {
        repoUpdate.errorCode = input.errorCode;
      }
      if (input.errorMessage !== undefined) {
        repoUpdate.errorMessage = input.errorMessage;
      }

      // Conditional update: never overwrite a terminal ('ready' or 'failed') repository
      const updatedRepos = await tx
        .update(repositories)
        .set(repoUpdate)
        .where(
          and(
            eq(repositories.id, input.repoId),
            notInArray(repositories.status, [...TERMINAL_REPOSITORY_STATUSES]),
          ),
        )
        .returning();

      const repository = updatedRepos[0];
      if (!repository) {
        return { applied: false };
      }

      const existingJobs = await tx
        .select()
        .from(ingestionJobs)
        .where(and(eq(ingestionJobs.id, input.jobId), eq(ingestionJobs.repoId, input.repoId)))
        .limit(1);

      const currentJob = existingJobs[0];
      if (!currentJob) {
        throw new DbError(
          'DB_QUERY_ERROR',
          `Ingestion job ${input.jobId} not found for repository ${input.repoId}.`,
        );
      }

      const startedAt = currentJob.startedAt ?? (input.toStatus !== 'queued' ? now : null);
      const terminal = isTerminalStatus(input.toStatus);
      const finishedAt = terminal ? now : currentJob.finishedAt;
      const durationMs = terminal
        ? Math.max(0, now.getTime() - (startedAt ?? currentJob.createdAt).getTime())
        : currentJob.durationMs;

      const jobUpdate: {
        stage: RepositoryStatus;
        progressPct: number;
        startedAt: Date | null;
        finishedAt: Date | null;
        durationMs: number | null;
        bullmqJobId?: string;
        errorDetail?: string | null;
      } = {
        stage: input.toStatus,
        progressPct: input.progressPct,
        startedAt,
        finishedAt,
        durationMs,
      };

      if (input.bullmqJobId !== undefined) {
        jobUpdate.bullmqJobId = input.bullmqJobId;
      }
      if (input.errorDetail !== undefined) {
        jobUpdate.errorDetail = input.errorDetail;
      }

      const updatedJobs = await tx
        .update(ingestionJobs)
        .set(jobUpdate)
        .where(eq(ingestionJobs.id, input.jobId))
        .returning();

      const job = updatedJobs[0];
      if (!job) {
        throw new DbError('DB_QUERY_ERROR', `Failed to update ingestion job ${input.jobId}.`);
      }

      return {
        applied: true,
        repository,
        job,
      };
    });
  }

  async function attachBullMqJobId(jobId: string, bullmqJobId: string): Promise<boolean> {
    const updated = await db
      .update(ingestionJobs)
      .set({ bullmqJobId })
      .where(
        and(
          eq(ingestionJobs.id, jobId),
          notInArray(ingestionJobs.stage, [...TERMINAL_REPOSITORY_STATUSES]),
        ),
      )
      .returning({ id: ingestionJobs.id });

    return updated.length > 0;
  }

  async function touchJobHeartbeat(
    repoId: string,
    now: Date = new Date(),
  ): Promise<TouchHeartbeatResult> {
    const updated = await db
      .update(repositories)
      .set({ updatedAt: now })
      .where(
        and(
          eq(repositories.id, repoId),
          notInArray(repositories.status, [...TERMINAL_REPOSITORY_STATUSES]),
        ),
      )
      .returning({ updatedAt: repositories.updatedAt });

    const row = updated[0];
    if (!row) {
      return { updated: false };
    }

    return { updated: true, updatedAt: row.updatedAt };
  }

  async function sweepStaleJobs(input: SweepStaleJobsInput = {}): Promise<SweepStaleJobsResult> {
    const thresholdMs = input.staleThresholdMs ?? DEFAULT_STALE_JOB_THRESHOLD_MS;
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
      throw new DbError(
        'DB_VALIDATION_ERROR',
        `staleThresholdMs must be positive (received ${thresholdMs}).`,
      );
    }

    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - thresholdMs);

    return db.transaction(async (tx) => {
      const conditions = [
        notInArray(repositories.status, [...TERMINAL_REPOSITORY_STATUSES]),
        lt(repositories.updatedAt, cutoff),
      ];

      if (input.repoId !== undefined) {
        conditions.push(eq(repositories.id, input.repoId));
      }

      const sweptRepos = await tx
        .update(repositories)
        .set({
          status: 'failed',
          errorCode: 'JOB_TIMEOUT',
          errorMessage: 'Ingestion timed out before completion. Please try again.',
          updatedAt: now,
        })
        .where(and(...conditions))
        .returning({ id: repositories.id });

      const sweptRepoIds = sweptRepos.map((row) => row.id);

      if (sweptRepoIds.length > 0) {
        await tx
          .update(ingestionJobs)
          .set({
            stage: 'failed',
            finishedAt: now,
            errorDetail: 'JOB_TIMEOUT',
          })
          .where(
            and(
              inArray(ingestionJobs.repoId, sweptRepoIds),
              notInArray(ingestionJobs.stage, [...TERMINAL_REPOSITORY_STATUSES]),
            ),
          );
      }

      return {
        sweptRepoIds,
        count: sweptRepoIds.length,
      };
    });
  }

  async function deleteExpiredRepositories(now: Date = new Date()): Promise<readonly string[]> {
    const deleted = await db
      .delete(repositories)
      .where(and(eq(repositories.isSample, false), lt(repositories.expiresAt, now)))
      .returning({ id: repositories.id });

    return deleted.map((row) => row.id);
  }

  return {
    findActiveByOwnerNameSha,
    findJobWithRepository,
    createOrGetActive,
    transitionJobStage,
    attachBullMqJobId,
    touchJobHeartbeat,
    bumpRepositoryExpiry,
    sweepStaleJobs,
    deleteExpiredRepositories,
  };
}
