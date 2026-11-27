import {
  DEFAULT_GRAPH_PAGE_LIMIT,
  DEFAULT_HUB_THRESHOLD,
  MAX_GRAPH_PAGE_LIMIT,
  MAX_HUB_THRESHOLD,
  MIN_HUB_THRESHOLD,
  normalizeCanonicalUuid,
  type EdgeDirection,
  type EdgeTypeFilter,
  type GraphNodeSummary,
  type NodeType,
} from '@archon/shared';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { ArchonDatabase } from './client.js';
import { DbError } from './errors.js';
import {
  applyTransactionTimeouts,
  isLegacyReadyRepository,
  validateTransactionTimeouts,
  type ArchonTransaction,
  type TransactionTimeoutConfig,
} from './repository.js';
import { edges, nodes, repositories, type RepositoryRecord } from './schema.js';

export const DEFAULT_GRAPH_READ_TX_TIMEOUT_CONFIG: TransactionTimeoutConfig = Object.freeze({
  lockTimeoutMs: 1_000,
  statementTimeoutMs: 3_000,
  transactionTimeoutMs: 5_000,
});

export interface GraphQueryLimits {
  readonly maxContainmentDepth: number;
  readonly maxFrontierSize: number;
  readonly maxScannedNodes: number;
  readonly maxScannedRawEdges: number;
  readonly maxReturnedNodes: number;
  readonly maxReturnedEdges: number;
  readonly maxResponseBytes: number;
}

/**
 * Proposed engineering safety ceilings for Phase 6 graph reads (not measured capacity guarantees).
 * Probes enforce qualifying-row ceilings before aggregation/sorting; physical DB I/O is bounded
 * separately by existing composite indexes and PG 17 statement/transaction timeouts.
 */
export const DEFAULT_GRAPH_QUERY_LIMITS: GraphQueryLimits = Object.freeze({
  maxContainmentDepth: 64,
  maxFrontierSize: 1_500,
  maxScannedNodes: 6_000,
  maxScannedRawEdges: 25_000,
  maxReturnedNodes: 1_500,
  maxReturnedEdges: 3_000,
  maxResponseBytes: 2 * 1024 * 1024,
});

export const HARD_MAX_GRAPH_QUERY_LIMITS: GraphQueryLimits = Object.freeze({
  maxContainmentDepth: 128,
  maxFrontierSize: 5_000,
  maxScannedNodes: 20_000,
  maxScannedRawEdges: 100_000,
  maxReturnedNodes: 5_000,
  maxReturnedEdges: 10_000,
  maxResponseBytes: 4 * 1024 * 1024,
});

export type GraphQueryErrorCode =
  | 'INVALID_QUERY'
  | 'INVALID_CURSOR'
  | 'REPO_NOT_FOUND'
  | 'NODE_NOT_FOUND'
  | 'GRAPH_NOT_READY'
  | 'LEGACY_GRAPH_UNAVAILABLE'
  | 'REPO_INGESTION_FAILED'
  | 'REPO_SUPERSEDED'
  | 'REPO_EXPIRED'
  | 'INVALID_SCOPE_NODE'
  | 'GRAPH_SCOPE_REQUIRED'
  | 'GRAPH_BUDGET_EXCEEDED'
  | 'GRAPH_RESPONSE_TOO_LARGE'
  | 'GRAPH_CONTAINMENT_INVALID';

/**
 * Sanitized domain error thrown by `GraphQueryRepository`. Never carries raw SQL or parameters.
 */
export class GraphQueryError extends Error {
  readonly code: GraphQueryErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: GraphQueryErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'GraphQueryError';
    this.code = code;
    this.details = details;
  }
}

export interface NodeMetadataRow {
  readonly id: string;
  readonly nodeType: NodeType;
  readonly name: string;
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly parentNodeId: string | null;
  readonly isExported: boolean;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

export interface NodeIncomingDegreeStats {
  readonly inDegreeDistinct: number;
  readonly rawIncomingEdgeCount: number;
  readonly distinctImporterCount: number;
  readonly distinctCallerCount: number;
}

export const ZERO_DEGREE_STATS: NodeIncomingDegreeStats = Object.freeze({
  inDegreeDistinct: 0,
  rawIncomingEdgeCount: 0,
  distinctImporterCount: 0,
  distinctCallerCount: 0,
});

function assertBoundedLimit(name: keyof GraphQueryLimits, value: number): void {
  const ceiling = HARD_MAX_GRAPH_QUERY_LIMITS[name];
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new DbError(
      'DB_VALIDATION_ERROR',
      `GraphQueryLimits.${name} must be an integer between 1 and ${String(ceiling)}.`,
    );
  }
}

export function validateGraphQueryLimits(
  overrides: Partial<GraphQueryLimits> = {},
): GraphQueryLimits {
  const resolved: GraphQueryLimits = {
    maxContainmentDepth:
      overrides.maxContainmentDepth ?? DEFAULT_GRAPH_QUERY_LIMITS.maxContainmentDepth,
    maxFrontierSize: overrides.maxFrontierSize ?? DEFAULT_GRAPH_QUERY_LIMITS.maxFrontierSize,
    maxScannedNodes: overrides.maxScannedNodes ?? DEFAULT_GRAPH_QUERY_LIMITS.maxScannedNodes,
    maxScannedRawEdges:
      overrides.maxScannedRawEdges ?? DEFAULT_GRAPH_QUERY_LIMITS.maxScannedRawEdges,
    maxReturnedNodes: overrides.maxReturnedNodes ?? DEFAULT_GRAPH_QUERY_LIMITS.maxReturnedNodes,
    maxReturnedEdges: overrides.maxReturnedEdges ?? DEFAULT_GRAPH_QUERY_LIMITS.maxReturnedEdges,
    maxResponseBytes: overrides.maxResponseBytes ?? DEFAULT_GRAPH_QUERY_LIMITS.maxResponseBytes,
  };
  assertBoundedLimit('maxContainmentDepth', resolved.maxContainmentDepth);
  assertBoundedLimit('maxFrontierSize', resolved.maxFrontierSize);
  assertBoundedLimit('maxScannedNodes', resolved.maxScannedNodes);
  assertBoundedLimit('maxScannedRawEdges', resolved.maxScannedRawEdges);
  assertBoundedLimit('maxReturnedNodes', resolved.maxReturnedNodes);
  assertBoundedLimit('maxReturnedEdges', resolved.maxReturnedEdges);
  assertBoundedLimit('maxResponseBytes', resolved.maxResponseBytes);

  if (resolved.maxReturnedNodes > resolved.maxScannedNodes) {
    throw new DbError(
      'DB_VALIDATION_ERROR',
      'GraphQueryLimits.maxReturnedNodes must not exceed maxScannedNodes.',
    );
  }
  if (resolved.maxReturnedEdges > resolved.maxScannedRawEdges) {
    throw new DbError(
      'DB_VALIDATION_ERROR',
      'GraphQueryLimits.maxReturnedEdges must not exceed maxScannedRawEdges.',
    );
  }
  return resolved;
}

export function resolveHubThreshold(raw: number | undefined): number {
  const val = raw ?? DEFAULT_HUB_THRESHOLD;
  if (!Number.isSafeInteger(val) || val < MIN_HUB_THRESHOLD || val > MAX_HUB_THRESHOLD) {
    throw new GraphQueryError(
      'INVALID_QUERY',
      `threshold must be an integer between ${String(MIN_HUB_THRESHOLD)} and ${String(MAX_HUB_THRESHOLD)}.`,
    );
  }
  return val;
}

export function resolvePageLimit(raw: number | undefined): number {
  const val = raw ?? DEFAULT_GRAPH_PAGE_LIMIT;
  if (!Number.isSafeInteger(val) || val < 1 || val > MAX_GRAPH_PAGE_LIMIT) {
    throw new GraphQueryError(
      'INVALID_QUERY',
      `limit must be an integer between 1 and ${String(MAX_GRAPH_PAGE_LIMIT)}.`,
    );
  }
  return val;
}

export function requireNormalizedUuid(name: string, value: string): string {
  const normalized = normalizeCanonicalUuid(value);
  if (normalized === null) {
    throw new GraphQueryError('INVALID_QUERY', `${name} must be a valid UUID.`);
  }
  return normalized;
}

export function assertResponseByteBudget(payload: unknown, maxResponseBytes: number): void {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > maxResponseBytes) {
    throw new GraphQueryError(
      'GRAPH_RESPONSE_TOO_LARGE',
      'Graph query response exceeds maximum allowed byte budget; narrow the requested scope.',
      { maxResponseBytes },
    );
  }
}

/**
 * Executes a snapshot-consistent PostgreSQL 17 `REPEATABLE READ READ ONLY` transaction
 * with bounded `lock_timeout`, `statement_timeout`, and `transaction_timeout`.
 */
export async function runBoundedReadTransaction<T>(
  db: ArchonDatabase,
  callback: (tx: ArchonTransaction) => Promise<T>,
  timeouts: TransactionTimeoutConfig = DEFAULT_GRAPH_READ_TX_TIMEOUT_CONFIG,
): Promise<T> {
  validateTransactionTimeouts(timeouts);
  return db.transaction(
    async (tx) => {
      await applyTransactionTimeouts(tx, timeouts);
      return callback(tx);
    },
    {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    },
  );
}

/**
 * Gates every graph read on persisted-ready, non-expired repository state within the
 * active `REPEATABLE READ READ ONLY` snapshot (no row locks, no TTL writes).
 */
export async function gatePersistedRepository(
  tx: ArchonTransaction,
  normalizedRepoId: string,
  now: Date,
): Promise<RepositoryRecord> {
  const rows = await tx
    .select()
    .from(repositories)
    .where(eq(repositories.id, normalizedRepoId))
    .limit(1);
  const repo = rows[0];
  if (repo === undefined) {
    throw new GraphQueryError('REPO_NOT_FOUND', 'Repository not found.');
  }

  switch (repo.status) {
    case 'queued':
    case 'cloning':
    case 'parsing':
    case 'building_graph':
      throw new GraphQueryError('GRAPH_NOT_READY', 'Repository graph is still being built.', {
        status: repo.status,
      });
    case 'failed':
      throw new GraphQueryError('REPO_INGESTION_FAILED', 'Repository ingestion failed.', {
        errorCode: repo.errorCode ?? 'INGESTION_FAILED',
      });
    case 'superseded':
      throw new GraphQueryError(
        'REPO_SUPERSEDED',
        'Repository snapshot has been superseded by a newer ingestion.',
      );
    case 'ready':
      break;
  }

  if (isLegacyReadyRepository(repo)) {
    throw new GraphQueryError(
      'LEGACY_GRAPH_UNAVAILABLE',
      'Repository graph was not persisted and requires re-ingestion.',
    );
  }

  if (!repo.isSample && repo.expiresAt !== null && repo.expiresAt.getTime() <= now.getTime()) {
    throw new GraphQueryError(
      'REPO_EXPIRED',
      'Repository snapshot has expired and must be re-ingested.',
    );
  }

  return repo;
}

function readIntColumn(row: Record<string, unknown> | undefined, colName: string): number {
  const raw = row?.[colName];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  return 0;
}

/**
 * Qualifying-row probe bounding repository nodes before unscoped scans or aggregations.
 */
export async function assertBoundedRawNodeScan(
  tx: ArchonTransaction,
  repoId: string,
  maxScannedNodes: number,
  options: {
    readonly errorCode: 'GRAPH_SCOPE_REQUIRED' | 'GRAPH_BUDGET_EXCEEDED';
    readonly suggestedLevel?: string;
  },
): Promise<void> {
  const probe = await tx.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM (SELECT 1 FROM ${nodes} WHERE ${nodes.repoId} = ${repoId} LIMIT ${maxScannedNodes + 1}) AS bounded_nodes`,
  );
  if (readIntColumn(probe.rows[0], 'cnt') > maxScannedNodes) {
    throw new GraphQueryError(
      options.errorCode,
      'Repository node count exceeds qualifying-row scan budget; narrow the requested scope.',
      {
        maxScannedNodes,
        ...(options.suggestedLevel !== undefined ? { suggestedLevel: options.suggestedLevel } : {}),
      },
    );
  }
}

/**
 * Qualifying-row probe bounding direct children of a single parent node before `COUNT(*)`.
 */
export async function countDirectChildrenBounded(
  tx: ArchonTransaction,
  repoId: string,
  parentNodeId: string,
  maxScannedNodes: number,
): Promise<number> {
  const probe = await tx.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM (SELECT 1 FROM ${nodes} WHERE ${nodes.repoId} = ${repoId} AND ${nodes.parentNodeId} = ${parentNodeId} LIMIT ${maxScannedNodes + 1}) AS bounded_children`,
  );
  const cnt = readIntColumn(probe.rows[0], 'cnt');
  if (cnt > maxScannedNodes) {
    throw new GraphQueryError(
      'GRAPH_BUDGET_EXCEEDED',
      'Direct child count exceeds maximum qualifying-row scan budget.',
      { maxScannedNodes },
    );
  }
  return cnt;
}

/**
 * Qualifying-row probe bounding internal edges BEFORE `GROUP BY` projection/aggregation.
 */
export async function assertBoundedRawEdgeScan(
  tx: ArchonTransaction,
  repoId: string,
  maxScannedRawEdges: number,
  options: {
    readonly errorCode: 'GRAPH_SCOPE_REQUIRED' | 'GRAPH_BUDGET_EXCEEDED';
    readonly scopedNodeIds?: readonly string[];
    readonly includeImports?: boolean;
    readonly suggestedLevel?: string;
  },
): Promise<void> {
  const limitPlusOne = maxScannedRawEdges + 1;
  const scopedIds = options.scopedNodeIds;
  const includeImports = options.includeImports ?? true;

  if (scopedIds?.length === 0) {
    return;
  }

  const baseCond =
    scopedIds !== undefined
      ? and(
          eq(edges.repoId, repoId),
          inArray(edges.sourceNodeId, [...scopedIds]),
          inArray(edges.targetNodeId, [...scopedIds]),
        )
      : eq(edges.repoId, repoId);
  const fullCond = includeImports ? baseCond : and(baseCond, eq(edges.edgeType, 'CALLS'));

  const sub = tx
    .select({ one: sql<number>`1` })
    .from(edges)
    .where(fullCond)
    .limit(limitPlusOne)
    .as('bounded_edges');
  const rows = await tx.select({ cnt: sql<number>`COUNT(*)::int` }).from(sub);
  if ((rows[0]?.cnt ?? 0) > maxScannedRawEdges) {
    throw new GraphQueryError(
      options.errorCode,
      'Qualifying edge count exceeds raw-edge budget before aggregation; narrow the requested scope.',
      {
        maxScannedRawEdges,
        ...(options.suggestedLevel !== undefined ? { suggestedLevel: options.suggestedLevel } : {}),
      },
    );
  }
}

/**
 * Qualifying-row probe bounding incoming edges for target nodes before degree or rollup `GROUP BY`.
 */
export async function assertBoundedIncomingEdgesForTargets(
  tx: ArchonTransaction,
  repoId: string,
  targetNodeIds: readonly string[],
  maxScannedRawEdges: number,
  errorCode: 'GRAPH_SCOPE_REQUIRED' | 'GRAPH_BUDGET_EXCEEDED' = 'GRAPH_BUDGET_EXCEEDED',
): Promise<void> {
  if (targetNodeIds.length === 0) return;
  const sub = tx
    .select({ one: sql<number>`1` })
    .from(edges)
    .where(
      and(
        eq(edges.repoId, repoId),
        inArray(edges.targetNodeId, [...targetNodeIds]),
        ne(edges.sourceNodeId, edges.targetNodeId),
      ),
    )
    .limit(maxScannedRawEdges + 1)
    .as('bounded_in_edges');
  const rows = await tx.select({ cnt: sql<number>`COUNT(*)::int` }).from(sub);
  if ((rows[0]?.cnt ?? 0) > maxScannedRawEdges) {
    throw new GraphQueryError(
      errorCode,
      'Incoming edge count exceeds qualifying-row budget before degree aggregation.',
      { maxScannedRawEdges },
    );
  }
}

/**
 * Qualifying-row probe bounding outgoing edges for a single node before `GROUP BY` / `COUNT(DISTINCT)`.
 */
export async function assertBoundedOutgoingEdgesForNode(
  tx: ArchonTransaction,
  repoId: string,
  sourceNodeId: string,
  maxScannedRawEdges: number,
): Promise<void> {
  const sub = tx
    .select({ one: sql<number>`1` })
    .from(edges)
    .where(
      and(
        eq(edges.repoId, repoId),
        eq(edges.sourceNodeId, sourceNodeId),
        ne(edges.sourceNodeId, edges.targetNodeId),
      ),
    )
    .limit(maxScannedRawEdges + 1)
    .as('bounded_out_edges');
  const rows = await tx.select({ cnt: sql<number>`COUNT(*)::int` }).from(sub);
  if ((rows[0]?.cnt ?? 0) > maxScannedRawEdges) {
    throw new GraphQueryError(
      'GRAPH_BUDGET_EXCEEDED',
      'Outgoing edge count exceeds qualifying-row budget before degree aggregation.',
      { maxScannedRawEdges },
    );
  }
}

/**
 * Qualifying-row probe bounding incident edges for `getNodeEdges` before join + sort.
 */
export async function assertBoundedIncidentEdgesForNode(
  tx: ArchonTransaction,
  repoId: string,
  nodeId: string,
  direction: EdgeDirection,
  edgeType: EdgeTypeFilter,
  peerNodeId: string | undefined,
  maxScannedRawEdges: number,
): Promise<void> {
  const anchorCol = direction === 'incoming' ? edges.targetNodeId : edges.sourceNodeId;
  const peerCol = direction === 'incoming' ? edges.sourceNodeId : edges.targetNodeId;
  const conds = [eq(edges.repoId, repoId), eq(anchorCol, nodeId)];
  if (edgeType !== 'all') {
    conds.push(eq(edges.edgeType, edgeType));
  }
  if (peerNodeId !== undefined) {
    conds.push(eq(peerCol, peerNodeId));
  }
  const sub = tx
    .select({ one: sql<number>`1` })
    .from(edges)
    .where(and(...conds))
    .limit(maxScannedRawEdges + 1)
    .as('bounded_incident_edges');
  const rows = await tx.select({ cnt: sql<number>`COUNT(*)::int` }).from(sub);
  if ((rows[0]?.cnt ?? 0) > maxScannedRawEdges) {
    throw new GraphQueryError(
      'GRAPH_BUDGET_EXCEEDED',
      'Incident edge count exceeds qualifying-row budget before sorting; filter by edgeType or peerNodeId.',
      { maxScannedRawEdges },
    );
  }
}

export const NODE_METADATA_COLUMNS = {
  id: nodes.id,
  nodeType: nodes.nodeType,
  name: nodes.name,
  qualifiedName: nodes.qualifiedName,
  filePath: nodes.filePath,
  parentNodeId: nodes.parentNodeId,
  isExported: nodes.isExported,
  startLine: nodes.startLine,
  endLine: nodes.endLine,
} as const;

export interface ExpandedSubtree {
  readonly nodes: readonly NodeMetadataRow[];
  readonly containerByNodeId: ReadonlyMap<string, string>;
}

/**
 * Iteratively expands ALL containment descendants (folders, files, classes, methods, functions,
 * nested symbols) starting from `seedNodes` using `idx_nodes_repo_parent`. Enforces depth,
 * frontier, and scanned-node caps and fails loudly with `GRAPH_CONTAINMENT_INVALID` on cycles.
 */
export async function expandContainmentSubtreeBounded(
  tx: ArchonTransaction,
  repoId: string,
  seedNodes: readonly NodeMetadataRow[],
  limits: GraphQueryLimits,
  budgetErrorCode: 'GRAPH_SCOPE_REQUIRED' | 'GRAPH_BUDGET_EXCEEDED' = 'GRAPH_BUDGET_EXCEEDED',
): Promise<ExpandedSubtree> {
  const allNodes: NodeMetadataRow[] = [];
  const visited = new Set<string>();
  const containerByNodeId = new Map<string, string>();
  let frontier: string[] = [];

  for (const seed of seedNodes) {
    if (visited.has(seed.id)) continue;
    visited.add(seed.id);
    allNodes.push(seed);
    containerByNodeId.set(seed.id, seed.id);
    frontier.push(seed.id);
  }

  if (allNodes.length > limits.maxScannedNodes) {
    throw new GraphQueryError(budgetErrorCode, 'Containment seed exceeds scanned node budget.', {
      maxScannedNodes: limits.maxScannedNodes,
    });
  }

  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (frontier.length > limits.maxFrontierSize) {
      throw new GraphQueryError(
        budgetErrorCode,
        'Containment frontier size exceeds maximum allowed budget.',
        { maxFrontierSize: limits.maxFrontierSize },
      );
    }

    const remaining = limits.maxScannedNodes - allNodes.length;
    const children = await tx
      .select(NODE_METADATA_COLUMNS)
      .from(nodes)
      .where(and(eq(nodes.repoId, repoId), inArray(nodes.parentNodeId, frontier)))
      .limit(remaining + 1);

    if (children.length === 0) {
      break;
    }

    if (depth >= limits.maxContainmentDepth) {
      throw new GraphQueryError(
        'GRAPH_BUDGET_EXCEEDED',
        'Repository containment depth exceeds maximum allowed traversal depth.',
        { maxContainmentDepth: limits.maxContainmentDepth },
      );
    }

    if (children.length > remaining) {
      throw new GraphQueryError(
        budgetErrorCode,
        'Containment subtree exceeds maximum scanned node budget.',
        { maxScannedNodes: limits.maxScannedNodes },
      );
    }

    const nextFrontier: string[] = [];
    for (const child of children) {
      if (visited.has(child.id)) {
        throw new GraphQueryError(
          'GRAPH_CONTAINMENT_INVALID',
          'Cyclic containment relationship detected in persisted repository graph.',
        );
      }
      visited.add(child.id);
      allNodes.push(child);
      const containerId =
        child.parentNodeId !== null
          ? (containerByNodeId.get(child.parentNodeId) ?? child.id)
          : child.id;
      containerByNodeId.set(child.id, containerId);
      nextFrontier.push(child.id);
    }
    frontier = nextFrontier;
  }

  return { nodes: allNodes, containerByNodeId };
}

/**
 * Computes consistent node-level incoming degree metrics (excluding self-edges) for `targetNodeIds`
 * AFTER enforcing the `maxScannedRawEdges` qualifying-row probe.
 */
export async function loadNodeIncomingDegrees(
  tx: ArchonTransaction,
  repoId: string,
  targetNodeIds: readonly string[],
  limits: GraphQueryLimits,
  budgetErrorCode: 'GRAPH_SCOPE_REQUIRED' | 'GRAPH_BUDGET_EXCEEDED' = 'GRAPH_BUDGET_EXCEEDED',
): Promise<ReadonlyMap<string, NodeIncomingDegreeStats>> {
  const result = new Map<string, NodeIncomingDegreeStats>();
  if (targetNodeIds.length === 0) {
    return result;
  }

  await assertBoundedIncomingEdgesForTargets(
    tx,
    repoId,
    targetNodeIds,
    limits.maxScannedRawEdges,
    budgetErrorCode,
  );

  const rows = await tx
    .select({
      targetNodeId: edges.targetNodeId,
      inDegreeDistinct: sql<number>`COUNT(DISTINCT ${edges.sourceNodeId})::int`,
      rawIncomingEdgeCount: sql<number>`COUNT(*)::int`,
      distinctImporterCount: sql<number>`COUNT(DISTINCT ${edges.sourceNodeId}) FILTER (WHERE ${edges.edgeType} = 'IMPORTS')::int`,
      distinctCallerCount: sql<number>`COUNT(DISTINCT ${edges.sourceNodeId}) FILTER (WHERE ${edges.edgeType} = 'CALLS')::int`,
    })
    .from(edges)
    .where(
      and(
        eq(edges.repoId, repoId),
        inArray(edges.targetNodeId, [...targetNodeIds]),
        ne(edges.sourceNodeId, edges.targetNodeId),
      ),
    )
    .groupBy(edges.targetNodeId);

  for (const row of rows) {
    result.set(row.targetNodeId, {
      inDegreeDistinct: row.inDegreeDistinct,
      rawIncomingEdgeCount: row.rawIncomingEdgeCount,
      distinctImporterCount: row.distinctImporterCount,
      distinctCallerCount: row.distinctCallerCount,
    });
  }
  return result;
}

/**
 * Computes distinct external dependent files (`dependentFileCount`) for `targetFilePaths`:
 * distinct external files `F' !== F` importing `F` OR calling an exported declaration in `F`.
 * Enforces both node and incoming-edge qualifying-row bounds before running `GROUP BY`.
 */
export async function loadDependentFileCounts(
  tx: ArchonTransaction,
  repoId: string,
  targetFilePaths: readonly string[],
  limits: GraphQueryLimits,
  budgetErrorCode: 'GRAPH_SCOPE_REQUIRED' | 'GRAPH_BUDGET_EXCEEDED' = 'GRAPH_BUDGET_EXCEEDED',
): Promise<ReadonlyMap<string, number>> {
  const result = new Map<string, number>();
  if (targetFilePaths.length === 0) {
    return result;
  }

  const uniquePaths = [...new Set(targetFilePaths)];
  const callableTypes: readonly NodeType[] = ['function', 'class', 'symbol'];
  const rollupTargetNodes = await tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.repoId, repoId),
        inArray(nodes.filePath, uniquePaths),
        or(
          eq(nodes.nodeType, 'file'),
          and(inArray(nodes.nodeType, [...callableTypes]), eq(nodes.isExported, true)),
        ),
      ),
    )
    .limit(limits.maxScannedNodes + 1);

  if (rollupTargetNodes.length > limits.maxScannedNodes) {
    throw new GraphQueryError(
      budgetErrorCode,
      'Exported target node count exceeds qualifying-row budget before file-rollup aggregation.',
      { maxScannedNodes: limits.maxScannedNodes },
    );
  }
  if (rollupTargetNodes.length === 0) {
    return result;
  }

  const rollupTargetIds = rollupTargetNodes.map((n) => n.id);
  await assertBoundedIncomingEdgesForTargets(
    tx,
    repoId,
    rollupTargetIds,
    limits.maxScannedRawEdges,
    budgetErrorCode,
  );

  const idListSql = sql.join(
    rollupTargetIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const execRes = await tx.execute(sql`
    SELECT tgt.file_path AS target_file_path, COUNT(DISTINCT src.file_path)::int AS dep_count
    FROM edges e
    INNER JOIN nodes src ON src.repo_id = e.repo_id AND src.id = e.source_node_id
    INNER JOIN nodes tgt ON tgt.repo_id = e.repo_id AND tgt.id = e.target_node_id
    WHERE e.repo_id = ${repoId}
      AND e.target_node_id IN (${idListSql})
      AND e.source_node_id <> e.target_node_id
      AND src.file_path <> tgt.file_path
      AND (
        (e.edge_type = 'IMPORTS' AND tgt.node_type = 'file')
        OR (
          e.edge_type = 'CALLS'
          AND tgt.node_type IN ('function', 'class', 'symbol')
          AND tgt.is_exported = true
        )
      )
    GROUP BY tgt.file_path
  `);

  for (const rawRow of execRes.rows) {
    const filePathVal = rawRow.target_file_path;
    if (typeof filePathVal === 'string') {
      result.set(filePathVal, readIntColumn(rawRow, 'dep_count'));
    }
  }
  return result;
}

export function buildGraphNodeSummary(
  row: NodeMetadataRow,
  degreeMap: ReadonlyMap<string, NodeIncomingDegreeStats>,
  depFileCountMap: ReadonlyMap<string, number>,
  hubThreshold: number,
): GraphNodeSummary {
  const deg = degreeMap.get(row.id) ?? ZERO_DEGREE_STATS;
  const dependentFileCount =
    row.nodeType === 'file' ? (depFileCountMap.get(row.filePath) ?? 0) : null;
  return {
    id: row.id,
    nodeType: row.nodeType,
    name: row.name,
    qualifiedName: row.qualifiedName,
    filePath: row.filePath,
    parentNodeId: row.parentNodeId,
    isExported: row.isExported,
    startLine: row.startLine,
    endLine: row.endLine,
    inDegreeDistinct: deg.inDegreeDistinct,
    rawIncomingEdgeCount: deg.rawIncomingEdgeCount,
    distinctImporterCount: deg.distinctImporterCount,
    distinctCallerCount: deg.distinctCallerCount,
    dependentFileCount,
    isHub: deg.inDegreeDistinct > hubThreshold,
    isFileRollupHub: dependentFileCount !== null ? dependentFileCount > hubThreshold : null,
  };
}
