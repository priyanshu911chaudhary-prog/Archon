import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analysisOutputSchema, type AnalysisOutput } from '@archon/shared';
import {
  BENCHMARK_SCHEMA_VERSION,
  BenchmarkError,
  PRELIMINARY_MEMORY_COVERAGE_POLICY,
  REFERENCE_WITH_LIB_DIGESTS,
  formatKiBAsMiB,
  formatMiB,
  isBenchmarkRepoId,
  isPlainObject,
  isSafeArtifactBasename,
  parseBenchmarkJson,
  readBool,
  readNonNegInt,
  readNullableBool,
  readNullableStr,
  readStr,
  readStringList,
  summarizeNumbers,
  validateBenchmarkAnalysisStats,
  validateBenchmarkEnvironment,
  validateBenchmarkRunnerConfig,
  validateParentBenchmarkRunRecord,
  validateWindowsMonitorSummary,
  writeFileExclusiveJson,
  type AggregatedBenchmarkReport,
  type AggregatedRepoBenchmarkSummary,
  type BenchmarkEnvironmentRecord,
  type BenchmarkRunnerConfigRecord,
  type ParentBenchmarkRunRecord,
  type PreparedSnapshotInventory,
  type ScoredBenchmarkRunRecord,
  type WindowsMonitorSummary,
} from './benchmark-parser-types.js';
import {
  FROZEN_EVAL_REPOS,
  aggregateRepositoryScores,
  compareCodePoint,
  formatCallIdentity,
  formatImportIdentity,
  formatPercent,
  scoreRepositoryAnalysis,
  verifyAndLoadFrozenManifest,
  type CanonicalCallIdentity,
  type CanonicalImportIdentity,
  type EdgeSetMetrics,
  type FrozenRepoId,
  type FrozenRepoSpec,
  type GroundTruthManifest,
  type RepositoryScoreResult,
} from './eval-policy.js';
import { isMainModule, resolveBundledTypeScriptVersion } from './evaluate-recall.js';
import { verifyPinnedSnapshot } from './snapshot-verifier.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARCHON_ROOT = path.resolve(MODULE_DIR, path.basename(MODULE_DIR) === 'dist' ? '../..' : '..');
const ORDERED_FROZEN_REPOS: readonly FrozenRepoId[] = [
  'zustand',
  'nextjs-subscription-payments',
  'taxonomy',
];
const HEX_64_RE = /^[0-9a-f]{64}$/;
const RATIO_EPSILON = 1e-12;

function assertRatioMatches(
  actual: unknown,
  expected: number | null,
  field: string,
  ctx: string,
): number | null {
  if (expected === null) {
    if (actual !== null) {
      throw new BenchmarkError(`${ctx}.${field} must be null when denominator is zero.`);
    }
    return null;
  }
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    throw new BenchmarkError(`${ctx}.${field} must be a finite number.`);
  }
  if (Math.abs(actual - expected) > RATIO_EPSILON) {
    throw new BenchmarkError(
      `${ctx}.${field} (${String(actual)}) is inconsistent with raw counts (expected ${String(expected)}).`,
    );
  }
  return actual;
}

function parseImportIdentityList(raw: unknown, ctx: string): readonly CanonicalImportIdentity[] {
  if (!Array.isArray(raw)) {
    throw new BenchmarkError(`${ctx} must be an array.`);
  }
  const out: CanonicalImportIdentity[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item: unknown = raw[i];
    const iCtx = `${ctx}[${String(i)}]`;
    if (!isPlainObject(item) || item.edgeType !== 'IMPORTS') {
      throw new BenchmarkError(`${iCtx} must be a valid IMPORTS identity.`);
    }
    out.push({
      sourceQualifiedName: readStr(item, 'sourceQualifiedName', iCtx),
      targetQualifiedName: readStr(item, 'targetQualifiedName', iCtx),
      edgeType: 'IMPORTS',
    });
  }
  return out;
}

function parseCallIdentityList(raw: unknown, ctx: string): readonly CanonicalCallIdentity[] {
  if (!Array.isArray(raw)) {
    throw new BenchmarkError(`${ctx} must be an array.`);
  }
  const out: CanonicalCallIdentity[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item: unknown = raw[i];
    const iCtx = `${ctx}[${String(i)}]`;
    if (!isPlainObject(item) || item.edgeType !== 'CALLS') {
      throw new BenchmarkError(`${iCtx} must be a valid CALLS identity.`);
    }
    const callSiteLine = readNonNegInt(item, 'callSiteLine', iCtx);
    if (callSiteLine < 1) {
      throw new BenchmarkError(`${iCtx}.callSiteLine must be >= 1.`);
    }
    out.push({
      sourceQualifiedName: readStr(item, 'sourceQualifiedName', iCtx),
      targetQualifiedName: readStr(item, 'targetQualifiedName', iCtx),
      edgeType: 'CALLS',
      callSiteLine,
    });
  }
  return out;
}

function validateEdgeSetMetrics<T>(
  raw: unknown,
  ctx: string,
  parseList: (value: unknown, listCtx: string) => readonly T[],
): EdgeSetMetrics<T> {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${ctx} must be an object.`);
  }
  const expectedCount = readNonNegInt(raw, 'expectedCount', ctx);
  const predictedCount = readNonNegInt(raw, 'predictedCount', ctx);
  const tp = readNonNegInt(raw, 'tp', ctx);
  const fp = readNonNegInt(raw, 'fp', ctx);
  const fn = readNonNegInt(raw, 'fn', ctx);
  const duplicateExpectedCount = readNonNegInt(raw, 'duplicateExpectedCount', ctx);
  const duplicatePredictedCount = readNonNegInt(raw, 'duplicatePredictedCount', ctx);
  const falsePositives = parseList(raw.falsePositives, `${ctx}.falsePositives`);
  const falseNegatives = parseList(raw.falseNegatives, `${ctx}.falseNegatives`);

  if (tp + fn !== expectedCount) {
    throw new BenchmarkError(`${ctx} arithmetic mismatch: tp + fn !== expectedCount.`);
  }
  if (tp + fp !== predictedCount) {
    throw new BenchmarkError(`${ctx} arithmetic mismatch: tp + fp !== predictedCount.`);
  }
  if (fp !== falsePositives.length || fn !== falseNegatives.length) {
    throw new BenchmarkError(`${ctx} mismatch list lengths do not equal fp/fn counts.`);
  }

  const expP = tp + fp === 0 ? null : tp / (tp + fp);
  const expR = tp + fn === 0 ? null : tp / (tp + fn);
  const expF1 = 2 * tp + fp + fn === 0 ? null : (2 * tp) / (2 * tp + fp + fn);

  return {
    expectedCount,
    predictedCount,
    tp,
    fp,
    fn,
    precision: assertRatioMatches(raw.precision, expP, 'precision', ctx),
    recall: assertRatioMatches(raw.recall, expR, 'recall', ctx),
    f1: assertRatioMatches(raw.f1, expF1, 'f1', ctx),
    duplicateExpectedCount,
    duplicatePredictedCount,
    falsePositives,
    falseNegatives,
  };
}

function validateRepositoryScoreResult(
  raw: unknown,
  spec: FrozenRepoSpec,
  ctx: string,
): RepositoryScoreResult {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${ctx} must be an object.`);
  }
  const repository = readStr(raw, 'repository', ctx);
  const commitSha = readStr(raw, 'commitSha', ctx);
  if (repository !== spec.repository || commitSha !== spec.commitSha) {
    throw new BenchmarkError(`${ctx} repository/commitSha does not match frozen spec.`);
  }
  const annotatedFilesCount = readNonNegInt(raw, 'annotatedFilesCount', ctx);
  if (annotatedFilesCount !== spec.selectedSourceFiles.length) {
    throw new BenchmarkError(`${ctx}.annotatedFilesCount does not match frozen sample.`);
  }
  const imports = validateEdgeSetMetrics(raw.imports, `${ctx}.imports`, parseImportIdentityList);
  const primaryCalls = validateEdgeSetMetrics(
    raw.primaryCalls,
    `${ctx}.primaryCalls`,
    parseCallIdentityList,
  );
  const broaderCalls = validateEdgeSetMetrics(
    raw.broaderCalls,
    `${ctx}.broaderCalls`,
    parseCallIdentityList,
  );
  if (
    imports.expectedCount !== spec.expectedImportsCount ||
    primaryCalls.expectedCount !== spec.expectedPrimaryCallsCount ||
    broaderCalls.expectedCount !== spec.expectedBroaderCallsCount
  ) {
    throw new BenchmarkError(`${ctx} expected denominators do not match frozen spec.`);
  }

  if (!isPlainObject(raw.wrapperExtensions)) {
    throw new BenchmarkError(`${ctx}.wrapperExtensions must be an object.`);
  }
  const wCtx = `${ctx}.wrapperExtensions`;
  const expectedExtensions = parseCallIdentityList(
    raw.wrapperExtensions.expectedExtensions,
    `${wCtx}.expectedExtensions`,
  );
  const matchedExtensions = parseCallIdentityList(
    raw.wrapperExtensions.matchedExtensions,
    `${wCtx}.matchedExtensions`,
  );
  const missedExtensions = parseCallIdentityList(
    raw.wrapperExtensions.missedExtensions,
    `${wCtx}.missedExtensions`,
  );
  const extMetrics = validateEdgeSetMetrics(
    raw.wrapperExtensions.metrics,
    `${wCtx}.metrics`,
    parseCallIdentityList,
  );

  if (!isPlainObject(raw.graphIntegrity)) {
    throw new BenchmarkError(`${ctx}.graphIntegrity must be an object.`);
  }
  const integrityValid = readBool(raw.graphIntegrity, 'valid', `${ctx}.graphIntegrity`);
  const violations = readStringList(raw.graphIntegrity, 'violations', `${ctx}.graphIntegrity`);

  const graphDigest = readStr(raw, 'graphDigest', ctx);
  if (!HEX_64_RE.test(graphDigest)) {
    throw new BenchmarkError(`${ctx}.graphDigest must be a 64-char lowercase hex SHA-256.`);
  }

  return {
    repository,
    commitSha,
    annotatedFilesCount,
    totalGraphImportsCount: readNonNegInt(raw, 'totalGraphImportsCount', ctx),
    totalGraphCallsCount: readNonNegInt(raw, 'totalGraphCallsCount', ctx),
    scopedPredictedImportsCount: readNonNegInt(raw, 'scopedPredictedImportsCount', ctx),
    scopedPredictedCallsCount: readNonNegInt(raw, 'scopedPredictedCallsCount', ctx),
    unscoredWrapperExtensionPredictions: parseCallIdentityList(
      raw.unscoredWrapperExtensionPredictions,
      `${ctx}.unscoredWrapperExtensionPredictions`,
    ),
    groupedExclusionRecordsCount: readNonNegInt(raw, 'groupedExclusionRecordsCount', ctx),
    declaredUncertainCandidatesCount: readNonNegInt(raw, 'declaredUncertainCandidatesCount', ctx),
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
      valid: integrityValid,
      violations,
    },
    graphDigest,
  };
}

/**
 * Stage A: Verifies frozen manifest SHA-256 and authoritative pinned Git snapshot outside
 * the measured parent, writing a compact `prepared-inventory.json` (zero source contents).
 */
export async function prepareBenchmarkInventory(options: {
  readonly repoId: FrozenRepoId;
  readonly repoRoot: string;
  readonly bundlePath: string;
  readonly outPath: string;
  readonly archonRoot?: string;
}): Promise<PreparedSnapshotInventory> {
  const spec = FROZEN_EVAL_REPOS[options.repoId];
  const archonRoot = options.archonRoot ?? ARCHON_ROOT;
  const manifestPath = path.resolve(archonRoot, ...spec.manifestRelativePath.split('/'));

  const { manifest, actualSha256 } = await verifyAndLoadFrozenManifest(
    manifestPath,
    spec.manifestSha256,
    spec,
  );

  const snapshot = await verifyPinnedSnapshot({
    repoRoot: options.repoRoot,
    bundlePath: options.bundlePath,
    manifest,
    expectedSourceCount: spec.inventoriedSourceCount,
    expectedConfigCount: spec.inventoriedConfigCount,
  });

  const bundledTypeScriptVersion = await resolveBundledTypeScriptVersion();

  const prepared: PreparedSnapshotInventory = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    repoId: spec.id,
    repository: manifest.repository,
    commitSha: manifest.commitSha,
    manifestRelativePath: spec.manifestRelativePath,
    manifestSha256: actualSha256,
    canonicalRoot: snapshot.canonicalRoot,
    supportedFiles: snapshot.supportedFiles,
    configFiles: snapshot.configFiles,
    totalSupportedBytes: snapshot.totalSupportedBytes,
    totalConfigBytes: snapshot.totalConfigBytes,
    bundledTypeScriptVersion,
    preparedAtUtc: new Date().toISOString(),
  };

  await writeFileExclusiveJson(options.outPath, prepared);
  return prepared;
}

function evaluateMemoryAcceptance(
  parentRecord: ParentBenchmarkRunRecord,
  iterationIndex: number,
  windowsMonitor: WindowsMonitorSummary | null,
  monitorLoadError: string | null,
): { readonly accepted: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];

  if (monitorLoadError !== null) {
    reasons.push(`Monitor artifact invalid or unreadable: ${monitorLoadError}`);
    return { accepted: false, reasons };
  }
  if (windowsMonitor === null) {
    reasons.push('Missing external OS monitor summary for memory coverage acceptance.');
    return { accepted: false, reasons };
  }
  if (windowsMonitor.monitorStatus !== 'completed') {
    reasons.push(
      `Monitor did not complete cleanly (status=${windowsMonitor.monitorStatus}${windowsMonitor.failureDetails !== null ? `: ${windowsMonitor.failureDetails}` : ''}).`,
    );
  }
  if (windowsMonitor.quarantinedOwnedProcesses.length > 0) {
    reasons.push(
      `Monitor reported ${String(windowsMonitor.quarantinedOwnedProcesses.length)} quarantined owned process(es).`,
    );
  }
  if (windowsMonitor.parentIdentity.pid !== parentRecord.parentProcess.pid) {
    reasons.push(
      `Monitor parent PID (${String(windowsMonitor.parentIdentity.pid)}) does not match parent record PID (${String(parentRecord.parentProcess.pid)}).`,
    );
  }
  if (windowsMonitor.parentIdentity.exitCode !== 0) {
    reasons.push(
      `Monitor recorded non-zero parent exitCode (${String(windowsMonitor.parentIdentity.exitCode)}).`,
    );
  }

  const iter = parentRecord.iterations.find((it) => it.iterationIndex === iterationIndex);
  if (parentRecord.parentRunnerMode === 'instrumented-spawn-pid-hook') {
    const expectedChildPid = iter?.childPid ?? null;
    const matchedChild = windowsMonitor.childIdentities.find(
      (c) => c.iterationIndex === iterationIndex,
    );
    if (expectedChildPid === null) {
      reasons.push('Parent record missing childPid in instrumented mode.');
    } else if (matchedChild?.pid !== expectedChildPid) {
      reasons.push(
        `Monitor child PID (${String(matchedChild?.pid ?? null)}) does not match parent record childPid (${String(expectedChildPid)}).`,
      );
    } else if (
      matchedChild.observationStatus === 'handle_unavailable' ||
      matchedChild.observationStatus === 'still_running'
    ) {
      reasons.push(
        `Child process observation status "${matchedChild.observationStatus}" does not confirm completed child observation.`,
      );
    }
    if (
      windowsMonitor.sampling.validChildSamples <
      PRELIMINARY_MEMORY_COVERAGE_POLICY.minValidChildSamplesInstrumented
    ) {
      reasons.push(
        `Insufficient valid child samples (${String(windowsMonitor.sampling.validChildSamples)} < ${String(PRELIMINARY_MEMORY_COVERAGE_POLICY.minValidChildSamplesInstrumented)}).`,
      );
    }
    if (
      windowsMonitor.sampling.pairedParserWindowSamples <
      PRELIMINARY_MEMORY_COVERAGE_POLICY.minPairedParserWindowSamples
    ) {
      reasons.push(
        `Insufficient paired parent+child parser-window samples (${String(windowsMonitor.sampling.pairedParserWindowSamples)} < ${String(PRELIMINARY_MEMORY_COVERAGE_POLICY.minPairedParserWindowSamples)}).`,
      );
    }
    if (
      windowsMonitor.parserExecutionWindowMemory.maxSameIterationCombinedWorkingSetBytes === null
    ) {
      reasons.push('Same-iteration combined working-set peak is unavailable (null).');
    }
  } else if (windowsMonitor.sampling.parserWindowSamples < 1) {
    reasons.push('Zero parent samples captured during parser execution window.');
  }

  return { accepted: reasons.length === 0, reasons };
}

/**
 * Pure Stage C scorer operating on already-persisted isolated parser output and monitor records.
 * - Never re-runs `analyzeRepository`.
 * - Separates `executionStatus` from `benchmarkAccepted` (`accuracyAccepted` + `memoryAccepted`).
 * - For `skipLoadingLibFiles === false`, requires exact corrected full graph digest parity AND
 *   exact expected frozen sampled scores before setting `accuracyAccepted: true`.
 * - Preserves raw execution evidence and accuracy results even when memory acceptance fails.
 */
export function scorePersistedBenchmarkRun(options: {
  readonly runId: string;
  readonly manifest: GroundTruthManifest;
  readonly parentRecord: ParentBenchmarkRunRecord;
  readonly persistedGraphOutput: AnalysisOutput | null;
  readonly windowsMonitor: WindowsMonitorSummary | null;
  readonly graphLoadError?: string | null;
  readonly monitorLoadError?: string | null;
  readonly iterationIndex?: number;
}): ScoredBenchmarkRunRecord {
  const { runId, manifest, parentRecord, persistedGraphOutput, windowsMonitor } = options;
  const spec = FROZEN_EVAL_REPOS[parentRecord.repoId];
  const expectedWithLibDigest = REFERENCE_WITH_LIB_DIGESTS[parentRecord.repoId];

  if (
    parentRecord.repository !== manifest.repository ||
    parentRecord.commitSha !== manifest.commitSha
  ) {
    throw new BenchmarkError(
      `Parent record repository/commit (${parentRecord.repository}@${parentRecord.commitSha}) does not match frozen manifest (${manifest.repository}@${manifest.commitSha}).`,
    );
  }
  if (parentRecord.manifestSha256 !== spec.manifestSha256) {
    throw new BenchmarkError(`Parent record manifestSha256 mismatch for "${parentRecord.repoId}".`);
  }

  const targetIterIndex = options.iterationIndex ?? 1;
  const iteration = parentRecord.iterations.find((it) => it.iterationIndex === targetIterIndex);
  if (iteration === undefined) {
    throw new BenchmarkError(
      `Parent record "${runId}" does not contain iterationIndex=${String(targetIterIndex)}.`,
    );
  }

  const memoryEval = evaluateMemoryAcceptance(
    parentRecord,
    targetIterIndex,
    windowsMonitor,
    options.monitorLoadError ?? null,
  );

  const executionFailureReasons: string[] = [];
  if (parentRecord.runStatus !== 'success' || iteration.status !== 'success') {
    const errDetail =
      iteration.error !== null
        ? `${iteration.error.code}: ${iteration.error.message}`
        : `iteration status=${iteration.status}, runnerState=${iteration.finalRunnerState}`;
    executionFailureReasons.push(`Parser execution failed (${errDetail}).`);
  }
  if (iteration.finalRunnerState !== 'IDLE') {
    executionFailureReasons.push(
      `Final runner state is "${iteration.finalRunnerState}", expected "IDLE".`,
    );
  }
  if (iteration.isFatal) {
    executionFailureReasons.push('Runner latched fatal state.');
  }
  if (iteration.hasActiveChild) {
    executionFailureReasons.push('Runner still reports an active child process.');
  }
  if (iteration.metrics !== null) {
    if (iteration.metrics.exitCode !== 0 || iteration.metrics.signal !== null) {
      executionFailureReasons.push(
        `Child did not exit cleanly (exitCode=${String(iteration.metrics.exitCode)}, signal=${String(iteration.metrics.signal)}).`,
      );
    }
  }
  if (options.graphLoadError !== undefined && options.graphLoadError !== null) {
    executionFailureReasons.push(`Graph artifact load/validation error: ${options.graphLoadError}`);
  } else if (executionFailureReasons.length === 0 && persistedGraphOutput === null) {
    executionFailureReasons.push(
      'Missing persisted graph output artifact for successful parent run.',
    );
  }

  if (executionFailureReasons.length > 0 || persistedGraphOutput === null) {
    const failureReason = executionFailureReasons.join(' ');
    return {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      runId,
      scoredAtUtc: new Date().toISOString(),
      executionStatus: 'failed',
      benchmarkAccepted: false,
      accuracyAccepted: null,
      memoryAccepted: memoryEval.accepted,
      acceptanceReasons: [...executionFailureReasons, ...memoryEval.reasons],
      failureReason,
      repoId: parentRecord.repoId,
      repository: parentRecord.repository,
      commitSha: parentRecord.commitSha,
      manifestSha256: parentRecord.manifestSha256,
      parentTopology: parentRecord.parentTopology,
      parentRunnerMode: parentRecord.parentRunnerMode,
      runnerConfig: parentRecord.runnerConfig,
      environment: parentRecord.environment,
      snapshotInventory: parentRecord.snapshotInventory,
      parentRecord,
      windowsMonitor,
      stats: null,
      warningsCount: null,
      graphDigest: null,
      expectedWithLibDigest,
      matchesWithLibReferenceDigest: null,
      score: null,
    };
  }

  let score: RepositoryScoreResult;
  try {
    score = scoreRepositoryAnalysis({
      manifest,
      output: persistedGraphOutput,
      wrapperExtensionCalls: spec.wrapperExtensionCalls,
      maxCallSiteSnippetChars: parentRecord.runnerConfig.maxCallSiteSnippetChars,
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : 'Scoring validation failed.';
    const reason = `Scoring/integrity failure: ${detail}`;
    return {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      runId,
      scoredAtUtc: new Date().toISOString(),
      executionStatus: 'failed',
      benchmarkAccepted: false,
      accuracyAccepted: false,
      memoryAccepted: memoryEval.accepted,
      acceptanceReasons: [reason, ...memoryEval.reasons],
      failureReason: reason,
      repoId: parentRecord.repoId,
      repository: parentRecord.repository,
      commitSha: parentRecord.commitSha,
      manifestSha256: parentRecord.manifestSha256,
      parentTopology: parentRecord.parentTopology,
      parentRunnerMode: parentRecord.parentRunnerMode,
      runnerConfig: parentRecord.runnerConfig,
      environment: parentRecord.environment,
      snapshotInventory: parentRecord.snapshotInventory,
      parentRecord,
      windowsMonitor,
      stats: persistedGraphOutput.stats,
      warningsCount: persistedGraphOutput.warnings.length,
      graphDigest: null,
      expectedWithLibDigest,
      matchesWithLibReferenceDigest: null,
      score: null,
    };
  }

  const matchesWithLibReferenceDigest = score.graphDigest === expectedWithLibDigest;
  const accuracyReasons: string[] = [];

  if (!parentRecord.runnerConfig.skipLoadingLibFiles) {
    if (!matchesWithLibReferenceDigest) {
      accuracyReasons.push(
        `Library-enabled full graph digest (${score.graphDigest}) does not match expected reference digest (${expectedWithLibDigest}).`,
      );
    }
    if (
      score.imports.tp !== spec.expectedImportsCount ||
      score.imports.fp !== 0 ||
      score.imports.fn !== 0
    ) {
      accuracyReasons.push(
        `Library-enabled IMPORTS score (${String(score.imports.tp)}/${String(spec.expectedImportsCount)}, FP=${String(score.imports.fp)}) does not match expected frozen parity.`,
      );
    }
    if (
      score.primaryCalls.tp !== spec.expectedPrimaryCallsCount ||
      score.primaryCalls.fp !== 0 ||
      score.primaryCalls.fn !== 0
    ) {
      accuracyReasons.push(
        `Library-enabled Primary CALLS score (${String(score.primaryCalls.tp)}/${String(spec.expectedPrimaryCallsCount)}, FP=${String(score.primaryCalls.fp)}) does not match expected frozen parity.`,
      );
    }
  }

  const accuracyAccepted = accuracyReasons.length === 0;
  const acceptanceReasons = [...accuracyReasons, ...memoryEval.reasons];
  const benchmarkAccepted = accuracyAccepted && memoryEval.accepted;

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runId,
    scoredAtUtc: new Date().toISOString(),
    executionStatus: 'success',
    benchmarkAccepted,
    accuracyAccepted,
    memoryAccepted: memoryEval.accepted,
    acceptanceReasons,
    failureReason: null,
    repoId: parentRecord.repoId,
    repository: parentRecord.repository,
    commitSha: parentRecord.commitSha,
    manifestSha256: parentRecord.manifestSha256,
    parentTopology: parentRecord.parentTopology,
    parentRunnerMode: parentRecord.parentRunnerMode,
    runnerConfig: parentRecord.runnerConfig,
    environment: parentRecord.environment,
    snapshotInventory: parentRecord.snapshotInventory,
    parentRecord,
    windowsMonitor,
    stats: persistedGraphOutput.stats,
    warningsCount: persistedGraphOutput.warnings.length,
    graphDigest: score.graphDigest,
    expectedWithLibDigest,
    matchesWithLibReferenceDigest,
    score,
  };
}

function isContainedInsideRunDir(runDir: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(runDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return process.platform === 'win32'
    ? resolvedCandidate.toLowerCase().startsWith(prefix.toLowerCase())
    : resolvedCandidate.startsWith(prefix);
}

export async function scoreRunDirectory(options: {
  readonly runDir: string;
  readonly runId: string;
  readonly parentRecordPath: string;
  readonly monitorPath?: string;
  readonly outPath: string;
  readonly archonRoot?: string;
}): Promise<ScoredBenchmarkRunRecord> {
  const parentRaw = await readFile(options.parentRecordPath, 'utf8');
  const parentRecord = validateParentBenchmarkRunRecord(
    parseBenchmarkJson(parentRaw, options.parentRecordPath),
    options.parentRecordPath,
  );

  const spec = FROZEN_EVAL_REPOS[parentRecord.repoId];
  const archonRoot = options.archonRoot ?? ARCHON_ROOT;
  const manifestPath = path.resolve(archonRoot, ...spec.manifestRelativePath.split('/'));
  const { manifest } = await verifyAndLoadFrozenManifest(manifestPath, spec.manifestSha256, spec);

  let windowsMonitor: WindowsMonitorSummary | null = null;
  let monitorLoadError: string | null = null;
  if (options.monitorPath !== undefined) {
    try {
      const monRaw = await readFile(options.monitorPath, 'utf8');
      windowsMonitor = validateWindowsMonitorSummary(
        parseBenchmarkJson(monRaw, options.monitorPath),
        options.monitorPath,
      );
    } catch (err: unknown) {
      monitorLoadError = err instanceof Error ? err.message : 'Failed to parse monitor artifact.';
    }
  }

  let persistedGraphOutput: AnalysisOutput | null = null;
  let graphLoadError: string | null = null;
  const firstIter = parentRecord.iterations[0];
  if (firstIter?.graphArtifactFileName !== null && firstIter?.graphArtifactFileName !== undefined) {
    if (!isSafeArtifactBasename(firstIter.graphArtifactFileName)) {
      graphLoadError = `Unsafe graphArtifactFileName "${firstIter.graphArtifactFileName}".`;
    } else {
      const graphPath = path.resolve(options.runDir, firstIter.graphArtifactFileName);
      if (!isContainedInsideRunDir(options.runDir, graphPath)) {
        graphLoadError = `Graph artifact path escapes runDir.`;
      } else {
        try {
          const graphRaw = await readFile(graphPath, 'utf8');
          const parsedGraph = analysisOutputSchema.safeParse(
            parseBenchmarkJson(graphRaw, graphPath),
          );
          if (!parsedGraph.success) {
            graphLoadError = `AnalysisOutput schema validation failed: ${parsedGraph.error.issues[0]?.message ?? 'invalid schema'}`;
          } else {
            persistedGraphOutput = parsedGraph.data;
          }
        } catch (err: unknown) {
          graphLoadError =
            err instanceof Error ? err.message : 'Failed to read persisted graph output.';
        }
      }
    }
  }

  const scored = scorePersistedBenchmarkRun({
    runId: options.runId,
    manifest,
    parentRecord,
    persistedGraphOutput,
    windowsMonitor,
    graphLoadError,
    monitorLoadError,
  });

  await writeFileExclusiveJson(options.outPath, scored);
  return scored;
}

function configsStrictlyMatch(
  a: BenchmarkRunnerConfigRecord,
  b: BenchmarkRunnerConfigRecord,
): boolean {
  return (
    a.parserTimeoutMs === b.parserTimeoutMs &&
    a.maxOldSpaceSizeMb === b.maxOldSpaceSizeMb &&
    a.maxResponseBytes === b.maxResponseBytes &&
    a.terminateGraceMs === b.terminateGraceMs &&
    a.killConfirmationMs === b.killConfirmationMs &&
    a.skipLoadingLibFiles === b.skipLoadingLibFiles &&
    a.maxSupportedFiles === b.maxSupportedFiles &&
    a.maxConfigFiles === b.maxConfigFiles &&
    a.maxFileBytes === b.maxFileBytes &&
    a.maxTotalBytes === b.maxTotalBytes &&
    a.maxFileSnippetChars === b.maxFileSnippetChars &&
    a.maxSymbolSnippetChars === b.maxSymbolSnippetChars &&
    a.maxCallSiteSnippetChars === b.maxCallSiteSnippetChars &&
    a.maxWarnings === b.maxWarnings &&
    a.maxExtendsDepth === b.maxExtendsDepth
  );
}

function environmentsStrictlyMatch(
  a: BenchmarkEnvironmentRecord,
  b: BenchmarkEnvironmentRecord,
): boolean {
  return (
    a.nodeVersion === b.nodeVersion &&
    a.platform === b.platform &&
    a.osRelease === b.osRelease &&
    a.arch === b.arch &&
    a.bundledTypeScriptVersion === b.bundledTypeScriptVersion
  );
}

export function validateScoredBenchmarkRunRecord(
  raw: unknown,
  label: string,
): ScoredBenchmarkRunRecord {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${label} must be a JSON object.`);
  }
  if (raw.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new BenchmarkError(`${label}.schemaVersion must be 1.`);
  }
  const runId = readStr(raw, 'runId', label);
  const scoredAtUtc = readStr(raw, 'scoredAtUtc', label);
  const executionStatus = raw.executionStatus;
  if (executionStatus !== 'success' && executionStatus !== 'failed') {
    throw new BenchmarkError(`${label}.executionStatus must be "success" or "failed".`);
  }
  const benchmarkAccepted = readBool(raw, 'benchmarkAccepted', label);
  const accuracyAccepted = readNullableBool(raw, 'accuracyAccepted', label);
  const memoryAccepted = readNullableBool(raw, 'memoryAccepted', label);
  const acceptanceReasons = readStringList(raw, 'acceptanceReasons', label);
  const failureReason = readNullableStr(raw, 'failureReason', label);

  const repoIdRaw = readStr(raw, 'repoId', label);
  if (!isBenchmarkRepoId(repoIdRaw)) {
    throw new BenchmarkError(`${label}.repoId "${repoIdRaw}" is invalid.`);
  }
  const spec = FROZEN_EVAL_REPOS[repoIdRaw];
  const repository = readStr(raw, 'repository', label);
  const commitSha = readStr(raw, 'commitSha', label);
  const manifestSha256 = readStr(raw, 'manifestSha256', label);
  if (
    repository !== spec.repository ||
    commitSha !== spec.commitSha ||
    manifestSha256 !== spec.manifestSha256
  ) {
    throw new BenchmarkError(`${label} repo/commit/manifest does not match frozen spec.`);
  }

  if (raw.parentTopology !== 'lightweight-parser-only-parent') {
    throw new BenchmarkError(`${label}.parentTopology must be "lightweight-parser-only-parent".`);
  }
  const parentRunnerMode = raw.parentRunnerMode;
  if (
    parentRunnerMode !== 'instrumented-spawn-pid-hook' &&
    parentRunnerMode !== 'public-createParserRunner'
  ) {
    throw new BenchmarkError(`${label}.parentRunnerMode is invalid.`);
  }

  const runnerConfig = validateBenchmarkRunnerConfig(raw.runnerConfig, `${label}.runnerConfig`);
  const environment = validateBenchmarkEnvironment(raw.environment, `${label}.environment`);

  if (!isPlainObject(raw.snapshotInventory)) {
    throw new BenchmarkError(`${label}.snapshotInventory must be an object.`);
  }
  const invCtx = `${label}.snapshotInventory`;
  const snapshotInventory = {
    supportedFilesCount: readNonNegInt(raw.snapshotInventory, 'supportedFilesCount', invCtx),
    configFilesCount: readNonNegInt(raw.snapshotInventory, 'configFilesCount', invCtx),
    totalSupportedBytes: readNonNegInt(raw.snapshotInventory, 'totalSupportedBytes', invCtx),
    totalConfigBytes: readNonNegInt(raw.snapshotInventory, 'totalConfigBytes', invCtx),
  };

  const parentRecord =
    raw.parentRecord === null
      ? null
      : validateParentBenchmarkRunRecord(raw.parentRecord, `${label}.parentRecord`);
  const windowsMonitor =
    raw.windowsMonitor === null
      ? null
      : validateWindowsMonitorSummary(raw.windowsMonitor, `${label}.windowsMonitor`);
  const stats =
    raw.stats === null ? null : validateBenchmarkAnalysisStats(raw.stats, `${label}.stats`);
  const warningsCount =
    raw.warningsCount === null ? null : readNonNegInt(raw, 'warningsCount', label);
  const graphDigest = readNullableStr(raw, 'graphDigest', label);
  if (graphDigest !== null && !HEX_64_RE.test(graphDigest)) {
    throw new BenchmarkError(`${label}.graphDigest must be a 64-char lowercase hex SHA-256.`);
  }
  const expectedWithLibDigest = readStr(raw, 'expectedWithLibDigest', label);
  if (expectedWithLibDigest !== REFERENCE_WITH_LIB_DIGESTS[repoIdRaw]) {
    throw new BenchmarkError(`${label}.expectedWithLibDigest does not match reference digest.`);
  }
  const matchesWithLibReferenceDigest = readNullableBool(
    raw,
    'matchesWithLibReferenceDigest',
    label,
  );
  const score =
    raw.score === null ? null : validateRepositoryScoreResult(raw.score, spec, `${label}.score`);

  // Cross-field consistency checks
  if (executionStatus === 'success') {
    if (score === null || graphDigest === null || stats === null) {
      throw new BenchmarkError(
        `${label} marked executionStatus="success" requires score, stats, and graphDigest.`,
      );
    }
    if (score.graphDigest !== graphDigest) {
      throw new BenchmarkError(`${label}.graphDigest does not match score.graphDigest.`);
    }
    if (matchesWithLibReferenceDigest !== (graphDigest === expectedWithLibDigest)) {
      throw new BenchmarkError(
        `${label}.matchesWithLibReferenceDigest is inconsistent with graphDigest.`,
      );
    }
  } else {
    if (benchmarkAccepted) {
      throw new BenchmarkError(
        `${label} cannot have benchmarkAccepted=true when executionStatus="failed".`,
      );
    }
    if (failureReason === null) {
      throw new BenchmarkError(
        `${label} with executionStatus="failed" requires non-null failureReason.`,
      );
    }
  }
  if (benchmarkAccepted && (accuracyAccepted !== true || memoryAccepted !== true)) {
    throw new BenchmarkError(
      `${label} cannot have benchmarkAccepted=true unless accuracyAccepted=true and memoryAccepted=true.`,
    );
  }

  return {
    schemaVersion: 1,
    runId,
    scoredAtUtc,
    executionStatus,
    benchmarkAccepted,
    accuracyAccepted,
    memoryAccepted,
    acceptanceReasons,
    failureReason,
    repoId: repoIdRaw,
    repository,
    commitSha,
    manifestSha256,
    parentTopology: 'lightweight-parser-only-parent',
    parentRunnerMode,
    runnerConfig,
    environment,
    snapshotInventory,
    parentRecord,
    windowsMonitor,
    stats,
    warningsCount,
    graphDigest,
    expectedWithLibDigest,
    matchesWithLibReferenceDigest,
    score,
  };
}

/**
 * Stage D: Aggregates scored single-run benchmark records into a reproducible report.
 * - Enforces identical runnerConfig (all 15 fields), topology, mode, and runtime environment
 *   (automatically keeping Windows/Linux and with-lib/without-lib reports separate).
 * - Rejects duplicate `runId`s, duplicate execution records, and multi-iteration records
 *   (repeated-job retention aggregation belongs to Batch 4.3C.3).
 * - Preserves all failed and unaccepted runs explicitly; never silently filters failures out.
 * - Marks `complete: true` and `accepted: true` ONLY with exact 3-repo × expectedRunsPerRepo
 *   coverage, zero failures, zero unaccepted runs, and exact reference parity in with-lib mode.
 */
export function aggregateBenchmarkRuns(
  runs: readonly ScoredBenchmarkRunRecord[],
  options: { readonly expectedRunsPerRepo?: number } = {},
): AggregatedBenchmarkReport {
  if (runs.length === 0) {
    throw new BenchmarkError('At least one scored benchmark run is required for aggregation.');
  }
  const expectedRunsPerRepo = options.expectedRunsPerRepo ?? 3;
  const first = runs[0];
  if (first === undefined) {
    throw new BenchmarkError('At least one scored benchmark run is required.');
  }

  const seenRunIds = new Set<string>();
  const seenRunSignatures = new Set<string>();

  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (run === undefined) {
      continue;
    }

    if (seenRunIds.has(run.runId)) {
      throw new BenchmarkError(`Duplicate runId provided in aggregation: "${run.runId}".`);
    }
    seenRunIds.add(run.runId);

    if (run.parentRecord !== null) {
      if (run.parentRecord.iterations.length !== 1) {
        throw new BenchmarkError(
          `Run "${run.runId}" contains ${String(run.parentRecord.iterations.length)} iterations; single-run matrix aggregation rejects multi-iteration repeated-job records (deferred to Batch 4.3C.3).`,
        );
      }
      const iter0 = run.parentRecord.iterations[0];
      const signature = JSON.stringify([
        run.repoId,
        run.parentRecord.parentProcess.pid,
        run.parentRecord.parentProcess.startedAtUtc,
        iter0?.requestId ?? null,
      ]);
      if (seenRunSignatures.has(signature)) {
        throw new BenchmarkError(
          `Duplicate run record detected for "${run.runId}" (identical repo/parentPid/startedAtUtc/requestId).`,
        );
      }
      seenRunSignatures.add(signature);
    }

    if (i > 0) {
      if (!configsStrictlyMatch(first.runnerConfig, run.runnerConfig)) {
        throw new BenchmarkError(
          `Inconsistent runnerConfig across runs ("${run.runId}" differs from "${first.runId}").`,
        );
      }
      if (run.parentRunnerMode !== first.parentRunnerMode) {
        throw new BenchmarkError(
          `Mixed parentRunnerMode across runs ("${run.runId}" has ${run.parentRunnerMode}, "${first.runId}" has ${first.parentRunnerMode}).`,
        );
      }
      if (!environmentsStrictlyMatch(first.environment, run.environment)) {
        throw new BenchmarkError(
          `Inconsistent runtime environment across runs ("${run.runId}" differs from "${first.runId}"; keep Windows/Linux and Node/TS versions separate).`,
        );
      }
    }
  }

  const byRepo = new Map<FrozenRepoId, ScoredBenchmarkRunRecord[]>();
  const failedOrUnacceptedRunSummaries: {
    readonly runId: string;
    readonly repoId: FrozenRepoId;
    readonly executionStatus: ScoredBenchmarkRunRecord['executionStatus'];
    readonly benchmarkAccepted: boolean;
    readonly accuracyAccepted: boolean | null;
    readonly memoryAccepted: boolean | null;
    readonly failureReason: string | null;
    readonly acceptanceReasons: readonly string[];
    readonly parentRunStatus: ParentBenchmarkRunRecord['runStatus'] | null;
    readonly monitorStatus: WindowsMonitorSummary['monitorStatus'] | null;
  }[] = [];

  let executionSucceededCount = 0;
  let acceptedRunsCount = 0;
  let failedRunsCount = 0;
  let unacceptedRunsCount = 0;

  for (const run of runs) {
    const list = byRepo.get(run.repoId);
    if (list !== undefined) {
      list.push(run);
    } else {
      byRepo.set(run.repoId, [run]);
    }
    if (run.executionStatus === 'success') {
      executionSucceededCount += 1;
    } else {
      failedRunsCount += 1;
    }
    if (run.benchmarkAccepted) {
      acceptedRunsCount += 1;
    } else {
      unacceptedRunsCount += 1;
      failedOrUnacceptedRunSummaries.push({
        runId: run.runId,
        repoId: run.repoId,
        executionStatus: run.executionStatus,
        benchmarkAccepted: run.benchmarkAccepted,
        accuracyAccepted: run.accuracyAccepted,
        memoryAccepted: run.memoryAccepted,
        failureReason: run.failureReason,
        acceptanceReasons: run.acceptanceReasons,
        parentRunStatus: run.parentRecord?.runStatus ?? null,
        monitorStatus: run.windowsMonitor?.monitorStatus ?? null,
      });
    }
  }

  const repositories: AggregatedRepoBenchmarkSummary[] = [];
  const representativeScores: RepositoryScoreResult[] = [];
  let allReposExactCoverage = true;
  let allReposAccepted = true;

  for (const repoId of ORDERED_FROZEN_REPOS) {
    const repoRuns = byRepo.get(repoId);
    if (repoRuns === undefined || repoRuns.length === 0) {
      allReposExactCoverage = false;
      allReposAccepted = false;
      continue;
    }

    const succeededRuns = repoRuns.filter((r) => r.executionStatus === 'success');
    const acceptedRuns = repoRuns.filter((r) => r.benchmarkAccepted);
    if (repoRuns.length !== expectedRunsPerRepo) {
      allReposExactCoverage = false;
    }
    if (acceptedRuns.length !== expectedRunsPerRepo || repoRuns.length !== expectedRunsPerRepo) {
      allReposAccepted = false;
    }

    const firstSuccess = succeededRuns[0];
    let deterministicGraphDigest: boolean | null = null;
    let graphDigest: string | null = null;
    let matchesWithLibReferenceDigest: boolean | null = null;

    if (firstSuccess !== undefined && firstSuccess.graphDigest !== null) {
      graphDigest = firstSuccess.graphDigest;
      matchesWithLibReferenceDigest = firstSuccess.matchesWithLibReferenceDigest;
      deterministicGraphDigest = succeededRuns.every((r) => r.graphDigest === graphDigest);
      if (!deterministicGraphDigest) {
        throw new BenchmarkError(
          `Non-deterministic graphDigest detected across benchmark runs for "${repoId}".`,
        );
      }
      if (firstSuccess.score !== null) {
        representativeScores.push(firstSuccess.score);
      }
    }

    const childDurations: number[] = [];
    const endToEndDurations: number[] = [];
    const validationDurations: number[] = [];
    const responseBytes: number[] = [];
    const childMaxRssKiB: number[] = [];
    const osChildPeakWs: number[] = [];
    const osParentPeakWs: number[] = [];
    const osCombinedWs: number[] = [];
    const osCombinedPriv: number[] = [];

    for (const r of succeededRuns) {
      const m = r.parentRecord?.iterations[0]?.metrics;
      if (m !== null && m !== undefined) {
        childDurations.push(m.childAnalysisDurationMs);
        endToEndDurations.push(m.endToEndDurationMs);
        validationDurations.push(m.parentValidationDurationMs);
        responseBytes.push(m.serializedResponseBytes);
        childMaxRssKiB.push(m.childPreSendMemory.maxRssKiB);
      }
      const winMem = r.windowsMonitor?.parserExecutionWindowMemory;
      if (winMem !== undefined && r.memoryAccepted === true) {
        if (winMem.childOsReportedPeakWorkingSetBytes !== null) {
          osChildPeakWs.push(winMem.childOsReportedPeakWorkingSetBytes);
        } else if (winMem.childSampledWorkingSetPeakBytes !== null) {
          osChildPeakWs.push(winMem.childSampledWorkingSetPeakBytes);
        }
        if (winMem.parentSampledWorkingSetPeakBytes !== null) {
          osParentPeakWs.push(winMem.parentSampledWorkingSetPeakBytes);
        }
        if (winMem.maxSameIterationCombinedWorkingSetBytes !== null) {
          osCombinedWs.push(winMem.maxSameIterationCombinedWorkingSetBytes);
        }
        if (winMem.maxSameIterationCombinedPrivateMemoryBytes !== null) {
          osCombinedPriv.push(winMem.maxSameIterationCombinedPrivateMemoryBytes);
        }
      }
    }

    const spec = FROZEN_EVAL_REPOS[repoId];
    repositories.push({
      repoId,
      repository: spec.repository,
      commitSha: spec.commitSha,
      totalRuns: repoRuns.length,
      executionSucceededRuns: succeededRuns.length,
      acceptedRuns: acceptedRuns.length,
      failedOrUnacceptedRuns: repoRuns.length - acceptedRuns.length,
      deterministicGraphDigest,
      graphDigest,
      matchesWithLibReferenceDigest,
      childAnalysisDurationMs: summarizeNumbers(childDurations),
      endToEndDurationMs: summarizeNumbers(endToEndDurations),
      parentValidationDurationMs: summarizeNumbers(validationDurations),
      serializedResponseBytes: summarizeNumbers(responseBytes),
      childPreSendMaxRssKiB: summarizeNumbers(childMaxRssKiB),
      osChildPeakWorkingSetBytes: summarizeNumbers(osChildPeakWs),
      osParentPeakWorkingSetBytes: summarizeNumbers(osParentPeakWs),
      osMaxSameIterationCombinedWorkingSetBytes: summarizeNumbers(osCombinedWs),
      osMaxSameIterationCombinedPrivateMemoryBytes: summarizeNumbers(osCombinedPriv),
      representativeScore: firstSuccess?.score ?? null,
    });
  }

  const hasFailures = failedRunsCount > 0;
  const hasUnacceptedRuns = unacceptedRunsCount > 0;
  const complete =
    !hasFailures && allReposExactCoverage && repositories.length === ORDERED_FROZEN_REPOS.length;
  const accepted =
    complete && !hasUnacceptedRuns && allReposAccepted && acceptedRunsCount === runs.length;

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    complete,
    accepted,
    hasFailures,
    hasUnacceptedRuns,
    expectedReposCount: ORDERED_FROZEN_REPOS.length,
    expectedRunsPerRepo,
    totalRunsProvided: runs.length,
    executionSucceededCount,
    acceptedRunsCount,
    failedRunsCount,
    unacceptedRunsCount,
    parentTopology: first.parentTopology,
    parentRunnerMode: first.parentRunnerMode,
    runnerConfig: first.runnerConfig,
    environment: first.environment,
    repositories,
    aggregateAccuracy:
      representativeScores.length > 0 ? aggregateRepositoryScores(representativeScores) : null,
    failedOrUnacceptedRunSummaries,
  };
}

export function formatBenchmarkMarkdown(report: AggregatedBenchmarkReport): string {
  const lines: string[] = [];
  const statusTag = report.accepted
    ? 'COMPLETE & ACCEPTED'
    : report.hasFailures
      ? 'INCOMPLETE — CONTAINS FAILURES'
      : report.hasUnacceptedRuns
        ? 'UNACCEPTED — FAILED ACCEPTANCE GATE'
        : 'PARTIAL — INCOMPLETE COVERAGE';
  lines.push(`# Parser Subprocess Isolation Benchmark Report (${statusTag})`);
  lines.push('');
  lines.push(
    `- Topology: \`${report.parentTopology}\` (NOT full production API+worker) | Mode: \`${report.parentRunnerMode}\``,
  );
  lines.push(
    `- Config: \`skipLoadingLibFiles=${String(report.runnerConfig.skipLoadingLibFiles)}\`, \`maxOldSpaceSizeMb=${String(report.runnerConfig.maxOldSpaceSizeMb)}\`, \`parserTimeoutMs=${String(report.runnerConfig.parserTimeoutMs)}\`, \`maxResponseBytes=${String(report.runnerConfig.maxResponseBytes)}\``,
  );
  lines.push(
    `- Environment: Node \`${report.environment.nodeVersion}\`, bundled TS \`${report.environment.bundledTypeScriptVersion}\`, \`${report.environment.platform}/${report.environment.arch}\` (release \`${report.environment.osRelease}\`)`,
  );
  lines.push(
    `- Runs: ${String(report.acceptedRunsCount)} accepted / ${String(report.executionSucceededCount)} executed OK / ${String(report.failedRunsCount)} failed / ${String(report.totalRunsProvided)} total`,
  );
  lines.push('');
  lines.push(
    'Repository | Accepted / Total | Digest Match (with-lib ref) | Median Child (ms) | Median End-to-End (ms) | Median Child Pre-Send maxRSS | Median OS Child Peak WS | Median Same-Tick Combined WS | Median Same-Tick Combined Private',
  );
  lines.push('--- | :---: | :---: | ---: | ---: | ---: | ---: | ---: | ---:');

  for (const repo of report.repositories) {
    lines.push(
      `${repo.repository} | ${String(repo.acceptedRuns)}/${String(repo.totalRuns)} | ${repo.matchesWithLibReferenceDigest === null ? 'N/A' : repo.matchesWithLibReferenceDigest ? 'EXACT' : 'DIFFERS'} | ${String(repo.childAnalysisDurationMs.median ?? 'N/A')} | ${String(repo.endToEndDurationMs.median ?? 'N/A')} | ${formatKiBAsMiB(repo.childPreSendMaxRssKiB.median)} | ${formatMiB(repo.osChildPeakWorkingSetBytes.median)} | ${formatMiB(repo.osMaxSameIterationCombinedWorkingSetBytes.median)} | ${formatMiB(repo.osMaxSameIterationCombinedPrivateMemoryBytes.median)}`,
    );
  }

  if (report.aggregateAccuracy !== null) {
    lines.push('');
    lines.push('## Sampled Accuracy (Micro-Averaged Once Per Covered Repository)');
    const agg = report.aggregateAccuracy;
    lines.push(
      `- IMPORTS: ${String(agg.imports.tp)}/${String(agg.imports.expectedCount)} (FP=${String(agg.imports.fp)}, P=${formatPercent(agg.imports.precision)}, R=${formatPercent(agg.imports.recall)}, F1=${formatPercent(agg.imports.f1)})`,
    );
    lines.push(
      `- Primary CALLS: ${String(agg.primaryCalls.tp)}/${String(agg.primaryCalls.expectedCount)} (FP=${String(agg.primaryCalls.fp)}, P=${formatPercent(agg.primaryCalls.precision)}, R=${formatPercent(agg.primaryCalls.recall)}, F1=${formatPercent(agg.primaryCalls.f1)})`,
    );
    lines.push(
      `- Broader CALLS: ${String(agg.broaderCalls.tp)}/${String(agg.broaderCalls.expectedCount)} (FP=${String(agg.broaderCalls.fp)}, P=${formatPercent(agg.broaderCalls.precision)}, R=${formatPercent(agg.broaderCalls.recall)}, F1=${formatPercent(agg.broaderCalls.f1)})`,
    );
  }

  for (const repo of report.repositories) {
    const s = repo.representativeScore;
    if (s === null) {
      continue;
    }
    const hasMismatches =
      s.imports.falsePositives.length > 0 ||
      s.imports.falseNegatives.length > 0 ||
      s.primaryCalls.falsePositives.length > 0 ||
      s.primaryCalls.falseNegatives.length > 0;
    if (hasMismatches) {
      lines.push('');
      lines.push(`### Mismatches — ${repo.repository}`);
      for (const fp of s.imports.falsePositives) {
        lines.push(`- [IMPORTS FP] ${formatImportIdentity(fp)}`);
      }
      for (const fn of s.imports.falseNegatives) {
        lines.push(`- [IMPORTS FN] ${formatImportIdentity(fn)}`);
      }
      for (const fp of s.primaryCalls.falsePositives) {
        lines.push(`- [PRIMARY CALLS FP] ${formatCallIdentity(fp)}`);
      }
      for (const fn of s.primaryCalls.falseNegatives) {
        lines.push(`- [PRIMARY CALLS FN] ${formatCallIdentity(fn)}`);
      }
    }
  }

  if (report.failedOrUnacceptedRunSummaries.length > 0) {
    lines.push('');
    lines.push('## Failed or Unaccepted Runs (Preserved — Never Discarded)');
    for (const f of report.failedOrUnacceptedRunSummaries) {
      lines.push(
        `- \`${f.runId}\` (${f.repoId}): execution=${f.executionStatus}, accepted=${String(f.benchmarkAccepted)}, accuracyAccepted=${String(f.accuracyAccepted)}, memoryAccepted=${String(f.memoryAccepted)} — ${f.acceptanceReasons.join(' | ')}`,
      );
    }
  }

  return lines.join('\n');
}

function getFlag(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

function getMultiFlag(args: readonly string[], flag: string): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.push(next);
      }
    }
  }
  return out;
}

function normalizePathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function runScoreCli(argv: readonly string[]): Promise<void> {
  const cmd = argv[0];

  if (cmd === 'prepare') {
    const repoArg = getFlag(argv, '--repo');
    const repoDir = getFlag(argv, '--repo-dir');
    const bundlePath = getFlag(argv, '--bundle');
    const outPath = getFlag(argv, '--out');
    if (
      repoArg === undefined ||
      !isBenchmarkRepoId(repoArg) ||
      repoDir === undefined ||
      bundlePath === undefined ||
      outPath === undefined
    ) {
      throw new BenchmarkError(
        'Usage: node scripts/dist/benchmark-parser-score.js prepare --repo <id> --repo-dir <dir> --bundle <file> --out <file>',
      );
    }
    const prepared = await prepareBenchmarkInventory({
      repoId: repoArg,
      repoRoot: repoDir,
      bundlePath,
      outPath,
    });
    process.stdout.write(
      `[prepare] ${prepared.repository}@${prepared.commitSha.slice(0, 7)} | sources=${String(prepared.supportedFiles.length)} configs=${String(prepared.configFiles.length)} bytes=${String(prepared.totalSupportedBytes)} ts=${prepared.bundledTypeScriptVersion}\n`,
    );
    return;
  }

  if (cmd === 'score') {
    const runDir = getFlag(argv, '--run-dir');
    const runId = getFlag(argv, '--run-id');
    const parentRecordPath = getFlag(argv, '--parent-record');
    const monitorPath = getFlag(argv, '--monitor');
    const outPath = getFlag(argv, '--out');
    if (
      runDir === undefined ||
      runId === undefined ||
      parentRecordPath === undefined ||
      outPath === undefined
    ) {
      throw new BenchmarkError(
        'Usage: node scripts/dist/benchmark-parser-score.js score --run-dir <dir> --run-id <id> --parent-record <file> [--monitor <file>] --out <file>',
      );
    }
    const scored = await scoreRunDirectory({
      runDir,
      runId,
      parentRecordPath,
      ...(monitorPath !== undefined ? { monitorPath } : {}),
      outPath,
    });
    process.stdout.write(
      `[score] ${scored.runId} | execution=${scored.executionStatus} | accepted=${String(scored.benchmarkAccepted)} (acc=${String(scored.accuracyAccepted)}, mem=${String(scored.memoryAccepted)}) | digest=${scored.graphDigest?.slice(0, 12) ?? 'NONE'} | matchesRef=${String(scored.matchesWithLibReferenceDigest)}\n`,
    );
    return;
  }

  if (cmd === 'aggregate') {
    const rawRunFiles = getMultiFlag(argv, '--run');
    const outJsonPath = getFlag(argv, '--out-json');
    const outMdPath = getFlag(argv, '--out-md');
    const expectedRunsPerRepoRaw = getFlag(argv, '--expected-runs-per-repo');
    if (rawRunFiles.length === 0) {
      throw new BenchmarkError(
        'Usage: node scripts/dist/benchmark-parser-score.js aggregate --run <scored1.json> [--run ...] [--expected-runs-per-repo 3] [--out-json <file>] [--out-md <file>]',
      );
    }
    const seen = new Set<string>();
    for (const file of rawRunFiles) {
      const key = normalizePathKey(file);
      if (seen.has(key)) {
        throw new BenchmarkError(`Duplicate --run file provided: "${file}".`);
      }
      seen.add(key);
    }

    const sortedFiles = [...rawRunFiles].sort(compareCodePoint);
    const records: ScoredBenchmarkRunRecord[] = [];
    for (const file of sortedFiles) {
      const raw = await readFile(file, 'utf8');
      records.push(validateScoredBenchmarkRunRecord(parseBenchmarkJson(raw, file), file));
    }

    let expectedRunsPerRepo = 3;
    if (expectedRunsPerRepoRaw !== undefined) {
      const parsedCount = Number(expectedRunsPerRepoRaw);
      if (!Number.isSafeInteger(parsedCount) || parsedCount < 1) {
        throw new BenchmarkError('--expected-runs-per-repo must be a positive integer.');
      }
      expectedRunsPerRepo = parsedCount;
    }

    const report = aggregateBenchmarkRuns(records, { expectedRunsPerRepo });
    const markdown = formatBenchmarkMarkdown(report);

    if (outJsonPath !== undefined) {
      await writeFileExclusiveJson(outJsonPath, report);
    }
    if (outMdPath !== undefined) {
      const resolvedMd = path.resolve(outMdPath);
      await mkdir(path.dirname(resolvedMd), { recursive: true });
      await writeFile(resolvedMd, `${markdown}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    process.stdout.write(`${markdown}\n`);
    return;
  }

  throw new BenchmarkError('Unknown command. Expected: prepare | score | aggregate.');
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runScoreCli(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`BENCHMARK_SCORE_ERROR: ${message}\n`);
    process.exitCode = 1;
  });
}
