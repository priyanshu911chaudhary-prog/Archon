import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HUB_THRESHOLD,
  GraphCursorValidationError,
  MAX_GRAPH_CURSOR_CHARS,
  compareGraphAggregatedEdges,
  compareGraphNodeSummaries,
  computeGraphCursorQueryHash,
  decodeGraphCursor,
  encodeGraphCursor,
  hubsCursorKeySchema,
  nodeChildrenCursorKeySchema,
  nodeEdgesCursorKeySchema,
  normalizeCanonicalUuid,
  sortEdgeTypesCanonical,
} from './graph-query-contracts.js';

const REPO_A_UPPER = '00000000-0000-4000-8000-0000000000AA';
const REPO_A_LOWER = '00000000-0000-4000-8000-0000000000aa';
const REPO_B = '00000000-0000-4000-8000-000000000002';
const NODE_1 = '00000000-0000-4000-8000-000000000011';
const NODE_2 = '00000000-0000-4000-8000-000000000012';
const EDGE_1 = '00000000-0000-4000-8000-000000000021';

describe('packages/shared/src/graph-query-contracts', () => {
  it('normalizes UUIDs, binds compact cursors to repo/endpoint/query params, and rejects mismatched or malformed cursors', () => {
    expect(DEFAULT_HUB_THRESHOLD).toBe(30);
    expect(normalizeCanonicalUuid(REPO_A_UPPER)).toBe(REPO_A_LOWER);
    expect(normalizeCanonicalUuid('not-a-uuid')).toBeNull();

    const hashA = computeGraphCursorQueryHash({
      endpoint: 'hubs',
      repoId: REPO_A_LOWER,
      scope: 'all',
      threshold: 30,
    });
    const hashSameOrderIndependent = computeGraphCursorQueryHash({
      threshold: 30,
      scope: 'all',
      repoId: REPO_A_LOWER,
      endpoint: 'hubs',
    });
    expect(hashA).toBe(hashSameOrderIndependent);

    // Encode with uppercase repoId -> normalized to lowercase; decodes with uppercase OR lowercase
    const cursor = encodeGraphCursor({
      endpoint: 'hubs',
      repoId: REPO_A_UPPER,
      queryHash: hashA,
      key: { hubDegree: 31, rawIncomingEdgeCount: 40, id: NODE_1 },
    });
    expect(cursor.length).toBeLessThanOrEqual(MAX_GRAPH_CURSOR_CHARS);

    const decoded = decodeGraphCursor(
      cursor,
      { endpoint: 'hubs', repoId: REPO_A_UPPER, queryHash: hashA },
      hubsCursorKeySchema,
    );
    expect(decoded).toEqual({ hubDegree: 31, rawIncomingEdgeCount: 40, id: NODE_1 });

    // Cross-repo, cross-endpoint, and changed-parameter rejections
    expect(() =>
      decodeGraphCursor(
        cursor,
        { endpoint: 'hubs', repoId: REPO_B, queryHash: hashA },
        hubsCursorKeySchema,
      ),
    ).toThrow(GraphCursorValidationError);

    expect(() =>
      decodeGraphCursor(
        cursor,
        { endpoint: 'node_edges', repoId: REPO_A_LOWER, queryHash: hashA },
        nodeEdgesCursorKeySchema,
      ),
    ).toThrow(GraphCursorValidationError);

    const hashDifferent = computeGraphCursorQueryHash({
      endpoint: 'hubs',
      repoId: REPO_A_LOWER,
      scope: 'all',
      threshold: 31,
    });
    expect(() =>
      decodeGraphCursor(
        cursor,
        { endpoint: 'hubs', repoId: REPO_A_LOWER, queryHash: hashDifferent },
        hubsCursorKeySchema,
      ),
    ).toThrow(GraphCursorValidationError);

    // Malformed / oversized / invalid base64url rejections
    for (const bad of ['', 'bad+base64/', 'a'.repeat(MAX_GRAPH_CURSOR_CHARS + 1), 'e30']) {
      expect(() =>
        decodeGraphCursor(
          bad,
          { endpoint: 'hubs', repoId: REPO_A_LOWER, queryHash: hashA },
          hubsCursorKeySchema,
        ),
      ).toThrow(GraphCursorValidationError);
    }

    // Compact node_children & node_edges cursors round-trip cleanly
    const childCursor = encodeGraphCursor({
      endpoint: 'node_children',
      repoId: REPO_A_LOWER,
      queryHash: hashA,
      key: { id: NODE_2 },
    });
    expect(
      decodeGraphCursor(
        childCursor,
        { endpoint: 'node_children', repoId: REPO_A_LOWER, queryHash: hashA },
        nodeChildrenCursorKeySchema,
      ),
    ).toEqual({ id: NODE_2 });

    const edgeCursor = encodeGraphCursor({
      endpoint: 'node_edges',
      repoId: REPO_A_LOWER,
      queryHash: hashA,
      key: { edgeId: EDGE_1 },
    });
    expect(
      decodeGraphCursor(
        edgeCursor,
        { endpoint: 'node_edges', repoId: REPO_A_LOWER, queryHash: hashA },
        nodeEdgesCursorKeySchema,
      ),
    ).toEqual({ edgeId: EDGE_1 });
  });

  it('orders node summaries and aggregated edges deterministically', () => {
    const items = [
      {
        nodeType: 'function' as const,
        filePath: 'src/a.ts',
        startLine: 5,
        qualifiedName: 'src/a.ts::fn:b',
        id: NODE_2,
      },
      {
        nodeType: 'folder' as const,
        filePath: 'src',
        startLine: null,
        qualifiedName: 'folder:src',
        id: NODE_1,
      },
      {
        nodeType: 'file' as const,
        filePath: 'src/a.ts',
        startLine: 1,
        qualifiedName: 'file:src/a.ts',
        id: NODE_1,
      },
      {
        nodeType: 'class' as const,
        filePath: 'src/a.ts',
        startLine: 2,
        qualifiedName: 'src/a.ts::class:A',
        id: NODE_1,
      },
    ];
    items.sort(compareGraphNodeSummaries);
    expect(items.map((i) => i.nodeType)).toEqual(['folder', 'file', 'class', 'function']);

    expect(sortEdgeTypesCanonical(['CALLS', 'IMPORTS', 'CALLS'])).toEqual(['IMPORTS', 'CALLS']);
    expect(
      compareGraphAggregatedEdges(
        { sourceNodeId: NODE_1, targetNodeId: NODE_2, edgeTypes: ['IMPORTS'] },
        { sourceNodeId: NODE_2, targetNodeId: NODE_1, edgeTypes: ['CALLS'] },
      ),
    ).toBeLessThan(0);
  });
});
