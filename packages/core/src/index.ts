export { CORE_ENGINE_ID } from '@archon/shared';

export { analyzeRepository } from './analyzer.js';

export {
  discoverWorkspaceFiles,
  validateRepoRelativePath,
  type DiscoverWorkspaceOptions,
  type DiscoveredWorkspace,
  type LoadedWorkspaceFile,
} from './discovery.js';

export {
  CoreAnalysisError,
  type CoreAnalysisErrorCode,
  type CoreAnalysisErrorOptions,
} from './errors.js';

export { extractImportEdges, type ExtractImportsOptions } from './imports-extractor.js';

export {
  createWorkspaceModuleResolver,
  type CreateWorkspaceModuleResolverOptions,
  type ModuleResolutionMode,
  type WorkspaceModuleResolver,
} from './module-resolver.js';

export { extractNodesFromFiles, type ExtractNodesOptions } from './node-extractor.js';

export {
  createAnalysisProject,
  type AnalysisProjectContext,
  type AnalysisSourceFileEntry,
  type CreateAnalysisProjectOptions,
} from './project.js';

export {
  QualifiedNameRegistry,
  buildAccessorQualifiedName,
  buildClassQualifiedName,
  buildConstructorQualifiedName,
  buildDefaultExportQualifiedName,
  buildFileQualifiedName,
  buildFolderQualifiedName,
  buildFunctionQualifiedName,
  buildMethodQualifiedName,
  buildSymbolQualifiedName,
  escapeQualifiedSegment,
  type SourceLocation,
} from './qualified-name.js';

export {
  VIRTUAL_REPO_ROOT,
  findNearestTsConfig,
  fromVirtualRepoPath,
  loadWorkspaceTsConfigs,
  resolveContainedVirtualPath,
  toVirtualRepoPath,
  type LoadedTsConfigsResult,
  type ResolvedTsConfig,
} from './tsconfig-loader.js';

export {
  DEFAULT_MAX_CONFIG_FILES,
  DEFAULT_MAX_EXTENDS_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILE_SNIPPET_CHARS,
  DEFAULT_MAX_SUPPORTED_FILES,
  DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
  DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_WARNINGS,
  EDGE_TYPES,
  MAX_WARNING_MESSAGE_CHARS,
  NODE_TYPES,
  type AnalysisInput,
  type AnalysisOutput,
  type AnalysisStats,
  type AnalysisWarning,
  type AnalysisWarningCode,
  type EdgeType,
  type ExtractedEdge,
  type ExtractedNode,
  type NodeType,
} from './types.js';
