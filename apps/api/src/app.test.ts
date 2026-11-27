import { randomUUID } from 'node:crypto';
import {
  ACTIVE_REPOSITORY_STATUSES,
  DEFAULT_CLAIM_PROGRESS_PCT,
  DEFAULT_ENQUEUE_ERROR_CODE,
  DEFAULT_ENQUEUE_ERROR_MESSAGE,
  DEFAULT_REPO_TTL_DAYS,
  DEFAULT_STALE_JOB_THRESHOLD_MS,
  assertValidAttemptOwnership,
  computeExpiresAt,
  isLegacyReadyRepository,
  DbError,
  GraphPublicationAbortedError,
  isPersistedReadyRepository,
  prepareGraphPersistencePlan,
  resolvePublicationCounts,
  validateClaimIngestionAttemptInput,
  type AttachBullMqJobIdResult,
  type ClaimIngestionAttemptInput,
  type ClaimIngestionAttemptResult,
  type CreateOrGetActiveRepoInput,
  type CreateOrGetActiveRepoResult,
  type CreateVerifiedEmptyRepoInput,
  type DeleteExpiredRepositoriesOptions,
  type FailQueuedJobOnEnqueueErrorInput,
  type FailQueuedJobOnEnqueueErrorResult,
  type IngestionAttemptOwnership,
  type IngestionJobRecord,
  type IngestionJobStage,
  type IngestionRepository,
  type PublishRepositoryGraphInput,
  type PublishRepositoryGraphResult,
  type ReconcilePublishedAttemptResult,
  type RepositoryRecord,
  type RepositoryStatus,
  type RepositoryWithJob,
  type SweepStaleJobsInput,
  type SweepStaleJobsResult,
  type TouchHeartbeatResult,
  type TransitionJobStageInput,
  type TransitionJobStageResult,
  type VerifiedAttemptOwnershipResult,
} from '@archon/db';
import { createLogger, parseEnv, type AppEnv } from '@archon/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { API_BODY_LIMIT_BYTES, buildApp, type BuildAppDependencies } from './app.js';
import {
  GitHubPrecheckError,
  type GitHubPrecheckClient,
  type PrecheckRepositoryResult,
  type RepoHeadInfo,
} from './github/precheck.js';
import {
  createStubIngestionEnqueuer,
  type IngestionJobEnqueuer,
  type IngestionJobPayload,
} from './queue/enqueuer.js';
import { createRedisRateLimitStoreConfig, type RateLimitStoreConfig } from './rate-limit.js';
import { createRedisRateLimitStore } from './redis-rate-limit-store.js';
import { createIngestionService } from './services/ingestion-service.js';

const ZUSTAND_SHA = '9fed2eb2f3af672da9f7bf694b996df3831fc207';
const SAMPLE_TREE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const healthBodySchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'error']),
  redis: z.enum(['ok', 'error', 'not_configured']),
  workerMode: z.enum(['embedded', 'external']),
  uptimeSec: z.number().int().nonnegative(),
});

const repoCreateBodySchema = z.object({
  repoId: z.uuid(),
  jobId: z.uuid(),
  status: z.string(),
  reused: z.boolean(),
});

const jobStatusBodySchema = z.object({
  jobId: z.uuid(),
  repoId: z.uuid(),
  status: z.string(),
  progressPct: z.number().int(),
  stats: z.object({
    fileCount: z.number().int(),
    skippedFilesCount: z.number().int(),
    emptyJsTs: z.boolean(),
  }),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

function parseJsonBody<T>(rawBody: string, schema: z.ZodType<T>): T {
  const parsed: unknown = JSON.parse(rawBody);
  return schema.parse(parsed);
}

function makeTestEnv(overrides: Record<string, string | undefined> = {}): AppEnv {
  return parseEnv({
    NODE_ENV: 'test',
    PORT: '4000',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://archon:test@127.0.0.1:5432/archon_test',
    REDIS_URL: 'redis://127.0.0.1:6380',
    WEB_ORIGIN: 'http://localhost:3000',
    INGEST_RATE_LIMIT_PER_HOUR: '5',
    TRUST_PROXY_HOPS: '1',
    MAX_SUPPORTED_FILES: '500',
    MAX_REPO_SIZE_MB: '50',
    HUB_THRESHOLD: '30',
    RUN_EMBEDDED_WORKER: 'false',
    ...overrides,
  });
}

function isTerminalRepo(status: RepositoryStatus): boolean {
  return status === 'ready' || status === 'failed' || status === 'superseded';
}

function isTerminalStage(stage: IngestionJobStage): boolean {
  return stage === 'ready' || stage === 'failed';
}

const ACTIVE_REPO_STATUS_SET = new Set<RepositoryStatus>(ACTIVE_REPOSITORY_STATUSES);

class InMemoryIngestionRepository implements IngestionRepository {
  readonly repos = new Map<string, RepositoryRecord>();
  readonly jobs = new Map<string, IngestionJobRecord>();
  expiryBumpCount = 0;

  findActiveByOwnerNameSha(
    owner: string,
    name: string,
    commitSha: string,
  ): Promise<RepositoryWithJob | null> {
    const lowOwner = owner.toLowerCase();
    const lowName = name.toLowerCase();
    for (const repository of this.repos.values()) {
      if (
        repository.owner === lowOwner &&
        repository.name === lowName &&
        repository.commitSha === commitSha &&
        ACTIVE_REPO_STATUS_SET.has(repository.status)
      ) {
        const job = this.findLatestJobSync(repository.id);
        if (job) {
          return Promise.resolve({ repository, job });
        }
      }
    }
    return Promise.resolve(null);
  }

  findJobWithRepository(jobId: string): Promise<RepositoryWithJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return Promise.resolve(null);
    }
    const repository = this.repos.get(job.repoId);
    if (!repository) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ repository, job });
  }

  private async createOrGetInternal(params: {
    readonly githubUrl: string;
    readonly owner: string;
    readonly name: string;
    readonly defaultBranch: string;
    readonly commitSha: string;
    readonly sizeKb: number;
    readonly fileCount: number;
    readonly isSample: boolean;
    readonly initialStatus: 'queued' | 'ready';
    readonly verifiedEmptyGraph: boolean;
    readonly ttlDays: number;
    readonly now: Date;
  }): Promise<CreateOrGetActiveRepoResult> {
    const existing = await this.findActiveByOwnerNameSha(
      params.owner,
      params.name,
      params.commitSha,
    );

    let supersededRepoId: string | undefined;
    let effectiveIsSample =
      params.isSample || this.hasRetainedSampleSync(params.owner, params.name, params.commitSha);

    if (existing !== null) {
      if (isLegacyReadyRepository(existing.repository)) {
        this.repos.set(existing.repository.id, {
          ...existing.repository,
          status: 'superseded',
          updatedAt: params.now,
        });
        supersededRepoId = existing.repository.id;
        effectiveIsSample = existing.repository.isSample || params.isSample;
      } else {
        if (isPersistedReadyRepository(existing.repository) && !existing.repository.isSample) {
          const bumped = await this.bumpRepositoryExpiry(existing.repository.id, {
            ttlDays: params.ttlDays,
            now: params.now,
          });
          if (bumped !== null) {
            return { created: false, repository: bumped, job: existing.job };
          }
        }
        return { created: false, repository: existing.repository, job: existing.job };
      }
    }

    const repoId = randomUUID();
    const jobId = randomUUID();
    const isImmediateReady = params.verifiedEmptyGraph || params.initialStatus === 'ready';

    const repository: RepositoryRecord = {
      graphPersistedAt: params.verifiedEmptyGraph ? params.now : null,
      id: repoId,
      githubUrl: params.githubUrl,
      owner: params.owner.toLowerCase(),
      name: params.name.toLowerCase(),
      defaultBranch: params.defaultBranch,
      commitSha: params.commitSha,
      status: isImmediateReady ? 'ready' : 'queued',
      embeddingStatus: 'pending',
      isSample: effectiveIsSample,
      fileCount: params.verifiedEmptyGraph ? 0 : params.fileCount,
      skippedFilesCount: 0,
      sizeKb: params.sizeKb,
      errorCode: null,
      errorMessage: null,
      expiresAt: computeExpiresAt(params.now, params.ttlDays, effectiveIsSample),
      createdAt: params.now,
      updatedAt: params.now,
    };

    const job: IngestionJobRecord = {
      attemptGeneration: 0,
      id: jobId,
      repoId,
      bullmqJobId: null,
      stage: isImmediateReady ? 'ready' : 'queued',
      progressPct: isImmediateReady ? 100 : 0,
      startedAt: isImmediateReady ? params.now : null,
      finishedAt: isImmediateReady ? params.now : null,
      durationMs: isImmediateReady ? 0 : null,
      errorDetail: null,
      createdAt: params.now,
    };

    this.repos.set(repoId, repository);
    this.jobs.set(jobId, job);
    return {
      created: true,
      ...(supersededRepoId !== undefined ? { supersededRepoId } : {}),
      repository,
      job,
    };
  }

  createOrGetActive(input: CreateOrGetActiveRepoInput): Promise<CreateOrGetActiveRepoResult> {
    return this.createOrGetInternal({
      githubUrl: input.githubUrl,
      owner: input.owner,
      name: input.name,
      defaultBranch: input.defaultBranch,
      commitSha: input.commitSha,
      sizeKb: input.sizeKb,
      fileCount: input.fileCount ?? 0,
      isSample: input.isSample ?? false,
      initialStatus: input.initialStatus ?? 'queued',
      verifiedEmptyGraph: false,
      ttlDays: input.ttlDays ?? DEFAULT_REPO_TTL_DAYS,
      now: input.now ?? new Date(),
    });
  }

  createOrGetVerifiedEmpty(
    input: CreateVerifiedEmptyRepoInput,
  ): Promise<CreateOrGetActiveRepoResult> {
    return this.createOrGetInternal({
      githubUrl: input.githubUrl,
      owner: input.owner,
      name: input.name,
      defaultBranch: input.defaultBranch,
      commitSha: input.commitSha,
      sizeKb: input.sizeKb,
      fileCount: 0,
      isSample: input.isSample ?? false,
      initialStatus: 'ready',
      verifiedEmptyGraph: true,
      ttlDays: input.ttlDays ?? DEFAULT_REPO_TTL_DAYS,
      now: input.now ?? new Date(),
    });
  }
  private verifyOwnershipSync(
    ownership: IngestionAttemptOwnership,
  ): VerifiedAttemptOwnershipResult {
    assertValidAttemptOwnership(ownership);
    const repository = this.repos.get(ownership.repoId);
    const job = this.jobs.get(ownership.jobId);
    if (!repository || job?.repoId !== ownership.repoId) {
      return { outcome: 'missing' };
    }
    if (repository.commitSha !== ownership.commitSha) {
      return { outcome: 'identity_mismatch', reason: 'commit_sha_mismatch' };
    }
    if (job.bullmqJobId !== null && job.bullmqJobId !== ownership.bullmqJobId) {
      return { outcome: 'identity_mismatch', reason: 'stored_bullmq_job_id_mismatch' };
    }
    if (isTerminalRepo(repository.status)) {
      return { outcome: 'terminal', status: repository.status };
    }
    if (isTerminalStage(job.stage)) {
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

  claimIngestionAttempt(input: ClaimIngestionAttemptInput): Promise<ClaimIngestionAttemptResult> {
    const validated = validateClaimIngestionAttemptInput(input);
    if (!validated.ok) {
      return Promise.resolve(validated.rejection);
    }
    const { ownership } = validated;
    const repo = this.repos.get(ownership.repoId);
    const job = this.jobs.get(ownership.jobId);
    if (!repo || job?.repoId !== ownership.repoId) {
      return Promise.resolve({ outcome: 'missing' });
    }
    if (repo.commitSha !== ownership.commitSha) {
      return Promise.resolve({ outcome: 'identity_mismatch', reason: 'commit_sha_mismatch' });
    }
    if (job.bullmqJobId !== null && job.bullmqJobId !== ownership.bullmqJobId) {
      return Promise.resolve({
        outcome: 'identity_mismatch',
        reason: 'stored_bullmq_job_id_mismatch',
      });
    }
    if (isTerminalRepo(repo.status)) {
      return Promise.resolve({ outcome: 'already_terminal', status: repo.status });
    }
    if (isTerminalStage(job.stage)) {
      return Promise.resolve({ outcome: 'already_terminal', status: job.stage });
    }
    if (ownership.attemptGeneration <= job.attemptGeneration) {
      return Promise.resolve({
        outcome: 'stale_generation',
        storedGeneration: job.attemptGeneration,
        incomingGeneration: ownership.attemptGeneration,
      });
    }
    const claimTime = input.now ?? new Date();
    const updatedRepo: RepositoryRecord = { ...repo, status: 'cloning', updatedAt: claimTime };
    const updatedJob: IngestionJobRecord = {
      ...job,
      stage: 'cloning',
      progressPct: input.progressPct ?? DEFAULT_CLAIM_PROGRESS_PCT,
      attemptGeneration: ownership.attemptGeneration,
      bullmqJobId: ownership.bullmqJobId,
      startedAt: job.startedAt ?? claimTime,
    };
    this.repos.set(ownership.repoId, updatedRepo);
    this.jobs.set(ownership.jobId, updatedJob);
    return Promise.resolve({
      outcome: 'claimed',
      ownership,
      repository: updatedRepo,
      job: updatedJob,
    });
  }

  transitionJobStage(
    ownership: IngestionAttemptOwnership,
    input: TransitionJobStageInput,
  ): Promise<TransitionJobStageResult> {
    const verified = this.verifyOwnershipSync(ownership);
    if (verified.outcome !== 'verified') {
      return Promise.resolve({ ...verified, applied: false });
    }

    const { repository: existingRepo, job: existingJob } = verified;
    const now = input.now ?? new Date();
    const updatedRepo: RepositoryRecord = {
      ...existingRepo,
      status: input.toStatus,
      updatedAt: now,
      fileCount: input.fileCount ?? existingRepo.fileCount,
      skippedFilesCount: input.skippedFilesCount ?? existingRepo.skippedFilesCount,
      errorCode: input.errorCode !== undefined ? input.errorCode : existingRepo.errorCode,
      errorMessage:
        input.errorMessage !== undefined ? input.errorMessage : existingRepo.errorMessage,
    };

    const startedAt = existingJob.startedAt ?? now;
    const terminal = isTerminalStage(input.toStatus);
    const updatedJob: IngestionJobRecord = {
      ...existingJob,
      stage: input.toStatus,
      progressPct: input.progressPct,
      startedAt,
      finishedAt: terminal ? now : existingJob.finishedAt,
      durationMs: terminal
        ? Math.max(0, now.getTime() - startedAt.getTime())
        : existingJob.durationMs,
      errorDetail: input.errorDetail !== undefined ? input.errorDetail : existingJob.errorDetail,
    };

    this.repos.set(ownership.repoId, updatedRepo);
    this.jobs.set(ownership.jobId, updatedJob);
    return Promise.resolve({
      outcome: 'applied',
      applied: true,
      repository: updatedRepo,
      job: updatedJob,
    });
  }

  publishRepositoryGraph(
    ownership: IngestionAttemptOwnership,
    input: PublishRepositoryGraphInput,
  ): Promise<PublishRepositoryGraphResult> {
    if (input.signal?.aborted === true) {
      return Promise.reject(new GraphPublicationAbortedError());
    }
    const plan = prepareGraphPersistencePlan(ownership.repoId, input.output, input.batchOptions);
    const counts = resolvePublicationCounts(input.extractionStats, input.output);
    const verified = this.verifyOwnershipSync(ownership);
    if (verified.outcome !== 'verified') {
      return Promise.resolve({ ...verified, applied: false });
    }
    if (
      verified.repository.status !== 'building_graph' ||
      verified.job.stage !== 'building_graph'
    ) {
      return Promise.reject(
        new DbError('DB_VALIDATION_ERROR', 'Repository and job must be in building_graph stage.'),
      );
    }
    const now = input.now ?? new Date();
    const updatedRepo: RepositoryRecord = {
      ...verified.repository,
      status: 'ready',
      graphPersistedAt: now,
      fileCount: counts.fileCount,
      skippedFilesCount: counts.skippedFilesCount,
      updatedAt: now,
    };
    const startedAt = verified.job.startedAt ?? now;
    const updatedJob: IngestionJobRecord = {
      ...verified.job,
      stage: 'ready',
      progressPct: 100,
      startedAt,
      finishedAt: now,
      durationMs: Math.max(0, now.getTime() - startedAt.getTime()),
    };
    this.repos.set(ownership.repoId, updatedRepo);
    this.jobs.set(ownership.jobId, updatedJob);
    return Promise.resolve({
      outcome: 'published',
      applied: true,
      repository: updatedRepo,
      job: updatedJob,
      persistedNodeCount: plan.nodeCount,
      persistedEdgeCount: plan.edgeCount,
      nodeBatches: plan.nodeBatches.length,
      edgeBatches: plan.edgeBatches.length,
    });
  }

  reconcilePublishedAttempt(
    ownership: IngestionAttemptOwnership,
  ): Promise<ReconcilePublishedAttemptResult> {
    assertValidAttemptOwnership(ownership);
    const repository = this.repos.get(ownership.repoId);
    const job = this.jobs.get(ownership.jobId);
    if (!repository || job?.repoId !== ownership.repoId) {
      return Promise.resolve({ outcome: 'missing' });
    }
    if (repository.commitSha !== ownership.commitSha) {
      return Promise.resolve({ outcome: 'identity_mismatch', reason: 'commit_sha_mismatch' });
    }
    if (job.bullmqJobId === null) {
      return Promise.resolve({
        outcome: 'identity_mismatch',
        reason: 'missing_stored_bullmq_job_id',
      });
    }
    if (job.bullmqJobId !== ownership.bullmqJobId) {
      return Promise.resolve({
        outcome: 'identity_mismatch',
        reason: 'stored_bullmq_job_id_mismatch',
      });
    }
    if (
      isPersistedReadyRepository(repository) &&
      job.stage === 'ready' &&
      job.progressPct === 100 &&
      job.attemptGeneration === ownership.attemptGeneration
    ) {
      return Promise.resolve({ outcome: 'published_by_owner', repository, job });
    }
    if (isTerminalRepo(repository.status)) {
      return Promise.resolve({ outcome: 'terminal', status: repository.status });
    }
    if (isTerminalStage(job.stage)) {
      return Promise.resolve({ outcome: 'terminal', status: job.stage });
    }
    if (job.attemptGeneration !== ownership.attemptGeneration) {
      return Promise.resolve({
        outcome: 'ownership_lost',
        storedGeneration: job.attemptGeneration,
        expectedGeneration: ownership.attemptGeneration,
      });
    }
    return Promise.resolve({ outcome: 'still_owned_unpublished', repository, job });
  }

  failQueuedJobOnEnqueueError(
    input: FailQueuedJobOnEnqueueErrorInput,
  ): Promise<FailQueuedJobOnEnqueueErrorResult> {
    const repo = this.repos.get(input.repoId);
    const job = this.jobs.get(input.jobId);
    if (!repo || job?.repoId !== input.repoId) {
      return Promise.resolve({ outcome: 'missing', applied: false });
    }
    if (isTerminalRepo(repo.status)) {
      return Promise.resolve({ outcome: 'already_terminal', applied: false, status: repo.status });
    }
    if (isTerminalStage(job.stage)) {
      return Promise.resolve({ outcome: 'already_terminal', applied: false, status: job.stage });
    }
    if (repo.status !== 'queued' || job.stage !== 'queued' || job.attemptGeneration !== 0) {
      return Promise.resolve({
        outcome: 'already_claimed',
        applied: false,
        status: repo.status,
        stage: job.stage,
        attemptGeneration: job.attemptGeneration,
      });
    }

    const now = input.now ?? new Date();
    const updatedRepo: RepositoryRecord = {
      ...repo,
      status: 'failed',
      errorCode: input.errorCode ?? DEFAULT_ENQUEUE_ERROR_CODE,
      errorMessage: input.errorMessage ?? DEFAULT_ENQUEUE_ERROR_MESSAGE,
      updatedAt: now,
    };
    const startedAt = job.startedAt ?? now;
    const updatedJob: IngestionJobRecord = {
      ...job,
      stage: 'failed',
      progressPct: 0,
      startedAt,
      finishedAt: now,
      durationMs: Math.max(0, now.getTime() - startedAt.getTime()),
      errorDetail: input.errorDetail !== undefined ? input.errorDetail : DEFAULT_ENQUEUE_ERROR_CODE,
    };
    this.repos.set(input.repoId, updatedRepo);
    this.jobs.set(input.jobId, updatedJob);
    return Promise.resolve({
      outcome: 'failed',
      applied: true,
      repository: updatedRepo,
      job: updatedJob,
    });
  }

  attachBullMqJobId(jobId: string, bullmqJobId: string): Promise<AttachBullMqJobIdResult> {
    if (bullmqJobId !== jobId) {
      return Promise.resolve({
        outcome: 'identity_mismatch',
        attached: false,
        reason: 'bullmq_job_id_mismatch',
      });
    }
    const job = this.jobs.get(jobId);
    if (!job) {
      return Promise.resolve({ outcome: 'missing', attached: false });
    }
    const repo = this.repos.get(job.repoId);
    if (!repo) {
      return Promise.resolve({ outcome: 'missing', attached: false });
    }
    if (job.bullmqJobId !== null) {
      if (job.bullmqJobId === bullmqJobId) {
        return Promise.resolve({ outcome: 'already_attached', attached: true });
      }
      return Promise.resolve({
        outcome: 'identity_mismatch',
        attached: false,
        reason: 'stored_bullmq_job_id_mismatch',
      });
    }
    if (isTerminalRepo(repo.status)) {
      return Promise.resolve({ outcome: 'terminal', attached: false, status: repo.status });
    }
    if (isTerminalStage(job.stage)) {
      return Promise.resolve({ outcome: 'terminal', attached: false, status: job.stage });
    }
    this.jobs.set(jobId, { ...job, bullmqJobId });
    return Promise.resolve({ outcome: 'attached', attached: true });
  }

  touchJobHeartbeat(
    ownership: IngestionAttemptOwnership,
    now: Date = new Date(),
  ): Promise<TouchHeartbeatResult> {
    const verified = this.verifyOwnershipSync(ownership);
    switch (verified.outcome) {
      case 'missing':
        return Promise.resolve({ outcome: 'missing', updated: false });
      case 'terminal':
        return Promise.resolve({ outcome: 'terminal', updated: false, status: verified.status });
      case 'ownership_lost':
        return Promise.resolve({
          outcome: 'ownership_lost',
          updated: false,
          reason: 'stale_generation',
          storedGeneration: verified.storedGeneration,
          expectedGeneration: verified.expectedGeneration,
        });
      case 'identity_mismatch':
        return Promise.resolve({
          outcome: 'ownership_lost',
          updated: false,
          reason: verified.reason,
        });
      case 'verified':
        break;
    }
    this.repos.set(ownership.repoId, { ...verified.repository, updatedAt: now });
    return Promise.resolve({ outcome: 'updated', updated: true, updatedAt: now });
  }
  bumpRepositoryExpiry(
    repoId: string,
    options: { readonly ttlDays?: number; readonly now?: Date } = {},
  ): Promise<RepositoryRecord | null> {
    const repo = this.repos.get(repoId);
    if (repo === undefined || !isPersistedReadyRepository(repo) || repo.isSample) {
      return Promise.resolve(null);
    }
    const now = options.now ?? new Date();
    const ttlDays = options.ttlDays ?? DEFAULT_REPO_TTL_DAYS;
    const updated: RepositoryRecord = {
      ...repo,
      expiresAt: computeExpiresAt(now, ttlDays, false),
      updatedAt: now,
    };
    this.repos.set(repoId, updated);
    this.expiryBumpCount += 1;
    return Promise.resolve(updated);
  }
  sweepStaleJobs(input: SweepStaleJobsInput = {}): Promise<SweepStaleJobsResult> {
    const thresholdMs = input.staleThresholdMs ?? DEFAULT_STALE_JOB_THRESHOLD_MS;
    const now = input.now ?? new Date();
    const cutoffMs = now.getTime() - thresholdMs;
    const sweptRepoIds: string[] = [];

    for (const [id, repo] of this.repos.entries()) {
      if (input.repoId !== undefined && id !== input.repoId) {
        continue;
      }
      if (!isTerminalRepo(repo.status) && repo.updatedAt.getTime() < cutoffMs) {
        this.repos.set(id, {
          ...repo,
          status: 'failed',
          errorCode: 'JOB_TIMEOUT',
          errorMessage: 'Ingestion timed out before completion. Please try again.',
          updatedAt: now,
        });
        for (const [jobId, job] of this.jobs.entries()) {
          if (job.repoId === id && !isTerminalStage(job.stage)) {
            this.jobs.set(jobId, {
              ...job,
              stage: 'failed',
              finishedAt: now,
              errorDetail: 'JOB_TIMEOUT',
            });
          }
        }
        sweptRepoIds.push(id);
      }
    }

    return Promise.resolve({
      sweptRepoIds,
      count: sweptRepoIds.length,
      batchesProcessed: sweptRepoIds.length > 0 ? 1 : 0,
      reachedLimit: false,
    });
  }

  deleteExpiredRepositories(
    now: Date = new Date(),
    _options?: DeleteExpiredRepositoriesOptions,
  ): Promise<readonly string[]> {
    const deleted: string[] = [];
    for (const [id, repo] of this.repos.entries()) {
      if (
        !repo.isSample &&
        isTerminalRepo(repo.status) &&
        repo.expiresAt !== null &&
        repo.expiresAt.getTime() < now.getTime()
      ) {
        this.repos.delete(id);
        deleted.push(id);
      }
    }
    return Promise.resolve(deleted);
  }
  private hasRetainedSampleSync(owner: string, name: string, commitSha: string): boolean {
    const lowOwner = owner.toLowerCase();
    const lowName = name.toLowerCase();
    for (const repo of this.repos.values()) {
      if (
        repo.owner === lowOwner &&
        repo.name === lowName &&
        repo.commitSha === commitSha &&
        repo.isSample
      ) {
        return true;
      }
    }
    return false;
  }

  private findLatestJobSync(repoId: string): IngestionJobRecord | null {
    let latest: IngestionJobRecord | null = null;
    for (const job of this.jobs.values()) {
      if (job.repoId === repoId) {
        if (!latest || job.createdAt.getTime() >= latest.createdAt.getTime()) {
          latest = job;
        }
      }
    }
    return latest;
  }
}

function makeFakePrecheck(
  options: {
    readonly head?: Partial<RepoHeadInfo>;
    readonly supportedFileCount?: number;
    readonly error?: Error;
  } = {},
): Pick<GitHubPrecheckClient, 'precheckRepository'> {
  return {
    async precheckRepository(parsedUrl, precheckOptions = {}): Promise<PrecheckRepositoryResult> {
      if (options.error) {
        throw options.error;
      }

      const head: RepoHeadInfo = {
        owner: parsedUrl.owner,
        name: parsedUrl.name,
        canonicalUrl: parsedUrl.canonicalUrl,
        defaultBranch: 'main',
        commitSha: options.head?.commitSha ?? ZUSTAND_SHA,
        treeSha: SAMPLE_TREE_SHA,
        sizeKb: 8253,
        ...options.head,
      };

      if (
        precheckOptions.shouldSkipTreeCheck &&
        (await precheckOptions.shouldSkipTreeCheck(head))
      ) {
        return { head, treeChecked: false };
      }

      const supportedFileCount = options.supportedFileCount ?? 49;
      return {
        head,
        treeChecked: true,
        supportedFileCount,
        emptyJsTs: supportedFileCount === 0,
      };
    },
  };
}

describe('Archon Fastify API (app.inject route tests)', () => {
  const appsToClose: FastifyInstance[] = [];

  afterEach(async () => {
    while (appsToClose.length > 0) {
      const app = appsToClose.pop();
      if (app) {
        await app.close();
      }
    }
  });

  async function createTestApp(
    overrides: {
      envOverrides?: Record<string, string | undefined>;
      repository?: InMemoryIngestionRepository;
      checkDbHealth?: () => Promise<boolean>;
      checkRedisHealth?: () => Promise<boolean>;
      rateLimitStore?: RateLimitStoreConfig;
      githubPrecheck?: Pick<GitHubPrecheckClient, 'precheckRepository'>;
      enqueuer?: IngestionJobEnqueuer;
      now?: () => Date;
      readonly onAppCreated?: BuildAppDependencies['onAppCreated'];
    } = {},
  ) {
    const env = makeTestEnv(overrides.envOverrides);
    const logger = createLogger({ service: 'api-test', level: 'silent' });
    const repository = overrides.repository ?? new InMemoryIngestionRepository();
    const enqueuedPayloads: IngestionJobPayload[] = [];
    const spyEnqueuer: IngestionJobEnqueuer = overrides.enqueuer ?? {
      enqueue(payload) {
        enqueuedPayloads.push(payload);
        return Promise.resolve({ bullmqJobId: payload.jobId });
      },
    };

    const app = await buildApp({
      env,
      logger,
      repository,
      checkDbHealth: overrides.checkDbHealth ?? (() => Promise.resolve(true)),
      githubPrecheck: overrides.githubPrecheck ?? makeFakePrecheck(),
      checkRedisHealth: overrides.checkRedisHealth,
      rateLimitStore: overrides.rateLimitStore,
      enqueuer: spyEnqueuer,
      now: overrides.now,
      ...(overrides.onAppCreated !== undefined ? { onAppCreated: overrides.onAppCreated } : {}),
    });

    appsToClose.push(app);
    return { app, repository, enqueuedPayloads };
  }

  it('GET /api/v1/health returns 200 with redis not_configured when DB is healthy, and 503 when DB fails', async () => {
    const { app } = await createTestApp();
    const okRes = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(okRes.statusCode).toBe(200);
    expect(okRes.headers['x-content-type-options']).toBe('nosniff'); // Helmet active
    const okBody = parseJsonBody(okRes.body, healthBodySchema);
    expect(okBody.status).toBe('ok');
    expect(okBody.db).toBe('ok');
    expect(okBody.redis).toBe('not_configured');
    expect(okBody.workerMode).toBe('external');

    const { app: degradedApp } = await createTestApp({
      envOverrides: { RUN_EMBEDDED_WORKER: 'true' },
      checkDbHealth: () => Promise.resolve(false),
    });
    const badRes = await degradedApp.inject({ method: 'GET', url: '/api/v1/health' });
    expect(badRes.statusCode).toBe(503);
    const badBody = parseJsonBody(badRes.body, healthBodySchema);
    expect(badBody.status).toBe('degraded');
    expect(badBody.db).toBe('error');
    expect(badBody.redis).toBe('not_configured');
    expect(badBody.workerMode).toBe('embedded');
  });

  it('enforces CORS for WEB_ORIGIN with GET/POST/OPTIONS only and blocks disallowed origins', async () => {
    const { app } = await createTestApp({
      envOverrides: { WEB_ORIGIN: 'https://archon.example.com' },
    });

    const allowedGet = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'https://archon.example.com' },
    });
    expect(allowedGet.statusCode).toBe(200);
    expect(allowedGet.headers['access-control-allow-origin']).toBe('https://archon.example.com');

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/repos',
      headers: {
        origin: 'https://archon.example.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://archon.example.com');
    const allowedMethods = preflight.headers['access-control-allow-methods'] ?? '';
    expect(allowedMethods).toContain('GET');
    expect(allowedMethods).toContain('POST');
    expect(allowedMethods).toContain('OPTIONS');
    expect(allowedMethods).not.toContain('DELETE');
    expect(allowedMethods).not.toContain('PUT');

    const disallowed = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(disallowed.headers['access-control-allow-origin']).toBeUndefined();

    const disallowedPreflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/repos',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(disallowedPreflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('POST /api/v1/repos with stub enqueuer creates a queued job and leaves it in queued state', async () => {
    const loggerWarnings: string[] = [];
    const stubEnqueuer = createStubIngestionEnqueuer({
      warn: (_obj: unknown, msg?: string) => {
        if (typeof msg === 'string') {
          loggerWarnings.push(msg);
        }
      },
    });

    const { app, repository } = await createTestApp({ enqueuer: stubEnqueuer });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });

    expect(res.statusCode).toBe(202);
    const created = parseJsonBody(res.body, repoCreateBodySchema);
    expect(created.status).toBe('queued');
    expect(created.reused).toBe(false);
    expect(loggerWarnings).toHaveLength(1);

    // Verify DB row genuinely remained in `queued` with bullmqJobId = null
    const stored = await repository.findJobWithRepository(created.jobId);
    expect(stored?.repository.status).toBe('queued');
    expect(stored?.job.stage).toBe('queued');
    expect(stored?.job.bullmqJobId).toBeNull();

    // GET /api/v1/jobs/:jobId reflects the same queued state
    const pollRes = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${created.jobId}`,
    });
    expect(pollRes.statusCode).toBe(200);
    const pollBody = parseJsonBody(pollRes.body, jobStatusBodySchema);
    expect(pollBody.status).toBe('queued');
    expect(pollBody.progressPct).toBe(0);
    expect(pollBody.stats.fileCount).toBe(49);
    expect(pollBody.stats.emptyJsTs).toBe(false);
  });

  it('rejects unknown fields like sha on public POST /api/v1/repos, invalid URLs, and oversized bodies (>2 KB)', async () => {
    const { app } = await createTestApp({
      envOverrides: { INGEST_RATE_LIMIT_PER_HOUR: '20' },
    });

    const withSha = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: {
        githubUrl: 'https://github.com/pmndrs/zustand',
        sha: ZUSTAND_SHA,
      },
    });
    expect(withSha.statusCode).toBe(400);
    expect(parseJsonBody(withSha.body, errorEnvelopeSchema).error.code).toBe('VALIDATION_ERROR');

    const badUrl = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://gitlab.com/pmndrs/zustand' },
    });
    expect(badUrl.statusCode).toBe(400);
    expect(parseJsonBody(badUrl.body, errorEnvelopeSchema).error.code).toBe('INVALID_URL');

    const hugePayload = JSON.stringify({
      githubUrl: `https://github.com/a/${'x'.repeat(API_BODY_LIMIT_BYTES + 200)}`,
    });
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: { 'content-type': 'application/json' },
      payload: hugePayload,
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(parseJsonBody(tooLarge.body, errorEnvelopeSchema).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('handles emptyJsTs repos, in-flight reuse (202), and ready reuse (200 with expires_at bump)', async () => {
    let clock = new Date('2026-11-21T10:00:00.000Z');
    const repository = new InMemoryIngestionRepository();
    const { app, enqueuedPayloads } = await createTestApp({
      repository,
      githubPrecheck: makeFakePrecheck({ supportedFileCount: 0 }),
      now: () => clock,
    });

    // 1. 0 supported TS/JS files -> immediately ready, never enqueued
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/acme/python-repo' },
    });
    expect(first.statusCode).toBe(202);
    const firstBody = parseJsonBody(first.body, repoCreateBodySchema);
    expect(firstBody.status).toBe('ready');
    expect(firstBody.reused).toBe(false);
    expect(enqueuedPayloads).toHaveLength(0);

    const pollEmpty = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${firstBody.jobId}`,
    });
    expect(parseJsonBody(pollEmpty.body, jobStatusBodySchema).stats.emptyJsTs).toBe(true);

    // 2. Re-submitting same ready repo -> 200 reused: true + bumps expires_at
    clock = new Date('2026-11-22T10:00:00.000Z');
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/acme/python-repo' },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = parseJsonBody(second.body, repoCreateBodySchema);
    expect(secondBody.repoId).toBe(firstBody.repoId);
    expect(secondBody.reused).toBe(true);
    expect(repository.expiryBumpCount).toBe(1);
  });

  it('reuses an in-flight queued job (202 reused: true) and sweeps stale jobs to JOB_TIMEOUT on GET /jobs/:jobId', async () => {
    let clock = new Date('2026-11-21T10:00:00.000Z');
    const { app, enqueuedPayloads } = await createTestApp({
      now: () => clock,
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(first.statusCode).toBe(202);
    const firstBody = parseJsonBody(first.body, repoCreateBodySchema);
    expect(enqueuedPayloads).toHaveLength(1);
    expect(enqueuedPayloads[0]?.jobId).toBe(firstBody.jobId);

    // Duplicate while still queued -> attaches to same job without double-enqueue
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(duplicate.statusCode).toBe(202);
    const dupBody = parseJsonBody(duplicate.body, repoCreateBodySchema);
    expect(dupBody.jobId).toBe(firstBody.jobId);
    expect(dupBody.reused).toBe(true);
    expect(enqueuedPayloads).toHaveLength(1);

    // Advance clock past 10-minute stale threshold -> poll sweeps to failed/JOB_TIMEOUT
    clock = new Date('2026-11-21T10:15:00.000Z');
    const stalePoll = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${firstBody.jobId}`,
    });
    expect(stalePoll.statusCode).toBe(200);
    const staleBody = parseJsonBody(stalePoll.body, jobStatusBodySchema);
    expect(staleBody.status).toBe('failed');
    expect(staleBody.error?.code).toBe('JOB_TIMEOUT');

    // Unknown UUID returns 404 JOB_NOT_FOUND; invalid UUID returns 400 VALIDATION_ERROR
    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${randomUUID()}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(parseJsonBody(missing.body, errorEnvelopeSchema).error.code).toBe('JOB_NOT_FOUND');

    const badUuid = await app.inject({
      method: 'GET',
      url: '/api/v1/jobs/not-a-uuid',
    });
    expect(badUuid.statusCode).toBe(400);
    expect(parseJsonBody(badUuid.body, errorEnvelopeSchema).error.code).toBe('VALIDATION_ERROR');
  });

  it('maps GitHubPrecheckError statuses (404, 422, 451, 503 + Retry-After) into the error envelope', async () => {
    const cases: readonly {
      readonly error: GitHubPrecheckError;
      readonly expectedStatus: number;
      readonly expectedCode: string;
      readonly expectedRetryAfter?: string;
    }[] = [
      {
        error: new GitHubPrecheckError({
          code: 'REPO_NOT_FOUND_OR_PRIVATE',
          statusCode: 404,
          message: 'Repository not found or is private.',
        }),
        expectedStatus: 404,
        expectedCode: 'REPO_NOT_FOUND_OR_PRIVATE',
      },
      {
        error: new GitHubPrecheckError({
          code: 'FILE_LIMIT_EXCEEDED',
          statusCode: 422,
          message: 'Too many files.',
          details: { maxSupportedFiles: 500 },
        }),
        expectedStatus: 422,
        expectedCode: 'FILE_LIMIT_EXCEEDED',
      },
      {
        error: new GitHubPrecheckError({
          code: 'REPO_BLOCKED',
          statusCode: 451,
          message: 'Unavailable for legal reasons.',
        }),
        expectedStatus: 451,
        expectedCode: 'REPO_BLOCKED',
      },
      {
        error: new GitHubPrecheckError({
          code: 'GITHUB_RATE_LIMITED',
          statusCode: 503,
          retryAfterSec: 90,
          message: 'Rate limited.',
        }),
        expectedStatus: 503,
        expectedCode: 'GITHUB_RATE_LIMITED',
        expectedRetryAfter: '90',
      },
    ];

    for (const tc of cases) {
      const { app } = await createTestApp({
        githubPrecheck: makeFakePrecheck({ error: tc.error }),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/repos',
        payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
      });
      expect(res.statusCode).toBe(tc.expectedStatus);
      const body = parseJsonBody(res.body, errorEnvelopeSchema);
      expect(body.error.code).toBe(tc.expectedCode);
      if (tc.expectedRetryAfter !== undefined) {
        expect(res.headers['retry-after']).toBe(tc.expectedRetryAfter);
      }
    }
  });

  it('keys rate limiting strictly on request.ip: TRUST_PROXY_HOPS=0 ignores spoofed X-Forwarded-For', async () => {
    const { app } = await createTestApp({
      envOverrides: {
        TRUST_PROXY_HOPS: '0',
        INGEST_RATE_LIMIT_PER_HOUR: '2',
      },
    });

    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '203.0.113.1' },
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(r1.statusCode).toBe(202);

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '203.0.113.2' },
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(r2.statusCode).toBe(202);

    const r3 = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '203.0.113.3' },
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(r3.statusCode).toBe(429);
    expect(parseJsonBody(r3.body, errorEnvelopeSchema).error.code).toBe('RATE_LIMITED');
    expect(r3.headers['retry-after']).toBeDefined();

    const healthRes = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      remoteAddress: '10.0.0.5',
    });
    expect(healthRes.statusCode).toBe(200);
  });

  it('TRUST_PROXY_HOPS=1 keys rate limit on the single proxy-appended address and ignores leftmost spoofed values', async () => {
    const { app } = await createTestApp({
      envOverrides: {
        TRUST_PROXY_HOPS: '1',
        INGEST_RATE_LIMIT_PER_HOUR: '1',
      },
    });

    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.1, 198.51.100.10' },
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(r1.statusCode).toBe(202);

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.10' },
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(r2.statusCode).toBe(429);
    expect(parseJsonBody(r2.body, errorEnvelopeSchema).error.code).toBe('RATE_LIMITED');

    const r3 = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.20' },
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(r3.statusCode).toBe(202);
  });

  it('GET /api/v1/health reports redis ok (200) and degraded (503) when checkRedisHealth is provided', async () => {
    const { app: healthyApp } = await createTestApp({
      checkRedisHealth: () => Promise.resolve(true),
    });
    const okRes = await healthyApp.inject({ method: 'GET', url: '/api/v1/health' });
    expect(okRes.statusCode).toBe(200);
    const okBody = parseJsonBody(okRes.body, healthBodySchema);
    expect(okBody.status).toBe('ok');
    expect(okBody.db).toBe('ok');
    expect(okBody.redis).toBe('ok');

    const { app: degradedApp } = await createTestApp({
      checkRedisHealth: () => Promise.resolve(false),
    });
    const badRes = await degradedApp.inject({ method: 'GET', url: '/api/v1/health' });
    expect(badRes.statusCode).toBe(503);
    const badBody = parseJsonBody(badRes.body, healthBodySchema);
    expect(badBody.status).toBe('degraded');
    expect(badBody.db).toBe('ok');
    expect(badBody.redis).toBe('error');
  });

  it('POST /api/v1/repos returns 503 QUEUE_UNAVAILABLE and marks queued DB row failed on enqueue error, without overwriting an already-claimed attempt', async () => {
    const repository = new InMemoryIngestionRepository();
    const { app } = await createTestApp({
      repository,
      enqueuer: {
        enqueue: () => Promise.reject(new Error('Redis connection timed out')),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });

    expect(res.statusCode).toBe(503);
    expect(parseJsonBody(res.body, errorEnvelopeSchema).error.code).toBe('QUEUE_UNAVAILABLE');

    const repos = [...repository.repos.values()];
    expect(repos).toHaveLength(1);
    expect(repos[0]?.status).toBe('failed');
    expect(repos[0]?.errorCode).toBe('QUEUE_ENQUEUE_FAILED');

    // Race case: worker claims ownership before enqueue error arrives -> must NOT be overwritten
    const racedRepo = new InMemoryIngestionRepository();
    const { app: racedApp } = await createTestApp({
      repository: racedRepo,
      enqueuer: {
        async enqueue(payload) {
          const claimed = await racedRepo.claimIngestionAttempt({
            repoId: payload.repoId,
            jobId: payload.jobId,
            bullmqJobId: payload.jobId,
            commitSha: payload.commitSha,
            attemptGeneration: 1,
          });
          expect(claimed.outcome).toBe('claimed');
          throw new Error('Late Redis enqueue timeout');
        },
      },
    });

    const racedRes = await racedApp.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(racedRes.statusCode).toBe(503);
    const racedRow = [...racedRepo.repos.values()][0];
    expect(racedRow?.status).toBe('cloning');
    expect(racedRow?.errorCode).toBeNull();
  });

  it('fails open with a logged warning (skipOnError: true) when Redis rate-limit store is not ready', async () => {
    const warnings: string[] = [];
    const storeCtor = createRedisRateLimitStore({
      client: {
        status: 'reconnecting',
        eval: () => Promise.reject(new Error('should not call eval while offline')),
      },
      logger: {
        warn(_obj: unknown, msg?: string): void {
          if (typeof msg === 'string') {
            warnings.push(msg);
          }
        },
      },
    });

    const { app } = await createTestApp({
      rateLimitStore: createRedisRateLimitStoreConfig(storeCtor),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });

    expect(res.statusCode).toBe(202);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('invokes onAppCreated during construction before buildApp resolves and allows closing via the registered callback', async () => {
    const events: string[] = [];
    const capturedInstances: unknown[] = [];
    const ownership: {
      close: (() => Promise<void>) | undefined;
      closed: boolean;
    } = {
      close: undefined,
      closed: false,
    };

    let builtApp: { close(): PromiseLike<unknown> } | undefined;
    try {
      const { app } = await createTestApp({
        onAppCreated: (createdApp) => {
          events.push('onAppCreated');
          capturedInstances.push(createdApp);
          ownership.close = async () => {
            await createdApp.close();
          };
        },
      });
      builtApp = app;
      events.push('buildAppResolved');

      expect(capturedInstances).toHaveLength(1);
      expect(capturedInstances[0]).toBe(app);
      expect(events).toEqual(['onAppCreated', 'buildAppResolved']);

      await app.listen({ host: '127.0.0.1', port: 0 });
      expect(app.server.listening).toBe(true);

      expect(ownership.close).toBeDefined();
      if (ownership.close === undefined) {
        throw new Error('Expected onAppCreated to register Fastify close callback.');
      }
      await ownership.close();
      ownership.closed = true;

      expect(app.server.listening).toBe(false);
    } finally {
      if (!ownership.closed) {
        if (ownership.close !== undefined) {
          await ownership.close();
        } else if (builtApp !== undefined) {
          await builtApp.close();
        }
      }
    }
  });

  it('preserves accepted queued status when attachBullMqJobId fails or rejects after successful enqueue and logs safely without raw errors', async () => {
    class AttachOverrideRepository extends InMemoryIngestionRepository {
      failEnqueueCalls = 0;

      constructor(
        private readonly onAttach: (
          jobId: string,
          bullmqJobId: string,
        ) => Promise<AttachBullMqJobIdResult>,
        private readonly onFailEnqueue?: (
          input: FailQueuedJobOnEnqueueErrorInput,
        ) => Promise<FailQueuedJobOnEnqueueErrorResult>,
      ) {
        super();
      }

      override attachBullMqJobId(
        jobId: string,
        bullmqJobId: string,
      ): Promise<AttachBullMqJobIdResult> {
        return this.onAttach(jobId, bullmqJobId);
      }

      override failQueuedJobOnEnqueueError(
        input: FailQueuedJobOnEnqueueErrorInput,
      ): Promise<FailQueuedJobOnEnqueueErrorResult> {
        this.failEnqueueCalls += 1;
        if (this.onFailEnqueue !== undefined) {
          return this.onFailEnqueue(input);
        }
        return super.failQueuedJobOnEnqueueError(input);
      }
    }

    // 1. Successful Redis enqueue + throwing DB attachment -> HTTP 202, stays queued, never marks failed
    const throwingAttachRepo = new AttachOverrideRepository(() =>
      Promise.reject(new Error('Connection terminated unexpectedly')),
    );
    const { app: attachErrApp, enqueuedPayloads } = await createTestApp({
      repository: throwingAttachRepo,
    });
    const res1 = await attachErrApp.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(res1.statusCode).toBe(202);
    const body1 = parseJsonBody(res1.body, repoCreateBodySchema);
    expect(body1.status).toBe('queued');
    expect(enqueuedPayloads).toHaveLength(1);
    expect(throwingAttachRepo.failEnqueueCalls).toBe(0);
    const stored1 = await throwingAttachRepo.findJobWithRepository(body1.jobId);
    expect(stored1?.repository.status).toBe('queued');
    expect(stored1?.repository.errorCode).toBeNull();
    expect(stored1?.job.bullmqJobId).toBeNull();

    // 2. Explicit attachment rejection outcome -> HTTP 202, never invokes failQueuedJobOnEnqueueError
    const mismatchAttachRepo = new AttachOverrideRepository(() =>
      Promise.resolve({
        outcome: 'identity_mismatch',
        attached: false,
        reason: 'stored_bullmq_job_id_mismatch',
      }),
    );
    const { app: mismatchApp } = await createTestApp({ repository: mismatchAttachRepo });
    const res2 = await mismatchApp.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(res2.statusCode).toBe(202);
    expect(mismatchAttachRepo.failEnqueueCalls).toBe(0);

    // 3. Safe classified logging: raw secrets in attach, enqueue, and cleanup errors never appear in logs
    const attachSecret = 'SECRET_ATTACH_DB_CRED_777';
    const enqueueSecret = 'SECRET_REDIS_ENQUEUE_888';
    const cleanupSecret = 'SECRET_DB_CLEANUP_999';
    const logs: { level: 'warn' | 'error'; obj: unknown; msg: string }[] = [];
    const safeSpyLogger = {
      warn(obj: unknown, msg?: string): void {
        logs.push({ level: 'warn', obj, msg: msg ?? '' });
      },
      error(obj: unknown, msg?: string): void {
        logs.push({ level: 'error', obj, msg: msg ?? '' });
      },
    };

    const attachSecretRepo = new AttachOverrideRepository(() =>
      Promise.reject(new Error(`postgres://u:${attachSecret}@host/db Connection terminated`)),
    );
    const svcAttach = createIngestionService({
      repository: attachSecretRepo,
      githubPrecheck: makeFakePrecheck(),
      enqueuer: {
        enqueue: (payload) => Promise.resolve({ bullmqJobId: payload.jobId }),
      },
      logger: safeSpyLogger,
    });
    const outAttach = await svcAttach.ingestRepository({
      githubUrl: 'https://github.com/pmndrs/zustand',
    });
    expect(outAttach.httpStatus).toBe(202);
    expect(attachSecretRepo.failEnqueueCalls).toBe(0);

    const enqueueSecretRepo = new AttachOverrideRepository(
      () => Promise.resolve({ outcome: 'attached', attached: true }),
      () =>
        Promise.reject(new Error(`postgres://u:${cleanupSecret}@host/db Connection terminated`)),
    );
    const expirySecret = 'sensitive-expiry-test-value';

    enqueueSecretRepo.deleteExpiredRepositories = () =>
      Promise.reject(new Error(`Connection terminated: ${expirySecret}`));

    const svcEnqueue = createIngestionService({
      repository: enqueueSecretRepo,
      githubPrecheck: makeFakePrecheck(),
      enqueuer: {
        enqueue: () => Promise.reject(new Error(`redis://default:${enqueueSecret}@127.0.0.1:6380`)),
      },
      logger: safeSpyLogger,
    });
    let caughtQueueErr: unknown;

    try {
      await svcEnqueue.ingestRepository({
        githubUrl: 'https://github.com/pmndrs/zustand',
      });
    } catch (err) {
      caughtQueueErr = err;
    }

    expect(caughtQueueErr).toMatchObject({
      code: 'QUEUE_UNAVAILABLE',
      statusCode: 503,
    });

    expect(caughtQueueErr).toBeInstanceOf(Error);

    if (caughtQueueErr instanceof Error) {
      expect(caughtQueueErr.cause).toBeUndefined();
    }

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(attachSecret);
    expect(serializedLogs).not.toContain(enqueueSecret);
    expect(serializedLogs).not.toContain(cleanupSecret);
    expect(serializedLogs).not.toContain(expirySecret);
    expect(
      logs.some((entry) =>
        entry.msg.includes('Best-effort cleanup of expired repositories failed'),
      ),
    ).toBe(true);
    expect(serializedLogs).toContain('connection_error');
    expect(serializedLogs).toContain('QUEUE_ENQUEUE_FAILED');
  });

  it('recovers a legacy-ready repository without early reuse, enqueues replacement, reports superseded historical jobs accurately, and reuses persisted-ready repos', async () => {
    const t0 = new Date('2026-11-27T10:00:00.000Z');
    const t1 = new Date('2026-11-27T10:05:00.000Z');
    let clock = t0;

    const repository = new InMemoryIngestionRepository();
    const legacy = await repository.createOrGetActive({
      githubUrl: 'https://github.com/pmndrs/zustand',
      owner: 'pmndrs',
      name: 'zustand',
      defaultBranch: 'main',
      commitSha: ZUSTAND_SHA,
      sizeKb: 8253,
      fileCount: 49,
      initialStatus: 'ready',
      now: t0,
    });
    expect(isLegacyReadyRepository(legacy.repository)).toBe(true);

    let precheckTreeChecks = 0;
    const basePrecheck = makeFakePrecheck({ supportedFileCount: 49 });
    const countingPrecheck: Pick<GitHubPrecheckClient, 'precheckRepository'> = {
      async precheckRepository(parsedUrl, opts) {
        const res = await basePrecheck.precheckRepository(parsedUrl, opts);
        if (res.treeChecked) {
          precheckTreeChecks += 1;
        }
        return res;
      },
    };

    const { app, enqueuedPayloads } = await createTestApp({
      repository,
      githubPrecheck: countingPrecheck,
      now: () => clock,
    });

    // 1. Legacy-ready MUST NOT be early-reused -> tree check runs, legacy is superseded, replacement is enqueued
    clock = t1;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(res.statusCode).toBe(202);
    const body = parseJsonBody(res.body, repoCreateBodySchema);
    expect(body.reused).toBe(false);
    expect(body.status).toBe('queued');
    expect(body.repoId).not.toBe(legacy.repository.id);
    expect(body.jobId).not.toBe(legacy.job.id);
    expect(precheckTreeChecks).toBe(1);
    expect(enqueuedPayloads).toHaveLength(1);
    expect(enqueuedPayloads[0]?.jobId).toBe(body.jobId);

    // 2. Historical job lookup MUST report status: 'superseded' (not 'ready') and emptyJsTs: false
    const histPoll = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${legacy.job.id}`,
    });
    expect(histPoll.statusCode).toBe(200);
    const histBody = parseJsonBody(histPoll.body, jobStatusBodySchema);
    expect(histBody.status).toBe('superseded');
    expect(histBody.stats.emptyJsTs).toBe(false);

    // 3. Mark replacement as persisted-ready -> subsequent POST reuses early without tree check or enqueue
    const replacement = repository.repos.get(body.repoId);
    if (replacement === undefined) {
      throw new Error('Expected replacement repository');
    }
    repository.repos.set(body.repoId, {
      ...replacement,
      status: 'ready',
      graphPersistedAt: t1,
    });

    const reuseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(reuseRes.statusCode).toBe(200);
    const reuseBody = parseJsonBody(reuseRes.body, repoCreateBodySchema);
    expect(reuseBody.reused).toBe(true);
    expect(reuseBody.repoId).toBe(body.repoId);
    expect(precheckTreeChecks).toBe(1);
    expect(enqueuedPayloads).toHaveLength(1);
    expect(repository.expiryBumpCount).toBe(1);
  });

  it('falls back cleanly when a matched ready repo expires before bumpRepositoryExpiry and supports replacement enqueue failure retry', async () => {
    const t0 = new Date('2026-11-27T10:00:00.000Z');
    class ExpireOnBumpRepository extends InMemoryIngestionRepository {
      expiredOnce = false;
      override bumpRepositoryExpiry(
        repoId: string,
        options?: { readonly ttlDays?: number; readonly now?: Date },
      ): Promise<RepositoryRecord | null> {
        if (!this.expiredOnce) {
          this.expiredOnce = true;
          this.repos.delete(repoId);
          return Promise.resolve(null);
        }
        return super.bumpRepositoryExpiry(repoId, options);
      }
    }

    const repository = new ExpireOnBumpRepository();
    const initial = await repository.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/pmndrs/zustand',
      owner: 'pmndrs',
      name: 'zustand',
      defaultBranch: 'main',
      commitSha: ZUSTAND_SHA,
      sizeKb: 100,
      now: t0,
    });

    const { app, enqueuedPayloads } = await createTestApp({
      repository,
      githubPrecheck: makeFakePrecheck({ supportedFileCount: 12 }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(res.statusCode).toBe(202);
    const body = parseJsonBody(res.body, repoCreateBodySchema);
    expect(body.reused).toBe(false);
    expect(body.repoId).not.toBe(initial.repository.id);
    expect(enqueuedPayloads).toHaveLength(1);

    // Replacement enqueue failure leaves superseded legacy row intact and allows retry
    const retryRepo = new InMemoryIngestionRepository();
    const legacyRow = await retryRepo.createOrGetActive({
      githubUrl: 'https://github.com/pmndrs/zustand',
      owner: 'pmndrs',
      name: 'zustand',
      defaultBranch: 'main',
      commitSha: ZUSTAND_SHA,
      sizeKb: 100,
      fileCount: 10,
      initialStatus: 'ready',
      now: t0,
    });
    let enqueueAttempts = 0;
    const { app: retryApp } = await createTestApp({
      repository: retryRepo,
      enqueuer: {
        enqueue(payload) {
          enqueueAttempts += 1;
          if (enqueueAttempts === 1) {
            return Promise.reject(new Error('transient redis down'));
          }
          return Promise.resolve({ bullmqJobId: payload.jobId });
        },
      },
    });

    const failRes = await retryApp.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(failRes.statusCode).toBe(503);
    expect(retryRepo.repos.get(legacyRow.repository.id)?.status).toBe('superseded');

    const okRetryRes = await retryApp.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(okRetryRes.statusCode).toBe(202);
    const okRetryBody = parseJsonBody(okRetryRes.body, repoCreateBodySchema);
    expect(okRetryBody.status).toBe('queued');
    expect(okRetryBody.reused).toBe(false);
  });

  it('preserves isSample and null expiresAt on public retries after a recovered sample repository fails', async () => {
    const t0 = new Date('2026-11-27T11:00:00.000Z');
    const repository = new InMemoryIngestionRepository();

    const legacySample = await repository.createOrGetActive({
      githubUrl: 'https://github.com/pmndrs/zustand',
      owner: 'pmndrs',
      name: 'zustand',
      defaultBranch: 'main',
      commitSha: ZUSTAND_SHA,
      sizeKb: 8253,
      fileCount: 49,
      isSample: true,
      initialStatus: 'ready',
      now: t0,
    });
    expect(legacySample.repository.isSample).toBe(true);
    expect(legacySample.repository.expiresAt).toBeNull();

    let enqueueCalls = 0;
    const { app } = await createTestApp({
      repository,
      enqueuer: {
        enqueue(payload) {
          enqueueCalls += 1;
          if (enqueueCalls === 1) {
            return Promise.reject(new Error('transient redis failure on first recovery'));
          }
          return Promise.resolve({ bullmqJobId: payload.jobId });
        },
      },
    });

    // 1. First public POST triggers legacy sample recovery, then fails enqueueing -> 503
    const firstRes = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(firstRes.statusCode).toBe(503);
    expect(repository.repos.get(legacySample.repository.id)?.status).toBe('superseded');

    const failedRecovery = [...repository.repos.values()].find(
      (r) => r.id !== legacySample.repository.id,
    );
    expect(failedRecovery?.status).toBe('failed');
    expect(failedRecovery?.isSample).toBe(true);
    expect(failedRecovery?.expiresAt).toBeNull();

    // 2. Subsequent public retry (without isSample flag) MUST still preserve isSample=true and expiresAt=null
    const retryRes = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(retryRes.statusCode).toBe(202);
    const retryBody = parseJsonBody(retryRes.body, repoCreateBodySchema);
    expect(retryBody.status).toBe('queued');
    expect(retryBody.reused).toBe(false);
    expect(retryBody.repoId).not.toBe(legacySample.repository.id);
    expect(retryBody.repoId).not.toBe(failedRecovery?.id);

    const retriedRecord = repository.repos.get(retryBody.repoId);
    expect(retriedRecord?.isSample).toBe(true);
    expect(retriedRecord?.expiresAt).toBeNull();
  });
});
