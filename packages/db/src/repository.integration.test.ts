import { randomBytes } from 'node:crypto';
import { loadEnv } from '@archon/shared';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPoolConfig,
  createDbClient,
  sanitizeDatabaseTarget,
  type DbClient,
} from './client.js';
import { runMigrations } from './migrate.js';
import { createIngestionRepository, type IngestionRepository } from './repository.js';
import { ingestionJobs, isEmptyJsTsRepository, repositories } from './schema.js';

function replaceDatabaseName(databaseUrl: string, newDbName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${newDbName}`;
  return parsed.toString();
}

describe('IngestionRepository (PostgreSQL integration)', () => {
  const testDbName = `archon_test_${randomBytes(6).toString('hex')}`;
  let adminPool: Pool | undefined;
  let client: DbClient | undefined;
  let repo: IngestionRepository;

  beforeAll(async () => {
    const env = loadEnv();
    const adminTarget = sanitizeDatabaseTarget(env.DATABASE_URL);
    adminPool = new Pool(buildPoolConfig({ databaseUrl: env.DATABASE_URL, max: 2 }));

    try {
      await adminPool.query('SELECT 1');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`PostgreSQL is unreachable at ${adminTarget}. ... Root cause: ${detail}`, {
        cause: err,
      });
    }

    await adminPool.query(`CREATE DATABASE "${testDbName}"`);

    const isolatedUrl = replaceDatabaseName(env.DATABASE_URL, testDbName);
    client = createDbClient({ databaseUrl: isolatedUrl, max: 5 });
    await runMigrations(client.db);
    repo = createIngestionRepository(client.db);
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
    if (adminPool) {
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
      } finally {
        await adminPool.end();
      }
    }
  });

  it('handles real concurrent inserts via 23505 catch and returns one shared repo/job', async () => {
    const commitSha = '9fed2eb2f3af672da9f7bf694b996df3831fc207';

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repo.createOrGetActive({
          githubUrl: 'https://github.com/pmndrs/zustand',
          owner: 'PMNDRS',
          name: 'Zustand',
          defaultBranch: 'main',
          commitSha,
          sizeKb: 8253,
        }),
      ),
    );

    const createdCount = results.filter((r) => r.created).length;
    const reusedCount = results.filter((r) => !r.created).length;
    expect(createdCount).toBe(1);
    expect(reusedCount).toBe(4);

    const first = results[0];
    if (!first) {
      throw new Error('Expected at least one result');
    }

    for (const result of results) {
      expect(result.repository.id).toBe(first.repository.id);
      expect(result.job.id).toBe(first.job.id);
      expect(result.repository.owner).toBe('pmndrs');
      expect(result.repository.name).toBe('zustand');
      expect(result.repository.expiresAt).not.toBeNull();
    }

    const dbClient = client;
    if (!dbClient) {
      throw new Error('Expected initialized DB client');
    }

    const repoRows = await dbClient.db
      .select()
      .from(repositories)
      .where(eq(repositories.commitSha, commitSha));
    const jobRows = await dbClient.db
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.repoId, first.repository.id));

    expect(repoRows).toHaveLength(1);
    expect(jobRows).toHaveLength(1);
  });

  it('enforces conditional transitions (no overwrite after ready/failed), attaches BullMQ job ID, and allows retrying after failed', async () => {
    const sha = '1111111111111111111111111111111111111111';
    const t0 = new Date('2026-11-21T10:00:00.000Z');
    const t1 = new Date('2026-11-21T10:00:05.000Z');
    const t2 = new Date('2026-11-21T10:00:12.000Z');
    const t3 = new Date('2026-11-21T10:00:20.000Z');

    const firstAttempt = await repo.createOrGetActive({
      githubUrl: 'https://github.com/acme/flaky',
      owner: 'acme',
      name: 'flaky',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 100,
      now: t0,
    });
    expect(firstAttempt.created).toBe(true);

    const attached = await repo.attachBullMqJobId(firstAttempt.job.id, firstAttempt.job.id);
    expect(attached.attached).toBe(true);

    const claimed = await repo.claimIngestionAttempt({
      repoId: firstAttempt.repository.id,
      jobId: firstAttempt.job.id,
      bullmqJobId: firstAttempt.job.id,
      commitSha: sha,
      attemptGeneration: 1,
      progressPct: 25,
      now: t1,
    });
    expect(claimed.outcome).toBe('claimed');
    if (claimed.outcome !== 'claimed') {
      throw new Error('Expected claimed ownership');
    }
    expect(claimed.repository.status).toBe('cloning');
    expect(claimed.repository.updatedAt.getTime()).toBe(t1.getTime());
    expect(claimed.job.bullmqJobId).toBe(firstAttempt.job.id);
    expect(claimed.job.attemptGeneration).toBe(1);
    expect(claimed.job.startedAt?.getTime()).toBe(t1.getTime());

    const ownership = claimed.ownership;

    const failed = await repo.transitionJobStage(ownership, {
      toStatus: 'failed',
      progressPct: 25,
      errorCode: 'TARBALL_ERROR',
      errorMessage: 'Archive download interrupted',
      errorDetail: 'ECONNRESET',
      now: t2,
    });
    expect(failed.applied).toBe(true);
    if (failed.applied) {
      expect(failed.repository.status).toBe('failed');
      expect(failed.repository.errorCode).toBe('TARBALL_ERROR');
      expect(failed.job.durationMs).toBe(7000);
    }

    // Terminal row must NOT transition again
    const lateTransition = await repo.transitionJobStage(ownership, {
      toStatus: 'ready',
      progressPct: 100,
      now: t3,
    });
    expect(lateTransition.applied).toBe(false);
    expect(lateTransition.outcome).toBe('terminal');

    // Failed row MUST NOT block a retry for the exact same (owner, name, commitSha)
    const retryAttempt = await repo.createOrGetActive({
      githubUrl: 'https://github.com/acme/flaky',
      owner: 'acme',
      name: 'flaky',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 100,
      now: t3,
    });
    expect(retryAttempt.created).toBe(true);
    expect(retryAttempt.repository.id).not.toBe(firstAttempt.repository.id);
  });

  it('bumps expires_at on ready user-repo reuse and keeps sample repo expires_at NULL', async () => {
    const t0 = new Date('2026-11-21T08:00:00.000Z');
    const tLater = new Date('2026-11-23T08:00:00.000Z');

    // User repo (ready immediately as emptyJsTs = 0 supported files)
    const userRepo = await repo.createOrGetActive({
      githubUrl: 'https://github.com/acme/python-only',
      owner: 'acme',
      name: 'python-only',
      defaultBranch: 'main',
      commitSha: '2222222222222222222222222222222222222222',
      sizeKb: 50,
      fileCount: 0,
      initialStatus: 'ready',
      ttlDays: 7,
      now: t0,
    });
    expect(userRepo.created).toBe(true);
    expect(isEmptyJsTsRepository(userRepo.repository)).toBe(true);
    const initialExpiryMs = userRepo.repository.expiresAt?.getTime() ?? 0;

    // Reusing a ready user repo bumps expires_at
    const reusedUser = await repo.createOrGetActive({
      githubUrl: 'https://github.com/acme/python-only',
      owner: 'acme',
      name: 'python-only',
      defaultBranch: 'main',
      commitSha: '2222222222222222222222222222222222222222',
      sizeKb: 50,
      ttlDays: 7,
      now: tLater,
    });
    expect(reusedUser.created).toBe(false);
    expect(reusedUser.repository.id).toBe(userRepo.repository.id);
    expect((reusedUser.repository.expiresAt?.getTime() ?? 0) > initialExpiryMs).toBe(true);

    // Sample repo stays expires_at = NULL even on reuse
    const sampleRepo = await repo.createOrGetActive({
      githubUrl: 'https://github.com/shadcn-ui/taxonomy',
      owner: 'shadcn-ui',
      name: 'taxonomy',
      defaultBranch: 'main',
      commitSha: '298a8857c7128a0d121e7f699dfd729f23b3966d',
      sizeKb: 14602,
      fileCount: 129,
      isSample: true,
      initialStatus: 'ready',
      now: t0,
    });
    expect(sampleRepo.repository.isSample).toBe(true);
    expect(sampleRepo.repository.expiresAt).toBeNull();

    const reusedSample = await repo.createOrGetActive({
      githubUrl: 'https://github.com/shadcn-ui/taxonomy',
      owner: 'shadcn-ui',
      name: 'taxonomy',
      defaultBranch: 'main',
      commitSha: '298a8857c7128a0d121e7f699dfd729f23b3966d',
      sizeKb: 14602,
      isSample: true,
      now: tLater,
    });
    expect(reusedSample.created).toBe(false);
    expect(reusedSample.repository.expiresAt).toBeNull();
  });

  it('supports heartbeat touch and sweeps only stale non-terminal jobs to failed with JOB_TIMEOUT', async () => {
    const shaOne = '3333333333333333333333333333333333333333';
    const shaTwo = '4444444444444444444444444444444444444444';
    const tStart = new Date('2026-11-21T09:00:00.000Z');
    const tHeartbeat = new Date('2026-11-21T09:09:00.000Z');
    const tSweep = new Date('2026-11-21T09:11:00.000Z'); // 11m after start, 2m after heartbeat

    const staleOne = await repo.createOrGetActive({
      githubUrl: 'https://github.com/acme/stale-repo',
      owner: 'acme',
      name: 'stale-repo',
      defaultBranch: 'main',
      commitSha: shaOne,
      sizeKb: 20,
      now: tStart,
    });

    const activeOne = await repo.createOrGetActive({
      githubUrl: 'https://github.com/acme/active-repo',
      owner: 'acme',
      name: 'active-repo',
      defaultBranch: 'main',
      commitSha: shaTwo,
      sizeKb: 20,
      now: tStart,
    });

    const claimedStale = await repo.claimIngestionAttempt({
      repoId: staleOne.repository.id,
      jobId: staleOne.job.id,
      bullmqJobId: staleOne.job.id,
      commitSha: shaOne,
      attemptGeneration: 1,
      now: tStart,
    });
    expect(claimedStale.outcome).toBe('claimed');
    if (claimedStale.outcome !== 'claimed') {
      throw new Error('Expected claimed staleOne ownership');
    }

    const claimedActive = await repo.claimIngestionAttempt({
      repoId: activeOne.repository.id,
      jobId: activeOne.job.id,
      bullmqJobId: activeOne.job.id,
      commitSha: shaTwo,
      attemptGeneration: 1,
      now: tStart,
    });
    expect(claimedActive.outcome).toBe('claimed');
    if (claimedActive.outcome !== 'claimed') {
      throw new Error('Expected claimed activeOne ownership');
    }

    const beat = await repo.touchJobHeartbeat(claimedActive.ownership, tHeartbeat);
    expect(beat.outcome).toBe('updated');
    expect(beat.updated).toBe(true);
    if (beat.outcome === 'updated') {
      expect(beat.updatedAt.getTime()).toBe(tHeartbeat.getTime());
    }

    // 10-minute stale threshold: staleOne is 11m old (swept), activeOne is 2m old (safe)
    const swept = await repo.sweepStaleJobs({
      staleThresholdMs: 10 * 60 * 1000,
      now: tSweep,
    });
    expect(swept.sweptRepoIds).toContain(staleOne.repository.id);
    expect(swept.sweptRepoIds).not.toContain(activeOne.repository.id);

    const staleLoaded = await repo.findJobWithRepository(staleOne.job.id);
    expect(staleLoaded?.repository.status).toBe('failed');
    expect(staleLoaded?.repository.errorCode).toBe('JOB_TIMEOUT');
    expect(staleLoaded?.job.stage).toBe('failed');
    expect(staleLoaded?.job.errorDetail).toBe('JOB_TIMEOUT');

    const activeLoaded = await repo.findJobWithRepository(activeOne.job.id);
    expect(activeLoaded?.repository.status).toBe('cloning');
    expect(activeLoaded?.job.stage).toBe('cloning');
    expect(activeLoaded?.repository.updatedAt.getTime()).toBe(tHeartbeat.getTime());

    // Heartbeat on swept terminal staleOne returns terminal without mutating updatedAt
    const tAfterSweep = new Date('2026-11-21T09:12:00.000Z');
    const deadBeat = await repo.touchJobHeartbeat(claimedStale.ownership, tAfterSweep);
    expect(deadBeat.updated).toBe(false);
    expect(deadBeat.outcome).toBe('terminal');
    const staleAfterDeadBeat = await repo.findJobWithRepository(staleOne.job.id);
    expect(staleAfterDeadBeat?.repository.updatedAt.getTime()).toBe(tSweep.getTime());
  });
});
