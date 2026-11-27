import { randomBytes, randomUUID } from 'node:crypto';
import { loadEnv, type AnalysisOutput } from '@archon/shared';
import { eq } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPoolConfig,
  createDbClient,
  sanitizeDatabaseTarget,
  type DbClient,
} from './client.js';
import { DbError } from './errors.js';
import { runMigrations } from './migrate.js';
import { MAX_PG_INT32, createIngestionRepository, type IngestionRepository } from './repository.js';
import { ingestionJobs, repositories } from './schema.js';

const EMPTY_ANALYSIS_OUTPUT: AnalysisOutput = {
  nodes: [],
  edges: [],
  warnings: [],
  stats: {
    discoveredFilesCount: 0,
    parsedFilesCount: 0,
    skippedSyntaxErrorFilesCount: 0,
    skippedOversizedFilesCount: 0,
    configFilesCount: 0,
    folderNodeCount: 0,
    fileNodeCount: 0,
    functionNodeCount: 0,
    classNodeCount: 0,
    symbolNodeCount: 0,
    importsEdgeCount: 0,
    callsEdgeCount: 0,
    totalBytesRead: 0,
    truncatedWarningsCount: 0,
  },
};

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(timeoutMs)} ms waiting for ${label}.`));
    }, timeoutMs);
    timer.unref();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function replaceDatabaseName(databaseUrl: string, newDbName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${newDbName}`;
  return parsed.toString();
}

async function waitForLockWaiters(
  pool: Pool,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await pool.query<{ waiting: number }>(
      `SELECT COUNT(*)::int AS waiting
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'`,
    );
    if ((res.rows[0]?.waiting ?? 0) >= expectedCount) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `Timed out waiting for ${String(expectedCount)} PostgreSQL lock waiter(s) in pg_stat_activity.`,
  );
}

async function safeRollbackAndRelease(pgClient: PoolClient | undefined): Promise<void> {
  if (pgClient === undefined) {
    return;
  }
  try {
    await pgClient.query('ROLLBACK');
  } catch {
    // Ignore rollback errors if already committed/rolled back
  } finally {
    pgClient.release();
  }
}

describe('Ingestion attempt ownership & concurrency (PostgreSQL integration)', () => {
  const testDbName = `archon_own_test_${randomBytes(6).toString('hex')}`;
  let adminPool: Pool | undefined;
  let clientA: DbClient | undefined;
  let clientB: DbClient | undefined;
  let repoA: IngestionRepository;
  let repoB: IngestionRepository;

  beforeAll(async () => {
    const env = loadEnv();
    const adminTarget = sanitizeDatabaseTarget(env.DATABASE_URL);
    adminPool = new Pool(buildPoolConfig({ databaseUrl: env.DATABASE_URL, max: 2 }));

    try {
      await adminPool.query('SELECT 1');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `PostgreSQL is unreachable at ${adminTarget}. Check DATABASE_URL in .env and run npm run docker:up. Root cause: ${detail}`,
        { cause: err },
      );
    }

    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    const isolatedUrl = replaceDatabaseName(env.DATABASE_URL, testDbName);

    clientA = createDbClient({ databaseUrl: isolatedUrl, max: 8 });
    clientB = createDbClient({ databaseUrl: isolatedUrl, max: 8 });
    await runMigrations(clientA.db);
    repoA = createIngestionRepository(clientA.db);
    repoB = createIngestionRepository(clientB.db);
  });

  afterAll(async () => {
    await clientA?.close();
    await clientB?.close();
    if (adminPool !== undefined) {
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
      } finally {
        await adminPool.end();
      }
    }
  });

  it('enforces claim generation ordering, BullMQ backfill, identity invariants, and terminal rejection', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const sha1 = '1010101010101010101010101010101010101010';
    const sha2 = '2020202020202020202020202020202020202020';
    const t0 = new Date('2026-11-27T10:00:00.000Z');
    const t1 = new Date('2026-11-27T10:00:05.000Z');
    const t2 = new Date('2026-11-27T10:00:10.000Z');
    const t3 = new Date('2026-11-27T10:00:15.000Z');
    const t4 = new Date('2026-11-27T10:00:20.000Z');

    const created = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-a/claim-basics',
      owner: 'own-a',
      name: 'claim-basics',
      defaultBranch: 'main',
      commitSha: sha1,
      sizeKb: 100,
      now: t0,
    });
    expect(created.job.attemptGeneration).toBe(0);
    expect(created.job.bullmqJobId).toBeNull();

    // 1. Invalid generation boundaries rejected without mutation
    for (const invalidGen of [0, -1, 1.5, Number.NaN, MAX_PG_INT32 + 1]) {
      const rejected = await repoA.claimIngestionAttempt({
        repoId: created.repository.id,
        jobId: created.job.id,
        bullmqJobId: created.job.id,
        commitSha: sha1,
        attemptGeneration: invalidGen,
        now: t1,
      });
      expect(rejected).toEqual({ outcome: 'invalid_generation', incomingGeneration: invalidGen });
    }

    // 2. Identity mismatches & scoped missing semantics
    const other = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-a/other-repo',
      owner: 'own-a',
      name: 'other-repo',
      defaultBranch: 'main',
      commitSha: sha2,
      sizeKb: 50,
      now: t0,
    });

    expect(
      await repoA.claimIngestionAttempt({
        repoId: 'not-a-uuid',
        jobId: created.job.id,
        bullmqJobId: created.job.id,
        commitSha: sha1,
        attemptGeneration: 1,
      }),
    ).toEqual({ outcome: 'identity_mismatch', reason: 'invalid_repo_id' });

    expect(
      await repoA.claimIngestionAttempt({
        repoId: created.repository.id,
        jobId: 'not-a-uuid',
        bullmqJobId: 'not-a-uuid',
        commitSha: sha1,
        attemptGeneration: 1,
      }),
    ).toEqual({ outcome: 'identity_mismatch', reason: 'invalid_job_id' });

    expect(
      await repoA.claimIngestionAttempt({
        repoId: created.repository.id,
        jobId: created.job.id,
        bullmqJobId: created.job.id,
        commitSha: 'bad-sha',
        attemptGeneration: 1,
      }),
    ).toEqual({ outcome: 'identity_mismatch', reason: 'invalid_commit_sha' });

    expect(
      await repoA.claimIngestionAttempt({
        repoId: created.repository.id,
        jobId: created.job.id,
        bullmqJobId: randomUUID(),
        commitSha: sha1,
        attemptGeneration: 1,
      }),
    ).toEqual({ outcome: 'identity_mismatch', reason: 'bullmq_job_id_mismatch' });

    expect(
      await repoA.claimIngestionAttempt({
        repoId: created.repository.id,
        jobId: created.job.id,
        bullmqJobId: created.job.id,
        commitSha: sha2,
        attemptGeneration: 1,
      }),
    ).toEqual({ outcome: 'identity_mismatch', reason: 'commit_sha_mismatch' });

    // Cross-repo (repoA, repoB.job) returns scoped missing without locking unrelated repo
    expect(
      await repoA.claimIngestionAttempt({
        repoId: created.repository.id,
        jobId: other.job.id,
        bullmqJobId: other.job.id,
        commitSha: sha1,
        attemptGeneration: 1,
      }),
    ).toEqual({ outcome: 'missing' });

    expect(
      await repoA.claimIngestionAttempt({
        repoId: randomUUID(),
        jobId: created.job.id,
        bullmqJobId: created.job.id,
        commitSha: sha1,
        attemptGeneration: 1,
      }),
    ).toEqual({ outcome: 'missing' });

    // 3. Initial generation 1 accepted and backfills nullable bullmq_job_id
    const claim1 = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha1,
      attemptGeneration: 1,
      now: t1,
    });
    expect(claim1.outcome).toBe('claimed');
    if (claim1.outcome !== 'claimed') {
      throw new Error('Expected generation 1 claim to succeed');
    }
    expect(claim1.repository.status).toBe('cloning');
    expect(claim1.repository.updatedAt.getTime()).toBe(t1.getTime());
    expect(claim1.job.stage).toBe('cloning');
    expect(claim1.job.attemptGeneration).toBe(1);
    expect(claim1.job.bullmqJobId).toBe(created.job.id);
    expect(claim1.job.startedAt?.getTime()).toBe(t1.getTime());

    // 4. Equal generation rejected with zero column/timestamp mutations
    const equalRejected = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha1,
      attemptGeneration: 1,
      now: t2,
    });
    expect(equalRejected).toEqual({
      outcome: 'stale_generation',
      storedGeneration: 1,
      incomingGeneration: 1,
    });
    const afterEqual = await repoA.findJobWithRepository(created.job.id);
    expect(afterEqual?.repository.updatedAt.getTime()).toBe(t1.getTime());
    expect(afterEqual?.job.attemptGeneration).toBe(1);

    // 5. Higher generation takeover (2, then MAX_PG_INT32) preserves original started_at
    const claim2 = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha1,
      attemptGeneration: 2,
      now: t2,
    });
    expect(claim2.outcome).toBe('claimed');
    if (claim2.outcome !== 'claimed') {
      throw new Error('Expected generation 2 claim to succeed');
    }
    expect(claim2.job.attemptGeneration).toBe(2);
    expect(claim2.job.startedAt?.getTime()).toBe(t1.getTime());
    expect(claim2.repository.updatedAt.getTime()).toBe(t2.getTime());

    // Delayed lower generation rejected without mutation
    const lowerRejected = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha1,
      attemptGeneration: 1,
      now: t3,
    });
    expect(lowerRejected).toEqual({
      outcome: 'stale_generation',
      storedGeneration: 2,
      incomingGeneration: 1,
    });
    const afterLower = await repoA.findJobWithRepository(created.job.id);
    expect(afterLower?.repository.updatedAt.getTime()).toBe(t2.getTime());

    // Max int32 generation boundary accepted
    const claimMax = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha1,
      attemptGeneration: MAX_PG_INT32,
      now: t3,
    });
    expect(claimMax.outcome).toBe('claimed');
    if (claimMax.outcome !== 'claimed') {
      throw new Error('Expected MAX_PG_INT32 claim to succeed');
    }

    // 6. Terminal repository & terminal job rejections
    await repoA.transitionJobStage(claimMax.ownership, {
      toStatus: 'building_graph',
      progressPct: 85,
      now: t3,
    });
    const finalized = await repoA.publishRepositoryGraph(claimMax.ownership, {
      output: EMPTY_ANALYSIS_OUTPUT,
      now: t4,
    });
    expect(finalized.applied).toBe(true);

    // Terminal repository ('ready') rejected
    expect(
      await repoA.claimIngestionAttempt({
        repoId: created.repository.id,
        jobId: created.job.id,
        bullmqJobId: created.job.id,
        commitSha: sha1,
        attemptGeneration: 1,
      }),
    ).toEqual({ outcome: 'already_terminal', status: 'ready' });

    // Terminal repository ('superseded') rejected
    await clientA.db
      .update(repositories)
      .set({ status: 'superseded' })
      .where(eq(repositories.id, other.repository.id));
    expect(
      await repoA.claimIngestionAttempt({
        repoId: other.repository.id,
        jobId: other.job.id,
        bullmqJobId: other.job.id,
        commitSha: sha2,
        attemptGeneration: 1,
      }),
    ).toEqual({ outcome: 'already_terminal', status: 'superseded' });

    // Terminal job stage ('failed') on an otherwise non-terminal repository rejected
    const sha3 = '3030303030303030303030303030303030303030';
    const terminalJobRepo = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-a/terminal-job',
      owner: 'own-a',
      name: 'terminal-job',
      defaultBranch: 'main',
      commitSha: sha3,
      sizeKb: 10,
      now: t0,
    });
    await clientA.db
      .update(ingestionJobs)
      .set({ stage: 'failed' })
      .where(eq(ingestionJobs.id, terminalJobRepo.job.id));
    expect(
      await repoA.claimIngestionAttempt({
        repoId: terminalJobRepo.repository.id,
        jobId: terminalJobRepo.job.id,
        bullmqJobId: terminalJobRepo.job.id,
        commitSha: sha3,
        attemptGeneration: 1,
      }),
    ).toEqual({ outcome: 'already_terminal', status: 'failed' });
  });

  it('fences stage transitions, heartbeats, ready/failed writes, and enforces PG int32 bounds', async () => {
    const sha = '4040404040404040404040404040404040404040';
    const t0 = new Date('2026-11-27T11:00:00.000Z');
    const t1 = new Date('2026-11-27T11:00:05.000Z');
    const t2 = new Date('2026-11-27T11:00:10.000Z');
    const t3 = new Date('2026-11-27T11:00:15.000Z');
    const t4 = new Date('2026-11-27T11:00:20.000Z');
    const t5 = new Date('2026-11-27T11:00:25.000Z');

    const created = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-b/fenced-writes',
      owner: 'own-b',
      name: 'fenced-writes',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 100,
      now: t0,
    });

    const c1 = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha,
      attemptGeneration: 1,
      now: t1,
    });
    if (c1.outcome !== 'claimed') {
      throw new Error('Expected gen 1 claim');
    }
    const own1 = c1.ownership;

    // Integer validation boundaries
    for (const badInt of [-1, 1.5, MAX_PG_INT32 + 1]) {
      await expect(
        repoA.transitionJobStage(own1, {
          toStatus: 'parsing',
          progressPct: 60,
          fileCount: badInt,
          now: t2,
        }),
      ).rejects.toBeInstanceOf(DbError);

      await expect(
        repoA.transitionJobStage(own1, {
          toStatus: 'parsing',
          progressPct: 60,
          skippedFilesCount: badInt,
          now: t2,
        }),
      ).rejects.toBeInstanceOf(DbError);
    }

    // Current owner (gen 1) succeeds with valid int32 boundary values
    const parsed = await repoA.transitionJobStage(own1, {
      toStatus: 'parsing',
      progressPct: 60,
      fileCount: MAX_PG_INT32,
      skippedFilesCount: 0,
      now: t2,
    });
    expect(parsed.applied).toBe(true);

    // Gen 2 supersedes gen 1
    const c2 = await repoB.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha,
      attemptGeneration: 2,
      now: t3,
    });
    if (c2.outcome !== 'claimed') {
      throw new Error('Expected gen 2 takeover');
    }
    const own2 = c2.ownership;
    const snapshotAfterGen2 = await repoB.findJobWithRepository(created.job.id);

    // Obsolete gen 1 cannot transition, heartbeat, mark ready, or mark failed
    expect(
      await repoA.transitionJobStage(own1, {
        toStatus: 'building_graph',
        progressPct: 85,
        now: t4,
      }),
    ).toEqual({
      outcome: 'ownership_lost',
      applied: false,
      storedGeneration: 2,
      expectedGeneration: 1,
    });

    expect(
      await repoA.publishRepositoryGraph(own1, {
        output: EMPTY_ANALYSIS_OUTPUT,
        now: t4,
      }),
    ).toEqual({
      outcome: 'ownership_lost',
      applied: false,
      storedGeneration: 2,
      expectedGeneration: 1,
    });

    expect(
      await repoA.transitionJobStage(own1, {
        toStatus: 'failed',
        progressPct: 60,
        errorCode: 'OBSOLETE_ERR',
        errorMessage: 'Should never persist',
        errorDetail: 'OBSOLETE_DETAIL',
        now: t4,
      }),
    ).toEqual({
      outcome: 'ownership_lost',
      applied: false,
      storedGeneration: 2,
      expectedGeneration: 1,
    });

    expect(await repoA.touchJobHeartbeat(own1, t4)).toEqual({
      outcome: 'ownership_lost',
      updated: false,
      reason: 'stale_generation',
      storedGeneration: 2,
      expectedGeneration: 1,
    });

    // Verify all DB columns and timestamps remained completely unchanged
    const snapshotAfterRejected = await repoB.findJobWithRepository(created.job.id);
    expect(snapshotAfterRejected).toEqual(snapshotAfterGen2);

    // Current owner (gen 2) transitions parsing with inventory, then atomically publishes to ready
    const parsed2 = await repoB.transitionJobStage(own2, {
      toStatus: 'parsing',
      progressPct: 60,
      fileCount: 12,
      skippedFilesCount: 2,
      now: t4,
    });
    expect(parsed2.applied).toBe(true);

    const building2 = await repoB.transitionJobStage(own2, {
      toStatus: 'building_graph',
      progressPct: 85,
      now: t4,
    });
    expect(building2.applied).toBe(true);

    const ready = await repoB.publishRepositoryGraph(own2, {
      output: EMPTY_ANALYSIS_OUTPUT,
      now: t5,
    });
    expect(ready.applied).toBe(true);
    if (ready.applied) {
      expect(ready.repository.status).toBe('ready');
      expect(ready.repository.graphPersistedAt?.getTime()).toBe(t5.getTime());
      expect(ready.repository.fileCount).toBe(12);
      expect(ready.repository.skippedFilesCount).toBe(2);
      expect(ready.job.stage).toBe('ready');
      expect(ready.job.finishedAt?.getTime()).toBe(t5.getTime());
    }
  });

  it('serializes real concurrent claims across independent connections with explicit PostgreSQL lock barriers', async () => {
    if (clientA === undefined || clientB === undefined) {
      throw new Error('Expected initialized DB clients');
    }

    // 1. Concurrent equal claims (gen 1 vs gen 1) synchronized behind an actual row lock
    const shaEq = '5050505050505050505050505050505050505050';
    const eqCreated = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-c/equal-race',
      owner: 'own-c',
      name: 'equal-race',
      defaultBranch: 'main',
      commitSha: shaEq,
      sizeKb: 10,
    });

    let blocker1: PoolClient | undefined;
    try {
      blocker1 = await clientA.pool.connect();
      await blocker1.query('BEGIN');
      await blocker1.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        eqCreated.repository.id,
      ]);

      const claimAPromise = repoA.claimIngestionAttempt({
        repoId: eqCreated.repository.id,
        jobId: eqCreated.job.id,
        bullmqJobId: eqCreated.job.id,
        commitSha: shaEq,
        attemptGeneration: 1,
      });
      const claimBPromise = repoB.claimIngestionAttempt({
        repoId: eqCreated.repository.id,
        jobId: eqCreated.job.id,
        bullmqJobId: eqCreated.job.id,
        commitSha: shaEq,
        attemptGeneration: 1,
      });

      // Deterministic barrier: wait until BOTH independent claims are blocked on the PG row lock
      await waitForLockWaiters(clientA.pool, 2);

      await blocker1.query('COMMIT');
      blocker1.release();
      blocker1 = undefined;

      const [resA, resB] = await withTimeout(
        Promise.all([claimAPromise, claimBPromise]),
        5_000,
        'equal concurrent claim settlement',
      );
      const outcomes = [resA.outcome, resB.outcome].sort();
      expect(outcomes).toEqual(['claimed', 'stale_generation']);
      const loadedEq = await repoA.findJobWithRepository(eqCreated.job.id);
      expect(loadedEq?.job.attemptGeneration).toBe(1);
    } finally {
      await safeRollbackAndRelease(blocker1);
    }

    // 2. Concurrent gen 1 vs gen 2 race: highest generation (2) always wins regardless of lock grant order
    const shaRace = '5151515151515151515151515151515151515151';
    const raceCreated = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-c/gen-race',
      owner: 'own-c',
      name: 'gen-race',
      defaultBranch: 'main',
      commitSha: shaRace,
      sizeKb: 10,
    });

    let blocker2: PoolClient | undefined;
    try {
      blocker2 = await clientA.pool.connect();
      await blocker2.query('BEGIN');
      await blocker2.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        raceCreated.repository.id,
      ]);

      const gen1Promise = repoA.claimIngestionAttempt({
        repoId: raceCreated.repository.id,
        jobId: raceCreated.job.id,
        bullmqJobId: raceCreated.job.id,
        commitSha: shaRace,
        attemptGeneration: 1,
      });
      const gen2Promise = repoB.claimIngestionAttempt({
        repoId: raceCreated.repository.id,
        jobId: raceCreated.job.id,
        bullmqJobId: raceCreated.job.id,
        commitSha: shaRace,
        attemptGeneration: 2,
      });

      await waitForLockWaiters(clientA.pool, 2);
      await blocker2.query('COMMIT');
      blocker2.release();
      blocker2 = undefined;

      const [r1, r2] = await withTimeout(
        Promise.all([gen1Promise, gen2Promise]),
        5_000,
        'gen 1 vs gen 2 concurrent claim settlement',
      );
      expect(r2.outcome).toBe('claimed');
      expect(['claimed', 'stale_generation']).toContain(r1.outcome);

      const loadedRace = await repoA.findJobWithRepository(raceCreated.job.id);
      expect(loadedRace?.job.attemptGeneration).toBe(2);
    } finally {
      await safeRollbackAndRelease(blocker2);
    }

    // 3. Newer generation commits while delayed older generation is actively blocked on the row lock
    const shaDelayed = '5252525252525252525252525252525252525252';
    const delayedCreated = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-c/delayed-older',
      owner: 'own-c',
      name: 'delayed-older',
      defaultBranch: 'main',
      commitSha: shaDelayed,
      sizeKb: 10,
    });

    let newerHolder: PoolClient | undefined;
    const commitNewerGate = createDeferred();
    try {
      newerHolder = await clientA.pool.connect();
      await newerHolder.query('BEGIN');
      await newerHolder.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        delayedCreated.repository.id,
      ]);
      await newerHolder.query(
        `UPDATE repositories SET status = 'cloning', updated_at = NOW() WHERE id = $1`,
        [delayedCreated.repository.id],
      );
      await newerHolder.query(
        `UPDATE ingestion_jobs
         SET stage = 'cloning', attempt_generation = 2, bullmq_job_id = $2
         WHERE id = $1 AND repo_id = $3`,
        [delayedCreated.job.id, delayedCreated.job.id, delayedCreated.repository.id],
      );

      const delayedOlderClaim = repoB.claimIngestionAttempt({
        repoId: delayedCreated.repository.id,
        jobId: delayedCreated.job.id,
        bullmqJobId: delayedCreated.job.id,
        commitSha: shaDelayed,
        attemptGeneration: 1,
      });

      await waitForLockWaiters(clientA.pool, 1);
      commitNewerGate.resolve();
      await commitNewerGate.promise;
      await newerHolder.query('COMMIT');
      newerHolder.release();
      newerHolder = undefined;

      const delayedOutcome = await withTimeout(
        delayedOlderClaim,
        5_000,
        'delayed older claim after newer commit',
      );
      expect(delayedOutcome).toEqual({
        outcome: 'stale_generation',
        storedGeneration: 2,
        incomingGeneration: 1,
      });
      const loadedDelayed = await repoA.findJobWithRepository(delayedCreated.job.id);
      expect(loadedDelayed?.job.attemptGeneration).toBe(2);
    } finally {
      commitNewerGate.resolve();
      await safeRollbackAndRelease(newerHolder);
    }
  });

  it('distinguishes NOWAIT busy contention (repo & job locks) from ownership_lost across independent connections', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const sha = '6060606060606060606060606060606060606060';
    const t0 = new Date('2026-11-27T12:00:00.000Z');
    const tBusy1 = new Date('2026-11-27T12:01:00.000Z');
    const tOk1 = new Date('2026-11-27T12:02:00.000Z');
    const tBusy2 = new Date('2026-11-27T12:03:00.000Z');
    const tOk2 = new Date('2026-11-27T12:04:00.000Z');
    const tClaim2 = new Date('2026-11-27T12:05:00.000Z');
    const tStaleBeat = new Date('2026-11-27T12:06:00.000Z');

    const created = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-d/heartbeat-lock',
      owner: 'own-d',
      name: 'heartbeat-lock',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 10,
      now: t0,
    });
    const c1 = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha,
      attemptGeneration: 1,
      now: t0,
    });
    if (c1.outcome !== 'claimed') {
      throw new Error('Expected gen 1 claim');
    }
    const own1 = c1.ownership;

    // 1. Repository row lock held -> NOWAIT returns busy without blocking or mutating
    let repoLockClient: PoolClient | undefined;
    try {
      repoLockClient = await clientA.pool.connect();
      await repoLockClient.query('BEGIN');
      await repoLockClient.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        created.repository.id,
      ]);

      const busyRepo = await withTimeout(
        repoB.touchJobHeartbeat(own1, tBusy1),
        3_000,
        'NOWAIT heartbeat during repo lock',
      );
      expect(busyRepo).toEqual({ outcome: 'busy', updated: false });

      await repoLockClient.query('ROLLBACK');
      repoLockClient.release();
      repoLockClient = undefined;
    } finally {
      await safeRollbackAndRelease(repoLockClient);
    }

    const afterRepoLock = await repoB.touchJobHeartbeat(own1, tOk1);
    expect(afterRepoLock).toEqual({ outcome: 'updated', updated: true, updatedAt: tOk1 });

    // 2. Ingestion-job row lock held -> NOWAIT also returns busy
    let jobLockClient: PoolClient | undefined;
    try {
      jobLockClient = await clientA.pool.connect();
      await jobLockClient.query('BEGIN');
      await jobLockClient.query('SELECT id FROM ingestion_jobs WHERE id = $1 FOR UPDATE', [
        created.job.id,
      ]);

      const busyJob = await withTimeout(
        repoB.touchJobHeartbeat(own1, tBusy2),
        3_000,
        'NOWAIT heartbeat during job lock',
      );
      expect(busyJob).toEqual({ outcome: 'busy', updated: false });

      await jobLockClient.query('ROLLBACK');
      jobLockClient.release();
      jobLockClient = undefined;
    } finally {
      await safeRollbackAndRelease(jobLockClient);
    }

    const afterJobLock = await repoB.touchJobHeartbeat(own1, tOk2);
    expect(afterJobLock).toEqual({ outcome: 'updated', updated: true, updatedAt: tOk2 });

    // 3. Newer ownership commits -> old heartbeat returns ownership_lost without mutating updatedAt
    const c2 = await repoB.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha,
      attemptGeneration: 2,
      now: tClaim2,
    });
    expect(c2.outcome).toBe('claimed');

    const staleBeat = await repoA.touchJobHeartbeat(own1, tStaleBeat);
    expect(staleBeat).toEqual({
      outcome: 'ownership_lost',
      updated: false,
      reason: 'stale_generation',
      storedGeneration: 2,
      expectedGeneration: 1,
    });
    const loaded = await repoA.findJobWithRepository(created.job.id);
    expect(loaded?.repository.updatedAt.getTime()).toBe(tClaim2.getTime());
  });

  it('sweeps stale unlocked rows with SKIP LOCKED, protects refreshed work, bounds batches without starvation, and preserves historical terminal jobs', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const tOld = new Date('2026-11-27T08:00:00.000Z');
    const tHistorical = new Date('2026-11-27T07:55:00.000Z');
    const tFresh = new Date('2026-11-27T08:59:00.000Z');
    const tSweep = new Date('2026-11-27T09:00:00.000Z');
    const staleThresholdMs = 10 * 60 * 1000;

    // Create 5 stale repositories and sort by UUID so we can deliberately lock the first two
    const batchRepos = [];
    for (let i = 0; i < 5; i += 1) {
      const sha = String(70 + i).repeat(20);
      const created = await repoA.createOrGetActive({
        githubUrl: `https://github.com/own-e/sweep-${String(i)}`,
        owner: 'own-e',
        name: `sweep-${String(i)}`,
        defaultBranch: 'main',
        commitSha: sha,
        sizeKb: 10,
        now: tOld,
      });
      const claim = await repoA.claimIngestionAttempt({
        repoId: created.repository.id,
        jobId: created.job.id,
        bullmqJobId: created.job.id,
        commitSha: sha,
        attemptGeneration: 1,
        now: tOld,
      });
      if (claim.outcome !== 'claimed') {
        throw new Error('Expected claim for sweep fixture');
      }
      batchRepos.push({ ...created, ownership: claim.ownership });
    }

    const sorted = [...batchRepos].sort((a, b) => a.repository.id.localeCompare(b.repository.id));
    const lockedA = sorted[0];
    const lockedB = sorted[1];
    const unlockedWithHistory = sorted[2];
    const unlockedRefreshed = sorted[3];
    const unlockedPlain = sorted[4];
    if (
      lockedA === undefined ||
      lockedB === undefined ||
      unlockedWithHistory === undefined ||
      unlockedRefreshed === undefined ||
      unlockedPlain === undefined
    ) {
      throw new Error('Expected 5 sorted sweep fixtures');
    }

    // Add a historical terminal ingestion_jobs row to unlockedWithHistory
    const [historicalJob] = await clientA.db
      .insert(ingestionJobs)
      .values({
        repoId: unlockedWithHistory.repository.id,
        stage: 'failed',
        progressPct: 40,
        attemptGeneration: 1,
        startedAt: tHistorical,
        finishedAt: tHistorical,
        durationMs: 1234,
        errorDetail: 'HISTORICAL_FAILURE_DO_NOT_REWRITE',
        createdAt: tHistorical,
      })
      .returning();
    if (historicalJob === undefined) {
      throw new Error('Expected inserted historical job');
    }

    // Refresh unlockedRefreshed with a fresh heartbeat right before the sweep
    const freshBeat = await repoB.touchJobHeartbeat(unlockedRefreshed.ownership, tFresh);
    expect(freshBeat.outcome).toBe('updated');

    let lockClient: PoolClient | undefined;
    try {
      // Hold FOR UPDATE locks on the FIRST TWO repos in UUID order
      lockClient = await clientA.pool.connect();
      await lockClient.query('BEGIN');
      await lockClient.query(
        'SELECT id FROM repositories WHERE id IN ($1, $2) ORDER BY id ASC FOR UPDATE',
        [lockedA.repository.id, lockedB.repository.id],
      );

      // Batch limit 1 with batchSize 1: must SKIP lockedA & lockedB without starvation and sweep 1 unlocked stale row
      const firstSweep = await withTimeout(
        repoB.sweepStaleJobs({
          staleThresholdMs,
          batchSize: 1,
          maxBatches: 1,
          now: tSweep,
        }),
        5_000,
        'bounded SKIP LOCKED sweep 1',
      );
      expect(firstSweep.count).toBe(1);
      expect(firstSweep.batchesProcessed).toBe(1);
      expect(firstSweep.reachedLimit).toBe(true);
      expect(firstSweep.sweptRepoIds).not.toContain(lockedA.repository.id);
      expect(firstSweep.sweptRepoIds).not.toContain(lockedB.repository.id);
      expect(firstSweep.sweptRepoIds).not.toContain(unlockedRefreshed.repository.id);

      // Second sweep processes remaining unlocked stale row and exhausts candidates cleanly
      const secondSweep = await withTimeout(
        repoB.sweepStaleJobs({
          staleThresholdMs,
          batchSize: 2,
          maxBatches: 5,
          now: tSweep,
        }),
        5_000,
        'bounded SKIP LOCKED sweep 2',
      );
      const combinedSwept = [...firstSweep.sweptRepoIds, ...secondSweep.sweptRepoIds].sort();
      expect(combinedSwept).toEqual(
        [unlockedWithHistory.repository.id, unlockedPlain.repository.id].sort(),
      );
      expect(secondSweep.reachedLimit).toBe(false);

      await lockClient.query('ROLLBACK');
      lockClient.release();
      lockClient = undefined;
    } finally {
      await safeRollbackAndRelease(lockClient);
    }

    // Verify locked rows & refreshed row remained active (cloning)
    for (const untouched of [lockedA, lockedB, unlockedRefreshed]) {
      const state = await repoA.findJobWithRepository(untouched.job.id);
      expect(state?.repository.status).toBe('cloning');
      expect(state?.job.stage).toBe('cloning');
    }

    // Verify unlockedWithHistory swept active job to JOB_TIMEOUT while preserving historical terminal job untouched
    const activeJobAfter = await repoA.findJobWithRepository(unlockedWithHistory.job.id);
    expect(activeJobAfter?.repository.status).toBe('failed');
    expect(activeJobAfter?.repository.errorCode).toBe('JOB_TIMEOUT');
    expect(activeJobAfter?.job.stage).toBe('failed');
    expect(activeJobAfter?.job.errorDetail).toBe('JOB_TIMEOUT');
    expect(activeJobAfter?.job.finishedAt?.getTime()).toBe(tSweep.getTime());

    const [historicalAfter] = await clientA.db
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.id, historicalJob.id));
    expect(historicalAfter?.stage).toBe('failed');
    expect(historicalAfter?.errorDetail).toBe('HISTORICAL_FAILURE_DO_NOT_REWRITE');
    expect(historicalAfter?.finishedAt?.getTime()).toBe(tHistorical.getTime());
    expect(historicalAfter?.durationMs).toBe(1234);
  });

  it('protects enqueue failure and BullMQ attachment against worker claim races and conflicting IDs', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const t0 = new Date('2026-11-27T13:00:00.000Z');
    const t1 = new Date('2026-11-27T13:00:05.000Z');
    const t2 = new Date('2026-11-27T13:00:10.000Z');

    // 1. Pre-claim enqueue failure succeeds at generation 0, then rejects repeat on terminal row
    const shaFail = '8080808080808080808080808080808080808080';
    const queued = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-f/enqueue-fail',
      owner: 'own-f',
      name: 'enqueue-fail',
      defaultBranch: 'main',
      commitSha: shaFail,
      sizeKb: 10,
      now: t0,
    });
    const failedPreClaim = await repoA.failQueuedJobOnEnqueueError({
      repoId: queued.repository.id,
      jobId: queued.job.id,
      now: t1,
    });
    expect(failedPreClaim.outcome).toBe('failed');
    expect(failedPreClaim.applied).toBe(true);
    if (failedPreClaim.outcome === 'failed') {
      expect(failedPreClaim.repository.status).toBe('failed');
      expect(failedPreClaim.repository.errorCode).toBe('QUEUE_ENQUEUE_FAILED');
      expect(failedPreClaim.job.stage).toBe('failed');
      expect(failedPreClaim.job.finishedAt?.getTime()).toBe(t1.getTime());
    }

    const repeatFail = await repoA.failQueuedJobOnEnqueueError({
      repoId: queued.repository.id,
      jobId: queued.job.id,
      now: t2,
    });
    expect(repeatFail).toEqual({
      outcome: 'already_terminal',
      applied: false,
      status: 'failed',
    });
    // Attachment on terminal row rejected without mutation
    expect(await repoA.attachBullMqJobId(queued.job.id, queued.job.id)).toEqual({
      outcome: 'terminal',
      attached: false,
      status: 'failed',
    });

    // 2. Claimed attempt cannot be overwritten by late enqueue failure; post-claim attach is idempotent
    const shaRace = '8181818181818181818181818181818181818181';
    const raced = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-f/enqueue-race',
      owner: 'own-f',
      name: 'enqueue-race',
      defaultBranch: 'main',
      commitSha: shaRace,
      sizeKb: 10,
      now: t0,
    });
    const claimed = await repoA.claimIngestionAttempt({
      repoId: raced.repository.id,
      jobId: raced.job.id,
      bullmqJobId: raced.job.id,
      commitSha: shaRace,
      attemptGeneration: 1,
      now: t1,
    });
    expect(claimed.outcome).toBe('claimed');

    const lateFail = await repoB.failQueuedJobOnEnqueueError({
      repoId: raced.repository.id,
      jobId: raced.job.id,
      now: t2,
    });
    expect(lateFail).toEqual({
      outcome: 'already_claimed',
      applied: false,
      status: 'cloning',
      stage: 'cloning',
      attemptGeneration: 1,
    });

    // Worker already backfilled bullmq_job_id -> attach returns already_attached without altering updatedAt
    expect(await repoB.attachBullMqJobId(raced.job.id, raced.job.id)).toEqual({
      outcome: 'already_attached',
      attached: true,
    });
    const racedState = await repoA.findJobWithRepository(raced.job.id);
    expect(racedState?.repository.status).toBe('cloning');
    expect(racedState?.repository.updatedAt.getTime()).toBe(t1.getTime());

    // 3. Pre-claim attach preserves updatedAt, and conflicting attachments are rejected without mutation
    const shaAttach = '8282828282828282828282828282828282828282';
    const preAttach = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/own-f/pre-attach',
      owner: 'own-f',
      name: 'pre-attach',
      defaultBranch: 'main',
      commitSha: shaAttach,
      sizeKb: 10,
      now: t0,
    });
    expect(await repoA.attachBullMqJobId(preAttach.job.id, randomUUID())).toEqual({
      outcome: 'identity_mismatch',
      attached: false,
      reason: 'bullmq_job_id_mismatch',
    });
    expect(await repoA.attachBullMqJobId(preAttach.job.id, preAttach.job.id)).toEqual({
      outcome: 'attached',
      attached: true,
    });
    const preAttachState = await repoA.findJobWithRepository(preAttach.job.id);
    expect(preAttachState?.job.bullmqJobId).toBe(preAttach.job.id);
    expect(preAttachState?.repository.updatedAt.getTime()).toBe(t0.getTime());

    // Conflicting stored bullmq_job_id rejected on both attach and claim without mutation
    await clientA.db
      .update(ingestionJobs)
      .set({ bullmqJobId: 'corrupted-foreign-id' })
      .where(eq(ingestionJobs.id, preAttach.job.id));

    expect(await repoA.attachBullMqJobId(preAttach.job.id, preAttach.job.id)).toEqual({
      outcome: 'identity_mismatch',
      attached: false,
      reason: 'stored_bullmq_job_id_mismatch',
    });
    expect(
      await repoA.claimIngestionAttempt({
        repoId: preAttach.repository.id,
        jobId: preAttach.job.id,
        bullmqJobId: preAttach.job.id,
        commitSha: shaAttach,
        attemptGeneration: 1,
      }),
    ).toEqual({
      outcome: 'identity_mismatch',
      reason: 'stored_bullmq_job_id_mismatch',
    });
  });
});
