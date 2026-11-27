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
import { DbError, classifyDbError } from './errors.js';
import {
  GraphPersistenceValidationError,
  GraphPublicationAbortedError,
  type PublicationExtractionStats,
} from './graph-persistence.js';
import { runMigrations } from './migrate.js';
import { createIngestionRepository, type IngestionRepository } from './repository.js';
import { edges, ingestionJobs, isEmptyJsTsRepository, nodes, repositories } from './schema.js';

const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const HASH_3 = '3'.repeat(64);
const HASH_4 = '4'.repeat(64);
const HASH_5 = '5'.repeat(64);

const SAMPLE_GRAPH_EXTRACTION_STATS: PublicationExtractionStats = {
  supportedFilesCount: 2,
  skippedFilesCount: 0,
  oversizedSupportedFilesCount: 0,
  oversizedSkippedFilesCount: 0,
};

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

/**
 * Full-parity graph covering all 5 node types (`folder`, `file`, `function`, `class`, `symbol`),
 * nested folder hierarchy, `IMPORTS`, multi-line `CALLS`, and legitimate recursive `CALLS`.
 */
function makeFullParityGraph(): AnalysisOutput {
  return {
    nodes: [
      {
        nodeType: 'symbol',
        name: 'DEFAULT_MODE',
        qualifiedName: 'src/core/service.ts::sym:DEFAULT_MODE',
        filePath: 'src/core/service.ts',
        parentQualifiedName: 'file:src/core/service.ts',
        isExported: true,
        startLine: 1,
        endLine: 1,
        contentHash: HASH_5,
        snippet: "export const DEFAULT_MODE = 'fast';",
      },
      {
        nodeType: 'class',
        name: 'Engine',
        qualifiedName: 'src/core/service.ts::class:Engine',
        filePath: 'src/core/service.ts',
        parentQualifiedName: 'file:src/core/service.ts',
        isExported: true,
        startLine: 3,
        endLine: 9,
        contentHash: HASH_4,
        snippet:
          'export class Engine { tick(n: number): number { return n > 0 ? this.tick(n - 1) : 0; } }',
      },
      {
        nodeType: 'function',
        name: 'boot',
        qualifiedName: 'src/index.ts::fn:boot',
        filePath: 'src/index.ts',
        parentQualifiedName: 'file:src/index.ts',
        isExported: false,
        startLine: 2,
        endLine: 6,
        contentHash: HASH_3,
        snippet: 'function boot() { const e = new Engine(); e.tick(1); return e.tick(2); }',
      },
      {
        nodeType: 'file',
        name: 'service.ts',
        qualifiedName: 'file:src/core/service.ts',
        filePath: 'src/core/service.ts',
        parentQualifiedName: 'folder:src/core',
        isExported: false,
        startLine: 1,
        endLine: 9,
        contentHash: HASH_2,
        snippet: "export const DEFAULT_MODE = 'fast';\nexport class Engine {}",
      },
      {
        nodeType: 'file',
        name: 'index.ts',
        qualifiedName: 'file:src/index.ts',
        filePath: 'src/index.ts',
        parentQualifiedName: 'folder:src',
        isExported: false,
        startLine: 1,
        endLine: 6,
        contentHash: HASH_1,
        snippet: "import { Engine } from './core/service.js';\nfunction boot() {}",
      },
      {
        nodeType: 'folder',
        name: 'core',
        qualifiedName: 'folder:src/core',
        filePath: 'src/core',
        parentQualifiedName: 'folder:src',
        isExported: false,
        startLine: null,
        endLine: null,
        contentHash: null,
        snippet: null,
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
        targetQualifiedName: 'file:src/core/service.ts',
        edgeType: 'IMPORTS',
        callSiteLine: null,
        callSiteSnippet: null,
      },
      {
        sourceQualifiedName: 'src/index.ts::fn:boot',
        targetQualifiedName: 'src/core/service.ts::class:Engine',
        edgeType: 'CALLS',
        callSiteLine: 4,
        callSiteSnippet: 'e.tick(1)',
      },
      {
        sourceQualifiedName: 'src/index.ts::fn:boot',
        targetQualifiedName: 'src/core/service.ts::class:Engine',
        edgeType: 'CALLS',
        callSiteLine: 5,
        callSiteSnippet: 'e.tick(2)',
      },
      {
        sourceQualifiedName: 'src/core/service.ts::class:Engine',
        targetQualifiedName: 'src/core/service.ts::class:Engine',
        edgeType: 'CALLS',
        callSiteLine: 6,
        callSiteSnippet: 'this.tick(n - 1)',
      },
    ],
    warnings: [],
    stats: {
      discoveredFilesCount: 3,
      parsedFilesCount: 2,
      skippedSyntaxErrorFilesCount: 1,
      skippedOversizedFilesCount: 0,
      configFilesCount: 1,
      folderNodeCount: 2,
      fileNodeCount: 2,
      functionNodeCount: 1,
      classNodeCount: 1,
      symbolNodeCount: 1,
      importsEdgeCount: 1,
      callsEdgeCount: 3,
      totalBytesRead: 320,
      truncatedWarningsCount: 0,
    },
  };
}

function makeEmptyGraph(statsOverrides: Partial<AnalysisOutput['stats']> = {}): AnalysisOutput {
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
      ...statsOverrides,
    },
  };
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
  options: { readonly waitEvent?: string; readonly timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res =
      options.waitEvent !== undefined
        ? await pool.query<{ waiting: number }>(
            `SELECT COUNT(*)::int AS waiting
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND wait_event_type = 'Lock'
               AND wait_event = $1`,
            [options.waitEvent],
          )
        : await pool.query<{ waiting: number }>(
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
    `Timed out waiting for ${String(expectedCount)} lock waiter(s) (event=${options.waitEvent ?? 'any'}).`,
  );
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

  it('persists exact full-schema graph parity across all node/edge types, normalizes snippet surrogates, enforces building_graph & progress=100, and applies file/skip count invariants', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const sha = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
    const t0 = new Date('2026-11-27T14:00:00.000Z');
    const t1 = new Date('2026-11-27T14:00:05.000Z');
    const t2 = new Date('2026-11-27T14:00:12.000Z');

    const created = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/gp-a/full-parity',
      owner: 'gp-a',
      name: 'full-parity',
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

    // Publishing directly from 'cloning' MUST be rejected without mutating DB
    await expect(
      repoA.publishRepositoryGraph(claimed.ownership, {
        output: makeFullParityGraph(),
        extractionStats: {
          supportedFilesCount: 3,
          skippedFilesCount: 2,
          oversizedSupportedFilesCount: 0,
          oversizedSkippedFilesCount: 0,
        },
      }),
    ).rejects.toBeInstanceOf(DbError);
    expect(
      await clientA.db.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
    ).toEqual([]);

    // Simulate stale counts written by an earlier stage so extractionStats proves zero double-counting
    await repoA.transitionJobStage(claimed.ownership, {
      toStatus: 'parsing',
      progressPct: 60,
      fileCount: 99,
      skippedFilesCount: 99,
      now: t1,
    });
    await repoA.transitionJobStage(claimed.ownership, {
      toStatus: 'building_graph',
      progressPct: 85,
      now: t1,
    });

    const inputGraph = makeFullParityGraph();
    const published = await repoA.publishRepositoryGraph(claimed.ownership, {
      output: inputGraph,
      extractionStats: {
        supportedFilesCount: 3,
        skippedFilesCount: 2,
        oversizedSupportedFilesCount: 0,
        oversizedSkippedFilesCount: 0,
      },
      batchOptions: { maxNodesPerBatch: 2, maxEdgesPerBatch: 2 },
      now: t2,
    });
    expect(published.outcome).toBe('published');
    if (published.outcome !== 'published') {
      throw new Error('Expected published outcome');
    }
    expect(published.persistedNodeCount).toBe(7);
    expect(published.persistedEdgeCount).toBe(4);
    expect(published.nodeBatches).toBe(4);
    expect(published.edgeBatches).toBe(2);
    expect(published.repository.status).toBe('ready');
    expect(published.repository.graphPersistedAt?.getTime()).toBe(t2.getTime());
    // Exact extraction + parser counts (2 extraction skips + 1 parser syntax skip = 3; never 99 + 1)
    expect(published.repository.fileCount).toBe(3);
    expect(published.repository.skippedFilesCount).toBe(3);
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
    expect(persistedNodes).toHaveLength(inputGraph.nodes.length);
    expect(persistedEdges).toHaveLength(inputGraph.edges.length);

    // Exact field-by-field parity for every node & parent relationship
    const nodeByQn = new Map(persistedNodes.map((n) => [n.qualifiedName, n]));
    const qnById = new Map(persistedNodes.map((n) => [n.id, n.qualifiedName]));
    for (const expected of inputGraph.nodes) {
      const actual = nodeByQn.get(expected.qualifiedName);
      expect(actual).toBeDefined();
      expect(actual?.nodeType).toBe(expected.nodeType);
      expect(actual?.name).toBe(expected.name);
      expect(actual?.filePath).toBe(expected.filePath);
      expect(actual?.isExported).toBe(expected.isExported);
      expect(actual?.startLine).toBe(expected.startLine);
      expect(actual?.endLine).toBe(expected.endLine);
      expect(actual?.contentHash).toBe(expected.contentHash);
      expect(actual?.snippet).toBe(expected.snippet);
      const actualParentQn =
        actual?.parentNodeId !== null && actual?.parentNodeId !== undefined
          ? (qnById.get(actual.parentNodeId) ?? null)
          : null;
      expect(actualParentQn).toBe(expected.parentQualifiedName);
    }

    // Exact field-by-field parity for every edge, callSiteLine & callSiteSnippet
    const actualEdgesNormalized = persistedEdges
      .map((e) => ({
        sourceQualifiedName: qnById.get(e.sourceNodeId),
        targetQualifiedName: qnById.get(e.targetNodeId),
        edgeType: e.edgeType,
        callSiteLine: e.callSiteLine,
        callSiteSnippet: e.callSiteSnippet,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const expectedEdgesNormalized = [...inputGraph.edges].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
    expect(actualEdgesNormalized).toEqual(expectedEdgesNormalized);

    // Verify lone-surrogate normalization + genuinely-empty vs all-oversized vs all-syntax-invalid vs mixed-source
    const cases: readonly {
      readonly name: string;
      readonly sha: string;
      readonly output: AnalysisOutput;
      readonly extractionStats: PublicationExtractionStats;
      readonly expectedFileCount: number;
      readonly expectedSkipped: number;
      readonly expectedEmptyJsTs: boolean;
    }[] = [
      {
        name: 'surrogate-norm',
        sha: 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2',
        output: makeSampleGraph(true),
        extractionStats: {
          supportedFilesCount: 2,
          skippedFilesCount: 1,
          oversizedSupportedFilesCount: 0,
        },
        expectedFileCount: 2,
        expectedSkipped: 1,
        expectedEmptyJsTs: false,
      },
      {
        name: 'genuinely-empty-with-general-and-config-skips',
        sha: 'a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3',
        output: makeEmptyGraph(),
        extractionStats: {
          supportedFilesCount: 0,
          skippedFilesCount: 3, // README.md + main.py + oversized package.json
          oversizedSupportedFilesCount: 0,
          oversizedSkippedFilesCount: 1,
        },
        expectedFileCount: 0,
        expectedSkipped: 3,
        expectedEmptyJsTs: true,
      },
      {
        name: 'all-syntax-skipped',
        sha: 'a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4',
        output: makeEmptyGraph({ discoveredFilesCount: 2, skippedSyntaxErrorFilesCount: 2 }),
        extractionStats: {
          supportedFilesCount: 2,
          skippedFilesCount: 1,
          oversizedSupportedFilesCount: 0,
        },
        expectedFileCount: 2,
        expectedSkipped: 3,
        expectedEmptyJsTs: false,
      },
      {
        name: 'all-parser-oversized',
        sha: 'a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5',
        output: makeEmptyGraph({ skippedOversizedFilesCount: 2 }),
        extractionStats: {
          supportedFilesCount: 2,
          skippedFilesCount: 0,
          oversizedSupportedFilesCount: 0,
        },
        expectedFileCount: 2,
        expectedSkipped: 2,
        expectedEmptyJsTs: false,
      },
      {
        name: 'all-extractor-oversized',
        sha: 'a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6',
        output: makeEmptyGraph(),
        extractionStats: {
          supportedFilesCount: 0,
          skippedFilesCount: 3, // 2 oversized .ts + 1 README.md
          oversizedSupportedFilesCount: 2,
          oversizedSkippedFilesCount: 2,
        },
        expectedFileCount: 2,
        expectedSkipped: 3,
        expectedEmptyJsTs: false,
      },
      {
        name: 'mixed-source-with-oversized-and-syntax',
        sha: 'a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7',
        output: makeFullParityGraph(), // 2 parsed + 1 syntax-invalid = 3 extracted supported
        extractionStats: {
          supportedFilesCount: 3,
          skippedFilesCount: 3, // README.md + oversized huge.ts + oversized package.json
          oversizedSupportedFilesCount: 1,
          oversizedSkippedFilesCount: 2,
        },
        expectedFileCount: 4, // 3 extracted + 1 oversized supported
        expectedSkipped: 4, // 3 extraction skips + 1 syntax-invalid extracted
        expectedEmptyJsTs: false,
      },
    ];

    for (const tc of cases) {
      const c = await repoA.createOrGetActive({
        githubUrl: `https://github.com/gp-a/${tc.name}`,
        owner: 'gp-a',
        name: tc.name,
        defaultBranch: 'main',
        commitSha: tc.sha,
        sizeKb: 10,
        now: t0,
      });
      const cl = await repoA.claimIngestionAttempt({
        repoId: c.repository.id,
        jobId: c.job.id,
        bullmqJobId: c.job.id,
        commitSha: tc.sha,
        attemptGeneration: 1,
        now: t1,
      });
      if (cl.outcome !== 'claimed') {
        throw new Error(`Expected claim for ${tc.name}`);
      }
      await repoA.transitionJobStage(cl.ownership, {
        toStatus: 'building_graph',
        progressPct: 85,
        now: t1,
      });
      const pub = await repoA.publishRepositoryGraph(cl.ownership, {
        output: tc.output,
        extractionStats: tc.extractionStats,
        now: t2,
      });
      expect(pub.outcome).toBe('published');
      if (pub.outcome === 'published') {
        expect(pub.repository.fileCount).toBe(tc.expectedFileCount);
        expect(pub.repository.skippedFilesCount).toBe(tc.expectedSkipped);
        expect(isEmptyJsTsRepository(pub.repository)).toBe(tc.expectedEmptyJsTs);
        if (tc.name === 'surrogate-norm') {
          const runRows = await clientA.db
            .select()
            .from(nodes)
            .where(eq(nodes.repoId, c.repository.id));
          const runRow = runRows.find((r) => r.qualifiedName === 'src/index.ts::fn:run');
          expect(runRow?.snippet).toBe('export function run() { return "\uFFFD"; }');
        }
      }
    }
  });

  it('rolls back completely at all three transaction boundaries (mid-node-batch, edge insert, and before ready update) and retries cleanly without duplicates', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const sha = 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
    const t0 = new Date('2026-11-27T15:00:00.000Z');
    const created = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/gp-b/rollback-all-phases',
      owner: 'gp-b',
      name: 'rollback-all-phases',
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

    const assertionDb = clientA.db;
    const assertZeroPartialGraph = async (): Promise<void> => {
      expect(
        await assertionDb.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
      ).toEqual([]);
      expect(
        await assertionDb.select().from(edges).where(eq(edges.repoId, created.repository.id)),
      ).toEqual([]);
      const loaded = await repoA.findJobWithRepository(created.job.id);
      expect(loaded?.repository.status).toBe('building_graph');
      expect(loaded?.repository.graphPersistedAt).toBeNull();
      expect(loaded?.job.stage).toBe('building_graph');
    };

    // 1. Failure AFTER node batch 1 succeeds (during node batch 2)
    await clientA.pool.query(`
      CREATE OR REPLACE FUNCTION fail_node_batch2() RETURNS trigger AS $$
      BEGIN
        IF NEW.repo_id = '${created.repository.id}'::uuid
           AND NEW.qualified_name = 'file:src/helper.ts' THEN
          RAISE EXCEPTION 'Simulated node batch 2 failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_node_batch2
      BEFORE INSERT ON nodes
      FOR EACH ROW EXECUTE FUNCTION fail_node_batch2();
    `);
    try {
      await expect(
        repoA.publishRepositoryGraph(claimed.ownership, {
          output: makeSampleGraph(),
          extractionStats: SAMPLE_GRAPH_EXTRACTION_STATS,
          batchOptions: { maxNodesPerBatch: 2, maxEdgesPerBatch: 1 },
        }),
      ).rejects.toThrow();
      await assertZeroPartialGraph();
    } finally {
      await clientA.pool.query(`
        DROP TRIGGER IF EXISTS trg_fail_node_batch2 ON nodes;
        DROP FUNCTION IF EXISTS fail_node_batch2();
      `);
    }

    // 2. Failure DURING edge insertion (after all 3 node batches succeeded)
    await clientA.pool.query(`
      CREATE OR REPLACE FUNCTION fail_edge_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.repo_id = '${created.repository.id}'::uuid THEN
          RAISE EXCEPTION 'Simulated mid-publish edge failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_edge_insert
      BEFORE INSERT ON edges
      FOR EACH ROW EXECUTE FUNCTION fail_edge_insert();
    `);
    try {
      await expect(
        repoA.publishRepositoryGraph(claimed.ownership, {
          output: makeSampleGraph(),
          extractionStats: SAMPLE_GRAPH_EXTRACTION_STATS,
          batchOptions: { maxNodesPerBatch: 2, maxEdgesPerBatch: 1 },
        }),
      ).rejects.toThrow();
      await assertZeroPartialGraph();
    } finally {
      await clientA.pool.query(`
        DROP TRIGGER IF EXISTS trg_fail_edge_insert ON edges;
        DROP FUNCTION IF EXISTS fail_edge_insert();
      `);
    }

    // 3. Failure BEFORE final ready update (after ALL node batches AND ALL edge batches succeeded)
    await clientA.pool.query(`
      CREATE OR REPLACE FUNCTION fail_ready_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${created.repository.id}'::uuid AND NEW.status = 'ready' THEN
          RAISE EXCEPTION 'Simulated pre-ready update failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_ready_update
      BEFORE UPDATE ON repositories
      FOR EACH ROW EXECUTE FUNCTION fail_ready_update();
    `);
    try {
      await expect(
        repoA.publishRepositoryGraph(claimed.ownership, {
          output: makeSampleGraph(),
          extractionStats: SAMPLE_GRAPH_EXTRACTION_STATS,
          batchOptions: { maxNodesPerBatch: 2, maxEdgesPerBatch: 1 },
        }),
      ).rejects.toThrow();
      await assertZeroPartialGraph();
    } finally {
      await clientA.pool.query(`
        DROP TRIGGER IF EXISTS trg_fail_ready_update ON repositories;
        DROP FUNCTION IF EXISTS fail_ready_update();
      `);
    }

    // 4. Subsequent retry succeeds cleanly with exact node/edge counts and zero duplicates
    const retryPub = await repoA.publishRepositoryGraph(claimed.ownership, {
      output: makeSampleGraph(),
      extractionStats: SAMPLE_GRAPH_EXTRACTION_STATS,
      batchOptions: { maxNodesPerBatch: 2, maxEdgesPerBatch: 1 },
    });
    expect(retryPub.outcome).toBe('published');
    expect(
      await clientA.db.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
    ).toHaveLength(5);
    expect(
      await clientA.db.select().from(edges).where(eq(edges.repoId, created.repository.id)),
    ).toHaveLength(2);
  });

  it('pauses mid-publication AFTER real SQL node inserts to prove heartbeat busy, sweeper SKIP LOCKED, mid-insert AbortSignal rollback, and real PG timeout rollback', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    const sha = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
    const tOld = new Date('2026-11-27T08:00:00.000Z');
    const tSweep = new Date('2026-11-27T09:00:00.000Z');
    const advisoryKey = 770551;

    const created = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/gp-b/mid-insert-concurrency',
      owner: 'gp-b',
      name: 'mid-insert-concurrency',
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 10,
      now: tOld,
    });
    const claimed = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: sha,
      attemptGeneration: 1,
      now: tOld,
    });
    if (claimed.outcome !== 'claimed') {
      throw new Error('Expected claim');
    }
    await repoA.transitionJobStage(claimed.ownership, {
      toStatus: 'building_graph',
      progressPct: 85,
      now: tOld,
    });

    // Install a transaction-scoped advisory-lock barrier on edges INSERT so publication pauses
    // strictly AFTER all 3 node batches have already executed inside the live PostgreSQL tx.
    await clientA.pool.query(`
      CREATE OR REPLACE FUNCTION pause_edge_insert_advisory() RETURNS trigger AS $$
      BEGIN
        IF NEW.repo_id = '${created.repository.id}'::uuid THEN
          PERFORM pg_advisory_xact_lock(${String(advisoryKey)});
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_pause_edge_insert_advisory
      BEFORE INSERT ON edges
      FOR EACH ROW EXECUTE FUNCTION pause_edge_insert_advisory();
    `);

    try {
      // 1. Mid-publication contention (heartbeat = busy, sweeper = SKIP LOCKED) + post-node-insert abort rollback
      const midAbortCtrl = new AbortController();
      let holdClient1: PoolClient | undefined;
      let abortedPubPromise: ReturnType<IngestionRepository['publishRepositoryGraph']> | undefined;
      let busyBeatPromise: ReturnType<IngestionRepository['touchJobHeartbeat']> | undefined;
      let skipSweepPromise: ReturnType<IngestionRepository['sweepStaleJobs']> | undefined;
      try {
        holdClient1 = await clientA.pool.connect();
        await holdClient1.query('BEGIN');
        await holdClient1.query('SELECT pg_advisory_xact_lock($1)', [advisoryKey]);

        abortedPubPromise = repoA.publishRepositoryGraph(claimed.ownership, {
          output: makeSampleGraph(),
          extractionStats: SAMPLE_GRAPH_EXTRACTION_STATS,
          batchOptions: { maxNodesPerBatch: 2, maxEdgesPerBatch: 1 },
          signal: midAbortCtrl.signal,
        });

        // Deterministic barrier: wait until publication has inserted all node batches & hit the edge advisory lock
        await waitForLockWaiters(clientA.pool, 1, { waitEvent: 'advisory' });

        // Heartbeat NOWAIT observes busy (never ownership_lost) while publication holds repo/job row locks
        busyBeatPromise = repoB.touchJobHeartbeat(claimed.ownership, tSweep);
        expect(
          await withTimeout(busyBeatPromise, 3_000, 'heartbeat busy during active publication'),
        ).toEqual({ outcome: 'busy', updated: false });

        // Stale-job sweeper skips the actively publishing repo via SKIP LOCKED even though updatedAt is stale
        skipSweepPromise = repoB.sweepStaleJobs({
          staleThresholdMs: 10 * 60 * 1000,
          now: tSweep,
        });
        const sweepRes = await withTimeout(
          skipSweepPromise,
          3_000,
          'sweeper SKIP LOCKED during active publication',
        );
        expect(sweepRes.sweptRepoIds).not.toContain(created.repository.id);

        // Abort mid-publication AFTER SQL node inserts occurred, then release advisory lock
        midAbortCtrl.abort();
        await holdClient1.query('ROLLBACK');
        holdClient1.release();
        holdClient1 = undefined;

        await expect(
          withTimeout(abortedPubPromise, 5_000, 'mid-insert aborted publication rollback'),
        ).rejects.toBeInstanceOf(GraphPublicationAbortedError);

        // Entire transaction rolled back: zero nodes, zero edges, building_graph intact
        expect(
          await clientA.db.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
        ).toEqual([]);
        expect(
          await clientA.db.select().from(edges).where(eq(edges.repoId, created.repository.id)),
        ).toEqual([]);
        const afterAbort = await repoA.findJobWithRepository(created.job.id);
        expect(afterAbort?.repository.status).toBe('building_graph');
        expect(afterAbort?.repository.graphPersistedAt).toBeNull();
      } finally {
        await safeRollbackAndRelease(holdClient1);
        await Promise.allSettled(
          [abortedPubPromise, busyBeatPromise, skipSweepPromise].filter((p) => p !== undefined),
        );
      }

      // 2. Real PostgreSQL statement_timeout (57014) mid-publication rolls back cleanly & reconciles unpublished
      let holdClient2: PoolClient | undefined;
      let timedOutPubPromise: ReturnType<IngestionRepository['publishRepositoryGraph']> | undefined;
      try {
        holdClient2 = await clientA.pool.connect();
        await holdClient2.query('BEGIN');
        await holdClient2.query('SELECT pg_advisory_xact_lock($1)', [advisoryKey]);

        timedOutPubPromise = repoA.publishRepositoryGraph(claimed.ownership, {
          output: makeSampleGraph(),
          extractionStats: SAMPLE_GRAPH_EXTRACTION_STATS,
          batchOptions: { maxNodesPerBatch: 2, maxEdgesPerBatch: 1 },
          timeouts: {
            lockTimeoutMs: 250,
            statementTimeoutMs: 300,
            transactionTimeoutMs: 1_000,
          },
        });

        let pgTimeoutErr: unknown;
        try {
          await withTimeout(timedOutPubPromise, 5_000, 'real PG timeout during publication');
        } catch (err) {
          pgTimeoutErr = err;
        }
        expect(pgTimeoutErr).toBeDefined();
        const classified = classifyDbError(pgTimeoutErr);
        expect(['query_canceled', 'lock_not_available', 'transaction_timeout']).toContain(
          classified.category,
        );
        expect(classified.retryable).toBe(true);

        await holdClient2.query('ROLLBACK');
        holdClient2.release();
        holdClient2 = undefined;

        expect(
          await clientA.db.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
        ).toEqual([]);
        expect(
          await clientA.db.select().from(edges).where(eq(edges.repoId, created.repository.id)),
        ).toEqual([]);
        expect((await repoB.reconcilePublishedAttempt(claimed.ownership)).outcome).toBe(
          'still_owned_unpublished',
        );
      } finally {
        await safeRollbackAndRelease(holdClient2);
        if (timedOutPubPromise !== undefined) {
          await Promise.allSettled([timedOutPubPromise]);
        }
      }
    } finally {
      await clientA.pool.query(`
        DROP TRIGGER IF EXISTS trg_pause_edge_insert_advisory ON edges;
        DROP FUNCTION IF EXISTS pause_edge_insert_advisory();
      `);
    }
  });

  it('serializes concurrent duplicate publication and gen-1 vs gen-2 publication races cleanly, and requires exact BullMQ identity in reconciliation', async () => {
    if (clientA === undefined) {
      throw new Error('Expected initialized clientA');
    }

    // 1. Duplicate delivery race: two concurrent publishRepositoryGraph calls with SAME active ownership
    const shaDup = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
    const dupCreated = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/gp-c/dup-publish-race',
      owner: 'gp-c',
      name: 'dup-publish-race',
      defaultBranch: 'main',
      commitSha: shaDup,
      sizeKb: 10,
    });
    const dupClaim = await repoA.claimIngestionAttempt({
      repoId: dupCreated.repository.id,
      jobId: dupCreated.job.id,
      bullmqJobId: dupCreated.job.id,
      commitSha: shaDup,
      attemptGeneration: 1,
    });
    if (dupClaim.outcome !== 'claimed') {
      throw new Error('Expected dup claim');
    }
    await repoA.transitionJobStage(dupClaim.ownership, {
      toStatus: 'building_graph',
      progressPct: 85,
    });

    let dupBlocker: PoolClient | undefined;
    let dupPubA: ReturnType<IngestionRepository['publishRepositoryGraph']> | undefined;
    let dupPubB: ReturnType<IngestionRepository['publishRepositoryGraph']> | undefined;
    try {
      dupBlocker = await clientA.pool.connect();
      await dupBlocker.query('BEGIN');
      await dupBlocker.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        dupCreated.repository.id,
      ]);

      dupPubA = repoA.publishRepositoryGraph(dupClaim.ownership, {
        output: makeSampleGraph(),
        extractionStats: SAMPLE_GRAPH_EXTRACTION_STATS,
      });
      dupPubB = repoB.publishRepositoryGraph(dupClaim.ownership, {
        output: makeSampleGraph(),
        extractionStats: SAMPLE_GRAPH_EXTRACTION_STATS,
      });
      await waitForLockWaiters(clientA.pool, 2);

      await dupBlocker.query('COMMIT');
      dupBlocker.release();
      dupBlocker = undefined;

      const [resA, resB] = await withTimeout(
        Promise.all([dupPubA, dupPubB]),
        5_000,
        'duplicate concurrent publication settlement',
      );
      expect([resA.outcome, resB.outcome].sort()).toEqual(['published', 'terminal']);
      expect(
        await clientA.db.select().from(nodes).where(eq(nodes.repoId, dupCreated.repository.id)),
      ).toHaveLength(5);
      expect(
        await clientA.db.select().from(edges).where(eq(edges.repoId, dupCreated.repository.id)),
      ).toHaveLength(2);
    } finally {
      await safeRollbackAndRelease(dupBlocker);
      await Promise.allSettled([dupPubA, dupPubB].filter((p) => p !== undefined));
    }

    // 2. Concurrent gen-1 vs gen-2 publication race + invalid cyclic/mismatched graphs + locked reconciliation
    const shaRace = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
    const created = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/gp-c/stale-and-reconcile',
      owner: 'gp-c',
      name: 'stale-and-reconcile',
      defaultBranch: 'main',
      commitSha: shaRace,
      sizeKb: 10,
    });
    const claim1 = await repoA.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: shaRace,
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
      repoA.publishRepositoryGraph(claim1.ownership, {
        output: cyclicGraph,
        extractionStats: {
          supportedFilesCount: 0,
          skippedFilesCount: 0,
          oversizedSupportedFilesCount: 0,
        },
      }),
    ).rejects.toBeInstanceOf(GraphPersistenceValidationError);

    // Mismatched parser counts vs extraction inventory also fail BEFORE opening SQL tx
    await expect(
      repoA.publishRepositoryGraph(claim1.ownership, {
        output: makeSampleGraph(),
        extractionStats: {
          supportedFilesCount: 1, // parser discovered 2 > 1 extracted
          skippedFilesCount: 0,
          oversizedSupportedFilesCount: 0,
        },
      }),
    ).rejects.toBeInstanceOf(GraphPersistenceValidationError);

    // Gen 2 takes over & reaches building_graph; then gen 1 & gen 2 race behind a PG row lock
    const claim2 = await repoB.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha: shaRace,
      attemptGeneration: 2,
    });
    if (claim2.outcome !== 'claimed') {
      throw new Error('Expected claim 2');
    }
    await repoB.transitionJobStage(claim2.ownership, {
      toStatus: 'building_graph',
      progressPct: 85,
    });

    // Stale gen 1 reconciling while gen 2 is active sees ownership_lost
    expect(await repoA.reconcilePublishedAttempt(claim1.ownership)).toEqual({
      outcome: 'ownership_lost',
      storedGeneration: 2,
      expectedGeneration: 1,
    });

    let raceBlocker: PoolClient | undefined;
    let gen1Pub: ReturnType<IngestionRepository['publishRepositoryGraph']> | undefined;
    let gen2Pub: ReturnType<IngestionRepository['publishRepositoryGraph']> | undefined;
    try {
      raceBlocker = await clientA.pool.connect();
      await raceBlocker.query('BEGIN');
      await raceBlocker.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        created.repository.id,
      ]);

      gen1Pub = repoA.publishRepositoryGraph(claim1.ownership, {
        output: makeSampleGraph(),
        extractionStats: SAMPLE_GRAPH_EXTRACTION_STATS,
      });
      gen2Pub = repoB.publishRepositoryGraph(claim2.ownership, {
        output: makeFullParityGraph(),
        extractionStats: {
          supportedFilesCount: 3,
          skippedFilesCount: 1,
          oversizedSupportedFilesCount: 0,
        },
      });
      await waitForLockWaiters(clientA.pool, 2);

      await raceBlocker.query('COMMIT');
      raceBlocker.release();
      raceBlocker = undefined;

      const [r1, r2] = await withTimeout(
        Promise.all([gen1Pub, gen2Pub]),
        5_000,
        'gen 1 vs gen 2 concurrent publication',
      );
      expect(r2.outcome).toBe('published');
      expect(['ownership_lost', 'terminal']).toContain(r1.outcome);
      expect(r1.applied).toBe(false);

      // Persisted graph is EXCLUSIVELY gen 2's 7-node full-parity graph (zero rows from gen 1)
      expect(
        await clientA.db.select().from(nodes).where(eq(nodes.repoId, created.repository.id)),
      ).toHaveLength(7);
      expect(
        await clientA.db.select().from(edges).where(eq(edges.repoId, created.repository.id)),
      ).toHaveLength(4);
    } finally {
      await safeRollbackAndRelease(raceBlocker);
      await Promise.allSettled([gen1Pub, gen2Pub].filter((p) => p !== undefined));
    }

    // Real row-lock serialization: reconcilePublishedAttempt waits on FOR UPDATE while publication commits
    const shaRec = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
    const recCreated = await repoA.createOrGetActive({
      githubUrl: 'https://github.com/gp-c/locked-reconcile',
      owner: 'gp-c',
      name: 'locked-reconcile',
      defaultBranch: 'main',
      commitSha: shaRec,
      sizeKb: 10,
    });
    const recClaim = await repoA.claimIngestionAttempt({
      repoId: recCreated.repository.id,
      jobId: recCreated.job.id,
      bullmqJobId: recCreated.job.id,
      commitSha: shaRec,
      attemptGeneration: 1,
    });
    if (recClaim.outcome !== 'claimed') {
      throw new Error('Expected recClaim');
    }

    let txClient: PoolClient | undefined;
    let reconcilePromise: ReturnType<IngestionRepository['reconcilePublishedAttempt']> | undefined;
    try {
      txClient = await clientA.pool.connect();
      await txClient.query('BEGIN');
      await txClient.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE', [
        recCreated.repository.id,
      ]);

      reconcilePromise = repoB.reconcilePublishedAttempt(recClaim.ownership);
      await waitForLockWaiters(clientA.pool, 1);

      const nowIso = new Date('2026-11-27T16:00:00.000Z').toISOString();
      await txClient.query(
        `UPDATE repositories SET status = 'ready', graph_persisted_at = $2, updated_at = $2 WHERE id = $1`,
        [recCreated.repository.id, nowIso],
      );
      await txClient.query(
        `UPDATE ingestion_jobs SET stage = 'ready', progress_pct = 100, finished_at = $2 WHERE id = $1`,
        [recCreated.job.id, nowIso],
      );
      await txClient.query('COMMIT');
      txClient.release();
      txClient = undefined;

      const reconciled = await withTimeout(reconcilePromise, 5_000, 'locked reconcile settlement');
      expect(reconciled.outcome).toBe('published_by_owner');
      const repoRow = await clientA.db
        .select()
        .from(repositories)
        .where(eq(repositories.id, recCreated.repository.id));
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
