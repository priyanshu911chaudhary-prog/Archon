import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isRepoConfigPath, isSupportedSourcePath, normalizePosixPath } from '@archon/shared';
import { CoreAnalysisError } from './errors.js';
import {
  DEFAULT_MAX_CONFIG_FILES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SUPPORTED_FILES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_WARNINGS,
  MAX_WARNING_MESSAGE_CHARS,
  type AnalysisWarning,
} from './types.js';

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;
const MAX_READ_CHUNK_BYTES = 64 * 1024;
const IGNORED_WALK_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '__snapshots__',
  '.git',
]);

export interface ReadableFileHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ readonly bytesRead: number }>;
  stat(): Promise<{ readonly size: number }>;
  close(): Promise<void>;
}

export interface WorkspaceFsAdapter {
  readonly lstat: (targetPath: string) => Promise<{
    readonly size: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isFile(): boolean;
  }>;
  readonly realpath: (targetPath: string) => Promise<string>;
  readonly open: (targetPath: string, flags: string) => Promise<ReadableFileHandle>;
}

const DEFAULT_FS_ADAPTER: WorkspaceFsAdapter = {
  lstat: (targetPath) => lstat(targetPath),
  realpath: (targetPath) => realpath(targetPath),
  open: (targetPath, flags) => open(targetPath, flags),
};

export interface LoadedWorkspaceFile {
  readonly relativePath: string;
  readonly content: string;
  readonly byteLength: number;
}

export interface DiscoveredWorkspace {
  readonly sourceFiles: readonly LoadedWorkspaceFile[];
  readonly configFiles: readonly LoadedWorkspaceFile[];
  readonly warnings: readonly AnalysisWarning[];
  readonly truncatedWarningsCount: number;
  readonly skippedOversizedFilesCount: number;
  /** Total actual bytes read from the filesystem across source, config, and read-then-skipped oversized files. */
  readonly totalBytesRead: number;
}

export interface DiscoverWorkspaceOptions {
  readonly rootDir: string;
  readonly supportedFiles?: readonly string[];
  readonly configFiles?: readonly string[];
  readonly maxSupportedFiles?: number;
  readonly maxConfigFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxWarnings?: number;
  /** Optional filesystem adapter seam for deterministic unit testing of partial reads and file-size changes. */
  readonly fsAdapter?: WorkspaceFsAdapter;
}

type BoundedReadResult =
  | { readonly kind: 'ok'; readonly buffer: Buffer; readonly bytesRead: number }
  | { readonly kind: 'file_oversized'; readonly bytesRead: number }
  | { readonly kind: 'global_limit_exceeded'; readonly bytesRead: number }
  | { readonly kind: 'read_error'; readonly bytesRead: number };

export function compareCodePoint(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
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

export function truncateWarningMessage(message: string): string {
  if (message.length <= MAX_WARNING_MESSAGE_CHARS) {
    return message;
  }
  return `${message.slice(0, MAX_WARNING_MESSAGE_CHARS - 3)}...`;
}

/**
 * Strictly validates a repository-relative input file path:
 * rejects empty paths, control chars, absolute paths, Windows drive letters,
 * and `.` / `..` / empty segments, returning a clean POSIX relative path.
 */
export function validateRepoRelativePath(rawInput: string): string {
  if (rawInput.length === 0) {
    throw new CoreAnalysisError({
      code: 'PATH_TRAVERSAL_REJECTED',
      message: 'File path must not be empty.',
    });
  }
  if (hasControlChars(rawInput)) {
    throw new CoreAnalysisError({
      code: 'PATH_TRAVERSAL_REJECTED',
      message: 'File path contains forbidden control characters.',
    });
  }
  if (
    rawInput.startsWith('/') ||
    rawInput.startsWith('\\') ||
    WINDOWS_DRIVE_RE.test(rawInput) ||
    path.isAbsolute(rawInput)
  ) {
    throw new CoreAnalysisError({
      code: 'PATH_TRAVERSAL_REJECTED',
      message: 'Absolute file paths are not permitted inside workspace inputs.',
    });
  }

  const slashNormalized = rawInput.replace(/\\/g, '/');
  const rawSegments = slashNormalized.split('/');
  for (const segment of rawSegments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new CoreAnalysisError({
        code: 'PATH_TRAVERSAL_REJECTED',
        message: 'Path traversal or empty segments are not permitted in workspace paths.',
      });
    }
  }

  return normalizePosixPath(slashNormalized);
}

function isContainedInsideRoot(canonicalRoot: string, candidateCanonicalPath: string): boolean {
  const rootPrefix = canonicalRoot.endsWith(path.sep)
    ? canonicalRoot
    : `${canonicalRoot}${path.sep}`;
  return candidateCanonicalPath.startsWith(rootPrefix);
}

/**
 * Reads actual bytes from disk while strictly enforcing BOTH the per-file limit
 * (`maxFileBytes`) and the remaining global byte budget (`remainingGlobalBytes`):
 * - Checks remaining global budget BEFORE allocating any read buffer or issuing a read.
 * - Never reads past `remainingGlobalBytes` merely to detect an overflow.
 * - Handles partial reads and files whose size changes between metadata inspection and reading.
 * - Always closes the opened file handle in `finally` on every success and failure path.
 */
async function readBoundedFileBytes(
  filePath: string,
  maxFileBytes: number,
  remainingGlobalBytes: number,
  fsAdapter: WorkspaceFsAdapter,
): Promise<BoundedReadResult> {
  let handle: ReadableFileHandle;
  try {
    handle = await fsAdapter.open(filePath, 'r');
  } catch {
    return { kind: 'read_error', bytesRead: 0 };
  }

  let totalRead = 0;
  try {
    // Check global budget before allocating any read buffer or issuing a read
    if (remainingGlobalBytes <= 0) {
      const fdStat = await handle.stat();
      if (fdStat.size <= 0) {
        return { kind: 'ok', buffer: Buffer.alloc(0), bytesRead: 0 };
      }
      return { kind: 'global_limit_exceeded', bytesRead: 0 };
    }

    const chunks: Buffer[] = [];

    for (;;) {
      const remainingGlobalForFile = remainingGlobalBytes - totalRead;
      if (remainingGlobalForFile <= 0) {
        // Global byte ceiling reached without EOF: inspect open fd size without reading another byte
        const fdStat = await handle.stat();
        if (fdStat.size <= totalRead) {
          return {
            kind: 'ok',
            buffer: Buffer.concat(chunks, totalRead),
            bytesRead: totalRead,
          };
        }
        if (totalRead === maxFileBytes && maxFileBytes > 0 && fdStat.size > maxFileBytes) {
          return { kind: 'file_oversized', bytesRead: totalRead };
        }
        return { kind: 'global_limit_exceeded', bytesRead: totalRead };
      }

      const remainingFileWithProbe = maxFileBytes + 1 - totalRead;
      const toRead = Math.min(MAX_READ_CHUNK_BYTES, remainingFileWithProbe, remainingGlobalForFile);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, null);

      if (bytesRead === 0) {
        return {
          kind: 'ok',
          buffer: Buffer.concat(chunks, totalRead),
          bytesRead: totalRead,
        };
      }

      totalRead += bytesRead;
      if (totalRead > maxFileBytes) {
        return { kind: 'file_oversized', bytesRead: totalRead };
      }

      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
  } catch {
    return { kind: 'read_error', bytesRead: totalRead };
  } finally {
    await handle.close();
  }
}

export async function discoverWorkspaceFiles(
  options: DiscoverWorkspaceOptions,
): Promise<DiscoveredWorkspace> {
  const maxSupportedFiles = options.maxSupportedFiles ?? DEFAULT_MAX_SUPPORTED_FILES;
  const maxConfigFiles = options.maxConfigFiles ?? DEFAULT_MAX_CONFIG_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxWarnings = options.maxWarnings ?? DEFAULT_MAX_WARNINGS;
  const fsAdapter = options.fsAdapter ?? DEFAULT_FS_ADAPTER;

  if (!Number.isFinite(maxFileBytes) || maxFileBytes < 0) {
    throw new CoreAnalysisError({
      code: 'INVALID_WORKSPACE',
      message: `maxFileBytes must be a non-negative finite number (received ${maxFileBytes}).`,
    });
  }
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes < 0) {
    throw new CoreAnalysisError({
      code: 'INVALID_WORKSPACE',
      message: `maxTotalBytes must be a non-negative finite number (received ${maxTotalBytes}).`,
    });
  }

  if (options.rootDir.trim().length === 0) {
    throw new CoreAnalysisError({
      code: 'INVALID_WORKSPACE',
      message: 'Workspace rootDir must not be empty.',
    });
  }

  let canonicalRoot: string;
  try {
    const rootStats = await fsAdapter.lstat(options.rootDir);
    if (!rootStats.isDirectory() && !rootStats.isSymbolicLink()) {
      throw new CoreAnalysisError({
        code: 'INVALID_WORKSPACE',
        message: 'Workspace rootDir must be a directory.',
      });
    }
    canonicalRoot = await fsAdapter.realpath(options.rootDir);
    const resolvedStats = await fsAdapter.lstat(canonicalRoot);
    if (!resolvedStats.isDirectory()) {
      throw new CoreAnalysisError({
        code: 'INVALID_WORKSPACE',
        message: 'Workspace rootDir does not resolve to a directory.',
      });
    }
  } catch (err) {
    if (err instanceof CoreAnalysisError) {
      throw err;
    }
    throw new CoreAnalysisError({
      code: 'INVALID_WORKSPACE',
      message: 'Workspace directory could not be accessed.',
      cause: err,
    });
  }

  const warnings: AnalysisWarning[] = [];
  const warningState = { truncated: 0 };
  const pushWarning = (warning: AnalysisWarning): void => {
    if (warnings.length < maxWarnings) {
      warnings.push({
        ...warning,
        message: truncateWarningMessage(warning.message),
      });
    } else {
      warningState.truncated += 1;
    }
  };

  const supportedCandidates = new Set<string>();
  const configCandidates = new Set<string>();
  const configCapState = { warned: false };

  const addConfigCandidate = (relPath: string): void => {
    if (configCandidates.has(relPath)) {
      return;
    }
    if (configCandidates.size >= maxConfigFiles) {
      if (!configCapState.warned) {
        configCapState.warned = true;
        pushWarning({
          code: 'CONFIG_LIMIT_EXCEEDED',
          filePath: relPath,
          message: `Configuration file limit (${maxConfigFiles}) reached; additional config files were skipped.`,
        });
      }
      return;
    }
    configCandidates.add(relPath);
  };

  const explicitMode = options.supportedFiles !== undefined || options.configFiles !== undefined;

  if (options.supportedFiles !== undefined) {
    for (const rawPath of options.supportedFiles) {
      const normalized = validateRepoRelativePath(rawPath);
      if (isSupportedSourcePath(normalized)) {
        supportedCandidates.add(normalized);
      }
    }
  }

  if (options.configFiles !== undefined) {
    for (const rawPath of options.configFiles) {
      const normalized = validateRepoRelativePath(rawPath);
      if (isRepoConfigPath(normalized)) {
        addConfigCandidate(normalized);
      }
    }
  }

  if (!explicitMode) {
    const walkDirectory = async (currentAbsDir: string, currentRelPosix: string): Promise<void> => {
      const entries = await readdir(currentAbsDir, { withFileTypes: true });
      entries.sort((a, b) => compareCodePoint(a.name, b.name));

      for (const entry of entries) {
        const nextRelPosix =
          currentRelPosix.length === 0 ? entry.name : `${currentRelPosix}/${entry.name}`;
        const nextAbsPath = path.join(currentAbsDir, entry.name);

        if (entry.isSymbolicLink()) {
          pushWarning({
            code: 'UNSAFE_SYMLINK_SKIPPED',
            filePath: nextRelPosix,
            message: `Skipped symbolic link "${nextRelPosix}" during workspace discovery.`,
          });
          continue;
        }

        if (entry.isDirectory()) {
          if (IGNORED_WALK_DIRS.has(entry.name)) {
            continue;
          }
          // Extra check: on Windows, junctions can sometimes report isDirectory()
          const dirStat = await fsAdapter.lstat(nextAbsPath);
          if (dirStat.isSymbolicLink()) {
            pushWarning({
              code: 'UNSAFE_SYMLINK_SKIPPED',
              filePath: nextRelPosix,
              message: `Skipped symbolic link directory "${nextRelPosix}" during workspace discovery.`,
            });
            continue;
          }
          const canonicalSubdir = await fsAdapter.realpath(nextAbsPath);
          if (!isContainedInsideRoot(canonicalRoot, canonicalSubdir)) {
            pushWarning({
              code: 'UNSAFE_SYMLINK_SKIPPED',
              filePath: nextRelPosix,
              message: `Skipped directory "${nextRelPosix}" escaping workspace root.`,
            });
            continue;
          }
          await walkDirectory(nextAbsPath, nextRelPosix);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        if (isSupportedSourcePath(nextRelPosix)) {
          supportedCandidates.add(nextRelPosix);
        } else if (isRepoConfigPath(nextRelPosix)) {
          addConfigCandidate(nextRelPosix);
        }
      }
    };

    await walkDirectory(canonicalRoot, '');
  }

  const sortedSupportedPaths = [...supportedCandidates].sort(compareCodePoint);
  if (sortedSupportedPaths.length > maxSupportedFiles) {
    throw new CoreAnalysisError({
      code: 'FILE_LIMIT_EXCEEDED',
      message: `Workspace contains ${sortedSupportedPaths.length} supported TS/JS files, exceeding limit of ${maxSupportedFiles}.`,
      details: {
        supportedFilesCount: sortedSupportedPaths.length,
        maxSupportedFiles,
      },
    });
  }

  const sortedConfigPaths = [...configCandidates].sort(compareCodePoint);
  const loadedSourceFiles: LoadedWorkspaceFile[] = [];
  const loadedConfigFiles: LoadedWorkspaceFile[] = [];
  const readStats = { totalBytesRead: 0, skippedOversized: 0 };

  const loadValidatedFile = async (
    relPosixPath: string,
    kind: 'source' | 'config',
  ): Promise<LoadedWorkspaceFile | null> => {
    const segments = relPosixPath.split('/');
    const absPath = path.resolve(canonicalRoot, ...segments);

    if (!isContainedInsideRoot(canonicalRoot, absPath)) {
      throw new CoreAnalysisError({
        code: 'PATH_TRAVERSAL_REJECTED',
        message: `File path "${relPosixPath}" escapes workspace root.`,
      });
    }

    let entryStat;
    try {
      entryStat = await fsAdapter.lstat(absPath);
    } catch {
      pushWarning({
        code: 'UNREADABLE_FILE',
        filePath: relPosixPath,
        message: `Could not stat "${relPosixPath}".`,
      });
      return null;
    }

    if (entryStat.isSymbolicLink()) {
      if (explicitMode) {
        throw new CoreAnalysisError({
          code: 'PATH_TRAVERSAL_REJECTED',
          message: `Symbolic link "${relPosixPath}" is not permitted.`,
        });
      }
      pushWarning({
        code: 'UNSAFE_SYMLINK_SKIPPED',
        filePath: relPosixPath,
        message: `Skipped symbolic link "${relPosixPath}".`,
      });
      return null;
    }

    if (!entryStat.isFile()) {
      return null;
    }

    let canonicalFilePath: string;
    try {
      canonicalFilePath = await fsAdapter.realpath(absPath);
    } catch {
      pushWarning({
        code: 'UNREADABLE_FILE',
        filePath: relPosixPath,
        message: `Could not resolve canonical path for "${relPosixPath}".`,
      });
      return null;
    }

    if (!isContainedInsideRoot(canonicalRoot, canonicalFilePath)) {
      throw new CoreAnalysisError({
        code: 'PATH_TRAVERSAL_REJECTED',
        message: `File "${relPosixPath}" resolves outside workspace root.`,
      });
    }

    // Metadata pre-check: oversized files rejected before opening contribute 0 actual bytes read
    if (entryStat.size > maxFileBytes) {
      readStats.skippedOversized += 1;
      pushWarning({
        code: 'OVERSIZED_FILE_SKIPPED',
        filePath: relPosixPath,
        message: `Skipped ${kind} file "${relPosixPath}" exceeding per-file byte limit (${maxFileBytes} bytes).`,
      });
      return null;
    }

    const remainingGlobalBytes = Math.max(0, maxTotalBytes - readStats.totalBytesRead);
    const readResult = await readBoundedFileBytes(
      canonicalFilePath,
      maxFileBytes,
      remainingGlobalBytes,
      fsAdapter,
    );

    // Always account for actual bytes read from the filesystem (including read-then-skipped oversized files)
    readStats.totalBytesRead += readResult.bytesRead;

    if (readResult.kind === 'read_error') {
      pushWarning({
        code: 'UNREADABLE_FILE',
        filePath: relPosixPath,
        message: `Failed reading file "${relPosixPath}".`,
      });
      return null;
    }

    if (readResult.kind === 'file_oversized') {
      readStats.skippedOversized += 1;
      pushWarning({
        code: 'OVERSIZED_FILE_SKIPPED',
        filePath: relPosixPath,
        message: `Skipped ${kind} file "${relPosixPath}" exceeding per-file byte limit (${maxFileBytes} bytes).`,
      });
      return null;
    }

    if (readResult.kind === 'global_limit_exceeded') {
      throw new CoreAnalysisError({
        code: 'SIZE_LIMIT_EXCEEDED',
        message: `Workspace total bytes read exceeded limit of ${maxTotalBytes} bytes.`,
        details: {
          maxTotalBytes,
          totalBytesRead: readStats.totalBytesRead,
        },
      });
    }

    return {
      relativePath: relPosixPath,
      content: readResult.buffer.toString('utf8'),
      byteLength: readResult.buffer.byteLength,
    };
  };

  for (const relPath of sortedSupportedPaths) {
    const loaded = await loadValidatedFile(relPath, 'source');
    if (loaded !== null) {
      loadedSourceFiles.push(loaded);
    }
  }

  for (const relPath of sortedConfigPaths) {
    const loaded = await loadValidatedFile(relPath, 'config');
    if (loaded !== null) {
      loadedConfigFiles.push(loaded);
    }
  }

  return {
    sourceFiles: loadedSourceFiles,
    configFiles: loadedConfigFiles,
    warnings,
    truncatedWarningsCount: warningState.truncated,
    skippedOversizedFilesCount: readStats.skippedOversized,
    totalBytesRead: readStats.totalBytesRead,
  };
}
