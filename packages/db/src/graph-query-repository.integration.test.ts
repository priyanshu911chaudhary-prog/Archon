import { randomBytes, randomUUID } from 'node:crypto';
import {
  compareGraphAggregatedEdges,
  compareGraphNodeSummaries,
  loadEnv,
  sortEdgeTypesCanonical,
  type AnalysisOutput,
  type EdgeType,
  type ExtractedEdge,
  type ExtractedNode,
  type GraphAggregatedEdge,
  type GraphNodeSummary,
} from '@archon/shared';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPoolConfig,
  createDbClient,
  sanitizeDatabaseTarget,
  type DbClient,
} from './client.js';
import { DbError } from './errors.js';
import {
  GraphQueryError,
  HARD_MAX_GRAPH_QUERY_LIMITS,
  runBoundedReadTransaction,
  validateGraphQueryLimits,
} from './graph-query-helpers.js';
import { createGraphQueryRepository, type GraphQueryRepository } from './graph-query-repository.js';
import { runMigrations } from './migrate.js';
import { createIngestionRepository, type IngestionRepository } from './repository.js';
import {
  MAX_QUALIFIED_NAME_UTF8_BYTES,
  edges,
  nodes,
  repositories,
  type EdgeRecord,
  type NodeRecord,
} from './schema.js';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

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

function replaceDatabaseName(databaseUrl: string, newDbName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${newDbName}`;
  return parsed.toString();
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

async function publishFixtureRepo(
  ingestionRepo: IngestionRepository,
  params: {
    readonly owner: string;
    readonly name: string;
    readonly commitSha: string;
    readonly output: AnalysisOutput;
    readonly isSample?: boolean;
    readonly ttlDays?: number;
    readonly now: Date;
  },
) {
  const created = await ingestionRepo.createOrGetActive({
    githubUrl: `https://github.com/${params.owner}/${params.name}`,
    owner: params.owner,
    name: params.name,
    defaultBranch: 'main',
    commitSha: params.commitSha,
    sizeKb: 50,
    isSample: params.isSample ?? false,
    ttlDays: params.ttlDays ?? 7,
    now: params.now,
  });
  const claimed = await ingestionRepo.claimIngestionAttempt({
    repoId: created.repository.id,
    jobId: created.job.id,
    bullmqJobId: created.job.id,
    commitSha: params.commitSha,
    attemptGeneration: 1,
    now: params.now,
  });
  if (claimed.outcome !== 'claimed') throw new Error('Expected claim');
  await ingestionRepo.transitionJobStage(claimed.ownership, {
    toStatus: 'building_graph',
    progressPct: 85,
    now: params.now,
  });
  const pub = await ingestionRepo.publishRepositoryGraph(claimed.ownership, {
    output: params.output,
    extractionStats: {
      supportedFilesCount: params.output.stats.discoveredFilesCount,
      skippedFilesCount: 0,
      oversizedSupportedFilesCount: 0,
    },
    now: params.now,
  });
  if (pub.outcome !== 'published') throw new Error('Expected published');
  return pub;
}

async function expectGraphError(promise: Promise<unknown>, code: string): Promise<GraphQueryError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(GraphQueryError);
  if (!(caught instanceof GraphQueryError)) throw new Error('Expected GraphQueryError');
  expect(caught.code).toBe(code);
  return caught;
}

/**
 * Independent test-only in-memory graph oracle computing exact degrees, file-rollups,
 * and semantic-zoom projections directly from raw PostgreSQL `nodes` and `edges` rows.
 */
function runIndependentProjectionOracle(
  rawNodes: readonly NodeRecord[],
  rawEdges: readonly EdgeRecord[],
  params: {
    readonly level: 'folder' | 'file' | 'function';
    readonly scopeNodeId?: string;
    readonly includeImports: boolean;
    readonly hubThreshold: number;
  },
): { readonly nodes: GraphNodeSummary[]; readonly edges: GraphAggregatedEdge[] } {
  const nodeById = new Map(rawNodes.map((n) => [n.id, n]));
  const childrenByParent = new Map<string | null, NodeRecord[]>();
  for (const n of rawNodes) {
    const list = childrenByParent.get(n.parentNodeId) ?? [];
    list.push(n);
    childrenByParent.set(n.parentNodeId, list);
  }

  const collectDesc = (seeds: readonly NodeRecord[]) => {
    const map = new Map<string, string>();
    const all: NodeRecord[] = [];
    const queue: NodeRecord[] = [];
    for (const s of seeds) {
      map.set(s.id, s.id);
      all.push(s);
      queue.push(s);
    }
    for (const cur of queue) {
      for (const ch of childrenByParent.get(cur.id) ?? []) {
        map.set(ch.id, map.get(cur.id) ?? ch.id);
        all.push(ch);
        queue.push(ch);
      }
    }
    return { all, containerById: map };
  };

  // Independent degree & file-rollup calculation across full repo
  const degreeFor = (nodeId: string) => {
    const distinctSrc = new Set<string>();
    const distinctImp = new Set<string>();
    const distinctCall = new Set<string>();
    let rawCount = 0;
    for (const e of rawEdges) {
      if (e.targetNodeId === nodeId && e.sourceNodeId !== e.targetNodeId) {
        rawCount += 1;
        distinctSrc.add(e.sourceNodeId);
        if (e.edgeType === 'IMPORTS') distinctImp.add(e.sourceNodeId);
        else distinctCall.add(e.sourceNodeId);
      }
    }
    return {
      inDegreeDistinct: distinctSrc.size,
      rawIncomingEdgeCount: rawCount,
      distinctImporterCount: distinctImp.size,
      distinctCallerCount: distinctCall.size,
    };
  };

  const depFileCountFor = (filePath: string): number => {
    const extFiles = new Set<string>();
    for (const e of rawEdges) {
      if (e.sourceNodeId === e.targetNodeId) continue;
      const src = nodeById.get(e.sourceNodeId);
      const tgt = nodeById.get(e.targetNodeId);
      if (src === undefined || tgt === undefined) continue;
      if (tgt.filePath !== filePath || src.filePath === filePath) continue;
      if (
        (e.edgeType === 'IMPORTS' && tgt.nodeType === 'file') ||
        (e.edgeType === 'CALLS' &&
          tgt.nodeType !== 'folder' &&
          tgt.nodeType !== 'file' &&
          tgt.isExported)
      ) {
        extFiles.add(src.filePath);
      }
    }
    return extFiles.size;
  };

  let visible: NodeRecord[];
  let projectEndpoint: (nodeId: string) => string | undefined;
  let allowSelf = false;

  if (params.level === 'folder') {
    visible = childrenByParent.get(params.scopeNodeId ?? null) ?? [];
    const { containerById } = collectDesc(visible);
    projectEndpoint = (id) => containerById.get(id);
  } else if (params.level === 'file') {
    if (params.scopeNodeId !== undefined) {
      const scopeNode = nodeById.get(params.scopeNodeId);
      const { all } = scopeNode ? collectDesc([scopeNode]) : { all: [] };
      visible = all.filter((n) => n.nodeType === 'file');
      const fileByPath = new Map(visible.map((f) => [f.filePath, f.id]));
      const inSubtree = new Set(all.map((n) => n.id));
      projectEndpoint = (id) => {
        if (!inSubtree.has(id)) return undefined;
        const n = nodeById.get(id);
        if (n === undefined) return undefined;
        return n.nodeType === 'folder' ? undefined : fileByPath.get(n.filePath);
      };
    } else {
      visible = rawNodes.filter((n) => n.nodeType === 'file');
      const fileByPath = new Map(visible.map((f) => [f.filePath, f.id]));
      projectEndpoint = (id) => {
        const n = nodeById.get(id);
        if (n === undefined) return undefined;
        return n.nodeType === 'folder' ? undefined : fileByPath.get(n.filePath);
      };
    }
  } else {
    allowSelf = true;
    if (params.scopeNodeId !== undefined) {
      const scopeNode = nodeById.get(params.scopeNodeId);
      visible = scopeNode ? collectDesc([scopeNode]).all : [];
    } else {
      visible = [...rawNodes];
    }
    const visSet = new Set(visible.map((n) => n.id));
    projectEndpoint = (id) => (visSet.has(id) ? id : undefined);
  }

  const aggMap = new Map<
    string,
    {
      sourceNodeId: string;
      targetNodeId: string;
      edgeTypes: Set<EdgeType>;
      importEdgeCount: number;
      callEdgeCount: number;
      callPairs: Set<string>;
      minCallSiteLine: number | null;
    }
  >();

  for (const e of rawEdges) {
    if (!params.includeImports && e.edgeType === 'IMPORTS') continue;
    const s = projectEndpoint(e.sourceNodeId);
    const t = projectEndpoint(e.targetNodeId);
    if (s === undefined || t === undefined) continue;
    if (!allowSelf && s === t) continue;
    const key = `${s}\0${t}`;
    const cur = aggMap.get(key) ?? {
      sourceNodeId: s,
      targetNodeId: t,
      edgeTypes: new Set<EdgeType>(),
      importEdgeCount: 0,
      callEdgeCount: 0,
      callPairs: new Set<string>(),
      minCallSiteLine: null,
    };
    cur.edgeTypes.add(e.edgeType);
    if (e.edgeType === 'IMPORTS') cur.importEdgeCount += 1;
    else {
      cur.callEdgeCount += 1;
      cur.callPairs.add(`${e.sourceNodeId}\0${e.targetNodeId}`);
      if (
        e.callSiteLine !== null &&
        (cur.minCallSiteLine === null || e.callSiteLine < cur.minCallSiteLine)
      ) {
        cur.minCallSiteLine = e.callSiteLine;
      }
    }
    aggMap.set(key, cur);
  }

  const outNodes: GraphNodeSummary[] = visible
    .map((n) => {
      const d = degreeFor(n.id);
      const depFiles = n.nodeType === 'file' ? depFileCountFor(n.filePath) : null;
      return {
        id: n.id,
        nodeType: n.nodeType,
        name: n.name,
        qualifiedName: n.qualifiedName,
        filePath: n.filePath,
        parentNodeId: n.parentNodeId,
        isExported: n.isExported,
        startLine: n.startLine,
        endLine: n.endLine,
        ...d,
        dependentFileCount: depFiles,
        isHub: d.inDegreeDistinct > params.hubThreshold,
        isFileRollupHub: depFiles !== null ? depFiles > params.hubThreshold : null,
      };
    })
    .sort(compareGraphNodeSummaries);

  const outEdges: GraphAggregatedEdge[] = [...aggMap.values()]
    .map((e) => ({
      sourceNodeId: e.sourceNodeId,
      targetNodeId: e.targetNodeId,
      edgeTypes: sortEdgeTypesCanonical(e.edgeTypes),
      importEdgeCount: e.importEdgeCount,
      callEdgeCount: e.callEdgeCount,
      distinctCallPairs: e.callPairs.size,
      minCallSiteLine: e.minCallSiteLine,
      isSelfEdge: e.sourceNodeId === e.targetNodeId,
    }))
    .sort(compareGraphAggregatedEdges);

  return { nodes: outNodes, edges: outEdges };
}

/**
 * Rich fixture with root file, nested folders, and nested class -> method -> inner symbol
 * cross-file CALLS (proving containment expansion traverses beyond folders/files).
 */
function makeNestedClassGraph(): AnalysisOutput {
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
      nodeType: 'folder',
      name: 'lib',
      qualifiedName: 'folder:src/lib',
      filePath: 'src/lib',
      parentQualifiedName: 'folder:src',
      isExported: false,
      startLine: null,
      endLine: null,
      contentHash: null,
      snippet: null,
    },
    {
      nodeType: 'folder',
      name: 'app',
      qualifiedName: 'folder:src/app',
      filePath: 'src/app',
      parentQualifiedName: 'folder:src',
      isExported: false,
      startLine: null,
      endLine: null,
      contentHash: null,
      snippet: null,
    },
    {
      nodeType: 'file',
      name: 'root.ts',
      qualifiedName: 'file:root.ts',
      filePath: 'root.ts',
      parentQualifiedName: null,
      isExported: false,
      startLine: 1,
      endLine: 4,
      contentHash: H1,
      snippet: "import { App } from './src/app/main.js';\nnew App().start();",
    },
    {
      nodeType: 'file',
      name: 'main.ts',
      qualifiedName: 'file:src/app/main.ts',
      filePath: 'src/app/main.ts',
      parentQualifiedName: 'folder:src/app',
      isExported: false,
      startLine: 1,
      endLine: 10,
      contentHash: H2,
      snippet:
        "import { Engine } from '../lib/engine.js';\nexport class App { start() { new Engine().compute(1); new Engine().compute(2); } }",
    },
    {
      nodeType: 'file',
      name: 'engine.ts',
      qualifiedName: 'file:src/lib/engine.ts',
      filePath: 'src/lib/engine.ts',
      parentQualifiedName: 'folder:src/lib',
      isExported: false,
      startLine: 1,
      endLine: 10,
      contentHash: H3,
      snippet:
        'export class Engine { compute(n: number): number { return n > 0 ? this.compute(n - 1) : 0; } }',
    },
    {
      nodeType: 'function',
      name: 'entry',
      qualifiedName: 'root.ts::fn:entry',
      filePath: 'root.ts',
      parentQualifiedName: 'file:root.ts',
      isExported: true,
      startLine: 2,
      endLine: 4,
      contentHash: H1,
      snippet: 'export function entry() { new App().start(); }',
    },
    {
      nodeType: 'class',
      name: 'App',
      qualifiedName: 'src/app/main.ts::class:App',
      filePath: 'src/app/main.ts',
      parentQualifiedName: 'file:src/app/main.ts',
      isExported: true,
      startLine: 2,
      endLine: 9,
      contentHash: H2,
      snippet: 'export class App { start() {} }',
    },
    {
      nodeType: 'function',
      name: 'start',
      qualifiedName: 'src/app/main.ts::class:App::method:start',
      filePath: 'src/app/main.ts',
      parentQualifiedName: 'src/app/main.ts::class:App',
      isExported: true,
      startLine: 3,
      endLine: 8,
      contentHash: H2,
      snippet: 'start() { new Engine().compute(1); new Engine().compute(2); }',
    },
    {
      nodeType: 'class',
      name: 'Engine',
      qualifiedName: 'src/lib/engine.ts::class:Engine',
      filePath: 'src/lib/engine.ts',
      parentQualifiedName: 'file:src/lib/engine.ts',
      isExported: true,
      startLine: 1,
      endLine: 9,
      contentHash: H3,
      snippet: 'export class Engine { compute(n: number) {} }',
    },
    {
      nodeType: 'function',
      name: 'compute',
      qualifiedName: 'src/lib/engine.ts::class:Engine::method:compute',
      filePath: 'src/lib/engine.ts',
      parentQualifiedName: 'src/lib/engine.ts::class:Engine',
      isExported: true,
      startLine: 2,
      endLine: 8,
      contentHash: H3,
      snippet: 'compute(n: number): number { return n > 0 ? this.compute(n - 1) : 0; }',
    },
  ];
  const gEdges: ExtractedEdge[] = [
    {
      sourceQualifiedName: 'file:root.ts',
      targetQualifiedName: 'file:src/app/main.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
    {
      sourceQualifiedName: 'file:src/app/main.ts',
      targetQualifiedName: 'file:src/lib/engine.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
    // Cross-file calls targeting nested class methods!
    {
      sourceQualifiedName: 'root.ts::fn:entry',
      targetQualifiedName: 'src/app/main.ts::class:App::method:start',
      edgeType: 'CALLS',
      callSiteLine: 3,
      callSiteSnippet: 'new App().start()',
    },
    {
      sourceQualifiedName: 'src/app/main.ts::class:App::method:start',
      targetQualifiedName: 'src/lib/engine.ts::class:Engine::method:compute',
      edgeType: 'CALLS',
      callSiteLine: 4,
      callSiteSnippet: 'new Engine().compute(1)',
    },
    {
      sourceQualifiedName: 'src/app/main.ts::class:App::method:start',
      targetQualifiedName: 'src/lib/engine.ts::class:Engine::method:compute',
      edgeType: 'CALLS',
      callSiteLine: 5,
      callSiteSnippet: 'new Engine().compute(2)',
    },
    {
      sourceQualifiedName: 'src/lib/engine.ts::class:Engine::method:compute',
      targetQualifiedName: 'src/lib/engine.ts::class:Engine::method:compute',
      edgeType: 'CALLS',
      callSiteLine: 6,
      callSiteSnippet: 'this.compute(n - 1)',
    },
  ];
  return makeOutput(gNodes, gEdges);
}

describe('GraphQueryRepository (PostgreSQL 17 integration)', () => {
  const testDbName = `archon_gq_test_${randomBytes(6).toString('hex')}`;
  let adminPool: Pool | undefined;
  let clientA: DbClient | undefined;
  let clientB: DbClient | undefined;
  let ingestionRepo: IngestionRepository;
  let graphRepo: GraphQueryRepository;

  beforeAll(async () => {
    const env = loadEnv();
    const adminTarget = sanitizeDatabaseTarget(env.DATABASE_URL);
    adminPool = new Pool(buildPoolConfig({ databaseUrl: env.DATABASE_URL, max: 2 }));
    try {
      await adminPool.query('SELECT 1');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`PostgreSQL unreachable at ${adminTarget}: ${detail}`, { cause: err });
    }
    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    const isolatedUrl = replaceDatabaseName(env.DATABASE_URL, testDbName);
    clientA = createDbClient({ databaseUrl: isolatedUrl, max: 6 });
    clientB = createDbClient({ databaseUrl: isolatedUrl, max: 6 });
    await runMigrations(clientA.db);
    ingestionRepo = createIngestionRepository(clientA.db);
    graphRepo = createGraphQueryRepository(clientA.db);
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

  it('enforces persisted-ready gating across all lifecycle states and validates configured hard limits', async () => {
    if (clientA === undefined) throw new Error('Expected clientA');
    const t0 = new Date('2026-11-28T00:00:00.000Z');
    const tExpired = new Date('2026-12-10T00:00:00.000Z');

    // Configured limit hard ceilings & cross-limit consistency
    expect(() =>
      validateGraphQueryLimits({
        maxScannedRawEdges: HARD_MAX_GRAPH_QUERY_LIMITS.maxScannedRawEdges + 1,
      }),
    ).toThrow(DbError);
    expect(() => validateGraphQueryLimits({ maxScannedNodes: 100, maxReturnedNodes: 101 })).toThrow(
      DbError,
    );

    await expectGraphError(
      graphRepo.getRepositoryGraph({ repoId: randomUUID(), now: t0 }),
      'REPO_NOT_FOUND',
    );

    const queued = await ingestionRepo.createOrGetActive({
      githubUrl: 'https://github.com/gq-gate/queued',
      owner: 'gq-gate',
      name: 'queued',
      defaultBranch: 'main',
      commitSha: '1010101010101010101010101010101010101010',
      sizeKb: 10,
      now: t0,
    });
    await expectGraphError(
      graphRepo.getRepositoryGraph({ repoId: queued.repository.id, now: t0 }),
      'GRAPH_NOT_READY',
    );

    await ingestionRepo.failQueuedJobOnEnqueueError({
      repoId: queued.repository.id,
      jobId: queued.job.id,
      now: t0,
    });
    await expectGraphError(
      graphRepo.getRepositoryGraph({ repoId: queued.repository.id, now: t0 }),
      'REPO_INGESTION_FAILED',
    );

    const legacy = await ingestionRepo.createOrGetActive({
      githubUrl: 'https://github.com/gq-gate/legacy',
      owner: 'gq-gate',
      name: 'legacy',
      defaultBranch: 'main',
      commitSha: '2020202020202020202020202020202020202020',
      sizeKb: 10,
      initialStatus: 'ready',
      now: t0,
    });
    await expectGraphError(
      graphRepo.getRepositoryGraph({ repoId: legacy.repository.id, now: t0 }),
      'LEGACY_GRAPH_UNAVAILABLE',
    );
    await clientA.db
      .update(repositories)
      .set({ status: 'superseded' })
      .where(eq(repositories.id, legacy.repository.id));
    await expectGraphError(
      graphRepo.getRepositoryGraph({ repoId: legacy.repository.id, now: t0 }),
      'REPO_SUPERSEDED',
    );

    const empty = await ingestionRepo.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/gq-gate/empty',
      owner: 'gq-gate',
      name: 'empty',
      defaultBranch: 'main',
      commitSha: '3030303030303030303030303030303030303030',
      sizeKb: 10,
      ttlDays: 7,
      now: t0,
    });
    const emptyGraph = await graphRepo.getRepositoryGraph({
      repoId: empty.repository.id,
      now: new Date('2026-11-29T00:00:00.000Z'),
    });
    expect(emptyGraph.repository.emptyJsTs).toBe(true);
    expect(emptyGraph.nodes).toEqual([]);
    expect(emptyGraph.edges).toEqual([]);
    const reloaded = await ingestionRepo.findJobWithRepository(empty.job.id);
    expect(reloaded?.repository.expiresAt?.getTime()).toBe(empty.repository.expiresAt?.getTime());
    await expectGraphError(
      graphRepo.getRepositoryGraph({ repoId: empty.repository.id, now: tExpired }),
      'REPO_EXPIRED',
    );

    const sampleEmpty = await ingestionRepo.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/gq-gate/sample',
      owner: 'gq-gate',
      name: 'sample',
      defaultBranch: 'main',
      commitSha: '4040404040404040404040404040404040404040',
      sizeKb: 10,
      isSample: true,
      now: t0,
    });
    expect(
      (await graphRepo.getRepositoryGraph({ repoId: sampleEmpty.repository.id, now: tExpired }))
        .nodes,
    ).toEqual([]);
  });

  it('matches independent projection/degree oracle across nested class-method CALLS, all zoom levels, includeImports, repo isolation, and pre-aggregation raw-work limits', async () => {
    if (clientA === undefined) throw new Error('Expected clientA');
    const t0 = new Date('2026-11-28T01:00:00.000Z');
    const pub1 = await publishFixtureRepo(ingestionRepo, {
      owner: 'gq-zoom',
      name: 'nested-one',
      commitSha: '5151515151515151515151515151515151515151',
      output: makeNestedClassGraph(),
      now: t0,
    });
    const pub2 = await publishFixtureRepo(ingestionRepo, {
      owner: 'gq-zoom',
      name: 'nested-two',
      commitSha: '5252525252525252525252525252525252525252',
      output: makeNestedClassGraph(),
      now: t0,
    });

    const rawNodes = await clientA.db
      .select()
      .from(nodes)
      .where(eq(nodes.repoId, pub1.repository.id));
    const rawEdges = await clientA.db
      .select()
      .from(edges)
      .where(eq(edges.repoId, pub1.repository.id));
    const srcFolder = rawNodes.find((n) => n.qualifiedName === 'folder:src');
    const engineFile = rawNodes.find((n) => n.qualifiedName === 'file:src/lib/engine.ts');
    const computeMethod = rawNodes.find(
      (n) => n.qualifiedName === 'src/lib/engine.ts::class:Engine::method:compute',
    );
    if (!srcFolder || !engineFile || !computeMethod) throw new Error('Expected fixture nodes');

    // Exact parity against independent oracle across root/scoped folder, file, and function zoom with includeImports=true & false
    const oracleScenarios: readonly {
      readonly level: 'folder' | 'file' | 'function';
      readonly scopeNodeId?: string;
      readonly includeImports: boolean;
    }[] = [
      { level: 'folder', includeImports: true },
      { level: 'folder', includeImports: false },
      { level: 'folder', scopeNodeId: srcFolder.id, includeImports: true },
      { level: 'folder', scopeNodeId: srcFolder.id, includeImports: false },
      { level: 'file', includeImports: true },
      { level: 'file', includeImports: false },
      { level: 'file', scopeNodeId: srcFolder.id, includeImports: true },
      { level: 'file', scopeNodeId: srcFolder.id, includeImports: false },
      { level: 'function', includeImports: true },
      { level: 'function', includeImports: false },
      { level: 'function', scopeNodeId: srcFolder.id, includeImports: true },
      { level: 'function', scopeNodeId: engineFile.id, includeImports: true },
    ];

    for (const sc of oracleScenarios) {
      const actual = await graphRepo.getRepositoryGraph({
        repoId: pub1.repository.id,
        level: sc.level,
        scopeNodeId: sc.scopeNodeId,
        includeImports: sc.includeImports,
        hubThreshold: 30,
        now: t0,
      });
      const expected = runIndependentProjectionOracle(rawNodes, rawEdges, {
        ...sc,
        hubThreshold: 30,
      });
      expect(actual.nodes).toEqual(expected.nodes);
      expect(actual.edges).toEqual(expected.edges);
      expect(actual.nodes.every((n) => !('snippet' in n))).toBe(true);
      const visIds = new Set(actual.nodes.map((n) => n.id));
      expect(
        actual.edges.every((e) => visIds.has(e.sourceNodeId) && visIds.has(e.targetNodeId)),
      ).toBe(true);
    }

    // Explicitly verify nested class method compute() is included in filePath function zoom & projected into folder/file CALLS
    const folderScopedCallsOnly = await graphRepo.getRepositoryGraph({
      repoId: pub1.repository.id,
      level: 'folder',
      scopeNodeId: srcFolder.id,
      includeImports: false,
      now: t0,
    });
    expect(folderScopedCallsOnly.edges).toHaveLength(1);
    expect(folderScopedCallsOnly.edges[0]).toMatchObject({
      edgeTypes: ['CALLS'],
      importEdgeCount: 0,
      callEdgeCount: 2,
      distinctCallPairs: 1,
    });

    const fnByPath = await graphRepo.getRepositoryGraph({
      repoId: pub1.repository.id,
      level: 'function',
      filePath: 'src/lib/engine.ts',
      now: t0,
    });
    expect(fnByPath.nodes.map((n) => n.qualifiedName)).toEqual([
      'file:src/lib/engine.ts',
      'src/lib/engine.ts::class:Engine',
      'src/lib/engine.ts::class:Engine::method:compute',
    ]);

    // Deep ancestor walk for nested class method: folder:src -> folder:src/lib -> file:engine.ts -> class:Engine
    const computeDetail = await graphRepo.getNodeDetail({
      repoId: pub1.repository.id,
      nodeId: computeMethod.id,
      now: t0,
    });
    expect(computeDetail.ancestors.map((a) => a.qualifiedName)).toEqual([
      'folder:src',
      'folder:src/lib',
      'file:src/lib/engine.ts',
      'src/lib/engine.ts::class:Engine',
    ]);

    // Ancestor depth exhaustion fails loudly with GRAPH_BUDGET_EXCEEDED (never breaks silently)
    const depth1Repo = createGraphQueryRepository(clientA.db, {
      limits: { maxContainmentDepth: 1 },
    });
    await expectGraphError(
      depth1Repo.getNodeDetail({ repoId: pub1.repository.id, nodeId: computeMethod.id, now: t0 }),
      'GRAPH_BUDGET_EXCEEDED',
    );

    // Cross-repo isolation & scope conflict checks
    const pub2Files = await graphRepo.getRepositoryGraph({
      repoId: pub2.repository.id,
      level: 'file',
      now: t0,
    });
    await expectGraphError(
      graphRepo.getRepositoryGraph({
        repoId: pub1.repository.id,
        level: 'function',
        scopeNodeId: pub2Files.nodes[0]?.id,
        now: t0,
      }),
      'NODE_NOT_FOUND',
    );
    await expectGraphError(
      graphRepo.getRepositoryGraph({
        repoId: pub1.repository.id,
        level: 'function',
        scopeNodeId: engineFile.id,
        filePath: 'src/lib/engine.ts',
        now: t0,
      }),
      'INVALID_QUERY',
    );

    // Pre-aggregation raw-work limits covering external incoming-degree / rollup / child-count / edge-evidence queries
    const edgeCap1Repo = createGraphQueryRepository(clientA.db, {
      limits: { maxScannedRawEdges: 1, maxReturnedEdges: 1 },
    });
    // Scoped engine.ts has 0 internal non-self edges, but 3 external incoming edges (1 IMPORTS + 2 CALLS) -> caught BEFORE degree/rollup GROUP BY!
    await expectGraphError(
      edgeCap1Repo.getRepositoryGraph({
        repoId: pub1.repository.id,
        level: 'function',
        scopeNodeId: engineFile.id,
        now: t0,
      }),
      'GRAPH_BUDGET_EXCEEDED',
    );
    // getNodeEdges incident edge probe catches 3 incoming CALLS to compute() before join+sort
    await expectGraphError(
      edgeCap1Repo.getNodeEdges({
        repoId: pub1.repository.id,
        nodeId: computeMethod.id,
        direction: 'incoming',
        now: t0,
      }),
      'GRAPH_BUDGET_EXCEEDED',
    );
    // getNodeDetail child-count bound
    const nodeCap1Repo = createGraphQueryRepository(clientA.db, {
      limits: { maxScannedNodes: 1, maxReturnedNodes: 1 },
    });
    await expectGraphError(
      nodeCap1Repo.getNodeDetail({ repoId: pub1.repository.id, nodeId: srcFolder.id, now: t0 }),
      'GRAPH_BUDGET_EXCEEDED',
    );
    // Response byte cap
    const bytesCapRepo = createGraphQueryRepository(clientA.db, {
      limits: { maxResponseBytes: 100 },
    });
    await expectGraphError(
      bytesCapRepo.getRepositoryGraph({ repoId: pub1.repository.id, level: 'folder', now: t0 }),
      'GRAPH_RESPONSE_TOO_LARGE',
    );
  });

  it('enforces strict > threshold hub boundaries (29/30/31), distinct isHub vs isFileRollupHub, uppercase UUIDs, and 2048-byte UTF-8 identity pagination', async () => {
    const t0 = new Date('2026-11-28T02:00:00.000Z');
    const longQnPrefix = `src/targets.ts::fn:${'q'.repeat(MAX_QUALIFIED_NAME_UTF8_BYTES - 25)}`;
    const longFn31Qn = `${longQnPrefix}_fn31`;
    const longFn30Qn = `${longQnPrefix}_fn30`;
    expect(Buffer.byteLength(longFn31Qn, 'utf8')).toBeLessThanOrEqual(
      MAX_QUALIFIED_NAME_UTF8_BYTES,
    );
    expect(Buffer.byteLength(longFn31Qn, 'utf8')).toBeGreaterThan(2000);

    const hubNodes: ExtractedNode[] = [
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
        name: 'targets.ts',
        qualifiedName: 'file:src/targets.ts',
        filePath: 'src/targets.ts',
        parentQualifiedName: 'folder:src',
        isExported: false,
        startLine: 1,
        endLine: 20,
        contentHash: H1,
        snippet: 'export function fn31(){}',
      },
      {
        nodeType: 'function',
        name: 'fn29',
        qualifiedName: 'src/targets.ts::fn:fn29',
        filePath: 'src/targets.ts',
        parentQualifiedName: 'file:src/targets.ts',
        isExported: true,
        startLine: 1,
        endLine: 1,
        contentHash: H1,
        snippet: 'export function fn29(){}',
      },
      {
        nodeType: 'function',
        name: 'fn30',
        qualifiedName: longFn30Qn,
        filePath: 'src/targets.ts',
        parentQualifiedName: 'file:src/targets.ts',
        isExported: true,
        startLine: 2,
        endLine: 2,
        contentHash: H1,
        snippet: 'export function fn30(){}',
      },
      {
        nodeType: 'function',
        name: 'fn31',
        qualifiedName: longFn31Qn,
        filePath: 'src/targets.ts',
        parentQualifiedName: 'file:src/targets.ts',
        isExported: true,
        startLine: 3,
        endLine: 3,
        contentHash: H1,
        snippet: 'export function fn31(){}',
      },
      {
        nodeType: 'function',
        name: 'fnMultiLine',
        qualifiedName: 'src/targets.ts::fn:fnMultiLine',
        filePath: 'src/targets.ts',
        parentQualifiedName: 'file:src/targets.ts',
        isExported: true,
        startLine: 4,
        endLine: 4,
        contentHash: H1,
        snippet: 'export function fnMultiLine(){}',
      },
      {
        nodeType: 'function',
        name: 'fnSelf',
        qualifiedName: 'src/targets.ts::fn:fnSelf',
        filePath: 'src/targets.ts',
        parentQualifiedName: 'file:src/targets.ts',
        isExported: true,
        startLine: 5,
        endLine: 5,
        contentHash: H1,
        snippet: 'export function fnSelf(){}',
      },
    ];
    const hubEdges: ExtractedEdge[] = [];

    for (let i = 1; i <= 31; i += 1) {
      const fp = `src/c${String(i).padStart(2, '0')}.ts`;
      const fnQn = `${fp}::fn:call${String(i).padStart(2, '0')}`;
      hubNodes.push(
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
          name: `call${String(i).padStart(2, '0')}`,
          qualifiedName: fnQn,
          filePath: fp,
          parentQualifiedName: `file:${fp}`,
          isExported: true,
          startLine: 1,
          endLine: 5,
          contentHash: H2,
          snippet: 'export function c(){}',
        },
      );
      if (i <= 29)
        hubEdges.push({
          sourceQualifiedName: fnQn,
          targetQualifiedName: 'src/targets.ts::fn:fn29',
          edgeType: 'CALLS',
          callSiteLine: 1,
          callSiteSnippet: 'fn29()',
        });
      if (i <= 30)
        hubEdges.push({
          sourceQualifiedName: fnQn,
          targetQualifiedName: longFn30Qn,
          edgeType: 'CALLS',
          callSiteLine: 2,
          callSiteSnippet: 'fn30()',
        });
      hubEdges.push({
        sourceQualifiedName: fnQn,
        targetQualifiedName: longFn31Qn,
        edgeType: 'CALLS',
        callSiteLine: 3,
        callSiteSnippet: 'fn31()',
      });
    }
    for (let line = 10; line < 45; line += 1) {
      hubEdges.push({
        sourceQualifiedName: 'src/c01.ts::fn:call01',
        targetQualifiedName: 'src/targets.ts::fn:fnMultiLine',
        edgeType: 'CALLS',
        callSiteLine: line,
        callSiteSnippet: 'fnMultiLine()',
      });
      hubEdges.push({
        sourceQualifiedName: 'src/targets.ts::fn:fnSelf',
        targetQualifiedName: 'src/targets.ts::fn:fnSelf',
        edgeType: 'CALLS',
        callSiteLine: line,
        callSiteSnippet: 'fnSelf()',
      });
    }

    const pub = await publishFixtureRepo(ingestionRepo, {
      owner: 'gq-hubs',
      name: 'boundary',
      commitSha: '6161616161616161616161616161616161616161',
      output: makeOutput(hubNodes, hubEdges),
      now: t0,
    });
    const upperRepoId = pub.repository.id.toUpperCase();

    // Strict > 30: ONLY fn31 qualifies; 29, 30, multi-line (1/35), self-call (0/0) do not
    const hubs30 = await graphRepo.getRepositoryHubs({
      repoId: upperRepoId,
      threshold: 30,
      scope: 'all',
      now: t0,
    });
    expect(hubs30.totalHubs).toBe(1);
    expect(hubs30.items[0]).toMatchObject({
      qualifiedName: longFn31Qn,
      hubDegree: 31,
      inDegreeDistinct: 31,
      isHub: true,
      isFileRollupHub: null,
    });

    // Uppercase UUID + 2048-byte qualifiedName pagination on hubs (limit=1 at threshold=29)
    const p1 = await graphRepo.getRepositoryHubs({
      repoId: upperRepoId,
      threshold: 29,
      scope: 'callable',
      limit: 1,
      now: t0,
    });
    expect(p1.items[0]?.qualifiedName).toBe(longFn31Qn);
    expect(p1.page.nextCursor).not.toBeNull();
    await expectGraphError(
      graphRepo.getRepositoryHubs({
        repoId: upperRepoId,
        threshold: 28,
        scope: 'callable',
        limit: 1,
        cursor: p1.page.nextCursor ?? '',
        now: t0,
      }),
      'INVALID_CURSOR',
    );
    const p2 = await graphRepo.getRepositoryHubs({
      repoId: upperRepoId,
      threshold: 29,
      scope: 'callable',
      limit: 1,
      cursor: p1.page.nextCursor ?? undefined,
      now: t0,
    });
    expect(p2.items[0]?.qualifiedName).toBe(longFn30Qn);
    expect(p2.page.hasMore).toBe(false);

    // Distinct isHub (false) vs isFileRollupHub (true) consistent across /hubs, /graph, and /nodes/:id
    const fileHubs = await graphRepo.getRepositoryHubs({
      repoId: upperRepoId,
      threshold: 30,
      scope: 'file_rollup',
      now: t0,
    });
    expect(fileHubs.items[0]).toMatchObject({
      qualifiedName: 'file:src/targets.ts',
      hubDegree: 31,
      inDegreeDistinct: 0,
      dependentFileCount: 31,
      isHub: false,
      isFileRollupHub: true,
    });

    const targetFileId = fileHubs.items[0]?.id ?? '';
    const detailP1 = await graphRepo.getNodeDetail({
      repoId: upperRepoId,
      nodeId: targetFileId.toUpperCase(),
      childrenLimit: 2,
      now: t0,
    });
    expect(detailP1.degree.isHub).toBe(false);
    expect(detailP1.degree.isFileRollupHub).toBe(true);
    expect(detailP1.children.totalCount).toBe(5);
    expect(detailP1.children.page.hasMore).toBe(true);

    // Paginate past 2048-byte children using compact cursor + uppercase UUIDs
    const detailP2 = await graphRepo.getNodeDetail({
      repoId: upperRepoId,
      nodeId: targetFileId.toUpperCase(),
      childrenLimit: 2,
      childrenCursor: detailP1.children.page.nextCursor ?? undefined,
      now: t0,
    });
    const detailP3 = await graphRepo.getNodeDetail({
      repoId: upperRepoId,
      nodeId: targetFileId.toUpperCase(),
      childrenLimit: 2,
      childrenCursor: detailP2.children.page.nextCursor ?? undefined,
      now: t0,
    });
    const allChildren = [
      ...detailP1.children.items,
      ...detailP2.children.items,
      ...detailP3.children.items,
    ];
    expect(allChildren).toHaveLength(5);
    expect(allChildren.some((c) => c.qualifiedName === longFn31Qn)).toBe(true);

    // Paginate edge evidence for 2048-byte qualifiedName target with uppercase UUIDs
    const fn31Id = allChildren.find((c) => c.qualifiedName === longFn31Qn)?.id ?? '';
    const e1 = await graphRepo.getNodeEdges({
      repoId: upperRepoId,
      nodeId: fn31Id.toUpperCase(),
      direction: 'incoming',
      edgeType: 'CALLS',
      limit: 20,
      now: t0,
    });
    expect(e1.items).toHaveLength(20);
    expect(e1.page.hasMore).toBe(true);
    const e2 = await graphRepo.getNodeEdges({
      repoId: upperRepoId,
      nodeId: fn31Id.toUpperCase(),
      direction: 'incoming',
      edgeType: 'CALLS',
      limit: 20,
      cursor: e1.page.nextCursor ?? undefined,
      now: t0,
    });
    expect(e2.items).toHaveLength(11);
    expect(e2.page.hasMore).toBe(false);
  });

  it('fails loudly on persisted containment cycles and preserves REPEATABLE READ snapshot consistency under concurrent expiration deletion', async () => {
    if (clientA === undefined || clientB === undefined) throw new Error('Expected clients');
    const tOld = new Date('2026-11-01T00:00:00.000Z');
    const tPurge = new Date('2026-11-20T00:00:00.000Z');

    // 1. Corrupt a persisted repo with a 2-node parent cycle -> BOTH getNodeDetail and getRepositoryGraph fail loudly with GRAPH_CONTAINMENT_INVALID
    const cycPub = await publishFixtureRepo(ingestionRepo, {
      owner: 'gq-cyc',
      name: 'cyclic-parent',
      commitSha: '7070707070707070707070707070707070707070',
      output: makeNestedClassGraph(),
      now: tOld,
    });
    const cycNodes = await clientA.db
      .select()
      .from(nodes)
      .where(eq(nodes.repoId, cycPub.repository.id));
    const fSrc = cycNodes.find((n) => n.qualifiedName === 'folder:src');
    const fLib = cycNodes.find((n) => n.qualifiedName === 'folder:src/lib');
    if (!fSrc || !fLib) throw new Error('Expected folders');
    await clientA.db.update(nodes).set({ parentNodeId: fLib.id }).where(eq(nodes.id, fSrc.id));

    await expectGraphError(
      graphRepo.getNodeDetail({ repoId: cycPub.repository.id, nodeId: fLib.id, now: tOld }),
      'GRAPH_CONTAINMENT_INVALID',
    );
    await expectGraphError(
      graphRepo.getRepositoryGraph({
        repoId: cycPub.repository.id,
        level: 'folder',
        scopeNodeId: fSrc.id,
        now: tOld,
      }),
      'GRAPH_CONTAINMENT_INVALID',
    );

    // 2. Concurrent expiration under REPEATABLE READ READ ONLY with immediate rejection observation, bounded barriers, and guaranteed drain
    const expPub = await publishFixtureRepo(ingestionRepo, {
      owner: 'gq-conc',
      name: 'expiring',
      commitSha: '7171717171717171717171717171717171717171',
      output: makeNestedClassGraph(),
      ttlDays: 1,
      now: tOld,
    });

    const repoB = createIngestionRepository(clientB.db);
    let releaseReadGate!: () => void;
    const readGate = new Promise<void>((r) => {
      releaseReadGate = r;
    });
    let markSnapshotReady!: () => void;
    const snapshotReady = new Promise<void>((r) => {
      markSnapshotReady = r;
    });

    let readError: unknown = null;
    const readPromise = runBoundedReadTransaction(clientA.db, async (tx) => {
      const repoRows = await tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, expPub.repository.id));
      expect(repoRows).toHaveLength(1);
      markSnapshotReady();
      await withTimeout(readGate, 5_000, 'readGate release');
      const snapNodes = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(eq(nodes.repoId, expPub.repository.id));
      const snapEdges = await tx
        .select({ id: edges.id })
        .from(edges)
        .where(eq(edges.repoId, expPub.repository.id));
      return { nodeCount: snapNodes.length, edgeCount: snapEdges.length };
    });
    // Immediate rejection observer so any mid-test failure never becomes an unhandled rejection
    const observedRead = readPromise.catch((err: unknown) => {
      readError = err;
      return null;
    });

    let deletePromise: ReturnType<IngestionRepository['deleteExpiredRepositories']> | undefined;

    try {
      await withTimeout(snapshotReady, 5_000, 'REPEATABLE READ snapshot ready');

      deletePromise = repoB.deleteExpiredRepositories(tPurge);

      const deleted = await withTimeout(
        deletePromise,
        5_000,
        'concurrent deleteExpiredRepositories',
      );

      expect(deleted).toContain(expPub.repository.id);
    } finally {
      releaseReadGate();
      await Promise.allSettled([observedRead, deletePromise]);
    }

    const snapResult = await observedRead;

    expect(readError).toBeNull();
    expect(snapResult).toEqual({ nodeCount: 11, edgeCount: 6 });

    await expectGraphError(
      graphRepo.getRepositoryGraph({ repoId: expPub.repository.id, now: tPurge }),
      'REPO_NOT_FOUND',
    );
  });
});
