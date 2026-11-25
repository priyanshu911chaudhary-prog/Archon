import { posix as posixPath } from 'node:path';
import { Project, type SourceFile, ts } from 'ts-morph';
import { truncateWarningMessage, type LoadedWorkspaceFile } from './discovery.js';
import { createWorkspaceModuleResolver, type WorkspaceModuleResolver } from './module-resolver.js';
import { VIRTUAL_REPO_ROOT, toVirtualRepoPath, type ResolvedTsConfig } from './tsconfig-loader.js';
import type { AnalysisWarning } from './types.js';

export interface CreateAnalysisProjectOptions {
  readonly sourceFiles: readonly LoadedWorkspaceFile[];
  /** Nearest applicable tsconfig/jsconfig per repo-relative POSIX directory. */
  readonly configsByDir?: ReadonlyMap<string, ResolvedTsConfig>;
  /**
   * Defaults to false so bundled TypeScript libs stay enabled until benchmarked
   * against `skipLoadingLibFiles: true` in Step 4.2b/4.3.
   */
  readonly skipLoadingLibFiles?: boolean;
}

export interface AnalysisSourceFileEntry {
  readonly relativePath: string;
  readonly virtualPath: string;
  readonly sourceText: string;
  readonly sourceFile: SourceFile;
}

export interface AnalysisProjectContext {
  readonly project: Project;
  readonly resolver: WorkspaceModuleResolver;
  readonly parsedFiles: readonly AnalysisSourceFileEntry[];
  readonly parsedVirtualPaths: ReadonlySet<string>;
  readonly syntaxWarnings: readonly AnalysisWarning[];
  readonly skippedSyntaxErrorFilesCount: number;
}

interface SyntaxPrefilterFile {
  readonly file: LoadedWorkspaceFile;
  readonly virtualPath: string;
}

interface SyntaxPrefilterResult {
  readonly validFiles: readonly SyntaxPrefilterFile[];
  readonly syntaxWarnings: readonly AnalysisWarning[];
  readonly skippedSyntaxErrorFilesCount: number;
}

function normalizeVirtualPath(filePath: string): string {
  return posixPath.normalize(filePath.replace(/\\/g, '/'));
}

function computeOneIndexedLine(sourceText: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, sourceText.length));
  let line = 1;
  for (let i = 0; i < clamped; i += 1) {
    if (sourceText.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

/**
 * Lightweight syntactic pre-filter using a restricted, in-memory `ts.CompilerHost`
 * (`noLib: true`, `noResolve: true`, `types: []`) so syntax-invalid files are excluded
 * BEFORE constructing the authoritative `WorkspaceModuleResolver` and persistent `ts-morph` Project.
 * Keeping the temporary program inside this helper allows it to become eligible for GC
 * before the main Project is created.
 */
function filterSyntaxCleanFiles(
  sourceFiles: readonly LoadedWorkspaceFile[],
): SyntaxPrefilterResult {
  const items: {
    readonly file: LoadedWorkspaceFile;
    readonly virtualPath: string;
    readonly sourceFile: ts.SourceFile;
  }[] = [];

  const sfByVirtualPath = new Map<string, ts.SourceFile>();
  const contentByVirtualPath = new Map<string, string>();

  for (const file of sourceFiles) {
    const virtualPath = toVirtualRepoPath(file.relativePath);
    // Let bundled TypeScript infer ScriptKind cleanly from the file extension (.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts)
    const sf = ts.createSourceFile(virtualPath, file.content, ts.ScriptTarget.ESNext, true);
    items.push({ file, virtualPath, sourceFile: sf });
    sfByVirtualPath.set(virtualPath, sf);
    contentByVirtualPath.set(virtualPath, file.content);
  }

  const preHost: ts.CompilerHost = {
    getSourceFile: (fileName: string): ts.SourceFile | undefined =>
      sfByVirtualPath.get(normalizeVirtualPath(fileName)),
    writeFile: (): void => {
      // Read-only in-memory pre-filter host
    },
    getCurrentDirectory: (): string => VIRTUAL_REPO_ROOT,
    getDirectories: (): string[] => [],
    fileExists: (fileName: string): boolean => sfByVirtualPath.has(normalizeVirtualPath(fileName)),
    readFile: (fileName: string): string | undefined =>
      contentByVirtualPath.get(normalizeVirtualPath(fileName)),
    getCanonicalFileName: (fileName: string): string => normalizeVirtualPath(fileName),
    useCaseSensitiveFileNames: (): boolean => true,
    getNewLine: (): string => '\n',
    getDefaultLibFileName: (): string => `${VIRTUAL_REPO_ROOT}/__archon_nolib__.d.ts`,
  };

  const preProgram = ts.createProgram(
    items.map((item) => item.virtualPath),
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      noLib: true,
      noResolve: true,
      types: [],
    },
    preHost,
  );

  const validFiles: SyntaxPrefilterFile[] = [];
  const syntaxWarnings: AnalysisWarning[] = [];
  let skippedSyntaxErrorFilesCount = 0;

  for (const item of items) {
    const programSf = preProgram.getSourceFile(item.virtualPath);
    // Explicitly verify we are inspecting syntactic diagnostics for the exact intended source file
    if (programSf === undefined || programSf !== item.sourceFile) {
      skippedSyntaxErrorFilesCount += 1;
      syntaxWarnings.push({
        code: 'SYNTAX_ERROR',
        filePath: item.file.relativePath,
        message: truncateWarningMessage(
          `Skipped "${item.file.relativePath}" because it could not be loaded for syntactic verification.`,
        ),
      });
      continue;
    }

    const syntacticDiagnostics = preProgram.getSyntacticDiagnostics(programSf);
    const firstError = syntacticDiagnostics.find(
      (diag) => diag.category === ts.DiagnosticCategory.Error,
    );

    if (firstError !== undefined) {
      skippedSyntaxErrorFilesCount += 1;
      const line = computeOneIndexedLine(item.file.content, firstError.start);
      const rawMessage = ts.flattenDiagnosticMessageText(firstError.messageText, ' ');
      syntaxWarnings.push({
        code: 'SYNTAX_ERROR',
        filePath: item.file.relativePath,
        line,
        message: truncateWarningMessage(
          `Skipped "${item.file.relativePath}" due to syntax error at line ${line}: ${rawMessage}`,
        ),
      });
      continue;
    }

    validFiles.push({
      file: item.file,
      virtualPath: item.virtualPath,
    });
  }

  return {
    validFiles,
    syntaxWarnings,
    skippedSyntaxErrorFilesCount,
  };
}

/**
 * Builds an isolated, single in-memory `ts-morph` Project populated exclusively with
 * syntax-clean validated workspace files under `/repo/...`, sharing a single
 * `WorkspaceModuleResolver` between `resolutionHost.resolveModuleNames` and `extractImportEdges`.
 */
export function createAnalysisProject(
  options: CreateAnalysisProjectOptions,
): AnalysisProjectContext {
  const prefilter = filterSyntaxCleanFiles(options.sourceFiles);
  const parsedVirtualPaths = new Set<string>(prefilter.validFiles.map((item) => item.virtualPath));
  const configsByDir = options.configsByDir ?? new Map<string, ResolvedTsConfig>();

  const resolver = createWorkspaceModuleResolver({
    parsedVirtualPaths,
    configsByDir,
  });

  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: options.skipLoadingLibFiles ?? false,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: [],
    },
    resolutionHost: () => ({
      resolveModuleNames: (moduleNames, containingFile) =>
        resolver.resolveModuleNames(moduleNames, containingFile),
      resolveTypeReferenceDirectives: (typeDirectiveNames) =>
        Array.from({ length: typeDirectiveNames.length }, () => undefined),
    }),
  });

  const parsedFiles: AnalysisSourceFileEntry[] = [];
  for (const item of prefilter.validFiles) {
    const sourceFile = project.createSourceFile(item.virtualPath, item.file.content);
    parsedFiles.push({
      relativePath: item.file.relativePath,
      virtualPath: item.virtualPath,
      sourceText: item.file.content,
      sourceFile,
    });
  }

  return {
    project,
    resolver,
    parsedFiles,
    parsedVirtualPaths: resolver.parsedVirtualPaths,
    syntaxWarnings: prefilter.syntaxWarnings,
    skippedSyntaxErrorFilesCount: prefilter.skippedSyntaxErrorFilesCount,
  };
}
