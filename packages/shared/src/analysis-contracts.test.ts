import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_WARNING_CODES,
  ARCHON_APP_NAME,
  ARCHON_VERSION,
  CORE_ANALYSIS_ERROR_CODES,
  CORE_ENGINE_ID,
  EDGE_TYPES,
  MAX_WARNING_MESSAGE_CHARS,
  NODE_TYPES,
  analysisOutputSchema,
  validateAnalysisGraph,
  type AnalysisOutput,
  type ExtractedEdge,
  type ExtractedNode,
} from './index.js';

const VALID_SHA256 = 'a'.repeat(64);

function makeEmptyOutput(): AnalysisOutput {
  return {
    nodes: [],
    edges: [],
    warnings: [],
    stats: {
      discoveredFilesCount: 0,
      parsedFilesCount: 0,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 0,
      folderNodeCount: 0,
      fileNodeCount: 0,
      functionNodeCount: 0,
      classNodeCount: 0,
      symbolNodeCount: 0,
      importsEdgeCount: 0,
      callsEdgeCount: 0,
      totalBytesRead: 0,
      truncatedWarningsCount: 0,
    },
  };
}

function makeValidGraph(): AnalysisOutput {
  const nodes: readonly ExtractedNode[] = [
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
      name: 'a.ts',
      qualifiedName: 'file:src/a.ts',
      filePath: 'src/a.ts',
      parentQualifiedName: 'folder:src',
      isExported: false,
      startLine: 1,
      endLine: 5,
      contentHash: VALID_SHA256,
      snippet: '',
    },
    {
      nodeType: 'file',
      name: 'b.ts',
      qualifiedName: 'file:src/b.ts',
      filePath: 'src/b.ts',
      parentQualifiedName: 'folder:src',
      isExported: false,
      startLine: 1,
      endLine: 3,
      contentHash: VALID_SHA256,
      snippet: 'export const x = 1;',
    },
    {
      nodeType: 'function',
      name: 'recurse',
      qualifiedName: 'src/a.ts::fn:recurse',
      filePath: 'src/a.ts',
      parentQualifiedName: 'file:src/a.ts',
      isExported: true,
      startLine: 2,
      endLine: 5,
      contentHash: VALID_SHA256,
      snippet: '',
    },
  ];
  const edges: readonly ExtractedEdge[] = [
    {
      sourceQualifiedName: 'file:src/a.ts',
      targetQualifiedName: 'file:src/b.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
    {
      sourceQualifiedName: 'src/a.ts::fn:recurse',
      targetQualifiedName: 'src/a.ts::fn:recurse',
      edgeType: 'CALLS',
      callSiteLine: 4,
      callSiteSnippet: '',
    },
  ];
  return {
    nodes,
    edges,
    warnings: [
      {
        code: 'SYNTAX_ERROR',
        filePath: 'src/broken.ts',
        message: 'Syntax error at line 1',
        line: 1,
      },
      {
        code: 'INVALID_TSCONFIG',
        filePath: 'tsconfig.json',
        message: 'Ignored invalid tsconfig',
      },
    ],
    stats: {
      discoveredFilesCount: 3,
      parsedFilesCount: 2,
      skippedSyntaxErrorFilesCount: 1,
      skippedOversizedFilesCount: 0,
      configFilesCount: 1,
      folderNodeCount: 1,
      fileNodeCount: 2,
      functionNodeCount: 1,
      classNodeCount: 0,
      symbolNodeCount: 0,
      importsEdgeCount: 1,
      callsEdgeCount: 1,
      totalBytesRead: 120,
      truncatedWarningsCount: 0,
    },
  };
}

describe('analysis-contracts (shared graph DTOs & semantic validation)', () => {
  it('preserves exact CORE_ENGINE_ID, ARCHON_APP_NAME, ARCHON_VERSION, and enum constants', () => {
    expect(CORE_ENGINE_ID).toBe('archon-core');
    expect(ARCHON_APP_NAME.length).toBeGreaterThan(0);
    expect(ARCHON_VERSION.length).toBeGreaterThan(0);
    expect(NODE_TYPES).toEqual(['folder', 'file', 'function', 'class', 'symbol']);
    expect(EDGE_TYPES).toEqual(['IMPORTS', 'CALLS']);
    expect(ANALYSIS_WARNING_CODES).toEqual([
      'SYNTAX_ERROR',
      'UNREADABLE_FILE',
      'UNSAFE_SYMLINK_SKIPPED',
      'OVERSIZED_FILE_SKIPPED',
      'INVALID_TSCONFIG',
      'TSCONFIG_TRAVERSAL_IGNORED',
      'TSCONFIG_CIRCULAR_EXTENDS',
      'TSCONFIG_EXTENDS_DEPTH_EXCEEDED',
      'CONFIG_LIMIT_EXCEEDED',
    ]);
    expect(CORE_ANALYSIS_ERROR_CODES).toEqual([
      'INVALID_WORKSPACE',
      'PATH_TRAVERSAL_REJECTED',
      'FILE_LIMIT_EXCEEDED',
      'SIZE_LIMIT_EXCEEDED',
    ]);
  });

  it('accepts valid graphs with empty snippets, nullable folder fields, optional warning line, and recursive CALLS self-edges', () => {
    const valid = makeValidGraph();
    expect(analysisOutputSchema.safeParse(valid).success).toBe(true);
    expect(validateAnalysisGraph(valid)).toEqual({ valid: true, violations: [] });
  });

  it('accepts an empty graph with zero counts cleanly', () => {
    const empty = makeEmptyOutput();
    expect(analysisOutputSchema.safeParse(empty).success).toBe(true);
    expect(validateAnalysisGraph(empty)).toEqual({ valid: true, violations: [] });
  });

  it('rejects invalid node/edge/warning kinds, missing fields, and unexpected extra properties', () => {
    const base = makeValidGraph();

    expect(
      analysisOutputSchema.safeParse({
        ...base,
        extraRootField: true,
      }).success,
    ).toBe(false);

    expect(
      analysisOutputSchema.safeParse({
        ...base,
        nodes: [{ ...base.nodes[0], nodeType: 'interface' }],
      }).success,
    ).toBe(false);

    expect(
      analysisOutputSchema.safeParse({
        ...base,
        edges: [{ ...base.edges[0], edgeType: 'EXTENDS' }],
      }).success,
    ).toBe(false);

    expect(
      analysisOutputSchema.safeParse({
        ...base,
        warnings: [{ code: 'TSCONFIG_ERROR', filePath: 'tsconfig.json', message: 'bad' }],
      }).success,
    ).toBe(false);

    expect(
      analysisOutputSchema.safeParse({
        ...base,
        warnings: [
          {
            code: 'SYNTAX_ERROR',
            filePath: 'src/a.ts',
            message: 'x'.repeat(MAX_WARNING_MESSAGE_CHARS + 1),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('detects missing parent/edge references, self-imports, duplicate edges, and bad metadata in validateAnalysisGraph', () => {
    const base = makeValidGraph();
    const impEdge = base.edges[0];
    const callEdge = base.edges[1];
    if (impEdge === undefined || callEdge === undefined) {
      throw new Error('Expected fixture edges.');
    }

    // Missing parentQualifiedName
    const missingParent: AnalysisOutput = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.qualifiedName === 'file:src/a.ts' ? { ...n, parentQualifiedName: 'folder:missing' } : n,
      ),
    };
    expect(validateAnalysisGraph(missingParent).valid).toBe(false);

    // Missing edge endpoint
    const missingEndpoint: AnalysisOutput = {
      ...base,
      edges: [
        ...base.edges,
        {
          sourceQualifiedName: 'file:src/a.ts',
          targetQualifiedName: 'file:src/nonexistent.ts',
          edgeType: 'IMPORTS',
          callSiteLine: null,
          callSiteSnippet: null,
        },
      ],
      stats: { ...base.stats, importsEdgeCount: 2 },
    };
    expect(validateAnalysisGraph(missingEndpoint).valid).toBe(false);

    // Self-import rejected (while recursive CALLS self-edge remains valid)
    const selfImport: AnalysisOutput = {
      ...base,
      edges: [
        {
          sourceQualifiedName: 'file:src/a.ts',
          targetQualifiedName: 'file:src/a.ts',
          edgeType: 'IMPORTS',
          callSiteLine: null,
          callSiteSnippet: null,
        },
        callEdge,
      ],
    };
    expect(validateAnalysisGraph(selfImport).valid).toBe(false);

    // Duplicate CALLS edge on same line rejected
    const dupCall: AnalysisOutput = {
      ...base,
      edges: [impEdge, callEdge, callEdge],
      stats: { ...base.stats, callsEdgeCount: 2 },
    };
    expect(validateAnalysisGraph(dupCall).valid).toBe(false);
  });

  it('detects inconsistent per-type node/edge counts and over-cap snippets in validateAnalysisGraph', () => {
    const base = makeValidGraph();
    const impEdge = base.edges[0];
    const callEdge = base.edges[1];
    if (impEdge === undefined || callEdge === undefined) {
      throw new Error('Expected fixture edges.');
    }

    const wrongCounts: AnalysisOutput = {
      ...base,
      stats: { ...base.stats, functionNodeCount: 99 },
    };
    expect(validateAnalysisGraph(wrongCounts).valid).toBe(false);

    const wrongParsedSum: AnalysisOutput = {
      ...base,
      stats: { ...base.stats, discoveredFilesCount: 10 },
    };
    expect(validateAnalysisGraph(wrongParsedSum).valid).toBe(false);

    const overCapCallSnippet: AnalysisOutput = {
      ...base,
      edges: [
        impEdge,
        {
          ...callEdge,
          callSiteSnippet: 'x'.repeat(25),
        },
      ],
    };
    expect(validateAnalysisGraph(overCapCallSnippet, { maxCallSiteSnippetChars: 20 }).valid).toBe(
      false,
    );
  });
});
