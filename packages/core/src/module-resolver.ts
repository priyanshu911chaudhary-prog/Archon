import { posix as posixPath } from 'node:path';
import { ts } from 'ts-morph';
import { compareCodePoint } from './discovery.js';
import {
  VIRTUAL_REPO_ROOT,
  findNearestTsConfig,
  fromVirtualRepoPath,
  type ResolvedTsConfig,
} from './tsconfig-loader.js';

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;
const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type ModuleResolutionMode = Parameters<typeof ts.resolveModuleName>[6];

export interface CreateWorkspaceModuleResolverOptions {
  /** Authoritative set of syntax-clean virtual `/repo/...` source file paths. */
  readonly parsedVirtualPaths: ReadonlySet<string>;
  /** Nearest applicable tsconfig/jsconfig per repo-relative POSIX directory. */
  readonly configsByDir: ReadonlyMap<string, ResolvedTsConfig>;
}

export interface WorkspaceModuleResolver {
  readonly parsedVirtualPaths: ReadonlySet<string>;
  /**
   * Resolves a module specifier natively via bundled `ts.resolveModuleName` and returns
   * the full `ts.ResolvedModuleFull` metadata when contained inside the authoritative
   * syntax-clean `/repo/...` file set, or `undefined` otherwise.
   */
  resolveModuleFull(
    specifier: string,
    containingVirtualFile: string,
    resolutionMode?: ModuleResolutionMode,
  ): ts.ResolvedModuleFull | undefined;
  /**
   * Convenience wrapper returning the normalized virtual `/repo/...` path or `null`.
   */
  resolveModulePath(
    specifier: string,
    containingVirtualFile: string,
    resolutionMode?: ModuleResolutionMode,
  ): string | null;
  /**
   * Batch resolution helper matching `ts.LanguageServiceHost['resolveModuleNames']`
   * for direct delegation from `ts-morph`'s `resolutionHost` hook.
   */
  resolveModuleNames(
    moduleNames: readonly string[],
    containingVirtualFile: string,
    resolutionMode?: ModuleResolutionMode,
  ): (ts.ResolvedModuleFull | undefined)[];
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function normalizeVirtualPath(filePath: string): string {
  return posixPath.normalize(filePath.replace(/\\/g, '/'));
}

function isInsideVirtualRepo(normalizedVirtualPath: string): boolean {
  return (
    normalizedVirtualPath === VIRTUAL_REPO_ROOT ||
    normalizedVirtualPath.startsWith(`${VIRTUAL_REPO_ROOT}/`)
  );
}

/**
 * Builds a restricted in-memory `ts.ModuleResolutionHost` that exposes ONLY validated,
 * syntax-clean virtual files under `/repo/...` with zero host filesystem access.
 */
function buildRestrictedResolutionHost(
  parsedVirtualPaths: ReadonlySet<string>,
): ts.ModuleResolutionHost {
  const virtualDirs = new Set<string>([VIRTUAL_REPO_ROOT]);
  const childDirsByParent = new Map<string, Set<string>>();

  for (const vPath of parsedVirtualPaths) {
    let dir = posixPath.dirname(vPath);
    while (isInsideVirtualRepo(dir)) {
      virtualDirs.add(dir);
      if (dir === VIRTUAL_REPO_ROOT) {
        break;
      }
      const parent = posixPath.dirname(dir);
      const base = posixPath.basename(dir);
      const children = childDirsByParent.get(parent);
      if (children !== undefined) {
        children.add(base);
      } else {
        childDirsByParent.set(parent, new Set([base]));
      }
      dir = parent;
    }
  }

  return {
    fileExists: (fileName: string): boolean => {
      const normalized = normalizeVirtualPath(fileName);
      if (!normalized.startsWith(`${VIRTUAL_REPO_ROOT}/`)) {
        return false;
      }
      return parsedVirtualPaths.has(normalized);
    },
    readFile: (): string | undefined => undefined,
    directoryExists: (directoryName: string): boolean => {
      const normalized = normalizeVirtualPath(directoryName);
      if (!isInsideVirtualRepo(normalized)) {
        return false;
      }
      return virtualDirs.has(normalized);
    },
    getCurrentDirectory: (): string => VIRTUAL_REPO_ROOT,
    getDirectories: (directoryName: string): string[] => {
      const normalized = normalizeVirtualPath(directoryName);
      if (!isInsideVirtualRepo(normalized)) {
        return [];
      }
      const children = childDirsByParent.get(normalized);
      return children !== undefined ? [...children].sort(compareCodePoint) : [];
    },
  };
}

/**
 * Converts validated readonly alias entries into mutable arrays for `ts.CompilerOptions`,
 * preserving exact declaration order and target array order while blocking prototype keys.
 */
function toMutableCompilerPaths(
  paths: Readonly<Record<string, readonly string[]>>,
): ts.MapLike<string[]> {
  const mutable: ts.MapLike<string[]> = {};
  for (const key of Object.keys(paths)) {
    if (FORBIDDEN_PATH_KEYS.has(key)) {
      continue;
    }
    const targets = paths[key];
    if (targets === undefined) {
      continue;
    }
    Object.defineProperty(mutable, key, {
      value: [...targets],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return mutable;
}

function buildResolutionCompilerOptions(
  nearestConfig: ResolvedTsConfig | undefined,
): ts.CompilerOptions {
  const compilerOptions: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolveJsonModule: false,
    noEmit: true,
    allowImportingTsExtensions: true,
    types: [],
  };

  if (nearestConfig === undefined) {
    return compilerOptions;
  }

  if (nearestConfig.paths !== undefined || nearestConfig.baseUrl !== undefined) {
    const mutablePaths: ts.MapLike<string[]> =
      nearestConfig.paths !== undefined ? toMutableCompilerPaths(nearestConfig.paths) : {};

    // TypeScript 6.0 deprecated CompilerOptions.baseUrl in favor of a catch-all "*" paths entry.
    // Appending "*": ["<baseUrl>/*"] when "*" is not explicitly declared preserves verified TS 6.0.2
    // baseUrl resolution without using the deprecated CompilerOptions.baseUrl property.
    if (
      nearestConfig.baseUrl !== undefined &&
      !Object.prototype.hasOwnProperty.call(mutablePaths, '*')
    ) {
      const cleanBase = nearestConfig.baseUrl.replace(/\/+$/, '');
      Object.defineProperty(mutablePaths, '*', {
        value: [`${cleanBase}/*`],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    compilerOptions.paths = mutablePaths;
  }

  return compilerOptions;
}

function resolveRawModuleFull(
  specifier: string,
  normalizedContainingFile: string,
  compilerOptions: ts.CompilerOptions,
  authoritativePaths: ReadonlySet<string>,
  host: ts.ModuleResolutionHost,
  resolutionMode?: ModuleResolutionMode,
): ts.ResolvedModuleFull | undefined {
  const trimmed = specifier.trim();
  if (
    trimmed.length === 0 ||
    hasControlChars(trimmed) ||
    trimmed.startsWith('node:') ||
    trimmed.startsWith('/') ||
    WINDOWS_DRIVE_RE.test(trimmed) ||
    trimmed.includes('\\')
  ) {
    return undefined;
  }

  const resolved = ts.resolveModuleName(
    trimmed,
    normalizedContainingFile,
    compilerOptions,
    host,
    undefined,
    undefined,
    resolutionMode,
  );
  const resolvedModule = resolved.resolvedModule;
  if (resolvedModule === undefined) {
    return undefined;
  }

  const normalizedTarget = normalizeVirtualPath(resolvedModule.resolvedFileName);
  if (
    !normalizedTarget.startsWith(`${VIRTUAL_REPO_ROOT}/`) ||
    !authoritativePaths.has(normalizedTarget)
  ) {
    return undefined;
  }

  return {
    ...resolvedModule,
    resolvedFileName: normalizedTarget,
    isExternalLibraryImport: false,
  };
}

function cloneFrozenPathRecord(
  source: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const cloned: Record<string, readonly string[]> = {};
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_PATH_KEYS.has(key)) {
      continue;
    }
    const targets = source[key];
    if (targets === undefined) {
      continue;
    }
    Object.defineProperty(cloned, key, {
      value: Object.freeze([...targets]),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(cloned);
}

function cloneAndFreezeConfig(config: ResolvedTsConfig): ResolvedTsConfig {
  return Object.freeze({
    configPath: config.configPath,
    configDir: config.configDir,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.pathsDeclarationDir !== undefined
      ? { pathsDeclarationDir: config.pathsDeclarationDir }
      : {}),
    ...(config.rawPaths !== undefined ? { rawPaths: cloneFrozenPathRecord(config.rawPaths) } : {}),
    ...(config.paths !== undefined ? { paths: cloneFrozenPathRecord(config.paths) } : {}),
  });
}

function cloneResolvedModule(mod: Readonly<ts.ResolvedModuleFull>): ts.ResolvedModuleFull {
  return {
    ...mod,
    ...(mod.packageId !== undefined ? { packageId: { ...mod.packageId } } : {}),
  };
}

function freezeResolvedModule(mod: ts.ResolvedModuleFull): Readonly<ts.ResolvedModuleFull> {
  const cloned = cloneResolvedModule(mod);
  if (cloned.packageId !== undefined) {
    Object.freeze(cloned.packageId);
  }
  return Object.freeze(cloned);
}

/**
 * Creates a runtime-immutable, non-recursive module resolver backed by bundled TypeScript 6.0.2's
 * `ts.resolveModuleName` and shared by both `extractImportEdges` and the in-memory `ts-morph` Project.
 */
export function createWorkspaceModuleResolver(
  options: CreateWorkspaceModuleResolverOptions,
): WorkspaceModuleResolver {
  // Snapshot and validate authoritative virtual paths privately so external mutations cannot affect resolution
  const authoritativePaths = new Set<string>();
  for (const rawPath of options.parsedVirtualPaths) {
    const normalized = normalizeVirtualPath(rawPath);
    if (
      normalized.startsWith(`${VIRTUAL_REPO_ROOT}/`) &&
      normalized.length > VIRTUAL_REPO_ROOT.length + 1
    ) {
      authoritativePaths.add(normalized);
    }
  }

  // Deep-clone and freeze config snapshots so caller mutations cannot corrupt alias resolution
  const configsByDir = new Map<string, ResolvedTsConfig>();
  for (const [dir, config] of options.configsByDir.entries()) {
    configsByDir.set(dir, cloneAndFreezeConfig(config));
  }

  const host = buildRestrictedResolutionHost(authoritativePaths);
  const defaultCompilerOptions = buildResolutionCompilerOptions(undefined);
  const compilerOptionsByConfig = new Map<string, ts.CompilerOptions>();
  const resolutionCache = new Map<string, Readonly<ts.ResolvedModuleFull> | null>();

  const getCompilerOptions = (config: ResolvedTsConfig | undefined): ts.CompilerOptions => {
    if (config === undefined) {
      return defaultCompilerOptions;
    }
    const cached = compilerOptionsByConfig.get(config.configPath);
    if (cached !== undefined) {
      return cached;
    }
    const built = buildResolutionCompilerOptions(config);
    compilerOptionsByConfig.set(config.configPath, built);
    return built;
  };

  const resolveModuleFull = (
    specifier: string,
    containingVirtualFile: string,
    resolutionMode?: ModuleResolutionMode,
  ): ts.ResolvedModuleFull | undefined => {
    const normalizedContaining = normalizeVirtualPath(containingVirtualFile);
    // Require repository module resolution to originate from an authoritative syntax-clean file
    if (!authoritativePaths.has(normalizedContaining)) {
      return undefined;
    }

    const containingRelPath = fromVirtualRepoPath(normalizedContaining);
    if (containingRelPath === null || containingRelPath.length === 0) {
      return undefined;
    }

    const nearestConfig = findNearestTsConfig(containingRelPath, configsByDir);
    const configIdentity = nearestConfig?.configPath ?? '';
    const modeIdentity = resolutionMode !== undefined ? String(resolutionMode) : '';
    const trimmedSpecifier = specifier.trim();
    const cacheKey = `${normalizedContaining}\0${configIdentity}\0${modeIdentity}\0${trimmedSpecifier}`;

    const cached = resolutionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached !== null ? cloneResolvedModule(cached) : undefined;
    }

    const compilerOptions = getCompilerOptions(nearestConfig);
    const resolved = resolveRawModuleFull(
      trimmedSpecifier,
      normalizedContaining,
      compilerOptions,
      authoritativePaths,
      host,
      resolutionMode,
    );

    if (resolved === undefined) {
      resolutionCache.set(cacheKey, null);
      return undefined;
    }

    const frozen = freezeResolvedModule(resolved);
    resolutionCache.set(cacheKey, frozen);
    return cloneResolvedModule(frozen);
  };

  const resolveModulePath = (
    specifier: string,
    containingVirtualFile: string,
    resolutionMode?: ModuleResolutionMode,
  ): string | null => {
    const resolved = resolveModuleFull(specifier, containingVirtualFile, resolutionMode);
    return resolved?.resolvedFileName ?? null;
  };

  const resolveModuleNames = (
    moduleNames: readonly string[],
    containingVirtualFile: string,
    resolutionMode?: ModuleResolutionMode,
  ): (ts.ResolvedModuleFull | undefined)[] =>
    moduleNames.map((name) => resolveModuleFull(name, containingVirtualFile, resolutionMode));

  return {
    get parsedVirtualPaths(): ReadonlySet<string> {
      return new Set(authoritativePaths);
    },
    resolveModuleFull,
    resolveModulePath,
    resolveModuleNames,
  };
}
