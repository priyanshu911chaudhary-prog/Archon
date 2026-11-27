import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EDGE_TYPES, NODE_TYPES, type EdgeType, type NodeType } from './analysis-contracts.js';

export const DEFAULT_HUB_THRESHOLD = 30 as const;
export const MIN_HUB_THRESHOLD = 1 as const;
export const MAX_HUB_THRESHOLD = 10_000 as const;

export const DEFAULT_GRAPH_PAGE_LIMIT = 50 as const;
export const MAX_GRAPH_PAGE_LIMIT = 100 as const;

export const GRAPH_CURSOR_VERSION = 1 as const;
/**
 * Continuation keys store only compact UUIDs and numeric sort scalars (never raw 2048-byte
 * qualified names), so every valid persisted identity stays well within 512 ASCII chars.
 */
export const MAX_GRAPH_CURSOR_CHARS = 512 as const;
export const MAX_GRAPH_FILE_PATH_CHARS = 1024 as const;

export const GRAPH_ZOOM_LEVELS = ['folder', 'file', 'function'] as const;
export type GraphZoomLevel = (typeof GRAPH_ZOOM_LEVELS)[number];

export const HUB_SCOPES = ['all', 'file', 'callable', 'file_rollup'] as const;
export type HubScope = (typeof HUB_SCOPES)[number];

export const HUB_DEGREE_METRICS = ['distinct_dependent_nodes', 'distinct_dependent_files'] as const;
export type HubDegreeMetric = (typeof HUB_DEGREE_METRICS)[number];

export const EDGE_DIRECTIONS = ['incoming', 'outgoing'] as const;
export type EdgeDirection = (typeof EDGE_DIRECTIONS)[number];

export const EDGE_TYPE_FILTERS = ['all', 'IMPORTS', 'CALLS'] as const;
export type EdgeTypeFilter = (typeof EDGE_TYPE_FILTERS)[number];

export const GRAPH_CURSOR_ENDPOINTS = ['node_children', 'node_edges', 'hubs'] as const;
export type GraphCursorEndpoint = (typeof GRAPH_CURSOR_ENDPOINTS)[number];

export const NODE_TYPE_SORT_RANK: Readonly<Record<NodeType, number>> = Object.freeze({
  folder: 0,
  file: 1,
  class: 2,
  function: 3,
  symbol: 4,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const uuidSchema = z.string().regex(UUID_RE, 'Expected valid UUID.');
const lowerUuidSchema = z.string().regex(LOWER_UUID_RE, 'Expected canonical lowercase UUID.');
const nonNegIntSchema = z
  .number()
  .int()
  .min(0)
  .refine(Number.isSafeInteger, 'Must be a safe integer.');
const posIntSchema = z
  .number()
  .int()
  .min(1)
  .refine(Number.isSafeInteger, 'Must be a safe integer.');

export const graphZoomLevelSchema = z.enum(GRAPH_ZOOM_LEVELS);
export const hubScopeSchema = z.enum(HUB_SCOPES);
export const edgeDirectionSchema = z.enum(EDGE_DIRECTIONS);
export const edgeTypeFilterSchema = z.enum(EDGE_TYPE_FILTERS);

export const graphNodeSummarySchema = z
  .object({
    id: uuidSchema,
    nodeType: z.enum(NODE_TYPES),
    name: z.string().min(1),
    qualifiedName: z.string().min(1),
    filePath: z.string().min(1),
    parentNodeId: uuidSchema.nullable(),
    isExported: z.boolean(),
    startLine: posIntSchema.nullable(),
    endLine: posIntSchema.nullable(),
    inDegreeDistinct: nonNegIntSchema,
    rawIncomingEdgeCount: nonNegIntSchema,
    distinctImporterCount: nonNegIntSchema,
    distinctCallerCount: nonNegIntSchema,
    dependentFileCount: nonNegIntSchema.nullable(),
    /** Node-level hub status: strictly `inDegreeDistinct > hubThreshold`. */
    isHub: z.boolean(),
    /** File-rollup hub status for `file` nodes: strictly `dependentFileCount > hubThreshold`; `null` for non-files. */
    isFileRollupHub: z.boolean().nullable(),
  })
  .strict();

export const graphAggregatedEdgeSchema = z
  .object({
    sourceNodeId: uuidSchema,
    targetNodeId: uuidSchema,
    edgeTypes: z.array(z.enum(EDGE_TYPES)).min(1),
    importEdgeCount: nonNegIntSchema,
    callEdgeCount: nonNegIntSchema,
    distinctCallPairs: nonNegIntSchema,
    minCallSiteLine: posIntSchema.nullable(),
    isSelfEdge: z.boolean(),
  })
  .strict();

export const graphPageMetadataSchema = z
  .object({
    limit: z.number().int().min(1).max(MAX_GRAPH_PAGE_LIMIT),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(MAX_GRAPH_CURSOR_CHARS).nullable(),
  })
  .strict();

export const repositoryGraphViewResponseSchema = z
  .object({
    repository: z
      .object({
        repoId: uuidSchema,
        owner: z.string().min(1),
        name: z.string().min(1),
        commitSha: z.string().min(1),
        defaultBranch: z.string().min(1),
        status: z.literal('ready'),
        fileCount: nonNegIntSchema,
        skippedFilesCount: nonNegIntSchema,
        emptyJsTs: z.boolean(),
        graphPersistedAt: z.string().min(1),
      })
      .strict(),
    view: z
      .object({
        level: graphZoomLevelSchema,
        scopeNodeId: uuidSchema.nullable(),
        scopeFilePath: z.string().min(1).nullable(),
        includeImports: z.boolean(),
        hubThreshold: z.number().int().min(MIN_HUB_THRESHOLD).max(MAX_HUB_THRESHOLD),
        complete: z.literal(true),
      })
      .strict(),
    counts: z
      .object({
        returnedNodes: nonNegIntSchema,
        returnedEdges: nonNegIntSchema,
      })
      .strict(),
    nodes: z.array(graphNodeSummarySchema),
    edges: z.array(graphAggregatedEdgeSchema),
  })
  .strict();

export const nodeAncestorSchema = z
  .object({
    id: uuidSchema,
    nodeType: z.enum(NODE_TYPES),
    name: z.string().min(1),
    qualifiedName: z.string().min(1),
    filePath: z.string().min(1),
  })
  .strict();

export const nodeDetailResponseSchema = z
  .object({
    node: z
      .object({
        id: uuidSchema,
        repoId: uuidSchema,
        nodeType: z.enum(NODE_TYPES),
        name: z.string().min(1),
        qualifiedName: z.string().min(1),
        filePath: z.string().min(1),
        parentNodeId: uuidSchema.nullable(),
        isExported: z.boolean(),
        startLine: posIntSchema.nullable(),
        endLine: posIntSchema.nullable(),
        contentHash: z.string().regex(SHA256_HEX_RE).nullable(),
        snippet: z.string().nullable(),
      })
      .strict(),
    ancestors: z.array(nodeAncestorSchema),
    degree: z
      .object({
        inDegreeDistinct: nonNegIntSchema,
        rawIncomingEdgeCount: nonNegIntSchema,
        outDegreeDistinct: nonNegIntSchema,
        rawOutgoingEdgeCount: nonNegIntSchema,
        distinctImporterCount: nonNegIntSchema,
        distinctCallerCount: nonNegIntSchema,
        dependentFileCount: nonNegIntSchema.nullable(),
        hubThreshold: z.number().int().min(MIN_HUB_THRESHOLD).max(MAX_HUB_THRESHOLD),
        isHub: z.boolean(),
        isFileRollupHub: z.boolean().nullable(),
      })
      .strict(),
    children: z
      .object({
        items: z.array(graphNodeSummarySchema),
        totalCount: nonNegIntSchema,
        page: graphPageMetadataSchema,
      })
      .strict(),
  })
  .strict();

export const nodeEdgeEvidenceItemSchema = z
  .object({
    edgeId: uuidSchema,
    edgeType: z.enum(EDGE_TYPES),
    direction: edgeDirectionSchema,
    sourceNodeId: uuidSchema,
    targetNodeId: uuidSchema,
    peerNode: z
      .object({
        id: uuidSchema,
        nodeType: z.enum(NODE_TYPES),
        name: z.string().min(1),
        qualifiedName: z.string().min(1),
        filePath: z.string().min(1),
        isExported: z.boolean(),
        startLine: posIntSchema.nullable(),
        endLine: posIntSchema.nullable(),
      })
      .strict(),
    callSiteLine: posIntSchema.nullable(),
    callSiteSnippet: z.string().nullable(),
  })
  .strict();

export const nodeEdgesResponseSchema = z
  .object({
    nodeId: uuidSchema,
    direction: edgeDirectionSchema,
    edgeType: edgeTypeFilterSchema,
    peerNodeId: uuidSchema.nullable(),
    items: z.array(nodeEdgeEvidenceItemSchema),
    page: graphPageMetadataSchema,
  })
  .strict();

export const hubNodeItemSchema = z
  .object({
    id: uuidSchema,
    nodeType: z.enum(NODE_TYPES),
    name: z.string().min(1),
    qualifiedName: z.string().min(1),
    filePath: z.string().min(1),
    parentNodeId: uuidSchema.nullable(),
    isExported: z.boolean(),
    startLine: posIntSchema.nullable(),
    endLine: posIntSchema.nullable(),
    hubDegree: posIntSchema,
    inDegreeDistinct: nonNegIntSchema,
    rawIncomingEdgeCount: nonNegIntSchema,
    distinctImporterCount: nonNegIntSchema,
    distinctCallerCount: nonNegIntSchema,
    dependentFileCount: nonNegIntSchema.nullable(),
    /** Consistent node-level hub status (`inDegreeDistinct > threshold`). */
    isHub: z.boolean(),
    /** Consistent file-rollup hub status (`dependentFileCount > threshold` for files; `null` for non-files). */
    isFileRollupHub: z.boolean().nullable(),
  })
  .strict();

export const repositoryHubsResponseSchema = z
  .object({
    threshold: z.number().int().min(MIN_HUB_THRESHOLD).max(MAX_HUB_THRESHOLD),
    scope: hubScopeSchema,
    degreeMetric: z.enum(HUB_DEGREE_METRICS),
    totalHubs: nonNegIntSchema,
    items: z.array(hubNodeItemSchema),
    page: graphPageMetadataSchema,
  })
  .strict();

export type GraphNodeSummary = z.infer<typeof graphNodeSummarySchema>;
export type GraphAggregatedEdge = z.infer<typeof graphAggregatedEdgeSchema>;
export type GraphPageMetadata = z.infer<typeof graphPageMetadataSchema>;
export type RepositoryGraphViewResponse = z.infer<typeof repositoryGraphViewResponseSchema>;
export type NodeAncestor = z.infer<typeof nodeAncestorSchema>;
export type NodeDetailResponse = z.infer<typeof nodeDetailResponseSchema>;
export type NodeEdgeEvidenceItem = z.infer<typeof nodeEdgeEvidenceItemSchema>;
export type NodeEdgesResponse = z.infer<typeof nodeEdgesResponseSchema>;
export type HubNodeItem = z.infer<typeof hubNodeItemSchema>;
export type RepositoryHubsResponse = z.infer<typeof repositoryHubsResponseSchema>;

export const nodeChildrenCursorKeySchema = z
  .object({
    id: lowerUuidSchema,
  })
  .strict();

export const nodeEdgesCursorKeySchema = z
  .object({
    edgeId: lowerUuidSchema,
  })
  .strict();

export const hubsCursorKeySchema = z
  .object({
    hubDegree: posIntSchema,
    rawIncomingEdgeCount: nonNegIntSchema,
    id: lowerUuidSchema,
  })
  .strict();

export type NodeChildrenCursorKey = z.infer<typeof nodeChildrenCursorKeySchema>;
export type NodeEdgesCursorKey = z.infer<typeof nodeEdgesCursorKeySchema>;
export type HubsCursorKey = z.infer<typeof hubsCursorKeySchema>;
export type GraphCursorKey = NodeChildrenCursorKey | NodeEdgesCursorKey | HubsCursorKey;

export class GraphCursorValidationError extends Error {
  readonly code = 'INVALID_CURSOR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'GraphCursorValidationError';
  }
}

export function normalizeCanonicalUuid(raw: string): string | null {
  return UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

/**
 * Computes an unsigned SHA-256 query-parameter consistency binding so a pagination cursor
 * cannot be accidentally replayed against a different repository, endpoint, or filter set.
 * Note: This is a consistency binding, NOT cryptographic tamper authentication.
 */
export function computeGraphCursorQueryHash(
  binding: Readonly<Record<string, string | number | boolean | null>>,
): string {
  const sortedKeys = Object.keys(binding).sort();
  const canonical: Record<string, string | number | boolean | null> = {};
  for (const key of sortedKeys) {
    canonical[key] = binding[key] ?? null;
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function encodeGraphCursor(params: {
  readonly endpoint: GraphCursorEndpoint;
  readonly repoId: string;
  readonly queryHash: string;
  readonly key: GraphCursorKey;
}): string {
  const normalizedRepoId = normalizeCanonicalUuid(params.repoId);
  if (normalizedRepoId === null) {
    throw new GraphCursorValidationError('Cursor repoId must be a valid UUID.');
  }
  const encoded = Buffer.from(
    JSON.stringify({
      v: GRAPH_CURSOR_VERSION,
      endpoint: params.endpoint,
      repoId: normalizedRepoId,
      queryHash: params.queryHash,
      key: params.key,
    }),
    'utf8',
  ).toString('base64url');
  if (encoded.length > MAX_GRAPH_CURSOR_CHARS) {
    throw new GraphCursorValidationError('Encoded pagination cursor exceeds maximum byte bound.');
  }
  return encoded;
}

const cursorEnvelopeSchema = z
  .object({
    v: z.literal(GRAPH_CURSOR_VERSION),
    endpoint: z.enum(GRAPH_CURSOR_ENDPOINTS),
    repoId: lowerUuidSchema,
    queryHash: z.string().regex(SHA256_HEX_RE),
    key: z.unknown(),
  })
  .strict();

export function decodeGraphCursor<TKey>(
  rawCursor: string,
  expected: {
    readonly endpoint: GraphCursorEndpoint;
    readonly repoId: string;
    readonly queryHash: string;
  },
  keySchema: z.ZodType<TKey>,
): TKey {
  const normalizedRepoId = normalizeCanonicalUuid(expected.repoId);
  if (normalizedRepoId === null) {
    throw new GraphCursorValidationError('Expected repoId must be a valid UUID.');
  }
  if (
    rawCursor.length === 0 ||
    rawCursor.length > MAX_GRAPH_CURSOR_CHARS ||
    !BASE64URL_RE.test(rawCursor)
  ) {
    throw new GraphCursorValidationError('Pagination cursor is malformed or exceeds size limit.');
  }

  let parsedJson: unknown;
  try {
    const decoded = Buffer.from(rawCursor, 'base64url').toString('utf8');
    parsedJson = JSON.parse(decoded);
  } catch {
    throw new GraphCursorValidationError('Pagination cursor could not be decoded.');
  }

  const envelope = cursorEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    throw new GraphCursorValidationError('Pagination cursor envelope is invalid.');
  }
  if (
    envelope.data.endpoint !== expected.endpoint ||
    envelope.data.repoId !== normalizedRepoId ||
    envelope.data.queryHash !== expected.queryHash
  ) {
    throw new GraphCursorValidationError(
      'Pagination cursor does not match repository, endpoint, or query parameters.',
    );
  }

  const keyParsed = keySchema.safeParse(envelope.data.key);
  if (!keyParsed.success) {
    throw new GraphCursorValidationError('Pagination cursor key is invalid.');
  }
  return keyParsed.data;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareGraphNodeSummaries(
  a: Pick<GraphNodeSummary, 'nodeType' | 'filePath' | 'startLine' | 'qualifiedName' | 'id'>,
  b: Pick<GraphNodeSummary, 'nodeType' | 'filePath' | 'startLine' | 'qualifiedName' | 'id'>,
): number {
  const rankDiff = NODE_TYPE_SORT_RANK[a.nodeType] - NODE_TYPE_SORT_RANK[b.nodeType];
  if (rankDiff !== 0) return rankDiff;
  const pathDiff = cmpStr(a.filePath, b.filePath);
  if (pathDiff !== 0) return pathDiff;
  const lineDiff = (a.startLine ?? 0) - (b.startLine ?? 0);
  if (lineDiff !== 0) return lineDiff;
  const qnDiff = cmpStr(a.qualifiedName, b.qualifiedName);
  if (qnDiff !== 0) return qnDiff;
  return cmpStr(a.id, b.id);
}

export function compareGraphAggregatedEdges(
  a: Pick<GraphAggregatedEdge, 'sourceNodeId' | 'targetNodeId' | 'edgeTypes'>,
  b: Pick<GraphAggregatedEdge, 'sourceNodeId' | 'targetNodeId' | 'edgeTypes'>,
): number {
  const srcDiff = cmpStr(a.sourceNodeId, b.sourceNodeId);
  if (srcDiff !== 0) return srcDiff;
  const tgtDiff = cmpStr(a.targetNodeId, b.targetNodeId);
  if (tgtDiff !== 0) return tgtDiff;
  return cmpStr(a.edgeTypes.join(','), b.edgeTypes.join(','));
}

export function sortEdgeTypesCanonical(types: Iterable<EdgeType>): EdgeType[] {
  const unique = new Set<EdgeType>(types);
  const out: EdgeType[] = [];
  if (unique.has('IMPORTS')) out.push('IMPORTS');
  if (unique.has('CALLS')) out.push('CALLS');
  return out;
}
