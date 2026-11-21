import path from 'node:path';
import { TarballExtractionError } from './errors.js';

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;
const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const WINDOWS_INVALID_CHAR_RE = /[<>:"|?*]/;
const MAX_PATH_SEGMENTS = 64;

export interface ParsedTarEntryPath {
  readonly topLevelPrefix: string;
  /** POSIX relative path after stripping the single top-level folder (`''` for the root folder itself). */
  readonly relativePosixPath: string;
  /** Validated individual relative path segments (empty for the root folder itself). */
  readonly relativeSegments: readonly string[];
}

/**
 * Validates raw tar entry path safety (rejects NUL/control chars, backslashes, absolute paths,
 * Windows drive letters, `.` / `..` traversal, and empty internal segments) and enforces that
 * every entry shares ONE single top-level folder prefix.
 */
export function parseAndValidateTarEntryPath(
  rawEntryPath: string,
  expectedTopLevelPrefix: string | null,
): ParsedTarEntryPath {
  if (rawEntryPath.length === 0) {
    throw new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: 'Tar archive contains an empty entry path.',
    });
  }

  if (hasControlChars(rawEntryPath)) {
    throw new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: 'Tar entry path contains forbidden control or NUL characters.',
    });
  }

  if (rawEntryPath.includes('\\')) {
    throw new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: `Tar entry path contains forbidden backslash: ${rawEntryPath}`,
    });
  }

  if (rawEntryPath.startsWith('/') || WINDOWS_DRIVE_RE.test(rawEntryPath)) {
    throw new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: `Tar entry path must be relative: ${rawEntryPath}`,
    });
  }

  // Strip a single trailing slash for directory entries, then reject double slashes
  const withoutTrailingSlash = rawEntryPath.endsWith('/')
    ? rawEntryPath.slice(0, -1)
    : rawEntryPath;

  if (withoutTrailingSlash.length === 0) {
    throw new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: `Tar entry path is invalid: ${rawEntryPath}`,
    });
  }

  const allSegments = withoutTrailingSlash.split('/');
  if (allSegments.length > MAX_PATH_SEGMENTS) {
    throw new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: `Tar entry path exceeds maximum nesting depth (${MAX_PATH_SEGMENTS}).`,
    });
  }

  for (const segment of allSegments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new TarballExtractionError({
        code: 'TARBALL_SECURITY_VIOLATION',
        message: `Tar entry path contains forbidden traversal or empty segment: ${rawEntryPath}`,
      });
    }
  }

  const topLevelPrefix = allSegments[0];
  if (!topLevelPrefix) {
    throw new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: `Tar entry path is missing a top-level folder: ${rawEntryPath}`,
    });
  }

  if (expectedTopLevelPrefix !== null && topLevelPrefix !== expectedTopLevelPrefix) {
    throw new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: `Tar entry escapes single top-level folder "${expectedTopLevelPrefix}": ${rawEntryPath}`,
    });
  }

  const relativeSegments = allSegments.slice(1);
  return {
    topLevelPrefix,
    relativePosixPath: relativeSegments.join('/'),
    relativeSegments,
  };
}

/**
 * Enforces cross-platform / Windows NTFS filename safety ONLY on paths we intend to write.
 * Skipped entries are drained without calling this function.
 */
export function assertSafeWritePath(
  relativeSegments: readonly string[],
  relPosixPath: string,
): void {
  if (relativeSegments.length === 0) {
    throw new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: 'Cannot write file at archive root without a filename.',
    });
  }

  for (const segment of relativeSegments) {
    if (WINDOWS_RESERVED_BASENAME_RE.test(segment)) {
      throw new TarballExtractionError({
        code: 'TARBALL_SECURITY_VIOLATION',
        message: `Refusing to write Windows-reserved path segment "${segment}" in ${relPosixPath}`,
      });
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw new TarballExtractionError({
        code: 'TARBALL_SECURITY_VIOLATION',
        message: `Refusing to write path segment ending with dot or space ("${segment}") in ${relPosixPath}`,
      });
    }
    if (WINDOWS_INVALID_CHAR_RE.test(segment)) {
      throw new TarballExtractionError({
        code: 'TARBALL_SECURITY_VIOLATION',
        message: `Refusing to write path segment with forbidden filename characters in ${relPosixPath}`,
      });
    }
  }
}

/**
 * Builds the destination filesystem path from validated segments and asserts that the
 * resulting resolved path remains strictly inside `canonicalRootDir`.
 */
export function buildSafeDestinationPath(
  canonicalRootDir: string,
  relativeSegments: readonly string[],
): string {
  const destination = path.resolve(canonicalRootDir, ...relativeSegments);
  const rootPrefix = canonicalRootDir.endsWith(path.sep)
    ? canonicalRootDir
    : `${canonicalRootDir}${path.sep}`;

  if (!destination.startsWith(rootPrefix)) {
    throw new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: 'Resolved extraction destination escaped temporary root directory.',
    });
  }

  return destination;
}
