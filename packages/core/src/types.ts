export const NODE_TYPES = ['folder', 'file', 'function', 'class', 'symbol'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = ['IMPORTS', 'CALLS'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export type AnalysisWarningCode =
  | 'SYNTAX_ERROR'
  | 'UNREADABLE_FILE'
  | 'UNSAFE_SYMLINK_SKIPPED'
  | 'OVERSIZED_FILE_SKIPPED'
  | 'INVALID_TSCONFIG'
  | 'TSCONFIG_TRAVERSAL_IGNORED'
  | 'TSCONFIG_CIRCULAR_EXTENDS'
  | 'TSCONFIG_EXTENDS_DEPTH_EXCEEDED'
  | 'CONFIG_LIMIT_EXCEEDED';

export interface AnalysisWarning {
  readonly code: AnalysisWarningCode;
  readonly filePath: string;
  readonly message: string;
  readonly line?: number;
}

export interface ExtractedNode {
  readonly nodeType: NodeType;
  readonly name: string;
  readonly qualifiedName: string;
  /** Repository-relative POSIX path (file path, or folder path for folder nodes). */
  readonly filePath: string;
  readonly parentQualifiedName: string | null;
  readonly isExported: boolean;
  /** 1-indexed start line in original source text (null for folder nodes). */
  readonly startLine: number | null;
  /** 1-indexed end line in original source text (null for folder nodes). */
  readonly endLine: number | null;
  /** SHA-256 hex digest of LF-normalized source text (null for folder nodes). */
  readonly contentHash: string | null;
  /** Bounded source snippet (null for folder nodes). */
  readonly snippet: string | null;
}

export interface ExtractedEdge {
  readonly sourceQualifiedName: string;
  readonly targetQualifiedName: string;
  readonly edgeType: EdgeType;
  /** 1-indexed call site line for CALLS edges; null for file-level IMPORTS edges. */
  readonly callSiteLine: number | null;
  /** Bounded call site window for CALLS edges; null for IMPORTS edges. */
  readonly callSiteSnippet: string | null;
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

export interface AnalysisInput {
  readonly rootDir: string;
  /** Optional pre-validated list of repo-relative supported TS/JS file paths. */
  readonly supportedFiles?: readonly string[];
  /** Optional pre-validated list of repo-relative config file paths (tsconfig/jsconfig/package.json). */
  readonly configFiles?: readonly string[];
  /** Default 500 (aligned with MAX_SUPPORTED_FILES). */
  readonly maxSupportedFiles?: number;
  /** Default 50 (aligned with extractor config cap). */
  readonly maxConfigFiles?: number;
  /** Default 1 MiB per file (aligned with extractor per-file cap). */
  readonly maxFileBytes?: number;
  /** Default 50 MiB total actual bytes read (aligned with MAX_REPO_SIZE_MB). */
  readonly maxTotalBytes?: number;
  /** Default 8,192 chars for file snippets. */
  readonly maxFileSnippetChars?: number;
  /** Default 4,096 chars for function/class/symbol snippets. */
  readonly maxSymbolSnippetChars?: number;
  /** Default 200 bounded warnings retained in output. */
  readonly maxWarnings?: number;
  /** Default 10 max tsconfig extends chain depth. */
  readonly maxExtendsDepth?: number;
  /**
   * Controls whether ts-morph skips loading bundled TypeScript lib files.
   * Defaults to false so default libs stay enabled pending the Step 4.2b/4.3 RSS benchmark.
   */
  readonly skipLoadingLibFiles?: boolean;
}

export interface AnalysisOutput {
  readonly nodes: readonly ExtractedNode[];
  readonly edges: readonly ExtractedEdge[];
  readonly warnings: readonly AnalysisWarning[];
  readonly stats: AnalysisStats;
}

export const DEFAULT_MAX_SUPPORTED_FILES = 500;
export const DEFAULT_MAX_CONFIG_FILES = 50;
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MiB
export const DEFAULT_MAX_FILE_SNIPPET_CHARS = 8192;
export const DEFAULT_MAX_SYMBOL_SNIPPET_CHARS = 4096;
export const DEFAULT_MAX_WARNINGS = 200;
export const DEFAULT_MAX_EXTENDS_DEPTH = 10;
export const MAX_WARNING_MESSAGE_CHARS = 300;
