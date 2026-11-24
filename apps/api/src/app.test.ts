import { randomUUID } from 'node:crypto';
import {
  DEFAULT_REPO_TTL_DAYS,
  DEFAULT_STALE_JOB_THRESHOLD_MS,
  computeExpiresAt,
  type CreateOrGetActiveRepoInput,
  type CreateOrGetActiveRepoResult,
  type IngestionJobRecord,
  type IngestionRepository,
  type RepositoryRecord,
  type RepositoryStatus,
  type RepositoryWithJob,
  type SweepStaleJobsInput,
  type SweepStaleJobsResult,
  type TouchHeartbeatResult,
  type TransitionJobStageInput,
  type TransitionJobStageResult,
} from '@archon/db';
import { createLogger, parseEnv, type AppEnv } from '@archon/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { API_BODY_LIMIT_BYTES, buildApp } from './app.js';
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

function isTerminal(status: RepositoryStatus): boolean {
  return status === 'ready' || status === 'failed';
}

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
        repository.status !== 'failed'
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

  async createOrGetActive(input: CreateOrGetActiveRepoInput): Promise<CreateOrGetActiveRepoResult> {
    const now = input.now ?? new Date();
    const ttlDays = input.ttlDays ?? DEFAULT_REPO_TTL_DAYS;
    const isSample = input.isSample ?? false;
    const initialStatus = input.initialStatus ?? 'queued';

    const existing = await this.findActiveByOwnerNameSha(input.owner, input.name, input.commitSha);
    if (existing) {
      if (existing.repository.status === 'ready' && !existing.repository.isSample) {
        const bumped = await this.bumpRepositoryExpiry(existing.repository.id, { ttlDays, now });
        if (bumped) {
          return { created: false, repository: bumped, job: existing.job };
        }
      }
      return { created: false, repository: existing.repository, job: existing.job };
    }

    const repoId = randomUUID();
    const jobId = randomUUID();
    const isImmediateReady = initialStatus === 'ready';

    const repository: RepositoryRecord = {
      id: repoId,
      githubUrl: input.githubUrl,
      owner: input.owner.toLowerCase(),
      name: input.name.toLowerCase(),
      defaultBranch: input.defaultBranch,
      commitSha: input.commitSha,
      status: initialStatus,
      embeddingStatus: 'pending',
      isSample,
      fileCount: input.fileCount ?? 0,
      skippedFilesCount: 0,
      sizeKb: input.sizeKb,
      errorCode: null,
      errorMessage: null,
      expiresAt: computeExpiresAt(now, ttlDays, isSample),
      createdAt: now,
      updatedAt: now,
    };

    const job: IngestionJobRecord = {
      id: jobId,
      repoId,
      bullmqJobId: null,
      stage: initialStatus,
      progressPct: isImmediateReady ? 100 : 0,
      startedAt: isImmediateReady ? now : null,
      finishedAt: isImmediateReady ? now : null,
      durationMs: isImmediateReady ? 0 : null,
      errorDetail: null,
      createdAt: now,
    };

    this.repos.set(repoId, repository);
    this.jobs.set(jobId, job);
    return { created: true, repository, job };
  }

  transitionJobStage(input: TransitionJobStageInput): Promise<TransitionJobStageResult> {
    const existingRepo = this.repos.get(input.repoId);
    const existingJob = this.jobs.get(input.jobId);
    if (!existingRepo || !existingJob || isTerminal(existingRepo.status)) {
      return Promise.resolve({ applied: false });
    }

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

    const startedAt = existingJob.startedAt ?? (input.toStatus !== 'queued' ? now : null);
    const terminal = isTerminal(input.toStatus);
    const updatedJob: IngestionJobRecord = {
      ...existingJob,
      stage: input.toStatus,
      progressPct: input.progressPct,
      bullmqJobId: input.bullmqJobId ?? existingJob.bullmqJobId,
      startedAt,
      finishedAt: terminal ? now : existingJob.finishedAt,
      durationMs: terminal
        ? Math.max(0, now.getTime() - (startedAt ?? existingJob.createdAt).getTime())
        : existingJob.durationMs,
      errorDetail: input.errorDetail !== undefined ? input.errorDetail : existingJob.errorDetail,
    };

    this.repos.set(input.repoId, updatedRepo);
    this.jobs.set(input.jobId, updatedJob);
    return Promise.resolve({ applied: true, repository: updatedRepo, job: updatedJob });
  }

  attachBullMqJobId(jobId: string, bullmqJobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || isTerminal(job.stage)) {
      return Promise.resolve(false);
    }
    this.jobs.set(jobId, { ...job, bullmqJobId });
    return Promise.resolve(true);
  }

  touchJobHeartbeat(repoId: string, now: Date = new Date()): Promise<TouchHeartbeatResult> {
    const repo = this.repos.get(repoId);
    if (!repo || isTerminal(repo.status)) {
      return Promise.resolve({ updated: false });
    }
    this.repos.set(repoId, { ...repo, updatedAt: now });
    return Promise.resolve({ updated: true, updatedAt: now });
  }

  bumpRepositoryExpiry(
    repoId: string,
    options: { readonly ttlDays?: number; readonly now?: Date } = {},
  ): Promise<RepositoryRecord | null> {
    const repo = this.repos.get(repoId);
    if (repo?.status !== 'ready' || repo.isSample) {
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
      if (!isTerminal(repo.status) && repo.updatedAt.getTime() < cutoffMs) {
        this.repos.set(id, {
          ...repo,
          status: 'failed',
          errorCode: 'JOB_TIMEOUT',
          errorMessage: 'Ingestion timed out before completion. Please try again.',
          updatedAt: now,
        });
        for (const [jobId, job] of this.jobs.entries()) {
          if (job.repoId === id && !isTerminal(job.stage)) {
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

    return Promise.resolve({ sweptRepoIds, count: sweptRepoIds.length });
  }

  deleteExpiredRepositories(now: Date = new Date()): Promise<readonly string[]> {
    const deleted: string[] = [];
    for (const [id, repo] of this.repos.entries()) {
      if (!repo.isSample && repo.expiresAt !== null && repo.expiresAt.getTime() < now.getTime()) {
        this.repos.delete(id);
        deleted.push(id);
      }
    }
    return Promise.resolve(deleted);
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
    } = {},
  ) {
    const env = makeTestEnv(overrides.envOverrides);
    const logger = createLogger({ service: 'api-test', level: 'silent' });
    const repository = overrides.repository ?? new InMemoryIngestionRepository();
    const enqueuedPayloads: IngestionJobPayload[] = [];
    const spyEnqueuer: IngestionJobEnqueuer = overrides.enqueuer ?? {
      enqueue(payload) {
        enqueuedPayloads.push(payload);
        return Promise.resolve({ bullmqJobId: `bull-${enqueuedPayloads.length}` });
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

    // Two requests from same remoteAddress with DIFFERENT spoofed X-Forwarded-For values consume the 2-req limit
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

    // Third request with yet another spoofed X-Forwarded-For is STILL blocked because hops=0 uses remoteAddress
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

    // Health and job polling are NOT rate-limited even for the blocked IP
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

    // Client spoofs leftmost IP (203.0.113.1), while trusted proxy appends real client IP (198.51.100.10)
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.1, 198.51.100.10' },
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(r1.statusCode).toBe(202);

    // Changing only the spoofed leftmost IP STILL hits 198.51.100.10's exhausted bucket -> 429
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.10' },
      payload: { githubUrl: 'https://github.com/pmndrs/zustand' },
    });
    expect(r2.statusCode).toBe(429);
    expect(parseJsonBody(r2.body, errorEnvelopeSchema).error.code).toBe('RATE_LIMITED');

    // A genuinely distinct client address appended by the proxy (198.51.100.20) gets its own bucket -> 202
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

  it('POST /api/v1/repos returns 503 QUEUE_UNAVAILABLE and marks the DB row failed when enqueueing fails', async () => {
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
});
