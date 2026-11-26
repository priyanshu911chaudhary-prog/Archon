import { z } from 'zod';

/** Lightweight engine identity (runtime value: `'archon-core'`). */
export const CORE_ENGINE_ID = 'archon-core' as const;

export const NODE_TYPES = ['folder', 'file', 'function', 'class', 'symbol'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = ['IMPORTS', 'CALLS'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const ANALYSIS_WARNING_CODES = [
  'SYNTAX_ERROR',
  'UNREADABLE_FILE',
  'UNSAFE_SYMLINK_SKIPPED',
  'OVERSIZED_FILE_SKIPPED',
  'INVALID_TSCONFIG',
  'TSCONFIG_TRAVERSAL_IGNORED',
  'TSCONFIG_CIRCULAR_EXTENDS',
  'TSCONFIG_EXTENDS_DEPTH_EXCEEDED',
  'CONFIG_LIMIT_EXCEEDED',
] as const;
export type AnalysisWarningCode = (typeof ANALYSIS_WARNING_CODES)[number];

export const CORE_ANALYSIS_ERROR_CODES = [
  'INVALID_WORKSPACE',
  'PATH_TRAVERSAL_REJECTED',
  'FILE_LIMIT_EXCEEDED',
  'SIZE_LIMIT_EXCEEDED',
] as const;
export type CoreAnalysisErrorCode = (typeof CORE_ANALYSIS_ERROR_CODES)[number];

export const DEFAULT_MAX_SUPPORTED_FILES = 500;
export const DEFAULT_MAX_CONFIG_FILES = 50;
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MiB
export const DEFAULT_MAX_FILE_SNIPPET_CHARS = 8192;
export const DEFAULT_MAX_SYMBOL_SNIPPET_CHARS = 4096;
export const DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS = 512;
export const DEFAULT_MAX_WARNINGS = 200;
export const DEFAULT_MAX_EXTENDS_DEPTH = 10;
export const MAX_WARNING_MESSAGE_CHARS = 300;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const nonNegativeSafeIntSchema = z
  .number()
  .int()
  .min(0)
  .refine(Number.isSafeInteger, 'Must be a safe integer.');

const positiveSafeIntSchema = z
  .number()
  .int()
  .min(1)
  .refine(Number.isSafeInteger, 'Must be a safe integer.');

export const nodeTypeSchema = z.enum(NODE_TYPES);
export const edgeTypeSchema = z.enum(EDGE_TYPES);
export const analysisWarningCodeSchema = z.enum(ANALYSIS_WARNING_CODES);
export const coreAnalysisErrorCodeSchema = z.enum(CORE_ANALYSIS_ERROR_CODES);

export const extractedNodeSchema = z
  .object({
    nodeType: nodeTypeSchema,
    name: z.string().min(1),
    qualifiedName: z.string().min(1),
    filePath: z.string().min(1),
    parentQualifiedName: z.string().min(1).nullable(),
    isExported: z.boolean(),
    startLine: positiveSafeIntSchema.nullable(),
    endLine: positiveSafeIntSchema.nullable(),
    contentHash: z
      .string()
      .regex(SHA256_HEX_RE, 'Expected lowercase 64-char SHA-256 hex.')
      .nullable(),
    snippet: z.string().nullable(),
  })
  .strict();

export const extractedEdgeSchema = z
  .object({
    sourceQualifiedName: z.string().min(1),
    targetQualifiedName: z.string().min(1),
    edgeType: edgeTypeSchema,
    callSiteLine: positiveSafeIntSchema.nullable(),
    callSiteSnippet: z.string().nullable(),
  })
  .strict();

export const analysisWarningSchema = z
  .object({
    code: analysisWarningCodeSchema,
    filePath: z.string().min(1),
    message: z.string().min(1).max(MAX_WARNING_MESSAGE_CHARS),
    line: positiveSafeIntSchema.optional(),
  })
  .strict();

export const analysisStatsSchema = z
  .object({
    discoveredFilesCount: nonNegativeSafeIntSchema,
    parsedFilesCount: nonNegativeSafeIntSchema,
    skippedSyntaxErrorFilesCount: nonNegativeSafeIntSchema,
    skippedOversizedFilesCount: nonNegativeSafeIntSchema,
    configFilesCount: nonNegativeSafeIntSchema,
    folderNodeCount: nonNegativeSafeIntSchema,
    fileNodeCount: nonNegativeSafeIntSchema,
    functionNodeCount: nonNegativeSafeIntSchema,
    classNodeCount: nonNegativeSafeIntSchema,
    symbolNodeCount: nonNegativeSafeIntSchema,
    importsEdgeCount: nonNegativeSafeIntSchema,
    callsEdgeCount: nonNegativeSafeIntSchema,
    totalBytesRead: nonNegativeSafeIntSchema,
    truncatedWarningsCount: nonNegativeSafeIntSchema,
  })
  .strict();

export const analysisOutputSchema = z
  .object({
    nodes: z.array(extractedNodeSchema),
    edges: z.array(extractedEdgeSchema),
    warnings: z.array(analysisWarningSchema),
    stats: analysisStatsSchema,
  })
  .strict();

export interface ExtractedNode {
  readonly nodeType: NodeType;
  readonly name: string;
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly parentQualifiedName: string | null;
  readonly isExported: boolean;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly contentHash: string | null;
  readonly snippet: string | null;
}

export interface ExtractedEdge {
  readonly sourceQualifiedName: string;
  readonly targetQualifiedName: string;
  readonly edgeType: EdgeType;
  readonly callSiteLine: number | null;
  readonly callSiteSnippet: string | null;
}

export interface AnalysisWarning {
  readonly code: AnalysisWarningCode;
  readonly filePath: string;
  readonly message: string;
  readonly line?: number;
}

export interface AnalysisStats {
  readonly discoveredFilesCount: number;
  readonly parsedFilesCount: number;
  readonly skippedSyntaxErrorFilesCount: number;
  readonly skippedOversizedFilesCount: number;
  readonly configFilesCount: number;
  readonly folderNodeCount: number;
  readonly fileNodeCount: number;
  readonly functionNodeCount: number;
  readonly classNodeCount: number;
  readonly symbolNodeCount: number;
  readonly importsEdgeCount: number;
  readonly callsEdgeCount: number;
  readonly totalBytesRead: number;
  readonly truncatedWarningsCount: number;
}

export interface AnalysisOutput {
  readonly nodes: readonly ExtractedNode[];
  readonly edges: readonly ExtractedEdge[];
  readonly warnings: readonly AnalysisWarning[];
  readonly stats: AnalysisStats;
}

// Compile-time schema-to-interface drift guards (zero runtime overhead)
type AssertAssignable<To, From extends To> = [To, From];
type _CheckNodeSchemaToInterface = AssertAssignable<
  ExtractedNode,
  z.infer<typeof extractedNodeSchema>
>;
type _CheckNodeInterfaceToSchema = AssertAssignable<
  z.infer<typeof extractedNodeSchema>,
  ExtractedNode
>;
type _CheckEdgeSchemaToInterface = AssertAssignable<
  ExtractedEdge,
  z.infer<typeof extractedEdgeSchema>
>;
type _CheckEdgeInterfaceToSchema = AssertAssignable<
  z.infer<typeof extractedEdgeSchema>,
  ExtractedEdge
>;
type _CheckWarningSchemaToInterface = AssertAssignable<
  AnalysisWarning,
  z.infer<typeof analysisWarningSchema>
>;
type _CheckStatsSchemaToInterface = AssertAssignable<
  AnalysisStats,
  z.infer<typeof analysisStatsSchema>
>;
type _CheckStatsInterfaceToSchema = AssertAssignable<
  z.infer<typeof analysisStatsSchema>,
  AnalysisStats
>;
type _CheckOutputSchemaToInterface = AssertAssignable<
  AnalysisOutput,
  z.infer<typeof analysisOutputSchema>
>;
export type _AnalysisContractDriftChecks = readonly [
  _CheckNodeSchemaToInterface,
  _CheckNodeInterfaceToSchema,
  _CheckEdgeSchemaToInterface,
  _CheckEdgeInterfaceToSchema,
  _CheckWarningSchemaToInterface,
  _CheckStatsSchemaToInterface,
  _CheckStatsInterfaceToSchema,
  _CheckOutputSchemaToInterface,
];

export interface GraphValidationLimits {
  readonly maxFileSnippetChars?: number;
  readonly maxSymbolSnippetChars?: number;
  readonly maxCallSiteSnippetChars?: number;
  readonly maxWarnings?: number;
}

export interface GraphValidationResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

/**
 * Performs single-pass semantic graph-integrity validation on an `AnalysisOutput`
 * without cloning or re-parsing nodes/edges. Preserves empty graphs, empty snippets,
 * zero counts, escaped qualified names, and legitimate recursive `CALLS` self-edges.
 */
export function validateAnalysisGraph(
  output: AnalysisOutput,
  limits: GraphValidationLimits = {},
): GraphValidationResult {
  const maxFileSnippetChars = limits.maxFileSnippetChars ?? DEFAULT_MAX_FILE_SNIPPET_CHARS;
  const maxSymbolSnippetChars = limits.maxSymbolSnippetChars ?? DEFAULT_MAX_SYMBOL_SNIPPET_CHARS;
  const maxCallSiteSnippetChars =
    limits.maxCallSiteSnippetChars ?? DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS;
  const maxWarnings = limits.maxWarnings ?? DEFAULT_MAX_WARNINGS;

  const violations: string[] = [];
  const nodeMap = new Map<string, ExtractedNode>();

  let folderNodeCount = 0;
  let fileNodeCount = 0;
  let functionNodeCount = 0;
  let classNodeCount = 0;
  let symbolNodeCount = 0;

  for (const node of output.nodes) {
    if (nodeMap.has(node.qualifiedName)) {
      violations.push(`Duplicate node qualifiedName: "${node.qualifiedName}".`);
    } else {
      nodeMap.set(node.qualifiedName, node);
    }

    if (node.nodeType === 'folder') {
      folderNodeCount += 1;
      if (node.isExported) {
        violations.push(`Folder node "${node.qualifiedName}" must not be exported.`);
      }
      if (
        node.startLine !== null ||
        node.endLine !== null ||
        node.contentHash !== null ||
        node.snippet !== null
      ) {
        violations.push(
          `Folder node "${node.qualifiedName}" must have null startLine, endLine, contentHash, and snippet.`,
        );
      }
    } else {
      switch (node.nodeType) {
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

      if (
        node.startLine === null ||
        !Number.isSafeInteger(node.startLine) ||
        node.startLine < 1 ||
        node.endLine === null ||
        !Number.isSafeInteger(node.endLine) ||
        node.endLine < node.startLine
      ) {
        violations.push(
          `Node "${node.qualifiedName}" has invalid line range (${String(node.startLine)}..${String(node.endLine)}).`,
        );
      }

      if (node.contentHash === null || !SHA256_HEX_RE.test(node.contentHash)) {
        violations.push(`Node "${node.qualifiedName}" has missing or invalid SHA-256 contentHash.`);
      }

      if (node.snippet === null) {
        violations.push(`Node "${node.qualifiedName}" has null snippet.`);
      } else {
        if (node.snippet.includes('\r')) {
          violations.push(`Node "${node.qualifiedName}" snippet contains unnormalized CR.`);
        }
        const snippetCap = node.nodeType === 'file' ? maxFileSnippetChars : maxSymbolSnippetChars;
        if (node.snippet.length > snippetCap) {
          violations.push(
            `Node "${node.qualifiedName}" snippet length (${String(node.snippet.length)}) exceeds cap (${String(snippetCap)}).`,
          );
        }
      }
    }
  }

  for (const node of output.nodes) {
    if (node.parentQualifiedName !== null) {
      if (node.parentQualifiedName === node.qualifiedName) {
        violations.push(`Node "${node.qualifiedName}" cannot reference itself as parent.`);
      } else if (!nodeMap.has(node.parentQualifiedName)) {
        violations.push(
          `Missing parentQualifiedName "${node.parentQualifiedName}" referenced by "${node.qualifiedName}".`,
        );
      }
    }
  }

  const seenImportKeys = new Set<string>();
  const seenCallKeys = new Set<string>();
  let importsEdgeCount = 0;
  let callsEdgeCount = 0;

  for (const edge of output.edges) {
    if (!nodeMap.has(edge.sourceQualifiedName)) {
      violations.push(
        `Missing source endpoint "${edge.sourceQualifiedName}" on ${edge.edgeType} edge to "${edge.targetQualifiedName}".`,
      );
    }
    if (!nodeMap.has(edge.targetQualifiedName)) {
      violations.push(
        `Missing target endpoint "${edge.targetQualifiedName}" on ${edge.edgeType} edge from "${edge.sourceQualifiedName}".`,
      );
    }

    if (edge.edgeType === 'IMPORTS') {
      importsEdgeCount += 1;
      if (edge.sourceQualifiedName === edge.targetQualifiedName) {
        violations.push(`Self-import edge emitted for "${edge.sourceQualifiedName}".`);
      }
      if (edge.callSiteLine !== null || edge.callSiteSnippet !== null) {
        violations.push(
          `IMPORTS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" must have null callSiteLine and callSiteSnippet.`,
        );
      }
      const key = JSON.stringify([edge.sourceQualifiedName, edge.targetQualifiedName, 'IMPORTS']);
      if (seenImportKeys.has(key)) {
        violations.push(
          `Duplicate IMPORTS edge: "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}".`,
        );
      } else {
        seenImportKeys.add(key);
      }
    } else {
      callsEdgeCount += 1;
      if (
        edge.callSiteLine === null ||
        !Number.isSafeInteger(edge.callSiteLine) ||
        edge.callSiteLine < 1
      ) {
        violations.push(
          `CALLS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" has invalid callSiteLine (${String(edge.callSiteLine)}).`,
        );
      } else {
        const key = JSON.stringify([
          edge.sourceQualifiedName,
          edge.targetQualifiedName,
          'CALLS',
          edge.callSiteLine,
        ]);
        if (seenCallKeys.has(key)) {
          violations.push(
            `Duplicate CALLS edge: "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName} @L${String(edge.callSiteLine)}".`,
          );
        } else {
          seenCallKeys.add(key);
        }
      }

      if (edge.callSiteSnippet === null) {
        violations.push(
          `CALLS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" has null callSiteSnippet.`,
        );
      } else {
        if (edge.callSiteSnippet.includes('\r')) {
          violations.push(
            `CALLS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" snippet contains unnormalized CR.`,
          );
        }
        if (edge.callSiteSnippet.length > maxCallSiteSnippetChars) {
          violations.push(
            `CALLS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" snippet length (${String(edge.callSiteSnippet.length)}) exceeds cap (${String(maxCallSiteSnippetChars)}).`,
          );
        }
      }
    }
  }

  if (output.warnings.length > maxWarnings) {
    violations.push(
      `Warnings count (${String(output.warnings.length)}) exceeds maxWarnings (${String(maxWarnings)}).`,
    );
  }
  for (const warning of output.warnings) {
    if (warning.message.length > MAX_WARNING_MESSAGE_CHARS) {
      violations.push(
        `Warning message for "${warning.filePath}" exceeds ${String(MAX_WARNING_MESSAGE_CHARS)} characters.`,
      );
    }
    if (warning.line !== undefined && (!Number.isSafeInteger(warning.line) || warning.line < 1)) {
      violations.push(
        `Warning for "${warning.filePath}" has invalid line (${String(warning.line)}).`,
      );
    }
  }

  const statChecks: readonly [string, number, number][] = [
    ['folderNodeCount', output.stats.folderNodeCount, folderNodeCount],
    ['fileNodeCount', output.stats.fileNodeCount, fileNodeCount],
    ['functionNodeCount', output.stats.functionNodeCount, functionNodeCount],
    ['classNodeCount', output.stats.classNodeCount, classNodeCount],
    ['symbolNodeCount', output.stats.symbolNodeCount, symbolNodeCount],
    ['importsEdgeCount', output.stats.importsEdgeCount, importsEdgeCount],
    ['callsEdgeCount', output.stats.callsEdgeCount, callsEdgeCount],
    ['parsedFilesCount', output.stats.parsedFilesCount, fileNodeCount],
  ];
  for (const [field, reported, actual] of statChecks) {
    if (reported !== actual) {
      violations.push(
        `AnalysisStats.${field} (${String(reported)}) does not match emitted count (${String(actual)}).`,
      );
    }
  }

  if (
    output.stats.parsedFilesCount + output.stats.skippedSyntaxErrorFilesCount !==
    output.stats.discoveredFilesCount
  ) {
    violations.push(
      `AnalysisStats.parsedFilesCount (${String(output.stats.parsedFilesCount)}) + skippedSyntaxErrorFilesCount (${String(output.stats.skippedSyntaxErrorFilesCount)}) !== discoveredFilesCount (${String(output.stats.discoveredFilesCount)}).`,
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
