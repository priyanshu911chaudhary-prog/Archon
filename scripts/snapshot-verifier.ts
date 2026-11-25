import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateRepoRelativePath } from '@archon/core';
import { isRepoConfigPath, isSupportedSourcePath } from '@archon/shared';
import {
  EvaluationError,
  compareCodePoint,
  extractFilePathFromQualifiedName,
  gitBlobSha1Hex,
  isRecord,
  parseJsonUnknown,
  sha256BufferHex,
  type GroundTruthManifest,
} from './eval-policy.js';

const HEX_40_RE = /^[0-9a-f]{40}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const REGULAR_GIT_MODES = new Set(['100644', '100755']);
const IGNORED_WALK_DIRS = new Set([
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '__snapshots__',
  '.git',
]);

export interface SourceBundleFileEntry {
  readonly path: string;
  readonly kind: 'source' | 'config';
  readonly gitBlobId: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ParsedSourceBundle {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly commitSha: string;
  readonly sourceCount: number;
  readonly configCount: number;
  readonly skippedSpecialEntries: number;
  readonly files: readonly SourceBundleFileEntry[];
}

export interface VerifiedSnapshot {
  readonly repository: string;
  readonly commitSha: string;
  readonly canonicalRoot: string;
  readonly supportedFiles: readonly string[];
  readonly configFiles: readonly string[];
  readonly totalSupportedBytes: number;
  readonly totalConfigBytes: number;
}

interface GitTreeEntry {
  readonly mode: string;
  readonly objectType: string;
  readonly gitBlobId: string;
  readonly path: string;
}

function isContainedInsideRoot(canonicalRoot: string, candidateCanonical: string): boolean {
  const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : `${canonicalRoot}${path.sep}`;
  return candidateCanonical.startsWith(prefix);
}

/**
 * Decodes already-verified raw snapshot bytes strictly for 1-indexed line-bound validation.
 * Supports UTF-8 (with or without BOM), UTF-16LE BOM (e.g. Payments `types_db.ts`), and UTF-16BE BOM.
 * Raw-byte SHA-256 and Git SHA-1 blob hashing remain completely independent of this decoding step.
 */
function decodeSourceTextForLineBounds(rawBuf: Buffer): string {
  if (rawBuf.byteLength >= 2 && rawBuf[0] === 0xff && rawBuf[1] === 0xfe) {
    return rawBuf.subarray(2).toString('utf16le');
  }
  if (rawBuf.byteLength >= 2 && rawBuf[0] === 0xfe && rawBuf[1] === 0xff) {
    const body = Buffer.from(rawBuf.subarray(2));
    const evenLength = body.byteLength - (body.byteLength % 2);
    return body.subarray(0, evenLength).swap16().toString('utf16le');
  }
  if (rawBuf.byteLength >= 3 && rawBuf[0] === 0xef && rawBuf[1] === 0xbb && rawBuf[2] === 0xbf) {
    return rawBuf.subarray(3).toString('utf8');
  }
  return rawBuf.toString('utf8');
}

/**
 * Counts 1-indexed source lines across LF, CRLF, and CR endings, ignoring a single trailing
 * EOF line terminator so an empty line after the final newline cannot mask an out-of-bounds line.
 */
function countSourceLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let end = text.length;
  if (text.charCodeAt(end - 1) === 10) {
    end -= 1;
    if (end > 0 && text.charCodeAt(end - 1) === 13) {
      end -= 1;
    }
  } else if (text.charCodeAt(end - 1) === 13) {
    end -= 1;
  }
  if (end === 0) {
    return 0;
  }

  let lines = 1;
  for (let i = 0; i < end; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      lines += 1;
    } else if (code === 13) {
      lines += 1;
      if (i + 1 < end && text.charCodeAt(i + 1) === 10) {
        i += 1;
      }
    }
  }
  return lines;
}

function runGitBuffer(repoRoot: string, args: readonly string[]): Buffer {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'buffer',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : 'unknown git error';
    throw new EvaluationError(`Git verification command failed (${args.join(' ')}): ${detail}`);
  }
}

function isInsideIgnoredDir(relPosixPath: string): boolean {
  const segments = relPosixPath.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (seg !== undefined && (seg === 'node_modules' || IGNORED_WALK_DIRS.has(seg))) {
      return true;
    }
  }
  return false;
}

function parseGitLsTree(rawOutput: Buffer): readonly GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  const text = rawOutput.toString('utf8');
  const records = text.split('\0');

  for (const record of records) {
    if (record.length === 0) {
      continue;
    }
    const tabIdx = record.indexOf('\t');
    if (tabIdx === -1) {
      throw new EvaluationError(`Malformed git ls-tree record: "${record}".`);
    }
    const meta = record.slice(0, tabIdx);
    const rawPath = record.slice(tabIdx + 1);
    const parts = meta.split(' ');
    const mode = parts[0];
    const objectType = parts[1];
    const gitBlobId = parts[2];

    if (
      parts.length !== 3 ||
      mode === undefined ||
      objectType === undefined ||
      gitBlobId === undefined ||
      !HEX_40_RE.test(gitBlobId)
    ) {
      throw new EvaluationError(`Malformed git ls-tree metadata: "${meta}".`);
    }

    const normalizedPath = validateRepoRelativePath(rawPath);
    entries.push({ mode, objectType, gitBlobId, path: normalizedPath });
  }

  return entries;
}

function parseSourceBundle(rawValue: unknown, bundlePath: string): ParsedSourceBundle {
  if (!isRecord(rawValue)) {
    throw new EvaluationError(`Source bundle "${bundlePath}" root must be a JSON object.`);
  }
  if (rawValue.schemaVersion !== 1) {
    throw new EvaluationError(`Source bundle "${bundlePath}" schemaVersion must be 1.`);
  }
  if (typeof rawValue.repository !== 'string' || rawValue.repository.trim().length === 0) {
    throw new EvaluationError(
      `Source bundle "${bundlePath}" repository must be a non-empty string.`,
    );
  }
  if (typeof rawValue.commitSha !== 'string' || !HEX_40_RE.test(rawValue.commitSha)) {
    throw new EvaluationError(`Source bundle "${bundlePath}" commitSha must be a 40-char hex SHA.`);
  }
  if (
    typeof rawValue.sourceCount !== 'number' ||
    !Number.isSafeInteger(rawValue.sourceCount) ||
    rawValue.sourceCount < 0
  ) {
    throw new EvaluationError(
      `Source bundle "${bundlePath}" sourceCount must be a non-negative integer.`,
    );
  }
  if (
    typeof rawValue.configCount !== 'number' ||
    !Number.isSafeInteger(rawValue.configCount) ||
    rawValue.configCount < 0
  ) {
    throw new EvaluationError(
      `Source bundle "${bundlePath}" configCount must be a non-negative integer.`,
    );
  }
  if (
    typeof rawValue.skippedSpecialEntries !== 'number' ||
    !Number.isSafeInteger(rawValue.skippedSpecialEntries) ||
    rawValue.skippedSpecialEntries < 0
  ) {
    throw new EvaluationError(
      `Source bundle "${bundlePath}" skippedSpecialEntries must be a non-negative integer.`,
    );
  }
  if (!Array.isArray(rawValue.files)) {
    throw new EvaluationError(`Source bundle "${bundlePath}" files must be an array.`);
  }

  const files: SourceBundleFileEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawValue.files.length; i += 1) {
    const item: unknown = rawValue.files[i];
    const ctx = `bundle.files[${String(i)}]`;
    if (!isRecord(item)) {
      throw new EvaluationError(`${ctx} must be an object.`);
    }
    if (typeof item.path !== 'string' || item.path.trim().length === 0) {
      throw new EvaluationError(`${ctx}.path must be a non-empty string.`);
    }
    const normalizedPath = validateRepoRelativePath(item.path);
    if (seen.has(normalizedPath)) {
      throw new EvaluationError(`Duplicate bundle file entry: "${normalizedPath}".`);
    }
    seen.add(normalizedPath);

    if (item.kind !== 'source' && item.kind !== 'config') {
      throw new EvaluationError(`${ctx}.kind must be "source" or "config".`);
    }
    if (typeof item.gitBlobId !== 'string' || !HEX_40_RE.test(item.gitBlobId)) {
      throw new EvaluationError(`${ctx}.gitBlobId must be a 40-char lowercase hex SHA-1.`);
    }
    if (typeof item.sha256 !== 'string' || !HEX_64_RE.test(item.sha256)) {
      throw new EvaluationError(`${ctx}.sha256 must be a 64-char lowercase hex SHA-256.`);
    }
    if (
      typeof item.byteLength !== 'number' ||
      !Number.isSafeInteger(item.byteLength) ||
      item.byteLength < 0
    ) {
      throw new EvaluationError(`${ctx}.byteLength must be a non-negative safe integer.`);
    }

    files.push({
      path: normalizedPath,
      kind: item.kind,
      gitBlobId: item.gitBlobId,
      sha256: item.sha256,
      byteLength: item.byteLength,
    });
  }

  return {
    schemaVersion: 1,
    repository: rawValue.repository,
    commitSha: rawValue.commitSha,
    sourceCount: rawValue.sourceCount,
    configCount: rawValue.configCount,
    skippedSpecialEntries: rawValue.skippedSpecialEntries,
    files,
  };
}

/**
 * Walks the local checkout independently of Git status so unexpected gitignored
 * supported source/config files, symlinks/reparse points, or `node_modules` directories
 * are explicitly detected and rejected.
 */
async function walkLocalSnapshotFiles(
  canonicalRoot: string,
): Promise<{ readonly supported: readonly string[]; readonly configs: readonly string[] }> {
  const supported: string[] = [];
  const configs: string[] = [];

  const walk = async (absDir: string, relPosix: string): Promise<void> => {
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => compareCodePoint(a.name, b.name));

    for (const entry of entries) {
      const nextRel = relPosix.length === 0 ? entry.name : `${relPosix}/${entry.name}`;
      const nextAbs = path.join(absDir, entry.name);

      if (entry.name === 'node_modules') {
        throw new EvaluationError(
          `Snapshot contains forbidden target dependencies directory "${nextRel}".`,
        );
      }
      if (entry.isDirectory() && IGNORED_WALK_DIRS.has(entry.name)) {
        continue;
      }

      const st = await lstat(nextAbs);
      if (st.isSymbolicLink()) {
        throw new EvaluationError(
          `Snapshot contains forbidden symbolic link or reparse point "${nextRel}".`,
        );
      }

      const canonicalEntry = await realpath(nextAbs);
      if (!isContainedInsideRoot(canonicalRoot, canonicalEntry)) {
        throw new EvaluationError(`Snapshot entry "${nextRel}" escapes canonical repository root.`);
      }

      if (st.isDirectory()) {
        await walk(nextAbs, nextRel);
        continue;
      }

      if (!st.isFile()) {
        continue;
      }

      const validatedRel = validateRepoRelativePath(nextRel);
      if (isSupportedSourcePath(validatedRel)) {
        supported.push(validatedRel);
      } else if (isRepoConfigPath(validatedRel)) {
        configs.push(validatedRel);
      }
    }
  };

  await walk(canonicalRoot, '');
  supported.sort(compareCodePoint);
  configs.sort(compareCodePoint);

  return { supported, configs };
}

/**
 * Authoritatively verifies a local pinned Git snapshot against:
 * 1. Exact Git HEAD SHA & clean working tree (`git rev-parse HEAD`, `git status --porcelain=v1 -z`).
 * 2. Authoritative Git tree entries (`git ls-tree -r -z HEAD`) — preventing a tampered external
 *    bundle with fabricated matching hashes from authenticating a modified checkout.
 * 3. External source bundle inventory & hashes cross-checked against the Git tree.
 * 4. Independent local filesystem walk catching unexpected gitignored files, symlinks, or `node_modules`.
 * 5. Raw original on-disk file bytes (SHA-256, Git SHA-1 blob hash, byte length) — never re-encoding
 *    non-UTF-8 source files such as UTF-16LE `types_db.ts`.
 * 6. Manifest annotated & referenced provenance records.
 */
export async function verifyPinnedSnapshot(options: {
  readonly repoRoot: string;
  readonly bundlePath: string;
  readonly manifest: GroundTruthManifest;
  readonly expectedSourceCount?: number;
  readonly expectedConfigCount?: number;
}): Promise<VerifiedSnapshot> {
  const { repoRoot, bundlePath, manifest } = options;

  const rootStat = await lstat(repoRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new EvaluationError(`Snapshot root "${repoRoot}" must be a regular directory.`);
  }
  const canonicalRoot = await realpath(repoRoot);

  // 1. Verify exact Git HEAD
  const actualHead = runGitBuffer(canonicalRoot, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (actualHead !== manifest.commitSha) {
    throw new EvaluationError(
      `Snapshot Git HEAD mismatch for ${manifest.repository}: expected ${manifest.commitSha}, got ${actualHead}.`,
    );
  }

  // 2. Verify clean Git working tree (no staged, modified, or untracked non-ignored files)
  const statusBuf = runGitBuffer(canonicalRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (statusBuf.byteLength > 0) {
    throw new EvaluationError(
      `Snapshot working tree is not clean for ${manifest.repository} (${canonicalRoot}).`,
    );
  }

  // 3. Parse authoritative Git tree from pinned HEAD
  const treeEntries = parseGitLsTree(runGitBuffer(canonicalRoot, ['ls-tree', '-r', '-z', 'HEAD']));
  const treeExpectedFiles = new Map<
    string,
    { readonly kind: 'source' | 'config'; readonly gitBlobId: string }
  >();

  for (const entry of treeEntries) {
    if (isInsideIgnoredDir(entry.path)) {
      continue;
    }
    const isSource = isSupportedSourcePath(entry.path);
    const isConfig = !isSource && isRepoConfigPath(entry.path);
    if (!isSource && !isConfig) {
      continue;
    }
    if (entry.objectType !== 'blob' || !REGULAR_GIT_MODES.has(entry.mode)) {
      throw new EvaluationError(
        `Authoritative Git tree entry "${entry.path}" has unsupported mode/type (${entry.mode} ${entry.objectType}).`,
      );
    }
    treeExpectedFiles.set(entry.path, {
      kind: isSource ? 'source' : 'config',
      gitBlobId: entry.gitBlobId,
    });
  }

  // 4. Load & cross-check external source bundle against authoritative Git tree
  const bundleRawText = await readFile(bundlePath, 'utf8');
  const bundle = parseSourceBundle(parseJsonUnknown(bundleRawText, bundlePath), bundlePath);

  if (bundle.repository !== manifest.repository) {
    throw new EvaluationError(
      `Bundle repository mismatch: expected "${manifest.repository}", got "${bundle.repository}".`,
    );
  }
  if (bundle.commitSha !== manifest.commitSha) {
    throw new EvaluationError(
      `Bundle commitSha mismatch: expected "${manifest.commitSha}", got "${bundle.commitSha}".`,
    );
  }
  if (bundle.skippedSpecialEntries !== 0) {
    throw new EvaluationError(
      `Bundle reports ${String(bundle.skippedSpecialEntries)} skipped special entries (expected 0).`,
    );
  }

  const bundleByPath = new Map<string, SourceBundleFileEntry>();
  let bundleSourceCount = 0;
  let bundleConfigCount = 0;
  for (const entry of bundle.files) {
    bundleByPath.set(entry.path, entry);
    if (entry.kind === 'source') {
      bundleSourceCount += 1;
    } else {
      bundleConfigCount += 1;
    }
  }

  if (bundleSourceCount !== bundle.sourceCount || bundleConfigCount !== bundle.configCount) {
    throw new EvaluationError(
      `Bundle header counts (${String(bundle.sourceCount)} source, ${String(bundle.configCount)} config) do not match entries (${String(bundleSourceCount)}, ${String(bundleConfigCount)}).`,
    );
  }

  if (
    options.expectedSourceCount !== undefined &&
    bundleSourceCount !== options.expectedSourceCount
  ) {
    throw new EvaluationError(
      `Expected ${String(options.expectedSourceCount)} supported source files, got ${String(bundleSourceCount)}.`,
    );
  }
  if (
    options.expectedConfigCount !== undefined &&
    bundleConfigCount !== options.expectedConfigCount
  ) {
    throw new EvaluationError(
      `Expected ${String(options.expectedConfigCount)} config files, got ${String(bundleConfigCount)}.`,
    );
  }

  // Cross-check exact 1:1 membership & Git blob IDs between Git tree and bundle
  if (treeExpectedFiles.size !== bundleByPath.size) {
    throw new EvaluationError(
      `Inventory count mismatch between git ls-tree HEAD (${String(treeExpectedFiles.size)}) and source bundle (${String(bundleByPath.size)}).`,
    );
  }
  for (const [relPath, treeMeta] of treeExpectedFiles.entries()) {
    const bundleEntry = bundleByPath.get(relPath);
    if (bundleEntry === undefined) {
      throw new EvaluationError(
        `Git tree file "${relPath}" is missing from source bundle "${bundlePath}".`,
      );
    }
    if (bundleEntry.kind !== treeMeta.kind) {
      throw new EvaluationError(
        `File kind mismatch for "${relPath}": git tree classified as ${treeMeta.kind}, bundle has ${bundleEntry.kind}.`,
      );
    }
    if (bundleEntry.gitBlobId !== treeMeta.gitBlobId) {
      throw new EvaluationError(
        `Git blob SHA-1 mismatch between git ls-tree HEAD (${treeMeta.gitBlobId}) and source bundle (${bundleEntry.gitBlobId}) for "${relPath}".`,
      );
    }
  }

  // 5. Walk local checkout to catch missing or unexpected gitignored files / symlinks
  const localWalk = await walkLocalSnapshotFiles(canonicalRoot);
  const localAll = new Set<string>([...localWalk.supported, ...localWalk.configs]);

  for (const localPath of localAll) {
    if (!treeExpectedFiles.has(localPath)) {
      throw new EvaluationError(
        `Unexpected supported/config file present in local checkout (possibly gitignored): "${localPath}".`,
      );
    }
  }
  for (const expectedPath of treeExpectedFiles.keys()) {
    if (!localAll.has(expectedPath)) {
      throw new EvaluationError(`Expected snapshot file missing on disk: "${expectedPath}".`);
    }
  }

  // 6. Verify raw on-disk bytes for EVERY inventoried source & config file (no UTF-8 re-encoding)
  const verifiedBytesMeta = new Map<
    string,
    {
      readonly kind: 'source' | 'config';
      readonly gitBlobId: string;
      readonly sha256: string;
      readonly byteLength: number;
      readonly lineCount: number;
    }
  >();
  let totalSupportedBytes = 0;
  let totalConfigBytes = 0;

  for (const [relPath, treeMeta] of treeExpectedFiles.entries()) {
    const bundleEntry = bundleByPath.get(relPath);
    if (bundleEntry === undefined) {
      throw new EvaluationError(`Missing bundle entry for "${relPath}".`);
    }
    const absPath = path.resolve(canonicalRoot, ...relPath.split('/'));
    const canonicalFile = await realpath(absPath);
    if (!isContainedInsideRoot(canonicalRoot, canonicalFile)) {
      throw new EvaluationError(`File "${relPath}" resolves outside snapshot root.`);
    }
    const fileStat = await lstat(absPath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new EvaluationError(`File "${relPath}" is not a regular file.`);
    }

    const rawBuf = await readFile(canonicalFile);
    const actualSha256 = sha256BufferHex(rawBuf);
    const actualBlobId = gitBlobSha1Hex(rawBuf);

    if (rawBuf.byteLength !== bundleEntry.byteLength) {
      throw new EvaluationError(
        `Byte length mismatch on disk for "${relPath}": expected ${String(bundleEntry.byteLength)}, got ${String(rawBuf.byteLength)}.`,
      );
    }
    if (actualSha256 !== bundleEntry.sha256) {
      throw new EvaluationError(
        `Raw-byte SHA-256 mismatch on disk for "${relPath}": expected ${bundleEntry.sha256}, got ${actualSha256}.`,
      );
    }
    if (actualBlobId !== treeMeta.gitBlobId || actualBlobId !== bundleEntry.gitBlobId) {
      throw new EvaluationError(
        `Git blob SHA-1 mismatch on disk for "${relPath}": tree=${treeMeta.gitBlobId}, bundle=${bundleEntry.gitBlobId}, disk=${actualBlobId}.`,
      );
    }

    const lineCount = countSourceLines(decodeSourceTextForLineBounds(rawBuf));

    verifiedBytesMeta.set(relPath, {
      kind: treeMeta.kind,
      gitBlobId: actualBlobId,
      sha256: actualSha256,
      byteLength: rawBuf.byteLength,
      lineCount,
    });

    if (treeMeta.kind === 'source') {
      totalSupportedBytes += rawBuf.byteLength;
    } else {
      totalConfigBytes += rawBuf.byteLength;
    }
  }

  // 7. Verify all manifest provenance records against the verified raw-byte disk inventory
  for (const rec of [
    ...manifest.annotatedFileProvenance,
    ...manifest.referencedTargetAndConfigProvenance,
  ]) {
    const diskMeta = verifiedBytesMeta.get(rec.path);
    if (diskMeta === undefined) {
      throw new EvaluationError(
        `Manifest provenance path "${rec.path}" was not found in verified snapshot inventory.`,
      );
    }
    if (
      diskMeta.gitBlobId !== rec.gitBlobId ||
      diskMeta.sha256 !== rec.sha256 ||
      diskMeta.byteLength !== rec.byteLength
    ) {
      throw new EvaluationError(
        `Manifest provenance mismatch for "${rec.path}" against verified raw snapshot bytes.`,
      );
    }
  }

  // 8. Verify selectedSourceFiles classification and manifest source-line bounds against verified snapshot files
  for (const selectedPath of manifest.selectedSourceFiles) {
    const diskMeta = verifiedBytesMeta.get(selectedPath);
    if (diskMeta === undefined) {
      throw new EvaluationError(
        `Selected source file "${selectedPath}" was not found in verified snapshot inventory.`,
      );
    }
    if (diskMeta.kind !== 'source') {
      throw new EvaluationError(
        `Selected file "${selectedPath}" is classified as "${diskMeta.kind}", expected supported "source".`,
      );
    }
  }

  for (const expectedCall of manifest.expectedCalls) {
    const sourceFile = extractFilePathFromQualifiedName(expectedCall.sourceQualifiedName);
    const srcMeta = verifiedBytesMeta.get(sourceFile);
    if (srcMeta?.kind !== 'source') {
      throw new EvaluationError(
        `Expected CALLS source file "${sourceFile}" is not a verified supported source file.`,
      );
    }
    if (expectedCall.callSiteLine < 1 || expectedCall.callSiteLine > srcMeta.lineCount) {
      throw new EvaluationError(
        `Expected CALLS callSiteLine ${String(expectedCall.callSiteLine)} is out of bounds for "${sourceFile}" (${String(srcMeta.lineCount)} lines).`,
      );
    }
  }

  for (const candidate of manifest.excludedOrUncertainCandidates) {
    const fileMeta = verifiedBytesMeta.get(candidate.filePath);
    if (fileMeta?.kind !== 'source') {
      throw new EvaluationError(
        `Manifest ${candidate.classification} record file "${candidate.filePath}" is not a verified supported source file.`,
      );
    }
    if (candidate.line < 1 || candidate.line > fileMeta.lineCount) {
      throw new EvaluationError(
        `Manifest ${candidate.classification} record line ${String(candidate.line)} is out of bounds for "${candidate.filePath}" (${String(fileMeta.lineCount)} lines).`,
      );
    }
  }

  return {
    repository: manifest.repository,
    commitSha: manifest.commitSha,
    canonicalRoot,
    supportedFiles: localWalk.supported,
    configFiles: localWalk.configs,
    totalSupportedBytes,
    totalConfigBytes,
  };
}
