import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  analyzeRepository,
  DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
  type AnalysisInput,
  type AnalysisStats,
} from '@archon/core';
import {
  EvaluationError,
  FROZEN_EVAL_REPOS,
  RECALL_TARGET_THRESHOLD,
  aggregateRepositoryScores,
  compareCodePoint,
  formatCallIdentity,
  formatImportIdentity,
  formatPercent,
  isFrozenRepoId,
  isRecord,
  meetsRecallTarget,
  parseJsonUnknown,
  scoreRepositoryAnalysis,
  serializeCallIdentity,
  verifyAndLoadFrozenManifest,
  type AggregateEvaluationMetrics,
  type CanonicalCallIdentity,
  type CanonicalImportIdentity,
  type EdgeSetMetrics,
  type FrozenRepoId,
  type FrozenRepoSpec,
  type RepositoryScoreResult,
} from './eval-policy.js';
import { verifyPinnedSnapshot } from './snapshot-verifier.js';

const HEX_64_RE = /^[0-9a-f]{64}$/;
const RATIO_EPSILON = 1e-12;
const OFFICIAL_BASELINE_REPOS: readonly FrozenRepoId[] = [
  'zustand',
  'nextjs-subscription-payments',
  'taxonomy',
];
const OFFICIAL_BASELINE_REPETITIONS_PER_REPO = 3;

export type EvaluationReportMode = 'baseline' | 'partial';

export interface BuildAggregatedReportOptions {
  /** Defaults to `'baseline'` (strict 3 repos × 3 runs, `skipLoadingLibFiles: false`). */
  readonly mode?: EvaluationReportMode;
}

export interface RecordedAnalysisWarning {
  readonly code: string;
  readonly filePath: string;
  readonly message: string;
  readonly line?: number;
}

export interface MemoryObservation {
  readonly baselineHeapUsedBytes: number;
  readonly postAnalysisHeapUsedBytes: number;
  readonly baselineRssBytes: number;
  readonly postAnalysisRssBytes: number;
  /**
   * Process-lifetime high-water RSS reported by Node's `process.resourceUsage().maxRSS` (in KiB).
   * Explicitly NOT isolated analyzer peak RSS; definitive subprocess peak-RSS belongs to Step 4.3.
   */
  readonly processLifetimeMaxRssKiB: number;
}

export interface RuntimeEnvironmentMetadata {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly osRelease: string;
  readonly arch: string;
  readonly bundledTypeScriptVersion: string;
}

export interface RecordedAnalysisOptions {
  readonly skipLoadingLibFiles: boolean;
  readonly maxCallSiteSnippetChars: number;
}

export interface SingleRepoRunRecord {
  readonly schemaVersion: 1;
  readonly repoId: FrozenRepoId;
  readonly manifestRelativePath: string;
  readonly manifestSha256: string;
  readonly analysisOptions: RecordedAnalysisOptions;
  readonly environment: RuntimeEnvironmentMetadata;
  readonly snapshotInventory: {
    readonly supportedFilesCount: number;
    readonly configFilesCount: number;
    readonly totalSupportedBytes: number;
    readonly totalConfigBytes: number;
  };
  readonly analysisDurationMs: number;
  readonly memory: MemoryObservation;
  readonly stats: AnalysisStats;
  readonly warnings: readonly RecordedAnalysisWarning[];
  readonly score: RepositoryScoreResult;
}

export interface MultiRunRepositorySummary {
  readonly repoId: FrozenRepoId;
  readonly repository: string;
  readonly commitSha: string;
  readonly runCount: number;
  readonly deterministicAcrossRuns: boolean;
  readonly graphDigest: string;
  readonly durationsMs: readonly number[];
  readonly medianDurationMs: number;
  readonly representativeRun: SingleRepoRunRecord;
}

export interface AggregatedEvaluationReport {
  readonly reportMode: EvaluationReportMode;
  readonly generatedAtIso: string;
  readonly recallTargetThreshold: number;
  readonly analysisOptions: RecordedAnalysisOptions;
  readonly environment: RuntimeEnvironmentMetadata;
  readonly repositories: readonly MultiRunRepositorySummary[];
  readonly aggregate: AggregateEvaluationMetrics;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const ARCHON_ROOT = path.resolve(MODULE_DIR, path.basename(MODULE_DIR) === 'dist' ? '../..' : '..');

/**
 * Resolves ts-morph's bundled TypeScript version through `@archon/core`'s dependency context
 * without adding a direct root dependency on `ts-morph` or confusing it with root `typescript`.
 */
export async function resolveBundledTypeScriptVersion(): Promise<string> {
  try {
    const corePkgUrl = pathToFileURL(path.join(ARCHON_ROOT, 'packages', 'core', 'package.json'));
    const coreRequire = createRequire(corePkgUrl);
    const tsMorphEntry = coreRequire.resolve('ts-morph');
    const loaded: unknown = await import(pathToFileURL(tsMorphEntry).href);
    if (isRecord(loaded) && isRecord(loaded.ts) && typeof loaded.ts.version === 'string') {
      return loaded.ts.version;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function computeMedian(values: readonly number[]): number {
  if (values.length === 0) {
    throw new EvaluationError('Cannot compute median of empty values array.');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  const lower = sorted[mid - 1] ?? 0;
  const upper = sorted[mid] ?? 0;
  return (lower + upper) / 2;
}

/**
 * Runs one isolated verification + full-repository analysis + scoring pass for a pinned repo.
 * Uses default `analyzeRepository` workspace discovery across the entire verified snapshot
 * (never filtering discovery to only the selected files).
 */
export async function runSingleRepositoryEvaluation(options: {
  readonly repoId: FrozenRepoId;
  readonly repoRoot: string;
  readonly bundlePath: string;
  readonly skipLoadingLibFiles?: boolean;
  readonly maxCallSiteSnippetChars?: number;
  readonly archonRoot?: string;
}): Promise<SingleRepoRunRecord> {
  const spec: FrozenRepoSpec = FROZEN_EVAL_REPOS[options.repoId];
  const archonRoot = options.archonRoot ?? ARCHON_ROOT;
  const manifestPath = path.resolve(archonRoot, ...spec.manifestRelativePath.split('/'));

  const skipLoadingLibFiles = options.skipLoadingLibFiles ?? false;
  const maxCallSiteSnippetChars =
    options.maxCallSiteSnippetChars ?? DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS;

  // Step 1: Verify frozen manifest SHA-256 and strict schema before touching snapshot
  const { manifest, actualSha256 } = await verifyAndLoadFrozenManifest(
    manifestPath,
    spec.manifestSha256,
    spec,
  );

  // Step 2: Authoritatively verify local snapshot (Git HEAD, clean tree, ls-tree, bundle, raw bytes)
  const snapshot = await verifyPinnedSnapshot({
    repoRoot: options.repoRoot,
    bundlePath: options.bundlePath,
    manifest,
    expectedSourceCount: spec.inventoriedSourceCount,
    expectedConfigCount: spec.inventoriedConfigCount,
  });

  const bundledTypeScriptVersion = await resolveBundledTypeScriptVersion();

  const analysisInput: AnalysisInput = {
    rootDir: snapshot.canonicalRoot,
    skipLoadingLibFiles,
    maxCallSiteSnippetChars,
  };

  // Step 3: Measure analysis duration & before/after memory separately from verification/reporting
  const baselineMem = process.memoryUsage();
  const startTime = performance.now();
  const output = await analyzeRepository(analysisInput);
  const analysisDurationMs = Number((performance.now() - startTime).toFixed(2));
  const postMem = process.memoryUsage();
  const maxRssKiB = process.resourceUsage().maxRSS;

  // Step 4: Validate graph integrity and compute exact metrics
  const score = scoreRepositoryAnalysis({
    manifest,
    output,
    wrapperExtensionCalls: spec.wrapperExtensionCalls,
    maxCallSiteSnippetChars,
  });

  return {
    schemaVersion: 1,
    repoId: spec.id,
    manifestRelativePath: spec.manifestRelativePath,
    manifestSha256: actualSha256,
    analysisOptions: {
      skipLoadingLibFiles,
      maxCallSiteSnippetChars,
    },
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      bundledTypeScriptVersion,
    },
    snapshotInventory: {
      supportedFilesCount: snapshot.supportedFiles.length,
      configFilesCount: snapshot.configFiles.length,
      totalSupportedBytes: snapshot.totalSupportedBytes,
      totalConfigBytes: snapshot.totalConfigBytes,
    },
    analysisDurationMs,
    memory: {
      baselineHeapUsedBytes: baselineMem.heapUsed,
      postAnalysisHeapUsedBytes: postMem.heapUsed,
      baselineRssBytes: baselineMem.rss,
      postAnalysisRssBytes: postMem.rss,
      processLifetimeMaxRssKiB: maxRssKiB,
    },
    stats: output.stats,
    warnings: output.warnings,
    score,
  };
}

/**
 * Aggregates multiple fresh-process run records, verifying byte-for-byte graph determinism
 * across repetitions for each repository and micro-averaging raw counts across repositories.
 */
function readNonEmptyStr(obj: Record<string, unknown>, field: string, ctx: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EvaluationError(`${ctx}.${field} must be a non-empty string.`);
  }
  return value;
}

function readBoolean(obj: Record<string, unknown>, field: string, ctx: string): boolean {
  const value = obj[field];
  if (typeof value !== 'boolean') {
    throw new EvaluationError(`${ctx}.${field} must be a boolean.`);
  }
  return value;
}

function readNonNegativeFiniteNum(
  obj: Record<string, unknown>,
  field: string,
  ctx: string,
): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new EvaluationError(`${ctx}.${field} must be a finite non-negative number.`);
  }
  return value;
}

function readNonNegativeSafeInt(obj: Record<string, unknown>, field: string, ctx: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new EvaluationError(`${ctx}.${field} must be a non-negative safe integer.`);
  }
  return value;
}

function readPositiveSafeInt(obj: Record<string, unknown>, field: string, ctx: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new EvaluationError(`${ctx}.${field} must be a positive safe integer.`);
  }
  return value;
}

function assertRatioMatches(
  actual: unknown,
  expected: number | null,
  field: string,
  ctx: string,
): number | null {
  if (expected === null) {
    if (actual !== null) {
      throw new EvaluationError(`${ctx}.${field} must be null when denominator is zero.`);
    }
    return null;
  }
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    throw new EvaluationError(`${ctx}.${field} must be a finite number.`);
  }
  if (Math.abs(actual - expected) > RATIO_EPSILON) {
    throw new EvaluationError(
      `${ctx}.${field} (${String(actual)}) is inconsistent with raw counts (expected ${String(expected)}).`,
    );
  }
  return actual;
}

function parseImportIdentityArray(raw: unknown, ctx: string): readonly CanonicalImportIdentity[] {
  if (!Array.isArray(raw)) {
    throw new EvaluationError(`${ctx} must be an array.`);
  }
  const result: CanonicalImportIdentity[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item: unknown = raw[i];
    const itemCtx = `${ctx}[${String(i)}]`;
    if (!isRecord(item)) {
      throw new EvaluationError(`${itemCtx} must be an object.`);
    }
    if (item.edgeType !== 'IMPORTS') {
      throw new EvaluationError(`${itemCtx}.edgeType must be "IMPORTS".`);
    }
    result.push({
      sourceQualifiedName: readNonEmptyStr(item, 'sourceQualifiedName', itemCtx),
      targetQualifiedName: readNonEmptyStr(item, 'targetQualifiedName', itemCtx),
      edgeType: 'IMPORTS',
    });
  }
  return result;
}

function parseCallIdentityArray(raw: unknown, ctx: string): readonly CanonicalCallIdentity[] {
  if (!Array.isArray(raw)) {
    throw new EvaluationError(`${ctx} must be an array.`);
  }
  const result: CanonicalCallIdentity[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item: unknown = raw[i];
    const itemCtx = `${ctx}[${String(i)}]`;
    if (!isRecord(item)) {
      throw new EvaluationError(`${itemCtx} must be an object.`);
    }
    if (item.edgeType !== 'CALLS') {
      throw new EvaluationError(`${itemCtx}.edgeType must be "CALLS".`);
    }
    result.push({
      sourceQualifiedName: readNonEmptyStr(item, 'sourceQualifiedName', itemCtx),
      targetQualifiedName: readNonEmptyStr(item, 'targetQualifiedName', itemCtx),
      edgeType: 'CALLS',
      callSiteLine: readPositiveSafeInt(item, 'callSiteLine', itemCtx),
    });
  }
  return result;
}

function parseAndValidateEdgeSetMetrics<T>(
  raw: unknown,
  ctx: string,
  parseItems: (value: unknown, arrayCtx: string) => readonly T[],
): EdgeSetMetrics<T> {
  if (!isRecord(raw)) {
    throw new EvaluationError(`${ctx} must be an object.`);
  }
  const expectedCount = readNonNegativeSafeInt(raw, 'expectedCount', ctx);
  const predictedCount = readNonNegativeSafeInt(raw, 'predictedCount', ctx);
  const tp = readNonNegativeSafeInt(raw, 'tp', ctx);
  const fp = readNonNegativeSafeInt(raw, 'fp', ctx);
  const fn = readNonNegativeSafeInt(raw, 'fn', ctx);
  const duplicateExpectedCount = readNonNegativeSafeInt(raw, 'duplicateExpectedCount', ctx);
  const duplicatePredictedCount = readNonNegativeSafeInt(raw, 'duplicatePredictedCount', ctx);
  const falsePositives = parseItems(raw.falsePositives, `${ctx}.falsePositives`);
  const falseNegatives = parseItems(raw.falseNegatives, `${ctx}.falseNegatives`);

  if (tp + fn !== expectedCount) {
    throw new EvaluationError(
      `${ctx} arithmetic mismatch: tp (${String(tp)}) + fn (${String(fn)}) !== expectedCount (${String(expectedCount)}).`,
    );
  }
  if (tp + fp !== predictedCount) {
    throw new EvaluationError(
      `${ctx} arithmetic mismatch: tp (${String(tp)}) + fp (${String(fp)}) !== predictedCount (${String(predictedCount)}).`,
    );
  }
  if (fp !== falsePositives.length) {
    throw new EvaluationError(
      `${ctx}.fp (${String(fp)}) does not match falsePositives.length (${String(falsePositives.length)}).`,
    );
  }
  if (fn !== falseNegatives.length) {
    throw new EvaluationError(
      `${ctx}.fn (${String(fn)}) does not match falseNegatives.length (${String(falseNegatives.length)}).`,
    );
  }

  const expectedPrecision = tp + fp === 0 ? null : tp / (tp + fp);
  const expectedRecall = tp + fn === 0 ? null : tp / (tp + fn);
  const expectedF1 = 2 * tp + fp + fn === 0 ? null : (2 * tp) / (2 * tp + fp + fn);

  const precision = assertRatioMatches(raw.precision, expectedPrecision, 'precision', ctx);
  const recall = assertRatioMatches(raw.recall, expectedRecall, 'recall', ctx);
  const f1 = assertRatioMatches(raw.f1, expectedF1, 'f1', ctx);

  return {
    expectedCount,
    predictedCount,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    duplicateExpectedCount,
    duplicatePredictedCount,
    falsePositives,
    falseNegatives,
  };
}

function parseAndValidateAnalysisStats(raw: unknown, ctx: string): AnalysisStats {
  if (!isRecord(raw)) {
    throw new EvaluationError(`${ctx} must be an object.`);
  }
  return {
    discoveredFilesCount: readNonNegativeSafeInt(raw, 'discoveredFilesCount', ctx),
    parsedFilesCount: readNonNegativeSafeInt(raw, 'parsedFilesCount', ctx),
    skippedSyntaxErrorFilesCount: readNonNegativeSafeInt(raw, 'skippedSyntaxErrorFilesCount', ctx),
    skippedOversizedFilesCount: readNonNegativeSafeInt(raw, 'skippedOversizedFilesCount', ctx),
    configFilesCount: readNonNegativeSafeInt(raw, 'configFilesCount', ctx),
    folderNodeCount: readNonNegativeSafeInt(raw, 'folderNodeCount', ctx),
    fileNodeCount: readNonNegativeSafeInt(raw, 'fileNodeCount', ctx),
    functionNodeCount: readNonNegativeSafeInt(raw, 'functionNodeCount', ctx),
    classNodeCount: readNonNegativeSafeInt(raw, 'classNodeCount', ctx),
    symbolNodeCount: readNonNegativeSafeInt(raw, 'symbolNodeCount', ctx),
    importsEdgeCount: readNonNegativeSafeInt(raw, 'importsEdgeCount', ctx),
    callsEdgeCount: readNonNegativeSafeInt(raw, 'callsEdgeCount', ctx),
    totalBytesRead: readNonNegativeSafeInt(raw, 'totalBytesRead', ctx),
    truncatedWarningsCount: readNonNegativeSafeInt(raw, 'truncatedWarningsCount', ctx),
  };
}

function parseAndValidateWarnings(raw: unknown, ctx: string): readonly RecordedAnalysisWarning[] {
  if (!Array.isArray(raw)) {
    throw new EvaluationError(`${ctx} must be an array.`);
  }
  const result: RecordedAnalysisWarning[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item: unknown = raw[i];
    const itemCtx = `${ctx}[${String(i)}]`;
    if (!isRecord(item)) {
      throw new EvaluationError(`${itemCtx} must be an object.`);
    }
    const code = readNonEmptyStr(item, 'code', itemCtx);
    const filePath = readNonEmptyStr(item, 'filePath', itemCtx);
    const message = readNonEmptyStr(item, 'message', itemCtx);
    if (item.line !== undefined) {
      const line = readPositiveSafeInt(item, 'line', itemCtx);
      result.push({ code, filePath, message, line });
    } else {
      result.push({ code, filePath, message });
    }
  }
  return result;
}

/**
 * Strictly validates an unknown JSON value into a trusted `SingleRepoRunRecord`:
 * checks frozen repo/manifest/commit provenance, finite non-negative timing & memory,
 * exact frozen denominator counts, graph integrity, and TP/FP/FN arithmetic consistency.
 */
export function parseAndValidateRunRecord(raw: unknown, label: string): SingleRepoRunRecord {
  if (!isRecord(raw)) {
    throw new EvaluationError(`${label} must be a JSON object.`);
  }
  if (raw.schemaVersion !== 1) {
    throw new EvaluationError(`${label}.schemaVersion must be 1.`);
  }

  const repoIdRaw = readNonEmptyStr(raw, 'repoId', label);
  if (!isFrozenRepoId(repoIdRaw)) {
    throw new EvaluationError(
      `${label}.repoId "${repoIdRaw}" is not an approved frozen repository.`,
    );
  }
  const spec = FROZEN_EVAL_REPOS[repoIdRaw];

  const manifestRelativePath = readNonEmptyStr(raw, 'manifestRelativePath', label);
  if (manifestRelativePath !== spec.manifestRelativePath) {
    throw new EvaluationError(
      `${label}.manifestRelativePath mismatch: expected "${spec.manifestRelativePath}", got "${manifestRelativePath}".`,
    );
  }

  const manifestSha256 = readNonEmptyStr(raw, 'manifestSha256', label);
  if (manifestSha256 !== spec.manifestSha256) {
    throw new EvaluationError(
      `${label}.manifestSha256 mismatch for "${spec.id}": expected ${spec.manifestSha256}, got ${manifestSha256}.`,
    );
  }

  if (!isRecord(raw.analysisOptions)) {
    throw new EvaluationError(`${label}.analysisOptions must be an object.`);
  }
  const analysisOptions: RecordedAnalysisOptions = {
    skipLoadingLibFiles: readBoolean(
      raw.analysisOptions,
      'skipLoadingLibFiles',
      `${label}.analysisOptions`,
    ),
    maxCallSiteSnippetChars: readNonNegativeSafeInt(
      raw.analysisOptions,
      'maxCallSiteSnippetChars',
      `${label}.analysisOptions`,
    ),
  };

  if (!isRecord(raw.environment)) {
    throw new EvaluationError(`${label}.environment must be an object.`);
  }
  const environment: RuntimeEnvironmentMetadata = {
    nodeVersion: readNonEmptyStr(raw.environment, 'nodeVersion', `${label}.environment`),
    platform: readNonEmptyStr(raw.environment, 'platform', `${label}.environment`),
    osRelease: readNonEmptyStr(raw.environment, 'osRelease', `${label}.environment`),
    arch: readNonEmptyStr(raw.environment, 'arch', `${label}.environment`),
    bundledTypeScriptVersion: readNonEmptyStr(
      raw.environment,
      'bundledTypeScriptVersion',
      `${label}.environment`,
    ),
  };

  if (!isRecord(raw.snapshotInventory)) {
    throw new EvaluationError(`${label}.snapshotInventory must be an object.`);
  }
  const snapshotInventory = {
    supportedFilesCount: readNonNegativeSafeInt(
      raw.snapshotInventory,
      'supportedFilesCount',
      `${label}.snapshotInventory`,
    ),
    configFilesCount: readNonNegativeSafeInt(
      raw.snapshotInventory,
      'configFilesCount',
      `${label}.snapshotInventory`,
    ),
    totalSupportedBytes: readNonNegativeSafeInt(
      raw.snapshotInventory,
      'totalSupportedBytes',
      `${label}.snapshotInventory`,
    ),
    totalConfigBytes: readNonNegativeSafeInt(
      raw.snapshotInventory,
      'totalConfigBytes',
      `${label}.snapshotInventory`,
    ),
  };
  if (
    snapshotInventory.supportedFilesCount !== spec.inventoriedSourceCount ||
    snapshotInventory.configFilesCount !== spec.inventoriedConfigCount
  ) {
    throw new EvaluationError(
      `${label}.snapshotInventory counts (${String(snapshotInventory.supportedFilesCount)}/${String(snapshotInventory.configFilesCount)}) do not match frozen baseline (${String(spec.inventoriedSourceCount)}/${String(spec.inventoriedConfigCount)}).`,
    );
  }

  const analysisDurationMs = readNonNegativeFiniteNum(raw, 'analysisDurationMs', label);

  if (!isRecord(raw.memory)) {
    throw new EvaluationError(`${label}.memory must be an object.`);
  }
  const memory: MemoryObservation = {
    baselineHeapUsedBytes: readNonNegativeFiniteNum(
      raw.memory,
      'baselineHeapUsedBytes',
      `${label}.memory`,
    ),
    postAnalysisHeapUsedBytes: readNonNegativeFiniteNum(
      raw.memory,
      'postAnalysisHeapUsedBytes',
      `${label}.memory`,
    ),
    baselineRssBytes: readNonNegativeFiniteNum(raw.memory, 'baselineRssBytes', `${label}.memory`),
    postAnalysisRssBytes: readNonNegativeFiniteNum(
      raw.memory,
      'postAnalysisRssBytes',
      `${label}.memory`,
    ),
    processLifetimeMaxRssKiB: readNonNegativeFiniteNum(
      raw.memory,
      'processLifetimeMaxRssKiB',
      `${label}.memory`,
    ),
  };

  const stats = parseAndValidateAnalysisStats(raw.stats, `${label}.stats`);
  const warnings = parseAndValidateWarnings(raw.warnings, `${label}.warnings`);

  if (!isRecord(raw.score)) {
    throw new EvaluationError(`${label}.score must be an object.`);
  }
  const scoreCtx = `${label}.score`;
  const repository = readNonEmptyStr(raw.score, 'repository', scoreCtx);
  if (repository !== spec.repository) {
    throw new EvaluationError(
      `${scoreCtx}.repository mismatch: expected "${spec.repository}", got "${repository}".`,
    );
  }
  const commitSha = readNonEmptyStr(raw.score, 'commitSha', scoreCtx);
  if (commitSha !== spec.commitSha) {
    throw new EvaluationError(
      `${scoreCtx}.commitSha mismatch: expected "${spec.commitSha}", got "${commitSha}".`,
    );
  }
  const annotatedFilesCount = readNonNegativeSafeInt(raw.score, 'annotatedFilesCount', scoreCtx);
  if (annotatedFilesCount !== spec.selectedSourceFiles.length) {
    throw new EvaluationError(
      `${scoreCtx}.annotatedFilesCount (${String(annotatedFilesCount)}) does not match frozen sample (${String(spec.selectedSourceFiles.length)}).`,
    );
  }

  const totalGraphImportsCount = readNonNegativeSafeInt(
    raw.score,
    'totalGraphImportsCount',
    scoreCtx,
  );
  const totalGraphCallsCount = readNonNegativeSafeInt(raw.score, 'totalGraphCallsCount', scoreCtx);
  const scopedPredictedImportsCount = readNonNegativeSafeInt(
    raw.score,
    'scopedPredictedImportsCount',
    scoreCtx,
  );
  const scopedPredictedCallsCount = readNonNegativeSafeInt(
    raw.score,
    'scopedPredictedCallsCount',
    scoreCtx,
  );
  const groupedExclusionRecordsCount = readNonNegativeSafeInt(
    raw.score,
    'groupedExclusionRecordsCount',
    scoreCtx,
  );
  const declaredUncertainCandidatesCount = readNonNegativeSafeInt(
    raw.score,
    'declaredUncertainCandidatesCount',
    scoreCtx,
  );

  if (totalGraphImportsCount !== stats.importsEdgeCount) {
    throw new EvaluationError(
      `${scoreCtx}.totalGraphImportsCount (${String(totalGraphImportsCount)}) !== stats.importsEdgeCount (${String(stats.importsEdgeCount)}).`,
    );
  }
  if (totalGraphCallsCount !== stats.callsEdgeCount) {
    throw new EvaluationError(
      `${scoreCtx}.totalGraphCallsCount (${String(totalGraphCallsCount)}) !== stats.callsEdgeCount (${String(stats.callsEdgeCount)}).`,
    );
  }
  if (scopedPredictedImportsCount > totalGraphImportsCount) {
    throw new EvaluationError(
      `${scoreCtx}.scopedPredictedImportsCount exceeds totalGraphImportsCount.`,
    );
  }
  if (scopedPredictedCallsCount > totalGraphCallsCount) {
    throw new EvaluationError(
      `${scoreCtx}.scopedPredictedCallsCount exceeds totalGraphCallsCount.`,
    );
  }

  const unscoredWrapperExtensionPredictions = parseCallIdentityArray(
    raw.score.unscoredWrapperExtensionPredictions,
    `${scoreCtx}.unscoredWrapperExtensionPredictions`,
  );

  const imports = parseAndValidateEdgeSetMetrics(
    raw.score.imports,
    `${scoreCtx}.imports`,
    parseImportIdentityArray,
  );
  const primaryCalls = parseAndValidateEdgeSetMetrics(
    raw.score.primaryCalls,
    `${scoreCtx}.primaryCalls`,
    parseCallIdentityArray,
  );
  const broaderCalls = parseAndValidateEdgeSetMetrics(
    raw.score.broaderCalls,
    `${scoreCtx}.broaderCalls`,
    parseCallIdentityArray,
  );

  if (imports.expectedCount !== spec.expectedImportsCount) {
    throw new EvaluationError(
      `${scoreCtx}.imports.expectedCount (${String(imports.expectedCount)}) does not match frozen denominator (${String(spec.expectedImportsCount)}).`,
    );
  }
  if (primaryCalls.expectedCount !== spec.expectedPrimaryCallsCount) {
    throw new EvaluationError(
      `${scoreCtx}.primaryCalls.expectedCount (${String(primaryCalls.expectedCount)}) does not match frozen denominator (${String(spec.expectedPrimaryCallsCount)}).`,
    );
  }
  if (broaderCalls.expectedCount !== spec.expectedBroaderCallsCount) {
    throw new EvaluationError(
      `${scoreCtx}.broaderCalls.expectedCount (${String(broaderCalls.expectedCount)}) does not match frozen denominator (${String(spec.expectedBroaderCallsCount)}).`,
    );
  }
  if (
    primaryCalls.predictedCount + unscoredWrapperExtensionPredictions.length !==
    broaderCalls.predictedCount
  ) {
    throw new EvaluationError(
      `${scoreCtx} predicted CALLS count mismatch across primary (${String(primaryCalls.predictedCount)}), unscored extensions (${String(unscoredWrapperExtensionPredictions.length)}), and broader (${String(broaderCalls.predictedCount)}).`,
    );
  }

  if (!isRecord(raw.score.wrapperExtensions)) {
    throw new EvaluationError(`${scoreCtx}.wrapperExtensions must be an object.`);
  }
  const extCtx = `${scoreCtx}.wrapperExtensions`;
  const expectedExtensions = parseCallIdentityArray(
    raw.score.wrapperExtensions.expectedExtensions,
    `${extCtx}.expectedExtensions`,
  );
  const matchedExtensions = parseCallIdentityArray(
    raw.score.wrapperExtensions.matchedExtensions,
    `${extCtx}.matchedExtensions`,
  );
  const missedExtensions = parseCallIdentityArray(
    raw.score.wrapperExtensions.missedExtensions,
    `${extCtx}.missedExtensions`,
  );
  const extMetrics = parseAndValidateEdgeSetMetrics(
    raw.score.wrapperExtensions.metrics,
    `${extCtx}.metrics`,
    parseCallIdentityArray,
  );

  const specExtKeys = new Set(spec.wrapperExtensionCalls.map(serializeCallIdentity));
  const recordExtKeys = new Set(expectedExtensions.map(serializeCallIdentity));
  if (
    expectedExtensions.length !== spec.wrapperExtensionCalls.length ||
    recordExtKeys.size !== specExtKeys.size ||
    ![...specExtKeys].every((k) => recordExtKeys.has(k))
  ) {
    throw new EvaluationError(
      `${extCtx}.expectedExtensions does not match frozen wrapper-extension identities for "${spec.id}".`,
    );
  }
  if (
    extMetrics.expectedCount !== spec.wrapperExtensionCalls.length ||
    extMetrics.tp !== matchedExtensions.length ||
    extMetrics.fn !== missedExtensions.length ||
    extMetrics.fp !== 0 ||
    matchedExtensions.length !== unscoredWrapperExtensionPredictions.length
  ) {
    throw new EvaluationError(`${extCtx} metrics do not match extension prediction lists.`);
  }
  if (
    primaryCalls.tp + extMetrics.tp !== broaderCalls.tp ||
    primaryCalls.fn + extMetrics.fn !== broaderCalls.fn ||
    primaryCalls.fp !== broaderCalls.fp
  ) {
    throw new EvaluationError(
      `${scoreCtx} primary/broader/extension TP/FP/FN conservation check failed.`,
    );
  }

  if (!isRecord(raw.score.graphIntegrity)) {
    throw new EvaluationError(`${scoreCtx}.graphIntegrity must be an object.`);
  }
  const integrityValid = readBoolean(
    raw.score.graphIntegrity,
    'valid',
    `${scoreCtx}.graphIntegrity`,
  );
  const rawViolations = raw.score.graphIntegrity.violations;
  if (!Array.isArray(rawViolations) || !rawViolations.every((v) => typeof v === 'string')) {
    throw new EvaluationError(`${scoreCtx}.graphIntegrity.violations must be a string array.`);
  }
  if (!integrityValid || rawViolations.length > 0) {
    throw new EvaluationError(
      `${scoreCtx}.graphIntegrity must be valid with zero violations for aggregation.`,
    );
  }

  const graphDigest = readNonEmptyStr(raw.score, 'graphDigest', scoreCtx);
  if (!HEX_64_RE.test(graphDigest)) {
    throw new EvaluationError(`${scoreCtx}.graphDigest must be a 64-char lowercase hex SHA-256.`);
  }

  return {
    schemaVersion: 1,
    repoId: repoIdRaw,
    manifestRelativePath,
    manifestSha256,
    analysisOptions,
    environment,
    snapshotInventory,
    analysisDurationMs,
    memory,
    stats,
    warnings,
    score: {
      repository,
      commitSha,
      annotatedFilesCount,
      totalGraphImportsCount,
      totalGraphCallsCount,
      scopedPredictedImportsCount,
      scopedPredictedCallsCount,
      unscoredWrapperExtensionPredictions,
      groupedExclusionRecordsCount,
      declaredUncertainCandidatesCount,
      imports,
      primaryCalls,
      broaderCalls,
      wrapperExtensions: {
        expectedExtensions,
        matchedExtensions,
        missedExtensions,
        metrics: extMetrics,
      },
      graphIntegrity: {
        valid: true,
        violations: [],
      },
      graphDigest,
    },
  };
}

/**
 * Aggregates fresh-process run records with strict invariance enforcement:
 * - Validates every run record (schema, frozen digests/commits, denominators, arithmetic).
 * - Rejects mixed analysis options or inconsistent runtime/compiler environments.
 * - Requires identical `graphDigest` and identical `score` across repetitions of each repository.
 * - In official `'baseline'` mode (default): requires all 3 frozen repositories, exactly 3 runs
 *   per repository (9 total), and `skipLoadingLibFiles: false`.
 * - Micro-averages each repository exactly once (never across all 9 repetitions).
 */
export function buildAggregatedReport(
  runs: readonly unknown[],
  options: BuildAggregatedReportOptions = {},
): AggregatedEvaluationReport {
  const mode: EvaluationReportMode = options.mode ?? 'baseline';

  if (runs.length === 0) {
    throw new EvaluationError('At least one run record is required to build an aggregated report.');
  }

  const validatedRuns: SingleRepoRunRecord[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    validatedRuns.push(parseAndValidateRunRecord(runs[i], `runs[${String(i)}]`));
  }

  const referenceRun = validatedRuns[0];
  if (referenceRun === undefined) {
    throw new EvaluationError('At least one validated run record is required.');
  }

  const referenceOptions = referenceRun.analysisOptions;
  const referenceEnv = referenceRun.environment;

  for (let i = 0; i < validatedRuns.length; i += 1) {
    const run = validatedRuns[i];
    if (run === undefined) {
      continue;
    }
    if (mode === 'baseline' && run.analysisOptions.skipLoadingLibFiles) {
      throw new EvaluationError(
        `Official baseline report requires skipLoadingLibFiles: false (runs[${String(i)}] for "${run.repoId}" had true).`,
      );
    }
    if (
      run.analysisOptions.skipLoadingLibFiles !== referenceOptions.skipLoadingLibFiles ||
      run.analysisOptions.maxCallSiteSnippetChars !== referenceOptions.maxCallSiteSnippetChars
    ) {
      throw new EvaluationError(
        `Inconsistent analysisOptions across runs (runs[${String(i)}] differs from runs[0]).`,
      );
    }
    if (
      run.environment.nodeVersion !== referenceEnv.nodeVersion ||
      run.environment.platform !== referenceEnv.platform ||
      run.environment.osRelease !== referenceEnv.osRelease ||
      run.environment.arch !== referenceEnv.arch ||
      run.environment.bundledTypeScriptVersion !== referenceEnv.bundledTypeScriptVersion
    ) {
      throw new EvaluationError(
        `Inconsistent runtime/compiler environment metadata across runs (runs[${String(i)}] differs from runs[0]).`,
      );
    }
  }

  const byRepo = new Map<FrozenRepoId, SingleRepoRunRecord[]>();
  for (const run of validatedRuns) {
    const existing = byRepo.get(run.repoId);
    if (existing !== undefined) {
      existing.push(run);
    } else {
      byRepo.set(run.repoId, [run]);
    }
  }

  const summaries: MultiRunRepositorySummary[] = [];

  for (const repoId of OFFICIAL_BASELINE_REPOS) {
    const repoRuns = byRepo.get(repoId);
    if (repoRuns === undefined || repoRuns.length === 0) {
      if (mode === 'baseline') {
        throw new EvaluationError(
          `Official baseline report is missing required repository "${repoId}".`,
        );
      }
      continue;
    }

    if (mode === 'baseline' && repoRuns.length !== OFFICIAL_BASELINE_REPETITIONS_PER_REPO) {
      throw new EvaluationError(
        `Official baseline report requires exactly ${String(OFFICIAL_BASELINE_REPETITIONS_PER_REPO)} fresh-process runs for "${repoId}" (received ${String(repoRuns.length)}).`,
      );
    }

    const firstRun = repoRuns[0];
    if (firstRun === undefined) {
      continue;
    }

    const firstDigest = firstRun.score.graphDigest;
    const firstScoreSerialized = JSON.stringify(firstRun.score);
    for (let i = 1; i < repoRuns.length; i += 1) {
      const nextRun = repoRuns[i];
      if (nextRun === undefined) {
        continue;
      }
      if (nextRun.score.graphDigest !== firstDigest) {
        throw new EvaluationError(
          `Non-deterministic graphDigest detected across fresh-process runs for "${repoId}".`,
        );
      }
      if (JSON.stringify(nextRun.score) !== firstScoreSerialized) {
        throw new EvaluationError(
          `Inconsistent repeated score payload detected across runs for "${repoId}".`,
        );
      }
    }

    const durationsMs = repoRuns.map((r) => r.analysisDurationMs);
    summaries.push({
      repoId,
      repository: firstRun.score.repository,
      commitSha: firstRun.score.commitSha,
      runCount: repoRuns.length,
      deterministicAcrossRuns: true,
      graphDigest: firstDigest,
      durationsMs,
      medianDurationMs: Number(computeMedian(durationsMs).toFixed(2)),
      representativeRun: firstRun,
    });
  }

  // Micro-average each repository exactly once (using representativeRun.score, never all 9 repetitions)
  const aggregate = aggregateRepositoryScores(summaries.map((s) => s.representativeRun.score));

  return {
    reportMode: mode,
    generatedAtIso: new Date().toISOString(),
    recallTargetThreshold: RECALL_TARGET_THRESHOLD,
    analysisOptions: referenceOptions,
    environment: referenceEnv,
    repositories: summaries,
    aggregate,
  };
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatMarkdownReport(report: AggregatedEvaluationReport): string {
  const lines: string[] = [];
  if (report.reportMode === 'baseline') {
    lines.push(
      '# Archon Static Analysis Sampled-File Recall & Precision Report (Official Baseline)',
    );
  } else {
    lines.push(
      '# Archon Static Analysis Sampled-File Recall & Precision Report (PARTIAL — Not Official Baseline)',
    );
  }
  lines.push('');
  lines.push(
    `- Mode: \`${report.reportMode}\` | Options: \`skipLoadingLibFiles=${String(report.analysisOptions.skipLoadingLibFiles)}\`, \`maxCallSiteSnippetChars=${String(report.analysisOptions.maxCallSiteSnippetChars)}\` | Runtime: Node \`${report.environment.nodeVersion}\`, bundled TS \`${report.environment.bundledTypeScriptVersion}\`, OS \`${report.environment.platform}/${report.environment.arch}\``,
  );
  lines.push('');
  lines.push(
    'Repository | Scope | Annotated files | Expected | Predicted | TP | FP | FN | Precision | Recall | F1',
  );
  lines.push('--- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:');

  for (const repo of report.repositories) {
    const s = repo.representativeRun.score;
    const rows: readonly [
      string,
      {
        readonly expectedCount: number;
        readonly predictedCount: number;
        readonly tp: number;
        readonly fp: number;
        readonly fn: number;
        readonly precision: number | null;
        readonly recall: number | null;
        readonly f1: number | null;
      },
    ][] = [
      ['IMPORTS', s.imports],
      ['Primary CALLS', s.primaryCalls],
      ['Broader CALLS', s.broaderCalls],
    ];

    for (const [scopeName, m] of rows) {
      lines.push(
        `${repo.repository} | ${scopeName} | ${String(s.annotatedFilesCount)} | ${String(m.expectedCount)} | ${String(m.predictedCount)} | ${String(m.tp)} | ${String(m.fp)} | ${String(m.fn)} | ${formatPercent(m.precision)} | ${formatPercent(m.recall)} | ${formatPercent(m.f1)}`,
      );
    }
  }

  const aggRows: readonly [
    string,
    {
      readonly annotatedFilesCount: number;
      readonly expectedCount: number;
      readonly predictedCount: number;
      readonly tp: number;
      readonly fp: number;
      readonly fn: number;
      readonly precision: number | null;
      readonly recall: number | null;
      readonly f1: number | null;
    },
  ][] = [
    ['IMPORTS', report.aggregate.imports],
    ['Primary CALLS', report.aggregate.primaryCalls],
    ['Broader CALLS', report.aggregate.broaderCalls],
  ];

  for (const [scopeName, m] of aggRows) {
    lines.push(
      `**Aggregate (micro-avg)** | **${scopeName}** | ${String(m.annotatedFilesCount)} | ${String(m.expectedCount)} | ${String(m.predictedCount)} | ${String(m.tp)} | ${String(m.fp)} | ${String(m.fn)} | ${formatPercent(m.precision)} | ${formatPercent(m.recall)} | ${formatPercent(m.f1)}`,
    );
  }

  lines.push('');
  lines.push('## PRD 95% Recall Target Status (Sampled-File Scope)');
  const impPass = meetsRecallTarget(report.aggregate.imports.recall);
  const callsPass = meetsRecallTarget(report.aggregate.primaryCalls.recall);
  const broaderPass = meetsRecallTarget(report.aggregate.broaderCalls.recall);
  lines.push(
    `- Aggregate IMPORTS recall: ${formatPercent(report.aggregate.imports.recall)} -> ${impPass === true ? 'PASS (>= 95%)' : impPass === false ? 'BELOW TARGET (< 95%)' : 'N/A'}`,
  );
  lines.push(
    `- Aggregate Primary CALLS recall: ${formatPercent(report.aggregate.primaryCalls.recall)} -> ${callsPass === true ? 'PASS (>= 95%)' : callsPass === false ? 'BELOW TARGET (< 95%)' : 'N/A'}`,
  );
  lines.push(
    `- Aggregate Broader CALLS recall (reference including wrapper extensions): ${formatPercent(report.aggregate.broaderCalls.recall)} -> ${broaderPass === true ? 'PASS (>= 95%)' : broaderPass === false ? 'BELOW TARGET (< 95%)' : 'N/A'}`,
  );

  lines.push('');
  lines.push('## Preliminary Runtime, Memory, Determinism & Warnings');
  for (const repo of report.repositories) {
    const r = repo.representativeRun;
    lines.push(`### ${repo.repository} (\`${repo.commitSha}\`)`);
    lines.push(
      `- Runs: ${String(repo.runCount)} fresh processes | Deterministic digest: \`${repo.graphDigest}\` (${repo.deterministicAcrossRuns ? 'MATCH' : 'MISMATCH'})`,
    );
    lines.push(
      `- Timing: median ${String(repo.medianDurationMs)} ms (runs: ${repo.durationsMs.map((d) => `${String(d)} ms`).join(', ')})`,
    );
    lines.push(
      `- Memory (run 1): heapUsed ${formatMb(r.memory.baselineHeapUsedBytes)} -> ${formatMb(r.memory.postAnalysisHeapUsedBytes)} | RSS ${formatMb(r.memory.baselineRssBytes)} -> ${formatMb(r.memory.postAnalysisRssBytes)} | process-lifetime maxRSS ${String(r.memory.processLifetimeMaxRssKiB)} KiB (not isolated analyzer peak RSS)`,
    );
    lines.push(
      `- Discovery/AST: inventoried=${String(r.snapshotInventory.supportedFilesCount)}, discovered=${String(r.stats.discoveredFilesCount)}, parsed=${String(r.stats.parsedFilesCount)}, skippedSyntax=${String(r.stats.skippedSyntaxErrorFilesCount)}, skippedOversized=${String(r.stats.skippedOversizedFilesCount)}, bytesRead=${String(r.stats.totalBytesRead)}, warnings=${String(r.warnings.length)} (truncated=${String(r.stats.truncatedWarningsCount)})`,
    );
    lines.push(
      `- Graph totals: folders=${String(r.stats.folderNodeCount)}, files=${String(r.stats.fileNodeCount)}, functions=${String(r.stats.functionNodeCount)}, classes=${String(r.stats.classNodeCount)}, symbols=${String(r.stats.symbolNodeCount)}, totalImports=${String(r.stats.importsEdgeCount)}, totalCalls=${String(r.stats.callsEdgeCount)}`,
    );
    lines.push(
      `- Wrapper extensions: matched=${String(r.score.wrapperExtensions.matchedExtensions.length)}/${String(r.score.wrapperExtensions.expectedExtensions.length)}, unscoredPrimaryPredictions=${String(r.score.unscoredWrapperExtensionPredictions.length)}`,
    );

    if (r.score.imports.falsePositives.length > 0 || r.score.imports.falseNegatives.length > 0) {
      lines.push('- IMPORTS mismatches:');
      for (const fp of r.score.imports.falsePositives) {
        lines.push(`  - [FP] ${formatImportIdentity(fp)}`);
      }
      for (const fn of r.score.imports.falseNegatives) {
        lines.push(`  - [FN] ${formatImportIdentity(fn)}`);
      }
    }

    if (
      r.score.primaryCalls.falsePositives.length > 0 ||
      r.score.primaryCalls.falseNegatives.length > 0
    ) {
      lines.push('- Primary CALLS mismatches:');
      for (const fp of r.score.primaryCalls.falsePositives) {
        lines.push(`  - [FP] ${formatCallIdentity(fp)}`);
      }
      for (const fn of r.score.primaryCalls.falseNegatives) {
        lines.push(`  - [FN] ${formatCallIdentity(fn)}`);
      }
    }

    if (r.score.wrapperExtensions.expectedExtensions.length > 0) {
      lines.push('- Wrapper-extension breakdown:');
      for (const m of r.score.wrapperExtensions.matchedExtensions) {
        lines.push(`  - [MATCHED/UNSCORED-PRIMARY] ${formatCallIdentity(m)}`);
      }
      for (const m of r.score.wrapperExtensions.missedExtensions) {
        lines.push(`  - [MISSED-BROADER-FN] ${formatCallIdentity(m)}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Windows- and POSIX-safe ESM main-module guard so importing this module in Vitest
 * never triggers CLI argument parsing or real-repository execution.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1.trim().length === 0) {
    return false;
  }
  const metaPath = fileURLToPath(metaUrl);
  try {
    const canonicalMeta = realpathSync(metaPath);
    const canonicalArgv = realpathSync(path.resolve(argv1));
    if (process.platform === 'win32') {
      return canonicalMeta.toLowerCase() === canonicalArgv.toLowerCase();
    }
    return canonicalMeta === canonicalArgv;
  } catch {
    const resolvedMeta = path.resolve(metaPath);
    const resolvedArgv = path.resolve(argv1);
    if (process.platform === 'win32') {
      return resolvedMeta.toLowerCase() === resolvedArgv.toLowerCase();
    }
    return resolvedMeta === resolvedArgv;
  }
}

function getFlagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return args[idx + 1];
}

function getMultiFlagValues(args: readonly string[], flag: string): readonly string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        results.push(next);
      }
    }
  }
  return results;
}

function normalizeRunFileKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const command = argv[0];

  if (command === 'run') {
    const repoArg = getFlagValue(argv, '--repo');
    const repoDir = getFlagValue(argv, '--repo-dir');
    const bundlePath = getFlagValue(argv, '--bundle');
    const outPath = getFlagValue(argv, '--out');
    const skipLoadingLibFiles = argv.includes('--skip-lib-files');

    if (repoArg === undefined || !isFrozenRepoId(repoArg)) {
      throw new EvaluationError(
        'Missing or invalid --repo (expected: zustand | nextjs-subscription-payments | taxonomy).',
      );
    }
    if (repoDir === undefined || bundlePath === undefined) {
      throw new EvaluationError('Both --repo-dir <dir> and --bundle <path> are required.');
    }

    const record = await runSingleRepositoryEvaluation({
      repoId: repoArg,
      repoRoot: repoDir,
      bundlePath,
      skipLoadingLibFiles,
    });

    if (outPath !== undefined) {
      await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    }

    process.stdout.write(
      `[eval] ${record.score.repository} (${record.analysisOptions.skipLoadingLibFiles ? 'no-lib' : 'with-lib'}) | IMPORTS R=${formatPercent(record.score.imports.recall)} P=${formatPercent(record.score.imports.precision)} | Primary CALLS R=${formatPercent(record.score.primaryCalls.recall)} P=${formatPercent(record.score.primaryCalls.precision)} | Broader CALLS R=${formatPercent(record.score.broaderCalls.recall)} | ${String(record.analysisDurationMs)} ms | digest=${record.score.graphDigest.slice(0, 12)}\n`,
    );
    return;
  }

  if (command === 'report') {
    const rawRunFiles = getMultiFlagValues(argv, '--run');
    const outJsonPath = getFlagValue(argv, '--out-json');
    const outMdPath = getFlagValue(argv, '--out-md');
    const mode: EvaluationReportMode = argv.includes('--partial') ? 'partial' : 'baseline';

    if (rawRunFiles.length === 0) {
      throw new EvaluationError('Provide one or more --run <runRecord.json> arguments.');
    }

    const seenRunFiles = new Set<string>();
    for (const filePath of rawRunFiles) {
      const key = normalizeRunFileKey(filePath);
      if (seenRunFiles.has(key)) {
        throw new EvaluationError(`Duplicate input run file provided: "${filePath}".`);
      }
      seenRunFiles.add(key);
    }

    const runFiles = [...rawRunFiles].sort(compareCodePoint);
    const runs: SingleRepoRunRecord[] = [];
    for (const filePath of runFiles) {
      const parsed = parseJsonUnknown(await readFile(filePath, 'utf8'), filePath);
      runs.push(parseAndValidateRunRecord(parsed, filePath));
    }

    const report = buildAggregatedReport(runs, { mode });
    const markdown = formatMarkdownReport(report);

    if (outJsonPath !== undefined) {
      await mkdir(path.dirname(path.resolve(outJsonPath)), { recursive: true });
      await writeFile(outJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    if (outMdPath !== undefined) {
      await mkdir(path.dirname(path.resolve(outMdPath)), { recursive: true });
      await writeFile(outMdPath, `${markdown}\n`, 'utf8');
    }

    process.stdout.write(`${markdown}\n`);
    return;
  }

  throw new EvaluationError(
    'Usage:\n' +
      '  npx tsx scripts/evaluate-recall.ts run --repo <id> --repo-dir <dir> --bundle <file> [--out <json>] [--skip-lib-files]\n' +
      '  npx tsx scripts/evaluate-recall.ts report --run <file1.json> [--run <file2.json> ...] [--partial] [--out-json <file>] [--out-md <file>]',
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exitCode = 1;
  });
}
