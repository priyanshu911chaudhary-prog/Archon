import { randomBytes } from 'node:crypto';
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
import {
  GraphPersistenceValidationError,
  GraphPublicationAbortedError,
} from './graph-persistence.js';
import { runMigrations } from './migrate.js';
import { createIngestionRepository, type IngestionRepository } from './repository.js';
import { edges, ingestionJobs, isEmptyJsTsRepository, nodes, repositories } from './schema.js';

const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const HASH_3 = '3'.repeat(64);

function makeSampleGraph(snippetWithLoneSurrogate = false): AnalysisOutput {
  return {
    nodes: [
      {
        nodeType: 'function',
        name: 'run',
        qualifiedName: 'src/index.ts::fn:run',
        filePath: 'src/index.ts',
        parentQualifiedName: 'file:src/index.ts',
        isExported: true,
        startLine: 2,
        endLine: 4,
        contentHash: HASH_3,
        snippet: snippetWithLoneSurrogate
          ? 'export function run() { return "\uD800"; }'
          : 'export function run() { return helper(); }',
      },
      {
        nodeType: 'function',
        name: 'helper',
        qualifiedName: 'src/helper.ts::fn:helper',
        filePath: 'src/helper.ts',
        parentQualifiedName: 'file:src/helper.ts',
        isExported: true,
        startLine: 1,
        endLine: 3,
        contentHash: HASH_2,
        snippet: 'export function helper() { return 42; }',
      },
      {
        nodeType: 'file',
        name: 'index.ts',
        qualifiedName: 'file:src/index.ts',
        filePath: 'src/index.ts',
        parentQualifiedName: 'folder:src',
        isExported: false,
        startLine: 1,
        endLine: 4,
        contentHash: HASH_1,
        snippet:
          "import { helper } from './helper.js';\nexport function run() { return helper(); }",
      },
      {
        nodeType: 'file',
        name: 'helper.ts',
        qualifiedName: 'file:src/helper.ts',
        filePath: 'src/helper.ts',
        parentQualifiedName: 'folder:src',
        isExported: false,
        startLine: 1,
        endLine: 3,
        contentHash: HASH_2,
        snippet: 'export function helper() { return 42; }',
      },
      {
        nodeType: 'folder',
        name: 'src',
        qualifiedName: 'folder:src',
        filePath: 'src',
        parentQualifiedName: null,
        isExported: false,
        startLine: null,
        endLine: null,
        contentHash: null,
        snippet: null,
      },
    ],
    edges: [
      {
        sourceQualifiedName: 'file:src/index.ts',
        targetQualifiedName: 'file:src/helper.ts',
        edgeType: 'IMPORTS',
        callSiteLine: null,
        callSiteSnippet: null,
      },
      {
        sourceQualifiedName: 'src/index.ts::fn:run',
        targetQualifiedName: 'src/helper.ts::fn:helper',
        edgeType: 'CALLS',
        callSiteLine: 3,
        callSiteSnippet: 'helper()',
      },
    ],
    warnings: [],
    stats: {
      discoveredFilesCount: 2,
      parsedFilesCount: 2,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 0,
      folderNodeCount: 1,
      fileNodeCount: 2,
      functionNodeCount: 2,
      classNodeCount: 0,
      symbolNodeCount: 0,
      importsEdgeCount: 1,
      callsEdgeCount: 1,
      totalBytesRead: 120,
      truncatedWarningsCount: 0,
    },
  };
}

function makeEmptyGraph(): AnalysisOutput {
  return {
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
  throw new Error(`Timed out waiting for ${String(expectedCount)} lock waiter(s).`);
}

async function safeRollbackAndRelease(pgClient: PoolClient | undefined): Promise<void> {
  if (pgClient === undefined) {
    return;
  }
  try {
    await pgClient.query('ROLLBACK');
  } catch {
    // Ignore rollback error if already settled
  } finally {
    pgClient.release();
  }
}

describe('Atomic graph publication (PostgreSQL integration)', () => {
  const testDbName = `archon_graph_test_${randomBytes(6).toString('hex')}`;
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

  it('publishes multi-batch parent-before-child nodes & edges, normalizes snippet surrogates, enforces building_graph stage & progress=100, and updates fileCount consistently', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const sha = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
    const t0 = new Date('2026-11-27T14:00:00.000Z');
    const t1 = new Date('2026-11-27T14:00:05.000Z');
    const t2 = new Date('2026-11-27T14:00:12.000Z');

    const created = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/gp-a/multi-batch',
      owner: 'gp-a',
      name: 'multi-batch',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 10,
      now: t0,
    });
    const claimed = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha,
      attemptGeneration: 1,
      now: t1,
    });
    if (claimed.outcome !== 'claimed') {
      throw new Error('Expected claim');
    }

    // Publishing directly from 'cloning' (before 'building_graph') MUST be rejected without mutating DB
    await expect(
      repoA.publishRepositoryGraph(claimed.ownership, { output: makeSampleGraph() }),
    ).rejects.toBeInstanceOf(DbError);
    expect(
      await clientA.db.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
    ).toEqual([]);

    await repoA.transitionJobStage(claimed.ownership, {
      toStatus: 'building_graph',
      progressPct: 85,
      now: t1,
    });

    // Force multiple node & edge batches across parent-child boundaries + snippet lone surrogate normalization
    const published = await repoA.publishRepositoryGraph(claimed.ownership, {
      output: makeSampleGraph(true),
      batchOptions: { maxNodesPerBatch: 2, maxEdgesPerBatch: 1 },
      now: t2,
    });
    expect(published.outcome).toBe('published');
    if (published.outcome !== 'published') {
      throw new Error('Expected published outcome');
    }
    expect(published.persistedNodeCount).toBe(5);
    expect(published.persistedEdgeCount).toBe(2);
    expect(published.nodeBatches).toBe(3);
    expect(published.edgeBatches).toBe(2);
    expect(published.repository.status).toBe('ready');
    expect(published.repository.graphPersistedAt?.getTime()).toBe(t2.getTime());
    expect(published.repository.fileCount).toBe(2);
    expect(isEmptyJsTsRepository(published.repository)).toBe(false);
    expect(published.job.stage).toBe('ready');
    expect(published.job.progressPct).toBe(100);
    expect(published.job.durationMs).toBe(7000);

    const persistedNodes = await clientA.db
      .select()
      .from(nodes)
      .where(eq(nodes.repoId, created.repository.id));
    const persistedEdges = await clientA.db
      .select()
      .from(edges)
      .where(eq(edges.repoId, created.repository.id));
    expect(persistedNodes).toHaveLength(5);
    expect(persistedEdges).toHaveLength(2);

    const nodeByQn = new Map(persistedNodes.map((n) => [n.qualifiedName, n]));
    const folderRow = nodeByQn.get('folder:src');
    const indexRow = nodeByQn.get('file:src/index.ts');
    const helperRow = nodeByQn.get('file:src/helper.ts');
    const runRow = nodeByQn.get('src/index.ts::fn:run');
    const helperFnRow = nodeByQn.get('src/helper.ts::fn:helper');
    expect(indexRow?.parentNodeId).toBe(folderRow?.id);
    expect(runRow?.parentNodeId).toBe(indexRow?.id);
    expect(runRow?.snippet).toBe('export function run() { return "\uFFFD"; }');

    const importsRow = persistedEdges.find((e) => e.edgeType === 'IMPORTS');
    const callsRow = persistedEdges.find((e) => e.edgeType === 'CALLS');
    expect(importsRow?.sourceNodeId).toBe(indexRow?.id);
    expect(importsRow?.targetNodeId).toBe(helperRow?.id);
    expect(callsRow?.sourceNodeId).toBe(runRow?.id);
    expect(callsRow?.targetNodeId).toBe(helperFnRow?.id);
    expect(callsRow?.callSiteLine).toBe(3);

    // Empty AnalysisOutput publishes cleanly with 0 nodes/edges and graphPersistedAt set
    const shaEmpty = 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
    const emptyCreated = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/gp-a/empty-pub',
      owner: 'gp-a',
      name: 'empty-pub',
      defaultBranch: 'main',
      commitSha: shaEmpty,
      sizeKb: 10,
      now: t0,
    });
    const emptyClaim = await repoA.claimIngestionAttempt({
      repoId: emptyCreated.repository.id,
      jobId: emptyCreated.job.id,
      bullmqJobId: emptyCreated.job.id,
      commitSha: shaEmpty,
      attemptGeneration: 1,
      now: t1,
    });
    if (emptyClaim.outcome !== 'claimed') {
      throw new Error('Expected empty claim');
    }
    await repoA.transitionJobStage(emptyClaim.ownership, {
      toStatus: 'building_graph',
      progressPct: 85,
      now: t1,
    });
    const emptyPub = await repoA.publishRepositoryGraph(emptyClaim.ownership, {
      output: makeEmptyGraph(),
      now: t2,
    });
    expect(emptyPub.outcome).toBe('published');
    if (emptyPub.outcome === 'published') {
      expect(emptyPub.persistedNodeCount).toBe(0);
      expect(emptyPub.persistedEdgeCount).toBe(0);
      expect(emptyPub.repository.graphPersistedAt?.getTime()).toBe(t2.getTime());
      expect(isEmptyJsTsRepository(emptyPub.repository)).toBe(true);
    }
  });

  it('rolls back completely on mid-transaction DB error or AbortSignal cancellation, then succeeds on retry', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const sha = 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
    const t0 = new Date('2026-11-27T15:00:00.000Z');
    const created = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/gp-b/rollback-test',
      owner: 'gp-b',
      name: 'rollback-test',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 10,
      now: t0,
    });
    const claimed = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha,
      attemptGeneration: 1,
      now: t0,
    });
    if (claimed.outcome !== 'claimed') {
      throw new Error('Expected claim');
    }
    await repoA.transitionJobStage(claimed.ownership, {
      toStatus: 'building_graph',
      progressPct: 85,
      now: t0,
    });

    // 1. Pre-aborted signal rejects before SQL mutation
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      repoA.publishRepositoryGraph(claimed.ownership, {
        output: makeSampleGraph(),
        signal: preAborted.signal,
      }),
    ).rejects.toBeInstanceOf(GraphPublicationAbortedError);

    // 2. Signal aborted while waiting on row lock rolls back immediately once lock is released
    const midAbort = new AbortController();
    let lockHolder: PoolClient | undefined;
    let abortedPubPromise: ReturnType<IngestionRepository['publishRepositoryGraph']> | undefined;
    try {
      lockHolder = await clientA.pool.connect();
      await lockHolder.query('BEGIN');
      await lockHolder.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        created.repository.id,
      ]);

      abortedPubPromise = repoB.publishRepositoryGraph(claimed.ownership, {
        output: makeSampleGraph(),
        batchOptions: { maxNodesPerBatch: 2, maxEdgesPerBatch: 1 },
        signal: midAbort.signal,
      });
      await waitForLockWaiters(clientA.pool, 1);

      midAbort.abort();
      await lockHolder.query('ROLLBACK');
      lockHolder.release();
      lockHolder = undefined;

      await expect(abortedPubPromise).rejects.toBeInstanceOf(GraphPublicationAbortedError);
      expect(
        await clientA.db.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
      ).toEqual([]);
    } finally {
      await safeRollbackAndRelease(lockHolder);
      if (abortedPubPromise !== undefined) {
        await Promise.allSettled([abortedPubPromise]);
      }
    }

    // 3. Mid-transaction DB failure after 3 node batches rolls back completely
    await clientA.pool.query(`
      CREATE OR REPLACE FUNCTION fail_edge_insert_once() RETURNS trigger AS $$
      BEGIN
        IF NEW.repo_id = '${created.repository.id}'::uuid THEN
          RAISE EXCEPTION 'Simulated mid-publish edge failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_edge_insert_once
      BEFORE INSERT ON edges
      FOR EACH ROW EXECUTE FUNCTION fail_edge_insert_once();
    `);

    try {
      await expect(
        repoA.publishRepositoryGraph(claimed.ownership, {
          output: makeSampleGraph(),
          batchOptions: { maxNodesPerBatch: 2, maxEdgesPerBatch: 1 },
        }),
      ).rejects.toThrow();

      expect(
        await clientA.db.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
      ).toEqual([]);
      expect(
        await clientA.db.select().from(edges).where(eq(edges.repoId, created.repository.id)),
      ).toEqual([]);
      const midLoaded = await repoA.findJobWithRepository(created.job.id);
      expect(midLoaded?.repository.status).toBe('building_graph');
      expect(midLoaded?.repository.graphPersistedAt).toBeNull();
    } finally {
      await clientA.pool.query(`
        DROP TRIGGER IF EXISTS trg_fail_edge_insert_once ON edges;
        DROP FUNCTION IF EXISTS fail_edge_insert_once();
      `);
    }

    // 4. Retry succeeds cleanly after transient DB fault clears
    const retryPub = await repoA.publishRepositoryGraph(claimed.ownership, {
      output: makeSampleGraph(),
    });
    expect(retryPub.outcome).toBe('published');
    expect(
      await clientA.db.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
    ).toHaveLength(5);
  });

  it('rejects stale ownership and invalid graphs before mutating DB, and requires exact BullMQ identity during locked reconciliation', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const sha = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
    const created = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/gp-c/stale-and-reconcile',
      owner: 'gp-c',
      name: 'stale-and-reconcile',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 10,
    });
    const claim1 = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha,
      attemptGeneration: 1,
    });
    if (claim1.outcome !== 'claimed') {
      throw new Error('Expected claim 1');
    }
    await repoA.transitionJobStage(claim1.ownership, {
      toStatus: 'building_graph',
      progressPct: 85,
    });

    // Invalid cyclic graph fails BEFORE opening SQL transaction
    const cyclicGraph: AnalysisOutput = {
      ...makeEmptyGraph(),
      nodes: [
        {
          nodeType: 'folder',
          name: 'a',
          qualifiedName: 'folder:a',
          filePath: 'a',
          parentQualifiedName: 'folder:b',
          isExported: false,
          startLine: null,
          endLine: null,
          contentHash: null,
          snippet: null,
        },
        {
          nodeType: 'folder',
          name: 'b',
          qualifiedName: 'folder:b',
          filePath: 'b',
          parentQualifiedName: 'folder:a',
          isExported: false,
          startLine: null,
          endLine: null,
          contentHash: null,
          snippet: null,
        },
      ],
    };
    await expect(
      repoA.publishRepositoryGraph(claim1.ownership, { output: cyclicGraph }),
    ).rejects.toBeInstanceOf(GraphPersistenceValidationError);

    expect((await repoA.reconcilePublishedAttempt(claim1.ownership)).outcome).toBe(
      'still_owned_unpublished',
    );

    // Generation 2 takes over -> stale generation 1 cannot publish any nodes/edges
    const claim2 = await repoB.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha,
      attemptGeneration: 2,
    });
    if (claim2.outcome !== 'claimed') {
      throw new Error('Expected claim 2');
    }

    const stalePub = await repoA.publishRepositoryGraph(claim1.ownership, {
      output: makeSampleGraph(),
    });
    expect(stalePub).toEqual({
      outcome: 'ownership_lost',
      applied: false,
      storedGeneration: 2,
      expectedGeneration: 1,
    });
    expect(
      await clientA.db.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
    ).toEqual([]);

    // Real row-lock serialization: reconcilePublishedAttempt waits on FOR UPDATE while publication commits
    let txClient: PoolClient | undefined;
    let reconcilePromise: ReturnType<IngestionRepository['reconcilePublishedAttempt']> | undefined;
    try {
      txClient = await clientA.pool.connect();
      await txClient.query('BEGIN');
      await txClient.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        created.repository.id,
      ]);

      reconcilePromise = repoB.reconcilePublishedAttempt(claim2.ownership);
      await waitForLockWaiters(clientA.pool, 1);

      const nowIso = new Date('2026-11-27T16:00:00.000Z').toISOString();
      await txClient.query(
        `UPDATE repositories SET status = 'ready', graph_persisted_at = $2, updated_at = $2 WHERE id = $1`,
        [created.repository.id, nowIso],
      );
      await txClient.query(
        `UPDATE ingestion_jobs SET stage = 'ready', progress_pct = 100, finished_at = $2 WHERE id = $1`,
        [created.job.id, nowIso],
      );
      await txClient.query('COMMIT');
      txClient.release();
      txClient = undefined;

      const reconciled = await reconcilePromise;
      expect(reconciled.outcome).toBe('published_by_owner');
      const repoRow = await clientA.db
        .select()
        .from(repositories)
        .where(eq(repositories.id, created.repository.id));
      expect(repoRow[0]?.graphPersistedAt).not.toBeNull();
    } finally {
      await safeRollbackAndRelease(txClient);
      if (reconcilePromise !== undefined) {
        await Promise.allSettled([reconcilePromise]);
      }
    }

    // Stale generation 1 reconciling after gen 2 published sees terminal, never published_by_owner
    expect(await repoA.reconcilePublishedAttempt(claim1.ownership)).toEqual({
      outcome: 'terminal',
      status: 'ready',
    });

    // Exact stored BullMQ identity required during reconciliation even when ready + graphPersistedAt set
    await clientA.db
      .update(ingestionJobs)
      .set({ bullmqJobId: null })
      .where(eq(ingestionJobs.id, created.job.id));
    expect(await repoB.reconcilePublishedAttempt(claim2.ownership)).toEqual({
      outcome: 'identity_mismatch',
      reason: 'missing_stored_bullmq_job_id',
    });

    await clientA.db
      .update(ingestionJobs)
      .set({ bullmqJobId: 'corrupted-foreign-id' })
      .where(eq(ingestionJobs.id, created.job.id));
    expect(await repoB.reconcilePublishedAttempt(claim2.ownership)).toEqual({
      outcome: 'identity_mismatch',
      reason: 'stored_bullmq_job_id_mismatch',
    });
  });
});
