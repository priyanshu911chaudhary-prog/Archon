const SUPPORTED_SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const IGNORED_PATH_RE =
  /(^|\/)(node_modules|dist|build|\.next|out|coverage|__snapshots__)\/|\.d\.[cm]?ts$/i;
const REPO_CONFIG_FILE_RE =
  /(^|\/)(tsconfig(\.[^/]+)?\.json|jsconfig(\.[^/]+)?\.json|package\.json)$/i;

/**
 * Normalizes repository-relative paths to POSIX forward slashes with no leading slash.
 */
export function normalizePosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Returns true if the path is a supported TS/JS source file under v1.0 limits
 * (excludes node_modules, build artifacts, snapshots, and TypeScript declaration files).
 */
export function isSupportedSourcePath(filePath: string): boolean {
  const normalized = normalizePosixPath(filePath);
  if (normalized.length === 0 || IGNORED_PATH_RE.test(normalized)) {
    return false;
  }
  return SUPPORTED_SOURCE_EXT_RE.test(normalized);
}

/**
 * Returns true if the path is a project configuration file needed for module/alias resolution.
 */
export function isRepoConfigPath(filePath: string): boolean {
  const normalized = normalizePosixPath(filePath);
  if (normalized.length === 0 || IGNORED_PATH_RE.test(normalized)) {
    return false;
  }
  return REPO_CONFIG_FILE_RE.test(normalized);
}
