import { randomUUID } from 'node:crypto';
import type { AnalysisOutput, AnalysisStats, ExtractedEdge, ExtractedNode } from '@archon/shared';
import { describe, expect, it } from 'vitest';
import {
  GRAPH_BATCH_MAX_BYTES,
  GRAPH_EDGE_BATCH_MAX_ROWS,
  GRAPH_NODE_BATCH_MAX_ROWS,
  GraphPersistenceValidationError,
  hasUnsafePgText,
  normalizeSnippetText,
  prepareGraphPersistencePlan,
} from './graph-persistence.js';
import { MAX_QUALIFIED_NAME_UTF8_BYTES } from './schema.js';

const REPO_ID = '00000000-0000-4000-8000-000000000001';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function makeOutput(
  nodes: readonly ExtractedNode[],
  edges: readonly ExtractedEdge[] = [],
  statsOverrides: Partial<AnalysisStats> = {},
): AnalysisOutput {
  let folderNodeCount = 0;
  let fileNodeCount = 0;
  let functionNodeCount = 0;
  let classNodeCount = 0;
  let symbolNodeCount = 0;
  for (const node of nodes) {
    switch (node.nodeType) {
      case 'folder':
        folderNodeCount += 1;
        break;
      case 'file':
        fileNodeCount += 1;
        break;
      case 'function':
        functionNodeCount += 1;
        break;
      case 'class':
        classNodeCount += 1;
        break;
      case 'symbol':
        symbolNodeCount += 1;
        break;
    }
  }
  const importsEdgeCount = edges.filter((e) => e.edgeType === 'IMPORTS').length;
  const callsEdgeCount = edges.filter((e) => e.edgeType === 'CALLS').length;

  return {
    nodes,
    edges,
    warnings: [],
    stats: {
      discoveredFilesCount: fileNodeCount,
      parsedFilesCount: fileNodeCount,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 0,
      folderNodeCount,
      fileNodeCount,
      functionNodeCount,
      classNodeCount,
      symbolNodeCount,
      importsEdgeCount,
      callsEdgeCount,
      totalBytesRead: 0,
      truncatedWarningsCount: 0,
      ...statsOverrides,
    },
  };
}

function makeFolder(name: string, parentQualifiedName: string | null = null): ExtractedNode {
  return {
    nodeType: 'folder',
    name,
    qualifiedName: `folder:${name}`,
    filePath: name,
    parentQualifiedName,
    isExported: false,
    startLine: null,
    endLine: null,
    contentHash: null,
    snippet: null,
  };
}

function makeFile(
  filePath: string,
  parentQualifiedName: string | null,
  snippet = 'export const x = 1;',
  qualifiedName = `file:${filePath}`,
): ExtractedNode {
  return {
    nodeType: 'file',
    name: filePath.split('/').at(-1) ?? filePath,
    qualifiedName,
    filePath,
    parentQualifiedName,
    isExported: false,
    startLine: 1,
    endLine: 3,
    contentHash: HASH_A,
    snippet,
  };
}

function expectValidationReason(fn: () => unknown, reasonCode: string): Error {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(GraphPersistenceValidationError);
  if (!(caught instanceof GraphPersistenceValidationError)) {
    throw new Error('Expected GraphPersistenceValidationError');
  }
  expect(caught.reasonCode).toBe(reasonCode);
  return caught;
}

describe('packages/db/src/graph-persistence', () => {
  it('rejects malformed identity text & NUL bytes, normalizes snippet surrogates via toWellFormed(), and enforces 2048 UTF-8 byte qualifiedName limit', () => {
    expect(hasUnsafePgText('hello 🚀 नमस्ते 日本語')).toBe(false);
    expect(hasUnsafePgText('has\u0000nul')).toBe(true);
    expect(hasUnsafePgText('lone-high-\uD800-tail')).toBe(true);
    expect(hasUnsafePgText('lone-high-end-\uD800')).toBe(true);
    expect(hasUnsafePgText('lone-low-\uDC00-mid')).toBe(true);

    // Snippet lone surrogates normalize cleanly to U+FFFD without throwing
    expect(normalizeSnippetText('ok \uD800 mid \uDC00 🚀')).toBe('ok \uFFFD mid \uFFFD 🚀');

    // Exact 2048 UTF-8 byte qualified name passes; 2049 multi-byte UTF-8 fails
    const exact2048 = 'a'.repeat(MAX_QUALIFIED_NAME_UTF8_BYTES);
    const planExact = prepareGraphPersistencePlan(
      REPO_ID,
      makeOutput([makeFile('src/exact.ts', null, 'export const s = "bad\uD800surr";', exact2048)]),
    );
    expect(planExact.nodeCount).toBe(1);
    expect(planExact.nodeBatches[0]?.[0]?.snippet).toBe('export const s = "bad\uFFFDsurr";');

    const overByteMultiByte = 'अ'.repeat(683);
    expect(Buffer.byteLength(overByteMultiByte, 'utf8')).toBe(2049);
    expectValidationReason(
      () =>
        prepareGraphPersistencePlan(
          REPO_ID,
          makeOutput([makeFile('src/over.ts', null, 'ok', overByteMultiByte)]),
        ),
      'INVALID_QUALIFIED_NAME_BYTES',
    );

    // Malformed identity text (lone surrogate or NUL in name/filePath/qualifiedName) is REJECTED
    expectValidationReason(
      () =>
        prepareGraphPersistencePlan(
          REPO_ID,
          makeOutput([makeFile('src/bad\uD800name.ts', null, 'ok')]),
        ),
      'UNSAFE_TEXT_VALUE',
    );

    // NUL byte in snippet is REJECTED without echoing secret text
    const secret = 'SECRET_SNIPPET_WITH_NUL_123';
    const nulErr = expectValidationReason(
      () =>
        prepareGraphPersistencePlan(
          REPO_ID,
          makeOutput([makeFile('src/nul.ts', null, `${secret}\u0000`)]),
        ),
      'UNSAFE_TEXT_VALUE',
    );
    expect(nulErr.message).not.toContain(secret);

    // CALLS snippet lone surrogate is normalized via toWellFormed(); CALLS NUL is rejected
    const f1 = makeFile('src/a.ts', null);
    const f2 = makeFile('src/b.ts', null);
    const callPlan = prepareGraphPersistencePlan(
      REPO_ID,
      makeOutput(
        [f1, f2],
        [
          {
            sourceQualifiedName: f1.qualifiedName,
            targetQualifiedName: f2.qualifiedName,
            edgeType: 'CALLS',
            callSiteLine: 2,
            callSiteSnippet: 'call("\uD800")',
          },
        ],
      ),
    );
    expect(callPlan.edgeBatches[0]?.[0]?.callSiteSnippet).toBe('call("\uFFFD")');

    expectValidationReason(
      () =>
        prepareGraphPersistencePlan(
          REPO_ID,
          makeOutput(
            [f1, f2],
            [
              {
                sourceQualifiedName: f1.qualifiedName,
                targetQualifiedName: f2.qualifiedName,
                edgeType: 'CALLS',
                callSiteLine: 2,
                callSiteSnippet: 'call("\u0000")',
              },
            ],
          ),
        ),
      'UNSAFE_TEXT_VALUE',
    );
  });

  it('rejects duplicate qualified names, missing/self/cyclic parents, invalid/duplicate edges, and inconsistent stats/metadata', () => {
    const f1 = makeFile('src/a.ts', null);
    expectValidationReason(
      () => prepareGraphPersistencePlan(REPO_ID, makeOutput([f1, f1])),
      'DUPLICATE_QUALIFIED_NAME',
    );

    expectValidationReason(
      () => prepareGraphPersistencePlan(REPO_ID, makeOutput([makeFile('src/a.ts', 'folder:nope')])),
      'MISSING_PARENT_NODE',
    );

    expectValidationReason(
      () =>
        prepareGraphPersistencePlan(REPO_ID, makeOutput([makeFile('src/a.ts', 'file:src/a.ts')])),
      'SELF_PARENT_NODE',
    );

    const cycA = makeFolder('a', 'folder:c');
    const cycB = makeFolder('b', 'folder:a');
    const cycC = makeFolder('c', 'folder:b');
    expectValidationReason(
      () => prepareGraphPersistencePlan(REPO_ID, makeOutput([cycA, cycB, cycC])),
      'PARENT_CYCLE_DETECTED',
    );

    // Mismatched stats rejected cleanly without echoing secrets
    expectValidationReason(
      () => prepareGraphPersistencePlan(REPO_ID, makeOutput([f1], [], { fileNodeCount: 99 })),
      'INVALID_GRAPH_STATS',
    );
    expectValidationReason(
      () => prepareGraphPersistencePlan(REPO_ID, makeOutput([f1], [], { discoveredFilesCount: 5 })),
      'INVALID_GRAPH_STATS',
    );
    // Unnormalized CR in snippet rejected
    expectValidationReason(
      () =>
        prepareGraphPersistencePlan(REPO_ID, makeOutput([makeFile('src/cr.ts', null, 'a\r\nb')])),
      'INVALID_NODE_METADATA',
    );

    const f2 = makeFile('src/b.ts', null);
    expectValidationReason(
      () =>
        prepareGraphPersistencePlan(
          REPO_ID,
          makeOutput(
            [f1],
            [
              {
                sourceQualifiedName: f1.qualifiedName,
                targetQualifiedName: 'file:src/missing.ts',
                edgeType: 'IMPORTS',
                callSiteLine: null,
                callSiteSnippet: null,
              },
            ],
          ),
        ),
      'MISSING_EDGE_ENDPOINT',
    );

    expectValidationReason(
      () =>
        prepareGraphPersistencePlan(
          REPO_ID,
          makeOutput(
            [f1],
            [
              {
                sourceQualifiedName: f1.qualifiedName,
                targetQualifiedName: f1.qualifiedName,
                edgeType: 'IMPORTS',
                callSiteLine: null,
                callSiteSnippet: null,
              },
            ],
          ),
        ),
      'SELF_IMPORT_EDGE',
    );

    const impEdge: ExtractedEdge = {
      sourceQualifiedName: f1.qualifiedName,
      targetQualifiedName: f2.qualifiedName,
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    };
    expectValidationReason(
      () => prepareGraphPersistencePlan(REPO_ID, makeOutput([f1, f2], [impEdge, impEdge])),
      'DUPLICATE_EDGE',
    );
  });

  it('orders children strictly after parents even when input is reversed and preallocates resolved UUIDs', () => {
    const root = makeFolder('src', null);
    const sub = makeFolder('src/nested', root.qualifiedName);
    const file = makeFile('src/nested/index.ts', sub.qualifiedName);
    const fn: ExtractedNode = {
      nodeType: 'function',
      name: 'run',
      qualifiedName: 'src/nested/index.ts::fn:run',
      filePath: 'src/nested/index.ts',
      parentQualifiedName: file.qualifiedName,
      isExported: true,
      startLine: 1,
      endLine: 3,
      contentHash: HASH_B,
      snippet: 'export function run() { return run(); }',
    };

    const plan = prepareGraphPersistencePlan(
      randomUUID(),
      makeOutput(
        [fn, file, sub, root],
        [
          {
            sourceQualifiedName: fn.qualifiedName,
            targetQualifiedName: fn.qualifiedName,
            edgeType: 'CALLS',
            callSiteLine: 1,
            callSiteSnippet: 'run()',
          },
        ],
      ),
    );

    expect(plan.nodeCount).toBe(4);
    expect(plan.edgeCount).toBe(1);
    const flatNodes = plan.nodeBatches.flat();
    expect(flatNodes.map((n) => n.qualifiedName)).toEqual([
      root.qualifiedName,
      sub.qualifiedName,
      file.qualifiedName,
      fn.qualifiedName,
    ]);

    const seenIds = new Set<string>();
    for (const row of flatNodes) {
      expect(row.id).toBeDefined();
      if (row.parentNodeId !== null && row.parentNodeId !== undefined) {
        expect(seenIds.has(row.parentNodeId)).toBe(true);
      }
      if (row.id !== undefined) {
        seenIds.add(row.id);
      }
    }

    const edge = plan.edgeBatches.flat()[0];
    expect(edge?.sourceNodeId).toBe(flatNodes[3]?.id);
    expect(edge?.targetNodeId).toBe(flatNodes[3]?.id);
  });

  it('enforces row limits (200 / 500), strict 1 MiB byte budget, and rejects oversized singleton batches', () => {
    const manyNodes: ExtractedNode[] = Array.from({ length: 450 }, (_, i) =>
      makeFile(`src/f${String(i)}.ts`, null, 'x'),
    );
    const manyEdges: ExtractedEdge[] = Array.from({ length: 1_100 }, (_, i) => ({
      sourceQualifiedName: manyNodes[0]?.qualifiedName ?? 'file:src/f0.ts',
      targetQualifiedName: manyNodes[1]?.qualifiedName ?? 'file:src/f1.ts',
      edgeType: 'CALLS',
      callSiteLine: i + 1,
      callSiteSnippet: 'call()',
    }));

    const rowPlan = prepareGraphPersistencePlan(REPO_ID, makeOutput(manyNodes, manyEdges));
    expect(rowPlan.nodeBatches.map((b) => b.length)).toEqual([
      GRAPH_NODE_BATCH_MAX_ROWS,
      GRAPH_NODE_BATCH_MAX_ROWS,
      50,
    ]);
    expect(rowPlan.edgeBatches.map((b) => b.length)).toEqual([
      GRAPH_EDGE_BATCH_MAX_ROWS,
      GRAPH_EDGE_BATCH_MAX_ROWS,
      100,
    ]);

    const largeSnippet = 'x'.repeat(8_192);
    const heavyNodes: ExtractedNode[] = Array.from({ length: 200 }, (_, i) =>
      makeFile(`src/heavy-${String(i)}.ts`, null, largeSnippet),
    );
    const bytePlan = prepareGraphPersistencePlan(REPO_ID, makeOutput(heavyNodes));
    expect(bytePlan.nodeBatches.length).toBeGreaterThanOrEqual(2);
    expect(bytePlan.nodeBatches.flat()).toHaveLength(200);

    // Oversized singleton record exceeding maxBatchBytes MUST be rejected (not squeezed into a singleton batch)
    expectValidationReason(
      () =>
        prepareGraphPersistencePlan(
          REPO_ID,
          makeOutput([makeFile('src/singleton.ts', null, 'x'.repeat(2_048))]),
          { maxBatchBytes: 512 },
        ),
      'OVERSIZED_BATCH_RECORD',
    );

    // Caller cannot configure maxBatchBytes above the 1 MiB ceiling
    expect(() =>
      prepareGraphPersistencePlan(REPO_ID, makeOutput([]), {
        maxBatchBytes: GRAPH_BATCH_MAX_BYTES + 1,
      }),
    ).toThrow(/maxBatchBytes/);
  });
});
