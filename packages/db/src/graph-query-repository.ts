import {
  GraphCursorValidationError,
  MAX_GRAPH_FILE_PATH_CHARS,
  NODE_TYPE_SORT_RANK,
  compareGraphAggregatedEdges,
  compareGraphNodeSummaries,
  computeGraphCursorQueryHash,
  decodeGraphCursor,
  encodeGraphCursor,
  hubsCursorKeySchema,
  nodeChildrenCursorKeySchema,
  nodeEdgesCursorKeySchema,
  sortEdgeTypesCanonical,
  type EdgeDirection,
  type EdgeType,
  type EdgeTypeFilter,
  type GraphAggregatedEdge,
  type GraphZoomLevel,
  type HubDegreeMetric,
  type HubNodeItem,
  type HubScope,
  type NodeAncestor,
  type NodeDetailResponse,
  type NodeEdgeEvidenceItem,
  type NodeEdgesResponse,
  type NodeType,
  type RepositoryGraphViewResponse,
  type RepositoryHubsResponse,
} from '@archon/shared';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { ArchonDatabase } from './client.js';
import {
  DEFAULT_GRAPH_READ_TX_TIMEOUT_CONFIG,
  GraphQueryError,
  NODE_METADATA_COLUMNS,
  ZERO_DEGREE_STATS,
  assertBoundedIncidentEdgesForNode,
  assertBoundedOutgoingEdgesForNode,
  assertBoundedRawEdgeScan,
  assertBoundedRawNodeScan,
  assertResponseByteBudget,
  buildGraphNodeSummary,
  countDirectChildrenBounded,
  expandContainmentSubtreeBounded,
  gatePersistedRepository,
  loadDependentFileCounts,
  loadNodeIncomingDegrees,
  requireNormalizedUuid,
  resolveHubThreshold,
  resolvePageLimit,
  runBoundedReadTransaction,
  validateGraphQueryLimits,
  type GraphQueryLimits,
  type NodeMetadataRow,
} from './graph-query-helpers.js';
import type { TransactionTimeoutConfig } from './repository.js';
import { edges, isEmptyJsTsRepository, nodes } from './schema.js';

export interface GetRepositoryGraphInput {
  readonly repoId: string;
  readonly level?: GraphZoomLevel;
  readonly scopeNodeId?: string;
  readonly filePath?: string;
  readonly includeImports?: boolean;
  readonly hubThreshold?: number;
  readonly now?: Date;
}

export interface GetNodeDetailInput {
  readonly repoId: string;
  readonly nodeId: string;
  readonly hubThreshold?: number;
  readonly childrenLimit?: number;
  readonly childrenCursor?: string;
  readonly now?: Date;
}

export interface GetNodeEdgesInput {
  readonly repoId: string;
  readonly nodeId: string;
  readonly direction?: EdgeDirection;
  readonly edgeType?: EdgeTypeFilter;
  readonly peerNodeId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly now?: Date;
}

export interface GetRepositoryHubsInput {
  readonly repoId: string;
  readonly threshold?: number;
  readonly scope?: HubScope;
  readonly limit?: number;
  readonly cursor?: string;
  readonly now?: Date;
}

export interface GraphQueryRepositoryOptions {
  readonly limits?: Partial<GraphQueryLimits>;
  readonly timeouts?: TransactionTimeoutConfig;
}

export interface GraphQueryRepository {
  getRepositoryGraph(input: GetRepositoryGraphInput): Promise<RepositoryGraphViewResponse>;
  getNodeDetail(input: GetNodeDetailInput): Promise<NodeDetailResponse>;
  getNodeEdges(input: GetNodeEdgesInput): Promise<NodeEdgesResponse>;
  getRepositoryHubs(input: GetRepositoryHubsInput): Promise<RepositoryHubsResponse>;
}

interface MutableAggEdge {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly edgeTypes: Set<EdgeType>;
  importEdgeCount: number;
  callEdgeCount: number;
  distinctCallPairs: number;
  minCallSiteLine: number | null;
  readonly isSelfEdge: boolean;
}

function mergeAggEdge(
  map: Map<string, MutableAggEdge>,
  sourceNodeId: string,
  targetNodeId: string,
  edgeType: EdgeType,
  edgeCount: number,
  distinctCallPairs: number,
  minCallSiteLine: number | null,
): void {
  const key = `${sourceNodeId}\0${targetNodeId}`;
  let entry = map.get(key);
  if (entry === undefined) {
    entry = {
      sourceNodeId,
      targetNodeId,
      edgeTypes: new Set<EdgeType>(),
      importEdgeCount: 0,
      callEdgeCount: 0,
      distinctCallPairs: 0,
      minCallSiteLine: null,
      isSelfEdge: sourceNodeId === targetNodeId,
    };
    map.set(key, entry);
  }
  entry.edgeTypes.add(edgeType);
  if (edgeType === 'IMPORTS') {
    entry.importEdgeCount += edgeCount;
  } else {
    entry.callEdgeCount += edgeCount;
    entry.distinctCallPairs += distinctCallPairs;
    if (
      minCallSiteLine !== null &&
      (entry.minCallSiteLine === null || minCallSiteLine < entry.minCallSiteLine)
    ) {
      entry.minCallSiteLine = minCallSiteLine;
    }
  }
}

function finalizeAggEdges(
  map: ReadonlyMap<string, MutableAggEdge>,
  maxReturnedEdges: number,
  budgetErrorCode: 'GRAPH_SCOPE_REQUIRED' | 'GRAPH_BUDGET_EXCEEDED',
): GraphAggregatedEdge[] {
  if (map.size > maxReturnedEdges) {
    throw new GraphQueryError(
      budgetErrorCode,
      'Aggregated graph edge count exceeds maximum response limit; narrow the requested scope.',
      { returnedEdges: map.size, maxReturnedEdges },
    );
  }
  const out: GraphAggregatedEdge[] = [];
  for (const e of map.values()) {
    out.push({
      sourceNodeId: e.sourceNodeId,
      targetNodeId: e.targetNodeId,
      edgeTypes: sortEdgeTypesCanonical(e.edgeTypes),
      importEdgeCount: e.importEdgeCount,
      callEdgeCount: e.callEdgeCount,
      distinctCallPairs: e.distinctCallPairs,
      minCallSiteLine: e.minCallSiteLine,
      isSelfEdge: e.isSelfEdge,
    });
  }
  out.sort(compareGraphAggregatedEdges);
  return out;
}

function wrapCursorError(err: unknown): never {
  if (err instanceof GraphCursorValidationError) {
    throw new GraphQueryError('INVALID_CURSOR', err.message);
  }
  throw err;
}

function assertValidParentChildTypes(childType: NodeType, parentType: NodeType): void {
  if ((childType === 'folder' || childType === 'file') && parentType !== 'folder') {
    throw new GraphQueryError(
      'GRAPH_CONTAINMENT_INVALID',
      'Inconsistent containment: folder or file node has a non-folder parent.',
    );
  }
  if (
    (childType === 'function' || childType === 'class' || childType === 'symbol') &&
    parentType === 'folder'
  ) {
    throw new GraphQueryError(
      'GRAPH_CONTAINMENT_INVALID',
      'Inconsistent containment: declaration node cannot have a folder as direct parent.',
    );
  }
}

const NODE_TYPE_RANK_SQL = sql<number>`CASE ${nodes.nodeType} WHEN 'folder' THEN 0 WHEN 'file' THEN 1 WHEN 'class' THEN 2 WHEN 'function' THEN 3 ELSE 4 END`;

export function createGraphQueryRepository(
  db: ArchonDatabase,
  options: GraphQueryRepositoryOptions = {},
): GraphQueryRepository {
  const limits = validateGraphQueryLimits(options.limits);
  const timeouts = options.timeouts ?? DEFAULT_GRAPH_READ_TX_TIMEOUT_CONFIG;

  async function getRepositoryGraph(
    input: GetRepositoryGraphInput,
  ): Promise<RepositoryGraphViewResponse> {
    const repoId = requireNormalizedUuid('repoId', input.repoId);
    const level: GraphZoomLevel = input.level ?? 'file';
    const includeImports = input.includeImports ?? true;
    const hubThreshold = resolveHubThreshold(input.hubThreshold);
    const now = input.now ?? new Date();

    if (input.scopeNodeId !== undefined && input.filePath !== undefined) {
      throw new GraphQueryError(
        'INVALID_QUERY',
        'Cannot specify both scopeNodeId and filePath on graph query.',
      );
    }
    const normalizedScopeNodeId =
      input.scopeNodeId !== undefined
        ? requireNormalizedUuid('scopeNodeId', input.scopeNodeId)
        : undefined;
    if (input.filePath !== undefined) {
      if (level !== 'function') {
        throw new GraphQueryError(
          'INVALID_QUERY',
          'filePath scope parameter is supported only at level=function.',
        );
      }
      if (input.filePath.length === 0 || input.filePath.length > MAX_GRAPH_FILE_PATH_CHARS) {
        throw new GraphQueryError('INVALID_QUERY', 'filePath is empty or exceeds maximum length.');
      }
    }

    const result = await runBoundedReadTransaction(
      db,
      async (tx): Promise<RepositoryGraphViewResponse> => {
        const repo = await gatePersistedRepository(tx, repoId, now);
        const repoHeader = {
          repoId: repo.id,
          owner: repo.owner,
          name: repo.name,
          commitSha: repo.commitSha,
          defaultBranch: repo.defaultBranch,
          status: 'ready' as const,
          fileCount: repo.fileCount,
          skippedFilesCount: repo.skippedFilesCount,
          emptyJsTs: isEmptyJsTsRepository(repo),
          graphPersistedAt: (repo.graphPersistedAt ?? repo.updatedAt).toISOString(),
        };

        let visibleNodes: NodeMetadataRow[];
        let resolvedScopeNodeId: string | null = null;
        let resolvedScopeFilePath: string | null = null;
        const aggEdges = new Map<string, MutableAggEdge>();
        const isUnscoped = normalizedScopeNodeId === undefined && input.filePath === undefined;
        const budgetCode: 'GRAPH_SCOPE_REQUIRED' | 'GRAPH_BUDGET_EXCEEDED' = isUnscoped
          ? 'GRAPH_SCOPE_REQUIRED'
          : 'GRAPH_BUDGET_EXCEEDED';

        if (level === 'folder') {
          let immediateChildren: NodeMetadataRow[];
          if (normalizedScopeNodeId !== undefined) {
            const scopeRows = await tx
              .select(NODE_METADATA_COLUMNS)
              .from(nodes)
              .where(and(eq(nodes.repoId, repo.id), eq(nodes.id, normalizedScopeNodeId)))
              .limit(1);
            const scopeNode = scopeRows[0];
            if (scopeNode === undefined) {
              throw new GraphQueryError('NODE_NOT_FOUND', 'Scope node not found in repository.');
            }
            if (scopeNode.nodeType !== 'folder') {
              throw new GraphQueryError(
                'INVALID_SCOPE_NODE',
                'Folder zoom scopeNodeId must reference a folder node.',
              );
            }
            resolvedScopeNodeId = scopeNode.id;
            immediateChildren = await tx
              .select(NODE_METADATA_COLUMNS)
              .from(nodes)
              .where(and(eq(nodes.repoId, repo.id), eq(nodes.parentNodeId, scopeNode.id)))
              .limit(limits.maxReturnedNodes + 1);
          } else {
            immediateChildren = await tx
              .select(NODE_METADATA_COLUMNS)
              .from(nodes)
              .where(and(eq(nodes.repoId, repo.id), isNull(nodes.parentNodeId)))
              .limit(limits.maxReturnedNodes + 1);
          }

          if (immediateChildren.length > limits.maxReturnedNodes) {
            throw new GraphQueryError(
              budgetCode,
              'Visible folder children exceed maximum returned node limit.',
              { maxReturnedNodes: limits.maxReturnedNodes },
            );
          }

          visibleNodes = immediateChildren;
          if (visibleNodes.length > 0) {
            const expanded = await expandContainmentSubtreeBounded(
              tx,
              repo.id,
              visibleNodes,
              limits,
              budgetCode,
            );
            const subtreeIds = expanded.nodes.map((n) => n.id);
            await assertBoundedRawEdgeScan(tx, repo.id, limits.maxScannedRawEdges, {
              errorCode: budgetCode,
              scopedNodeIds: isUnscoped ? undefined : subtreeIds,
              includeImports,
            });

            const baseWhere = isUnscoped
              ? eq(edges.repoId, repo.id)
              : and(
                  eq(edges.repoId, repo.id),
                  inArray(edges.sourceNodeId, subtreeIds),
                  inArray(edges.targetNodeId, subtreeIds),
                );
            const edgeWhere = includeImports
              ? baseWhere
              : and(baseWhere, eq(edges.edgeType, 'CALLS'));

            const groupedEdges = await tx
              .select({
                sourceNodeId: edges.sourceNodeId,
                targetNodeId: edges.targetNodeId,
                edgeType: edges.edgeType,
                edgeCount: sql<number>`COUNT(*)::int`,
                minCallSiteLine: sql<number | null>`MIN(${edges.callSiteLine})::int`,
              })
              .from(edges)
              .where(edgeWhere)
              .groupBy(edges.sourceNodeId, edges.targetNodeId, edges.edgeType);

            for (const row of groupedEdges) {
              const srcContainer = expanded.containerByNodeId.get(row.sourceNodeId);
              const tgtContainer = expanded.containerByNodeId.get(row.targetNodeId);
              if (
                srcContainer === undefined ||
                tgtContainer === undefined ||
                srcContainer === tgtContainer
              ) {
                continue;
              }
              mergeAggEdge(
                aggEdges,
                srcContainer,
                tgtContainer,
                row.edgeType,
                row.edgeCount,
                row.edgeType === 'CALLS' ? 1 : 0,
                row.minCallSiteLine,
              );
            }
          }
        } else if (level === 'file') {
          let scopedSubtreeIds: string[] | undefined;
          let fileIdByNodeId: Map<string, string> | undefined;

          if (normalizedScopeNodeId !== undefined) {
            const scopeRows = await tx
              .select(NODE_METADATA_COLUMNS)
              .from(nodes)
              .where(and(eq(nodes.repoId, repo.id), eq(nodes.id, normalizedScopeNodeId)))
              .limit(1);
            const scopeNode = scopeRows[0];
            if (scopeNode === undefined) {
              throw new GraphQueryError('NODE_NOT_FOUND', 'Scope node not found in repository.');
            }
            if (scopeNode.nodeType !== 'folder') {
              throw new GraphQueryError(
                'INVALID_SCOPE_NODE',
                'File zoom scopeNodeId must reference a folder node.',
              );
            }
            resolvedScopeNodeId = scopeNode.id;
            const expanded = await expandContainmentSubtreeBounded(
              tx,
              repo.id,
              [scopeNode],
              limits,
              'GRAPH_BUDGET_EXCEEDED',
            );
            visibleNodes = expanded.nodes.filter((n) => n.nodeType === 'file');
            const fileIdByPath = new Map(visibleNodes.map((f) => [f.filePath, f.id]));
            fileIdByNodeId = new Map<string, string>();
            for (const n of expanded.nodes) {
              if (n.nodeType !== 'folder') {
                const enclosingFileId = fileIdByPath.get(n.filePath);
                if (enclosingFileId !== undefined) {
                  fileIdByNodeId.set(n.id, enclosingFileId);
                }
              }
            }
            scopedSubtreeIds = [...fileIdByNodeId.keys()];
          } else {
            await assertBoundedRawNodeScan(tx, repo.id, limits.maxScannedNodes, {
              errorCode: 'GRAPH_SCOPE_REQUIRED',
              suggestedLevel: 'folder',
            });
            visibleNodes = await tx
              .select(NODE_METADATA_COLUMNS)
              .from(nodes)
              .where(and(eq(nodes.repoId, repo.id), eq(nodes.nodeType, 'file')))
              .limit(limits.maxReturnedNodes + 1);
          }

          if (visibleNodes.length > limits.maxReturnedNodes) {
            throw new GraphQueryError(
              budgetCode,
              'File zoom node count exceeds maximum response limit; scope to a folder.',
              { maxReturnedNodes: limits.maxReturnedNodes, suggestedLevel: 'folder' },
            );
          }

          if (visibleNodes.length > 0) {
            await assertBoundedRawEdgeScan(tx, repo.id, limits.maxScannedRawEdges, {
              errorCode: budgetCode,
              scopedNodeIds: scopedSubtreeIds,
              includeImports,
              suggestedLevel: 'folder',
            });

            if (scopedSubtreeIds !== undefined && fileIdByNodeId !== undefined) {
              // Exact same node-ID population as the raw-edge work probe above
              const baseWhere = and(
                eq(edges.repoId, repo.id),
                inArray(edges.sourceNodeId, scopedSubtreeIds),
                inArray(edges.targetNodeId, scopedSubtreeIds),
              );
              const edgeWhere = includeImports
                ? baseWhere
                : and(baseWhere, eq(edges.edgeType, 'CALLS'));

              const grouped = await tx
                .select({
                  sourceNodeId: edges.sourceNodeId,
                  targetNodeId: edges.targetNodeId,
                  edgeType: edges.edgeType,
                  edgeCount: sql<number>`COUNT(*)::int`,
                  minCallSiteLine: sql<number | null>`MIN(${edges.callSiteLine})::int`,
                })
                .from(edges)
                .where(edgeWhere)
                .groupBy(edges.sourceNodeId, edges.targetNodeId, edges.edgeType);

              for (const row of grouped) {
                const srcFileId = fileIdByNodeId.get(row.sourceNodeId);
                const tgtFileId = fileIdByNodeId.get(row.targetNodeId);
                if (srcFileId === undefined || tgtFileId === undefined || srcFileId === tgtFileId) {
                  continue;
                }
                mergeAggEdge(
                  aggEdges,
                  srcFileId,
                  tgtFileId,
                  row.edgeType,
                  row.edgeCount,
                  row.edgeType === 'CALLS' ? 1 : 0,
                  row.minCallSiteLine,
                );
              }
            } else {
              const fileIdByPath = new Map(visibleNodes.map((f) => [f.filePath, f.id]));
              const typeFilterSql = includeImports ? sql`` : sql`AND e.edge_type = 'CALLS'`;
              const execEdges = await tx.execute(sql`
                SELECT
                  src.file_path AS src_path,
                  tgt.file_path AS tgt_path,
                  e.edge_type AS edge_type,
                  COUNT(*)::int AS edge_count,
                  COUNT(DISTINCT (e.source_node_id, e.target_node_id))::int AS distinct_pairs,
                  MIN(e.call_site_line)::int AS min_line
                FROM edges e
                INNER JOIN nodes src ON src.repo_id = e.repo_id AND src.id = e.source_node_id
                INNER JOIN nodes tgt ON tgt.repo_id = e.repo_id AND tgt.id = e.target_node_id
                WHERE e.repo_id = ${repo.id}
                  AND src.file_path <> tgt.file_path
                  ${typeFilterSql}
                GROUP BY src.file_path, tgt.file_path, e.edge_type
              `);

              for (const rawRow of execEdges.rows) {
                const srcPath = rawRow.src_path;
                const tgtPath = rawRow.tgt_path;
                const srcId = typeof srcPath === 'string' ? fileIdByPath.get(srcPath) : undefined;
                const tgtId = typeof tgtPath === 'string' ? fileIdByPath.get(tgtPath) : undefined;
                if (srcId === undefined || tgtId === undefined || srcId === tgtId) continue;
                const et: EdgeType = rawRow.edge_type === 'IMPORTS' ? 'IMPORTS' : 'CALLS';
                const cnt = Number(rawRow.edge_count ?? 0);
                const pairs = Number(rawRow.distinct_pairs ?? 0);
                const minLine = typeof rawRow.min_line === 'number' ? rawRow.min_line : null;
                mergeAggEdge(aggEdges, srcId, tgtId, et, cnt, et === 'CALLS' ? pairs : 0, minLine);
              }
            }
          }
        } else {
          // level === 'function' (includes containment context: file + all nested declarations, or folder subtree)
          if (input.filePath !== undefined) {
            const fileRows = await tx
              .select(NODE_METADATA_COLUMNS)
              .from(nodes)
              .where(
                and(
                  eq(nodes.repoId, repo.id),
                  eq(nodes.nodeType, 'file'),
                  eq(nodes.filePath, input.filePath),
                ),
              )
              .limit(1);
            const fileNode = fileRows[0];
            if (fileNode === undefined) {
              throw new GraphQueryError('NODE_NOT_FOUND', 'File node not found in repository.');
            }
            resolvedScopeNodeId = fileNode.id;
            resolvedScopeFilePath = fileNode.filePath;
            const expanded = await expandContainmentSubtreeBounded(
              tx,
              repo.id,
              [fileNode],
              limits,
              'GRAPH_BUDGET_EXCEEDED',
            );
            visibleNodes = [...expanded.nodes];
          } else if (normalizedScopeNodeId !== undefined) {
            const scopeRows = await tx
              .select(NODE_METADATA_COLUMNS)
              .from(nodes)
              .where(and(eq(nodes.repoId, repo.id), eq(nodes.id, normalizedScopeNodeId)))
              .limit(1);
            const scopeNode = scopeRows[0];
            if (scopeNode === undefined) {
              throw new GraphQueryError('NODE_NOT_FOUND', 'Scope node not found in repository.');
            }
            if (scopeNode.nodeType !== 'folder' && scopeNode.nodeType !== 'file') {
              throw new GraphQueryError(
                'INVALID_SCOPE_NODE',
                'Function zoom scopeNodeId must reference a folder or file node.',
              );
            }
            resolvedScopeNodeId = scopeNode.id;
            if (scopeNode.nodeType === 'file') {
              resolvedScopeFilePath = scopeNode.filePath;
            }
            const expanded = await expandContainmentSubtreeBounded(
              tx,
              repo.id,
              [scopeNode],
              limits,
              'GRAPH_BUDGET_EXCEEDED',
            );
            visibleNodes = [...expanded.nodes];
          } else {
            await assertBoundedRawNodeScan(tx, repo.id, limits.maxScannedNodes, {
              errorCode: 'GRAPH_SCOPE_REQUIRED',
              suggestedLevel: 'file',
            });
            visibleNodes = await tx
              .select(NODE_METADATA_COLUMNS)
              .from(nodes)
              .where(eq(nodes.repoId, repo.id))
              .limit(limits.maxReturnedNodes + 1);
          }

          if (visibleNodes.length > limits.maxReturnedNodes) {
            throw new GraphQueryError(
              budgetCode,
              'Function zoom node count exceeds maximum response limit; provide scopeNodeId or filePath.',
              { maxReturnedNodes: limits.maxReturnedNodes, suggestedLevel: 'file' },
            );
          }

          if (visibleNodes.length > 0) {
            const visibleIds = visibleNodes.map((n) => n.id);
            await assertBoundedRawEdgeScan(tx, repo.id, limits.maxScannedRawEdges, {
              errorCode: budgetCode,
              scopedNodeIds: isUnscoped ? undefined : visibleIds,
              includeImports,
              suggestedLevel: 'file',
            });

            const baseWhere = isUnscoped
              ? eq(edges.repoId, repo.id)
              : and(
                  eq(edges.repoId, repo.id),
                  inArray(edges.sourceNodeId, visibleIds),
                  inArray(edges.targetNodeId, visibleIds),
                );
            const edgeWhere = includeImports
              ? baseWhere
              : and(baseWhere, eq(edges.edgeType, 'CALLS'));

            const grouped = await tx
              .select({
                sourceNodeId: edges.sourceNodeId,
                targetNodeId: edges.targetNodeId,
                edgeType: edges.edgeType,
                edgeCount: sql<number>`COUNT(*)::int`,
                minCallSiteLine: sql<number | null>`MIN(${edges.callSiteLine})::int`,
              })
              .from(edges)
              .where(edgeWhere)
              .groupBy(edges.sourceNodeId, edges.targetNodeId, edges.edgeType);

            const visibleIdSet = new Set(visibleIds);
            for (const row of grouped) {
              if (!visibleIdSet.has(row.sourceNodeId) || !visibleIdSet.has(row.targetNodeId)) {
                continue;
              }
              mergeAggEdge(
                aggEdges,
                row.sourceNodeId,
                row.targetNodeId,
                row.edgeType,
                row.edgeCount,
                row.edgeType === 'CALLS' ? 1 : 0,
                row.minCallSiteLine,
              );
            }
          }
        }

        const visibleIds = visibleNodes.map((n) => n.id);
        const visibleFilePaths = visibleNodes
          .filter((n) => n.nodeType === 'file')
          .map((n) => n.filePath);
        const degreeMap = await loadNodeIncomingDegrees(
          tx,
          repo.id,
          visibleIds,
          limits,
          budgetCode,
        );
        const depFileMap = await loadDependentFileCounts(
          tx,
          repo.id,
          visibleFilePaths,
          limits,
          budgetCode,
        );

        const nodeSummaries = visibleNodes
          .map((row) => buildGraphNodeSummary(row, degreeMap, depFileMap, hubThreshold))
          .sort(compareGraphNodeSummaries);
        const edgeItems = finalizeAggEdges(aggEdges, limits.maxReturnedEdges, budgetCode);

        return {
          repository: repoHeader,
          view: {
            level,
            scopeNodeId: resolvedScopeNodeId,
            scopeFilePath: resolvedScopeFilePath,
            includeImports,
            hubThreshold,
            complete: true,
          },
          counts: {
            returnedNodes: nodeSummaries.length,
            returnedEdges: edgeItems.length,
          },
          nodes: nodeSummaries,
          edges: edgeItems,
        };
      },
      timeouts,
    );

    assertResponseByteBudget(result, limits.maxResponseBytes);
    return result;
  }

  async function getNodeDetail(input: GetNodeDetailInput): Promise<NodeDetailResponse> {
    const repoId = requireNormalizedUuid('repoId', input.repoId);
    const nodeId = requireNormalizedUuid('nodeId', input.nodeId);
    const hubThreshold = resolveHubThreshold(input.hubThreshold);
    const childrenLimit = resolvePageLimit(input.childrenLimit);
    const now = input.now ?? new Date();

    const queryHash = computeGraphCursorQueryHash({
      endpoint: 'node_children',
      repoId,
      nodeId,
      hubThreshold,
    });
    const cursorKey =
      input.childrenCursor !== undefined
        ? (() => {
            try {
              return decodeGraphCursor(
                input.childrenCursor,
                { endpoint: 'node_children', repoId, queryHash },
                nodeChildrenCursorKeySchema,
              );
            } catch (err) {
              wrapCursorError(err);
            }
          })()
        : null;

    const result = await runBoundedReadTransaction(
      db,
      async (tx): Promise<NodeDetailResponse> => {
        const repo = await gatePersistedRepository(tx, repoId, now);

        const targetRows = await tx
          .select()
          .from(nodes)
          .where(and(eq(nodes.repoId, repo.id), eq(nodes.id, nodeId)))
          .limit(1);
        const target = targetRows[0];
        if (target === undefined) {
          throw new GraphQueryError('NODE_NOT_FOUND', 'Node not found in repository.');
        }

        // Strict ancestor walk: fails loudly on depth exhaustion, cycles, missing parents, or invalid containment
        const ancestorsRev: NodeAncestor[] = [];
        const seenAncestors = new Set<string>([target.id]);
        let childType: NodeType = target.nodeType;
        let currentParentId = target.parentNodeId;
        for (let depth = 0; currentParentId !== null; depth += 1) {
          if (seenAncestors.has(currentParentId)) {
            throw new GraphQueryError(
              'GRAPH_CONTAINMENT_INVALID',
              'Cyclic containment relationship detected while resolving ancestors.',
            );
          }
          if (depth >= limits.maxContainmentDepth) {
            throw new GraphQueryError(
              'GRAPH_BUDGET_EXCEEDED',
              'Node ancestor depth exceeds maximum allowed containment depth.',
              { maxContainmentDepth: limits.maxContainmentDepth },
            );
          }
          seenAncestors.add(currentParentId);
          const pRows = await tx
            .select({
              id: nodes.id,
              nodeType: nodes.nodeType,
              name: nodes.name,
              qualifiedName: nodes.qualifiedName,
              filePath: nodes.filePath,
              parentNodeId: nodes.parentNodeId,
            })
            .from(nodes)
            .where(and(eq(nodes.repoId, repo.id), eq(nodes.id, currentParentId)))
            .limit(1);
          const parent = pRows[0];
          if (parent === undefined) {
            throw new GraphQueryError(
              'GRAPH_CONTAINMENT_INVALID',
              'Inconsistent containment: ancestor node not found in repository.',
            );
          }
          assertValidParentChildTypes(childType, parent.nodeType);
          ancestorsRev.push({
            id: parent.id,
            nodeType: parent.nodeType,
            name: parent.name,
            qualifiedName: parent.qualifiedName,
            filePath: parent.filePath,
          });
          childType = parent.nodeType;
          currentParentId = parent.parentNodeId;
        }
        ancestorsRev.reverse();

        // Bound outgoing edges before COUNT(DISTINCT) / COUNT(*)
        await assertBoundedOutgoingEdgesForNode(tx, repo.id, target.id, limits.maxScannedRawEdges);
        const outRows = await tx
          .select({
            outDegreeDistinct: sql<number>`COUNT(DISTINCT ${edges.targetNodeId})::int`,
            rawOutgoingEdgeCount: sql<number>`COUNT(*)::int`,
          })
          .from(edges)
          .where(
            and(
              eq(edges.repoId, repo.id),
              eq(edges.sourceNodeId, target.id),
              ne(edges.sourceNodeId, edges.targetNodeId),
            ),
          );
        const outDegreeDistinct = outRows[0]?.outDegreeDistinct ?? 0;
        const rawOutgoingEdgeCount = outRows[0]?.rawOutgoingEdgeCount ?? 0;

        // Bound direct children count before pagination
        const totalChildrenCount = await countDirectChildrenBounded(
          tx,
          repo.id,
          target.id,
          limits.maxScannedNodes,
        );

        const childConditions = [eq(nodes.repoId, repo.id), eq(nodes.parentNodeId, target.id)];
        if (cursorKey !== null) {
          const anchorRows = await tx
            .select(NODE_METADATA_COLUMNS)
            .from(nodes)
            .where(
              and(
                eq(nodes.repoId, repo.id),
                eq(nodes.id, cursorKey.id),
                eq(nodes.parentNodeId, target.id),
              ),
            )
            .limit(1);
          const anchor = anchorRows[0];
          if (anchor === undefined) {
            throw new GraphQueryError(
              'INVALID_CURSOR',
              'Pagination cursor references a child node not found under this parent.',
            );
          }
          const anchorRank = NODE_TYPE_SORT_RANK[anchor.nodeType];
          const anchorStartLine = anchor.startLine ?? 0;
          childConditions.push(
            sql`(${NODE_TYPE_RANK_SQL}, ${nodes.filePath}, COALESCE(${nodes.startLine}, 0), ${nodes.qualifiedName}, ${nodes.id}) > (${anchorRank}, ${anchor.filePath}, ${anchorStartLine}, ${anchor.qualifiedName}, ${anchor.id}::uuid)`,
          );
        }

        const childRows = await tx
          .select(NODE_METADATA_COLUMNS)
          .from(nodes)
          .where(and(...childConditions))
          .orderBy(
            NODE_TYPE_RANK_SQL,
            nodes.filePath,
            sql`COALESCE(${nodes.startLine}, 0)`,
            nodes.qualifiedName,
            nodes.id,
          )
          .limit(childrenLimit + 1);

        const hasMoreChildren = childRows.length > childrenLimit;
        const pageChildren = hasMoreChildren ? childRows.slice(0, childrenLimit) : childRows;

        const idsForDegrees = [target.id, ...pageChildren.map((c) => c.id)];
        const filePathsForRollup = [
          ...(target.nodeType === 'file' ? [target.filePath] : []),
          ...pageChildren.filter((c) => c.nodeType === 'file').map((c) => c.filePath),
        ];
        const degreeMap = await loadNodeIncomingDegrees(tx, repo.id, idsForDegrees, limits);
        const depFileMap = await loadDependentFileCounts(tx, repo.id, filePathsForRollup, limits);

        const targetIn = degreeMap.get(target.id) ?? ZERO_DEGREE_STATS;
        const targetDepFiles =
          target.nodeType === 'file' ? (depFileMap.get(target.filePath) ?? 0) : null;

        const childSummaries = pageChildren.map((c) =>
          buildGraphNodeSummary(c, degreeMap, depFileMap, hubThreshold),
        );
        const lastChild = pageChildren.at(-1);
        const nextCursor =
          hasMoreChildren && lastChild !== undefined
            ? encodeGraphCursor({
                endpoint: 'node_children',
                repoId: repo.id,
                queryHash,
                key: { id: lastChild.id },
              })
            : null;

        return {
          node: {
            id: target.id,
            repoId: target.repoId,
            nodeType: target.nodeType,
            name: target.name,
            qualifiedName: target.qualifiedName,
            filePath: target.filePath,
            parentNodeId: target.parentNodeId,
            isExported: target.isExported,
            startLine: target.startLine,
            endLine: target.endLine,
            contentHash: target.contentHash,
            snippet: target.snippet,
          },
          ancestors: ancestorsRev,
          degree: {
            inDegreeDistinct: targetIn.inDegreeDistinct,
            rawIncomingEdgeCount: targetIn.rawIncomingEdgeCount,
            outDegreeDistinct,
            rawOutgoingEdgeCount,
            distinctImporterCount: targetIn.distinctImporterCount,
            distinctCallerCount: targetIn.distinctCallerCount,
            dependentFileCount: targetDepFiles,
            hubThreshold,
            isHub: targetIn.inDegreeDistinct > hubThreshold,
            isFileRollupHub: targetDepFiles !== null ? targetDepFiles > hubThreshold : null,
          },
          children: {
            items: childSummaries,
            totalCount: totalChildrenCount,
            page: {
              limit: childrenLimit,
              hasMore: hasMoreChildren,
              nextCursor,
            },
          },
        };
      },
      timeouts,
    );

    assertResponseByteBudget(result, limits.maxResponseBytes);
    return result;
  }

  async function getNodeEdges(input: GetNodeEdgesInput): Promise<NodeEdgesResponse> {
    const repoId = requireNormalizedUuid('repoId', input.repoId);
    const nodeId = requireNormalizedUuid('nodeId', input.nodeId);
    const peerNodeId =
      input.peerNodeId !== undefined
        ? requireNormalizedUuid('peerNodeId', input.peerNodeId)
        : undefined;
    const direction: EdgeDirection = input.direction ?? 'incoming';
    const edgeType: EdgeTypeFilter = input.edgeType ?? 'all';
    const limit = resolvePageLimit(input.limit);
    const now = input.now ?? new Date();

    const queryHash = computeGraphCursorQueryHash({
      endpoint: 'node_edges',
      repoId,
      nodeId,
      direction,
      edgeType,
      peerNodeId: peerNodeId ?? null,
    });
    const cursorKey =
      input.cursor !== undefined
        ? (() => {
            try {
              return decodeGraphCursor(
                input.cursor,
                { endpoint: 'node_edges', repoId, queryHash },
                nodeEdgesCursorKeySchema,
              );
            } catch (err) {
              wrapCursorError(err);
            }
          })()
        : null;

    const result = await runBoundedReadTransaction(
      db,
      async (tx): Promise<NodeEdgesResponse> => {
        const repo = await gatePersistedRepository(tx, repoId, now);

        const existsRows = await tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(and(eq(nodes.repoId, repo.id), eq(nodes.id, nodeId)))
          .limit(1);
        if (existsRows[0] === undefined) {
          throw new GraphQueryError('NODE_NOT_FOUND', 'Node not found in repository.');
        }

        // Bound qualifying incident edge rows BEFORE join + sort
        await assertBoundedIncidentEdgesForNode(
          tx,
          repo.id,
          nodeId,
          direction,
          edgeType,
          peerNodeId,
          limits.maxScannedRawEdges,
        );

        const peerJoinCol = direction === 'incoming' ? edges.sourceNodeId : edges.targetNodeId;
        const anchorCol = direction === 'incoming' ? edges.targetNodeId : edges.sourceNodeId;

        const conditions = [eq(edges.repoId, repo.id), eq(anchorCol, nodeId)];
        if (edgeType !== 'all') {
          conditions.push(eq(edges.edgeType, edgeType));
        }
        if (peerNodeId !== undefined) {
          conditions.push(eq(peerJoinCol, peerNodeId));
        }

        if (cursorKey !== null) {
          const anchorRows = await tx
            .select({
              edgeId: edges.id,
              edgeType: edges.edgeType,
              callSiteLine: edges.callSiteLine,
              peerQualifiedName: nodes.qualifiedName,
            })
            .from(edges)
            .innerJoin(nodes, and(eq(nodes.repoId, edges.repoId), eq(nodes.id, peerJoinCol)))
            .where(and(...conditions, eq(edges.id, cursorKey.edgeId)))
            .limit(1);
          const anchor = anchorRows[0];
          if (anchor === undefined) {
            throw new GraphQueryError(
              'INVALID_CURSOR',
              'Pagination cursor references an edge not matching this query.',
            );
          }
          const anchorLine = anchor.callSiteLine ?? 0;
          conditions.push(
            sql`(${edges.edgeType}, COALESCE(${edges.callSiteLine}, 0), ${nodes.qualifiedName}, ${edges.id}) > (${anchor.edgeType}, ${anchorLine}, ${anchor.peerQualifiedName}, ${anchor.edgeId}::uuid)`,
          );
        }

        const rows = await tx
          .select({
            edgeId: edges.id,
            edgeType: edges.edgeType,
            sourceNodeId: edges.sourceNodeId,
            targetNodeId: edges.targetNodeId,
            callSiteLine: edges.callSiteLine,
            callSiteSnippet: edges.callSiteSnippet,
            peerId: nodes.id,
            peerNodeType: nodes.nodeType,
            peerName: nodes.name,
            peerQualifiedName: nodes.qualifiedName,
            peerFilePath: nodes.filePath,
            peerIsExported: nodes.isExported,
            peerStartLine: nodes.startLine,
            peerEndLine: nodes.endLine,
          })
          .from(edges)
          .innerJoin(nodes, and(eq(nodes.repoId, edges.repoId), eq(nodes.id, peerJoinCol)))
          .where(and(...conditions))
          .orderBy(
            edges.edgeType,
            sql`COALESCE(${edges.callSiteLine}, 0)`,
            nodes.qualifiedName,
            edges.id,
          )
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const items: NodeEdgeEvidenceItem[] = pageRows.map((r) => ({
          edgeId: r.edgeId,
          edgeType: r.edgeType,
          direction,
          sourceNodeId: r.sourceNodeId,
          targetNodeId: r.targetNodeId,
          peerNode: {
            id: r.peerId,
            nodeType: r.peerNodeType,
            name: r.peerName,
            qualifiedName: r.peerQualifiedName,
            filePath: r.peerFilePath,
            isExported: r.peerIsExported,
            startLine: r.peerStartLine,
            endLine: r.peerEndLine,
          },
          callSiteLine: r.callSiteLine,
          callSiteSnippet: r.callSiteSnippet,
        }));

        const last = pageRows.at(-1);
        const nextCursor =
          hasMore && last !== undefined
            ? encodeGraphCursor({
                endpoint: 'node_edges',
                repoId: repo.id,
                queryHash,
                key: { edgeId: last.edgeId },
              })
            : null;

        return {
          nodeId,
          direction,
          edgeType,
          peerNodeId: peerNodeId ?? null,
          items,
          page: { limit, hasMore, nextCursor },
        };
      },
      timeouts,
    );

    assertResponseByteBudget(result, limits.maxResponseBytes);
    return result;
  }

  async function getRepositoryHubs(input: GetRepositoryHubsInput): Promise<RepositoryHubsResponse> {
    const repoId = requireNormalizedUuid('repoId', input.repoId);
    const threshold = resolveHubThreshold(input.threshold);
    const scope: HubScope = input.scope ?? 'all';
    const limit = resolvePageLimit(input.limit);
    const now = input.now ?? new Date();
    const degreeMetric: HubDegreeMetric =
      scope === 'file_rollup' ? 'distinct_dependent_files' : 'distinct_dependent_nodes';

    const queryHash = computeGraphCursorQueryHash({
      endpoint: 'hubs',
      repoId,
      threshold,
      scope,
    });
    const cursorKey =
      input.cursor !== undefined
        ? (() => {
            try {
              return decodeGraphCursor(
                input.cursor,
                { endpoint: 'hubs', repoId, queryHash },
                hubsCursorKeySchema,
              );
            } catch (err) {
              wrapCursorError(err);
            }
          })()
        : null;

    const result = await runBoundedReadTransaction(
      db,
      async (tx): Promise<RepositoryHubsResponse> => {
        const repo = await gatePersistedRepository(tx, repoId, now);

        // Bound qualifying nodes and edges BEFORE hub aggregation
        await assertBoundedRawNodeScan(tx, repo.id, limits.maxScannedNodes, {
          errorCode: 'GRAPH_BUDGET_EXCEEDED',
        });
        await assertBoundedRawEdgeScan(tx, repo.id, limits.maxScannedRawEdges, {
          errorCode: 'GRAPH_BUDGET_EXCEEDED',
        });

        let anchorQualifiedName: string | null = null;
        if (cursorKey !== null) {
          const anchorRows = await tx
            .select({ qualifiedName: nodes.qualifiedName })
            .from(nodes)
            .where(and(eq(nodes.repoId, repo.id), eq(nodes.id, cursorKey.id)))
            .limit(1);
          const anchor = anchorRows[0];
          if (anchor === undefined) {
            throw new GraphQueryError(
              'INVALID_CURSOR',
              'Pagination cursor references a hub node not found in this repository.',
            );
          }
          anchorQualifiedName = anchor.qualifiedName;
        }

        let candidateNodes: NodeMetadataRow[];
        if (scope === 'file' || scope === 'file_rollup') {
          candidateNodes = await tx
            .select(NODE_METADATA_COLUMNS)
            .from(nodes)
            .where(and(eq(nodes.repoId, repo.id), eq(nodes.nodeType, 'file')));
        } else if (scope === 'callable') {
          const callableTypes: readonly NodeType[] = ['function', 'class', 'symbol'];
          candidateNodes = await tx
            .select(NODE_METADATA_COLUMNS)
            .from(nodes)
            .where(and(eq(nodes.repoId, repo.id), inArray(nodes.nodeType, [...callableTypes])));
        } else {
          candidateNodes = await tx
            .select(NODE_METADATA_COLUMNS)
            .from(nodes)
            .where(eq(nodes.repoId, repo.id));
        }

        const candidateIds = candidateNodes.map((n) => n.id);
        const candidateFilePaths = candidateNodes
          .filter((n) => n.nodeType === 'file')
          .map((n) => n.filePath);
        const degreeMap = await loadNodeIncomingDegrees(tx, repo.id, candidateIds, limits);
        const depFileMap = await loadDependentFileCounts(tx, repo.id, candidateFilePaths, limits);

        const allHubs: HubNodeItem[] = [];
        for (const row of candidateNodes) {
          const deg = degreeMap.get(row.id) ?? ZERO_DEGREE_STATS;
          const depFiles = row.nodeType === 'file' ? (depFileMap.get(row.filePath) ?? 0) : null;
          const hubDegree = scope === 'file_rollup' ? (depFiles ?? 0) : deg.inDegreeDistinct;
          if (hubDegree > threshold) {
            allHubs.push({
              id: row.id,
              nodeType: row.nodeType,
              name: row.name,
              qualifiedName: row.qualifiedName,
              filePath: row.filePath,
              parentNodeId: row.parentNodeId,
              isExported: row.isExported,
              startLine: row.startLine,
              endLine: row.endLine,
              hubDegree,
              inDegreeDistinct: deg.inDegreeDistinct,
              rawIncomingEdgeCount: deg.rawIncomingEdgeCount,
              distinctImporterCount: deg.distinctImporterCount,
              distinctCallerCount: deg.distinctCallerCount,
              dependentFileCount: depFiles,
              isHub: deg.inDegreeDistinct > threshold,
              isFileRollupHub: depFiles !== null ? depFiles > threshold : null,
            });
          }
        }

        allHubs.sort((a, b) => {
          if (a.hubDegree !== b.hubDegree) return b.hubDegree - a.hubDegree;
          if (a.rawIncomingEdgeCount !== b.rawIncomingEdgeCount) {
            return b.rawIncomingEdgeCount - a.rawIncomingEdgeCount;
          }
          if (a.qualifiedName !== b.qualifiedName) {
            return a.qualifiedName < b.qualifiedName ? -1 : 1;
          }
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });

        const totalHubs = allHubs.length;
        const filtered =
          cursorKey === null || anchorQualifiedName === null
            ? allHubs
            : allHubs.filter((item) => {
                if (item.hubDegree !== cursorKey.hubDegree) {
                  return item.hubDegree < cursorKey.hubDegree;
                }
                if (item.rawIncomingEdgeCount !== cursorKey.rawIncomingEdgeCount) {
                  return item.rawIncomingEdgeCount < cursorKey.rawIncomingEdgeCount;
                }
                if (item.qualifiedName !== anchorQualifiedName) {
                  return item.qualifiedName > anchorQualifiedName;
                }
                return item.id > cursorKey.id;
              });

        const hasMore = filtered.length > limit;
        const pageItems = hasMore ? filtered.slice(0, limit) : filtered;
        const last = pageItems.at(-1);
        const nextCursor =
          hasMore && last !== undefined
            ? encodeGraphCursor({
                endpoint: 'hubs',
                repoId: repo.id,
                queryHash,
                key: {
                  hubDegree: last.hubDegree,
                  rawIncomingEdgeCount: last.rawIncomingEdgeCount,
                  id: last.id,
                },
              })
            : null;

        return {
          threshold,
          scope,
          degreeMetric,
          totalHubs,
          items: pageItems,
          page: { limit, hasMore, nextCursor },
        };
      },
      timeouts,
    );

    assertResponseByteBudget(result, limits.maxResponseBytes);
    return result;
  }

  return {
    getRepositoryGraph,
    getNodeDetail,
    getNodeEdges,
    getRepositoryHubs,
  };
}
