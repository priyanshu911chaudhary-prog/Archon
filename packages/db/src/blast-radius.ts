import {
  DEFAULT_BLAST_RADIUS_MAX_DEPTH,
  MAX_BLAST_RADIUS_MAX_DEPTH,
  MIN_BLAST_RADIUS_MAX_DEPTH,
  compareBlastRadiusCallSites,
  compareBlastRadiusImpactedFiles,
  compareBlastRadiusImpactedFolders,
  compareBlastRadiusImpactedNodes,
  isCallableOrSymbolNodeType,
  sortBlastRadiusReasonsCanonical,
  type BlastRadiusCallSite,
  type BlastRadiusImpactedFile,
  type BlastRadiusImpactedFolder,
  type BlastRadiusImpactedNode,
  type BlastRadiusPropagationModel,
  type BlastRadiusReason,
  type BlastRadiusResponse,
  type NodeType,
} from '@archon/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { ArchonDatabase } from './client.js';
import { DbError } from './errors.js';
import {
  DEFAULT_GRAPH_QUERY_LIMITS,
  DEFAULT_GRAPH_READ_TX_TIMEOUT_CONFIG,
  GraphQueryError,
  NODE_METADATA_COLUMNS,
  ZERO_DEGREE_STATS,
  assertResponseByteBudget,
  expandContainmentSubtreeBounded,
  gatePersistedRepository,
  loadDependentFileCounts,
  loadNodeIncomingDegrees,
  requireNormalizedUuid,
  resolveHubThreshold,
  runBoundedReadTransaction,
  type GraphQueryLimits,
  type NodeMetadataRow,
  type QualifyingEdgeBudgetTracker,
} from './graph-query-helpers.js';
import type { ArchonTransaction, TransactionTimeoutConfig } from './repository.js';
import { edges, nodes } from './schema.js';

export interface BlastRadiusLimits {
  readonly maxContainmentDepth: number;
  readonly maxSeedNodes: number;
  readonly maxFrontierSize: number;
  readonly maxVisitedStates: number;
  readonly maxCumulativeRawEdges: number;
  readonly maxEvidenceItems: number;
  readonly maxResponseBytes: number;
}

/**
 * Proposed cumulative blast-radius budgets (not measured capacity claims).
 * Every limit fails loudly with `BLAST_RADIUS_BUDGET_EXCEEDED` or `GRAPH_RESPONSE_TOO_LARGE`;
 * partial traversal is never returned as complete.
 */
export const DEFAULT_BLAST_RADIUS_LIMITS: BlastRadiusLimits = Object.freeze({
  maxContainmentDepth: 64,
  maxSeedNodes: 1_000,
  maxFrontierSize: 500,
  maxVisitedStates: 1_000,
  maxCumulativeRawEdges: 10_000,
  maxEvidenceItems: 2_000,
  maxResponseBytes: 2 * 1024 * 1024,
});

export const HARD_MAX_BLAST_RADIUS_LIMITS: BlastRadiusLimits = Object.freeze({
  maxContainmentDepth: 128,
  maxSeedNodes: 5_000,
  maxFrontierSize: 2_500,
  maxVisitedStates: 5_000,
  maxCumulativeRawEdges: 50_000,
  maxEvidenceItems: 10_000,
  maxResponseBytes: 4 * 1024 * 1024,
});

export interface GetBlastRadiusInput {
  readonly repoId: string;
  readonly nodeId: string;
  readonly maxDepth?: number;
  readonly hubThreshold?: number;
  readonly now?: Date;
}

const CALLS_ONLY_NOTE =
  'Callable, class, and symbol targets traverse reverse CALLS edges only; enclosing files and ancestor folders are projected at zero hops without file-wide IMPORTS expansion.';
const CONSERVATIVE_FILE_WIDE_NOTE =
  'File-wide propagation conservatively treats files importing or calling exported declarations of an impacted file as structurally impacted; this represents static dependency reachability, not runtime execution certainty.';

function assertBlastLimit(name: keyof BlastRadiusLimits, value: number): void {
  const ceiling = HARD_MAX_BLAST_RADIUS_LIMITS[name];
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new DbError(
      'DB_VALIDATION_ERROR',
      `BlastRadiusLimits.${name} must be an integer between 1 and ${String(ceiling)}.`,
    );
  }
}

export function validateBlastRadiusLimits(
  overrides: Partial<BlastRadiusLimits> = {},
): BlastRadiusLimits {
  const resolved: BlastRadiusLimits = {
    maxContainmentDepth:
      overrides.maxContainmentDepth ?? DEFAULT_BLAST_RADIUS_LIMITS.maxContainmentDepth,
    maxSeedNodes: overrides.maxSeedNodes ?? DEFAULT_BLAST_RADIUS_LIMITS.maxSeedNodes,
    maxFrontierSize: overrides.maxFrontierSize ?? DEFAULT_BLAST_RADIUS_LIMITS.maxFrontierSize,
    maxVisitedStates: overrides.maxVisitedStates ?? DEFAULT_BLAST_RADIUS_LIMITS.maxVisitedStates,
    maxCumulativeRawEdges:
      overrides.maxCumulativeRawEdges ?? DEFAULT_BLAST_RADIUS_LIMITS.maxCumulativeRawEdges,
    maxEvidenceItems: overrides.maxEvidenceItems ?? DEFAULT_BLAST_RADIUS_LIMITS.maxEvidenceItems,
    maxResponseBytes: overrides.maxResponseBytes ?? DEFAULT_BLAST_RADIUS_LIMITS.maxResponseBytes,
  };
  assertBlastLimit('maxContainmentDepth', resolved.maxContainmentDepth);
  assertBlastLimit('maxSeedNodes', resolved.maxSeedNodes);
  assertBlastLimit('maxFrontierSize', resolved.maxFrontierSize);
  assertBlastLimit('maxVisitedStates', resolved.maxVisitedStates);
  assertBlastLimit('maxCumulativeRawEdges', resolved.maxCumulativeRawEdges);
  assertBlastLimit('maxEvidenceItems', resolved.maxEvidenceItems);
  assertBlastLimit('maxResponseBytes', resolved.maxResponseBytes);
  return resolved;
}

function resolveMaxDepth(raw: number | undefined): number {
  const val = raw ?? DEFAULT_BLAST_RADIUS_MAX_DEPTH;
  if (
    !Number.isSafeInteger(val) ||
    val < MIN_BLAST_RADIUS_MAX_DEPTH ||
    val > MAX_BLAST_RADIUS_MAX_DEPTH
  ) {
    throw new GraphQueryError(
      'INVALID_QUERY',
      `maxDepth must be an integer between ${String(MIN_BLAST_RADIUS_MAX_DEPTH)} and ${String(MAX_BLAST_RADIUS_MAX_DEPTH)}.`,
    );
  }
  return val;
}

interface ImpactedStateEntry {
  readonly node: NodeMetadataRow;
  readonly hop: number;
  readonly reasons: Set<BlastRadiusReason>;
  readonly viaNodeIds: Set<string>;
  readonly callSiteKeys: Set<string>;
  readonly callSites: BlastRadiusCallSite[];
}

interface CumulativeBudgetState {
  rawEdgesScanned: number;
  evidenceItems: number;
}

function createSharedEdgeBudgetTracker(
  budget: CumulativeBudgetState,
  maxCumulativeRawEdges: number,
): QualifyingEdgeBudgetTracker {
  return {
    remaining: () => Math.max(0, maxCumulativeRawEdges - budget.rawEdgesScanned),
    consume: (observedRows: number, stage: string) => {
      const next = budget.rawEdgesScanned + observedRows;
      if (next > maxCumulativeRawEdges) {
        throw new GraphQueryError(
          'BLAST_RADIUS_BUDGET_EXCEEDED',
          `Blast-radius exceeded cumulative qualifying edge budget during ${stage}.`,
          { maxCumulativeRawEdges, stage },
        );
      }
      budget.rawEdgesScanned = next;
    },
    onExceeded: (stage: string): never => {
      throw new GraphQueryError(
        'BLAST_RADIUS_BUDGET_EXCEEDED',
        `Blast-radius exceeded cumulative qualifying edge budget during ${stage}.`,
        { maxCumulativeRawEdges, stage },
      );
    },
  };
}

async function loadExportedCallablesForFiles(
  tx: ArchonTransaction,
  repoId: string,
  filePaths: readonly string[],
  maxFrontierSize: number,
): Promise<readonly NodeMetadataRow[]> {
  if (filePaths.length === 0) return [];
  const uniquePaths = [...new Set(filePaths)];
  const callableTypes: readonly NodeType[] = ['function', 'class', 'symbol'];
  const rows = await tx
    .select(NODE_METADATA_COLUMNS)
    .from(nodes)
    .where(
      and(
        eq(nodes.repoId, repoId),
        inArray(nodes.filePath, uniquePaths),
        inArray(nodes.nodeType, [...callableTypes]),
        eq(nodes.isExported, true),
      ),
    )
    .limit(maxFrontierSize + 1);
  if (rows.length > maxFrontierSize) {
    throw new GraphQueryError(
      'BLAST_RADIUS_BUDGET_EXCEEDED',
      'Exported declaration frontier exceeds maximum allowed frontier size.',
      { maxFrontierSize },
    );
  }
  return rows;
}

async function loadEnclosingFilesByPaths(
  tx: ArchonTransaction,
  repoId: string,
  filePaths: readonly string[],
  maxLookupFiles: number,
): Promise<ReadonlyMap<string, NodeMetadataRow>> {
  const map = new Map<string, NodeMetadataRow>();
  if (filePaths.length === 0) return map;
  const uniquePaths = [...new Set(filePaths)];
  if (uniquePaths.length > maxLookupFiles) {
    throw new GraphQueryError(
      'BLAST_RADIUS_BUDGET_EXCEEDED',
      'Enclosing file lookup exceeds maximum allowed visited-state budget.',
      { maxVisitedStates: maxLookupFiles },
    );
  }
  const rows = await tx
    .select(NODE_METADATA_COLUMNS)
    .from(nodes)
    .where(
      and(
        eq(nodes.repoId, repoId),
        eq(nodes.nodeType, 'file'),
        inArray(nodes.filePath, uniquePaths),
      ),
    )
    .limit(uniquePaths.length + 1);
  for (const r of rows) {
    map.set(r.filePath, r);
  }
  for (const p of uniquePaths) {
    if (!map.has(p)) {
      throw new GraphQueryError(
        'GRAPH_CONTAINMENT_INVALID',
        'Inconsistent containment: impacted callable has no enclosing file node in repository.',
      );
    }
  }
  return map;
}

function getOrCreateLayerEntry(
  layerMap: Map<string, ImpactedStateEntry>,
  node: NodeMetadataRow,
  hop: number,
): ImpactedStateEntry {
  let entry = layerMap.get(node.id);
  if (entry === undefined) {
    entry = {
      node,
      hop,
      reasons: new Set<BlastRadiusReason>(),
      viaNodeIds: new Set<string>(),
      callSiteKeys: new Set<string>(),
      callSites: [],
    };
    layerMap.set(node.id, entry);
  }
  return entry;
}

function recordCallSiteEvidence(
  entry: ImpactedStateEntry,
  viaNodeId: string,
  callSiteLine: number,
  budget: CumulativeBudgetState,
  maxEvidenceItems: number,
): void {
  const key = `${viaNodeId}\0${String(callSiteLine)}`;
  if (entry.callSiteKeys.has(key)) return;
  if (budget.evidenceItems + 1 > maxEvidenceItems) {
    throw new GraphQueryError(
      'BLAST_RADIUS_BUDGET_EXCEEDED',
      'Blast-radius call-site evidence count exceeds maximum allowed evidence budget.',
      { maxEvidenceItems },
    );
  }
  entry.callSiteKeys.add(key);
  entry.callSites.push({ viaNodeId, callSiteLine });
  budget.evidenceItems += 1;
}

function assertValidFolderParentType(childType: NodeType, parentType: NodeType): void {
  if ((childType === 'folder' || childType === 'file') && parentType !== 'folder') {
    throw new GraphQueryError(
      'GRAPH_CONTAINMENT_INVALID',
      'Inconsistent containment: folder or file node has a non-folder parent.',
    );
  }
}

export async function executeBlastRadiusQuery(
  db: ArchonDatabase,
  input: GetBlastRadiusInput,
  limits: BlastRadiusLimits,
  timeouts: TransactionTimeoutConfig = DEFAULT_GRAPH_READ_TX_TIMEOUT_CONFIG,
): Promise<BlastRadiusResponse> {
  const repoId = requireNormalizedUuid('repoId', input.repoId);
  const nodeId = requireNormalizedUuid('nodeId', input.nodeId);
  const maxDepth = resolveMaxDepth(input.maxDepth);
  const hubThreshold = resolveHubThreshold(input.hubThreshold);
  const now = input.now ?? new Date();

  const result = await runBoundedReadTransaction(
    db,
    async (tx): Promise<BlastRadiusResponse> => {
      const repo = await gatePersistedRepository(tx, repoId, now);

      const targetRows = await tx
        .select(NODE_METADATA_COLUMNS)
        .from(nodes)
        .where(and(eq(nodes.repoId, repo.id), eq(nodes.id, nodeId)))
        .limit(1);
      const target = targetRows[0];
      if (target === undefined) {
        throw new GraphQueryError('NODE_NOT_FOUND', 'Node not found in repository.');
      }

      const isCallableTarget = isCallableOrSymbolNodeType(target.nodeType);
      const propagationModel: BlastRadiusPropagationModel = isCallableTarget
        ? 'calls_only'
        : 'conservative_file_wide_structural';

      const seedLimits: GraphQueryLimits = {
        ...DEFAULT_GRAPH_QUERY_LIMITS,
        maxContainmentDepth: limits.maxContainmentDepth,
        maxFrontierSize: limits.maxFrontierSize,
        maxScannedNodes: limits.maxSeedNodes,
        maxReturnedNodes: limits.maxSeedNodes,
      };

      const excludedNodeIds = new Set<string>();
      const excludedFileIds = new Set<string>();
      const excludedFolderIds = new Set<string>();

      let fileFrontier: NodeMetadataRow[] = [];
      let callableFrontier: NodeMetadataRow[] = [];
      let seedFileCount = 0;
      let seedExportedCallableCount = 0;

      if (isCallableTarget) {
        excludedNodeIds.add(target.id);
        callableFrontier = [target];
      } else {
        let expanded;
        try {
          expanded = await expandContainmentSubtreeBounded(
            tx,
            repo.id,
            [target],
            seedLimits,
            'GRAPH_BUDGET_EXCEEDED',
          );
        } catch (err) {
          if (err instanceof GraphQueryError && err.code === 'GRAPH_BUDGET_EXCEEDED') {
            throw new GraphQueryError(
              'BLAST_RADIUS_BUDGET_EXCEEDED',
              'Target containment seed exceeds blast-radius seed/containment budget.',
              err.details,
            );
          }
          throw err;
        }

        for (const n of expanded.nodes) {
          excludedNodeIds.add(n.id);
          if (n.nodeType === 'file') {
            excludedFileIds.add(n.id);
            fileFrontier.push(n);
          } else if (n.nodeType === 'folder') {
            excludedFolderIds.add(n.id);
          } else if (n.isExported) {
            seedExportedCallableCount += 1;
          }
        }
        seedFileCount = fileFrontier.length;
      }

      if (excludedNodeIds.size > limits.maxSeedNodes) {
        throw new GraphQueryError(
          'BLAST_RADIUS_BUDGET_EXCEEDED',
          'Target seed node count exceeds maximum allowed seed budget.',
          { maxSeedNodes: limits.maxSeedNodes },
        );
      }
      if (fileFrontier.length + callableFrontier.length > limits.maxFrontierSize) {
        throw new GraphQueryError(
          'BLAST_RADIUS_BUDGET_EXCEEDED',
          'Initial seed frontier exceeds maximum allowed frontier size.',
          { maxFrontierSize: limits.maxFrontierSize },
        );
      }

      // Distinct visited traversal state sets (file states vs callable states; strictly disjoint by nodeType)
      const visitedFileIds = new Set<string>(excludedFileIds);
      const visitedCallableIds = new Set<string>(isCallableTarget ? [target.id] : []);
      if (visitedFileIds.size + visitedCallableIds.size > limits.maxVisitedStates) {
        throw new GraphQueryError(
          'BLAST_RADIUS_BUDGET_EXCEEDED',
          'Initial visited seed states exceed maximum allowed visited-state budget.',
          { maxVisitedStates: limits.maxVisitedStates },
        );
      }

      // Impacted state maps are strictly disjoint by nodeType (`file` vs `function|class|symbol`)
      const impactedFileEntries = new Map<string, ImpactedStateEntry>();
      const impactedCallableEntries = new Map<string, ImpactedStateEntry>();
      const budget: CumulativeBudgetState = { rawEdgesScanned: 0, evidenceItems: 0 };
      const edgeBudgetTracker = createSharedEdgeBudgetTracker(budget, limits.maxCumulativeRawEdges);
      let virtualExportedTargetsExpanded = 0;

      for (let hop = 1; hop <= maxDepth; hop += 1) {
        if (fileFrontier.length === 0 && callableFrontier.length === 0) {
          break;
        }
        if (fileFrontier.length + callableFrontier.length > limits.maxFrontierSize) {
          throw new GraphQueryError(
            'BLAST_RADIUS_BUDGET_EXCEEDED',
            `Frontier at hop ${String(hop)} exceeds maximum allowed frontier size.`,
            { hop, maxFrontierSize: limits.maxFrontierSize },
          );
        }

        const layerFiles = new Map<string, ImpactedStateEntry>();
        const layerCallables = new Map<string, ImpactedStateEntry>();

        // 1. Reverse IMPORTS from current fileFrontier (file/folder propagation only)
        if (!isCallableTarget && fileFrontier.length > 0) {
          const fileTargetIds = fileFrontier.map((f) => f.id);
          const remaining = edgeBudgetTracker.remaining();
          const importRows = await tx
            .select({
              targetNodeId: edges.targetNodeId,
              sourceNode: NODE_METADATA_COLUMNS,
            })
            .from(edges)
            .innerJoin(nodes, and(eq(nodes.repoId, edges.repoId), eq(nodes.id, edges.sourceNodeId)))
            .where(
              and(
                eq(edges.repoId, repo.id),
                eq(edges.edgeType, 'IMPORTS'),
                inArray(edges.targetNodeId, fileTargetIds),
                ne(edges.sourceNodeId, edges.targetNodeId),
              ),
            )
            .limit(remaining + 1);

          if (importRows.length > remaining) {
            edgeBudgetTracker.onExceeded(`hop_${String(hop)}_imports`);
          }
          edgeBudgetTracker.consume(importRows.length, `hop_${String(hop)}_imports`);

          for (const row of importRows) {
            const srcFile = row.sourceNode;
            if (
              srcFile.nodeType !== 'file' ||
              excludedNodeIds.has(srcFile.id) ||
              visitedFileIds.has(srcFile.id)
            ) {
              continue;
            }
            const entry = getOrCreateLayerEntry(layerFiles, srcFile, hop);
            entry.reasons.add('imports_file');
            entry.viaNodeIds.add(row.targetNodeId);
          }
        }

        // 2. Build reverse CALLS target set: direct callableFrontier + virtual exported declarations of fileFrontier
        const directCallableIds = new Set<string>(callableFrontier.map((c) => c.id));
        const exportedFromFiles =
          !isCallableTarget && fileFrontier.length > 0
            ? await loadExportedCallablesForFiles(
                tx,
                repo.id,
                fileFrontier.map((f) => f.filePath),
                limits.maxFrontierSize,
              )
            : [];
        virtualExportedTargetsExpanded += exportedFromFiles.length;

        const exportedFromFileIds = new Set<string>(exportedFromFiles.map((e) => e.id));
        const callTargetIdsSet = new Set<string>(directCallableIds);
        for (const id of exportedFromFileIds) {
          callTargetIdsSet.add(id);
        }
        const callTargetIds = [...callTargetIdsSet];
        if (callTargetIds.length > limits.maxFrontierSize) {
          throw new GraphQueryError(
            'BLAST_RADIUS_BUDGET_EXCEEDED',
            `CALLS target frontier at hop ${String(hop)} exceeds maximum allowed frontier size.`,
            { hop, maxFrontierSize: limits.maxFrontierSize },
          );
        }

        if (callTargetIds.length > 0) {
          const remaining = edgeBudgetTracker.remaining();
          const callRows = await tx
            .select({
              targetNodeId: edges.targetNodeId,
              callSiteLine: edges.callSiteLine,
              sourceNode: NODE_METADATA_COLUMNS,
            })
            .from(edges)
            .innerJoin(nodes, and(eq(nodes.repoId, edges.repoId), eq(nodes.id, edges.sourceNodeId)))
            .where(
              and(
                eq(edges.repoId, repo.id),
                eq(edges.edgeType, 'CALLS'),
                inArray(edges.targetNodeId, callTargetIds),
                ne(edges.sourceNodeId, edges.targetNodeId),
              ),
            )
            .limit(remaining + 1);

          if (callRows.length > remaining) {
            edgeBudgetTracker.onExceeded(`hop_${String(hop)}_calls`);
          }
          edgeBudgetTracker.consume(callRows.length, `hop_${String(hop)}_calls`);

          for (const row of callRows) {
            const caller = row.sourceNode;
            if (excludedNodeIds.has(caller.id)) {
              continue;
            }
            const isDirectCallable = directCallableIds.has(row.targetNodeId);
            const isExportedTarget = exportedFromFileIds.has(row.targetNodeId);

            if (caller.nodeType === 'file') {
              // Top-level file-scope CALLS: route to layerFiles (never layerCallables) for unique UUIDs
              if (visitedFileIds.has(caller.id)) {
                continue;
              }
              const entry = getOrCreateLayerEntry(layerFiles, caller, hop);
              if (isDirectCallable) entry.reasons.add('calls_symbol');
              if (isExportedTarget) entry.reasons.add('calls_exported_symbol');
              entry.viaNodeIds.add(row.targetNodeId);
              if (row.callSiteLine !== null) {
                recordCallSiteEvidence(
                  entry,
                  row.targetNodeId,
                  row.callSiteLine,
                  budget,
                  limits.maxEvidenceItems,
                );
              }
            } else if (isCallableOrSymbolNodeType(caller.nodeType)) {
              if (visitedCallableIds.has(caller.id)) {
                continue;
              }
              const entry = getOrCreateLayerEntry(layerCallables, caller, hop);
              if (isDirectCallable) entry.reasons.add('calls_symbol');
              if (isExportedTarget) entry.reasons.add('calls_exported_symbol');
              entry.viaNodeIds.add(row.targetNodeId);
              if (row.callSiteLine !== null) {
                recordCallSiteEvidence(
                  entry,
                  row.targetNodeId,
                  row.callSiteLine,
                  budget,
                  limits.maxEvidenceItems,
                );
              }
            }
          }
        }

        // 3. Zero-hop containment projection: newly discovered callables project to their enclosing files
        if (!isCallableTarget && layerCallables.size > 0) {
          const callableFilePaths = [...layerCallables.values()].map((e) => e.node.filePath);
          const enclosingByPath = await loadEnclosingFilesByPaths(
            tx,
            repo.id,
            callableFilePaths,
            limits.maxVisitedStates,
          );
          for (const callableEntry of layerCallables.values()) {
            const enclosingFile = enclosingByPath.get(callableEntry.node.filePath);
            if (
              enclosingFile === undefined ||
              excludedNodeIds.has(enclosingFile.id) ||
              visitedFileIds.has(enclosingFile.id)
            ) {
              continue;
            }
            const fileEntry = getOrCreateLayerEntry(layerFiles, enclosingFile, hop);
            fileEntry.reasons.add('contains_impacted_callable');
            fileEntry.viaNodeIds.add(callableEntry.node.id);
          }
        }

        // 4. Commit full frontier layer & enforce terminal-hop frontier and visited-state budgets
        const nextFileFrontier: NodeMetadataRow[] = [];
        const nextCallableFrontier: NodeMetadataRow[] = [];

        for (const [fId, fEntry] of layerFiles) {
          visitedFileIds.add(fId);
          impactedFileEntries.set(fId, fEntry);
          if (!isCallableTarget) {
            nextFileFrontier.push(fEntry.node);
          }
        }
        for (const [cId, cEntry] of layerCallables) {
          visitedCallableIds.add(cId);
          impactedCallableEntries.set(cId, cEntry);
          nextCallableFrontier.push(cEntry.node);
        }

        const discoveredLayerSize = layerFiles.size + layerCallables.size;
        if (discoveredLayerSize > limits.maxFrontierSize) {
          throw new GraphQueryError(
            'BLAST_RADIUS_BUDGET_EXCEEDED',
            `Discovered frontier at hop ${String(hop)} exceeds maximum allowed frontier size.`,
            { hop, maxFrontierSize: limits.maxFrontierSize, discoveredLayerSize },
          );
        }
        const totalVisitedStates = visitedFileIds.size + visitedCallableIds.size;
        if (totalVisitedStates > limits.maxVisitedStates) {
          throw new GraphQueryError(
            'BLAST_RADIUS_BUDGET_EXCEEDED',
            'Total visited blast-radius traversal states exceed maximum allowed budget.',
            { maxVisitedStates: limits.maxVisitedStates, visitedStates: totalVisitedStates },
          );
        }

        fileFrontier = nextFileFrontier;
        callableFrontier = nextCallableFrontier;
      }

      // 5. Build complete impactedFiles rollup (distinct file UUIDs; files never counted in impactedCallableCount)
      interface FileRollupAcc {
        readonly fileNode: NodeMetadataRow;
        minHop: number;
        readonly reasons: Set<BlastRadiusReason>;
        readonly viaNodeIds: Set<string>;
        impactedCallableCount: number;
      }
      const fileRollups = new Map<string, FileRollupAcc>();

      for (const fEntry of impactedFileEntries.values()) {
        fileRollups.set(fEntry.node.id, {
          fileNode: fEntry.node,
          minHop: fEntry.hop,
          reasons: new Set(fEntry.reasons),
          viaNodeIds: new Set(fEntry.viaNodeIds),
          impactedCallableCount: 0,
        });
      }

      if (impactedCallableEntries.size > 0) {
        const allCallablePaths = [...impactedCallableEntries.values()].map((e) => e.node.filePath);
        const enclosingByPath = await loadEnclosingFilesByPaths(
          tx,
          repo.id,
          allCallablePaths,
          limits.maxVisitedStates,
        );
        for (const cEntry of impactedCallableEntries.values()) {
          const encFile = enclosingByPath.get(cEntry.node.filePath);
          if (encFile === undefined) continue;
          const existing = fileRollups.get(encFile.id);
          if (existing === undefined) {
            fileRollups.set(encFile.id, {
              fileNode: encFile,
              minHop: cEntry.hop,
              reasons: new Set<BlastRadiusReason>(['contains_impacted_callable']),
              viaNodeIds: new Set<string>([cEntry.node.id]),
              impactedCallableCount: 1,
            });
          } else {
            existing.impactedCallableCount += 1;
            if (cEntry.hop < existing.minHop) {
              existing.minHop = cEntry.hop;
              existing.reasons.clear();
              existing.reasons.add('contains_impacted_callable');
              existing.viaNodeIds.clear();
              existing.viaNodeIds.add(cEntry.node.id);
            } else if (cEntry.hop === existing.minHop) {
              existing.reasons.add('contains_impacted_callable');
              existing.viaNodeIds.add(cEntry.node.id);
            }
          }
        }
      }

      if (fileRollups.size > limits.maxVisitedStates) {
        throw new GraphQueryError(
          'BLAST_RADIUS_BUDGET_EXCEEDED',
          'Impacted file rollup count exceeds maximum allowed visited-state budget.',
          { maxVisitedStates: limits.maxVisitedStates },
        );
      }

      // 6. Zero-hop ancestor folder rollup with deduplicated frontiers & cycle/depth/missing checks
      const folderCache = new Map<string, NodeMetadataRow>();
      const folderAcc = new Map<
        string,
        { readonly folder: NodeMetadataRow; minHop: number; readonly fileIds: Set<string> }
      >();

      let pendingParentIds = [
        ...new Set(
          [...fileRollups.values()]
            .map((f) => f.fileNode.parentNodeId)
            .filter((id): id is string => id !== null),
        ),
      ];
      const fetchedParents = new Set<string>();

      for (let depth = 0; pendingParentIds.length > 0; depth += 1) {
        if (depth >= limits.maxContainmentDepth) {
          throw new GraphQueryError(
            'BLAST_RADIUS_BUDGET_EXCEEDED',
            'Ancestor folder containment depth exceeded while rolling up impacted folders.',
            { maxContainmentDepth: limits.maxContainmentDepth },
          );
        }
        const toFetch = [...new Set(pendingParentIds)].filter((id) => !fetchedParents.has(id));
        if (toFetch.length === 0) break;
        if (toFetch.length > limits.maxFrontierSize) {
          throw new GraphQueryError(
            'BLAST_RADIUS_BUDGET_EXCEEDED',
            'Ancestor folder frontier exceeds maximum allowed frontier size.',
            { maxFrontierSize: limits.maxFrontierSize },
          );
        }
        if (fetchedParents.size + toFetch.length > limits.maxVisitedStates) {
          throw new GraphQueryError(
            'BLAST_RADIUS_BUDGET_EXCEEDED',
            'Ancestor folder expansion exceeds maximum allowed visited-state budget.',
            { maxVisitedStates: limits.maxVisitedStates },
          );
        }
        for (const id of toFetch) fetchedParents.add(id);

        const parentRows = await tx
          .select(NODE_METADATA_COLUMNS)
          .from(nodes)
          .where(and(eq(nodes.repoId, repo.id), inArray(nodes.id, toFetch)));
        if (parentRows.length !== toFetch.length) {
          throw new GraphQueryError(
            'GRAPH_CONTAINMENT_INVALID',
            'Inconsistent containment: ancestor folder missing in repository.',
          );
        }
        const nextParents = new Set<string>();
        for (const p of parentRows) {
          folderCache.set(p.id, p);
          if (p.parentNodeId !== null && !fetchedParents.has(p.parentNodeId)) {
            nextParents.add(p.parentNodeId);
          }
        }
        pendingParentIds = [...nextParents];
      }

      for (const fAcc of fileRollups.values()) {
        const seenAnc = new Set<string>([fAcc.fileNode.id]);
        let childType: NodeType = fAcc.fileNode.nodeType;
        let curParentId = fAcc.fileNode.parentNodeId;
        for (let depth = 0; curParentId !== null; depth += 1) {
          if (seenAnc.has(curParentId)) {
            throw new GraphQueryError(
              'GRAPH_CONTAINMENT_INVALID',
              'Cyclic folder containment detected during blast-radius folder rollup.',
            );
          }
          if (depth >= limits.maxContainmentDepth) {
            throw new GraphQueryError(
              'BLAST_RADIUS_BUDGET_EXCEEDED',
              'Folder containment depth exceeded during blast-radius folder rollup.',
            );
          }
          seenAnc.add(curParentId);
          const parentFolder = folderCache.get(curParentId);
          if (parentFolder === undefined) {
            throw new GraphQueryError(
              'GRAPH_CONTAINMENT_INVALID',
              'Inconsistent containment: ancestor folder missing.',
            );
          }
          assertValidFolderParentType(childType, parentFolder.nodeType);
          if (!excludedFolderIds.has(parentFolder.id)) {
            const cur = folderAcc.get(parentFolder.id);
            if (cur === undefined) {
              folderAcc.set(parentFolder.id, {
                folder: parentFolder,
                minHop: fAcc.minHop,
                fileIds: new Set([fAcc.fileNode.id]),
              });
            } else {
              cur.minHop = Math.min(cur.minHop, fAcc.minHop);
              cur.fileIds.add(fAcc.fileNode.id);
            }
          }
          childType = parentFolder.nodeType;
          curParentId = parentFolder.parentNodeId;
        }
      }

      if (folderAcc.size > limits.maxVisitedStates) {
        throw new GraphQueryError(
          'BLAST_RADIUS_BUDGET_EXCEEDED',
          'Impacted folder rollup count exceeds maximum allowed visited-state budget.',
          { maxVisitedStates: limits.maxVisitedStates },
        );
      }

      // 7. Degree & file-rollup enrichment sharing the exact same cumulative edge budget tracker
      const allImpactedEntries: ImpactedStateEntry[] = [
        ...impactedFileEntries.values(),
        ...impactedCallableEntries.values(),
      ];
      const allDegreeNodeIds = [
        ...new Set([
          ...allImpactedEntries.map((e) => e.node.id),
          ...[...fileRollups.values()].map((f) => f.fileNode.id),
        ]),
      ];
      const allImpactedFilePaths = [...fileRollups.values()].map((f) => f.fileNode.filePath);

      const degreeLimits: GraphQueryLimits = {
        ...DEFAULT_GRAPH_QUERY_LIMITS,
        maxScannedNodes: Math.max(limits.maxVisitedStates, limits.maxSeedNodes, 1),
        maxReturnedNodes: Math.max(limits.maxVisitedStates, limits.maxSeedNodes, 1),
        maxScannedRawEdges: limits.maxCumulativeRawEdges,
        maxReturnedEdges: Math.min(
          limits.maxCumulativeRawEdges,
          DEFAULT_GRAPH_QUERY_LIMITS.maxReturnedEdges,
        ),
      };

      let degreeMap;
      let depFileMap;
      try {
        degreeMap = await loadNodeIncomingDegrees(
          tx,
          repo.id,
          allDegreeNodeIds,
          degreeLimits,
          'GRAPH_BUDGET_EXCEEDED',
          edgeBudgetTracker,
        );
        depFileMap = await loadDependentFileCounts(
          tx,
          repo.id,
          allImpactedFilePaths,
          degreeLimits,
          'GRAPH_BUDGET_EXCEEDED',
          edgeBudgetTracker,
        );
      } catch (err) {
        if (err instanceof GraphQueryError && err.code === 'GRAPH_BUDGET_EXCEEDED') {
          throw new GraphQueryError(
            'BLAST_RADIUS_BUDGET_EXCEEDED',
            'Cumulative node or edge budget exceeded during degree enrichment.',
            err.details,
          );
        }
        throw err;
      }

      // 8. Assemble deterministic response collections
      const impactedNodes: BlastRadiusImpactedNode[] = allImpactedEntries
        .map((e) => {
          const deg = degreeMap.get(e.node.id) ?? ZERO_DEGREE_STATS;
          const depFiles =
            e.node.nodeType === 'file' ? (depFileMap.get(e.node.filePath) ?? 0) : null;
          const sortedSites = [...e.callSites].sort(compareBlastRadiusCallSites);
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
            viaNodeIds: [...e.viaNodeIds].sort(),
            callSiteCount: sortedSites.length,
            callSites: sortedSites,
            inDegreeDistinct: deg.inDegreeDistinct,
            rawIncomingEdgeCount: deg.rawIncomingEdgeCount,
            distinctImporterCount: deg.distinctImporterCount,
            distinctCallerCount: deg.distinctCallerCount,
            dependentFileCount: depFiles,
            isHub: deg.inDegreeDistinct > hubThreshold,
            isFileRollupHub: depFiles !== null ? depFiles > hubThreshold : null,
          };
        })
        .sort(compareBlastRadiusImpactedNodes);

      const impactedFiles: BlastRadiusImpactedFile[] = [...fileRollups.values()]
        .map((f) => {
          const deg = degreeMap.get(f.fileNode.id) ?? ZERO_DEGREE_STATS;
          const depFiles = depFileMap.get(f.fileNode.filePath) ?? 0;
          return {
            fileNodeId: f.fileNode.id,
            name: f.fileNode.name,
            qualifiedName: f.fileNode.qualifiedName,
            filePath: f.fileNode.filePath,
            parentNodeId: f.fileNode.parentNodeId,
            minHop: f.minHop,
            reasons: sortBlastRadiusReasonsCanonical(f.reasons),
            viaNodeIds: [...f.viaNodeIds].sort(),
            impactedCallableCount: f.impactedCallableCount,
            inDegreeDistinct: deg.inDegreeDistinct,
            rawIncomingEdgeCount: deg.rawIncomingEdgeCount,
            dependentFileCount: depFiles,
            isHub: deg.inDegreeDistinct > hubThreshold,
            isFileRollupHub: depFiles > hubThreshold,
          };
        })
        .sort(compareBlastRadiusImpactedFiles);

      const impactedFolders: BlastRadiusImpactedFolder[] = [...folderAcc.values()]
        .map((d) => ({
          folderNodeId: d.folder.id,
          name: d.folder.name,
          qualifiedName: d.folder.qualifiedName,
          folderPath: d.folder.filePath,
          parentNodeId: d.folder.parentNodeId,
          minHop: d.minHop,
          impactedFileCount: d.fileIds.size,
        }))
        .sort(compareBlastRadiusImpactedFolders);

      const byHop = {
        '1': { nodes: 0, files: 0, folders: 0 },
        '2': { nodes: 0, files: 0, folders: 0 },
        '3': { nodes: 0, files: 0, folders: 0 },
      };
      for (const n of impactedNodes) {
        const key = String(n.hop) as '1' | '2' | '3';
        byHop[key].nodes += 1;
      }
      for (const f of impactedFiles) {
        const key = String(f.minHop) as '1' | '2' | '3';
        byHop[key].files += 1;
      }
      for (const d of impactedFolders) {
        const key = String(d.minHop) as '1' | '2' | '3';
        byHop[key].folders += 1;
      }

      return {
        target: {
          id: target.id,
          repoId: repo.id,
          nodeType: target.nodeType,
          name: target.name,
          qualifiedName: target.qualifiedName,
          filePath: target.filePath,
          isExported: target.isExported,
          seedFileCount,
          seedExportedCallableCount,
          excludedSubtreeNodeCount: excludedNodeIds.size,
        },
        params: { maxDepth, hubThreshold },
        semantics: {
          propagationModel,
          fileWidePropagationNote: isCallableTarget ? CALLS_ONLY_NOTE : CONSERVATIVE_FILE_WIDE_NOTE,
          containmentProjectionHops: 0,
          hubPredicate: 'inDegreeDistinct > hubThreshold',
          fileRollupHubPredicate: 'dependentFileCount > hubThreshold',
        },
        completeness: {
          complete: true,
          traversalStrategy: 'bounded_reverse_frontier_bfs',
          visitedFileStates: visitedFileIds.size,
          visitedCallableStates: visitedCallableIds.size,
          virtualExportedTargetsExpanded,
          cumulativeRawEdgesScanned: budget.rawEdgesScanned,
          totalEvidenceItems: budget.evidenceItems,
        },
        summary: {
          totalImpactedNodes: impactedNodes.length,
          directNodeCount: byHop['1'].nodes,
          transitiveNodeCount: byHop['2'].nodes + byHop['3'].nodes,
          totalImpactedFiles: impactedFiles.length,
          directFileCount: byHop['1'].files,
          transitiveFileCount: byHop['2'].files + byHop['3'].files,
          totalImpactedFolders: impactedFolders.length,
          directFolderCount: byHop['1'].folders,
          transitiveFolderCount: byHop['2'].folders + byHop['3'].folders,
          impactedNodeHubCount: impactedNodes.filter((n) => n.isHub).length,
          impactedFileRollupHubCount: impactedFiles.filter((f) => f.isFileRollupHub).length,
          byHop,
        },
        impactedNodes,
        impactedFiles,
        impactedFolders,
      };
    },
    timeouts,
  );

  assertResponseByteBudget(result, limits.maxResponseBytes);
  return result;
}
