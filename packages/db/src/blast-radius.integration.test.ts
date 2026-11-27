import { randomBytes, randomUUID } from 'node:crypto';
import {
  blastRadiusResponseSchema,
  compareBlastRadiusCallSites,
  compareBlastRadiusImpactedFiles,
  compareBlastRadiusImpactedFolders,
  compareBlastRadiusImpactedNodes,
  isCallableOrSymbolNodeType,
  loadEnv,
  sortBlastRadiusReasonsCanonical,
  type AnalysisOutput,
  type BlastRadiusCallSite,
  type BlastRadiusReason,
  type ExtractedEdge,
  type ExtractedNode,
} from '@archon/shared';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARD_MAX_BLAST_RADIUS_LIMITS, validateBlastRadiusLimits } from './blast-radius.js';
import {
  buildPoolConfig,
  createDbClient,
  sanitizeDatabaseTarget,
  type DbClient,
} from './client.js';
import { DbError } from './errors.js';
import { GraphQueryError, runBoundedReadTransaction } from './graph-query-helpers.js';
import { createGraphQueryRepository, type GraphQueryRepository } from './graph-query-repository.js';
import { runMigrations } from './migrate.js';
import { createIngestionRepository, type IngestionRepository } from './repository.js';
import { edges, nodes, repositories, type EdgeRecord, type NodeRecord } from './schema.js';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

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

function mkFolder(fp: string, parent: string | null): ExtractedNode {
  return {
    nodeType: 'folder',
    name: fp.split('/').at(-1) ?? fp,
    qualifiedName: `folder:${fp}`,
    filePath: fp,
    parentQualifiedName: parent,
    isExported: false,
    startLine: null,
    endLine: null,
    contentHash: null,
    snippet: null,
  };
}

function mkFile(fp: string, parent: string | null): ExtractedNode {
  return {
    nodeType: 'file',
    name: fp.split('/').at(-1) ?? fp,
    qualifiedName: `file:${fp}`,
    filePath: fp,
    parentQualifiedName: parent,
    isExported: false,
    startLine: 1,
    endLine: 20,
    contentHash: H1,
    snippet: `// ${fp}`,
  };
}

function mkDecl(
  nodeType: 'function' | 'class' | 'symbol',
  fp: string,
  qn: string,
  parent: string,
  isExported: boolean,
  line: number,
): ExtractedNode {
  return {
    nodeType,
    name: qn.split(':').at(-1) ?? qn,
    qualifiedName: qn,
    filePath: fp,
    parentQualifiedName: parent,
    isExported,
    startLine: line,
    endLine: line + 1,
    contentHash: H2,
    snippet: `// ${qn}`,
  };
}

function runIndependentBlastRadiusOracle(
  rawNodes: readonly NodeRecord[],
  rawEdges: readonly EdgeRecord[],
  params: {
    readonly targetNodeId: string;
    readonly maxDepth: number;
    readonly hubThreshold: number;
  },
) {
  const nodeById = new Map(rawNodes.map((n) => [n.id, n]));
  const fileByPath = new Map(
    rawNodes.filter((n) => n.nodeType === 'file').map((f) => [f.filePath, f]),
  );
  const childrenByParent = new Map<string | null, NodeRecord[]>();
  for (const n of rawNodes) {
    const arr = childrenByParent.get(n.parentNodeId) ?? [];
    arr.push(n);
    childrenByParent.set(n.parentNodeId, arr);
  }

  const target = nodeById.get(params.targetNodeId);
  if (target === undefined) throw new Error('Oracle target missing');
  const isCallable = isCallableOrSymbolNodeType(target.nodeType);

  const subtree = (root: NodeRecord): NodeRecord[] => {
    const out: NodeRecord[] = [root];
    for (const cur of out) {
      for (const ch of childrenByParent.get(cur.id) ?? []) {
        out.push(ch);
      }
    }
    return out;
  };

  const excludedNodeIds = new Set<string>();
  const excludedFileIds = new Set<string>();
  const excludedFolderIds = new Set<string>();
  let fileFrontier: NodeRecord[] = [];
  let callableFrontier: NodeRecord[] = [];

  if (isCallable) {
    excludedNodeIds.add(target.id);
    callableFrontier = [target];
  } else {
    for (const n of subtree(target)) {
      excludedNodeIds.add(n.id);
      if (n.nodeType === 'file') {
        excludedFileIds.add(n.id);
        fileFrontier.push(n);
      } else if (n.nodeType === 'folder') {
        excludedFolderIds.add(n.id);
      }
    }
  }

  const visitedFiles = new Set<string>(excludedFileIds);
  const visitedCallables = new Set<string>(isCallable ? [target.id] : []);

  interface Entry {
    node: NodeRecord;
    hop: number;
    reasons: Set<BlastRadiusReason>;
    via: Set<string>;
    sites: Map<string, BlastRadiusCallSite>;
  }
  const impFiles = new Map<string, Entry>();
  const impCallables = new Map<string, Entry>();

  const ensure = (m: Map<string, Entry>, n: NodeRecord, hop: number): Entry => {
    let e = m.get(n.id);
    if (e === undefined) {
      e = { node: n, hop, reasons: new Set(), via: new Set(), sites: new Map() };
      m.set(n.id, e);
    }
    return e;
  };

  for (let hop = 1; hop <= params.maxDepth; hop += 1) {
    const layerF = new Map<string, Entry>();
    const layerC = new Map<string, Entry>();

    if (!isCallable) {
      const fIds = new Set(fileFrontier.map((f) => f.id));
      for (const e of rawEdges) {
        if (
          e.edgeType !== 'IMPORTS' ||
          e.sourceNodeId === e.targetNodeId ||
          !fIds.has(e.targetNodeId)
        ) {
          continue;
        }
        const src = nodeById.get(e.sourceNodeId);
        if (src === undefined) continue;
        if (src.nodeType !== 'file' || excludedNodeIds.has(src.id) || visitedFiles.has(src.id)) {
          continue;
        }
        const ent = ensure(layerF, src, hop);
        ent.reasons.add('imports_file');
        ent.via.add(e.targetNodeId);
      }
    }

    const directC = new Set(callableFrontier.map((c) => c.id));
    const expC = new Set<string>();
    if (!isCallable) {
      const fPaths = new Set(fileFrontier.map((f) => f.filePath));
      for (const n of rawNodes) {
        if (isCallableOrSymbolNodeType(n.nodeType) && n.isExported && fPaths.has(n.filePath)) {
          expC.add(n.id);
        }
      }
    }

    for (const e of rawEdges) {
      if (e.edgeType !== 'CALLS' || e.sourceNodeId === e.targetNodeId) continue;
      const inDirect = directC.has(e.targetNodeId);
      const inExp = expC.has(e.targetNodeId);
      if (!inDirect && !inExp) continue;
      if (excludedNodeIds.has(e.sourceNodeId)) continue;
      const caller = nodeById.get(e.sourceNodeId);
      if (caller === undefined) continue;

      if (caller.nodeType === 'file') {
        if (visitedFiles.has(caller.id)) continue;
        const ent = ensure(layerF, caller, hop);
        if (inDirect) ent.reasons.add('calls_symbol');
        if (inExp) ent.reasons.add('calls_exported_symbol');
        ent.via.add(e.targetNodeId);
        if (e.callSiteLine !== null) {
          ent.sites.set(`${e.targetNodeId}\0${String(e.callSiteLine)}`, {
            viaNodeId: e.targetNodeId,
            callSiteLine: e.callSiteLine,
          });
        }
      } else if (isCallableOrSymbolNodeType(caller.nodeType)) {
        if (visitedCallables.has(caller.id)) continue;
        const ent = ensure(layerC, caller, hop);
        if (inDirect) ent.reasons.add('calls_symbol');
        if (inExp) ent.reasons.add('calls_exported_symbol');
        ent.via.add(e.targetNodeId);
        if (e.callSiteLine !== null) {
          ent.sites.set(`${e.targetNodeId}\0${String(e.callSiteLine)}`, {
            viaNodeId: e.targetNodeId,
            callSiteLine: e.callSiteLine,
          });
        }
      }
    }

    if (!isCallable) {
      for (const cEnt of layerC.values()) {
        const enc = fileByPath.get(cEnt.node.filePath);
        if (enc === undefined) continue;
        if (excludedNodeIds.has(enc.id) || visitedFiles.has(enc.id)) continue;
        const fEnt = ensure(layerF, enc, hop);
        fEnt.reasons.add('contains_impacted_callable');
        fEnt.via.add(cEnt.node.id);
      }
    }

    const nextF: NodeRecord[] = [];
    const nextC: NodeRecord[] = [];
    for (const [id, ent] of layerF) {
      visitedFiles.add(id);
      impFiles.set(id, ent);
      if (!isCallable) nextF.push(ent.node);
    }
    for (const [id, ent] of layerC) {
      visitedCallables.add(id);
      impCallables.set(id, ent);
      nextC.push(ent.node);
    }
    fileFrontier = nextF;
    callableFrontier = nextC;
  }

  const degOf = (id: string) => {
    const src = new Set<string>();
    const imp = new Set<string>();
    const cal = new Set<string>();
    let raw = 0;
    for (const e of rawEdges) {
      if (e.targetNodeId === id && e.sourceNodeId !== e.targetNodeId) {
        raw += 1;
        src.add(e.sourceNodeId);
        if (e.edgeType === 'IMPORTS') imp.add(e.sourceNodeId);
        else cal.add(e.sourceNodeId);
      }
    }
    return {
      inDegreeDistinct: src.size,
      rawIncomingEdgeCount: raw,
      distinctImporterCount: imp.size,
      distinctCallerCount: cal.size,
    };
  };

  const depFilesOf = (fp: string): number => {
    const s = new Set<string>();
    for (const e of rawEdges) {
      if (e.sourceNodeId === e.targetNodeId) continue;
      const sn = nodeById.get(e.sourceNodeId);
      const tn = nodeById.get(e.targetNodeId);
      if (sn === undefined || tn === undefined) continue;
      if (tn.filePath !== fp || sn.filePath === fp) continue;
      if (
        (e.edgeType === 'IMPORTS' && tn.nodeType === 'file') ||
        (e.edgeType === 'CALLS' && isCallableOrSymbolNodeType(tn.nodeType) && tn.isExported)
      ) {
        s.add(sn.filePath);
      }
    }
    return s.size;
  };

  const fRollup = new Map<
    string,
    {
      f: NodeRecord;
      minHop: number;
      reasons: Set<BlastRadiusReason>;
      via: Set<string>;
      callableCount: number;
    }
  >();
  for (const e of impFiles.values()) {
    fRollup.set(e.node.id, {
      f: e.node,
      minHop: e.hop,
      reasons: new Set(e.reasons),
      via: new Set(e.via),
      callableCount: 0,
    });
  }
  for (const c of impCallables.values()) {
    const enc = fileByPath.get(c.node.filePath);
    if (enc === undefined) continue;
    const cur = fRollup.get(enc.id);
    if (cur === undefined) {
      fRollup.set(enc.id, {
        f: enc,
        minHop: c.hop,
        reasons: new Set(['contains_impacted_callable']),
        via: new Set([c.node.id]),
        callableCount: 1,
      });
    } else {
      cur.callableCount += 1;
      if (c.hop < cur.minHop) {
        cur.minHop = c.hop;
        cur.reasons = new Set(['contains_impacted_callable']);
        cur.via = new Set([c.node.id]);
      } else if (c.hop === cur.minHop) {
        cur.reasons.add('contains_impacted_callable');
        cur.via.add(c.node.id);
      }
    }
  }

  const dRollup = new Map<string, { d: NodeRecord; minHop: number; files: Set<string> }>();
  for (const fr of fRollup.values()) {
    let pid = fr.f.parentNodeId;
    while (pid !== null) {
      const p = nodeById.get(pid);
      if (p === undefined) break;
      if (!excludedFolderIds.has(p.id)) {
        const cur = dRollup.get(p.id);
        if (cur === undefined)
          dRollup.set(p.id, { d: p, minHop: fr.minHop, files: new Set([fr.f.id]) });
        else {
          cur.minHop = Math.min(cur.minHop, fr.minHop);
          cur.files.add(fr.f.id);
        }
      }
      pid = p.parentNodeId;
    }
  }

  const impactedNodes = [...impFiles.values(), ...impCallables.values()]
    .map((e) => {
      const d = degOf(e.node.id);
      const df = e.node.nodeType === 'file' ? depFilesOf(e.node.filePath) : null;
      const sites = [...e.sites.values()].sort(compareBlastRadiusCallSites);
      return {
        id: e.node.id,
        nodeType: e.node.nodeType,
        name: e.node.name,
        qualifiedName: e.node.qualifiedName,
        filePath: e.node.filePath,
        parentNodeId: e.node.parentNodeId,
        isExported: e.node.isExported,
        startLine: e.node.startLine,
        endLine: e.node.endLine,
        hop: e.hop,
        reasons: sortBlastRadiusReasonsCanonical(e.reasons),
        viaNodeIds: [...e.via].sort(),
        callSiteCount: sites.length,
        callSites: sites,
        ...d,
        dependentFileCount: df,
        isHub: d.inDegreeDistinct > params.hubThreshold,
        isFileRollupHub: df !== null ? df > params.hubThreshold : null,
      };
    })
    .sort(compareBlastRadiusImpactedNodes);

  const impactedFiles = [...fRollup.values()]
    .map((fr) => {
      const d = degOf(fr.f.id);
      const df = depFilesOf(fr.f.filePath);
      return {
        fileNodeId: fr.f.id,
        name: fr.f.name,
        qualifiedName: fr.f.qualifiedName,
        filePath: fr.f.filePath,
        parentNodeId: fr.f.parentNodeId,
        minHop: fr.minHop,
        reasons: sortBlastRadiusReasonsCanonical(fr.reasons),
        viaNodeIds: [...fr.via].sort(),
        impactedCallableCount: fr.callableCount,
        inDegreeDistinct: d.inDegreeDistinct,
        rawIncomingEdgeCount: d.rawIncomingEdgeCount,
        dependentFileCount: df,
        isHub: d.inDegreeDistinct > params.hubThreshold,
        isFileRollupHub: df > params.hubThreshold,
      };
    })
    .sort(compareBlastRadiusImpactedFiles);

  const impactedFolders = [...dRollup.values()]
    .map((dr) => ({
      folderNodeId: dr.d.id,
      name: dr.d.name,
      qualifiedName: dr.d.qualifiedName,
      folderPath: dr.d.filePath,
      parentNodeId: dr.d.parentNodeId,
      minHop: dr.minHop,
      impactedFileCount: dr.files.size,
    }))
    .sort(compareBlastRadiusImpactedFolders);

  return { impactedNodes, impactedFiles, impactedFolders };
}

function makeComplexBlastGraph(): AnalysisOutput {
  const gNodes: ExtractedNode[] = [
    mkFolder('src', null),
    mkFolder('src/core', 'folder:src'),
    mkFolder('src/core/sub', 'folder:src/core'),
    mkFolder('src/app', 'folder:src'),
    mkFolder('src/ui', 'folder:src'),
    mkFile('src/core/sub/base.ts', 'folder:src/core/sub'),
    mkFile('src/core/internal.ts', 'folder:src/core'),
    mkFile('src/app/service.ts', 'folder:src/app'),
    mkFile('src/app/bridge.ts', 'folder:src/app'),
    mkFile('src/ui/page.ts', 'folder:src/ui'),
    mkFile('src/ui/widget.ts', 'folder:src/ui'),
    mkFile('root.ts', null),
    mkDecl(
      'class',
      'src/core/sub/base.ts',
      'src/core/sub/base.ts::class:Core',
      'file:src/core/sub/base.ts',
      true,
      1,
    ),
    mkDecl(
      'function',
      'src/core/sub/base.ts',
      'src/core/sub/base.ts::class:Core::method:run',
      'src/core/sub/base.ts::class:Core',
      true,
      2,
    ),
    mkDecl(
      'function',
      'src/core/sub/base.ts',
      'src/core/sub/base.ts::fn:sameFileCaller',
      'file:src/core/sub/base.ts',
      false,
      5,
    ),
    mkDecl(
      'function',
      'src/core/sub/base.ts',
      'src/core/sub/base.ts::fn:privateOnly',
      'file:src/core/sub/base.ts',
      false,
      8,
    ),
    mkDecl(
      'function',
      'src/core/internal.ts',
      'src/core/internal.ts::fn:coreWrap',
      'file:src/core/internal.ts',
      true,
      1,
    ),
    mkDecl(
      'function',
      'src/app/service.ts',
      'src/app/service.ts::fn:useCore',
      'file:src/app/service.ts',
      true,
      1,
    ),
    mkDecl(
      'function',
      'src/app/service.ts',
      'src/app/service.ts::fn:localAfter',
      'file:src/app/service.ts',
      false,
      6,
    ),
    mkDecl(
      'function',
      'src/app/bridge.ts',
      'src/app/bridge.ts::fn:bridgeFn',
      'file:src/app/bridge.ts',
      true,
      1,
    ),
    mkDecl(
      'function',
      'src/ui/page.ts',
      'src/ui/page.ts::fn:renderPage',
      'file:src/ui/page.ts',
      true,
      1,
    ),
    mkDecl(
      'function',
      'src/ui/widget.ts',
      'src/ui/widget.ts::fn:renderWidget',
      'file:src/ui/widget.ts',
      true,
      1,
    ),
    mkDecl('function', 'root.ts', 'root.ts::fn:main', 'file:root.ts', true, 1),
  ];

  const gEdges: ExtractedEdge[] = [
    {
      sourceQualifiedName: 'src/core/sub/base.ts::class:Core::method:run',
      targetQualifiedName: 'src/core/sub/base.ts::class:Core::method:run',
      edgeType: 'CALLS',
      callSiteLine: 3,
      callSiteSnippet: 'this.run()',
    },
    {
      sourceQualifiedName: 'src/core/sub/base.ts::fn:sameFileCaller',
      targetQualifiedName: 'src/core/sub/base.ts::class:Core::method:run',
      edgeType: 'CALLS',
      callSiteLine: 6,
      callSiteSnippet: 'run(1)',
    },
    {
      sourceQualifiedName: 'src/core/sub/base.ts::fn:sameFileCaller',
      targetQualifiedName: 'src/core/sub/base.ts::class:Core::method:run',
      edgeType: 'CALLS',
      callSiteLine: 7,
      callSiteSnippet: 'run(2)',
    },
    {
      sourceQualifiedName: 'file:src/core/internal.ts',
      targetQualifiedName: 'file:src/core/sub/base.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
    {
      sourceQualifiedName: 'src/core/internal.ts::fn:coreWrap',
      targetQualifiedName: 'src/core/sub/base.ts::class:Core::method:run',
      edgeType: 'CALLS',
      callSiteLine: 2,
      callSiteSnippet: 'core.run()',
    },
    {
      sourceQualifiedName: 'file:src/app/service.ts',
      targetQualifiedName: 'file:src/core/sub/base.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
    {
      sourceQualifiedName: 'src/app/service.ts::fn:useCore',
      targetQualifiedName: 'src/core/sub/base.ts::class:Core::method:run',
      edgeType: 'CALLS',
      callSiteLine: 2,
      callSiteSnippet: 'run(10)',
    },
    {
      sourceQualifiedName: 'src/app/service.ts::fn:useCore',
      targetQualifiedName: 'src/core/sub/base.ts::class:Core::method:run',
      edgeType: 'CALLS',
      callSiteLine: 4,
      callSiteSnippet: 'run(20)',
    },
    {
      sourceQualifiedName: 'src/app/service.ts::fn:localAfter',
      targetQualifiedName: 'src/app/service.ts::fn:useCore',
      edgeType: 'CALLS',
      callSiteLine: 7,
      callSiteSnippet: 'useCore()',
    },
    {
      sourceQualifiedName: 'file:src/app/bridge.ts',
      targetQualifiedName: 'file:src/core/sub/base.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
    {
      sourceQualifiedName: 'file:src/app/bridge.ts',
      targetQualifiedName: 'file:src/app/service.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
    {
      sourceQualifiedName: 'file:src/app/service.ts',
      targetQualifiedName: 'file:src/app/bridge.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
    {
      sourceQualifiedName: 'src/app/bridge.ts::fn:bridgeFn',
      targetQualifiedName: 'src/app/service.ts::fn:useCore',
      edgeType: 'CALLS',
      callSiteLine: 2,
      callSiteSnippet: 'useCore()',
    },
    {
      sourceQualifiedName: 'src/app/service.ts::fn:useCore',
      targetQualifiedName: 'src/app/bridge.ts::fn:bridgeFn',
      edgeType: 'CALLS',
      callSiteLine: 5,
      callSiteSnippet: 'bridgeFn()',
    },
    {
      sourceQualifiedName: 'src/ui/page.ts::fn:renderPage',
      targetQualifiedName: 'src/core/sub/base.ts::fn:privateOnly',
      edgeType: 'CALLS',
      callSiteLine: 9,
      callSiteSnippet: 'privateOnly()',
    },
    {
      sourceQualifiedName: 'file:src/ui/page.ts',
      targetQualifiedName: 'file:src/app/service.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
    {
      sourceQualifiedName: 'src/ui/page.ts::fn:renderPage',
      targetQualifiedName: 'src/app/bridge.ts::fn:bridgeFn',
      edgeType: 'CALLS',
      callSiteLine: 3,
      callSiteSnippet: 'bridgeFn()',
    },
    {
      sourceQualifiedName: 'src/ui/widget.ts::fn:renderWidget',
      targetQualifiedName: 'src/ui/page.ts::fn:renderPage',
      edgeType: 'CALLS',
      callSiteLine: 2,
      callSiteSnippet: 'renderPage()',
    },
    {
      sourceQualifiedName: 'file:root.ts',
      targetQualifiedName: 'file:src/ui/page.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
    {
      sourceQualifiedName: 'root.ts::fn:main',
      targetQualifiedName: 'src/app/service.ts::fn:localAfter',
      edgeType: 'CALLS',
      callSiteLine: 2,
      callSiteSnippet: 'localAfter()',
    },
  ];
  return makeOutput(gNodes, gEdges);
}

describe('Blast-Radius Engine (PostgreSQL 17 integration + independent oracle)', () => {
  const testDbName = `archon_br_test_${randomBytes(6).toString('hex')}`;
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

  it('matches oracle across callable/file/folder depths 1..3, preserves overlapping shortest-hop reasons & shared ancestor folders, and isolates repositories', async () => {
    if (clientA === undefined) throw new Error('Expected clientA');
    const t0 = new Date('2026-11-28T03:00:00.000Z');

    const pub1 = await publishFixtureRepo(ingestionRepo, {
      owner: 'br-ora',
      name: 'complex-one',
      commitSha: '8181818181818181818181818181818181818181',
      output: makeComplexBlastGraph(),
      now: t0,
    });
    const pub2 = await publishFixtureRepo(ingestionRepo, {
      owner: 'br-ora',
      name: 'complex-two',
      commitSha: '8282828282828282828282828282828282828282',
      output: makeComplexBlastGraph(),
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

    const coreMethod = rawNodes.find(
      (n) => n.qualifiedName === 'src/core/sub/base.ts::class:Core::method:run',
    );
    const baseFile = rawNodes.find((n) => n.qualifiedName === 'file:src/core/sub/base.ts');
    const coreFolder = rawNodes.find((n) => n.qualifiedName === 'folder:src/core');
    const privateFn = rawNodes.find(
      (n) => n.qualifiedName === 'src/core/sub/base.ts::fn:privateOnly',
    );
    if (!coreMethod || !baseFile || !coreFolder || !privateFn)
      throw new Error('Missing fixture nodes');

    for (const target of [coreMethod, privateFn, baseFile, coreFolder]) {
      for (const maxDepth of [1, 2, 3] as const) {
        const actual = await graphRepo.getBlastRadius({
          repoId: pub1.repository.id.toUpperCase(),
          nodeId: target.id.toUpperCase(),
          maxDepth,
          hubThreshold: 30,
          now: t0,
        });
        expect(blastRadiusResponseSchema.safeParse(actual).success).toBe(true);
        const expected = runIndependentBlastRadiusOracle(rawNodes, rawEdges, {
          targetNodeId: target.id,
          maxDepth,
          hubThreshold: 30,
        });
        expect(actual.impactedNodes).toEqual(expected.impactedNodes);
        expect(actual.impactedFiles).toEqual(expected.impactedFiles);
        expect(actual.impactedFolders).toEqual(expected.impactedFolders);
        expect(JSON.stringify(actual)).not.toContain('callSiteSnippet');
      }
    }

    // Explicit hand-derived assertions for overlapping reasons & sibling shared ancestor (folder:src):
    // From base.ts at depth 3:
    // - hop 1: service.ts (IMPORTS + contains useCore), bridge.ts (IMPORTS), service.ts::useCore (CALLS exported Core.run)
    // - hop 2: bridge.ts::bridgeFn calls service.ts::useCore, which is BOTH in directCallableIds AND exportedFromFileIds(service.ts)!
    //   -> bridgeFn MUST carry BOTH ['calls_exported_symbol', 'calls_symbol'] with callSiteCount: 1 (no duplicate evidence!).
    // - Sibling folders src/app and src/ui both share ancestor folder:src -> folder:src resolved cleanly!
    const fileD3 = await graphRepo.getBlastRadius({
      repoId: pub1.repository.id,
      nodeId: baseFile.id,
      maxDepth: 3,
      now: t0,
    });
    const bridgeFnItem = fileD3.impactedNodes.find(
      (n) => n.qualifiedName === 'src/app/bridge.ts::fn:bridgeFn',
    );
    expect(bridgeFnItem).toMatchObject({
      hop: 2,
      reasons: ['calls_exported_symbol', 'calls_symbol'],
      callSiteCount: 1,
    });
    const srcFolderRollup = fileD3.impactedFolders.find((d) => d.folderPath === 'src');
    expect(srcFolderRollup).toMatchObject({ minHop: 1, impactedFileCount: 5 });

    // Repository isolation
    const pub2Nodes = await clientA.db
      .select()
      .from(nodes)
      .where(eq(nodes.repoId, pub2.repository.id));
    await expectGraphError(
      graphRepo.getBlastRadius({
        repoId: pub1.repository.id,
        nodeId: pub2Nodes[0]?.id ?? randomUUID(),
        now: t0,
      }),
      'NODE_NOT_FOUND',
    );
  });

  it('handles top-level file-scope CALLS + IMPORTS without duplicate UUIDs, self-containment, or false callable counts, and handles sibling folders sharing one ancestor', async () => {
    if (clientA === undefined) throw new Error('Expected clientA');
    const t0 = new Date('2026-11-28T03:30:00.000Z');

    // Graph with top-level file-scope CALLS (source = file:src/a/entry.ts) + IMPORTS + sibling folders src/a & src/b sharing folder:src
    const topLevelNodes: ExtractedNode[] = [
      mkFolder('src', null),
      mkFolder('src/target', 'folder:src'),
      mkFolder('src/a', 'folder:src'),
      mkFolder('src/b', 'folder:src'),
      mkFile('src/target/lib.ts', 'folder:src/target'),
      mkDecl(
        'function',
        'src/target/lib.ts',
        'src/target/lib.ts::fn:init',
        'file:src/target/lib.ts',
        true,
        1,
      ),
      mkFile('src/a/entry.ts', 'folder:src/a'),
      mkFile('src/b/peer.ts', 'folder:src/b'),
    ];
    const topLevelEdges: ExtractedEdge[] = [
      // entry.ts BOTH imports lib.ts AND invokes init() at top level (lines 3 & 4)
      {
        sourceQualifiedName: 'file:src/a/entry.ts',
        targetQualifiedName: 'file:src/target/lib.ts',
        edgeType: 'IMPORTS',
        callSiteLine: null,
        callSiteSnippet: null,
      },
      {
        sourceQualifiedName: 'file:src/a/entry.ts',
        targetQualifiedName: 'src/target/lib.ts::fn:init',
        edgeType: 'CALLS',
        callSiteLine: 3,
        callSiteSnippet: 'init(1)',
      },
      {
        sourceQualifiedName: 'file:src/a/entry.ts',
        targetQualifiedName: 'src/target/lib.ts::fn:init',
        edgeType: 'CALLS',
        callSiteLine: 4,
        callSiteSnippet: 'init(2)',
      },
      // sibling folder src/b also imports lib.ts -> src/a and src/b share ancestor folder:src!
      {
        sourceQualifiedName: 'file:src/b/peer.ts',
        targetQualifiedName: 'file:src/target/lib.ts',
        edgeType: 'IMPORTS',
        callSiteLine: null,
        callSiteSnippet: null,
      },
    ];

    const pub = await publishFixtureRepo(ingestionRepo, {
      owner: 'br-top',
      name: 'file-calls',
      commitSha: '8484848484848484848484848484848484848484',
      output: makeOutput(topLevelNodes, topLevelEdges),
      now: t0,
    });
    const dbNodes = await clientA.db
      .select()
      .from(nodes)
      .where(eq(nodes.repoId, pub.repository.id));
    const libFile = dbNodes.find((n) => n.qualifiedName === 'file:src/target/lib.ts');
    const initFn = dbNodes.find((n) => n.qualifiedName === 'src/target/lib.ts::fn:init');
    const entryFile = dbNodes.find((n) => n.qualifiedName === 'file:src/a/entry.ts');
    const peerFile = dbNodes.find((n) => n.qualifiedName === 'file:src/b/peer.ts');
    if (!libFile || !initFn || !entryFile || !peerFile) throw new Error('Expected fixture nodes');

    // 1. File target (lib.ts): entry.ts appears ONCE with merged ['imports_file', 'calls_exported_symbol'], 2 callSites, 0 impactedCallables, NO contains_impacted_callable!
    const fileRes = await graphRepo.getBlastRadius({
      repoId: pub.repository.id,
      nodeId: libFile.id,
      maxDepth: 2,
      now: t0,
    });
    expect(blastRadiusResponseSchema.safeParse(fileRes).success).toBe(true);
    expect(fileRes.impactedNodes.map((n) => n.id).sort()).toEqual(
      [entryFile.id, peerFile.id].sort(),
    );
    const entryNode = fileRes.impactedNodes.find((n) => n.id === entryFile.id);
    expect(entryNode).toMatchObject({
      hop: 1,
      reasons: ['imports_file', 'calls_exported_symbol'],
      viaNodeIds: [libFile.id, initFn.id].sort(),
      callSiteCount: 2,
      callSites: [
        { viaNodeId: initFn.id, callSiteLine: 3 },
        { viaNodeId: initFn.id, callSiteLine: 4 },
      ],
    });
    const entryFileRollup = fileRes.impactedFiles.find((f) => f.fileNodeId === entryFile.id);
    expect(entryFileRollup).toMatchObject({
      minHop: 1,
      reasons: ['imports_file', 'calls_exported_symbol'],
      impactedCallableCount: 0,
    });
    // Shared ancestor folder:src deduplicated cleanly with impactedFileCount: 2 (entry.ts + peer.ts)
    expect(fileRes.impactedFolders.find((d) => d.folderPath === 'src')).toMatchObject({
      minHop: 1,
      impactedFileCount: 2,
    });

    // 2. Callable target (initFn): entry.ts appears once via calls_symbol without triggering IMPORTS or self-containment
    const fnRes = await graphRepo.getBlastRadius({
      repoId: pub.repository.id,
      nodeId: initFn.id,
      maxDepth: 2,
      now: t0,
    });
    expect(blastRadiusResponseSchema.safeParse(fnRes).success).toBe(true);
    expect(fnRes.impactedNodes).toHaveLength(1);
    expect(fnRes.impactedNodes[0]).toMatchObject({
      id: entryFile.id,
      hop: 1,
      reasons: ['calls_symbol'],
      callSiteCount: 2,
    });
    expect(fnRes.impactedFiles).toHaveLength(1);
    expect(fnRes.impactedFiles[0]).toMatchObject({
      fileNodeId: entryFile.id,
      minHop: 1,
      reasons: ['calls_symbol'],
      impactedCallableCount: 0,
    });
  });

  it('enforces exact shared cumulative budgets (E succeeds, E-1 fails), zero-remaining edge allowance, seed/depth/frontier limits, 29/30/31 hubs, full lifecycle gating, and concurrent expiration consistency', async () => {
    if (clientA === undefined || clientB === undefined) throw new Error('Expected clients');
    const t0 = new Date('2026-11-28T04:00:00.000Z');
    const tPurge = new Date('2026-12-15T00:00:00.000Z');

    // Hard ceiling validation & invalid maxDepth
    expect(() =>
      validateBlastRadiusLimits({
        maxCumulativeRawEdges: HARD_MAX_BLAST_RADIUS_LIMITS.maxCumulativeRawEdges + 1,
      }),
    ).toThrow(DbError);
    await expectGraphError(
      graphRepo.getBlastRadius({
        repoId: randomUUID(),
        nodeId: randomUUID(),
        maxDepth: 4,
        now: t0,
      }),
      'INVALID_QUERY',
    );

    // Full lifecycle gating matrix
    await expectGraphError(
      graphRepo.getBlastRadius({ repoId: randomUUID(), nodeId: randomUUID(), now: t0 }),
      'REPO_NOT_FOUND',
    );
    const queued = await ingestionRepo.createOrGetActive({
      githubUrl: 'https://github.com/br-gate/queued',
      owner: 'br-gate',
      name: 'queued',
      defaultBranch: 'main',
      commitSha: '9191919191919191919191919191919191919191',
      sizeKb: 10,
      now: t0,
    });
    await expectGraphError(
      graphRepo.getBlastRadius({ repoId: queued.repository.id, nodeId: randomUUID(), now: t0 }),
      'GRAPH_NOT_READY',
    );
    await ingestionRepo.failQueuedJobOnEnqueueError({
      repoId: queued.repository.id,
      jobId: queued.job.id,
      now: t0,
    });
    await expectGraphError(
      graphRepo.getBlastRadius({ repoId: queued.repository.id, nodeId: randomUUID(), now: t0 }),
      'REPO_INGESTION_FAILED',
    );
    const legacy = await ingestionRepo.createOrGetActive({
      githubUrl: 'https://github.com/br-gate/legacy',
      owner: 'br-gate',
      name: 'legacy',
      defaultBranch: 'main',
      commitSha: '9292929292929292929292929292929292929292',
      sizeKb: 10,
      initialStatus: 'ready',
      now: t0,
    });
    await expectGraphError(
      graphRepo.getBlastRadius({ repoId: legacy.repository.id, nodeId: randomUUID(), now: t0 }),
      'LEGACY_GRAPH_UNAVAILABLE',
    );
    await clientA.db
      .update(repositories)
      .set({ status: 'superseded' })
      .where(eq(repositories.id, legacy.repository.id));
    await expectGraphError(
      graphRepo.getBlastRadius({ repoId: legacy.repository.id, nodeId: randomUUID(), now: t0 }),
      'REPO_SUPERSEDED',
    );
    const verifiedEmpty = await ingestionRepo.createOrGetVerifiedEmpty({
      githubUrl: 'https://github.com/br-gate/empty',
      owner: 'br-gate',
      name: 'empty',
      defaultBranch: 'main',
      commitSha: '9393939393939393939393939393939393939393',
      sizeKb: 10,
      now: t0,
    });
    await expectGraphError(
      graphRepo.getBlastRadius({
        repoId: verifiedEmpty.repository.id,
        nodeId: randomUUID(),
        now: t0,
      }),
      'NODE_NOT_FOUND',
    );

    // Exact cumulative budget fixture:
    // targetFn <-(1 CALLS)- midFn (exported in mid.ts) <-(2 CALLS)- outerFn + outer.ts -(1 IMPORTS)-> mid.ts
    // At maxDepth=1 from targetFn:
    //   hop 1 CALLS: 1 row
    //   loadNodeIncomingDegrees([midFn, mid.ts]): 2 CALLS + 1 IMPORTS = 3 rows (cumul = 4)
    //   loadDependentFileCounts([mid.ts]): 1 IMPORTS + 2 CALLS = 3 rows (cumul = 7)
    const exactNodes: ExtractedNode[] = [
      mkFolder('src', null),
      mkFile('src/target.ts', 'folder:src'),
      mkDecl(
        'function',
        'src/target.ts',
        'src/target.ts::fn:targetFn',
        'file:src/target.ts',
        true,
        1,
      ),
      mkFile('src/mid.ts', 'folder:src'),
      mkDecl('function', 'src/mid.ts', 'src/mid.ts::fn:midFn', 'file:src/mid.ts', true, 1),
      mkFile('src/outer.ts', 'folder:src'),
      mkDecl('function', 'src/outer.ts', 'src/outer.ts::fn:outerFn', 'file:src/outer.ts', true, 1),
    ];
    const exactEdges: ExtractedEdge[] = [
      {
        sourceQualifiedName: 'src/mid.ts::fn:midFn',
        targetQualifiedName: 'src/target.ts::fn:targetFn',
        edgeType: 'CALLS',
        callSiteLine: 2,
        callSiteSnippet: 'targetFn()',
      },
      {
        sourceQualifiedName: 'file:src/outer.ts',
        targetQualifiedName: 'file:src/mid.ts',
        edgeType: 'IMPORTS',
        callSiteLine: null,
        callSiteSnippet: null,
      },
      {
        sourceQualifiedName: 'src/outer.ts::fn:outerFn',
        targetQualifiedName: 'src/mid.ts::fn:midFn',
        edgeType: 'CALLS',
        callSiteLine: 2,
        callSiteSnippet: 'midFn(1)',
      },
      {
        sourceQualifiedName: 'src/outer.ts::fn:outerFn',
        targetQualifiedName: 'src/mid.ts::fn:midFn',
        edgeType: 'CALLS',
        callSiteLine: 3,
        callSiteSnippet: 'midFn(2)',
      },
    ];
    const exactPub = await publishFixtureRepo(ingestionRepo, {
      owner: 'br-exact',
      name: 'budget',
      commitSha: '9494949494949494949494949494949494949494',
      output: makeOutput(exactNodes, exactEdges),
      now: t0,
    });
    const exactDbNodes = await clientA.db
      .select()
      .from(nodes)
      .where(eq(nodes.repoId, exactPub.repository.id));
    const exTarget = exactDbNodes.find((n) => n.qualifiedName === 'src/target.ts::fn:targetFn');
    const exMid = exactDbNodes.find((n) => n.qualifiedName === 'src/mid.ts::fn:midFn');
    const exFolder = exactDbNodes.find((n) => n.qualifiedName === 'folder:src');
    if (!exTarget || !exMid || !exFolder) throw new Error('Expected exact nodes');

    // Exact cap 7 SUCCEEDS with cumulativeRawEdgesScanned === 7; cap 6 FAILS during degree_file_rollup!
    const exactOkRepo = createGraphQueryRepository(clientA.db, {
      blastRadiusLimits: { maxCumulativeRawEdges: 7 },
    });
    const exactRes = await exactOkRepo.getBlastRadius({
      repoId: exactPub.repository.id,
      nodeId: exTarget.id,
      maxDepth: 1,
      now: t0,
    });
    expect(exactRes.completeness.cumulativeRawEdgesScanned).toBe(7);

    const exactFailRollupRepo = createGraphQueryRepository(clientA.db, {
      blastRadiusLimits: { maxCumulativeRawEdges: 6 },
    });
    await expectGraphError(
      exactFailRollupRepo.getBlastRadius({
        repoId: exactPub.repository.id,
        nodeId: exTarget.id,
        maxDepth: 1,
        now: t0,
      }),
      'BLAST_RADIUS_BUDGET_EXCEEDED',
    );

    // Zero-remaining allowance after traversal: midFn -> outerFn uses 2 traversal CALLS; outerFn/outer.ts have 0 incoming edges -> cap 2 SUCCEEDS!
    const zeroRemOkRepo = createGraphQueryRepository(clientA.db, {
      blastRadiusLimits: { maxCumulativeRawEdges: 2 },
    });
    const zeroRemRes = await zeroRemOkRepo.getBlastRadius({
      repoId: exactPub.repository.id,
      nodeId: exMid.id,
      maxDepth: 1,
      now: t0,
    });
    expect(zeroRemRes.completeness.cumulativeRawEdgesScanned).toBe(2);

    // Zero-remaining allowance when incoming degree HAS rows (targetFn traversal uses 1, degree_incoming has 3 -> cap 1 FAILS!)
    const zeroRemFailRepo = createGraphQueryRepository(clientA.db, {
      blastRadiusLimits: { maxCumulativeRawEdges: 1 },
    });
    await expectGraphError(
      zeroRemFailRepo.getBlastRadius({
        repoId: exactPub.repository.id,
        nodeId: exTarget.id,
        maxDepth: 1,
        now: t0,
      }),
      'BLAST_RADIUS_BUDGET_EXCEEDED',
    );

    // Seed, containment depth, and terminal-hop frontier limits all fail loudly
    const seedTight = createGraphQueryRepository(clientA.db, {
      blastRadiusLimits: { maxSeedNodes: 2 },
    });
    await expectGraphError(
      seedTight.getBlastRadius({
        repoId: exactPub.repository.id,
        nodeId: exFolder.id,
        maxDepth: 1,
        now: t0,
      }),
      'BLAST_RADIUS_BUDGET_EXCEEDED',
    );
    const depthTight = createGraphQueryRepository(clientA.db, {
      blastRadiusLimits: { maxContainmentDepth: 1 },
    });
    await expectGraphError(
      depthTight.getBlastRadius({
        repoId: exactPub.repository.id,
        nodeId: exFolder.id,
        maxDepth: 1,
        now: t0,
      }),
      'BLAST_RADIUS_BUDGET_EXCEEDED',
    );

    // 29 / 30 / 31 hub threshold boundaries (two hop-1 callers: hub30 with 30 deps and hub31 with 31 deps)
    const fanNodes: ExtractedNode[] = [
      mkFolder('src', null),
      mkFile('src/target.ts', 'folder:src'),
      mkDecl(
        'function',
        'src/target.ts',
        'src/target.ts::fn:targetFn',
        'file:src/target.ts',
        true,
        1,
      ),
      mkFile('src/h30.ts', 'folder:src'),
      mkDecl('function', 'src/h30.ts', 'src/h30.ts::fn:h30', 'file:src/h30.ts', true, 1),
      mkFile('src/h31.ts', 'folder:src'),
      mkDecl('function', 'src/h31.ts', 'src/h31.ts::fn:h31', 'file:src/h31.ts', true, 1),
    ];
    const fanEdges: ExtractedEdge[] = [
      {
        sourceQualifiedName: 'src/h30.ts::fn:h30',
        targetQualifiedName: 'src/target.ts::fn:targetFn',
        edgeType: 'CALLS',
        callSiteLine: 2,
        callSiteSnippet: 'targetFn()',
      },
      {
        sourceQualifiedName: 'src/h31.ts::fn:h31',
        targetQualifiedName: 'src/target.ts::fn:targetFn',
        edgeType: 'CALLS',
        callSiteLine: 2,
        callSiteSnippet: 'targetFn()',
      },
    ];
    for (let i = 1; i <= 31; i += 1) {
      const fp = `src/u${String(i).padStart(2, '0')}.ts`;
      const qn = `${fp}::fn:u${String(i).padStart(2, '0')}`;
      fanNodes.push(mkFile(fp, 'folder:src'), mkDecl('function', fp, qn, `file:${fp}`, true, 1));
      if (i <= 30)
        fanEdges.push({
          sourceQualifiedName: qn,
          targetQualifiedName: 'src/h30.ts::fn:h30',
          edgeType: 'CALLS',
          callSiteLine: 2,
          callSiteSnippet: 'h30()',
        });
      fanEdges.push({
        sourceQualifiedName: qn,
        targetQualifiedName: 'src/h31.ts::fn:h31',
        edgeType: 'CALLS',
        callSiteLine: 3,
        callSiteSnippet: 'h31()',
      });
    }
    const fanPub = await publishFixtureRepo(ingestionRepo, {
      owner: 'br-hub',
      name: 'fan',
      commitSha: '9595959595959595959595959595959595959595',
      output: makeOutput(fanNodes, fanEdges),
      ttlDays: 1,
      now: t0,
    });
    const fanDbNodes = await clientA.db
      .select()
      .from(nodes)
      .where(eq(nodes.repoId, fanPub.repository.id));
    const fanTarget = fanDbNodes.find((n) => n.qualifiedName === 'src/target.ts::fn:targetFn');
    if (!fanTarget) throw new Error('Expected fanTarget');

    // 29 -> both h30(30>29) & h31(31>29) are hubs; 30 -> only h31(31>30) is a hub; 31 -> 0 hubs
    expect(
      (
        await graphRepo.getBlastRadius({
          repoId: fanPub.repository.id,
          nodeId: fanTarget.id,
          maxDepth: 1,
          hubThreshold: 29,
          now: t0,
        })
      ).summary,
    ).toMatchObject({
      impactedNodeHubCount: 2,
      impactedFileRollupHubCount: 2,
    });
    expect(
      (
        await graphRepo.getBlastRadius({
          repoId: fanPub.repository.id,
          nodeId: fanTarget.id,
          maxDepth: 1,
          hubThreshold: 30,
          now: t0,
        })
      ).summary,
    ).toMatchObject({
      impactedNodeHubCount: 1,
      impactedFileRollupHubCount: 1,
    });
    expect(
      (
        await graphRepo.getBlastRadius({
          repoId: fanPub.repository.id,
          nodeId: fanTarget.id,
          maxDepth: 1,
          hubThreshold: 31,
          now: t0,
        })
      ).summary,
    ).toMatchObject({
      impactedNodeHubCount: 0,
      impactedFileRollupHubCount: 0,
    });

    // Terminal-hop frontier limit (maxDepth=1 discovers 2 callables h30+h31 > maxFrontierSize=1)
    const frontierTight = createGraphQueryRepository(clientA.db, {
      blastRadiusLimits: { maxFrontierSize: 1 },
    });
    await expectGraphError(
      frontierTight.getBlastRadius({
        repoId: fanPub.repository.id,
        nodeId: fanTarget.id,
        maxDepth: 1,
        now: t0,
      }),
      'BLAST_RADIUS_BUDGET_EXCEEDED',
    );

    // Logical expiry -> REPO_EXPIRED
    await expectGraphError(
      graphRepo.getBlastRadius({
        repoId: fanPub.repository.id,
        nodeId: fanTarget.id,
        maxDepth: 1,
        now: tPurge,
      }),
      'REPO_EXPIRED',
    );

    // Concurrent expiration under REPEATABLE READ READ ONLY: retain & drain BOTH promises safely
    const repoB = createIngestionRepository(clientB.db);
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    let markReady!: () => void;
    const ready = new Promise<void>((r) => {
      markReady = r;
    });

    let readErr: unknown = null;
    let deleteErr: unknown = null;
    const snapPromise = runBoundedReadTransaction(clientA.db, async (tx) => {
      const r = await tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, fanPub.repository.id));
      expect(r).toHaveLength(1);
      markReady();
      await withTimeout(gate, 5_000, 'blast-radius expiration gate');
      const eRows = await tx
        .select({ id: edges.id })
        .from(edges)
        .where(eq(edges.repoId, fanPub.repository.id));
      return eRows.length;
    }).catch((err: unknown) => {
      readErr = err;
      return null;
    });

    let deletePromise: Promise<readonly string[] | null> | undefined;
    let snapEdgeCount: number | null;
    let deletedIds: readonly string[] | null;
    try {
      await withTimeout(ready, 5_000, 'blast-radius snapshot ready');
      deletePromise = repoB.deleteExpiredRepositories(tPurge).catch((err: unknown) => {
        deleteErr = err;
        return null;
      });
      deletedIds = await withTimeout(deletePromise, 5_000, 'concurrent deleteExpiredRepositories');
    } finally {
      releaseGate();
      await Promise.allSettled([snapPromise, deletePromise]);
      snapEdgeCount = await snapPromise;
    }

    expect(readErr).toBeNull();
    expect(deleteErr).toBeNull();
    expect(deletedIds).toContain(fanPub.repository.id);
    expect(snapEdgeCount).toBe(63);
    await expectGraphError(
      graphRepo.getBlastRadius({
        repoId: fanPub.repository.id,
        nodeId: fanTarget.id,
        maxDepth: 1,
        now: tPurge,
      }),
      'REPO_NOT_FOUND',
    );
  });
});
