import { randomBytes, randomUUID } from 'node:crypto';
import {
  buildPoolConfig,
  createDbClient,
  createGraphQueryRepository,
  createIngestionRepository,
  runMigrations,
  sanitizeDatabaseTarget,
  type DbClient,
} from '@archon/db';
import {
  blastRadiusResponseSchema,
  computeGraphCursorQueryHash,
  createLogger,
  encodeGraphCursor,
  loadEnv,
  nodeDetailResponseSchema,
  nodeEdgesResponseSchema,
  repositoryGraphViewResponseSchema,
  repositoryHubsResponseSchema,
  type AnalysisOutput,
  type ExtractedEdge,
  type ExtractedNode,
} from '@archon/shared';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app.js';
import { createStubIngestionEnqueuer } from './queue/enqueuer.js';
import { createRedisRateLimitStoreConfig } from './rate-limit.js';
import { createRedisRateLimitStore } from './redis-rate-limit-store.js';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const REDIS_TEST_DB = 15;

const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

function parseBody<T>(res: { readonly body: string }, schema: z.ZodType<T>): T {
  const raw: unknown = JSON.parse(res.body);
  return schema.parse(raw);
}

function replaceDatabaseName(databaseUrl: string, newDbName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${newDbName}`;
  return parsed.toString();
}

function replaceRedisDb(redisUrl: string, dbIndex: number): string {
  const parsed = new URL(redisUrl);
  parsed.pathname = `/${String(dbIndex)}`;
  return parsed.toString();
}

async function scanRedisKeys(client: Redis, pattern: string): Promise<string[]> {
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [nextCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = nextCursor;
    for (const k of batch) {
      keys.push(k);
    }
  } while (cursor !== '0');
  return keys;
}

function makeOutput(
  outNodes: readonly ExtractedNode[],
  outEdges: readonly ExtractedEdge[],
): AnalysisOutput {
  const counts = { folder: 0, file: 0, function: 0, class: 0, symbol: 0 };
  for (const n of outNodes) counts[n.nodeType] += 1;
  return {
    nodes: outNodes,
    edges: outEdges,
    warnings: [],
    stats: {
      discoveredFilesCount: counts.file,
      parsedFilesCount: counts.file,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 0,
      folderNodeCount: counts.folder,
      fileNodeCount: counts.file,
      functionNodeCount: counts.function,
      classNodeCount: counts.class,
      symbolNodeCount: counts.symbol,
      importsEdgeCount: outEdges.filter((e) => e.edgeType === 'IMPORTS').length,
      callsEdgeCount: outEdges.filter((e) => e.edgeType === 'CALLS').length,
      totalBytesRead: 512,
      truncatedWarningsCount: 0,
    },
  };
}

describe('Fastify Graph API HTTP integration (real PostgreSQL 17 + Redis 7)', () => {
  const suffix = randomBytes(5).toString('hex');
  const testDbName = `archon_api_gq_${suffix}`;
  const keyPrefix = `archon_api_gq_rl_${suffix}:`;
  let adminPool: Pool | undefined;
  let dbClient: DbClient | undefined;
  let redisClient: Redis | undefined;
  let dbCreated = false;

  beforeAll(async () => {
    const env = loadEnv();
    const pgTarget = sanitizeDatabaseTarget(env.DATABASE_URL);
    adminPool = new Pool(buildPoolConfig({ databaseUrl: env.DATABASE_URL, max: 2 }));
    try {
      await adminPool.query('SELECT 1');
    } catch (err) {
      throw new Error(
        `PostgreSQL unreachable at ${pgTarget}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    dbCreated = true;
    dbClient = createDbClient({
      databaseUrl: replaceDatabaseName(env.DATABASE_URL, testDbName),
      max: 5,
    });
    await runMigrations(dbClient.db);

    redisClient = new Redis(replaceRedisDb(env.REDIS_URL, REDIS_TEST_DB), {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    const pong: string = await redisClient.ping();
    if (pong !== 'PONG') {
      throw new Error('Redis ping failed for HTTP integration test.');
    }
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    if (redisClient !== undefined) {
      try {
        const keys = await scanRedisKeys(redisClient, `${keyPrefix}*`);
        if (keys.length > 0) {
          await redisClient.del(...keys);
        }
      } catch (err) {
        cleanupErrors.push(err);
      }
      try {
        await redisClient.quit();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }

    if (dbClient !== undefined) {
      try {
        await dbClient.close();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }

    if (adminPool !== undefined) {
      if (dbCreated) {
        try {
          await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
        } catch (err) {
          cleanupErrors.push(err);
        }
      }
      try {
        await adminPool.end();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Integration test cleanup encountered errors.');
    }
  });

  it('serves all 5 routes + HEAD over real PostgreSQL, rejects inconsistent hub anchors, enforces gating, and verifies real Redis shared bucket, TTL preservation, and IP/ingestion isolation', async () => {
    if (dbClient === undefined || redisClient === undefined) {
      throw new Error('Expected live dbClient and redisClient');
    }

    const baseEnv = loadEnv();
    const logger = createLogger({ service: 'api-int-test', level: 'silent' });
    const ingestionRepo = createIngestionRepository(dbClient.db);
    const graphQueryRepo = createGraphQueryRepository(dbClient.db);

    const t0 = new Date('2026-11-28T06:00:00.000Z');
    const nowRef = { current: t0 };

    const gNodes: ExtractedNode[] = [
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
      {
        nodeType: 'file',
        name: 'core.ts',
        qualifiedName: 'file:src/core.ts',
        filePath: 'src/core.ts',
        parentQualifiedName: 'folder:src',
        isExported: false,
        startLine: 1,
        endLine: 10,
        contentHash: H1,
        snippet: 'export function hubFn(){}\nexport function leafFn(){}',
      },
      {
        nodeType: 'function',
        name: 'hubFn',
        qualifiedName: 'src/core.ts::fn:hubFn',
        filePath: 'src/core.ts',
        parentQualifiedName: 'file:src/core.ts',
        isExported: true,
        startLine: 1,
        endLine: 2,
        contentHash: H1,
        snippet: 'export function hubFn(){}',
      },
      {
        nodeType: 'function',
        name: 'leafFn',
        qualifiedName: 'src/core.ts::fn:leafFn',
        filePath: 'src/core.ts',
        parentQualifiedName: 'file:src/core.ts',
        isExported: true,
        startLine: 3,
        endLine: 4,
        contentHash: H1,
        snippet: 'export function leafFn(){}',
      },
    ];
    const gEdges: ExtractedEdge[] = [];
    for (let i = 1; i <= 31; i += 1) {
      const fp = `src/c${String(i).padStart(2, '0')}.ts`;
      const qn = `${fp}::fn:c${String(i).padStart(2, '0')}`;
      gNodes.push(
        {
          nodeType: 'file',
          name: `c${String(i).padStart(2, '0')}.ts`,
          qualifiedName: `file:${fp}`,
          filePath: fp,
          parentQualifiedName: 'folder:src',
          isExported: false,
          startLine: 1,
          endLine: 5,
          contentHash: H2,
          snippet: 'export function c(){}',
        },
        {
          nodeType: 'function',
          name: `c${String(i).padStart(2, '0')}`,
          qualifiedName: qn,
          filePath: fp,
          parentQualifiedName: `file:${fp}`,
          isExported: true,
          startLine: 1,
          endLine: 4,
          contentHash: H2,
          snippet: 'export function c(){}',
        },
      );
      gEdges.push(
        {
          sourceQualifiedName: `file:${fp}`,
          targetQualifiedName: 'file:src/core.ts',
          edgeType: 'IMPORTS',
          callSiteLine: null,
          callSiteSnippet: null,
        },
        {
          sourceQualifiedName: qn,
          targetQualifiedName: 'src/core.ts::fn:hubFn',
          edgeType: 'CALLS',
          callSiteLine: 2,
          callSiteSnippet: 'hubFn()',
        },
      );
      if (i <= 30) {
        gEdges.push({
          sourceQualifiedName: qn,
          targetQualifiedName: 'src/core.ts::fn:leafFn',
          edgeType: 'CALLS',
          callSiteLine: 3,
          callSiteSnippet: 'leafFn()',
        });
      }
    }

    const commitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const created = await ingestionRepo.createOrGetActive({
      githubUrl: 'https://github.com/api-int/demo',
      owner: 'api-int',
      name: 'demo',
      defaultBranch: 'main',
      commitSha,
      sizeKb: 50,
      ttlDays: 1,
      now: t0,
    });
    const claimed = await ingestionRepo.claimIngestionAttempt({
      repoId: created.repository.id,
      jobId: created.job.id,
      bullmqJobId: created.job.id,
      commitSha,
      attemptGeneration: 1,
      now: t0,
    });
    if (claimed.outcome !== 'claimed') throw new Error('Expected claim');
    await ingestionRepo.transitionJobStage(claimed.ownership, {
      toStatus: 'building_graph',
      progressPct: 85,
      now: t0,
    });
    const pub = await ingestionRepo.publishRepositoryGraph(claimed.ownership, {
      output: makeOutput(gNodes, gEdges),
      extractionStats: {
        supportedFilesCount: 32,
        skippedFilesCount: 0,
        oversizedSupportedFilesCount: 0,
      },
      now: t0,
    });
    if (pub.outcome !== 'published') throw new Error('Expected published');
    const repoId = pub.repository.id;

    const emptyRepo = await ingestionRepo.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/api-int/empty',
      owner: 'api-int',
      name: 'empty',
      defaultBranch: 'main',
      commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sizeKb: 1,
      now: t0,
    });
    const legacyRepo = await ingestionRepo.createOrGetActive({
      githubUrl: 'https://github.com/api-int/legacy',
      owner: 'api-int',
      name: 'legacy',
      defaultBranch: 'main',
      commitSha: 'cccccccccccccccccccccccccccccccccccccccc',
      sizeKb: 1,
      initialStatus: 'ready',
      now: t0,
    });

    const redisStoreCtor = createRedisRateLimitStore({
      client: redisClient,
      keyPrefix,
      logger,
    });

    const app = await buildApp({
      env: {
        ...baseEnv,
        HUB_THRESHOLD: 30,
        INGEST_RATE_LIMIT_PER_HOUR: 2,
        RUN_EMBEDDED_WORKER: false,
      },
      logger,
      repository: ingestionRepo,
      graphQueryRepository: graphQueryRepo,
      rateLimitStore: createRedisRateLimitStoreConfig(redisStoreCtor),
      graphRateLimitMax: 15,
      graphRateLimitWindowMs: 60_000,
      checkDbHealth: () => dbClient?.ping() ?? Promise.resolve(false),
      githubPrecheck: { precheckRepository: vi.fn(() => Promise.reject(new Error('unused'))) },
      enqueuer: createStubIngestionEnqueuer(logger),
      now: () => nowRef.current,
    });

    try {
      const ipA = '203.0.113.21';
      const ipB = '203.0.113.22';
      const keyA = `${keyPrefix}graph-read:${ipA}`;
      const keyB = `${keyPrefix}graph-read:${ipB}`;

      // 1. GET /graph + HEAD /graph + capture initial Redis TTL
      const gRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoId}/graph?level=file`,
        remoteAddress: ipA,
      });
      expect(gRes.statusCode).toBe(200);
      const gBody = parseBody(gRes, repositoryGraphViewResponseSchema);
      expect(gBody.nodes).toHaveLength(32);
      const coreFile = gBody.nodes.find((n) => n.qualifiedName === 'file:src/core.ts');
      if (coreFile === undefined) throw new Error('Expected coreFile');
      expect(coreFile.isHub).toBe(true);
      expect(coreFile.isFileRollupHub).toBe(true);

      const initialPttl = await redisClient.pttl(keyA);
      expect(initialPttl).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 30));

      const hRes = await app.inject({
        method: 'HEAD',
        url: `/api/v1/repos/${repoId}/graph?level=file`,
        remoteAddress: ipA,
      });
      expect(hRes.statusCode).toBe(200);
      expect(hRes.body).toBe('');

      // TTL must NOT reset on subsequent hits
      const secondPttl = await redisClient.pttl(keyA);
      expect(secondPttl).toBeGreaterThan(0);
      expect(secondPttl).toBeLessThanOrEqual(initialPttl);

      // 2. GET /nodes/:nodeId (with snippet & children pagination)
      const dRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoId}/nodes/${coreFile.id}?childrenLimit=1`,
        remoteAddress: ipA,
      });
      expect(dRes.statusCode).toBe(200);
      const dBody = parseBody(dRes, nodeDetailResponseSchema);
      expect(dBody.node.snippet).toContain('export function hubFn');
      expect(dBody.children.totalCount).toBe(2);
      expect(dBody.children.page.nextCursor).not.toBeNull();

      const d2Res = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoId}/nodes/${coreFile.id}?childrenLimit=5&childrenCursor=${encodeURIComponent(dBody.children.page.nextCursor ?? '')}`,
        remoteAddress: ipA,
      });
      expect(d2Res.statusCode).toBe(200);
      const d2Body = parseBody(d2Res, nodeDetailResponseSchema);
      const allChildren = [...dBody.children.items, ...d2Body.children.items];
      const hubFn = allChildren.find((c) => c.name === 'hubFn');
      const leafFn = allChildren.find((c) => c.name === 'leafFn');
      if (hubFn === undefined || leafFn === undefined) throw new Error('Expected hubFn & leafFn');
      expect(hubFn.isHub).toBe(true);
      expect(leafFn.isHub).toBe(false);

      // 3. GET /nodes/:nodeId/edges (with callSiteSnippet)
      const eRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoId}/nodes/${hubFn.id}/edges?direction=incoming&edgeType=CALLS&limit=5`,
        remoteAddress: ipA,
      });
      expect(eRes.statusCode).toBe(200);
      const eBody = parseBody(eRes, nodeEdgesResponseSchema);
      expect(eBody.items).toHaveLength(5);
      expect(eBody.items[0]?.callSiteSnippet).toBe('hubFn()');

      // 4. GET /nodes/:nodeId/blast-radius
      const brRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoId}/nodes/${hubFn.id}/blast-radius?maxDepth=1`,
        remoteAddress: ipA,
      });
      expect(brRes.statusCode).toBe(200);
      const brBody = parseBody(brRes, blastRadiusResponseSchema);
      expect(brBody.summary.totalImpactedNodes).toBe(31);
      expect(brBody.summary.totalImpactedFiles).toBe(31);

      // 5. GET /hubs + tampered hubDegree & non-hub anchor cursor rejection
      const hubsRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoId}/hubs?scope=callable&threshold=30&limit=1`,
        remoteAddress: ipA,
      });
      expect(hubsRes.statusCode).toBe(200);
      const hubsBody = parseBody(hubsRes, repositoryHubsResponseSchema);
      expect(hubsBody.totalHubs).toBe(1);
      expect(hubsBody.items[0]?.id).toBe(hubFn.id);

      const hubHash = computeGraphCursorQueryHash({
        endpoint: 'hubs',
        repoId,
        threshold: 30,
        scope: 'callable',
      });
      const forgedDegreeCursor = encodeGraphCursor({
        endpoint: 'hubs',
        repoId,
        queryHash: hubHash,
        key: { hubDegree: 999, rawIncomingEdgeCount: 31, id: hubFn.id },
      });
      const forgedRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoId}/hubs?scope=callable&threshold=30&cursor=${encodeURIComponent(forgedDegreeCursor)}`,
        remoteAddress: ipA,
      });
      expect(forgedRes.statusCode).toBe(400);
      expect(parseBody(forgedRes, apiErrorSchema).error.code).toBe('INVALID_CURSOR');

      const nonHubCursor = encodeGraphCursor({
        endpoint: 'hubs',
        repoId,
        queryHash: hubHash,
        key: { hubDegree: 30, rawIncomingEdgeCount: 30, id: leafFn.id },
      });
      const nonHubRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoId}/hubs?scope=callable&threshold=30&cursor=${encodeURIComponent(nonHubCursor)}`,
        remoteAddress: ipA,
      });
      expect(nonHubRes.statusCode).toBe(400);
      expect(parseBody(nonHubRes, apiErrorSchema).error.code).toBe('INVALID_CURSOR');

      // 6. Lifecycle gating across second repoId (same shared Redis key for ipA!)
      const emptyRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${emptyRepo.repository.id}/graph`,
        remoteAddress: ipA,
      });
      expect(emptyRes.statusCode).toBe(200);
      expect(parseBody(emptyRes, repositoryGraphViewResponseSchema).repository.emptyJsTs).toBe(
        true,
      );

      const legacyRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${legacyRepo.repository.id}/graph`,
        remoteAddress: ipA,
      });
      expect(legacyRes.statusCode).toBe(409);
      expect(parseBody(legacyRes, apiErrorSchema).error.code).toBe('LEGACY_GRAPH_UNAVAILABLE');

      const missingRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${randomUUID()}/graph`,
        remoteAddress: ipA,
      });
      expect(missingRes.statusCode).toBe(404);
      expect(parseBody(missingRes, apiErrorSchema).error.code).toBe('REPO_NOT_FOUND');

      nowRef.current = new Date('2026-12-05T00:00:00.000Z');
      const expiredRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoId}/graph`,
        remoteAddress: ipA,
      });
      expect(expiredRes.statusCode).toBe(410);
      expect(parseBody(expiredRes, apiErrorSchema).error.code).toBe('REPO_EXPIRED');

      // 13 hits so far for ipA across all 5 routes + HEAD + 4 distinct repoIds -> ALL on ONE Redis key!
      expect(Number(await redisClient.get(keyA))).toBe(13);

      // 2 more HEAD hits fill quota (15), 16th hits 429; independent ipB stays 200; ingestion stays isolated!
      expect(
        (
          await app.inject({
            method: 'HEAD',
            url: `/api/v1/repos/${emptyRepo.repository.id}/hubs`,
            remoteAddress: ipA,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'HEAD',
            url: `/api/v1/repos/${emptyRepo.repository.id}/graph`,
            remoteAddress: ipA,
          })
        ).statusCode,
      ).toBe(200);
      const blocked = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${emptyRepo.repository.id}/graph`,
        remoteAddress: ipA,
      });
      expect(blocked.statusCode).toBe(429);
      expect(parseBody(blocked, apiErrorSchema).error.message).toBe(
        'Graph query rate limit exceeded. Please try again later.',
      );

      // Independent IP gets its own Redis key
      const ipBRes = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${emptyRepo.repository.id}/graph`,
        remoteAddress: ipB,
      });
      expect(ipBRes.statusCode).toBe(200);
      expect(Number(await redisClient.get(keyB))).toBe(1);

      // Ingestion bucket on ipA remains completely separate on its own Redis key
      const ingestCheck = await app.inject({
        method: 'POST',
        url: '/api/v1/repos',
        remoteAddress: ipA,
        payload: {},
      });
      expect(ingestCheck.statusCode).toBe(400);
      expect(Number(await redisClient.get(`${keyPrefix}POST:/api/v1/repos:${ipA}`))).toBe(1);
    } finally {
      await app.close();
    }
  });
});
