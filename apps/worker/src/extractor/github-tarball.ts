import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { isRepoConfigPath, isSupportedSourcePath } from '@archon/shared';
import { Parser, type ReadEntry, type types } from 'tar';
import { TarballExtractionError } from './errors.js';
import {
  assertSafeWritePath,
  buildSafeDestinationPath,
  parseAndValidateTarEntryPath,
} from './path-guard.js';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const ALLOWED_CODELOAD_HOST = 'codeload.github.com';
const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_MAX_SUPPORTED_FILES = 500;
const DEFAULT_MAX_REPO_SIZE_MB = 50;
const DEFAULT_MAX_FILE_BYTES = BYTES_PER_MIB; // 1 MiB per file
const DEFAULT_MAX_CONFIG_FILES = 50;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_META_ENTRY_SIZE = 64 * 1024; // 64 KiB
const DEFAULT_MAX_DECOMPRESSION_RATIO = 1000;
const MAX_DECOMPRESSED_CAP_MB = 200;

export const SAFE_TARBALL_CANCELLED_MESSAGE =
  'Tarball extraction cancelled during worker shutdown.';

const ALLOWED_TARBALL_CONTENT_TYPES = new Set([
  'application/x-gzip',
  'application/gzip',
  'application/octet-stream',
  'application/x-tar',
]);

const REGULAR_FILE_TYPES = new Set<types.EntryTypeName>(['File', 'OldFile']);

const FORBIDDEN_SPECIAL_TYPES = new Set<types.EntryTypeName>([
  'SymbolicLink',
  'Link',
  'CharacterDevice',
  'BlockDevice',
  'FIFO',
  'ContiguousFile',
  'SparseFile',
  'ContinuationFile',
]);

export interface ExtractGitHubTarballOptions {
  readonly owner: string;
  readonly name: string;
  readonly commitSha: string;
  readonly token?: string;
  readonly maxSupportedFiles?: number;
  readonly maxRepoSizeMb?: number;
  /** Override exact compressed byte cap (defaults to maxRepoSizeMb * 1 MiB). */
  readonly maxCompressedBytes?: number;
  /** Override exact decompressed tar stream byte cap (defaults to min(maxRepoSizeMb * 4, 200) MiB). */
  readonly maxDecompressedBytes?: number;
  /** Override total extracted written bytes cap (defaults to maxRepoSizeMb * 1 MiB). */
  readonly maxWrittenBytes?: number;
  /** Files exceeding this byte cap are skipped and counted in skippedFilesCount (default 1 MiB). */
  readonly maxFileBytes?: number;
  /** Maximum config files (tsconfig/jsconfig/package.json) written (default 50). */
  readonly maxConfigFiles?: number;
  readonly timeoutMs?: number;
  /** Injectable parent directory for mkdtemp (defaults to os.tmpdir()). */
  readonly tempBaseDir?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export interface ExtractionStats {
  readonly compressedBytes: number;
  readonly decompressedBytes: number;
  readonly writtenBytes: number;
  readonly supportedFilesCount: number;
  readonly configFilesCount: number;
  readonly skippedFilesCount: number;
  readonly oversizedSkippedFilesCount: number;
  readonly oversizedSupportedFilesCount: number;
}

export interface ExtractedRepoWorkspace {
  readonly rootDir: string;
  readonly topLevelPrefix: string;
  /** POSIX-normalized relative paths of written TS/JS source files. */
  readonly supportedFiles: readonly string[];
  /** POSIX-normalized relative paths of written tsconfig/jsconfig/package.json files. */
  readonly configFiles: readonly string[];
  readonly stats: ExtractionStats;
}

interface ResolvedCaps {
  readonly maxSupportedFiles: number;
  readonly maxCompressedBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxWrittenBytes: number;
  readonly maxFileBytes: number;
  readonly maxConfigFiles: number;
  readonly timeoutMs: number;
}

interface ExtractionAbortTracker {
  firstError: TarballExtractionError | null;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function createTarballCancelledError(): TarballExtractionError {
  return new TarballExtractionError({
    code: 'TARBALL_CANCELLED',
    message: SAFE_TARBALL_CANCELLED_MESSAGE,
    retryable: true,
  });
}

function createTarballTimeoutError(message: string, cause?: unknown): TarballExtractionError {
  return new TarballExtractionError({
    code: 'TARBALL_TIMEOUT',
    message,
    retryable: true,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function resolveAbortFailure(
  signal: AbortSignal,
  tracker: ExtractionAbortTracker,
  fallbackTimeoutMessage: string,
  cause?: unknown,
): TarballExtractionError {
  if (tracker.firstError !== null) {
    return tracker.firstError;
  }
  const reason: unknown = signal.reason;
  if (reason instanceof TarballExtractionError) {
    tracker.firstError = reason;
    return reason;
  }
  return createTarballTimeoutError(fallbackTimeoutMessage, cause);
}

function resolveCaps(options: ExtractGitHubTarballOptions): ResolvedCaps {
  const maxRepoSizeMb = options.maxRepoSizeMb ?? DEFAULT_MAX_REPO_SIZE_MB;
  const maxRepoBytes = maxRepoSizeMb * BYTES_PER_MIB;
  const defaultDecompressedMb = Math.min(maxRepoSizeMb * 4, MAX_DECOMPRESSED_CAP_MB);

  return {
    maxSupportedFiles: options.maxSupportedFiles ?? DEFAULT_MAX_SUPPORTED_FILES,
    maxCompressedBytes: options.maxCompressedBytes ?? maxRepoBytes,
    maxDecompressedBytes: options.maxDecompressedBytes ?? defaultDecompressedMb * BYTES_PER_MIB,
    maxWrittenBytes: options.maxWrittenBytes ?? maxRepoBytes,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxConfigFiles: options.maxConfigFiles ?? DEFAULT_MAX_CONFIG_FILES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function parseRetryAfterSec(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) {
    return Math.max(1, Number.parseInt(retryAfter.trim(), 10));
  }
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset !== null && /^\d+$/.test(reset.trim())) {
    const resetSec = Number.parseInt(reset.trim(), 10);
    return Math.max(1, resetSec - Math.floor(Date.now() / 1000));
  }
  return undefined;
}

function validateCodeloadRedirectUrl(locationHeader: string | null): string {
  if (!locationHeader || locationHeader.trim().length === 0) {
    throw new TarballExtractionError({
      code: 'TARBALL_REDIRECT_REJECTED',
      message: 'GitHub tarball redirect response did not include a Location header.',
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(locationHeader);
  } catch (err) {
    throw new TarballExtractionError({
      code: 'TARBALL_REDIRECT_REJECTED',
      message: 'GitHub tarball redirect Location header is not a valid URL.',
      cause: err,
    });
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== ALLOWED_CODELOAD_HOST ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new TarballExtractionError({
      code: 'TARBALL_REDIRECT_REJECTED',
      message: `Refusing tarball redirect to disallowed host: ${parsed.protocol}//${parsed.host}`,
    });
  }

  return parsed.toString();
}

function validateTarballContentType(contentTypeHeader: string | null): void {
  if (!contentTypeHeader) {
    throw new TarballExtractionError({
      code: 'TARBALL_UPSTREAM_ERROR',
      message: 'Tarball download response is missing a Content-Type header.',
    });
  }
  const mediaType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_TARBALL_CONTENT_TYPES.has(mediaType)) {
    throw new TarballExtractionError({
      code: 'TARBALL_UPSTREAM_ERROR',
      message: `Unexpected tarball Content-Type: ${mediaType || '<empty>'}`,
    });
  }
}

class ByteLimitTransform extends Transform {
  totalBytes = 0;

  constructor(
    private readonly limitBytes: number,
    private readonly label: string,
    private readonly onLimitExceeded: (err: TarballExtractionError) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.limitBytes) {
      const err = new TarballExtractionError({
        code: 'TARBALL_SIZE_LIMIT_EXCEEDED',
        message: `${this.label} exceeded limit of ${this.limitBytes} bytes.`,
        details: { limitBytes: this.limitBytes, observedBytes: this.totalBytes },
      });
      this.onLimitExceeded(err);
      callback(err);
      return;
    }
    callback(null, chunk);
  }
}

function isAbortLikeError(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return true;
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return true;
  }
  return false;
}

async function fetchTarballStream(
  options: ExtractGitHubTarballOptions,
  signal: AbortSignal,
  abortTracker: ExtractionAbortTracker,
): Promise<NodeWebReadableStream<Uint8Array>> {
  if (isSignalAborted(signal)) {
    throw resolveAbortFailure(
      signal,
      abortTracker,
      'Timed out requesting tarball redirect from GitHub API.',
    );
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/tarball/${encodeURIComponent(options.commitSha)}`;

  const apiHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'archon-app',
  };
  if (options.token) {
    apiHeaders.Authorization = `Bearer ${options.token}`;
  }

  let redirectResponse: Response;
  try {
    redirectResponse = await fetchImpl(apiUrl, {
      method: 'GET',
      headers: apiHeaders,
      redirect: 'manual',
      signal,
    });
  } catch (err) {
    if (isAbortLikeError(err) || isSignalAborted(signal)) {
      throw resolveAbortFailure(
        signal,
        abortTracker,
        'Timed out requesting tarball redirect from GitHub API.',
        err,
      );
    }
    throw new TarballExtractionError({
      code: 'TARBALL_UPSTREAM_ERROR',
      message: 'Failed to reach GitHub API for tarball download.',
      cause: err,
    });
  }

  if (redirectResponse.status === 429 || redirectResponse.status === 403) {
    const remaining = redirectResponse.headers.get('x-ratelimit-remaining');
    const retryAfter = redirectResponse.headers.get('retry-after');
    if (redirectResponse.status === 429 || remaining === '0' || retryAfter !== null) {
      throw new TarballExtractionError({
        code: 'TARBALL_RATE_LIMITED',
        message: 'GitHub API rate limit reached while requesting tarball.',
        retryAfterSec: parseRetryAfterSec(redirectResponse),
      });
    }
  }

  if (redirectResponse.status < 300 || redirectResponse.status >= 400) {
    throw new TarballExtractionError({
      code: 'TARBALL_UPSTREAM_ERROR',
      message: `Expected redirect from GitHub tarball API, received HTTP ${redirectResponse.status}.`,
    });
  }

  const codeloadUrl = validateCodeloadRedirectUrl(redirectResponse.headers.get('location'));

  if (isSignalAborted(signal)) {
    throw resolveAbortFailure(signal, abortTracker, 'Timed out downloading repository tarball.');
  }

  // Second request: codeload.github.com ONLY, strictly NO Authorization header, no further redirects
  let archiveResponse: Response;
  try {
    archiveResponse = await fetchImpl(codeloadUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'archon-app',
        Accept: 'application/x-gzip, application/gzip, application/octet-stream',
      },
      redirect: 'manual',
      signal,
    });
  } catch (err) {
    if (isAbortLikeError(err) || isSignalAborted(signal)) {
      throw resolveAbortFailure(
        signal,
        abortTracker,
        'Timed out downloading repository tarball.',
        err,
      );
    }
    throw new TarballExtractionError({
      code: 'TARBALL_UPSTREAM_ERROR',
      message: 'Failed to download repository tarball from codeload.',
      cause: err,
    });
  }

  if (archiveResponse.status >= 300 && archiveResponse.status < 400) {
    throw new TarballExtractionError({
      code: 'TARBALL_REDIRECT_REJECTED',
      message: `Refusing secondary redirect (HTTP ${archiveResponse.status}) from codeload.`,
    });
  }

  if (archiveResponse.status !== 200) {
    throw new TarballExtractionError({
      code: 'TARBALL_UPSTREAM_ERROR',
      message: `Unexpected HTTP ${archiveResponse.status} downloading tarball from codeload.`,
    });
  }

  validateTarballContentType(archiveResponse.headers.get('content-type'));

  if (!archiveResponse.body) {
    throw new TarballExtractionError({
      code: 'TARBALL_UPSTREAM_ERROR',
      message: 'Tarball download response had an empty body.',
    });
  }

  if (isSignalAborted(signal)) {
    await archiveResponse.body.cancel().catch(() => undefined);
    throw resolveAbortFailure(signal, abortTracker, 'Timed out downloading repository tarball.');
  }

  return archiveResponse.body;
}

async function writeEntryToDisk(
  entry: ReadEntry,
  destinationPath: string,
  remainingFileBytes: number,
  remainingTotalBytes: number,
  signal: AbortSignal,
  abortTracker: ExtractionAbortTracker,
): Promise<number> {
  const absorbEntryError = (): void => {
    // Prevent unhandled 'error' events when parser.abort() tears down a read entry
  };
  const drainEntry = (): void => {
    entry.on('error', absorbEntryError);
    entry.resume();
  };

  if (isSignalAborted(signal)) {
    drainEntry();
    throw resolveAbortFailure(signal, abortTracker, 'Tarball extraction aborted or timed out.');
  }

  // Keep entry error absorbed while awaiting mkdir so parser.abort() during mkdir never crashes
  entry.on('error', absorbEntryError);
  await mkdir(path.dirname(destinationPath), { recursive: true });

  if (isSignalAborted(signal)) {
    drainEntry();
    throw resolveAbortFailure(signal, abortTracker, 'Tarball extraction aborted or timed out.');
  }

  return await new Promise<number>((resolve, reject) => {
    const out = createWriteStream(destinationPath, { flags: 'wx', autoClose: true });
    let bytesForThisFile = 0;
    let settled = false;
    let outcome:
      | { readonly ok: true; readonly bytes: number }
      | { readonly ok: false; readonly err: Error }
      | null = null;

    const cleanupListeners = (): void => {
      signal.removeEventListener('abort', onAbort);
      entry.removeListener('data', onEntryData);
      entry.removeListener('end', onEntryEnd);
      entry.removeListener('error', onEntryError);
      out.removeListener('drain', onOutDrain);
      out.removeListener('finish', onOutFinish);
      out.removeListener('error', onOutError);
      out.removeListener('close', onOutClose);
    };

    const settleAfterClose = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupListeners();
      entry.on('error', absorbEntryError);
      if (outcome === null) {
        reject(
          new TarballExtractionError({
            code: 'TARBALL_PARSE_ERROR',
            retryable: true,
            message: `Write stream closed unexpectedly for ${path.basename(destinationPath)}.`,
          }),
        );
        return;
      }
      if (outcome.ok) {
        resolve(outcome.bytes);
      } else {
        reject(outcome.err);
      }
    };

    const failAndClose = (err: Error): void => {
      outcome ??= { ok: false, err };
      entry.removeListener('data', onEntryData);
      entry.removeListener('end', onEntryEnd);
      entry.removeListener('error', onEntryError);
      entry.on('error', absorbEntryError);
      out.removeListener('drain', onOutDrain);
      // Resume entry if paused for backpressure so parser teardown never hangs
      entry.resume();
      if (!out.destroyed) {
        out.destroy();
      }
      if (out.closed) {
        settleAfterClose();
      }
    };

    const onAbort = (): void => {
      failAndClose(
        resolveAbortFailure(signal, abortTracker, 'Tarball extraction aborted or timed out.'),
      );
    };

    const onOutDrain = (): void => {
      if (outcome === null) {
        entry.resume();
      }
    };

    const onOutError = (err: Error): void => {
      failAndClose(
        new TarballExtractionError({
          code: 'TARBALL_PARSE_ERROR',
          retryable: true,
          message: `Failed writing extracted file ${path.basename(destinationPath)}.`,
          cause: err,
        }),
      );
    };

    const onOutFinish = (): void => {
      outcome ??= { ok: true, bytes: bytesForThisFile };
      if (out.closed) {
        settleAfterClose();
      }
    };

    const onOutClose = (): void => {
      settleAfterClose();
    };

    const onEntryError = (err: unknown): void => {
      failAndClose(
        err instanceof TarballExtractionError
          ? err
          : new TarballExtractionError({
              code: 'TARBALL_PARSE_ERROR',
              retryable: true,
              message: 'Error reading tar entry stream.',
              cause: err,
            }),
      );
    };

    const onEntryData = (chunk: Buffer): void => {
      if (outcome !== null) {
        return;
      }
      bytesForThisFile += chunk.length;

      if (bytesForThisFile > remainingFileBytes) {
        failAndClose(
          new TarballExtractionError({
            code: 'TARBALL_SIZE_LIMIT_EXCEEDED',
            message: `Tar entry exceeded declared size / per-file cap (${remainingFileBytes} bytes).`,
          }),
        );
        return;
      }
      if (bytesForThisFile > remainingTotalBytes) {
        failAndClose(
          new TarballExtractionError({
            code: 'TARBALL_SIZE_LIMIT_EXCEEDED',
            message: 'Total extracted file size exceeded maximum written bytes cap.',
          }),
        );
        return;
      }

      if (!out.write(chunk)) {
        entry.pause();
        out.once('drain', onOutDrain);
      }
    };

    const onEntryEnd = (): void => {
      if (outcome === null) {
        out.end();
      }
    };

    out.on('error', onOutError);
    out.on('finish', onOutFinish);
    out.on('close', onOutClose);
    entry.removeListener('error', absorbEntryError);
    entry.on('error', onEntryError);
    entry.on('data', onEntryData);
    entry.on('end', onEntryEnd);
    signal.addEventListener('abort', onAbort, { once: true });

    if (isSignalAborted(signal)) {
      onAbort();
      return;
    }

    entry.resume();
  });
}

async function extractTarballStreamIntoDir(
  bodyStream: NodeWebReadableStream<Uint8Array>,
  canonicalRootDir: string,
  caps: ResolvedCaps,
  abortController: AbortController,
  abortTracker: ExtractionAbortTracker,
): Promise<ExtractedRepoWorkspace> {
  const supportedFiles: string[] = [];
  const configFiles: string[] = [];
  const seenWritePaths = new Set<string>();
  const pendingWrites: Promise<void>[] = [];

  let writtenBytes = 0;
  let skippedFilesCount = 0;
  let oversizedSkippedFilesCount = 0;
  let oversizedSupportedFilesCount = 0;

  const state: { fatal: TarballExtractionError | null; topLevelPrefix: string | null } = {
    fatal: null,
    topLevelPrefix: null,
  };

  // Guard against cancellation/timeout arriving between fetch completion and stream setup
  if (isSignalAborted(abortController.signal)) {
    await bodyStream.cancel().catch(() => undefined);
    throw resolveAbortFailure(
      abortController.signal,
      abortTracker,
      'Tarball extraction timed out.',
    );
  }

  const triggerFatal = (err: TarballExtractionError, parser?: Parser): void => {
    abortTracker.firstError ??= err;
    state.fatal ??= abortTracker.firstError;
    if (!abortController.signal.aborted) {
      abortController.abort(abortTracker.firstError);
    }
    if (parser) {
      parser.abort(abortTracker.firstError);
    }
  };

  const compressedLimiter = new ByteLimitTransform(
    caps.maxCompressedBytes,
    'Compressed tarball',
    (err) => {
      triggerFatal(err);
    },
  );
  const decompressedLimiter = new ByteLimitTransform(
    caps.maxDecompressedBytes,
    'Decompressed tarball stream',
    (err) => {
      triggerFatal(err);
    },
  );

  const parser = new Parser({
    strict: true,
    noResume: true,
    gzip: false,
    brotli: false,
    zstd: false,
    maxMetaEntrySize: DEFAULT_MAX_META_ENTRY_SIZE,
    maxDecompressionRatio: DEFAULT_MAX_DECOMPRESSION_RATIO,
    onwarn: (code, message) => {
      triggerFatal(
        new TarballExtractionError({
          code: 'TARBALL_PARSE_ERROR',
          retryable: true,
          message: `Tar warning (${code}): ${message}`,
        }),
        parser,
      );
    },
    onReadEntry: (entry: ReadEntry) => {
      if (state.fatal !== null || abortTracker.firstError !== null) {
        entry.resume();
        return;
      }

      // 1. Strict reject any symlink, hardlink, device, FIFO, or special non-regular FS entry
      if (FORBIDDEN_SPECIAL_TYPES.has(entry.type)) {
        triggerFatal(
          new TarballExtractionError({
            code: 'TARBALL_SECURITY_VIOLATION',
            message: `Tar archive contains disallowed entry type "${entry.type}": ${entry.path}`,
          }),
          parser,
        );
        entry.resume();
        return;
      }

      // 2. Validate raw path and enforce single top-level folder prefix for ALL entries
      let parsedPath;
      try {
        parsedPath = parseAndValidateTarEntryPath(entry.path, state.topLevelPrefix);
      } catch (err) {
        const typedErr =
          err instanceof TarballExtractionError
            ? err
            : new TarballExtractionError({
                code: 'TARBALL_SECURITY_VIOLATION',
                message: 'Invalid tar entry path.',
                cause: err,
              });
        triggerFatal(typedErr, parser);
        entry.resume();
        return;
      }

      state.topLevelPrefix ??= parsedPath.topLevelPrefix;

      // 3. Directories and archive root folder: drain cleanly (we create dirs only for written files)
      if (entry.type === 'Directory' || parsedPath.relativePosixPath.length === 0) {
        entry.resume();
        return;
      }

      const relPosix = parsedPath.relativePosixPath;
      const isSupported = isSupportedSourcePath(relPosix);
      const isConfig = !isSupported && isRepoConfigPath(relPosix);
      const wouldWrite = isSupported || isConfig;

      // 4. Skipped paths: drain cleanly without Windows-reserved or invalid/unsupported failures
      if (!wouldWrite) {
        skippedFilesCount += 1;
        entry.resume();
        return;
      }

      // 5. Paths we would write: reject invalid/unsupported/non-regular entries
      if (entry.invalid || entry.unsupported || !REGULAR_FILE_TYPES.has(entry.type)) {
        triggerFatal(
          new TarballExtractionError({
            code: 'TARBALL_SECURITY_VIOLATION',
            message: `Refusing to write invalid or unsupported tar entry "${relPosix}" (type: ${entry.type}).`,
          }),
          parser,
        );
        entry.resume();
        return;
      }

      // 6. Enforce Windows-reserved-name / trailing-dot/space rules ONLY on paths we would write
      try {
        assertSafeWritePath(parsedPath.relativeSegments, relPosix);
      } catch (err) {
        const typedErr =
          err instanceof TarballExtractionError
            ? err
            : new TarballExtractionError({
                code: 'TARBALL_SECURITY_VIOLATION',
                message: `Unsafe write path: ${relPosix}`,
                cause: err,
              });
        triggerFatal(typedErr, parser);
        entry.resume();
        return;
      }

      // 7. Reject duplicate target paths (case-insensitive to prevent Windows collisions)
      const dedupeKey = relPosix.toLowerCase();
      if (seenWritePaths.has(dedupeKey)) {
        triggerFatal(
          new TarballExtractionError({
            code: 'TARBALL_SECURITY_VIOLATION',
            message: `Tar archive contains duplicate file path: ${relPosix}`,
          }),
          parser,
        );
        entry.resume();
        return;
      }

      // 8. Amendment (a): per-file oversize skips the file and counts in skippedFilesCount
      const declaredSize = entry.size;
      if (declaredSize > caps.maxFileBytes) {
        skippedFilesCount += 1;
        oversizedSkippedFilesCount += 1;
        if (isSupported) {
          oversizedSupportedFilesCount += 1;
        }
        entry.resume();
        return;
      }

      // 9. Total written bytes cap fails the entire extraction
      if (writtenBytes + declaredSize > caps.maxWrittenBytes) {
        triggerFatal(
          new TarballExtractionError({
            code: 'TARBALL_SIZE_LIMIT_EXCEEDED',
            message: `Total extracted size exceeds cap of ${caps.maxWrittenBytes} bytes.`,
            details: { maxWrittenBytes: caps.maxWrittenBytes },
          }),
          parser,
        );
        entry.resume();
        return;
      }

      // 10. File-count caps
      if (isSupported && supportedFiles.length + 1 > caps.maxSupportedFiles) {
        triggerFatal(
          new TarballExtractionError({
            code: 'TARBALL_FILE_LIMIT_EXCEEDED',
            message: `Supported TS/JS file count exceeds limit of ${caps.maxSupportedFiles}.`,
            details: { maxSupportedFiles: caps.maxSupportedFiles },
          }),
          parser,
        );
        entry.resume();
        return;
      }

      if (isConfig && configFiles.length + 1 > caps.maxConfigFiles) {
        triggerFatal(
          new TarballExtractionError({
            code: 'TARBALL_FILE_LIMIT_EXCEEDED',
            message: `Config file count exceeds limit of ${caps.maxConfigFiles}.`,
            details: { maxConfigFiles: caps.maxConfigFiles },
          }),
          parser,
        );
        entry.resume();
        return;
      }

      // 11. Build and verify safe destination path ourselves, then stream entry to disk
      let destinationPath: string;
      try {
        destinationPath = buildSafeDestinationPath(canonicalRootDir, parsedPath.relativeSegments);
      } catch (err) {
        const typedErr =
          err instanceof TarballExtractionError
            ? err
            : new TarballExtractionError({
                code: 'TARBALL_SECURITY_VIOLATION',
                message: `Unsafe destination path for ${relPosix}.`,
                cause: err,
              });
        triggerFatal(typedErr, parser);
        entry.resume();
        return;
      }

      seenWritePaths.add(dedupeKey);
      if (isSupported) {
        supportedFiles.push(relPosix);
      } else {
        configFiles.push(relPosix);
      }

      const remainingTotal = caps.maxWrittenBytes - writtenBytes;
      // Reserve declaredSize immediately so concurrent async writes cannot exceed maxWrittenBytes
      writtenBytes += declaredSize;

      const writePromise = writeEntryToDisk(
        entry,
        destinationPath,
        caps.maxFileBytes,
        remainingTotal,
        abortController.signal,
        abortTracker,
      )
        .then((actualBytes) => {
          // Adjust if actual bytes differed slightly from declaredSize
          writtenBytes += actualBytes - declaredSize;
        })
        .catch((err: unknown) => {
          const typedErr =
            err instanceof TarballExtractionError
              ? err
              : new TarballExtractionError({
                  code: 'TARBALL_PARSE_ERROR',
                  retryable: true,
                  message: `Failed writing entry ${relPosix}.`,
                  cause: err,
                });
          triggerFatal(typedErr, parser);
        });

      pendingWrites.push(writePromise);
    },
  });

  const parserDone = new Promise<void>((resolve, reject) => {
    parser.once('end', () => {
      resolve();
    });
    parser.once('error', (err: unknown) => {
      const typedErr =
        err instanceof TarballExtractionError
          ? err
          : new TarballExtractionError({
              code: 'TARBALL_PARSE_ERROR',
              retryable: false,
              message: 'Corrupt or invalid tar archive header.',
              cause: err,
            });
      state.fatal ??= typedErr;
      abortTracker.firstError ??= typedErr;
      reject(typedErr);
    });
  });

  parserDone.catch(() => undefined);

  const nodeReadable = Readable.fromWeb(bodyStream);
  const gunzip = createGunzip();

  const onAbort = (): void => {
    const err =
      state.fatal ??
      resolveAbortFailure(
        abortController.signal,
        abortTracker,
        'Tarball extraction aborted or timed out.',
      );
    nodeReadable.destroy(err);
    gunzip.destroy(err);
    parser.abort(err);
  };
  abortController.signal.addEventListener('abort', onAbort, { once: true });
  // Handle the case where abortController was already aborted before listener registration
  if (isSignalAborted(abortController.signal)) {
    onAbort();
  }

  const parserSink = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      if (state.fatal !== null) {
        callback(state.fatal);
        return;
      }
      parser.write(chunk);
      callback();
    },
    final(callback: (error?: Error | null) => void) {
      if (state.fatal !== null) {
        callback(state.fatal);
        return;
      }
      parser.end();
      parserDone
        .then(() => {
          callback();
        })
        .catch((err: unknown) => {
          callback(err instanceof Error ? err : new Error(String(err)));
        });
    },
  });

  try {
    await pipeline(nodeReadable, compressedLimiter, gunzip, decompressedLimiter, parserSink);
    await Promise.all(pendingWrites);
  } catch (err) {
    await Promise.allSettled(pendingWrites);
    if (abortTracker.firstError !== null) {
      throw abortTracker.firstError;
    }
    if (state.fatal !== null) {
      throw state.fatal;
    }
    if (err instanceof TarballExtractionError) {
      throw err;
    }
    if (isAbortLikeError(err) || isSignalAborted(abortController.signal)) {
      throw resolveAbortFailure(
        abortController.signal,
        abortTracker,
        'Tarball extraction timed out.',
        err,
      );
    }
    throw new TarballExtractionError({
      code: 'TARBALL_PARSE_ERROR',
      retryable: true,
      message: 'Failed to decompress or parse repository tarball.',
      cause: err,
    });
  } finally {
    abortController.signal.removeEventListener('abort', onAbort);
  }

  if (state.fatal !== null) {
    throw state.fatal;
  }

  const finalPrefix = state.topLevelPrefix;
  if (finalPrefix === null) {
    throw new TarballExtractionError({
      code: 'TARBALL_PARSE_ERROR',
      retryable: false,
      message: 'Tar archive was empty or missing a top-level folder.',
    });
  }

  supportedFiles.sort();
  configFiles.sort();

  return {
    rootDir: canonicalRootDir,
    topLevelPrefix: finalPrefix,
    supportedFiles,
    configFiles,
    stats: {
      compressedBytes: compressedLimiter.totalBytes,
      decompressedBytes: decompressedLimiter.totalBytes,
      writtenBytes,
      supportedFilesCount: supportedFiles.length,
      configFilesCount: configFiles.length,
      skippedFilesCount,
      oversizedSkippedFilesCount,
      oversizedSupportedFilesCount,
    },
  };
}

/**
 * Downloads and extracts a GitHub repository commit tarball into a fresh isolated temp directory,
 * executes `callback`, and purges the temp directory in `finally` ONLY AFTER `callback` settles.
 * External cancellation is distinguished from internal extraction timeout via `TARBALL_CANCELLED`
 * using a fixed safe message and first-abort precedence.
 */
export async function withExtractedRepo<T>(
  options: ExtractGitHubTarballOptions,
  callback: (workspace: ExtractedRepoWorkspace) => Promise<T>,
): Promise<T> {
  if (isSignalAborted(options.signal)) {
    throw createTarballCancelledError();
  }

  const caps = resolveCaps(options);
  const tempBaseDir = options.tempBaseDir ?? os.tmpdir();
  await mkdir(tempBaseDir, { recursive: true });

  if (isSignalAborted(options.signal)) {
    throw createTarballCancelledError();
  }

  const tempDir = await mkdtemp(path.join(tempBaseDir, 'archon-extract-'));

  const abortController = new AbortController();
  const abortTracker: ExtractionAbortTracker = { firstError: null };

  const abortWithFirst = (err: TarballExtractionError): void => {
    abortTracker.firstError ??= err;
    if (!abortController.signal.aborted) {
      abortController.abort(abortTracker.firstError);
    }
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = (): void => {
    abortWithFirst(createTarballCancelledError());
  };

  try {
    const canonicalRootDir = await realpath(tempDir);

    timeoutHandle = setTimeout(() => {
      abortWithFirst(
        createTarballTimeoutError(`Tarball extraction timed out after ${caps.timeoutMs} ms.`),
      );
    }, caps.timeoutMs);

    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
      if (isSignalAborted(options.signal)) {
        onExternalAbort();
      }
    }

    const bodyStream = await fetchTarballStream(options, abortController.signal, abortTracker);
    const workspace = await extractTarballStreamIntoDir(
      bodyStream,
      canonicalRootDir,
      caps,
      abortController,
      abortTracker,
    );
    clearTimeout(timeoutHandle);
    timeoutHandle = undefined;
    options.signal?.removeEventListener('abort', onExternalAbort);

    // Check internal deadline AND external cancellation before invoking callback
    if (abortTracker.firstError !== null) {
      throw abortTracker.firstError;
    }
    if (isSignalAborted(abortController.signal)) {
      throw resolveAbortFailure(
        abortController.signal,
        abortTracker,
        `Tarball extraction timed out after ${caps.timeoutMs} ms.`,
      );
    }
    if (isSignalAborted(options.signal)) {
      throw createTarballCancelledError();
    }

    return await callback(workspace);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    options.signal?.removeEventListener('abort', onExternalAbort);
    await rm(tempDir, { recursive: true, force: true });
  }
}
