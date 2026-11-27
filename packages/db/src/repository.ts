import { and, asc, desc, eq, gt, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { ArchonDatabase } from './client.js';
import { DbError, classifyDbError, extractPgErrorInfo, isPgUniqueViolation } from './errors.js';
import {
  ACTIVE_REPOSITORY_STATUSES,
  TERMINAL_INGESTION_JOB_STAGES,
  TERMINAL_REPOSITORY_STATUSES,
  ingestionJobs,
  repositories,
  type IngestionJobRecord,
  type IngestionJobStage,
  type RepositoryRecord,
  type RepositoryStatus,
} from './schema.js';

export const DEFAULT_REPO_TTL_DAYS = 7;
export const DEFAULT_STALE_JOB_THRESHOLD_MS = 10 * 60 * 1000;
export const ACTIVE_REPO_UNIQUE_INDEX = 'idx_repos_active_owner_name_sha' as const;

export const MAX_PG_INT32 = 2_147_483_647 as const;
export const MIN_ATTEMPT_GENERATION = 1 as const;
export const MAX_ATTEMPT_GENERATION = MAX_PG_INT32;
export const DEFAULT_CLAIM_PROGRESS_PCT = 20 as const;

export const DEFAULT_ENQUEUE_ERROR_CODE = 'QUEUE_ENQUEUE_FAILED' as const;
export const DEFAULT_ENQUEUE_ERROR_MESSAGE =
  'Failed to enqueue ingestion job. Please try again.' as const;

export const DEFAULT_SWEEP_BATCH_SIZE = 50 as const;
export const MAX_SWEEP_BATCH_SIZE = 200 as const;
export const DEFAULT_SWEEP_MAX_BATCHES = 10 as const;
export const MAX_SWEEP_MAX_BATCHES = 50 as const;
export const DEFAULT_SWEEP_MAX_DURATION_MS = 10_000 as const;
export const MAX_SWEEP_MAX_DURATION_MS = 30_000 as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

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

export interface IngestionAttemptOwnership {
  readonly repoId: string;
  readonly jobId: string;
  readonly bullmqJobId: string;
  readonly commitSha: string;
  readonly attemptGeneration: number;
}

export interface ClaimIngestionAttemptInput {
  readonly repoId: string;
  readonly jobId: string;
  /** Runtime BullMQ job ID; must equal `jobId` (nullable DB `bullmq_job_id` is backfilled on claim). */
  readonly bullmqJobId: string | undefined;
  readonly commitSha: string;
  readonly attemptGeneration: number;
  readonly progressPct?: number;
  readonly now?: Date;
}

export type ClaimIdentityMismatchReason =
  | 'invalid_repo_id'
  | 'invalid_job_id'
  | 'invalid_commit_sha'
  | 'bullmq_job_id_mismatch'
  | 'job_repo_mismatch'
  | 'commit_sha_mismatch'
  | 'stored_bullmq_job_id_mismatch';

export type ClaimIngestionAttemptOutcome =
  | 'claimed'
  | 'stale_generation'
  | 'already_terminal'
  | 'missing'
  | 'identity_mismatch'
  | 'invalid_generation';

/**
 * Discriminated outcomes for an ingestion attempt claim.
 * Database infrastructure failures propagate as rejected promises (`DbError` / PG errors)
 * rather than being collapsed into a rejected claim outcome.
 */
export type ClaimIngestionAttemptResult =
  | {
      readonly outcome: 'claimed';
      readonly ownership: IngestionAttemptOwnership;
      readonly repository: RepositoryRecord;
      readonly job: IngestionJobRecord;
    }
  | {
      readonly outcome: 'stale_generation';
      readonly storedGeneration: number;
      readonly incomingGeneration: number;
    }
  | {
      readonly outcome: 'already_terminal';
      readonly status: RepositoryStatus;
    }
  | {
      readonly outcome: 'missing';
    }
  | {
      readonly outcome: 'identity_mismatch';
      readonly reason: ClaimIdentityMismatchReason;
    }
  | {
      readonly outcome: 'invalid_generation';
      readonly incomingGeneration: number;
    };

export type ValidatedClaimIngestionAttemptInput =
  | {
      readonly ok: true;
      readonly ownership: IngestionAttemptOwnership;
    }
  | {
      readonly ok: false;
      readonly rejection: Extract<
        ClaimIngestionAttemptResult,
        { readonly outcome: 'invalid_generation' | 'identity_mismatch' }
      >;
    };

export type FencedTransitionStage = Exclude<IngestionJobStage, 'queued'>;

const FENCED_TRANSITION_STAGES = new Set<string>([
  'cloning',
  'parsing',
  'building_graph',
  'ready',
  'failed',
]);

/**
 * Identity fields (`repoId`, `jobId`, `bullmqJobId`, `commitSha`, `attemptGeneration`)
 * are sourced exclusively from `IngestionAttemptOwnership` to prevent conflicting inputs.
 */
export interface TransitionJobStageInput {
  readonly toStatus: FencedTransitionStage;
  readonly progressPct: number;
  readonly fileCount?: number;
  readonly skippedFilesCount?: number;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly errorDetail?: string | null;
  readonly now?: Date;
}

export type OwnershipIdentityMismatchReason =
  'commit_sha_mismatch' | 'stored_bullmq_job_id_mismatch' | 'missing_stored_bullmq_job_id';

export type VerifiedAttemptOwnershipResult =
  | {
      readonly outcome: 'verified';
      readonly repository: RepositoryRecord;
      readonly job: IngestionJobRecord;
    }
  | {
      readonly outcome: 'ownership_lost';
      readonly storedGeneration: number;
      readonly expectedGeneration: number;
    }
  | {
      readonly outcome: 'terminal';
      readonly status: RepositoryStatus;
    }
  | { readonly outcome: 'missing' }
  | {
      readonly outcome: 'identity_mismatch';
      readonly reason: OwnershipIdentityMismatchReason;
    };

export type TransitionJobStageOutcome =
  'applied' | 'ownership_lost' | 'terminal' | 'missing' | 'identity_mismatch';

export type TransitionJobStageResult =
  | {
      readonly outcome: 'applied';
      readonly applied: true;
      readonly repository: RepositoryRecord;
      readonly job: IngestionJobRecord;
    }
  | {
      readonly outcome: 'ownership_lost';
      readonly applied: false;
      readonly storedGeneration: number;
      readonly expectedGeneration: number;
    }
  | {
      readonly outcome: 'terminal';
      readonly applied: false;
      readonly status: RepositoryStatus;
    }
  | {
      readonly outcome: 'missing';
      readonly applied: false;
    }
  | {
      readonly outcome: 'identity_mismatch';
      readonly applied: false;
      readonly reason: OwnershipIdentityMismatchReason;
    };

export type TouchHeartbeatOutcome = 'updated' | 'busy' | 'ownership_lost' | 'terminal' | 'missing';

export type TouchHeartbeatResult =
  | {
      readonly outcome: 'updated';
      readonly updated: true;
      readonly updatedAt: Date;
    }
  | {
      readonly outcome: 'busy';
      readonly updated: false;
    }
  | {
      readonly outcome: 'ownership_lost';
      readonly updated: false;
      readonly reason: 'stale_generation';
      readonly storedGeneration: number;
      readonly expectedGeneration: number;
    }
  | {
      readonly outcome: 'ownership_lost';
      readonly updated: false;
      readonly reason: OwnershipIdentityMismatchReason;
    }
  | {
      readonly outcome: 'terminal';
      readonly updated: false;
      readonly status: RepositoryStatus;
    }
  | {
      readonly outcome: 'missing';
      readonly updated: false;
    };

export interface FailQueuedJobOnEnqueueErrorInput {
  readonly repoId: string;
  readonly jobId: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly errorDetail?: string | null;
  readonly now?: Date;
}

export type FailQueuedJobOnEnqueueErrorResult =
  | {
      readonly outcome: 'failed';
      readonly applied: true;
      readonly repository: RepositoryRecord;
      readonly job: IngestionJobRecord;
    }
  | {
      readonly outcome: 'already_claimed';
      readonly applied: false;
      readonly status: RepositoryStatus;
      readonly stage: IngestionJobStage;
      readonly attemptGeneration: number;
    }
  | {
      readonly outcome: 'already_terminal';
      readonly applied: false;
      readonly status: RepositoryStatus;
    }
  | { readonly outcome: 'missing'; readonly applied: false }
  | {
      readonly outcome: 'identity_mismatch';
      readonly applied: false;
      readonly reason: 'invalid_repo_id' | 'invalid_job_id';
    };

export type AttachBullMqJobIdResult =
  | { readonly outcome: 'attached'; readonly attached: true }
  | { readonly outcome: 'already_attached'; readonly attached: true }
  | { readonly outcome: 'terminal'; readonly attached: false; readonly status: RepositoryStatus }
  | { readonly outcome: 'missing'; readonly attached: false }
  | {
      readonly outcome: 'identity_mismatch';
      readonly attached: false;
      readonly reason:
        'invalid_job_id' | 'bullmq_job_id_mismatch' | 'stored_bullmq_job_id_mismatch';
    };

export interface SweepStaleJobsInput {
  readonly staleThresholdMs?: number;
  readonly repoId?: string;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly maxDurationMs?: number;
  readonly now?: Date;
}

export interface SweepStaleJobsResult {
  readonly sweptRepoIds: readonly string[];
  readonly count: number;
  readonly batchesProcessed: number;
  readonly reachedLimit: boolean;
}

export interface IngestionRepository {
  findActiveByOwnerNameSha(
    owner: string,
    name: string,
    commitSha: string,
  ): Promise<RepositoryWithJob | null>;
  findJobWithRepository(jobId: string): Promise<RepositoryWithJob | null>;
  createOrGetActive(input: CreateOrGetActiveRepoInput): Promise<CreateOrGetActiveRepoResult>;
  claimIngestionAttempt(input: ClaimIngestionAttemptInput): Promise<ClaimIngestionAttemptResult>;
  transitionJobStage(
    ownership: IngestionAttemptOwnership,
    input: TransitionJobStageInput,
  ): Promise<TransitionJobStageResult>;
  failQueuedJobOnEnqueueError(
    input: FailQueuedJobOnEnqueueErrorInput,
  ): Promise<FailQueuedJobOnEnqueueErrorResult>;
  attachBullMqJobId(jobId: string, bullmqJobId: string): Promise<AttachBullMqJobIdResult>;
  touchJobHeartbeat(
    ownership: IngestionAttemptOwnership,
    now?: Date,
  ): Promise<TouchHeartbeatResult>;
  bumpRepositoryExpiry(
    repoId: string,
    options?: { readonly ttlDays?: number; readonly now?: Date },
  ): Promise<RepositoryRecord | null>;
  sweepStaleJobs(input?: SweepStaleJobsInput): Promise<SweepStaleJobsResult>;
  deleteExpiredRepositories(now?: Date): Promise<readonly string[]>;
}

export function isValidAttemptGeneration(generation: number): boolean {
  return (
    Number.isSafeInteger(generation) &&
    generation >= MIN_ATTEMPT_GENERATION &&
    generation <= MAX_ATTEMPT_GENERATION
  );
}

export function validateClaimIngestionAttemptInput(
  input: ClaimIngestionAttemptInput,
): ValidatedClaimIngestionAttemptInput {
  if (!isValidAttemptGeneration(input.attemptGeneration)) {
    return {
      ok: false,
      rejection: { outcome: 'invalid_generation', incomingGeneration: input.attemptGeneration },
    };
  }
  if (!UUID_RE.test(input.repoId)) {
    return { ok: false, rejection: { outcome: 'identity_mismatch', reason: 'invalid_repo_id' } };
  }
  if (!UUID_RE.test(input.jobId)) {
    return { ok: false, rejection: { outcome: 'identity_mismatch', reason: 'invalid_job_id' } };
  }
  if (!COMMIT_SHA_RE.test(input.commitSha)) {
    return {
      ok: false,
      rejection: { outcome: 'identity_mismatch', reason: 'invalid_commit_sha' },
    };
  }
  if (input.bullmqJobId !== input.jobId) {
    return {
      ok: false,
      rejection: { outcome: 'identity_mismatch', reason: 'bullmq_job_id_mismatch' },
    };
  }
  if (
    input.progressPct !== undefined &&
    (!Number.isInteger(input.progressPct) || input.progressPct < 0 || input.progressPct > 100)
  ) {
    throw new DbError(
      'DB_VALIDATION_ERROR',
      `progressPct must be an integer between 0 and 100 (received ${String(input.progressPct)}).`,
    );
  }

  return {
    ok: true,
    ownership: Object.freeze({
      repoId: input.repoId,
      jobId: input.jobId,
      bullmqJobId: input.bullmqJobId,
      commitSha: input.commitSha,
      attemptGeneration: input.attemptGeneration,
    }),
  };
}

export function assertValidAttemptOwnership(ownership: IngestionAttemptOwnership): void {
  const checked = validateClaimIngestionAttemptInput(ownership);
  if (!checked.ok) {
    throw new DbError(
      'DB_VALIDATION_ERROR',
      `Invalid ingestion attempt ownership (${checked.rejection.outcome}).`,
    );
  }
}

export type ArchonTransaction = Parameters<Parameters<ArchonDatabase['transaction']>[0]>[0];

export interface TransactionTimeoutConfig {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly transactionTimeoutMs: number;
}

export const MAX_TX_TIMEOUT_MS = 60_000 as const;

export const DEFAULT_TX_TIMEOUT_CONFIG: TransactionTimeoutConfig = Object.freeze({
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 5_000,
  transactionTimeoutMs: 10_000,
});

export type RowLockMode = 'wait' | 'nowait';

export type LockedRepositoryAndJobResult =
  | { readonly status: 'missing_repository' }
  | { readonly status: 'missing_job'; readonly repository: RepositoryRecord }
  | {
      readonly status: 'locked';
      readonly repository: RepositoryRecord;
      readonly job: IngestionJobRecord;
    };

function assertBoundedInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DbError(
      'DB_VALIDATION_ERROR',
      `${name} must be an integer between ${String(min)} and ${String(max)} (received ${String(value)}).`,
    );
  }
}

function assertNonNegativePgInt32(name: string, value: number | undefined): void {
  if (value !== undefined) {
    assertBoundedInt(name, value, 0, MAX_PG_INT32);
  }
}

export function validateTransactionTimeouts(timeouts: TransactionTimeoutConfig): void {
  assertBoundedInt('lockTimeoutMs', timeouts.lockTimeoutMs, 1, MAX_TX_TIMEOUT_MS);
  assertBoundedInt('statementTimeoutMs', timeouts.statementTimeoutMs, 1, MAX_TX_TIMEOUT_MS);
  assertBoundedInt('transactionTimeoutMs', timeouts.transactionTimeoutMs, 1, MAX_TX_TIMEOUT_MS);
  if (timeouts.lockTimeoutMs > timeouts.statementTimeoutMs) {
    throw new DbError('DB_VALIDATION_ERROR', 'lockTimeoutMs must not exceed statementTimeoutMs.');
  }
  if (timeouts.statementTimeoutMs > timeouts.transactionTimeoutMs) {
    throw new DbError(
      'DB_VALIDATION_ERROR',
      'statementTimeoutMs must not exceed transactionTimeoutMs.',
    );
  }
}

/**
 * Applies PostgreSQL 17 transaction-local `lock_timeout`, `statement_timeout`, and
 * `transaction_timeout` via parameterized `set_config(..., true)` in a single round trip.
 */
export async function applyTransactionTimeouts(
  tx: ArchonTransaction,
  timeouts: TransactionTimeoutConfig = DEFAULT_TX_TIMEOUT_CONFIG,
): Promise<void> {
  validateTransactionTimeouts(timeouts);
  const lockParam = `${String(timeouts.lockTimeoutMs)}ms`;
  const stmtParam = `${String(timeouts.statementTimeoutMs)}ms`;
  const txParam = `${String(timeouts.transactionTimeoutMs)}ms`;
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${lockParam}, true), set_config('statement_timeout', ${stmtParam}, true), set_config('transaction_timeout', ${txParam}, true)`,
  );
}

/**
 * Executes a Drizzle transaction with validated PG 17 local timeouts.
 * Propagates all errors untouched (no `Promise.race` abandonment; caller must never treat
 * a failed COMMIT acknowledgement as proof of rollback).
 */
export async function runBoundedTransaction<T>(
  db: ArchonDatabase,
  callback: (tx: ArchonTransaction) => Promise<T>,
  timeouts: TransactionTimeoutConfig = DEFAULT_TX_TIMEOUT_CONFIG,
): Promise<T> {
  validateTransactionTimeouts(timeouts);
  return db.transaction(async (tx) => {
    await applyTransactionTimeouts(tx, timeouts);
    return callback(tx);
  });
}

/**
 * Acquires row locks strictly in `repositories -> ingestion_jobs` order for the same `repoId`
 * (preventing cross-repository lock-order inversions). Supports bounded blocking `'wait'` and
 * heartbeat `'nowait'` modes. Locking alone does not establish ownership; only a committed
 * claim transaction establishes ownership.
 */
export async function lockRepositoryAndJobForUpdate(
  tx: ArchonTransaction,
  repoId: string,
  jobId: string,
  lockMode: RowLockMode = 'wait',
): Promise<LockedRepositoryAndJobResult> {
  const repoQuery = tx.select().from(repositories).where(eq(repositories.id, repoId)).limit(1);
  const repoRows = await (lockMode === 'nowait'
    ? repoQuery.for('update', { noWait: true })
    : repoQuery.for('update'));

  const repository = repoRows[0];
  if (repository === undefined) {
    return { status: 'missing_repository' };
  }

  const jobQuery = tx
    .select()
    .from(ingestionJobs)
    .where(and(eq(ingestionJobs.id, jobId), eq(ingestionJobs.repoId, repoId)))
    .limit(1);
  const jobRows = await (lockMode === 'nowait'
    ? jobQuery.for('update', { noWait: true })
    : jobQuery.for('update'));

  const job = jobRows[0];
  if (job === undefined) {
    return { status: 'missing_job', repository };
  }

  return { status: 'locked', repository, job };
}

/**
 * True only for clean lock contention (`55P03`) without any concurrent connection or
 * transaction-outcome uncertainty, so mixed errors are never downgraded to a busy heartbeat.
 */
export function isBusyLockContentionError(err: unknown): boolean {
  const classified = classifyDbError(err);
  return (
    classified.category === 'lock_not_available' &&
    classified.retryable &&
    !classified.commitOutcomeUncertain
  );
}

function validateExplicitDate(value: Date | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Object.prototype.toString.call(value) !== '[object Date]' || Number.isNaN(value.getTime())) {
    throw new DbError('DB_VALIDATION_ERROR', 'Explicit timestamp must be a valid Date.');
  }
  return value;
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

function isTerminalJobStage(status: IngestionJobStage): boolean {
  return status === 'ready' || status === 'failed';
}

function isTerminalRepositoryStatus(status: RepositoryStatus): boolean {
  return status === 'ready' || status === 'failed' || status === 'superseded';
}

/**
 * Acquires repository-first row locks (`repositories -> ingestion_jobs`) and verifies
 * existence, commit SHA, BullMQ job binding, non-terminal status on both rows, and exact
 * `attempt_generation` equality. Reusable by fenced transitions, heartbeats, and publication.
 */
export async function verifyLockedAttemptOwnership(
  tx: ArchonTransaction,
  ownership: IngestionAttemptOwnership,
  lockMode: RowLockMode = 'wait',
): Promise<VerifiedAttemptOwnershipResult> {
  assertValidAttemptOwnership(ownership);
  const locked = await lockRepositoryAndJobForUpdate(
    tx,
    ownership.repoId,
    ownership.jobId,
    lockMode,
  );
  if (locked.status !== 'locked') {
    return { outcome: 'missing' };
  }

  const { repository, job } = locked;
  if (repository.commitSha !== ownership.commitSha) {
    return { outcome: 'identity_mismatch', reason: 'commit_sha_mismatch' };
  }
  if (job.bullmqJobId !== null && job.bullmqJobId !== ownership.bullmqJobId) {
    return { outcome: 'identity_mismatch', reason: 'stored_bullmq_job_id_mismatch' };
  }
  if (isTerminalRepositoryStatus(repository.status)) {
    return { outcome: 'terminal', status: repository.status };
  }
  if (isTerminalJobStage(job.stage)) {
    return { outcome: 'terminal', status: job.stage };
  }
  if (job.attemptGeneration !== ownership.attemptGeneration) {
    return {
      outcome: 'ownership_lost',
      storedGeneration: job.attemptGeneration,
      expectedGeneration: ownership.attemptGeneration,
    };
  }
  if (job.bullmqJobId !== ownership.bullmqJobId) {
    return { outcome: 'identity_mismatch', reason: 'missing_stored_bullmq_job_id' };
  }

  return { outcome: 'verified', repository, job };
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
    const now = validateExplicitDate(options.now) ?? new Date();
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
    assertNonNegativePgInt32('sizeKb', input.sizeKb);
    assertNonNegativePgInt32('fileCount', input.fileCount);
    const now = validateExplicitDate(input.now) ?? new Date();
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

  async function claimIngestionAttempt(
    input: ClaimIngestionAttemptInput,
  ): Promise<ClaimIngestionAttemptResult> {
    const validated = validateClaimIngestionAttemptInput(input);
    if (!validated.ok) {
      return validated.rejection;
    }
    const explicitNow = validateExplicitDate(input.now);
    const progressPct = input.progressPct ?? DEFAULT_CLAIM_PROGRESS_PCT;
    const { ownership } = validated;

    return runBoundedTransaction(db, async (tx): Promise<ClaimIngestionAttemptResult> => {
      const locked = await lockRepositoryAndJobForUpdate(
        tx,
        ownership.repoId,
        ownership.jobId,
        'wait',
      );
      // Scoped missing semantics: never query or lock jobs belonging to unrelated repositories.
      if (locked.status !== 'locked') {
        return { outcome: 'missing' };
      }

      const { repository, job } = locked;
      if (repository.commitSha !== ownership.commitSha) {
        return { outcome: 'identity_mismatch', reason: 'commit_sha_mismatch' };
      }
      if (job.bullmqJobId !== null && job.bullmqJobId !== ownership.bullmqJobId) {
        return { outcome: 'identity_mismatch', reason: 'stored_bullmq_job_id_mismatch' };
      }
      if (isTerminalRepositoryStatus(repository.status)) {
        return { outcome: 'already_terminal', status: repository.status };
      }
      if (isTerminalJobStage(job.stage)) {
        return { outcome: 'already_terminal', status: job.stage };
      }
      if (ownership.attemptGeneration <= job.attemptGeneration) {
        return {
          outcome: 'stale_generation',
          storedGeneration: job.attemptGeneration,
          incomingGeneration: ownership.attemptGeneration,
        };
      }

      const claimTime = explicitNow ?? new Date();
      const updatedRepos = await tx
        .update(repositories)
        .set({ status: 'cloning', updatedAt: claimTime })
        .where(
          and(
            eq(repositories.id, ownership.repoId),
            notInArray(repositories.status, [...TERMINAL_REPOSITORY_STATUSES]),
          ),
        )
        .returning();
      const updatedRepo = updatedRepos[0];
      if (updatedRepo === undefined) {
        throw new DbError('DB_QUERY_ERROR', 'Failed to update repository during attempt claim.');
      }

      const updatedJobs = await tx
        .update(ingestionJobs)
        .set({
          stage: 'cloning',
          progressPct,
          attemptGeneration: ownership.attemptGeneration,
          bullmqJobId: ownership.bullmqJobId,
          startedAt: job.startedAt ?? claimTime,
          finishedAt: job.finishedAt,
          durationMs: job.durationMs,
        })
        .where(
          and(
            eq(ingestionJobs.id, ownership.jobId),
            eq(ingestionJobs.repoId, ownership.repoId),
            notInArray(ingestionJobs.stage, [...TERMINAL_INGESTION_JOB_STAGES]),
            lt(ingestionJobs.attemptGeneration, ownership.attemptGeneration),
          ),
        )
        .returning();
      const updatedJob = updatedJobs[0];
      if (updatedJob === undefined) {
        throw new DbError('DB_QUERY_ERROR', 'Failed to update ingestion job during attempt claim.');
      }

      return { outcome: 'claimed', ownership, repository: updatedRepo, job: updatedJob };
    });
  }

  async function transitionJobStage(
    ownership: IngestionAttemptOwnership,
    input: TransitionJobStageInput,
  ): Promise<TransitionJobStageResult> {
    assertValidAttemptOwnership(ownership);
    if (!FENCED_TRANSITION_STAGES.has(input.toStatus)) {
      throw new DbError(
        'DB_VALIDATION_ERROR',
        `Invalid fenced transition stage: ${input.toStatus}.`,
      );
    }
    if (!Number.isInteger(input.progressPct) || input.progressPct < 0 || input.progressPct > 100) {
      throw new DbError(
        'DB_VALIDATION_ERROR',
        `progressPct must be an integer between 0 and 100 (received ${String(input.progressPct)}).`,
      );
    }
    assertNonNegativePgInt32('fileCount', input.fileCount);
    assertNonNegativePgInt32('skippedFilesCount', input.skippedFilesCount);
    const explicitNow = validateExplicitDate(input.now);

    return runBoundedTransaction(db, async (tx): Promise<TransitionJobStageResult> => {
      const verified = await verifyLockedAttemptOwnership(tx, ownership, 'wait');
      if (verified.outcome !== 'verified') {
        return { ...verified, applied: false };
      }

      const transitionTime = explicitNow ?? new Date();
      const repoUpdate: {
        status: FencedTransitionStage;
        updatedAt: Date;
        fileCount?: number;
        skippedFilesCount?: number;
        errorCode?: string | null;
        errorMessage?: string | null;
      } = {
        status: input.toStatus,
        updatedAt: transitionTime,
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

      const updatedRepos = await tx
        .update(repositories)
        .set(repoUpdate)
        .where(
          and(
            eq(repositories.id, ownership.repoId),
            notInArray(repositories.status, [...TERMINAL_REPOSITORY_STATUSES]),
          ),
        )
        .returning();
      const repository = updatedRepos[0];
      if (repository === undefined) {
        throw new DbError('DB_QUERY_ERROR', 'Failed to update repository during stage transition.');
      }

      const startedAt = verified.job.startedAt ?? transitionTime;
      const terminal = isTerminalJobStage(input.toStatus);
      const finishedAt = terminal ? transitionTime : verified.job.finishedAt;
      const durationMs = terminal
        ? Math.max(0, transitionTime.getTime() - startedAt.getTime())
        : verified.job.durationMs;

      const jobUpdate: {
        stage: FencedTransitionStage;
        progressPct: number;
        startedAt: Date;
        finishedAt: Date | null;
        durationMs: number | null;
        errorDetail?: string | null;
      } = {
        stage: input.toStatus,
        progressPct: input.progressPct,
        startedAt,
        finishedAt,
        durationMs,
      };
      if (input.errorDetail !== undefined) {
        jobUpdate.errorDetail = input.errorDetail;
      }

      const updatedJobs = await tx
        .update(ingestionJobs)
        .set(jobUpdate)
        .where(
          and(
            eq(ingestionJobs.id, ownership.jobId),
            eq(ingestionJobs.repoId, ownership.repoId),
            notInArray(ingestionJobs.stage, [...TERMINAL_INGESTION_JOB_STAGES]),
            eq(ingestionJobs.attemptGeneration, ownership.attemptGeneration),
          ),
        )
        .returning();
      const job = updatedJobs[0];
      if (job === undefined) {
        throw new DbError(
          'DB_QUERY_ERROR',
          'Failed to update ingestion job during stage transition.',
        );
      }

      return { outcome: 'applied', applied: true, repository, job };
    });
  }

  /**
   * Administrative pre-claim failure helper for API enqueue errors.
   * An enqueue acknowledgement error (e.g. Redis timeout/disconnect) does NOT prove Redis
   * rejected the job—a fast worker may still claim it. This operation therefore transitions
   * to `failed` ONLY while `repositories.status === 'queued'`, `ingestion_jobs.stage === 'queued'`,
   * and `attempt_generation === 0`, leaving claimed or terminal rows completely untouched.
   */
  async function failQueuedJobOnEnqueueError(
    input: FailQueuedJobOnEnqueueErrorInput,
  ): Promise<FailQueuedJobOnEnqueueErrorResult> {
    if (!UUID_RE.test(input.repoId)) {
      return { outcome: 'identity_mismatch', applied: false, reason: 'invalid_repo_id' };
    }
    if (!UUID_RE.test(input.jobId)) {
      return { outcome: 'identity_mismatch', applied: false, reason: 'invalid_job_id' };
    }
    const errorCode = input.errorCode ?? DEFAULT_ENQUEUE_ERROR_CODE;
    const errorMessage = input.errorMessage ?? DEFAULT_ENQUEUE_ERROR_MESSAGE;
    if (errorCode.trim().length === 0 || errorMessage.trim().length === 0) {
      throw new DbError(
        'DB_VALIDATION_ERROR',
        'Enqueue errorCode and errorMessage must be non-empty.',
      );
    }
    const errorDetail =
      input.errorDetail !== undefined ? input.errorDetail : DEFAULT_ENQUEUE_ERROR_CODE;
    const explicitNow = validateExplicitDate(input.now);

    return runBoundedTransaction(db, async (tx): Promise<FailQueuedJobOnEnqueueErrorResult> => {
      const locked = await lockRepositoryAndJobForUpdate(tx, input.repoId, input.jobId, 'wait');
      if (locked.status !== 'locked') {
        return { outcome: 'missing', applied: false };
      }

      const { repository, job } = locked;
      if (isTerminalRepositoryStatus(repository.status)) {
        return { outcome: 'already_terminal', applied: false, status: repository.status };
      }
      if (isTerminalJobStage(job.stage)) {
        return { outcome: 'already_terminal', applied: false, status: job.stage };
      }
      if (repository.status !== 'queued' || job.stage !== 'queued' || job.attemptGeneration !== 0) {
        return {
          outcome: 'already_claimed',
          applied: false,
          status: repository.status,
          stage: job.stage,
          attemptGeneration: job.attemptGeneration,
        };
      }

      const failureTime = explicitNow ?? new Date();
      const updatedRepos = await tx
        .update(repositories)
        .set({
          status: 'failed',
          errorCode,
          errorMessage,
          updatedAt: failureTime,
        })
        .where(and(eq(repositories.id, input.repoId), eq(repositories.status, 'queued')))
        .returning();
      const updatedRepo = updatedRepos[0];
      if (updatedRepo === undefined) {
        throw new DbError('DB_QUERY_ERROR', 'Failed to mark queued repository failed on enqueue.');
      }

      const startedAt = job.startedAt ?? failureTime;
      const durationMs = Math.max(0, failureTime.getTime() - startedAt.getTime());
      const updatedJobs = await tx
        .update(ingestionJobs)
        .set({
          stage: 'failed',
          progressPct: 0,
          startedAt,
          finishedAt: failureTime,
          durationMs,
          errorDetail,
        })
        .where(
          and(
            eq(ingestionJobs.id, input.jobId),
            eq(ingestionJobs.repoId, input.repoId),
            eq(ingestionJobs.stage, 'queued'),
            eq(ingestionJobs.attemptGeneration, 0),
          ),
        )
        .returning();
      const updatedJob = updatedJobs[0];
      if (updatedJob === undefined) {
        throw new DbError('DB_QUERY_ERROR', 'Failed to mark queued job failed on enqueue.');
      }

      return { outcome: 'failed', applied: true, repository: updatedRepo, job: updatedJob };
    });
  }

  /**
   * Attaches the deterministic BullMQ job ID (`bullmqJobId === jobId`) using an unlocked
   * `repoId` lookup followed by repository-first locking and identity revalidation.
   * Preserves valid worker-backfilled bindings, rejects conflicts, and never mutates
   * terminal states or `repositories.updated_at`.
   */
  async function attachBullMqJobId(
    jobId: string,
    bullmqJobId: string,
  ): Promise<AttachBullMqJobIdResult> {
    if (!UUID_RE.test(jobId)) {
      return { outcome: 'identity_mismatch', attached: false, reason: 'invalid_job_id' };
    }
    if (bullmqJobId !== jobId) {
      return { outcome: 'identity_mismatch', attached: false, reason: 'bullmq_job_id_mismatch' };
    }

    const lookupRows = await db
      .select({ repoId: ingestionJobs.repoId })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.id, jobId))
      .limit(1);
    const discoveredRepoId = lookupRows[0]?.repoId;
    if (discoveredRepoId === undefined) {
      return { outcome: 'missing', attached: false };
    }

    return runBoundedTransaction(db, async (tx): Promise<AttachBullMqJobIdResult> => {
      const locked = await lockRepositoryAndJobForUpdate(tx, discoveredRepoId, jobId, 'wait');
      if (locked.status !== 'locked') {
        return { outcome: 'missing', attached: false };
      }

      const { repository, job } = locked;
      if (job.bullmqJobId !== null) {
        if (job.bullmqJobId === bullmqJobId) {
          return { outcome: 'already_attached', attached: true };
        }
        return {
          outcome: 'identity_mismatch',
          attached: false,
          reason: 'stored_bullmq_job_id_mismatch',
        };
      }
      if (isTerminalRepositoryStatus(repository.status)) {
        return { outcome: 'terminal', attached: false, status: repository.status };
      }
      if (isTerminalJobStage(job.stage)) {
        return { outcome: 'terminal', attached: false, status: job.stage };
      }

      const updated = await tx
        .update(ingestionJobs)
        .set({ bullmqJobId })
        .where(
          and(
            eq(ingestionJobs.id, jobId),
            eq(ingestionJobs.repoId, discoveredRepoId),
            isNull(ingestionJobs.bullmqJobId),
          ),
        )
        .returning({ id: ingestionJobs.id });
      if (updated[0] === undefined) {
        throw new DbError('DB_QUERY_ERROR', 'Failed to attach BullMQ job ID.');
      }

      return { outcome: 'attached', attached: true };
    });
  }

  async function touchJobHeartbeat(
    ownership: IngestionAttemptOwnership,
    now?: Date,
  ): Promise<TouchHeartbeatResult> {
    assertValidAttemptOwnership(ownership);
    const explicitNow = validateExplicitDate(now);

    try {
      return await runBoundedTransaction(db, async (tx): Promise<TouchHeartbeatResult> => {
        const verified = await verifyLockedAttemptOwnership(tx, ownership, 'nowait');

        switch (verified.outcome) {
          case 'missing':
            return { outcome: 'missing', updated: false };
          case 'terminal':
            return { outcome: 'terminal', updated: false, status: verified.status };
          case 'ownership_lost':
            return {
              outcome: 'ownership_lost',
              updated: false,
              reason: 'stale_generation',
              storedGeneration: verified.storedGeneration,
              expectedGeneration: verified.expectedGeneration,
            };
          case 'identity_mismatch':
            return {
              outcome: 'ownership_lost',
              updated: false,
              reason: verified.reason,
            };
          case 'verified':
            break;
        }

        const heartbeatTime = explicitNow ?? new Date();
        const updated = await tx
          .update(repositories)
          .set({ updatedAt: heartbeatTime })
          .where(
            and(
              eq(repositories.id, ownership.repoId),
              notInArray(repositories.status, [...TERMINAL_REPOSITORY_STATUSES]),
            ),
          )
          .returning({ updatedAt: repositories.updatedAt });

        const row = updated[0];
        if (row === undefined) {
          throw new DbError('DB_QUERY_ERROR', 'Failed to update repository heartbeat timestamp.');
        }

        return { outcome: 'updated', updated: true, updatedAt: row.updatedAt };
      });
    } catch (err) {
      if (isBusyLockContentionError(err)) {
        return { outcome: 'busy', updated: false };
      }
      throw err;
    }
  }

  /**
   * Concurrent-safe bounded stale-job sweeper:
   * - Runs in bounded batches (`ORDER BY id ASC LIMIT batchSize FOR UPDATE SKIP LOCKED`),
   *   so busy rows never block the sweep or starve later candidates.
   * - Rechecks non-terminal status and `updated_at < cutoff` after acquiring repository locks.
   * - Locks non-terminal `ingestion_jobs` strictly after `repositories` in deterministic order,
   *   leaving historical terminal jobs untouched.
   */
  async function sweepStaleJobs(input: SweepStaleJobsInput = {}): Promise<SweepStaleJobsResult> {
    const thresholdMs = input.staleThresholdMs ?? DEFAULT_STALE_JOB_THRESHOLD_MS;
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
      throw new DbError(
        'DB_VALIDATION_ERROR',
        `staleThresholdMs must be positive (received ${String(thresholdMs)}).`,
      );
    }

    const batchSize = input.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE;
    const maxBatches = input.maxBatches ?? DEFAULT_SWEEP_MAX_BATCHES;
    const maxDurationMs = input.maxDurationMs ?? DEFAULT_SWEEP_MAX_DURATION_MS;
    assertBoundedInt('batchSize', batchSize, 1, MAX_SWEEP_BATCH_SIZE);
    assertBoundedInt('maxBatches', maxBatches, 1, MAX_SWEEP_MAX_BATCHES);
    assertBoundedInt('maxDurationMs', maxDurationMs, 1, MAX_SWEEP_MAX_DURATION_MS);

    if (input.repoId !== undefined && !UUID_RE.test(input.repoId)) {
      throw new DbError('DB_VALIDATION_ERROR', 'repoId must be a valid UUID.');
    }

    const explicitNow = validateExplicitDate(input.now);
    const sweepStartedMs = Date.now();
    const sweptRepoIds: string[] = [];
    const effectiveMaxBatches = input.repoId !== undefined ? 1 : maxBatches;
    const effectiveBatchSize = input.repoId !== undefined ? 1 : batchSize;

    let batchesProcessed = 0;
    let reachedLimit = false;
    let cursorRepoId: string | undefined;

    while (batchesProcessed < effectiveMaxBatches) {
      if (batchesProcessed > 0 && Date.now() - sweepStartedMs >= maxDurationMs) {
        reachedLimit = true;
        break;
      }

      const batchOutcome = await runBoundedTransaction(db, async (tx) => {
        const preCutoff = new Date((explicitNow ?? new Date()).getTime() - thresholdMs);
        const conditions = [
          notInArray(repositories.status, [...TERMINAL_REPOSITORY_STATUSES]),
          lt(repositories.updatedAt, preCutoff),
        ];
        if (input.repoId !== undefined) {
          conditions.push(eq(repositories.id, input.repoId));
        } else if (cursorRepoId !== undefined) {
          conditions.push(gt(repositories.id, cursorRepoId));
        }

        const lockedRepos = await tx
          .select({
            id: repositories.id,
            status: repositories.status,
            updatedAt: repositories.updatedAt,
          })
          .from(repositories)
          .where(and(...conditions))
          .orderBy(asc(repositories.id))
          .limit(effectiveBatchSize)
          .for('update', { skipLocked: true });

        if (lockedRepos.length === 0) {
          return { lockedCount: 0, lastRepoId: undefined, sweptIds: [] as string[] };
        }

        const sweepTime = explicitNow ?? new Date();
        const postLockCutoff = new Date(sweepTime.getTime() - thresholdMs);
        const eligibleRepoIds = lockedRepos
          .filter(
            (repo) =>
              !isTerminalRepositoryStatus(repo.status) &&
              repo.updatedAt.getTime() < postLockCutoff.getTime(),
          )
          .map((repo) => repo.id);

        const lastRepoId = lockedRepos[lockedRepos.length - 1]?.id;
        if (eligibleRepoIds.length === 0) {
          return { lockedCount: lockedRepos.length, lastRepoId, sweptIds: [] as string[] };
        }

        const updatedRepos = await tx
          .update(repositories)
          .set({
            status: 'failed',
            errorCode: 'JOB_TIMEOUT',
            errorMessage: 'Ingestion timed out before completion. Please try again.',
            updatedAt: sweepTime,
          })
          .where(
            and(
              inArray(repositories.id, eligibleRepoIds),
              notInArray(repositories.status, [...TERMINAL_REPOSITORY_STATUSES]),
              lt(repositories.updatedAt, postLockCutoff),
            ),
          )
          .returning({ id: repositories.id });

        const updatedRepoIds = updatedRepos.map((row) => row.id);
        if (updatedRepoIds.length > 0) {
          const lockedJobs = await tx
            .select({ id: ingestionJobs.id, stage: ingestionJobs.stage })
            .from(ingestionJobs)
            .where(
              and(
                inArray(ingestionJobs.repoId, updatedRepoIds),
                notInArray(ingestionJobs.stage, [...TERMINAL_INGESTION_JOB_STAGES]),
              ),
            )
            .orderBy(asc(ingestionJobs.repoId), asc(ingestionJobs.id))
            .for('update');

          const nonTerminalJobIds = lockedJobs
            .filter((job) => !isTerminalJobStage(job.stage))
            .map((job) => job.id);

          if (nonTerminalJobIds.length > 0) {
            await tx
              .update(ingestionJobs)
              .set({
                stage: 'failed',
                finishedAt: sweepTime,
                errorDetail: 'JOB_TIMEOUT',
              })
              .where(
                and(
                  inArray(ingestionJobs.id, nonTerminalJobIds),
                  notInArray(ingestionJobs.stage, [...TERMINAL_INGESTION_JOB_STAGES]),
                ),
              );
          }
        }

        return {
          lockedCount: lockedRepos.length,
          lastRepoId,
          sweptIds: updatedRepoIds,
        };
      });

      batchesProcessed += 1;
      sweptRepoIds.push(...batchOutcome.sweptIds);

      if (
        input.repoId !== undefined ||
        batchOutcome.lockedCount < effectiveBatchSize ||
        batchOutcome.lastRepoId === undefined
      ) {
        break;
      }

      cursorRepoId = batchOutcome.lastRepoId;
      if (batchesProcessed >= effectiveMaxBatches) {
        reachedLimit = true;
      }
    }

    return {
      sweptRepoIds,
      count: sweptRepoIds.length,
      batchesProcessed,
      reachedLimit,
    };
  }

  async function deleteExpiredRepositories(now?: Date): Promise<readonly string[]> {
    const cutoff = validateExplicitDate(now) ?? new Date();
    const deleted = await db
      .delete(repositories)
      .where(and(eq(repositories.isSample, false), lt(repositories.expiresAt, cutoff)))
      .returning({ id: repositories.id });

    return deleted.map((row) => row.id);
  }

  return {
    findActiveByOwnerNameSha,
    findJobWithRepository,
    createOrGetActive,
    claimIngestionAttempt,
    transitionJobStage,
    failQueuedJobOnEnqueueError,
    attachBullMqJobId,
    touchJobHeartbeat,
    bumpRepositoryExpiry,
    sweepStaleJobs,
    deleteExpiredRepositories,
  };
}
