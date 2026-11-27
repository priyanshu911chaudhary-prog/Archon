import http from 'node:http';
import {
  DbError,
  GraphQueryError,
  type GraphQueryErrorCode,
  type GraphQueryRepository,
  type IngestionRepository,
} from '@archon/db';
import {
  MAX_GRAPH_CURSOR_CHARS,
  blastRadiusResponseSchema,
  createLogger,
  nodeDetailResponseSchema,
  nodeEdgesResponseSchema,
  repositoryGraphViewResponseSchema,
  repositoryHubsResponseSchema,
  type AppEnv,
  type BlastRadiusResponse,
  type NodeDetailResponse,
  type NodeEdgesResponse,
  type RepositoryGraphViewResponse,
  type RepositoryHubsResponse,
} from '@archon/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app.js';
import { createGraphQueryAdmissionGate } from './graph-admission.js';
import { createStubIngestionEnqueuer } from './queue/enqueuer.js';
import { createRedisRateLimitStoreConfig } from './rate-limit.js';
import { createRedisRateLimitStore, type RedisRateLimitClient } from './redis-rate-limit-store.js';

const REPO_ID_UPPER = '11111111-1111-4111-8111-1111111111AA';
const REPO_ID = REPO_ID_UPPER.toLowerCase();
const REPO_ID_2 = '99999999-9999-4999-8999-999999999999';
const NODE_ID_UPPER = '22222222-2222-4222-8222-2222222222BB';
const NODE_ID = NODE_ID_UPPER.toLowerCase();
const EDGE_ID = '33333333-3333-4333-8333-3333333333cc';
const PEER_ID = '44444444-4444-4444-8444-4444444444dd';
const HASH_64 = 'a'.repeat(64);

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(timeoutMs)} ms waiting for ${label}.`));
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function makeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    NODE_ENV: 'test',
    PORT: 3001,
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://archon:archon@127.0.0.1:5432/archon',
    REDIS_URL: 'redis://127.0.0.1:6380/0',
    WEB_ORIGIN: 'http://localhost:3000',
    TRUST_PROXY_HOPS: 0,
    RUN_EMBEDDED_WORKER: false,
    MAX_REPO_SIZE_MB: 50,
    MAX_SUPPORTED_FILES: 500,
    INGEST_RATE_LIMIT_PER_HOUR: 2,
    HUB_THRESHOLD: 42,
    ...overrides,
  };
}

function makeSpiedLogger() {
  const logger = createLogger({ service: 'api-graph-test', level: 'silent' });
  const recorded: { readonly level: string; readonly args: readonly unknown[] }[] = [];
  vi.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
    recorded.push({ level: 'error', args });
  });
  vi.spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => {
    recorded.push({ level: 'warn', args });
  });
  vi.spyOn(logger, 'fatal').mockImplementation((...args: unknown[]) => {
    recorded.push({ level: 'fatal', args });
  });
  const childLogger = logger.child<string>({});

  vi.spyOn(childLogger, 'error').mockImplementation((...args: unknown[]) => {
    recorded.push({ level: 'error', args });
  });

  vi.spyOn(childLogger, 'warn').mockImplementation((...args: unknown[]) => {
    recorded.push({ level: 'warn', args });
  });

  vi.spyOn(childLogger, 'fatal').mockImplementation((...args: unknown[]) => {
    recorded.push({ level: 'fatal', args });
  });

  vi.spyOn(childLogger, 'child').mockReturnValue(childLogger);
  vi.spyOn(logger, 'child').mockReturnValue(childLogger);
  return { logger, recorded };
}

function makeGraphFixture(): RepositoryGraphViewResponse {
  return repositoryGraphViewResponseSchema.parse({
    repository: {
      repoId: REPO_ID,
      owner: 'pmndrs',
      name: 'zustand',
      commitSha: '9fed2eb2f3af672da9f7bf694b996df3831fc207',
      defaultBranch: 'main',
      status: 'ready',
      fileCount: 1,
      skippedFilesCount: 0,
      emptyJsTs: false,
      graphPersistedAt: '2026-11-28T00:00:00.000Z',
    },
    view: {
      level: 'file',
      scopeNodeId: null,
      scopeFilePath: null,
      includeImports: true,
      hubThreshold: 42,
      complete: true,
    },
    counts: { returnedNodes: 1, returnedEdges: 0 },
    nodes: [
      {
        id: NODE_ID,
        nodeType: 'file',
        name: 'index.ts',
        qualifiedName: 'file:src/index.ts',
        filePath: 'src/index.ts',
        parentNodeId: null,
        isExported: false,
        startLine: 1,
        endLine: 5,
        inDegreeDistinct: 0,
        rawIncomingEdgeCount: 0,
        distinctImporterCount: 0,
        distinctCallerCount: 0,
        dependentFileCount: 0,
        isHub: false,
        isFileRollupHub: false,
      },
    ],
    edges: [],
  });
}

function makeNodeDetailFixture(): NodeDetailResponse {
  return nodeDetailResponseSchema.parse({
    node: {
      id: NODE_ID,
      repoId: REPO_ID,
      nodeType: 'file',
      name: 'index.ts',
      qualifiedName: 'file:src/index.ts',
      filePath: 'src/index.ts',
      parentNodeId: null,
      isExported: false,
      startLine: 1,
      endLine: 5,
      contentHash: HASH_64,
      snippet: 'export const x = 1;',
    },
    ancestors: [],
    degree: {
      inDegreeDistinct: 0,
      rawIncomingEdgeCount: 0,
      outDegreeDistinct: 0,
      rawOutgoingEdgeCount: 0,
      distinctImporterCount: 0,
      distinctCallerCount: 0,
      dependentFileCount: 0,
      hubThreshold: 42,
      isHub: false,
      isFileRollupHub: false,
    },
    children: { items: [], totalCount: 0, page: { limit: 50, hasMore: false, nextCursor: null } },
  });
}

function makeNodeEdgesFixture(): NodeEdgesResponse {
  return nodeEdgesResponseSchema.parse({
    nodeId: NODE_ID,
    direction: 'incoming',
    edgeType: 'all',
    peerNodeId: null,
    items: [
      {
        edgeId: EDGE_ID,
        edgeType: 'CALLS',
        direction: 'incoming',
        sourceNodeId: PEER_ID,
        targetNodeId: NODE_ID,
        peerNode: {
          id: PEER_ID,
          nodeType: 'function',
          name: 'caller',
          qualifiedName: 'src/a.ts::fn:caller',
          filePath: 'src/a.ts',
          isExported: true,
          startLine: 1,
          endLine: 4,
        },
        callSiteLine: 3,
        callSiteSnippet: 'run()',
      },
    ],
    page: { limit: 50, hasMore: false, nextCursor: null },
  });
}

function makeBlastFixture(): BlastRadiusResponse {
  return blastRadiusResponseSchema.parse({
    target: {
      id: NODE_ID,
      repoId: REPO_ID,
      nodeType: 'file',
      name: 'index.ts',
      qualifiedName: 'file:src/index.ts',
      filePath: 'src/index.ts',
      isExported: false,
      seedFileCount: 1,
      seedExportedCallableCount: 0,
      excludedSubtreeNodeCount: 1,
    },
    params: { maxDepth: 2, hubThreshold: 42 },
    semantics: {
      propagationModel: 'conservative_file_wide_structural',
      fileWidePropagationNote: 'Conservative static reachability.',
      containmentProjectionHops: 0,
      hubPredicate: 'inDegreeDistinct > hubThreshold',
      fileRollupHubPredicate: 'dependentFileCount > hubThreshold',
    },
    completeness: {
      complete: true,
      traversalStrategy: 'bounded_reverse_frontier_bfs',
      visitedFileStates: 1,
      visitedCallableStates: 0,
      virtualExportedTargetsExpanded: 0,
      cumulativeRawEdgesScanned: 0,
      totalEvidenceItems: 0,
    },
    summary: {
      totalImpactedNodes: 0,
      directNodeCount: 0,
      transitiveNodeCount: 0,
      totalImpactedFiles: 0,
      directFileCount: 0,
      transitiveFileCount: 0,
      totalImpactedFolders: 0,
      directFolderCount: 0,
      transitiveFolderCount: 0,
      impactedNodeHubCount: 0,
      impactedFileRollupHubCount: 0,
      byHop: {
        '1': { nodes: 0, files: 0, folders: 0 },
        '2': { nodes: 0, files: 0, folders: 0 },
        '3': { nodes: 0, files: 0, folders: 0 },
      },
    },
    impactedNodes: [],
    impactedFiles: [],
    impactedFolders: [],
  });
}

function makeHubsFixture(): RepositoryHubsResponse {
  return repositoryHubsResponseSchema.parse({
    threshold: 42,
    scope: 'all',
    degreeMetric: 'distinct_dependent_nodes',
    totalHubs: 0,
    items: [],
    page: { limit: 50, hasMore: false, nextCursor: null },
  });
}

function makeMockGraphRepo(overrides: Partial<GraphQueryRepository> = {}): GraphQueryRepository {
  return {
    getRepositoryGraph: vi.fn(() => Promise.resolve(makeGraphFixture())),
    getNodeDetail: vi.fn(() => Promise.resolve(makeNodeDetailFixture())),
    getNodeEdges: vi.fn(() => Promise.resolve(makeNodeEdgesFixture())),
    getBlastRadius: vi.fn(() => Promise.resolve(makeBlastFixture())),
    getRepositoryHubs: vi.fn(() => Promise.resolve(makeHubsFixture())),
    ...overrides,
  };
}

function makeUnusedIngestionRepo(): IngestionRepository {
  return new Proxy({} as IngestionRepository, {
    get(_target, prop) {
      return () => Promise.reject(new Error(`Unexpected IngestionRepository.${String(prop)} call`));
    },
  });
}

const dummyPrecheck = {
  precheckRepository: vi.fn(() => Promise.reject(new Error('not used'))),
};

describe('Fastify Graph API routes (Phase 6.4 unit tests)', () => {
  it('routes all five GET endpoints + HEAD, normalizes uppercase UUIDs, propagates HUB_THRESHOLD, validates responses, and enforces strict query validation', async () => {
    const graphRepo = makeMockGraphRepo();
    const { logger } = makeSpiedLogger();
    const app = await buildApp({
      env: makeEnv({ HUB_THRESHOLD: 42 }),
      logger,
      repository: makeUnusedIngestionRepo(),
      graphQueryRepository: graphRepo,
      checkDbHealth: () => Promise.resolve(true),
      githubPrecheck: dummyPrecheck,
      enqueuer: createStubIngestionEnqueuer(logger),
    });

    try {
      const graphCallSpy = vi.spyOn(graphRepo, 'getRepositoryGraph');
      const rGraph = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${REPO_ID_UPPER}/graph`,
      });
      expect(rGraph.statusCode).toBe(200);
      expect(parseBody(rGraph, repositoryGraphViewResponseSchema).view.hubThreshold).toBe(42);
      expect(graphCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repoId: REPO_ID,
          level: 'file',
          includeImports: true,
          hubThreshold: 42,
        }),
      );

      const rHead = await app.inject({
        method: 'HEAD',
        url: `/api/v1/repos/${REPO_ID_UPPER}/graph`,
      });
      expect(rHead.statusCode).toBe(200);
      expect(rHead.body).toBe('');

      const rDetail = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${REPO_ID_UPPER}/nodes/${NODE_ID_UPPER}`,
      });
      expect(rDetail.statusCode).toBe(200);
      expect(parseBody(rDetail, nodeDetailResponseSchema).node.snippet).toBe('export const x = 1;');

      const rEdges = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${REPO_ID_UPPER}/nodes/${NODE_ID_UPPER}/edges?direction=outgoing&edgeType=CALLS&limit=10`,
      });
      expect(rEdges.statusCode).toBe(200);
      expect(parseBody(rEdges, nodeEdgesResponseSchema).items).toHaveLength(1);

      const rBlast = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${REPO_ID_UPPER}/nodes/${NODE_ID_UPPER}/blast-radius`,
      });
      expect(rBlast.statusCode).toBe(200);
      expect(parseBody(rBlast, blastRadiusResponseSchema).params.maxDepth).toBe(2);

      const rHubs = await app.inject({ method: 'GET', url: `/api/v1/repos/${REPO_ID_UPPER}/hubs` });
      expect(rHubs.statusCode).toBe(200);
      expect(parseBody(rHubs, repositoryHubsResponseSchema).threshold).toBe(42);

      const invalidUrls = [
        `/api/v1/repos/not-a-uuid/graph`,
        `/api/v1/repos/${REPO_ID}/graph?unknown=1`,
        `/api/v1/repos/${REPO_ID}/graph?level=file&level=folder`,
        `/api/v1/repos/${REPO_ID}/graph?includeImports=yes`,
        `/api/v1/repos/${REPO_ID}/graph?includeImports=1`,
        `/api/v1/repos/${REPO_ID}/graph?hubThreshold=0`,
        `/api/v1/repos/${REPO_ID}/graph?hubThreshold=10001`,
        `/api/v1/repos/${REPO_ID}/graph?hubThreshold=1.5`,
        `/api/v1/repos/${REPO_ID}/graph?level=function&scopeNodeId=${NODE_ID}&filePath=src/a.ts`,
        `/api/v1/repos/${REPO_ID}/graph?level=file&filePath=src/a.ts`,
        `/api/v1/repos/${REPO_ID}/nodes/${NODE_ID}/blast-radius?maxDepth=0`,
        `/api/v1/repos/${REPO_ID}/nodes/${NODE_ID}/blast-radius?maxDepth=4`,
        `/api/v1/repos/${REPO_ID}/nodes/${NODE_ID}/blast-radius?maxDepth=1&maxDepth=2`,
        `/api/v1/repos/${REPO_ID}/hubs?limit=101`,
        `/api/v1/repos/${REPO_ID}/hubs?cursor=${'a'.repeat(MAX_GRAPH_CURSOR_CHARS + 1)}`,
      ];
      for (const badUrl of invalidUrls) {
        const res = await app.inject({ method: 'GET', url: badUrl });
        expect(res.statusCode, `Expected 400 for ${badUrl}`).toBe(400);
        expect(parseBody(res, apiErrorSchema).error.code).toBe('VALIDATION_ERROR');
      }
    } finally {
      await app.close();
    }
  });

  it('uses fixed public messages, validates details strictly, distinguishes timeouts vs cancellations vs connections, sanitizes logs, and rejects extra response fields', async () => {
    const codeTable: readonly [GraphQueryErrorCode, number, string][] = [
      ['INVALID_QUERY', 400, 'VALIDATION_ERROR'],
      ['INVALID_CURSOR', 400, 'INVALID_CURSOR'],
      ['REPO_NOT_FOUND', 404, 'REPO_NOT_FOUND'],
      ['NODE_NOT_FOUND', 404, 'NODE_NOT_FOUND'],
      ['GRAPH_NOT_READY', 409, 'GRAPH_NOT_READY'],
      ['LEGACY_GRAPH_UNAVAILABLE', 409, 'LEGACY_GRAPH_UNAVAILABLE'],
      ['REPO_INGESTION_FAILED', 409, 'REPO_INGESTION_FAILED'],
      ['REPO_SUPERSEDED', 409, 'REPO_SUPERSEDED'],
      ['REPO_EXPIRED', 410, 'REPO_EXPIRED'],
      ['INVALID_SCOPE_NODE', 422, 'INVALID_SCOPE_NODE'],
      ['GRAPH_SCOPE_REQUIRED', 422, 'GRAPH_SCOPE_REQUIRED'],
      ['GRAPH_BUDGET_EXCEEDED', 422, 'GRAPH_BUDGET_EXCEEDED'],
      ['BLAST_RADIUS_BUDGET_EXCEEDED', 422, 'BLAST_RADIUS_BUDGET_EXCEEDED'],
      ['GRAPH_RESPONSE_TOO_LARGE', 422, 'GRAPH_RESPONSE_TOO_LARGE'],
      ['GRAPH_CONTAINMENT_INVALID', 500, 'GRAPH_DATA_INTEGRITY_ERROR'],
    ];

    let nextImpl: () => Promise<RepositoryGraphViewResponse> = () =>
      Promise.resolve(makeGraphFixture());
    const graphRepo = makeMockGraphRepo({ getRepositoryGraph: () => nextImpl() });
    const { logger, recorded } = makeSpiedLogger();

    const app = await buildApp({
      env: makeEnv(),
      logger,
      repository: makeUnusedIngestionRepo(),
      graphQueryRepository: graphRepo,
      checkDbHealth: () => Promise.resolve(true),
      githubPrecheck: dummyPrecheck,
      enqueuer: createStubIngestionEnqueuer(logger),
    });

    try {
      for (const [gqCode, expectedStatus, expectedApiCode] of codeTable) {
        nextImpl = () =>
          Promise.reject(
            new GraphQueryError(gqCode, `ARBITRARY_SECRET_MSG_${gqCode}`, {
              status: 'parsing',
              suggestedLevel: 'file',
              stage: 'INVALID STAGE WITH SECRET',
              errorCode: 'bad lower secret',
              maxScannedNodes: 99_999_999,
              hop: 2,
              rogueKey: 'SECRET_DETAIL_LEAK',
            }),
          );
        const res = await app.inject({ method: 'GET', url: `/api/v1/repos/${REPO_ID}/graph` });
        expect(res.statusCode).toBe(expectedStatus);
        const body = parseBody(res, apiErrorSchema);
        expect(body.error.code).toBe(expectedApiCode);
        expect(res.body).not.toContain(`ARBITRARY_SECRET_MSG_${gqCode}`);
        expect(res.body).not.toContain('SECRET_DETAIL_LEAK');
        expect(res.body).not.toContain('INVALID STAGE');
        expect(res.body).not.toContain('bad lower secret');
        expect(body.error.details?.maxScannedNodes).toBeUndefined();
      }

      // 1. Confirmed 57014 statement timeout -> 504 GRAPH_QUERY_TIMEOUT
      nextImpl = () =>
        Promise.reject(
          Object.assign(
            new Error('canceling statement due to statement timeout; SELECT secret_sql'),
            {
              code: '57014',
            },
          ),
        );
      const rStmt = await app.inject({ method: 'GET', url: `/api/v1/repos/${REPO_ID}/graph` });
      expect(rStmt.statusCode).toBe(504);
      expect(parseBody(rStmt, apiErrorSchema).error.code).toBe('GRAPH_QUERY_TIMEOUT');

      // 2. Confirmed 25P04 transaction timeout -> 504 GRAPH_QUERY_TIMEOUT
      nextImpl = () =>
        Promise.reject(
          Object.assign(new Error('terminating connection due to transaction timeout'), {
            code: '25P04',
          }),
        );
      const rTx = await app.inject({ method: 'GET', url: `/api/v1/repos/${REPO_ID}/graph` });
      expect(rTx.statusCode).toBe(504);
      expect(parseBody(rTx, apiErrorSchema).error.code).toBe('GRAPH_QUERY_TIMEOUT');

      // 3. Generic 57014 user cancellation wrapped in misleading timeout message -> 503 GRAPH_QUERY_CANCELED
      nextImpl = () =>
        Promise.reject(
          new Error('canceling statement due to statement timeout', {
            cause: Object.assign(new Error('canceling statement due to user request'), {
              code: '57014',
            }),
          }),
        );
      const rCancel = await app.inject({ method: 'GET', url: `/api/v1/repos/${REPO_ID}/graph` });
      expect(rCancel.statusCode).toBe(503);
      expect(parseBody(rCancel, apiErrorSchema).error.code).toBe('GRAPH_QUERY_CANCELED');

      // 4. Wrapped connection error -> 503 DATABASE_ERROR
      nextImpl = () =>
        Promise.reject(new DbError('DB_CONNECTION_ERROR', 'conn refused secret_param'));
      const rConn = await app.inject({ method: 'GET', url: `/api/v1/repos/${REPO_ID}/graph` });
      expect(rConn.statusCode).toBe(503);
      expect(parseBody(rConn, apiErrorSchema).error.code).toBe('DATABASE_ERROR');

      // 5. Unrelated message with custom error subclass name -> 500 INTERNAL_ERROR & zero name/message leak
      class SecretErrorName extends Error {
        constructor() {
          super('canceling statement due to statement timeout SENSITIVE_PARAM_999');
          this.name = 'SecretErrorName_LEAK';
        }
      }
      nextImpl = () => Promise.reject(new SecretErrorName());
      const rUnk = await app.inject({ method: 'GET', url: `/api/v1/repos/${REPO_ID}/graph` });
      expect(rUnk.statusCode).toBe(500);
      expect(parseBody(rUnk, apiErrorSchema).error.code).toBe('INTERNAL_ERROR');

      // 6. Strict response validation rejects leaked snippet without silent stripping
      nextImpl = () => {
        const bad = makeGraphFixture();
        const leakedNode = { ...bad.nodes[0], snippet: 'SECRET_SNIPPET_MUST_NOT_STRIP' };
        return Promise.resolve({
          ...bad,
          nodes: [leakedNode],
        } as unknown as RepositoryGraphViewResponse);
      };
      const rStrip = await app.inject({ method: 'GET', url: `/api/v1/repos/${REPO_ID}/graph` });
      expect(rStrip.statusCode).toBe(500);
      expect(parseBody(rStrip, apiErrorSchema).error.code).toBe('INTERNAL_ERROR');

      const allLogs = JSON.stringify(recorded);
      expect(allLogs).not.toContain('SENSITIVE_PARAM_999');
      expect(allLogs).not.toContain('SecretErrorName_LEAK');
      expect(allLogs).not.toContain('secret_sql');
      expect(allLogs).not.toContain('secret_param');
      expect(allLogs).not.toContain('SECRET_SNIPPET_MUST_NOT_STRIP');
    } finally {
      await app.close();
    }
  });

  function createTestBarrier() {
    let release!: () => void;

    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });

    return { promise, release };
  }

  it('releases admission permits idempotently and rejects admission after stop', () => {
    const gate = createGraphQueryAdmissionGate(1);
    const release = gate.tryAcquire();

    expect(release).not.toBeNull();
    expect(gate.getInFlightCount()).toBe(1);
    expect(gate.tryAcquire()).toBeNull();

    release?.();
    release?.();

    expect(gate.getInFlightCount()).toBe(0);

    gate.stop();
    expect(gate.isStopped()).toBe(true);
    expect(gate.tryAcquire()).toBeNull();
  });

  it.each([
    { embedded: true, expectedCap: 2 },
    { embedded: false, expectedCap: 3 },
  ])(
    'enforces default admission cap $expectedCap and releases rejected queries',
    async ({ embedded, expectedCap }) => {
      const entered = createTestBarrier();
      const work = createTestBarrier();
      let calls = 0;

      const capRepo = makeMockGraphRepo({
        getRepositoryGraph: async () => {
          const callIndex = calls;
          calls += 1;

          if (calls === expectedCap) {
            entered.release();
          }

          await work.promise;

          if (callIndex === 0) {
            throw new GraphQueryError('NODE_NOT_FOUND', 'Simulated rejected query');
          }

          return makeGraphFixture();
        },
      });

      const { logger } = makeSpiedLogger();

      const app = await buildApp({
        env: makeEnv({ RUN_EMBEDDED_WORKER: embedded }),
        logger,
        repository: makeUnusedIngestionRepo(),
        graphQueryRepository: capRepo,
        checkDbHealth: () => Promise.resolve(true),
        githubPrecheck: dummyPrecheck,
        enqueuer: createStubIngestionEnqueuer(logger),
      });

      const pending = Array.from({ length: expectedCap }, () =>
        app.inject({
          method: 'GET',
          url: `/api/v1/repos/${REPO_ID}/graph`,
        }),
      );

      const observed = Promise.allSettled(pending);

      try {
        await withTimeout(entered.promise, 5_000, `admission cap ${String(expectedCap)} entered`);

        const busyGet = await withTimeout(
          app.inject({
            method: 'GET',
            url: `/api/v1/repos/${REPO_ID}/hubs`,
          }),
          5_000,
          'busy GET response',
        );

        expect(busyGet.statusCode).toBe(503);
        expect(parseBody(busyGet, apiErrorSchema).error.code).toBe('GRAPH_QUERY_BUSY');
        expect(busyGet.headers['retry-after']).toBe('1');

        const busyHead = await withTimeout(
          app.inject({
            method: 'HEAD',
            url: `/api/v1/repos/${REPO_ID}/hubs`,
          }),
          5_000,
          'busy HEAD response',
        );

        expect(busyHead.statusCode).toBe(503);

        work.release();

        const completed = await withTimeout(
          Promise.all(pending),
          5_000,
          'admitted request settlement',
        );

        expect(completed.map((res) => res.statusCode).sort((a, b) => a - b)).toEqual([
          ...Array.from({ length: expectedCap - 1 }, () => 200),
          404,
        ]);

        const recovered = await app.inject({
          method: 'GET',
          url: `/api/v1/repos/${REPO_ID}/hubs`,
        });

        expect(recovered.statusCode).toBe(200);
      } finally {
        work.release();

        try {
          await withTimeout(observed, 5_000, 'cap test cleanup');
        } finally {
          await withTimeout(app.close(), 5_000, 'cap app close');
        }
      }
    },
    30_000,
  );

  it('retains the admission permit after a real TCP client disconnect', async () => {
    const entered = createTestBarrier();
    const work = createTestBarrier();
    const admission = createGraphQueryAdmissionGate(1);
    const { logger } = makeSpiedLogger();

    const slowRepo = makeMockGraphRepo({
      getRepositoryGraph: async () => {
        entered.release();
        await work.promise;
        return makeGraphFixture();
      },
    });

    const app = await buildApp({
      env: makeEnv(),
      logger,
      repository: makeUnusedIngestionRepo(),
      graphQueryRepository: slowRepo,
      graphQueryAdmission: admission,
      checkDbHealth: () => Promise.resolve(true),
      githubPrecheck: dummyPrecheck,
      enqueuer: createStubIngestionEnqueuer(logger),
    });

    let request: ReturnType<typeof http.get> | undefined;

    try {
      const address = await app.listen({
        host: '127.0.0.1',
        port: 0,
      });

      const rawRequest = http.get(`${address}/api/v1/repos/${REPO_ID}/graph`, {
        agent: false,
        headers: { connection: 'close' },
      });

      request = rawRequest;
      rawRequest.on('error', () => undefined);

      const clientClosed = new Promise<void>((resolve) => {
        rawRequest.once('close', resolve);
      });

      await withTimeout(entered.promise, 5_000, 'disconnect query entered');

      expect(admission.getInFlightCount()).toBe(1);

      rawRequest.destroy();

      await withTimeout(clientClosed, 5_000, 'TCP client closed');

      expect(admission.getInFlightCount()).toBe(1);

      const busy = await withTimeout(
        app.inject({
          method: 'GET',
          url: `/api/v1/repos/${REPO_ID}/hubs`,
        }),
        5_000,
        'busy response after disconnect',
      );

      expect(busy.statusCode).toBe(503);
      expect(parseBody(busy, apiErrorSchema).error.code).toBe('GRAPH_QUERY_BUSY');

      work.release();

      await withTimeout(admission.waitForIdle(), 5_000, 'disconnected query settlement');

      expect(admission.getInFlightCount()).toBe(0);

      const recovered = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${REPO_ID}/hubs`,
      });

      expect(recovered.statusCode).toBe(200);
    } finally {
      work.release();
      request?.destroy();

      await withTimeout(app.close(), 5_000, 'disconnect app close');
    }
  }, 30_000);

  it('stops new admission and drains active graph work during shutdown', async () => {
    const entered = createTestBarrier();
    const work = createTestBarrier();
    const admission = createGraphQueryAdmissionGate(1);
    const { logger } = makeSpiedLogger();

    const slowRepo = makeMockGraphRepo({
      getRepositoryGraph: async () => {
        entered.release();
        await work.promise;
        return makeGraphFixture();
      },
    });

    const app = await buildApp({
      env: makeEnv(),
      logger,
      repository: makeUnusedIngestionRepo(),
      graphQueryRepository: slowRepo,
      graphQueryAdmission: admission,
      checkDbHealth: () => Promise.resolve(true),
      githubPrecheck: dummyPrecheck,
      enqueuer: createStubIngestionEnqueuer(logger),
    });

    let request: ReturnType<typeof http.get> | undefined;
    let shutdown: Promise<void> | undefined;

    const closeState = { settled: false };

    try {
      const address = await app.listen({
        host: '127.0.0.1',
        port: 0,
      });

      const rawRequest = http.get(`${address}/api/v1/repos/${REPO_ID}/graph`, {
        agent: false,
        headers: { connection: 'close' },
      });

      request = rawRequest;

      const clientFinished = new Promise<number>((resolve, reject) => {
        rawRequest.once('response', (response) => {
          response.once('error', reject);
          response.once('end', () => {
            resolve(response.statusCode ?? 0);
          });
          response.resume();
        });

        rawRequest.once('error', reject);
        rawRequest.once('close', () => {
          reject(new Error('HTTP connection closed before response completed'));
        });
      });

      void clientFinished.catch(() => undefined);

      await withTimeout(entered.promise, 5_000, 'shutdown query entered');

      expect(admission.getInFlightCount()).toBe(1);

      shutdown = app.close().then(() => {
        closeState.settled = true;
      });

      void shutdown.catch(() => undefined);

      const deadline = Date.now() + 3_000;

      while (!admission.isStopped() && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }

      expect(admission.isStopped()).toBe(true);

      const unexpectedPermit = admission.tryAcquire();
      unexpectedPermit?.();

      expect(unexpectedPermit).toBeNull();
      expect(closeState.settled).toBe(false);
      expect(admission.getInFlightCount()).toBe(1);

      work.release();

      expect(await withTimeout(clientFinished, 5_000, 'active HTTP response completion')).toBe(200);

      await withTimeout(shutdown, 5_000, 'application shutdown drain');

      expect(closeState.settled).toBe(true);
      expect(admission.getInFlightCount()).toBe(0);
    } finally {
      work.release();
      request?.destroy();

      shutdown ??= app.close();

      await withTimeout(shutdown, 5_000, 'shutdown test cleanup');
    }
  }, 30_000);

  it('shares one graph-read bucket across all 5 routes + HEAD + multiple repos, isolates IPs & ingestion, and fails open on Redis outage while admission still protects', async () => {
    const graphRepo = makeMockGraphRepo();
    const { logger } = makeSpiedLogger();

    // 1. In-memory shared bucket across all 5 routes + HEAD + 2 repoIds + independent IPs
    const memApp = await buildApp({
      env: makeEnv({ INGEST_RATE_LIMIT_PER_HOUR: 2 }),
      logger,
      repository: makeUnusedIngestionRepo(),
      graphQueryRepository: graphRepo,
      graphRateLimitMax: 5,
      graphRateLimitWindowMs: 60_000,
      checkDbHealth: () => Promise.resolve(true),
      githubPrecheck: dummyPrecheck,
      enqueuer: createStubIngestionEnqueuer(logger),
    });
    try {
      const urls = [
        { method: 'GET' as const, url: `/api/v1/repos/${REPO_ID}/graph` },
        { method: 'HEAD' as const, url: `/api/v1/repos/${REPO_ID_2}/nodes/${NODE_ID}` },
        { method: 'GET' as const, url: `/api/v1/repos/${REPO_ID}/nodes/${NODE_ID}/edges` },
        { method: 'GET' as const, url: `/api/v1/repos/${REPO_ID_2}/nodes/${NODE_ID}/blast-radius` },
        { method: 'GET' as const, url: `/api/v1/repos/${REPO_ID}/hubs` },
      ];
      for (const req of urls) {
        const res = await memApp.inject({ ...req, remoteAddress: '203.0.113.10' });
        expect(res.statusCode).toBe(200);
      }
      const blocked = await memApp.inject({
        method: 'GET',
        url: `/api/v1/repos/${REPO_ID}/graph`,
        remoteAddress: '203.0.113.10',
      });
      expect(blocked.statusCode).toBe(429);
      const errBody = parseBody(blocked, apiErrorSchema);
      expect(errBody.error.code).toBe('RATE_LIMITED');
      expect(errBody.error.message).toBe(
        'Graph query rate limit exceeded. Please try again later.',
      );

      // Independent IP is unaffected
      const otherIp = await memApp.inject({
        method: 'GET',
        url: `/api/v1/repos/${REPO_ID}/graph`,
        remoteAddress: '203.0.113.11',
      });
      expect(otherIp.statusCode).toBe(200);

      // Ingestion bucket on same IP is unaffected (400 validation, NOT 429)
      const ingestCheck = await memApp.inject({
        method: 'POST',
        url: '/api/v1/repos',
        remoteAddress: '203.0.113.10',
        payload: {},
      });
      expect(ingestCheck.statusCode).toBe(400);
    } finally {
      await memApp.close();
    }

    // 2. Redis unavailable (fail-open via skipOnError) MUST allow rate limit to pass while admission STILL protects!
    let markSlowEntered!: () => void;
    let releaseSlow!: () => void;
    const slowEntered = new Promise<void>((r) => {
      markSlowEntered = r;
    });
    const downRedis: RedisRateLimitClient = {
      status: 'reconnecting',
      eval: () => Promise.reject(new Error('Redis offline')),
    };
    const downStoreCtor = createRedisRateLimitStore({ client: downRedis, logger });
    const downAdmission = createGraphQueryAdmissionGate(1);
    const downRepo = makeMockGraphRepo({
      getRepositoryGraph: () =>
        new Promise<RepositoryGraphViewResponse>((resolve) => {
          markSlowEntered();
          releaseSlow = () => {
            resolve(makeGraphFixture());
          };
        }),
    });

    const failOpenApp = await buildApp({
      env: makeEnv(),
      logger,
      repository: makeUnusedIngestionRepo(),
      graphQueryRepository: downRepo,
      graphQueryAdmission: downAdmission,
      rateLimitStore: createRedisRateLimitStoreConfig(downStoreCtor),
      graphRateLimitMax: 1,
      checkDbHealth: () => Promise.resolve(true),
      githubPrecheck: dummyPrecheck,
      enqueuer: createStubIngestionEnqueuer(logger),
    });

    const firstReq = failOpenApp
      .inject({ method: 'GET', url: `/api/v1/repos/${REPO_ID}/graph` })
      .catch((err: unknown) => err);
    try {
      await withTimeout(slowEntered, 5_000, 'fail-open slow query entered');
      // Even though Redis rate-limit failed open, concurrency admission STILL rejects 2nd request with 503!
      const secondReq = await failOpenApp.inject({
        method: 'GET',
        url: `/api/v1/repos/${REPO_ID}/hubs`,
      });
      expect(secondReq.statusCode).toBe(503);
      expect(parseBody(secondReq, apiErrorSchema).error.code).toBe('GRAPH_QUERY_BUSY');
    } finally {
      releaseSlow();
      await withTimeout(firstReq, 5_000, 'drain fail-open first request');
      await failOpenApp.close();
    }
  });
});
