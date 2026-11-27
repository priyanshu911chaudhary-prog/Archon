import { randomBytes } from 'node:crypto';
import { loadEnv } from '@archon/shared';
import { eq } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPoolConfig,
  createDbClient,
  sanitizeDatabaseTarget,
  type DbClient,
} from './client.js';
import { runMigrations } from './migrate.js';
import {
  createIngestionRepository,
  isLegacyReadyRepository,
  isPersistedReadyRepository,
  type IngestionRepository,
} from './repository.js';
import { edges, ingestionJobs, isEmptyJsTsRepository, nodes, repositories } from './schema.js';

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

describe('Legacy-ready recovery, verified-empty graphs & expiration safety (PostgreSQL integration)', () => {
  const testDbName = `archon_rec_test_${randomBytes(6).toString('hex')}`;
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

  it('atomically supersedes a legacy-ready repo, preserves historical records & generation, and supports replacement enqueue failure + retry', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const sha = '1212121212121212121212121212121212121212';
    const t0 = new Date('2026-11-27T09:00:00.000Z');
    const t1 = new Date('2026-11-27T09:01:00.000Z');
    const t2 = new Date('2026-11-27T09:02:00.000Z');
    const t3 = new Date('2026-11-27T09:03:00.000Z');

    // Create a legacy-ready repo (status = 'ready', graphPersistedAt = null, fileCount = 0 does NOT infer persistence)
    const legacy = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-a/legacy-repo',
      owner: 'rec-a',
      name: 'legacy-repo',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 120,
      fileCount: 0,
      initialStatus: 'ready',
      now: t0,
    });
    expect(isLegacyReadyRepository(legacy.repository)).toBe(true);
    expect(isEmptyJsTsRepository(legacy.repository)).toBe(false);

    // Simulate historical ownership metadata on the legacy job
    await clientA.db
      .update(ingestionJobs)
      .set({ attemptGeneration: 2, bullmqJobId: legacy.job.id })
      .where(eq(ingestionJobs.id, legacy.job.id));

    // bumpRepositoryExpiry must NOT extend a legacy-ready repository
    expect(await repoA.bumpRepositoryExpiry(legacy.repository.id, { now: t1 })).toBeNull();

    // Recovery atomically supersedes legacy repo and creates fresh queued replacement
    const recovered = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-a/legacy-repo',
      owner: 'rec-a',
      name: 'legacy-repo',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 120,
      fileCount: 15,
      now: t1,
    });
    expect(recovered.created).toBe(true);
    expect(recovered.supersededRepoId).toBe(legacy.repository.id);
    expect(recovered.repository.id).not.toBe(legacy.repository.id);
    expect(recovered.job.id).not.toBe(legacy.job.id);
    expect(recovered.repository.status).toBe('queued');
    expect(recovered.repository.graphPersistedAt).toBeNull();
    expect(recovered.job.attemptGeneration).toBe(0);
    expect(recovered.job.bullmqJobId).toBeNull();

    // Original repository and historical job remain intact
    const historicalLoaded = await repoA.findJobWithRepository(legacy.job.id);
    expect(historicalLoaded?.repository.status).toBe('superseded');
    expect(historicalLoaded?.repository.graphPersistedAt).toBeNull();
    expect(historicalLoaded?.job.stage).toBe('ready');
    expect(historicalLoaded?.job.attemptGeneration).toBe(2);
    expect(historicalLoaded?.job.bullmqJobId).toBe(legacy.job.id);

    // Replacement enqueue failure marks ONLY the replacement failed, allowing clean retry
    const enqFail = await repoA.failQueuedJobOnEnqueueError({
      repoId: recovered.repository.id,
      jobId: recovered.job.id,
      now: t2,
    });
    expect(enqFail.outcome).toBe('failed');

    const retry = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-a/legacy-repo',
      owner: 'rec-a',
      name: 'legacy-repo',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 120,
      fileCount: 15,
      now: t3,
    });
    expect(retry.created).toBe(true);
    expect(retry.repository.id).not.toBe(recovered.repository.id);
    expect(retry.repository.id).not.toBe(legacy.repository.id);
    expect(retry.repository.status).toBe('queued');
  });

  it('converges concurrent legacy-ready recovery requests onto one replacement repository/job under real PG row locking', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const sha = '2323232323232323232323232323232323232323';
    const t0 = new Date('2026-11-27T09:10:00.000Z');
    const legacy = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-b/concurrent-legacy',
      owner: 'rec-b',
      name: 'concurrent-legacy',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 50,
      fileCount: 10,
      initialStatus: 'ready',
      now: t0,
    });

    let blocker: PoolClient | undefined;
    let pA: Promise<Awaited<ReturnType<IngestionRepository['createOrGetActive']>>> | undefined;
    let pB: Promise<Awaited<ReturnType<IngestionRepository['createOrGetActive']>>> | undefined;
    try {
      blocker = await clientA.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        legacy.repository.id,
      ]);

      pA = repoA.createOrGetActive({
        githubUrl: 'https://github.com/rec-b/concurrent-legacy',
        owner: 'rec-b',
        name: 'concurrent-legacy',
        defaultBranch: 'main',
        commitSha: sha,
        sizeKb: 50,
        fileCount: 10,
      });
      pB = repoB.createOrGetActive({
        githubUrl: 'https://github.com/rec-b/concurrent-legacy',
        owner: 'rec-b',
        name: 'concurrent-legacy',
        defaultBranch: 'main',
        commitSha: sha,
        sizeKb: 50,
        fileCount: 10,
      });

      await waitForLockWaiters(clientA.pool, 2);
      await blocker.query('COMMIT');
      blocker.release();
      blocker = undefined;

      const [resA, resB] = await withTimeout(
        Promise.all([pA, pB]),
        5_000,
        'concurrent legacy recovery settlement',
      );
      expect([resA.created, resB.created].sort()).toEqual([false, true]);
      expect(resA.repository.id).toBe(resB.repository.id);
      expect(resA.job.id).toBe(resB.job.id);
      expect(resA.repository.id).not.toBe(legacy.repository.id);
      expect(resA.repository.status).toBe('queued');

      const allRows = await clientA.db
        .select()
        .from(repositories)
        .where(eq(repositories.commitSha, sha));
      expect(allRows).toHaveLength(2);
      expect(allRows.map((r) => r.status).sort()).toEqual(['queued', 'superseded']);
    } finally {
      await safeRollbackAndRelease(blocker);
      await Promise.allSettled([pA, pB].filter((p) => p !== undefined));
    }
  });

  it('creates verified-empty persisted graphs, reuses persisted-ready repos without replacement, and preserves sample identity on recovery', async () => {
    const t0 = new Date('2026-11-27T10:00:00.000Z');
    const t1 = new Date('2026-11-27T10:05:00.000Z');

    // 1. Verified-empty creation sets graphPersistedAt atomically and is reused without replacement
    const shaEmpty = '3434343434343434343434343434343434343434';
    const emptyCreated = await repoA.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/rec-c/empty-repo',
      owner: 'rec-c',
      name: 'empty-repo',
      defaultBranch: 'main',
      commitSha: shaEmpty,
      sizeKb: 12,
      now: t0,
    });
    expect(emptyCreated.created).toBe(true);
    expect(isPersistedReadyRepository(emptyCreated.repository)).toBe(true);
    expect(isEmptyJsTsRepository(emptyCreated.repository)).toBe(true);
    expect(emptyCreated.job.stage).toBe('ready');
    expect(emptyCreated.job.progressPct).toBe(100);

    const emptyReused = await repoB.createOrGetActive({
      githubUrl: 'https://github.com/rec-c/empty-repo',
      owner: 'rec-c',
      name: 'empty-repo',
      defaultBranch: 'main',
      commitSha: shaEmpty,
      sizeKb: 12,
      now: t1,
    });
    expect(emptyReused.created).toBe(false);
    expect(emptyReused.repository.id).toBe(emptyCreated.repository.id);
    expect(
      (emptyReused.repository.expiresAt?.getTime() ?? 0) >
        (emptyCreated.repository.expiresAt?.getTime() ?? 0),
    ).toBe(true);

    // 2. Legacy-ready recovered via createOrGetVerifiedEmpty supersedes instead of backfilling in-place
    const shaLegacyEmpty = '3535353535353535353535353535353535353535';
    const legacyEmpty = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-c/legacy-empty',
      owner: 'rec-c',
      name: 'legacy-empty',
      defaultBranch: 'main',
      commitSha: shaLegacyEmpty,
      sizeKb: 10,
      fileCount: 0,
      initialStatus: 'ready',
      now: t0,
    });
    const replacedEmpty = await repoA.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/rec-c/legacy-empty',
      owner: 'rec-c',
      name: 'legacy-empty',
      defaultBranch: 'main',
      commitSha: shaLegacyEmpty,
      sizeKb: 10,
      now: t1,
    });
    expect(replacedEmpty.created).toBe(true);
    expect(replacedEmpty.supersededRepoId).toBe(legacyEmpty.repository.id);
    expect(isPersistedReadyRepository(replacedEmpty.repository)).toBe(true);
    const oldEmptyState = await repoA.findJobWithRepository(legacyEmpty.job.id);
    expect(oldEmptyState?.repository.status).toBe('superseded');
    expect(oldEmptyState?.repository.graphPersistedAt).toBeNull();

    // 3. Legacy-ready SAMPLE repository recovery preserves isSample = true and expiresAt = null
    const shaSample = '3636363636363636363636363636363636363636';
    const legacySample = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-c/sample-repo',
      owner: 'rec-c',
      name: 'sample-repo',
      defaultBranch: 'main',
      commitSha: shaSample,
      sizeKb: 500,
      fileCount: 50,
      isSample: true,
      initialStatus: 'ready',
      now: t0,
    });
    expect(legacySample.repository.isSample).toBe(true);
    expect(legacySample.repository.expiresAt).toBeNull();

    // Even when a public caller passes isSample: false, sample identity & expiry exemption are preserved
    const recoveredSample = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-c/sample-repo',
      owner: 'rec-c',
      name: 'sample-repo',
      defaultBranch: 'main',
      commitSha: shaSample,
      sizeKb: 500,
      fileCount: 50,
      isSample: false,
      now: t1,
    });
    expect(recoveredSample.created).toBe(true);
    expect(recoveredSample.supersededRepoId).toBe(legacySample.repository.id);
    expect(recoveredSample.repository.isSample).toBe(true);
    expect(recoveredSample.repository.expiresAt).toBeNull();
    expect(recoveredSample.repository.status).toBe('queued');
  });

  it('protects active and sample repos from expiration, cascades terminal deletes (jobs/nodes/edges), and handles expiry-extension concurrency', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const tOld = new Date('2026-11-01T00:00:00.000Z');
    const tExpiredNow = new Date('2026-11-20T00:00:00.000Z');
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);

    // 1. Active (cloning) repo whose expiresAt is in the past -> MUST NOT be deleted
    const activeExpired = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-d/active-expired',
      owner: 'rec-d',
      name: 'active-expired',
      defaultBranch: 'main',
      commitSha: '4141414141414141414141414141414141414141',
      sizeKb: 10,
      ttlDays: 1,
      now: tOld,
    });
    await repoA.claimIngestionAttempt({
      repoId: activeExpired.repository.id,
      jobId: activeExpired.job.id,
      bullmqJobId: activeExpired.job.id,
      commitSha: '4141414141414141414141414141414141414141',
      attemptGeneration: 1,
      now: tOld,
    });

    // 2. Sample persisted-ready repo -> MUST NOT be deleted
    const sampleReady = await repoA.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/rec-d/sample-ready',
      owner: 'rec-d',
      name: 'sample-ready',
      defaultBranch: 'main',
      commitSha: '4242424242424242424242424242424242424242',
      sizeKb: 10,
      isSample: true,
      now: tOld,
    });

    // 3. Expired terminal repo with parent-child nodes & edges -> MUST cascade delete cleanly
    const terminalWithGraph = await repoA.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/rec-d/terminal-graph',
      owner: 'rec-d',
      name: 'terminal-graph',
      defaultBranch: 'main',
      commitSha: '4343434343434343434343434343434343434343',
      sizeKb: 10,
      ttlDays: 1,
      now: tOld,
    });
    const [folderNode] = await clientA.db
      .insert(nodes)
      .values({
        repoId: terminalWithGraph.repository.id,
        nodeType: 'folder',
        name: 'src',
        qualifiedName: 'folder:src',
        filePath: 'src',
      })
      .returning();
    if (folderNode === undefined) {
      throw new Error('Expected inserted folder node');
    }
    const [fileA] = await clientA.db
      .insert(nodes)
      .values({
        repoId: terminalWithGraph.repository.id,
        nodeType: 'file',
        name: 'a.ts',
        qualifiedName: 'file:src/a.ts',
        filePath: 'src/a.ts',
        parentNodeId: folderNode.id,
        startLine: 1,
        endLine: 3,
        contentHash: hashA,
        snippet: 'export const a = 1;',
      })
      .returning();
    const [fileB] = await clientA.db
      .insert(nodes)
      .values({
        repoId: terminalWithGraph.repository.id,
        nodeType: 'file',
        name: 'b.ts',
        qualifiedName: 'file:src/b.ts',
        filePath: 'src/b.ts',
        parentNodeId: folderNode.id,
        startLine: 1,
        endLine: 3,
        contentHash: hashB,
        snippet: 'export const b = 2;',
      })
      .returning();
    if (fileA === undefined || fileB === undefined) {
      throw new Error('Expected inserted file nodes');
    }
    await clientA.db.insert(edges).values({
      repoId: terminalWithGraph.repository.id,
      sourceNodeId: fileA.id,
      targetNodeId: fileB.id,
      edgeType: 'IMPORTS',
    });

    // 4. Two expired persisted-ready repos for real lock concurrency tests
    const contendedExtend = await repoA.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/rec-d/contended-extend',
      owner: 'rec-d',
      name: 'contended-extend',
      defaultBranch: 'main',
      commitSha: '4444444444444444444444444444444444444444',
      sizeKb: 10,
      ttlDays: 1,
      now: tOld,
    });
    const contendedDelete = await repoA.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/rec-d/contended-delete',
      owner: 'rec-d',
      name: 'contended-delete',
      defaultBranch: 'main',
      commitSha: '4545454545454545454545454545454545454545',
      sizeKb: 10,
      ttlDays: 1,
      now: tOld,
    });

    // Concurrency A: lock held on contendedExtend -> deleteExpiredRepositories skips it via SKIP LOCKED
    // while deleting terminalWithGraph (and cascading its jobs, parent-child nodes, and edges).
    let lockClientA: PoolClient | undefined;
    let deletePromiseA: ReturnType<IngestionRepository['deleteExpiredRepositories']> | undefined;
    try {
      lockClientA = await clientA.pool.connect();
      await lockClientA.query('BEGIN');
      await lockClientA.query(
        'SELECT id FROM repositories WHERE id IN ($1, $2) ORDER BY id ASC FOR UPDATE',
        [contendedExtend.repository.id, contendedDelete.repository.id],
      );

      deletePromiseA = repoB.deleteExpiredRepositories(tExpiredNow);
      const deleted1 = await withTimeout(deletePromiseA, 5_000, 'SKIP LOCKED expiration delete');
      expect(deleted1).toContain(terminalWithGraph.repository.id);
      expect(deleted1).not.toContain(activeExpired.repository.id);
      expect(deleted1).not.toContain(sampleReady.repository.id);
      expect(deleted1).not.toContain(contendedExtend.repository.id);
      expect(deleted1).not.toContain(contendedDelete.repository.id);

      await lockClientA.query('ROLLBACK');
      lockClientA.release();
      lockClientA = undefined;
    } finally {
      await safeRollbackAndRelease(lockClientA);
      if (deletePromiseA !== undefined) {
        await Promise.allSettled([deletePromiseA]);
      }
    }

    // Verify cascade removed jobs, nodes, and edges for terminalWithGraph
    expect(
      await clientA.db
        .select()
        .from(nodes)
        .where(eq(nodes.repoId, terminalWithGraph.repository.id)),
    ).toEqual([]);
    expect(
      await clientA.db
        .select()
        .from(edges)
        .where(eq(edges.repoId, terminalWithGraph.repository.id)),
    ).toEqual([]);
    expect(await repoA.findJobWithRepository(terminalWithGraph.job.id)).toBeNull();
    expect(await repoA.findJobWithRepository(activeExpired.job.id)).not.toBeNull();
    expect(await repoA.findJobWithRepository(sampleReady.job.id)).not.toBeNull();

    // Extending expiry on contendedExtend protects it from subsequent expiration deletion
    const bumped = await repoA.bumpRepositoryExpiry(contendedExtend.repository.id, {
      ttlDays: 7,
      now: tExpiredNow,
    });
    expect(bumped).not.toBeNull();

    // Concurrency B: deletion holds FOR UPDATE lock on contendedDelete while bumpRepositoryExpiry waits;
    // once deletion commits, bumpRepositoryExpiry wakes up and returns null cleanly.
    let lockClientB: PoolClient | undefined;
    let waitingBump:
      Promise<Awaited<ReturnType<IngestionRepository['bumpRepositoryExpiry']>>> | undefined;
    try {
      lockClientB = await clientA.pool.connect();
      await lockClientB.query('BEGIN');
      await lockClientB.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        contendedDelete.repository.id,
      ]);

      waitingBump = repoB.bumpRepositoryExpiry(contendedDelete.repository.id, {
        ttlDays: 7,
        now: tExpiredNow,
      });
      await waitForLockWaiters(clientA.pool, 1);

      await lockClientB.query('DELETE FROM repositories WHERE id = $1', [
        contendedDelete.repository.id,
      ]);
      await lockClientB.query('COMMIT');
      lockClientB.release();
      lockClientB = undefined;

      const bumpOutcome = await withTimeout(
        waitingBump,
        5_000,
        'bumpRepositoryExpiry after concurrent delete',
      );
      expect(bumpOutcome).toBeNull();
    } finally {
      await safeRollbackAndRelease(lockClientB);
      if (waitingBump !== undefined) {
        await Promise.allSettled([waitingBump]);
      }
    }

    // Subsequent expiration pass leaves active, sample, and expiry-extended repos intact
    const deleted2 = await repoA.deleteExpiredRepositories(tExpiredNow);
    expect(deleted2).not.toContain(activeExpired.repository.id);
    expect(deleted2).not.toContain(sampleReady.repository.id);
    expect(deleted2).not.toContain(contendedExtend.repository.id);
  });

  it('preserves isSample and null expiresAt across public retries after a recovered sample repository fails', async () => {
    const shaSample = '5656565656565656565656565656565656565656';
    const shaOther = '5757575757575757575757575757575757575757';
    const t0 = new Date('2026-11-27T11:00:00.000Z');
    const t1 = new Date('2026-11-27T11:01:00.000Z');
    const t2 = new Date('2026-11-27T11:02:00.000Z');
    const t3 = new Date('2026-11-27T11:03:00.000Z');
    const t4 = new Date('2026-11-27T11:04:00.000Z');
    const t5 = new Date('2026-11-27T11:05:00.000Z');
    const tFarFuture = new Date('2027-06-01T00:00:00.000Z');

    // 1. Seed legacy-ready sample repo and recover it via a public request (isSample: false)
    const legacySample = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-s/failed-sample',
      owner: 'rec-s',
      name: 'failed-sample',
      defaultBranch: 'main',
      commitSha: shaSample,
      sizeKb: 250,
      fileCount: 30,
      isSample: true,
      initialStatus: 'ready',
      now: t0,
    });
    const firstRecovery = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-s/failed-sample',
      owner: 'rec-s',
      name: 'failed-sample',
      defaultBranch: 'main',
      commitSha: shaSample,
      sizeKb: 250,
      fileCount: 30,
      isSample: false,
      now: t1,
    });
    expect(firstRecovery.created).toBe(true);
    expect(firstRecovery.supersededRepoId).toBe(legacySample.repository.id);
    expect(firstRecovery.repository.isSample).toBe(true);
    expect(firstRecovery.repository.expiresAt).toBeNull();

    // 2. First recovery fails on enqueue -> only historical ('superseded' + 'failed') sample rows remain
    const failedEnqueue = await repoA.failQueuedJobOnEnqueueError({
      repoId: firstRecovery.repository.id,
      jobId: firstRecovery.job.id,
      now: t2,
    });
    expect(failedEnqueue.outcome).toBe('failed');
    expect(await repoA.findActiveByOwnerNameSha('rec-s', 'failed-sample', shaSample)).toBeNull();

    // 3. Concurrent public retries (isSample: false) must deduplicate AND preserve isSample=true, expiresAt=null
    const [retryA, retryB] = await Promise.all([
      repoA.createOrGetActive({
        githubUrl: 'https://github.com/rec-s/failed-sample',
        owner: 'rec-s',
        name: 'failed-sample',
        defaultBranch: 'main',
        commitSha: shaSample,
        sizeKb: 250,
        fileCount: 30,
        isSample: false,
        now: t3,
      }),
      repoB.createOrGetActive({
        githubUrl: 'https://github.com/rec-s/failed-sample',
        owner: 'rec-s',
        name: 'failed-sample',
        defaultBranch: 'main',
        commitSha: shaSample,
        sizeKb: 250,
        fileCount: 30,
        isSample: false,
        now: t3,
      }),
    ]);

    expect([retryA.created, retryB.created].sort()).toEqual([false, true]);
    expect(retryA.repository.id).toBe(retryB.repository.id);
    expect(retryA.job.id).toBe(retryB.job.id);
    expect(retryA.repository.id).not.toBe(firstRecovery.repository.id);
    expect(retryA.repository.id).not.toBe(legacySample.repository.id);
    expect(retryA.repository.status).toBe('queued');
    expect(retryA.repository.isSample).toBe(true);
    expect(retryA.repository.expiresAt).toBeNull();
    expect(retryB.repository.isSample).toBe(true);
    expect(retryB.repository.expiresAt).toBeNull();

    // 4. Verified-empty public retry after a subsequent worker failure also preserves sample identity
    const claimed = await repoA.claimIngestionAttempt({
      repoId: retryA.repository.id,
      jobId: retryA.job.id,
      bullmqJobId: retryA.job.id,
      commitSha: shaSample,
      attemptGeneration: 1,
      now: t4,
    });
    if (claimed.outcome !== 'claimed') {
      throw new Error('Expected retry claim to succeed');
    }
    const workerFailed = await repoA.transitionJobStage(claimed.ownership, {
      toStatus: 'failed',
      progressPct: 20,
      errorCode: 'WORKER_ERROR',
      errorMessage: 'Simulated worker failure',
      errorDetail: 'WORKER_ERROR',
      now: t4,
    });
    expect(workerFailed.applied).toBe(true);

    const emptyRetry = await repoB.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/rec-s/failed-sample',
      owner: 'rec-s',
      name: 'failed-sample',
      defaultBranch: 'main',
      commitSha: shaSample,
      sizeKb: 250,
      isSample: false,
      now: t5,
    });
    expect(emptyRetry.created).toBe(true);
    expect(emptyRetry.repository.isSample).toBe(true);
    expect(emptyRetry.repository.expiresAt).toBeNull();
    expect(isPersistedReadyRepository(emptyRetry.repository)).toBe(true);

    // 5. Different commitSha for the same owner/name does NOT falsely inherit isSample
    const otherShaRepo = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/rec-s/failed-sample',
      owner: 'rec-s',
      name: 'failed-sample',
      defaultBranch: 'main',
      commitSha: shaOther,
      sizeKb: 250,
      fileCount: 30,
      isSample: false,
      now: t5,
    });
    expect(otherShaRepo.repository.isSample).toBe(false);
    expect(otherShaRepo.repository.expiresAt).not.toBeNull();

    // 6. Far-future expiration sweep never deletes any retained or retried sample rows
    const deleted = await repoA.deleteExpiredRepositories(tFarFuture);
    expect(deleted).not.toContain(legacySample.repository.id);
    expect(deleted).not.toContain(firstRecovery.repository.id);
    expect(deleted).not.toContain(retryA.repository.id);
    expect(deleted).not.toContain(emptyRetry.repository.id);
  });
});
