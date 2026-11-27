import { z } from 'zod';
import { NODE_TYPES, type NodeType } from './analysis-contracts.js';
import { MAX_HUB_THRESHOLD, MIN_HUB_THRESHOLD } from './graph-query-contracts.js';

export const DEFAULT_BLAST_RADIUS_MAX_DEPTH = 2 as const;
export const MIN_BLAST_RADIUS_MAX_DEPTH = 1 as const;
export const MAX_BLAST_RADIUS_MAX_DEPTH = 3 as const;

export const BLAST_RADIUS_REASONS = [
  'imports_file',
  'calls_exported_symbol',
  'calls_symbol',
  'contains_impacted_callable',
] as const;
export type BlastRadiusReason = (typeof BLAST_RADIUS_REASONS)[number];

export const BLAST_RADIUS_PROPAGATION_MODELS = [
  'calls_only',
  'conservative_file_wide_structural',
] as const;
export type BlastRadiusPropagationModel = (typeof BLAST_RADIUS_PROPAGATION_MODELS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidSchema = z.string().regex(UUID_RE, 'Expected valid UUID.');
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
const hopSchema = z.number().int().min(MIN_BLAST_RADIUS_MAX_DEPTH).max(MAX_BLAST_RADIUS_MAX_DEPTH);

export const blastRadiusReasonSchema = z.enum(BLAST_RADIUS_REASONS);
export const blastRadiusPropagationModelSchema = z.enum(BLAST_RADIUS_PROPAGATION_MODELS);

export const blastRadiusCallSiteSchema = z
  .object({
    viaNodeId: uuidSchema,
    callSiteLine: posIntSchema,
  })
  .strict();

export const blastRadiusImpactedNodeSchema = z
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
    hop: hopSchema,
    reasons: z.array(blastRadiusReasonSchema).min(1),
    viaNodeIds: z.array(uuidSchema).min(1),
    callSiteCount: nonNegIntSchema,
    callSites: z.array(blastRadiusCallSiteSchema),
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

export const blastRadiusImpactedFileSchema = z
  .object({
    fileNodeId: uuidSchema,
    name: z.string().min(1),
    qualifiedName: z.string().min(1),
    filePath: z.string().min(1),
    parentNodeId: uuidSchema.nullable(),
    minHop: hopSchema,
    reasons: z.array(blastRadiusReasonSchema).min(1),
    viaNodeIds: z.array(uuidSchema).min(1),
    impactedCallableCount: nonNegIntSchema,
    inDegreeDistinct: nonNegIntSchema,
    rawIncomingEdgeCount: nonNegIntSchema,
    dependentFileCount: nonNegIntSchema,
    isHub: z.boolean(),
    isFileRollupHub: z.boolean(),
  })
  .strict();

export const blastRadiusImpactedFolderSchema = z
  .object({
    folderNodeId: uuidSchema,
    name: z.string().min(1),
    qualifiedName: z.string().min(1),
    folderPath: z.string().min(1),
    parentNodeId: uuidSchema.nullable(),
    minHop: hopSchema,
    impactedFileCount: posIntSchema,
  })
  .strict();

const hopBucketCountSchema = z
  .object({
    nodes: nonNegIntSchema,
    files: nonNegIntSchema,
    folders: nonNegIntSchema,
  })
  .strict();

export const blastRadiusResponseSchema = z
  .object({
    target: z
      .object({
        id: uuidSchema,
        repoId: uuidSchema,
        nodeType: z.enum(NODE_TYPES),
        name: z.string().min(1),
        qualifiedName: z.string().min(1),
        filePath: z.string().min(1),
        isExported: z.boolean(),
        seedFileCount: nonNegIntSchema,
        seedExportedCallableCount: nonNegIntSchema,
        excludedSubtreeNodeCount: posIntSchema,
      })
      .strict(),
    params: z
      .object({
        maxDepth: hopSchema,
        hubThreshold: z.number().int().min(MIN_HUB_THRESHOLD).max(MAX_HUB_THRESHOLD),
      })
      .strict(),
    semantics: z
      .object({
        propagationModel: blastRadiusPropagationModelSchema,
        fileWidePropagationNote: z.string().min(1),
        containmentProjectionHops: z.literal(0),
        hubPredicate: z.literal('inDegreeDistinct > hubThreshold'),
        fileRollupHubPredicate: z.literal('dependentFileCount > hubThreshold'),
      })
      .strict(),
    completeness: z
      .object({
        complete: z.literal(true),
        traversalStrategy: z.literal('bounded_reverse_frontier_bfs'),
        /** Distinct file traversal states visited (seed files + impacted files). */
        visitedFileStates: nonNegIntSchema,
        /** Distinct callable/symbol traversal states visited (seed callable target + impacted callables). */
        visitedCallableStates: nonNegIntSchema,
        /** Virtual exported declarations expanded from frontier files (distinct from impacted callable states). */
        virtualExportedTargetsExpanded: nonNegIntSchema,
        /** Cumulative qualifying edge rows charged across traversal and degree/rollup enrichment (not physical DB page scans). */
        cumulativeRawEdgesScanned: nonNegIntSchema,
        totalEvidenceItems: nonNegIntSchema,
      })
      .strict(),
    summary: z
      .object({
        totalImpactedNodes: nonNegIntSchema,
        directNodeCount: nonNegIntSchema,
        transitiveNodeCount: nonNegIntSchema,
        totalImpactedFiles: nonNegIntSchema,
        directFileCount: nonNegIntSchema,
        transitiveFileCount: nonNegIntSchema,
        totalImpactedFolders: nonNegIntSchema,
        directFolderCount: nonNegIntSchema,
        transitiveFolderCount: nonNegIntSchema,
        impactedNodeHubCount: nonNegIntSchema,
        impactedFileRollupHubCount: nonNegIntSchema,
        byHop: z
          .object({
            '1': hopBucketCountSchema,
            '2': hopBucketCountSchema,
            '3': hopBucketCountSchema,
          })
          .strict(),
      })
      .strict(),
    impactedNodes: z.array(blastRadiusImpactedNodeSchema),
    impactedFiles: z.array(blastRadiusImpactedFileSchema),
    impactedFolders: z.array(blastRadiusImpactedFolderSchema),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seenNodeIds = new Set<string>();
    let evidenceSum = 0;
    let nodeHubs = 0;
    const nodeHops = { 1: 0, 2: 0, 3: 0 };

    for (let i = 0; i < data.impactedNodes.length; i += 1) {
      const node = data.impactedNodes[i];
      if (node === undefined) continue;
      if (seenNodeIds.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['impactedNodes', i, 'id'],
          message: 'Duplicate impactedNodes id.',
        });
      }
      seenNodeIds.add(node.id);
      if (node.callSiteCount !== node.callSites.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['impactedNodes', i, 'callSiteCount'],
          message: 'callSiteCount must equal callSites.length.',
        });
      }
      evidenceSum += node.callSites.length;
      if (node.isHub) nodeHubs += 1;
      if (node.hop === 1 || node.hop === 2 || node.hop === 3) {
        nodeHops[node.hop] += 1;
      }
    }

    const seenFileIds = new Set<string>();
    let fileHubs = 0;
    const fileHops = { 1: 0, 2: 0, 3: 0 };
    for (let i = 0; i < data.impactedFiles.length; i += 1) {
      const file = data.impactedFiles[i];
      if (file === undefined) continue;
      if (seenFileIds.has(file.fileNodeId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['impactedFiles', i, 'fileNodeId'],
          message: 'Duplicate impactedFiles fileNodeId.',
        });
      }
      seenFileIds.add(file.fileNodeId);
      if (file.isFileRollupHub) fileHubs += 1;
      if (file.minHop === 1 || file.minHop === 2 || file.minHop === 3) {
        fileHops[file.minHop] += 1;
      }
    }

    const seenFolderIds = new Set<string>();
    const folderHops = { 1: 0, 2: 0, 3: 0 };
    for (let i = 0; i < data.impactedFolders.length; i += 1) {
      const folder = data.impactedFolders[i];
      if (folder === undefined) continue;
      if (seenFolderIds.has(folder.folderNodeId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['impactedFolders', i, 'folderNodeId'],
          message: 'Duplicate impactedFolders folderNodeId.',
        });
      }
      seenFolderIds.add(folder.folderNodeId);
      if (folder.minHop === 1 || folder.minHop === 2 || folder.minHop === 3) {
        folderHops[folder.minHop] += 1;
      }
    }

    if (evidenceSum !== data.completeness.totalEvidenceItems) {
      ctx.addIssue({
        code: 'custom',
        path: ['completeness', 'totalEvidenceItems'],
        message: 'totalEvidenceItems must equal total callSites across impactedNodes.',
      });
    }

    const s = data.summary;
    const summaryConsistent =
      s.totalImpactedNodes === data.impactedNodes.length &&
      s.directNodeCount === nodeHops[1] &&
      s.transitiveNodeCount === nodeHops[2] + nodeHops[3] &&
      s.totalImpactedFiles === data.impactedFiles.length &&
      s.directFileCount === fileHops[1] &&
      s.transitiveFileCount === fileHops[2] + fileHops[3] &&
      s.totalImpactedFolders === data.impactedFolders.length &&
      s.directFolderCount === folderHops[1] &&
      s.transitiveFolderCount === folderHops[2] + folderHops[3] &&
      s.impactedNodeHubCount === nodeHubs &&
      s.impactedFileRollupHubCount === fileHubs &&
      s.byHop['1'].nodes === nodeHops[1] &&
      s.byHop['2'].nodes === nodeHops[2] &&
      s.byHop['3'].nodes === nodeHops[3] &&
      s.byHop['1'].files === fileHops[1] &&
      s.byHop['2'].files === fileHops[2] &&
      s.byHop['3'].files === fileHops[3] &&
      s.byHop['1'].folders === folderHops[1] &&
      s.byHop['2'].folders === folderHops[2] &&
      s.byHop['3'].folders === folderHops[3];

    if (!summaryConsistent) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary'],
        message: 'Blast-radius summary counts do not match impacted collections.',
      });
    }
  });

export type BlastRadiusCallSite = z.infer<typeof blastRadiusCallSiteSchema>;
export type BlastRadiusImpactedNode = z.infer<typeof blastRadiusImpactedNodeSchema>;
export type BlastRadiusImpactedFile = z.infer<typeof blastRadiusImpactedFileSchema>;
export type BlastRadiusImpactedFolder = z.infer<typeof blastRadiusImpactedFolderSchema>;
export type BlastRadiusResponse = z.infer<typeof blastRadiusResponseSchema>;

const REASON_SORT_RANK: Readonly<Record<BlastRadiusReason, number>> = Object.freeze({
  imports_file: 0,
  calls_exported_symbol: 1,
  calls_symbol: 2,
  contains_impacted_callable: 3,
});

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortBlastRadiusReasonsCanonical(
  reasons: Iterable<BlastRadiusReason>,
): BlastRadiusReason[] {
  return [...new Set(reasons)].sort((a, b) => REASON_SORT_RANK[a] - REASON_SORT_RANK[b]);
}

export function compareBlastRadiusCallSites(
  a: BlastRadiusCallSite,
  b: BlastRadiusCallSite,
): number {
  if (a.callSiteLine !== b.callSiteLine) return a.callSiteLine - b.callSiteLine;
  return cmpStr(a.viaNodeId, b.viaNodeId);
}

export function compareBlastRadiusImpactedNodes(
  a: Pick<
    BlastRadiusImpactedNode,
    'hop' | 'isHub' | 'inDegreeDistinct' | 'filePath' | 'qualifiedName' | 'id'
  >,
  b: Pick<
    BlastRadiusImpactedNode,
    'hop' | 'isHub' | 'inDegreeDistinct' | 'filePath' | 'qualifiedName' | 'id'
  >,
): number {
  if (a.hop !== b.hop) return a.hop - b.hop;
  if (a.isHub !== b.isHub) return a.isHub ? -1 : 1;
  if (a.inDegreeDistinct !== b.inDegreeDistinct) return b.inDegreeDistinct - a.inDegreeDistinct;
  const pathDiff = cmpStr(a.filePath, b.filePath);
  if (pathDiff !== 0) return pathDiff;
  const qnDiff = cmpStr(a.qualifiedName, b.qualifiedName);
  if (qnDiff !== 0) return qnDiff;
  return cmpStr(a.id, b.id);
}

export function compareBlastRadiusImpactedFiles(
  a: Pick<
    BlastRadiusImpactedFile,
    'minHop' | 'isFileRollupHub' | 'dependentFileCount' | 'filePath' | 'fileNodeId'
  >,
  b: Pick<
    BlastRadiusImpactedFile,
    'minHop' | 'isFileRollupHub' | 'dependentFileCount' | 'filePath' | 'fileNodeId'
  >,
): number {
  if (a.minHop !== b.minHop) return a.minHop - b.minHop;
  if (a.isFileRollupHub !== b.isFileRollupHub) return a.isFileRollupHub ? -1 : 1;
  if (a.dependentFileCount !== b.dependentFileCount) {
    return b.dependentFileCount - a.dependentFileCount;
  }
  const pathDiff = cmpStr(a.filePath, b.filePath);
  if (pathDiff !== 0) return pathDiff;
  return cmpStr(a.fileNodeId, b.fileNodeId);
}

export function compareBlastRadiusImpactedFolders(
  a: Pick<
    BlastRadiusImpactedFolder,
    'minHop' | 'impactedFileCount' | 'folderPath' | 'folderNodeId'
  >,
  b: Pick<
    BlastRadiusImpactedFolder,
    'minHop' | 'impactedFileCount' | 'folderPath' | 'folderNodeId'
  >,
): number {
  if (a.minHop !== b.minHop) return a.minHop - b.minHop;
  if (a.impactedFileCount !== b.impactedFileCount) {
    return b.impactedFileCount - a.impactedFileCount;
  }
  const pathDiff = cmpStr(a.folderPath, b.folderPath);
  if (pathDiff !== 0) return pathDiff;
  return cmpStr(a.folderNodeId, b.folderNodeId);
}

export function isCallableOrSymbolNodeType(nodeType: NodeType): boolean {
  return nodeType === 'function' || nodeType === 'class' || nodeType === 'symbol';
}
