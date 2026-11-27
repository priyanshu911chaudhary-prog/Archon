import { randomUUID } from 'node:crypto';
import {
  EDGE_TYPES,
  NODE_TYPES,
  validateAnalysisGraph,
  type AnalysisOutput,
  type ExtractedEdge,
  type ExtractedNode,
  type GraphValidationLimits,
} from '@archon/shared';
import { DbError } from './errors.js';
import { MAX_QUALIFIED_NAME_UTF8_BYTES, type NewEdgeRecord, type NewNodeRecord } from './schema.js';

export const GRAPH_NODE_BATCH_MAX_ROWS = 200 as const;
export const GRAPH_EDGE_BATCH_MAX_ROWS = 500 as const;
export const GRAPH_BATCH_MAX_BYTES = 1024 * 1024; // 1 MiB variable-data budget per batch

const MAX_PG_INT32_VALUE = 2_147_483_647;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const VALID_NODE_TYPES: ReadonlySet<string> = new Set(NODE_TYPES);
const VALID_EDGE_TYPES: ReadonlySet<string> = new Set(EDGE_TYPES);

export type GraphValidationReasonCode =
  | 'INVALID_REPO_ID'
  | 'DUPLICATE_QUALIFIED_NAME'
  | 'INVALID_QUALIFIED_NAME_BYTES'
  | 'UNSAFE_TEXT_VALUE'
  | 'INVALID_NODE_TYPE'
  | 'INVALID_NODE_METADATA'
  | 'MISSING_PARENT_NODE'
  | 'SELF_PARENT_NODE'
  | 'PARENT_CYCLE_DETECTED'
  | 'MISSING_EDGE_ENDPOINT'
  | 'INVALID_EDGE_TYPE'
  | 'SELF_IMPORT_EDGE'
  | 'DUPLICATE_EDGE'
  | 'INVALID_EDGE_METADATA'
  | 'INVALID_GRAPH_STATS'
  | 'INVALID_GRAPH_WARNINGS'
  | 'OVERSIZED_BATCH_RECORD';

/**
 * Sanitized validation error thrown before opening a graph publication transaction.
 * Never echoes raw source snippets, file paths, or untrusted qualified names.
 */
export class GraphPersistenceValidationError extends DbError {
  readonly reasonCode: GraphValidationReasonCode;

  constructor(reasonCode: GraphValidationReasonCode, message: string) {
    super('DB_VALIDATION_ERROR', message);
    this.name = 'GraphPersistenceValidationError';
    this.reasonCode = reasonCode;
  }
}

/**
 * Thrown when an `AbortSignal` aborts graph publication before transaction `COMMIT`,
 * causing PostgreSQL to roll back the entire publication transaction atomically.
 */
export class GraphPublicationAbortedError extends Error {
  readonly code = 'GRAPH_PUBLICATION_ABORTED' as const;

  constructor() {
    super('Repository graph publication aborted before commit.');
    this.name = 'GraphPublicationAbortedError';
  }
}

export interface GraphBatchOptions {
  readonly maxNodesPerBatch?: number;
  readonly maxEdgesPerBatch?: number;
  readonly maxBatchBytes?: number;
  readonly validationLimits?: GraphValidationLimits;
}

export interface GraphPersistencePlan {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly fileNodeCount: number;
  readonly nodeBatches: readonly (readonly NewNodeRecord[])[];
  readonly edgeBatches: readonly (readonly NewEdgeRecord[])[];
}

interface StringPrototypeWithWellFormed {
  readonly toWellFormed?: (this: string) => string;
}

const STRING_PROTO: StringPrototypeWithWellFormed = String.prototype;

/**
 * Rejects NUL bytes (`\u0000`, invalid in PostgreSQL UTF-8 text columns) and unpaired
 * UTF-16 surrogates (invalid Unicode scalar values) while permitting valid astral-plane
 * Unicode (e.g., emoji, CJK, Devanagari). Used for strict identity text fields.
 */
export function hasUnsafePgText(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) {
        return true;
      }
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Rejects NUL bytes in source/call-site snippets and normalizes any lone UTF-16 surrogates
 * using `String.prototype.toWellFormed()` (replacing unpaired surrogates with U+FFFD).
 */
export function normalizeSnippetText(value: string): string {
  if (value.includes('\u0000')) {
    throw new GraphPersistenceValidationError(
      'UNSAFE_TEXT_VALUE',
      'Graph snippet contains an invalid NUL byte.',
    );
  }
  const toWellFormedFn = STRING_PROTO.toWellFormed;
  if (typeof toWellFormedFn === 'function') {
    return toWellFormedFn.call(value);
  }
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value.charAt(i) + value.charAt(i + 1);
        i += 1;
      } else {
        out += '\uFFFD';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\uFFFD';
    } else {
      out += value.charAt(i);
    }
  }
  return out;
}

function assertSafeIdentityText(value: string): void {
  if (hasUnsafePgText(value)) {
    throw new GraphPersistenceValidationError(
      'UNSAFE_TEXT_VALUE',
      'Graph identity text contains NUL byte or unpaired UTF-16 surrogate.',
    );
  }
}

function assertPositivePgInt32(value: number | null): asserts value is number {
  if (value === null || !Number.isSafeInteger(value) || value < 1 || value > MAX_PG_INT32_VALUE) {
    throw new GraphPersistenceValidationError(
      'INVALID_NODE_METADATA',
      'Line number must be a positive PostgreSQL 32-bit integer.',
    );
  }
}

function assertNonNegativeStatInt32(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PG_INT32_VALUE) {
    throw new GraphPersistenceValidationError(
      'INVALID_GRAPH_STATS',
      'Graph statistics count must be a non-negative PostgreSQL 32-bit integer.',
    );
  }
}

function assertBatchBound(name: string, value: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new DbError(
      'DB_VALIDATION_ERROR',
      `${name} must be an integer between 1 and ${String(max)} (received ${String(value)}).`,
    );
  }
}

function validateNodeAndNormalizeSnippet(node: ExtractedNode): string | null {
  if (!VALID_NODE_TYPES.has(node.nodeType)) {
    throw new GraphPersistenceValidationError('INVALID_NODE_TYPE', 'Unsupported graph node type.');
  }
  if (node.name.length === 0 || node.filePath.length === 0) {
    throw new GraphPersistenceValidationError(
      'INVALID_NODE_METADATA',
      'Graph node name and filePath must be non-empty.',
    );
  }
  assertSafeIdentityText(node.name);
  assertSafeIdentityText(node.qualifiedName);
  assertSafeIdentityText(node.filePath);

  const qnBytes = Buffer.byteLength(node.qualifiedName, 'utf8');
  if (qnBytes < 1 || qnBytes > MAX_QUALIFIED_NAME_UTF8_BYTES) {
    throw new GraphPersistenceValidationError(
      'INVALID_QUALIFIED_NAME_BYTES',
      `Node qualifiedName UTF-8 length must be between 1 and ${String(MAX_QUALIFIED_NAME_UTF8_BYTES)} bytes.`,
    );
  }

  if (node.parentQualifiedName !== null) {
    assertSafeIdentityText(node.parentQualifiedName);
    if (node.parentQualifiedName === node.qualifiedName) {
      throw new GraphPersistenceValidationError(
        'SELF_PARENT_NODE',
        'Graph node cannot reference itself as parent.',
      );
    }
  }

  if (node.nodeType === 'folder') {
    if (
      node.isExported ||
      node.startLine !== null ||
      node.endLine !== null ||
      node.contentHash !== null ||
      node.snippet !== null
    ) {
      throw new GraphPersistenceValidationError(
        'INVALID_NODE_METADATA',
        'Folder node must not carry export flag, line numbers, contentHash, or snippet.',
      );
    }
    return null;
  }

  assertPositivePgInt32(node.startLine);
  assertPositivePgInt32(node.endLine);
  if (node.endLine < node.startLine) {
    throw new GraphPersistenceValidationError(
      'INVALID_NODE_METADATA',
      'Graph node endLine must be greater than or equal to startLine.',
    );
  }
  if (node.contentHash === null || !SHA256_HEX_RE.test(node.contentHash)) {
    throw new GraphPersistenceValidationError(
      'INVALID_NODE_METADATA',
      'Non-folder node must carry a lowercase 64-character SHA-256 contentHash.',
    );
  }
  if (node.snippet === null) {
    throw new GraphPersistenceValidationError(
      'INVALID_NODE_METADATA',
      'Non-folder node must carry a non-null snippet.',
    );
  }
  if (node.snippet.includes('\r')) {
    throw new GraphPersistenceValidationError(
      'INVALID_NODE_METADATA',
      'Graph node snippet must use normalized LF line endings.',
    );
  }
  return normalizeSnippetText(node.snippet);
}

function validateEdgeAndNormalizeSnippet(
  edge: ExtractedEdge,
  nodeIdByQualifiedName: ReadonlyMap<string, string>,
  seenImportKeys: Set<string>,
  seenCallKeys: Set<string>,
): {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly callSiteSnippet: string | null;
} {
  if (!VALID_EDGE_TYPES.has(edge.edgeType)) {
    throw new GraphPersistenceValidationError('INVALID_EDGE_TYPE', 'Unsupported graph edge type.');
  }
  assertSafeIdentityText(edge.sourceQualifiedName);
  assertSafeIdentityText(edge.targetQualifiedName);

  const sourceNodeId = nodeIdByQualifiedName.get(edge.sourceQualifiedName);
  const targetNodeId = nodeIdByQualifiedName.get(edge.targetQualifiedName);
  if (sourceNodeId === undefined || targetNodeId === undefined) {
    throw new GraphPersistenceValidationError(
      'MISSING_EDGE_ENDPOINT',
      'Graph edge references a missing source or target node.',
    );
  }

  if (edge.edgeType === 'IMPORTS') {
    if (sourceNodeId === targetNodeId) {
      throw new GraphPersistenceValidationError(
        'SELF_IMPORT_EDGE',
        'IMPORTS edge cannot target its own source node.',
      );
    }
    if (edge.callSiteLine !== null || edge.callSiteSnippet !== null) {
      throw new GraphPersistenceValidationError(
        'INVALID_EDGE_METADATA',
        'IMPORTS edge must have null callSiteLine and callSiteSnippet.',
      );
    }
    const importKey = `${sourceNodeId}\0${targetNodeId}`;
    if (seenImportKeys.has(importKey)) {
      throw new GraphPersistenceValidationError(
        'DUPLICATE_EDGE',
        'Duplicate IMPORTS edge detected between the same nodes.',
      );
    }
    seenImportKeys.add(importKey);
    return { sourceNodeId, targetNodeId, callSiteSnippet: null };
  }

  if (
    edge.callSiteLine === null ||
    !Number.isSafeInteger(edge.callSiteLine) ||
    edge.callSiteLine < 1 ||
    edge.callSiteLine > MAX_PG_INT32_VALUE
  ) {
    throw new GraphPersistenceValidationError(
      'INVALID_EDGE_METADATA',
      'CALLS edge callSiteLine must be a positive PostgreSQL 32-bit integer.',
    );
  }
  if (edge.callSiteSnippet === null) {
    throw new GraphPersistenceValidationError(
      'INVALID_EDGE_METADATA',
      'CALLS edge must carry a non-null callSiteSnippet.',
    );
  }
  if (edge.callSiteSnippet.includes('\r')) {
    throw new GraphPersistenceValidationError(
      'INVALID_EDGE_METADATA',
      'CALLS edge snippet must use normalized LF line endings.',
    );
  }
  const normalizedCallSnippet = normalizeSnippetText(edge.callSiteSnippet);

  const callKey = `${sourceNodeId}\0${targetNodeId}\0${String(edge.callSiteLine)}`;
  if (seenCallKeys.has(callKey)) {
    throw new GraphPersistenceValidationError(
      'DUPLICATE_EDGE',
      'Duplicate CALLS edge detected at the same callSiteLine.',
    );
  }
  seenCallKeys.add(callKey);
  return { sourceNodeId, targetNodeId, callSiteSnippet: normalizedCallSnippet };
}

function validateCompleteStatsAndWarnings(
  output: AnalysisOutput,
  limits?: GraphValidationLimits,
): void {
  const { stats } = output;
  assertNonNegativeStatInt32(stats.discoveredFilesCount);
  assertNonNegativeStatInt32(stats.parsedFilesCount);
  assertNonNegativeStatInt32(stats.skippedSyntaxErrorFilesCount);
  assertNonNegativeStatInt32(stats.skippedOversizedFilesCount);
  assertNonNegativeStatInt32(stats.configFilesCount);
  assertNonNegativeStatInt32(stats.folderNodeCount);
  assertNonNegativeStatInt32(stats.fileNodeCount);
  assertNonNegativeStatInt32(stats.functionNodeCount);
  assertNonNegativeStatInt32(stats.classNodeCount);
  assertNonNegativeStatInt32(stats.symbolNodeCount);
  assertNonNegativeStatInt32(stats.importsEdgeCount);
  assertNonNegativeStatInt32(stats.callsEdgeCount);
  assertNonNegativeStatInt32(stats.truncatedWarningsCount);
  if (!Number.isSafeInteger(stats.totalBytesRead) || stats.totalBytesRead < 0) {
    throw new GraphPersistenceValidationError(
      'INVALID_GRAPH_STATS',
      'Graph statistics totalBytesRead must be a non-negative safe integer.',
    );
  }

  for (const warning of output.warnings) {
    if (warning.filePath.length === 0 || warning.message.length === 0) {
      throw new GraphPersistenceValidationError(
        'INVALID_GRAPH_WARNINGS',
        'Graph warning filePath and message must be non-empty.',
      );
    }
    assertSafeIdentityText(warning.filePath);
    if (warning.message.includes('\u0000')) {
      throw new GraphPersistenceValidationError(
        'UNSAFE_TEXT_VALUE',
        'Graph warning message contains an invalid NUL byte.',
      );
    }
  }

  // Single-pass semantic validation without cloning `output` (checks stats parity,
  // warning caps, and snippet char caps). Never echoes raw violation text.
  const semanticCheck = validateAnalysisGraph(output, limits);
  if (!semanticCheck.valid) {
    const first = semanticCheck.violations[0] ?? '';
    if (first.startsWith('AnalysisStats.')) {
      throw new GraphPersistenceValidationError(
        'INVALID_GRAPH_STATS',
        'Analysis graph statistics do not match emitted nodes and edges.',
      );
    }
    if (first.startsWith('Warning') || first.startsWith('Warnings')) {
      throw new GraphPersistenceValidationError(
        'INVALID_GRAPH_WARNINGS',
        'Analysis graph warnings violate contract limits.',
      );
    }
    if (first.includes('CALLS edge') || first.includes('IMPORTS edge')) {
      throw new GraphPersistenceValidationError(
        'INVALID_EDGE_METADATA',
        'Analysis graph edge metadata violates contract limits.',
      );
    }
    throw new GraphPersistenceValidationError(
      'INVALID_NODE_METADATA',
      'Analysis graph node metadata violates contract limits.',
    );
  }
}

function measureNodeVariableBytes(record: NewNodeRecord): number {
  return (
    Buffer.byteLength(record.name, 'utf8') +
    Buffer.byteLength(record.qualifiedName, 'utf8') +
    Buffer.byteLength(record.filePath, 'utf8') +
    (record.contentHash !== null && record.contentHash !== undefined
      ? Buffer.byteLength(record.contentHash, 'utf8')
      : 0) +
    (record.snippet !== null && record.snippet !== undefined
      ? Buffer.byteLength(record.snippet, 'utf8')
      : 0)
  );
}

function measureEdgeVariableBytes(record: NewEdgeRecord): number {
  return record.callSiteSnippet !== null && record.callSiteSnippet !== undefined
    ? Buffer.byteLength(record.callSiteSnippet, 'utf8')
    : 0;
}

function chunkRecords<T>(
  records: readonly T[],
  measureBytes: (record: T) => number,
  maxRows: number,
  maxBytes: number,
): readonly (readonly T[])[] {
  if (records.length === 0) {
    return [];
  }

  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const record of records) {
    const rowBytes = measureBytes(record);
    if (rowBytes > maxBytes) {
      throw new GraphPersistenceValidationError(
        'OVERSIZED_BATCH_RECORD',
        'Single graph record exceeds the maximum variable-data batch byte budget.',
      );
    }
    if (current.length > 0 && (current.length >= maxRows || currentBytes + rowBytes > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(record);
    currentBytes += rowBytes;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/**
 * Validates `AnalysisOutput` (complete stats, warnings, metadata, identity safety,
 * snippet normalization, and parent acyclicity) without cloning `output`, preallocates
 * node UUIDs in parent-before-child order, resolves edge endpoints, and builds bounded
 * insertion batches (`maxNodesPerBatch` = 200, `maxEdgesPerBatch` = 500, `maxBatchBytes` <= 1 MiB).
 */
export function prepareGraphPersistencePlan(
  repoId: string,
  output: AnalysisOutput,
  options: GraphBatchOptions = {},
): GraphPersistencePlan {
  if (!UUID_RE.test(repoId)) {
    throw new GraphPersistenceValidationError(
      'INVALID_REPO_ID',
      'Repository ID must be a valid UUID.',
    );
  }

  const maxNodesPerBatch = options.maxNodesPerBatch ?? GRAPH_NODE_BATCH_MAX_ROWS;
  const maxEdgesPerBatch = options.maxEdgesPerBatch ?? GRAPH_EDGE_BATCH_MAX_ROWS;
  const maxBatchBytes = options.maxBatchBytes ?? GRAPH_BATCH_MAX_BYTES;
  assertBatchBound('maxNodesPerBatch', maxNodesPerBatch, GRAPH_NODE_BATCH_MAX_ROWS);
  assertBatchBound('maxEdgesPerBatch', maxEdgesPerBatch, GRAPH_EDGE_BATCH_MAX_ROWS);
  assertBatchBound('maxBatchBytes', maxBatchBytes, GRAPH_BATCH_MAX_BYTES);

  const indexByQualifiedName = new Map<string, number>();
  const normalizedSnippetsByIndex: (string | null)[] = [];
  let fileNodeCount = 0;

  for (let i = 0; i < output.nodes.length; i += 1) {
    const node = output.nodes[i];
    if (node === undefined) {
      normalizedSnippetsByIndex.push(null);
      continue;
    }
    const normalizedSnippet = validateNodeAndNormalizeSnippet(node);
    normalizedSnippetsByIndex.push(normalizedSnippet);
    if (node.nodeType === 'file') {
      fileNodeCount += 1;
    }
    if (indexByQualifiedName.has(node.qualifiedName)) {
      throw new GraphPersistenceValidationError(
        'DUPLICATE_QUALIFIED_NAME',
        'Duplicate node qualifiedName detected in analysis graph.',
      );
    }
    indexByQualifiedName.set(node.qualifiedName, i);
  }

  // Iterative parent-before-child topological ordering & full cycle detection
  const childrenByParentIndex = new Map<number, number[]>();
  const orderedIndices: number[] = [];

  for (let i = 0; i < output.nodes.length; i += 1) {
    const node = output.nodes[i];
    if (node === undefined) {
      continue;
    }
    if (node.parentQualifiedName === null) {
      orderedIndices.push(i);
    } else {
      const parentIdx = indexByQualifiedName.get(node.parentQualifiedName);
      if (parentIdx === undefined) {
        throw new GraphPersistenceValidationError(
          'MISSING_PARENT_NODE',
          'Graph node references a missing parentQualifiedName.',
        );
      }
      const siblings = childrenByParentIndex.get(parentIdx);
      if (siblings !== undefined) {
        siblings.push(i);
      } else {
        childrenByParentIndex.set(parentIdx, [i]);
      }
    }
  }

  for (const currentIdx of orderedIndices) {
    const children = childrenByParentIndex.get(currentIdx);
    if (children !== undefined) {
      for (const childIdx of children) {
        orderedIndices.push(childIdx);
      }
    }
  }

  if (orderedIndices.length !== output.nodes.length) {
    throw new GraphPersistenceValidationError(
      'PARENT_CYCLE_DETECTED',
      'Analysis graph contains a cyclic parent hierarchy.',
    );
  }

  // Preallocate UUIDs in parent-before-child order so every parentNodeId is already resolved
  const nodeIdByQualifiedName = new Map<string, string>();
  const orderedNodeRecords: NewNodeRecord[] = [];

  for (const idx of orderedIndices) {
    const node = output.nodes[idx];
    if (node === undefined) {
      continue;
    }
    const nodeId = randomUUID();
    nodeIdByQualifiedName.set(node.qualifiedName, nodeId);
    const parentNodeId =
      node.parentQualifiedName === null
        ? null
        : (nodeIdByQualifiedName.get(node.parentQualifiedName) ?? null);
    if (node.parentQualifiedName !== null && parentNodeId === null) {
      throw new GraphPersistenceValidationError(
        'MISSING_PARENT_NODE',
        'Failed to resolve preallocated parent UUID.',
      );
    }

    orderedNodeRecords.push({
      id: nodeId,
      repoId,
      nodeType: node.nodeType,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      parentNodeId,
      isExported: node.isExported,
      startLine: node.startLine,
      endLine: node.endLine,
      contentHash: node.contentHash,
      snippet: normalizedSnippetsByIndex[idx] ?? null,
    });
  }

  const seenImportKeys = new Set<string>();
  const seenCallKeys = new Set<string>();
  const edgeRecords: NewEdgeRecord[] = [];

  for (const edge of output.edges) {
    const { sourceNodeId, targetNodeId, callSiteSnippet } = validateEdgeAndNormalizeSnippet(
      edge,
      nodeIdByQualifiedName,
      seenImportKeys,
      seenCallKeys,
    );
    edgeRecords.push({
      repoId,
      sourceNodeId,
      targetNodeId,
      edgeType: edge.edgeType,
      callSiteLine: edge.callSiteLine,
      callSiteSnippet,
    });
  }

  // Validate complete stats, warnings, and semantic contract caps without cloning `output`
  validateCompleteStatsAndWarnings(output, options.validationLimits);

  const nodeBatches = chunkRecords(
    orderedNodeRecords,
    measureNodeVariableBytes,
    maxNodesPerBatch,
    maxBatchBytes,
  );
  const edgeBatches = chunkRecords(
    edgeRecords,
    measureEdgeVariableBytes,
    maxEdgesPerBatch,
    maxBatchBytes,
  );

  return {
    nodeCount: orderedNodeRecords.length,
    edgeCount: edgeRecords.length,
    fileNodeCount,
    nodeBatches,
    edgeBatches,
  };
}
