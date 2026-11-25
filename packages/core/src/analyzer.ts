import { discoverWorkspaceFiles, truncateWarningMessage } from './discovery.js';
import { extractImportEdges } from './imports-extractor.js';
import { extractNodesFromFiles } from './node-extractor.js';
import { createAnalysisProject } from './project.js';
import { loadWorkspaceTsConfigs } from './tsconfig-loader.js';
import {
  DEFAULT_MAX_EXTENDS_DEPTH,
  DEFAULT_MAX_WARNINGS,
  type AnalysisInput,
  type AnalysisOutput,
  type AnalysisWarning,
} from './types.js';

/**
 * Pure deterministic static analysis entrypoint (Step 4.2a: nodes + IMPORTS edges).
 * Step 4.2b extends this pipeline with CALLS extraction on the same in-memory Project.
 */
export async function analyzeRepository(input: AnalysisInput): Promise<AnalysisOutput> {
  const maxWarnings = input.maxWarnings ?? DEFAULT_MAX_WARNINGS;

  const discovered = await discoverWorkspaceFiles({
    rootDir: input.rootDir,
    supportedFiles: input.supportedFiles,
    configFiles: input.configFiles,
    maxSupportedFiles: input.maxSupportedFiles,
    maxConfigFiles: input.maxConfigFiles,
    maxFileBytes: input.maxFileBytes,
    maxTotalBytes: input.maxTotalBytes,
    maxWarnings,
  });

  const tsConfigs = loadWorkspaceTsConfigs(discovered.configFiles, {
    maxExtendsDepth: input.maxExtendsDepth ?? DEFAULT_MAX_EXTENDS_DEPTH,
  });

  const projectContext = createAnalysisProject({
    sourceFiles: discovered.sourceFiles,
    configsByDir: tsConfigs.configsByDir,
    skipLoadingLibFiles: input.skipLoadingLibFiles ?? false,
  });

  const nodes = extractNodesFromFiles({
    parsedFiles: projectContext.parsedFiles,
    maxFileSnippetChars: input.maxFileSnippetChars,
    maxSymbolSnippetChars: input.maxSymbolSnippetChars,
  });

  const edges = extractImportEdges({
    parsedFiles: projectContext.parsedFiles,
    resolver: projectContext.resolver,
  });

  // Merge and cap warnings deterministically
  const combinedWarnings: AnalysisWarning[] = [...discovered.warnings];
  let truncatedWarningsCount = discovered.truncatedWarningsCount;

  for (const warning of [...tsConfigs.warnings, ...projectContext.syntaxWarnings]) {
    if (combinedWarnings.length < maxWarnings) {
      combinedWarnings.push({
        ...warning,
        message: truncateWarningMessage(warning.message),
      });
    } else {
      truncatedWarningsCount += 1;
    }
  }

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

  return {
    nodes,
    edges,
    warnings: combinedWarnings,
    stats: {
      discoveredFilesCount: discovered.sourceFiles.length,
      parsedFilesCount: projectContext.parsedFiles.length,
      skippedSyntaxErrorFilesCount: projectContext.skippedSyntaxErrorFilesCount,
      skippedOversizedFilesCount: discovered.skippedOversizedFilesCount,
      configFilesCount: discovered.configFiles.length,
      folderNodeCount,
      fileNodeCount,
      functionNodeCount,
      classNodeCount,
      symbolNodeCount,
      importsEdgeCount: edges.length,
      callsEdgeCount: 0,
      totalBytesRead: discovered.totalBytesRead,
      truncatedWarningsCount,
    },
  };
}
