import type { ParserIpcAnalysisInput } from '@archon/shared';

export {
  ANALYSIS_WARNING_CODES,
  CORE_ANALYSIS_ERROR_CODES,
  DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
  DEFAULT_MAX_CONFIG_FILES,
  DEFAULT_MAX_EXTENDS_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILE_SNIPPET_CHARS,
  DEFAULT_MAX_SUPPORTED_FILES,
  DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_WARNINGS,
  EDGE_TYPES,
  MAX_WARNING_MESSAGE_CHARS,
  NODE_TYPES,
  type AnalysisOutput,
  type AnalysisStats,
  type AnalysisWarning,
  type AnalysisWarningCode,
  type CoreAnalysisErrorCode,
  type EdgeType,
  type ExtractedEdge,
  type ExtractedNode,
  type NodeType,
} from '@archon/shared';

export interface AnalysisInput {
  readonly rootDir: string;
  readonly supportedFiles?: readonly string[];
  readonly configFiles?: readonly string[];
  readonly maxSupportedFiles?: number;
  readonly maxConfigFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileSnippetChars?: number;
  readonly maxSymbolSnippetChars?: number;
  /** Default 512 chars for CALLS call-site context snippets. */
  readonly maxCallSiteSnippetChars?: number;
  readonly maxWarnings?: number;
  readonly maxExtendsDepth?: number;
  /** Default false: load bundled TypeScript lib declarations for accurate type resolution. */
  readonly skipLoadingLibFiles?: boolean;
}

// Compile-time check: shared IPC input must always remain structurally assignable to AnalysisInput
type AssertAssignable<To, From extends To> = [To, From];
export type _CheckIpcInputCompatibleWithAnalysisInput = AssertAssignable<
  AnalysisInput,
  ParserIpcAnalysisInput
>;
