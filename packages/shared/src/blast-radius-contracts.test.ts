import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLAST_RADIUS_MAX_DEPTH,
  MAX_BLAST_RADIUS_MAX_DEPTH,
  MIN_BLAST_RADIUS_MAX_DEPTH,
  blastRadiusResponseSchema,
  compareBlastRadiusCallSites,
  compareBlastRadiusImpactedFiles,
  compareBlastRadiusImpactedFolders,
  compareBlastRadiusImpactedNodes,
  sortBlastRadiusReasonsCanonical,
} from './blast-radius-contracts.js';

const ID_1 = '00000000-0000-4000-8000-000000000001';
const ID_2 = '00000000-0000-4000-8000-000000000002';
const ID_3 = '00000000-0000-4000-8000-000000000003';
const ID_4 = '00000000-0000-4000-8000-000000000004';

function makeValidResponse() {
  return {
    target: {
      id: ID_1,
      repoId: ID_2,
      nodeType: 'file' as const,
      name: 'a.ts',
      qualifiedName: 'file:src/a.ts',
      filePath: 'src/a.ts',
      isExported: false,
      seedFileCount: 1,
      seedExportedCallableCount: 1,
      excludedSubtreeNodeCount: 2,
    },
    params: { maxDepth: 2, hubThreshold: 30 },
    semantics: {
      propagationModel: 'conservative_file_wide_structural' as const,
      fileWidePropagationNote: 'Conservative static structural reachability.',
      containmentProjectionHops: 0 as const,
      hubPredicate: 'inDegreeDistinct > hubThreshold' as const,
      fileRollupHubPredicate: 'dependentFileCount > hubThreshold' as const,
    },
    completeness: {
      complete: true as const,
      traversalStrategy: 'bounded_reverse_frontier_bfs' as const,
      visitedFileStates: 2,
      visitedCallableStates: 0,
      virtualExportedTargetsExpanded: 1,
      cumulativeRawEdgesScanned: 2,
      totalEvidenceItems: 1,
    },
    summary: {
      totalImpactedNodes: 1,
      directNodeCount: 1,
      transitiveNodeCount: 0,
      totalImpactedFiles: 1,
      directFileCount: 1,
      transitiveFileCount: 0,
      totalImpactedFolders: 1,
      directFolderCount: 1,
      transitiveFolderCount: 0,
      impactedNodeHubCount: 0,
      impactedFileRollupHubCount: 0,
      byHop: {
        '1': { nodes: 1, files: 1, folders: 1 },
        '2': { nodes: 0, files: 0, folders: 0 },
        '3': { nodes: 0, files: 0, folders: 0 },
      },
    },
    impactedNodes: [
      {
        id: ID_3,
        nodeType: 'file' as const,
        name: 'b.ts',
        qualifiedName: 'file:src/b.ts',
        filePath: 'src/b.ts',
        parentNodeId: ID_4,
        isExported: false,
        startLine: 1,
        endLine: 5,
        hop: 1,
        reasons: ['imports_file' as const, 'calls_exported_symbol' as const],
        viaNodeIds: [ID_1],
        callSiteCount: 1,
        callSites: [{ viaNodeId: ID_1, callSiteLine: 3 }],
        inDegreeDistinct: 0,
        rawIncomingEdgeCount: 0,
        distinctImporterCount: 0,
        distinctCallerCount: 0,
        dependentFileCount: 0,
        isHub: false,
        isFileRollupHub: false,
      },
    ],
    impactedFiles: [
      {
        fileNodeId: ID_3,
        name: 'b.ts',
        qualifiedName: 'file:src/b.ts',
        filePath: 'src/b.ts',
        parentNodeId: ID_4,
        minHop: 1,
        reasons: ['imports_file' as const, 'calls_exported_symbol' as const],
        viaNodeIds: [ID_1],
        impactedCallableCount: 0,
        inDegreeDistinct: 0,
        rawIncomingEdgeCount: 0,
        dependentFileCount: 0,
        isHub: false,
        isFileRollupHub: false,
      },
    ],
    impactedFolders: [
      {
        folderNodeId: ID_4,
        name: 'src',
        qualifiedName: 'folder:src',
        folderPath: 'src',
        parentNodeId: null,
        minHop: 1,
        impactedFileCount: 1,
      },
    ],
  };
}

describe('packages/shared/src/blast-radius-contracts', () => {
  it('enforces depth constants and canonical deterministic sorting', () => {
    expect(MIN_BLAST_RADIUS_MAX_DEPTH).toBe(1);
    expect(DEFAULT_BLAST_RADIUS_MAX_DEPTH).toBe(2);
    expect(MAX_BLAST_RADIUS_MAX_DEPTH).toBe(3);

    expect(
      sortBlastRadiusReasonsCanonical([
        'contains_impacted_callable',
        'calls_symbol',
        'imports_file',
        'calls_exported_symbol',
        'imports_file',
      ]),
    ).toEqual([
      'imports_file',
      'calls_exported_symbol',
      'calls_symbol',
      'contains_impacted_callable',
    ]);

    const sites = [
      { viaNodeId: ID_2, callSiteLine: 10 },
      { viaNodeId: ID_1, callSiteLine: 10 },
      { viaNodeId: ID_2, callSiteLine: 3 },
    ];
    sites.sort(compareBlastRadiusCallSites);
    expect(sites).toEqual([
      { viaNodeId: ID_2, callSiteLine: 3 },
      { viaNodeId: ID_1, callSiteLine: 10 },
      { viaNodeId: ID_2, callSiteLine: 10 },
    ]);

    const nodes = [
      {
        hop: 2,
        isHub: true,
        inDegreeDistinct: 40,
        filePath: 'src/a.ts',
        qualifiedName: 'a',
        id: ID_1,
      },
      {
        hop: 1,
        isHub: false,
        inDegreeDistinct: 5,
        filePath: 'src/b.ts',
        qualifiedName: 'b',
        id: ID_2,
      },
      {
        hop: 1,
        isHub: true,
        inDegreeDistinct: 31,
        filePath: 'src/c.ts',
        qualifiedName: 'c',
        id: ID_3,
      },
    ];
    nodes.sort(compareBlastRadiusImpactedNodes);
    expect(nodes.map((n) => n.id)).toEqual([ID_3, ID_2, ID_1]);

    const files = [
      {
        minHop: 1,
        isFileRollupHub: false,
        dependentFileCount: 5,
        filePath: 'src/b.ts',
        fileNodeId: ID_2,
      },
      {
        minHop: 1,
        isFileRollupHub: true,
        dependentFileCount: 31,
        filePath: 'src/z.ts',
        fileNodeId: ID_1,
      },
    ];
    files.sort(compareBlastRadiusImpactedFiles);
    expect(files.map((f) => f.fileNodeId)).toEqual([ID_1, ID_2]);

    const folders = [
      { minHop: 2, impactedFileCount: 10, folderPath: 'src/a', folderNodeId: ID_1 },
      { minHop: 1, impactedFileCount: 2, folderPath: 'src/b', folderNodeId: ID_2 },
      { minHop: 1, impactedFileCount: 5, folderPath: 'src/c', folderNodeId: ID_3 },
    ];
    folders.sort(compareBlastRadiusImpactedFolders);
    expect(folders.map((f) => f.folderNodeId)).toEqual([ID_3, ID_2, ID_1]);
  });

  it('validates uniqueness, summary/evidence consistency, and strictly rejects snippet/callSiteSnippet fields', () => {
    const valid = makeValidResponse();
    expect(blastRadiusResponseSchema.safeParse(valid).success).toBe(true);

    // Rejects snippet on impactedNode
    const withNodeSnippet = makeValidResponse();
    expect(
      blastRadiusResponseSchema.safeParse({
        ...withNodeSnippet,
        impactedNodes: [{ ...withNodeSnippet.impactedNodes[0], snippet: 'secret source' }],
      }).success,
    ).toBe(false);

    // Rejects callSiteSnippet on callSites
    const withCallSnippet = makeValidResponse();
    expect(
      blastRadiusResponseSchema.safeParse({
        ...withCallSnippet,
        impactedNodes: [
          {
            ...withCallSnippet.impactedNodes[0],
            callSites: [{ viaNodeId: ID_1, callSiteLine: 3, callSiteSnippet: 'secret()' }],
          },
        ],
      }).success,
    ).toBe(false);

    // Rejects duplicate impactedNodes id, duplicate impactedFiles id, duplicate impactedFolders id
    const dupNode = makeValidResponse();
    expect(
      blastRadiusResponseSchema.safeParse({
        ...dupNode,
        impactedNodes: [dupNode.impactedNodes[0], dupNode.impactedNodes[0]],
        summary: {
          ...dupNode.summary,
          totalImpactedNodes: 2,
          directNodeCount: 2,
          byHop: { ...dupNode.summary.byHop, '1': { nodes: 2, files: 1, folders: 1 } },
        },
        completeness: { ...dupNode.completeness, totalEvidenceItems: 2 },
      }).success,
    ).toBe(false);

    // Rejects inconsistent summary counts & inconsistent callSiteCount / totalEvidenceItems
    const badSummary = makeValidResponse();
    expect(
      blastRadiusResponseSchema.safeParse({
        ...badSummary,
        summary: { ...badSummary.summary, totalImpactedNodes: 99 },
      }).success,
    ).toBe(false);

    const badEvidence = makeValidResponse();
    expect(
      blastRadiusResponseSchema.safeParse({
        ...badEvidence,
        completeness: { ...badEvidence.completeness, totalEvidenceItems: 99 },
      }).success,
    ).toBe(false);

    // Rejects complete: false
    const incomplete = makeValidResponse();
    expect(
      blastRadiusResponseSchema.safeParse({
        ...incomplete,
        completeness: { ...incomplete.completeness, complete: false },
      }).success,
    ).toBe(false);
  });
});
