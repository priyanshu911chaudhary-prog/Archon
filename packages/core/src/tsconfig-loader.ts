import { posix as posixPath } from 'node:path';
import { ts } from 'ts-morph';
import { compareCodePoint, truncateWarningMessage, type LoadedWorkspaceFile } from './discovery.js';
import { DEFAULT_MAX_EXTENDS_DEPTH, type AnalysisWarning } from './types.js';

export const VIRTUAL_REPO_ROOT = '/repo' as const;

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;
const FORBIDDEN_ALIAS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ResolvedTsConfig {
  /** Repo-relative POSIX path of the config file (e.g. "tsconfig.json" or "apps/web/tsconfig.json"). */
  readonly configPath: string;
  /** Repo-relative POSIX directory containing this config (`""` for root). */
  readonly configDir: string;
  /** Effective virtual absolute baseUrl inside `/repo`, or undefined when omitted. */
  readonly baseUrl?: string;
  /**
   * Repo-relative POSIX directory of the config that declared the effective `paths`,
   * or undefined when no config in the inheritance chain declared `paths`.
   */
  readonly pathsDeclarationDir?: string;
  /**
   * Validated raw `paths` alias entries in original declaration order.
   * `undefined` when omitted across the inheritance chain; `{}` when explicitly cleared.
   */
  readonly rawPaths?: Readonly<Record<string, readonly string[]>>;
  /**
   * Final workspace-contained virtual `/repo/...` alias targets resolved using effective
   * `baseUrl` (when present) or `pathsDeclarationDir` (when `baseUrl` is absent),
   * preserving exact key declaration order and target array order.
   * `undefined` when omitted; `{}` when explicitly cleared.
   */
  readonly paths?: Readonly<Record<string, readonly string[]>>;
}

export interface LoadedTsConfigsResult {
  /** All resolved tsconfig/jsconfig entries, indexed by repo-relative configPath. */
  readonly configsByPath: ReadonlyMap<string, ResolvedTsConfig>;
  /** Nearest applicable config per directory (preferring tsconfig.json over jsconfig.json). */
  readonly configsByDir: ReadonlyMap<string, ResolvedTsConfig>;
  readonly warnings: readonly AnalysisWarning[];
}

interface ParsedOwnTsConfig {
  readonly configPath: string;
  readonly configDir: string;
  readonly extendsSpecs: readonly string[];
  readonly baseUrl?: string;
  readonly hasPaths: boolean;
  readonly rawPaths?: Readonly<Record<string, readonly string[]>>;
}

interface ResolvedChainState {
  readonly baseUrl?: string;
  readonly pathsDeclarationDir?: string;
  readonly rawPaths?: Readonly<Record<string, readonly string[]>>;
  readonly hadCycle: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function setSafeRecordEntry(
  record: Record<string, readonly string[]>,
  key: string,
  value: readonly string[],
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function hasTraversalAfterWildcard(target: string): boolean {
  const segments = target.split('/');
  let sawWildcard = false;
  for (const segment of segments) {
    if (segment.includes('*')) {
      sawWildcard = true;
    } else if (sawWildcard && segment === '..') {
      return true;
    }
  }
  return false;
}

function isTsOrJsConfigFile(relPath: string): boolean {
  const base = posixPath.basename(relPath).toLowerCase();
  return (
    base === 'tsconfig.json' ||
    base === 'jsconfig.json' ||
    (base.startsWith('tsconfig.') && base.endsWith('.json')) ||
    (base.startsWith('jsconfig.') && base.endsWith('.json'))
  );
}

export function toVirtualRepoPath(relPosixPath: string): string {
  const clean = relPosixPath.replace(/^\/+/, '');
  return clean.length === 0 ? VIRTUAL_REPO_ROOT : `${VIRTUAL_REPO_ROOT}/${clean}`;
}

export function fromVirtualRepoPath(virtualPath: string): string | null {
  const normalized = posixPath.normalize(virtualPath.replace(/\\/g, '/'));
  if (normalized === VIRTUAL_REPO_ROOT) {
    return '';
  }
  const prefix = `${VIRTUAL_REPO_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    return null;
  }
  return normalized.slice(prefix.length);
}

/**
 * Resolves a path segment against a virtual base directory inside `/repo`.
 * Returns `null` if the path contains control characters, backslashes, Windows drive
 * prefixes, or escapes `/repo`.
 */
export function resolveContainedVirtualPath(baseVirtualDir: string, target: string): string | null {
  if (
    target.length === 0 ||
    hasControlChars(target) ||
    WINDOWS_DRIVE_RE.test(target) ||
    target.includes('\\')
  ) {
    return null;
  }
  const joined = target.startsWith('/')
    ? posixPath.normalize(target)
    : posixPath.normalize(posixPath.join(baseVirtualDir, target));

  if (joined === VIRTUAL_REPO_ROOT || joined.startsWith(`${VIRTUAL_REPO_ROOT}/`)) {
    return joined;
  }
  return null;
}

/**
 * Resolves a relative config target (from untrusted tsconfig JSON) against `baseVirtualDir`,
 * rejecting absolute POSIX host paths, Windows drive paths, backslashes, and escapes outside `/repo`.
 */
function resolveRelativeConfigPath(baseVirtualDir: string, rawTarget: string): string | null {
  if (rawTarget.startsWith('/')) {
    return null;
  }
  return resolveContainedVirtualPath(baseVirtualDir, rawTarget);
}

function isRelativeSpec(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

function extractExtendsList(
  rawExtends: unknown,
  configPath: string,
  addWarning: (warning: AnalysisWarning) => void,
): readonly string[] {
  if (rawExtends === undefined) {
    return [];
  }
  if (typeof rawExtends === 'string') {
    const trimmed = rawExtends.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(rawExtends)) {
    const specs: string[] = [];
    for (const item of rawExtends) {
      if (typeof item === 'string' && item.trim().length > 0) {
        specs.push(item.trim());
      } else {
        addWarning({
          code: 'INVALID_TSCONFIG',
          filePath: configPath,
          message: `Ignored non-string entry in "extends" array of "${configPath}".`,
        });
      }
    }
    return specs;
  }

  addWarning({
    code: 'INVALID_TSCONFIG',
    filePath: configPath,
    message: `Ignored malformed "extends" field in "${configPath}".`,
  });
  return [];
}

function resolveLocalExtendsPath(
  fromConfigPath: string,
  extendsSpec: string,
  parsedOwnMap: ReadonlyMap<string, ParsedOwnTsConfig>,
  addWarning: (warning: AnalysisWarning) => void,
): string | null {
  // Reject absolute POSIX/Windows paths or backslashes in extends
  if (
    extendsSpec.startsWith('/') ||
    WINDOWS_DRIVE_RE.test(extendsSpec) ||
    extendsSpec.includes('\\')
  ) {
    addWarning({
      code: 'TSCONFIG_TRAVERSAL_IGNORED',
      filePath: fromConfigPath,
      message: `Ignored absolute or unsafe "extends" target in "${fromConfigPath}".`,
    });
    return null;
  }

  // Ignore unavailable external package extends (e.g. "@tsconfig/next/tsconfig.json") gracefully
  if (!isRelativeSpec(extendsSpec)) {
    return null;
  }

  const fromDir = posixPath.dirname(fromConfigPath);
  const fromVirtualDir = toVirtualRepoPath(fromDir === '.' ? '' : fromDir);
  const resolvedVirtual = resolveRelativeConfigPath(fromVirtualDir, extendsSpec);

  if (resolvedVirtual === null) {
    addWarning({
      code: 'TSCONFIG_TRAVERSAL_IGNORED',
      filePath: fromConfigPath,
      message: `Ignored "extends" target escaping workspace in "${fromConfigPath}".`,
    });
    return null;
  }

  const relCandidate = fromVirtualRepoPath(resolvedVirtual);
  if (relCandidate === null || relCandidate.length === 0) {
    return null;
  }

  const candidates = [
    relCandidate,
    relCandidate.endsWith('.json') ? '' : `${relCandidate}.json`,
    `${relCandidate}/tsconfig.json`,
  ].filter((c) => c.length > 0);

  for (const candidate of candidates) {
    if (parsedOwnMap.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function parseSingleConfigFile(
  file: LoadedWorkspaceFile,
  addWarning: (warning: AnalysisWarning) => void,
): ParsedOwnTsConfig {
  const configPath = file.relativePath;
  const dir = posixPath.dirname(configPath);
  const configDir = dir === '.' ? '' : dir;
  const emptyOwn: ParsedOwnTsConfig = {
    configPath,
    configDir,
    extendsSpecs: [],
    hasPaths: false,
  };

  const virtualPath = toVirtualRepoPath(configPath);
  const parsedJson = ts.parseConfigFileTextToJson(virtualPath, file.content);

  if (parsedJson.error !== undefined) {
    const diagText = ts.flattenDiagnosticMessageText(parsedJson.error.messageText, ' ');
    addWarning({
      code: 'INVALID_TSCONFIG',
      filePath: configPath,
      message: `Failed parsing JSONC config "${configPath}": ${diagText}`,
    });
    return emptyOwn;
  }

  const rawRoot: unknown = parsedJson.config;
  if (!isRecord(rawRoot)) {
    addWarning({
      code: 'INVALID_TSCONFIG',
      filePath: configPath,
      message: `Expected JSON object at root of "${configPath}".`,
    });
    return emptyOwn;
  }

  const extendsSpecs = extractExtendsList(rawRoot.extends, configPath, addWarning);
  const configVirtualDir = toVirtualRepoPath(configDir);

  let ownBaseUrl: string | undefined;
  let hasPaths = false;
  let ownRawPaths: Record<string, readonly string[]> | undefined;

  const rawCompilerOptions = rawRoot.compilerOptions;
  if (rawCompilerOptions !== undefined && !isRecord(rawCompilerOptions)) {
    addWarning({
      code: 'INVALID_TSCONFIG',
      filePath: configPath,
      message: `Ignored non-object "compilerOptions" in "${configPath}".`,
    });
  } else if (isRecord(rawCompilerOptions)) {
    const rawBaseUrl = rawCompilerOptions.baseUrl;
    if (rawBaseUrl !== undefined) {
      if (typeof rawBaseUrl !== 'string' || rawBaseUrl.trim().length === 0) {
        addWarning({
          code: 'INVALID_TSCONFIG',
          filePath: configPath,
          message: `Ignored invalid "compilerOptions.baseUrl" in "${configPath}".`,
        });
      } else {
        const resolvedBase = resolveRelativeConfigPath(configVirtualDir, rawBaseUrl.trim());
        if (resolvedBase === null) {
          addWarning({
            code: 'TSCONFIG_TRAVERSAL_IGNORED',
            filePath: configPath,
            message: `Ignored "compilerOptions.baseUrl" escaping workspace in "${configPath}".`,
          });
        } else {
          ownBaseUrl = resolvedBase;
        }
      }
    }

    const rawPathsVal = rawCompilerOptions.paths;
    if (rawPathsVal !== undefined) {
      if (!isRecord(rawPathsVal)) {
        addWarning({
          code: 'INVALID_TSCONFIG',
          filePath: configPath,
          message: `Ignored non-object "compilerOptions.paths" in "${configPath}".`,
        });
      } else {
        hasPaths = true;
        ownRawPaths = {};
        // Preserve exact declaration order (do NOT sort alias keys alphabetically)
        for (const pattern of Object.keys(rawPathsVal)) {
          if (FORBIDDEN_ALIAS_KEYS.has(pattern)) {
            addWarning({
              code: 'INVALID_TSCONFIG',
              filePath: configPath,
              message: `Ignored unsafe paths alias key "${pattern}" in "${configPath}".`,
            });
            continue;
          }

          const rawTargets = rawPathsVal[pattern];
          if (!Array.isArray(rawTargets)) {
            addWarning({
              code: 'INVALID_TSCONFIG',
              filePath: configPath,
              message: `Ignored non-array paths target for "${pattern}" in "${configPath}".`,
            });
            continue;
          }

          const validatedTargets: string[] = [];
          for (const rawTarget of rawTargets) {
            if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) {
              addWarning({
                code: 'INVALID_TSCONFIG',
                filePath: configPath,
                message: `Ignored invalid path target entry under "${pattern}" in "${configPath}".`,
              });
              continue;
            }
            const trimmed = rawTarget.trim();
            if (
              trimmed.startsWith('/') ||
              WINDOWS_DRIVE_RE.test(trimmed) ||
              trimmed.includes('\\') ||
              hasControlChars(trimmed)
            ) {
              addWarning({
                code: 'TSCONFIG_TRAVERSAL_IGNORED',
                filePath: configPath,
                message: `Ignored unsafe paths target under "${pattern}" in "${configPath}".`,
              });
              continue;
            }
            if (hasTraversalAfterWildcard(trimmed)) {
              addWarning({
                code: 'INVALID_TSCONFIG',
                filePath: configPath,
                message: `Ignored unsupported paths target with traversal after wildcard under "${pattern}" in "${configPath}".`,
              });
              continue;
            }
            validatedTargets.push(trimmed);
          }

          // Retain declared key even if targets became empty so less-specific wildcards cannot accidentally match
          setSafeRecordEntry(ownRawPaths, pattern, validatedTargets);
        }
      }
    }
  }

  return {
    configPath,
    configDir,
    extendsSpecs,
    ...(ownBaseUrl !== undefined ? { baseUrl: ownBaseUrl } : {}),
    hasPaths,
    ...(ownRawPaths !== undefined ? { rawPaths: ownRawPaths } : {}),
  };
}

/**
 * Safely parses and resolves all workspace tsconfig/jsconfig files using TypeScript's
 * JSONC parser (`ts.parseConfigFileTextToJson`) with verified TypeScript 6.0.2 inheritance
 * semantics:
 * - `compilerOptions.paths` replaces inherited `paths` as a whole property (including `{}`).
 * - `extends` arrays apply parents left-to-right (later parents replace earlier properties).
 * - Raw alias targets stay unanchored until final effective `baseUrl` vs. `pathsDeclarationDir`
 *   is known, preserving exact alias key declaration order and target array order.
 * - Per-root depth-aware memoization prevents cycle pollution and `maxExtendsDepth` bypasses
 *   while supporting shared diamond inheritance without false cycle warnings.
 */
export function loadWorkspaceTsConfigs(
  configFiles: readonly LoadedWorkspaceFile[],
  options: { readonly maxExtendsDepth?: number } = {},
): LoadedTsConfigsResult {
  const maxExtendsDepth = options.maxExtendsDepth ?? DEFAULT_MAX_EXTENDS_DEPTH;
  const warnings: AnalysisWarning[] = [];
  const seenWarnings = new Set<string>();

  const addWarning = (warning: AnalysisWarning): void => {
    const truncatedMessage = truncateWarningMessage(warning.message);
    const dedupeKey = `${warning.code}\0${warning.filePath}\0${truncatedMessage}`;
    if (seenWarnings.has(dedupeKey)) {
      return;
    }
    seenWarnings.add(dedupeKey);
    warnings.push({
      ...warning,
      message: truncatedMessage,
    });
  };

  const sortedConfigFiles = [...configFiles]
    .filter((f) => isTsOrJsConfigFile(f.relativePath))
    .sort((a, b) => compareCodePoint(a.relativePath, b.relativePath));

  // Pass 1: parse each config file's own fields once (deterministic, order-independent)
  const parsedOwnMap = new Map<string, ParsedOwnTsConfig>();
  for (const file of sortedConfigFiles) {
    parsedOwnMap.set(file.relativePath, parseSingleConfigFile(file, addWarning));
  }

  // Pass 2: resolve each config's inheritance chain independently (no cross-root cycle/depth leakage)
  const configsByPath = new Map<string, ResolvedTsConfig>();

  for (const file of sortedConfigFiles) {
    const rootPath = file.relativePath;
    const perRootMemo = new Map<string, ResolvedChainState>();
    const visiting = new Set<string>();

    const resolveChain = (configPath: string, depth: number): ResolvedChainState => {
      const memoKey = `${configPath}@${depth}`;
      const memoized = perRootMemo.get(memoKey);
      if (memoized !== undefined) {
        return memoized;
      }

      if (depth > maxExtendsDepth) {
        addWarning({
          code: 'TSCONFIG_EXTENDS_DEPTH_EXCEEDED',
          filePath: configPath,
          message: `Configuration inheritance depth exceeded maximum (${maxExtendsDepth}) at "${configPath}".`,
        });
        return { hadCycle: false };
      }

      const own = parsedOwnMap.get(configPath);
      if (own === undefined) {
        return { hadCycle: false };
      }

      visiting.add(configPath);
      let effectiveBaseUrl: string | undefined;
      let effectivePathsDir: string | undefined;
      let effectiveRawPaths: Readonly<Record<string, readonly string[]>> | undefined;
      let hadCycle = false;

      try {
        for (const spec of own.extendsSpecs) {
          const parentPath = resolveLocalExtendsPath(configPath, spec, parsedOwnMap, addWarning);
          if (parentPath === null) {
            continue;
          }
          if (visiting.has(parentPath)) {
            hadCycle = true;
            addWarning({
              code: 'TSCONFIG_CIRCULAR_EXTENDS',
              filePath: configPath,
              message: `Circular tsconfig "extends" detected from "${configPath}" to "${parentPath}".`,
            });
            continue;
          }

          const parent = resolveChain(parentPath, depth + 1);
          if (parent.hadCycle) {
            hadCycle = true;
          }
          if (parent.baseUrl !== undefined) {
            effectiveBaseUrl = parent.baseUrl;
          }
          if (parent.rawPaths !== undefined) {
            effectiveRawPaths = parent.rawPaths;
            effectivePathsDir = parent.pathsDeclarationDir;
          }
        }
      } finally {
        visiting.delete(configPath);
      }

      if (own.baseUrl !== undefined) {
        effectiveBaseUrl = own.baseUrl;
      }
      if (own.hasPaths) {
        effectiveRawPaths = own.rawPaths;
        effectivePathsDir = own.configDir;
      }

      const state: ResolvedChainState = {
        ...(effectiveBaseUrl !== undefined ? { baseUrl: effectiveBaseUrl } : {}),
        ...(effectivePathsDir !== undefined ? { pathsDeclarationDir: effectivePathsDir } : {}),
        ...(effectiveRawPaths !== undefined ? { rawPaths: effectiveRawPaths } : {}),
        hadCycle,
      };

      if (!hadCycle) {
        perRootMemo.set(memoKey, state);
      }

      return state;
    };

    const resolvedChain = resolveChain(rootPath, 0);
    const own = parsedOwnMap.get(rootPath);
    const configDir = own?.configDir ?? '';

    let resolvedPaths: Record<string, readonly string[]> | undefined;
    if (resolvedChain.rawPaths !== undefined) {
      resolvedPaths = {};
      const anchor =
        resolvedChain.baseUrl ?? toVirtualRepoPath(resolvedChain.pathsDeclarationDir ?? configDir);

      for (const pattern of Object.keys(resolvedChain.rawPaths)) {
        const rawTargets = resolvedChain.rawPaths[pattern];
        if (rawTargets === undefined) {
          continue;
        }
        const anchoredTargets: string[] = [];
        for (const rawTarget of rawTargets) {
          const contained = resolveRelativeConfigPath(anchor, rawTarget);
          if (contained === null) {
            addWarning({
              code: 'TSCONFIG_TRAVERSAL_IGNORED',
              filePath: rootPath,
              message: `Ignored paths target escaping workspace under "${pattern}" in "${rootPath}".`,
            });
            continue;
          }
          anchoredTargets.push(contained);
        }
        setSafeRecordEntry(resolvedPaths, pattern, anchoredTargets);
      }
    }

    configsByPath.set(rootPath, {
      configPath: rootPath,
      configDir,
      ...(resolvedChain.baseUrl !== undefined ? { baseUrl: resolvedChain.baseUrl } : {}),
      ...(resolvedChain.pathsDeclarationDir !== undefined
        ? { pathsDeclarationDir: resolvedChain.pathsDeclarationDir }
        : {}),
      ...(resolvedChain.rawPaths !== undefined ? { rawPaths: resolvedChain.rawPaths } : {}),
      ...(resolvedPaths !== undefined ? { paths: resolvedPaths } : {}),
    });
  }

  // Pick primary config per directory: tsconfig.json > jsconfig.json
  const configsByDir = new Map<string, ResolvedTsConfig>();
  for (const resolved of configsByPath.values()) {
    const baseName = posixPath.basename(resolved.configPath).toLowerCase();
    if (baseName !== 'tsconfig.json' && baseName !== 'jsconfig.json') {
      continue;
    }
    const existing = configsByDir.get(resolved.configDir);
    if (existing === undefined || baseName === 'tsconfig.json') {
      configsByDir.set(resolved.configDir, resolved);
    }
  }

  return {
    configsByPath,
    configsByDir,
    warnings,
  };
}

/**
 * Finds the nearest ancestor tsconfig.json (or jsconfig.json) for a repo-relative source file.
 */
export function findNearestTsConfig(
  sourceRelPosixPath: string,
  configsByDir: ReadonlyMap<string, ResolvedTsConfig>,
): ResolvedTsConfig | undefined {
  let currentDir = posixPath.dirname(sourceRelPosixPath);
  if (currentDir === '.') {
    currentDir = '';
  }

  for (;;) {
    const found = configsByDir.get(currentDir);
    if (found !== undefined) {
      return found;
    }
    if (currentDir.length === 0) {
      return undefined;
    }
    const parent = posixPath.dirname(currentDir);
    currentDir = parent === '.' ? '' : parent;
  }
}
