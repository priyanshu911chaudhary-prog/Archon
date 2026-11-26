import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analysisStatsSchema, type AnalysisStats } from '@archon/shared';
import type { ParserRunMetrics, ParserRunnerState } from '../apps/worker/src/parser-runner.js';
import type {
  AggregateEvaluationMetrics,
  FrozenRepoId,
  RepositoryScoreResult,
} from './eval-policy.js';

export const BENCHMARK_SCHEMA_VERSION = 1 as const;
export const BENCHMARK_EVENT_PREFIX = 'ARCHON_BENCH_EVENT:' as const;

export const PROVISIONAL_COMBINED_HEADROOM_BYTES = 410 * 1024 * 1024;

/**
 * Preliminary memory-coverage acceptance policy for Windows external-monitor runs.
 * Insufficient sampling marks `memoryAccepted: false` (incomplete memory measurement)
 * without fabricating peak values or discarding raw execution/accuracy evidence.
 */
export const PRELIMINARY_MEMORY_COVERAGE_POLICY = {
  minPairedParserWindowSamples: 1,
  minValidChildSamplesInstrumented: 1,
  requireCompletedMonitor: true,
  requireZeroQuarantinedProcesses: true,
  requireMatchingParentPid: true,
  requireMatchingChildPidInstrumented: true,
  description:
    'Requires completed monitor, zero quarantined processes, matching parent/child PID identities across records, and >= 1 valid paired parent+child sample during the parser execution window (with non-null same-iteration combined working set).',
} as const;

export const REFERENCE_WITH_LIB_DIGESTS: Readonly<Record<FrozenRepoId, string>> = {
  zustand: '97124aa98acff926bc1ef4fe9b968aff6bf8b35f2987f92f61b7bbe0d98543af',
  'nextjs-subscription-payments':
    '530baa46477a8ebe5418639b31f65eeb1ee45b29ba1d1c42fe2e9b8c98aa3f9a',
  taxonomy: 'de7edaea1ecc41aecb35baa6872b055a78aa90087e2b1c7a3908b60680534aed',
};

export const WINDOWS_COUNTER_SEMANTICS =
  'Windows System.Diagnostics.Process counters: WorkingSet64/PeakWorkingSet64 measure mapped physical pages (combined same-iteration working set may double-count shared pages); PrivateMemorySize64 measures committed private virtual bytes (not physical resident memory); PagedMemorySize64 measures committed paged virtual memory. Same-iteration parent+child readings are approximately simultaneous (not atomic), sampling can miss transient sub-interval spikes, and Windows counters are not equivalent to Linux cgroup memory accounting.';

export const WINDOWS_CLOCK_DOMAIN_NOTES =
  'Monotonic Stopwatch offsets (tMs, tickDurationMs, actualIntervalMs, pidBindingDurationMs, parentChildSkewMs) share one monitor clock domain. Cross-process wall-clock deltas (creationToFirstSampleMs, eventDeliveryLatencyMs) compare OS/parent UTC wall clocks and may be null when sub-tick skew produces a negative delta. Phase attribution switches upon monitor stdout receipt of lifecycle markers (approximate-monitor-stdout-event-receipt); zero samples in a short window (e.g. artifact persistence or final record writing) indicates the window finished faster than the sampling interval, not zero memory consumption.';

export type ParentRunnerMode = 'instrumented-spawn-pid-hook' | 'public-createParserRunner';
export type ParentTopology = 'lightweight-parser-only-parent';
export type BenchmarkRunStatus = 'success' | 'error' | 'fatal';
export type BenchmarkExecutionStatus = 'success' | 'failed';
export type WindowsMonitorStatus =
  'completed' | 'parent_nonzero_exit' | 'supervisor_timeout' | 'monitor_error';
export type ChildObservationStatus =
  'confirmed_closed' | 'observed_exited' | 'handle_unavailable' | 'still_running';
export type PhaseAttributionMethod = 'approximate-monitor-stdout-event-receipt';

const VALID_RUNNER_STATES: ReadonlySet<string> = new Set<ParserRunnerState>([
  'IDLE',
  'VALIDATING',
  'SPAWNING',
  'RUNNING',
  'RESPONSE_RECEIVED_AWAITING_EXIT',
  'TERMINATING_GRACE',
  'TERMINATING_FORCED',
  'EXITED_AWAITING_CLEANUP',
  'FATAL_TERMINATION_UNCONFIRMED',
  'FATAL_CLEANUP_UNCONFIRMED',
]);

export interface PreparedSnapshotInventory {
  readonly schemaVersion: 1;
  readonly repoId: FrozenRepoId;
  readonly repository: string;
  readonly commitSha: string;
  readonly manifestRelativePath: string;
  readonly manifestSha256: string;
  readonly canonicalRoot: string;
  readonly supportedFiles: readonly string[];
  readonly configFiles: readonly string[];
  readonly totalSupportedBytes: number;
  readonly totalConfigBytes: number;
  readonly bundledTypeScriptVersion: string;
  readonly preparedAtUtc: string;
}

export interface BenchmarkRunnerConfigRecord {
  readonly parserTimeoutMs: number;
  readonly maxOldSpaceSizeMb: number;
  readonly maxResponseBytes: number;
  readonly terminateGraceMs: number;
  readonly killConfirmationMs: number;
  readonly skipLoadingLibFiles: boolean;
  readonly maxSupportedFiles: number;
  readonly maxConfigFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFileSnippetChars: number;
  readonly maxSymbolSnippetChars: number;
  readonly maxCallSiteSnippetChars: number;
  readonly maxWarnings: number;
  readonly maxExtendsDepth: number;
}

export interface BenchmarkEnvironmentRecord {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly osRelease: string;
  readonly arch: string;
  readonly bundledTypeScriptVersion: string;
}

export interface ParentErrorRecord {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly startupFailure: boolean;
  readonly coreErrorCode?: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface ParentFatalEventRecord {
  readonly code: string;
  readonly requestId: string;
  readonly pid: number | null;
  readonly processExited: boolean;
  readonly timestampUtc: string;
}

export interface ArtifactPersistenceRecord {
  readonly durationMs: number;
  readonly graphFileBytes: number;
  readonly postPersistParentHeapUsedBytes: number;
  readonly postPersistParentRssBytes: number;
}

export interface ParentIterationRecord {
  readonly iterationIndex: number;
  readonly status: BenchmarkRunStatus;
  readonly requestId: string | null;
  readonly childPid: number | null;
  readonly finalRunnerState: ParserRunnerState;
  readonly isFatal: boolean;
  readonly hasActiveChild: boolean;
  readonly metrics: ParserRunMetrics | null;
  readonly graphArtifactFileName: string | null;
  readonly artifactPersistence: ArtifactPersistenceRecord | null;
  readonly error: ParentErrorRecord | null;
  readonly fatalEvent: ParentFatalEventRecord | null;
}

export interface ParentBenchmarkRunRecord {
  readonly schemaVersion: 1;
  readonly runStatus: BenchmarkRunStatus;
  readonly parentTopology: ParentTopology;
  readonly parentRunnerMode: ParentRunnerMode;
  readonly instrumentationOverheadNotes: string;
  readonly repoId: FrozenRepoId;
  readonly repository: string;
  readonly commitSha: string;
  readonly manifestRelativePath: string;
  readonly manifestSha256: string;
  readonly environment: BenchmarkEnvironmentRecord;
  readonly parentProcess: {
    readonly pid: number;
    readonly startedAtUtc: string;
  };
  readonly runnerConfig: BenchmarkRunnerConfigRecord;
  readonly snapshotInventory: {
    readonly supportedFilesCount: number;
    readonly configFilesCount: number;
    readonly totalSupportedBytes: number;
    readonly totalConfigBytes: number;
  };
  readonly parentStartup: {
    readonly importsLoadedDurationMs: number;
    readonly heapUsedBytes: number;
    readonly rssBytes: number;
  };
  readonly iterations: readonly ParentIterationRecord[];
  /**
   * Captured right BEFORE writing `parent-run-record.json` (therefore excludes final
   * record serialization/write; full parent lifetime through exit is observed by the external monitor).
   */
  readonly parentMemoryBeforeFinalRecordWrite: {
    readonly heapUsedBytes: number;
    readonly rssBytes: number;
    readonly preFinalRecordWriteMaxRssKiB: number;
  };
}

export interface NumericSummary {
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
}

export interface ObservedChildIdentity {
  readonly iterationIndex: number;
  readonly pid: number;
  readonly startTimeUtc: string | null;
  readonly spawnEventEmittedAtUtc: string | null;
  readonly spawnEventReceivedAtUtc: string | null;
  readonly spawnEventReceivedOffsetMs: number | null;
  readonly pidBindingDurationMs: number | null;
  readonly eventDeliveryLatencyMs: number | null;
  readonly firstValidSampleAtUtc: string | null;
  readonly firstSampleOffsetMs: number | null;
  readonly lastSampleOffsetMs: number | null;
  readonly creationToFirstSampleMs: number | null;
  readonly pairedSampleCount: number;
  readonly observationStatus: ChildObservationStatus;
}

export interface QuarantinedOwnedProcess {
  readonly role: 'parent' | 'child';
  readonly pid: number;
  readonly startTimeUtc: string | null;
}

export interface WindowsMonitorSummary {
  readonly schemaVersion: 1;
  readonly monitorStatus: WindowsMonitorStatus;
  readonly platform: string;
  readonly phaseAttributionMethod: PhaseAttributionMethod;
  readonly counterSemantics: string;
  readonly clockDomainNotes: string;
  readonly auditArtifacts: {
    readonly lifecycleEventsFile: string;
    readonly samplesFile: string;
  };
  readonly parentIdentity: {
    readonly pid: number;
    readonly startTimeUtc: string | null;
    readonly exitCode: number | null;
  };
  readonly childIdentities: readonly ObservedChildIdentity[];
  readonly sampling: {
    readonly requestedIntervalMs: number;
    readonly windowStartUtc: string;
    readonly windowEndUtc: string;
    readonly totalSamples: number;
    readonly startupWindowSamples: number;
    readonly parserWindowSamples: number;
    readonly artifactPersistenceWindowSamples: number;
    readonly finalRecordWriteWindowSamples: number;
    readonly validChildSamples: number;
    readonly pairedParserWindowSamples: number;
    readonly observedGapCount: number;
    readonly missingCounterCount: number;
    readonly counterReadFailureCount: number;
    readonly actualIntervalMs: NumericSummary;
    readonly tickDurationMs: NumericSummary;
    readonly maxParentChildSkewMs: number | null;
  };
  readonly parserExecutionWindowMemory: {
    readonly parentSampledWorkingSetPeakBytes: number | null;
    readonly parentSampledPrivateMemoryPeakBytes: number | null;
    readonly childSampledWorkingSetPeakBytes: number | null;
    readonly childOsReportedPeakWorkingSetBytes: number | null;
    readonly childSampledPrivateMemoryPeakBytes: number | null;
    readonly maxSameIterationCombinedWorkingSetBytes: number | null;
    readonly maxSameIterationCombinedPrivateMemoryBytes: number | null;
  };
  readonly fullParentLifetimeMemory: {
    readonly parentSampledWorkingSetPeakBytes: number | null;
    readonly parentOsReportedPeakWorkingSetBytes: number | null;
    readonly parentSampledPrivateMemoryPeakBytes: number | null;
  };
  readonly failureDetails: string | null;
  readonly quarantinedOwnedProcesses: readonly QuarantinedOwnedProcess[];
}

export interface ScoredBenchmarkRunRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly scoredAtUtc: string;
  /** Whether parser execution & scoring produced a valid graph without runtime failure. */
  readonly executionStatus: BenchmarkExecutionStatus;
  /** Whether the run satisfies ALL execution, accuracy/parity, and memory-coverage acceptance gates. */
  readonly benchmarkAccepted: boolean;
  readonly accuracyAccepted: boolean | null;
  readonly memoryAccepted: boolean | null;
  readonly acceptanceReasons: readonly string[];
  readonly failureReason: string | null;
  readonly repoId: FrozenRepoId;
  readonly repository: string;
  readonly commitSha: string;
  readonly manifestSha256: string;
  readonly parentTopology: ParentTopology;
  readonly parentRunnerMode: ParentRunnerMode;
  readonly runnerConfig: BenchmarkRunnerConfigRecord;
  readonly environment: BenchmarkEnvironmentRecord;
  readonly snapshotInventory: ParentBenchmarkRunRecord['snapshotInventory'];
  readonly parentRecord: ParentBenchmarkRunRecord | null;
  readonly windowsMonitor: WindowsMonitorSummary | null;
  readonly stats: AnalysisStats | null;
  readonly warningsCount: number | null;
  readonly graphDigest: string | null;
  readonly expectedWithLibDigest: string;
  readonly matchesWithLibReferenceDigest: boolean | null;
  readonly score: RepositoryScoreResult | null;
}

export interface AggregatedRepoBenchmarkSummary {
  readonly repoId: FrozenRepoId;
  readonly repository: string;
  readonly commitSha: string;
  readonly totalRuns: number;
  readonly executionSucceededRuns: number;
  readonly acceptedRuns: number;
  readonly failedOrUnacceptedRuns: number;
  readonly deterministicGraphDigest: boolean | null;
  readonly graphDigest: string | null;
  readonly matchesWithLibReferenceDigest: boolean | null;
  readonly childAnalysisDurationMs: NumericSummary;
  readonly endToEndDurationMs: NumericSummary;
  readonly parentValidationDurationMs: NumericSummary;
  readonly serializedResponseBytes: NumericSummary;
  readonly childPreSendMaxRssKiB: NumericSummary;
  readonly osChildPeakWorkingSetBytes: NumericSummary;
  readonly osParentPeakWorkingSetBytes: NumericSummary;
  readonly osMaxSameIterationCombinedWorkingSetBytes: NumericSummary;
  readonly osMaxSameIterationCombinedPrivateMemoryBytes: NumericSummary;
  readonly representativeScore: RepositoryScoreResult | null;
}

export interface AggregatedBenchmarkReport {
  readonly schemaVersion: 1;
  readonly generatedAtUtc: string;
  readonly complete: boolean;
  readonly accepted: boolean;
  readonly hasFailures: boolean;
  readonly hasUnacceptedRuns: boolean;
  readonly expectedReposCount: number;
  readonly expectedRunsPerRepo: number;
  readonly totalRunsProvided: number;
  readonly executionSucceededCount: number;
  readonly acceptedRunsCount: number;
  readonly failedRunsCount: number;
  readonly unacceptedRunsCount: number;
  readonly parentTopology: ParentTopology;
  readonly parentRunnerMode: ParentRunnerMode;
  readonly runnerConfig: BenchmarkRunnerConfigRecord;
  readonly environment: BenchmarkEnvironmentRecord;
  readonly repositories: readonly AggregatedRepoBenchmarkSummary[];
  readonly aggregateAccuracy: AggregateEvaluationMetrics | null;
  readonly failedOrUnacceptedRunSummaries: readonly {
    readonly runId: string;
    readonly repoId: FrozenRepoId;
    readonly executionStatus: BenchmarkExecutionStatus;
    readonly benchmarkAccepted: boolean;
    readonly accuracyAccepted: boolean | null;
    readonly memoryAccepted: boolean | null;
    readonly failureReason: string | null;
    readonly acceptanceReasons: readonly string[];
    readonly parentRunStatus: BenchmarkRunStatus | null;
    readonly monitorStatus: WindowsMonitorStatus | null;
  }[];
}

export class BenchmarkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'BenchmarkError';
  }
}

const HEX_40_RE = /^[0-9a-f]{40}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBenchmarkRepoId(value: string): value is FrozenRepoId {
  return value === 'zustand' || value === 'nextjs-subscription-payments' || value === 'taxonomy';
}

export function isSafeArtifactBasename(fileName: string): boolean {
  if (
    fileName.trim().length === 0 ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..') ||
    fileName.includes('\0')
  ) {
    return false;
  }
  return path.posix.basename(fileName) === fileName && path.win32.basename(fileName) === fileName;
}

export function parseBenchmarkJson(rawText: string, label: string): unknown {
  try {
    const parsed: unknown = JSON.parse(rawText);
    return parsed;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : 'invalid JSON';
    throw new BenchmarkError(`Failed to parse ${label} as JSON: ${detail}`, err);
  }
}

/**
 * Writes formatted UTF-8 LF JSON with exclusive `wx` flag so existing benchmark
 * artifacts can never be silently overwritten.
 */
export async function writeFileExclusiveJson(filePath: string, value: unknown): Promise<number> {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  await writeFile(resolved, serialized, { encoding: 'utf8', flag: 'wx' });
  return byteLength;
}

export function readStr(obj: Record<string, unknown>, field: string, ctx: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BenchmarkError(`${ctx}.${field} must be a non-empty string.`);
  }
  return value;
}

export function readNullableStr(
  obj: Record<string, unknown>,
  field: string,
  ctx: string,
): string | null {
  const value = obj[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BenchmarkError(`${ctx}.${field} must be a string or null.`);
  }
  return value;
}

export function readBool(obj: Record<string, unknown>, field: string, ctx: string): boolean {
  const value = obj[field];
  if (typeof value !== 'boolean') {
    throw new BenchmarkError(`${ctx}.${field} must be a boolean.`);
  }
  return value;
}

export function readNullableBool(
  obj: Record<string, unknown>,
  field: string,
  ctx: string,
): boolean | null {
  const value = obj[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'boolean') {
    throw new BenchmarkError(`${ctx}.${field} must be a boolean or null.`);
  }
  return value;
}

export function readNonNegInt(obj: Record<string, unknown>, field: string, ctx: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BenchmarkError(`${ctx}.${field} must be a non-negative safe integer.`);
  }
  return value;
}

export function readNullableNonNegInt(
  obj: Record<string, unknown>,
  field: string,
  ctx: string,
): number | null {
  const value = obj[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BenchmarkError(`${ctx}.${field} must be a non-negative safe integer or null.`);
  }
  return value;
}

export function readNullableInt(
  obj: Record<string, unknown>,
  field: string,
  ctx: string,
): number | null {
  const value = obj[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new BenchmarkError(`${ctx}.${field} must be a safe integer or null.`);
  }
  return value;
}

export function readNonNegFinite(obj: Record<string, unknown>, field: string, ctx: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BenchmarkError(`${ctx}.${field} must be a finite non-negative number.`);
  }
  return value;
}

export function readNullableNonNegFinite(
  obj: Record<string, unknown>,
  field: string,
  ctx: string,
): number | null {
  const value = obj[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BenchmarkError(`${ctx}.${field} must be a finite non-negative number or null.`);
  }
  return value;
}

export function readStringList(
  obj: Record<string, unknown>,
  field: string,
  ctx: string,
): readonly string[] {
  const value = obj[field];
  if (!Array.isArray(value)) {
    throw new BenchmarkError(`${ctx}.${field} must be an array.`);
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new BenchmarkError(`${ctx}.${field}[${String(i)}] must be a non-empty string.`);
    }
    result.push(item);
  }
  return result;
}

export function validateBenchmarkRunnerConfig(
  raw: unknown,
  ctx: string,
): BenchmarkRunnerConfigRecord {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${ctx} must be an object.`);
  }
  return {
    parserTimeoutMs: readNonNegInt(raw, 'parserTimeoutMs', ctx),
    maxOldSpaceSizeMb: readNonNegInt(raw, 'maxOldSpaceSizeMb', ctx),
    maxResponseBytes: readNonNegInt(raw, 'maxResponseBytes', ctx),
    terminateGraceMs: readNonNegInt(raw, 'terminateGraceMs', ctx),
    killConfirmationMs: readNonNegInt(raw, 'killConfirmationMs', ctx),
    skipLoadingLibFiles: readBool(raw, 'skipLoadingLibFiles', ctx),
    maxSupportedFiles: readNonNegInt(raw, 'maxSupportedFiles', ctx),
    maxConfigFiles: readNonNegInt(raw, 'maxConfigFiles', ctx),
    maxFileBytes: readNonNegInt(raw, 'maxFileBytes', ctx),
    maxTotalBytes: readNonNegInt(raw, 'maxTotalBytes', ctx),
    maxFileSnippetChars: readNonNegInt(raw, 'maxFileSnippetChars', ctx),
    maxSymbolSnippetChars: readNonNegInt(raw, 'maxSymbolSnippetChars', ctx),
    maxCallSiteSnippetChars: readNonNegInt(raw, 'maxCallSiteSnippetChars', ctx),
    maxWarnings: readNonNegInt(raw, 'maxWarnings', ctx),
    maxExtendsDepth: readNonNegInt(raw, 'maxExtendsDepth', ctx),
  };
}

export function validateBenchmarkEnvironment(
  raw: unknown,
  ctx: string,
): BenchmarkEnvironmentRecord {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${ctx} must be an object.`);
  }
  return {
    nodeVersion: readStr(raw, 'nodeVersion', ctx),
    platform: readStr(raw, 'platform', ctx),
    osRelease: readStr(raw, 'osRelease', ctx),
    arch: readStr(raw, 'arch', ctx),
    bundledTypeScriptVersion: readStr(raw, 'bundledTypeScriptVersion', ctx),
  };
}

export function validateParserRunMetrics(raw: unknown, ctx: string): ParserRunMetrics {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${ctx} must be an object.`);
  }
  if (!isPlainObject(raw.childPreSendMemory)) {
    throw new BenchmarkError(`${ctx}.childPreSendMemory must be an object.`);
  }
  const cCtx = `${ctx}.childPreSendMemory`;
  const childPreSendMemory = {
    baselineHeapUsedBytes: readNonNegInt(raw.childPreSendMemory, 'baselineHeapUsedBytes', cCtx),
    postHeapUsedBytes: readNonNegInt(raw.childPreSendMemory, 'postHeapUsedBytes', cCtx),
    baselineRssBytes: readNonNegInt(raw.childPreSendMemory, 'baselineRssBytes', cCtx),
    postRssBytes: readNonNegInt(raw.childPreSendMemory, 'postRssBytes', cCtx),
    maxRssKiB: readNonNegInt(raw.childPreSendMemory, 'maxRssKiB', cCtx),
  };

  if (!isPlainObject(raw.parentMemory)) {
    throw new BenchmarkError(`${ctx}.parentMemory must be an object.`);
  }
  const pCtx = `${ctx}.parentMemory`;
  const parentMemory = {
    baselineHeapUsedBytes: readNonNegInt(raw.parentMemory, 'baselineHeapUsedBytes', pCtx),
    postHeapUsedBytes: readNonNegInt(raw.parentMemory, 'postHeapUsedBytes', pCtx),
    baselineRssBytes: readNonNegInt(raw.parentMemory, 'baselineRssBytes', pCtx),
    postRssBytes: readNonNegInt(raw.parentMemory, 'postRssBytes', pCtx),
  };

  const rawSignal = readNullableStr(raw, 'signal', ctx);
  const signal = rawSignal !== null ? (rawSignal as NodeJS.Signals) : null;

  return {
    endToEndDurationMs: readNonNegFinite(raw, 'endToEndDurationMs', ctx),
    childAnalysisDurationMs: readNonNegFinite(raw, 'childAnalysisDurationMs', ctx),
    childPreSendMemory,
    serializedResponseBytes: readNonNegInt(raw, 'serializedResponseBytes', ctx),
    parentValidationDurationMs: readNonNegFinite(raw, 'parentValidationDurationMs', ctx),
    parentMemory,
    exitCode: readNullableInt(raw, 'exitCode', ctx),
    signal,
  };
}

function validateParentErrorRecord(raw: unknown, ctx: string): ParentErrorRecord {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${ctx} must be an object.`);
  }
  const coreErrorCode =
    raw.coreErrorCode !== undefined ? readStr(raw, 'coreErrorCode', ctx) : undefined;
  return {
    code: readStr(raw, 'code', ctx),
    message: readStr(raw, 'message', ctx),
    retryable: readBool(raw, 'retryable', ctx),
    fatal: readBool(raw, 'fatal', ctx),
    startupFailure: readBool(raw, 'startupFailure', ctx),
    ...(coreErrorCode !== undefined ? { coreErrorCode } : {}),
    exitCode: readNullableInt(raw, 'exitCode', ctx),
    signal: readNullableStr(raw, 'signal', ctx),
  };
}

function validateParentFatalEventRecord(raw: unknown, ctx: string): ParentFatalEventRecord {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${ctx} must be an object.`);
  }
  return {
    code: readStr(raw, 'code', ctx),
    requestId: readStr(raw, 'requestId', ctx),
    pid: readNullableNonNegInt(raw, 'pid', ctx),
    processExited: readBool(raw, 'processExited', ctx),
    timestampUtc: readStr(raw, 'timestampUtc', ctx),
  };
}

function validateArtifactPersistenceRecord(raw: unknown, ctx: string): ArtifactPersistenceRecord {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${ctx} must be an object.`);
  }
  return {
    durationMs: readNonNegFinite(raw, 'durationMs', ctx),
    graphFileBytes: readNonNegInt(raw, 'graphFileBytes', ctx),
    postPersistParentHeapUsedBytes: readNonNegInt(raw, 'postPersistParentHeapUsedBytes', ctx),
    postPersistParentRssBytes: readNonNegInt(raw, 'postPersistParentRssBytes', ctx),
  };
}

export function validateParentBenchmarkRunRecord(
  raw: unknown,
  label: string,
): ParentBenchmarkRunRecord {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${label} must be a JSON object.`);
  }
  if (raw.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new BenchmarkError(`${label}.schemaVersion must be 1.`);
  }
  const runStatus = raw.runStatus;
  if (runStatus !== 'success' && runStatus !== 'error' && runStatus !== 'fatal') {
    throw new BenchmarkError(`${label}.runStatus is invalid.`);
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
  const repoIdRaw = readStr(raw, 'repoId', label);
  if (!isBenchmarkRepoId(repoIdRaw)) {
    throw new BenchmarkError(`${label}.repoId "${repoIdRaw}" is invalid.`);
  }
  const commitSha = readStr(raw, 'commitSha', label);
  if (!HEX_40_RE.test(commitSha)) {
    throw new BenchmarkError(`${label}.commitSha must be a 40-char lowercase hex SHA.`);
  }
  const manifestSha256 = readStr(raw, 'manifestSha256', label);
  if (!HEX_64_RE.test(manifestSha256)) {
    throw new BenchmarkError(`${label}.manifestSha256 must be a 64-char lowercase hex SHA-256.`);
  }

  const environment = validateBenchmarkEnvironment(raw.environment, `${label}.environment`);

  if (!isPlainObject(raw.parentProcess)) {
    throw new BenchmarkError(`${label}.parentProcess must be an object.`);
  }
  const parentProcess = {
    pid: readNonNegInt(raw.parentProcess, 'pid', `${label}.parentProcess`),
    startedAtUtc: readStr(raw.parentProcess, 'startedAtUtc', `${label}.parentProcess`),
  };

  const runnerConfig = validateBenchmarkRunnerConfig(raw.runnerConfig, `${label}.runnerConfig`);

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

  if (!isPlainObject(raw.parentStartup)) {
    throw new BenchmarkError(`${label}.parentStartup must be an object.`);
  }
  const startCtx = `${label}.parentStartup`;
  const parentStartup = {
    importsLoadedDurationMs: readNonNegFinite(
      raw.parentStartup,
      'importsLoadedDurationMs',
      startCtx,
    ),
    heapUsedBytes: readNonNegInt(raw.parentStartup, 'heapUsedBytes', startCtx),
    rssBytes: readNonNegInt(raw.parentStartup, 'rssBytes', startCtx),
  };

  if (!isPlainObject(raw.parentMemoryBeforeFinalRecordWrite)) {
    throw new BenchmarkError(`${label}.parentMemoryBeforeFinalRecordWrite must be an object.`);
  }
  const memCtx = `${label}.parentMemoryBeforeFinalRecordWrite`;
  const parentMemoryBeforeFinalRecordWrite = {
    heapUsedBytes: readNonNegInt(raw.parentMemoryBeforeFinalRecordWrite, 'heapUsedBytes', memCtx),
    rssBytes: readNonNegInt(raw.parentMemoryBeforeFinalRecordWrite, 'rssBytes', memCtx),
    preFinalRecordWriteMaxRssKiB: readNonNegInt(
      raw.parentMemoryBeforeFinalRecordWrite,
      'preFinalRecordWriteMaxRssKiB',
      memCtx,
    ),
  };

  if (!Array.isArray(raw.iterations) || raw.iterations.length === 0) {
    throw new BenchmarkError(`${label}.iterations must be a non-empty array.`);
  }
  const iterations: ParentIterationRecord[] = [];
  const seenIterIndices = new Set<number>();

  for (let i = 0; i < raw.iterations.length; i += 1) {
    const item: unknown = raw.iterations[i];
    const iCtx = `${label}.iterations[${String(i)}]`;
    if (!isPlainObject(item)) {
      throw new BenchmarkError(`${iCtx} must be an object.`);
    }
    const iterationIndex = readNonNegInt(item, 'iterationIndex', iCtx);
    if (iterationIndex < 1 || seenIterIndices.has(iterationIndex)) {
      throw new BenchmarkError(`${iCtx}.iterationIndex must be a unique positive integer.`);
    }
    seenIterIndices.add(iterationIndex);

    const status = item.status;
    if (status !== 'success' && status !== 'error' && status !== 'fatal') {
      throw new BenchmarkError(`${iCtx}.status is invalid.`);
    }

    const finalRunnerStateRaw = readStr(item, 'finalRunnerState', iCtx);
    if (!VALID_RUNNER_STATES.has(finalRunnerStateRaw)) {
      throw new BenchmarkError(`${iCtx}.finalRunnerState "${finalRunnerStateRaw}" is invalid.`);
    }
    const finalRunnerState = finalRunnerStateRaw as ParserRunnerState;

    const isFatal = readBool(item, 'isFatal', iCtx);
    const hasActiveChild = readBool(item, 'hasActiveChild', iCtx);
    const requestId = readNullableStr(item, 'requestId', iCtx);
    const childPid = readNullableNonNegInt(item, 'childPid', iCtx);
    const graphArtifactFileName = readNullableStr(item, 'graphArtifactFileName', iCtx);

    if (graphArtifactFileName !== null && !isSafeArtifactBasename(graphArtifactFileName)) {
      throw new BenchmarkError(
        `${iCtx}.graphArtifactFileName "${graphArtifactFileName}" must be a safe basename inside runDir.`,
      );
    }

    const metrics =
      item.metrics === null ? null : validateParserRunMetrics(item.metrics, `${iCtx}.metrics`);
    const artifactPersistence =
      item.artifactPersistence === null
        ? null
        : validateArtifactPersistenceRecord(
            item.artifactPersistence,
            `${iCtx}.artifactPersistence`,
          );
    const error =
      item.error === null ? null : validateParentErrorRecord(item.error, `${iCtx}.error`);
    const fatalEvent =
      item.fatalEvent === null
        ? null
        : validateParentFatalEventRecord(item.fatalEvent, `${iCtx}.fatalEvent`);

    // Enforce status-dependent nullability invariants
    if (status === 'success') {
      if (metrics === null || graphArtifactFileName === null || error !== null || isFatal) {
        throw new BenchmarkError(
          `${iCtx} marked "success" must have non-null metrics and graphArtifactFileName, null error, and isFatal=false.`,
        );
      }
    } else {
      if (error === null || metrics !== null || graphArtifactFileName !== null) {
        throw new BenchmarkError(
          `${iCtx} marked "${status}" must have non-null error and null metrics/graphArtifactFileName.`,
        );
      }
      if (status === 'fatal' && !isFatal) {
        throw new BenchmarkError(`${iCtx} marked "fatal" must have isFatal=true.`);
      }
    }

    iterations.push({
      iterationIndex,
      status,
      requestId,
      childPid,
      finalRunnerState,
      isFatal,
      hasActiveChild,
      metrics,
      graphArtifactFileName,
      artifactPersistence,
      error,
      fatalEvent,
    });
  }

  return {
    schemaVersion: 1,
    runStatus,
    parentTopology: 'lightweight-parser-only-parent',
    parentRunnerMode,
    instrumentationOverheadNotes: readStr(raw, 'instrumentationOverheadNotes', label),
    repoId: repoIdRaw,
    repository: readStr(raw, 'repository', label),
    commitSha,
    manifestRelativePath: readStr(raw, 'manifestRelativePath', label),
    manifestSha256,
    environment,
    parentProcess,
    runnerConfig,
    snapshotInventory,
    parentStartup,
    iterations,
    parentMemoryBeforeFinalRecordWrite,
  };
}

export function validatePreparedSnapshotInventory(
  raw: unknown,
  label: string,
): PreparedSnapshotInventory {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${label} must be a JSON object.`);
  }
  if (raw.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new BenchmarkError(`${label}.schemaVersion must be 1.`);
  }
  const repoIdRaw = readStr(raw, 'repoId', label);
  if (!isBenchmarkRepoId(repoIdRaw)) {
    throw new BenchmarkError(
      `${label}.repoId "${repoIdRaw}" is not a supported frozen repository.`,
    );
  }
  const commitSha = readStr(raw, 'commitSha', label);
  if (!HEX_40_RE.test(commitSha)) {
    throw new BenchmarkError(`${label}.commitSha must be a 40-char lowercase hex SHA.`);
  }
  const manifestSha256 = readStr(raw, 'manifestSha256', label);
  if (!HEX_64_RE.test(manifestSha256)) {
    throw new BenchmarkError(`${label}.manifestSha256 must be a 64-char lowercase hex SHA-256.`);
  }

  return {
    schemaVersion: 1,
    repoId: repoIdRaw,
    repository: readStr(raw, 'repository', label),
    commitSha,
    manifestRelativePath: readStr(raw, 'manifestRelativePath', label),
    manifestSha256,
    canonicalRoot: readStr(raw, 'canonicalRoot', label),
    supportedFiles: readStringList(raw, 'supportedFiles', label),
    configFiles: readStringList(raw, 'configFiles', label),
    totalSupportedBytes: readNonNegInt(raw, 'totalSupportedBytes', label),
    totalConfigBytes: readNonNegInt(raw, 'totalConfigBytes', label),
    bundledTypeScriptVersion: readStr(raw, 'bundledTypeScriptVersion', label),
    preparedAtUtc: readStr(raw, 'preparedAtUtc', label),
  };
}

function validateNumericSummary(raw: unknown, ctx: string): NumericSummary {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${ctx} must be an object.`);
  }
  const min = readNullableNonNegFinite(raw, 'min', ctx);
  const median = readNullableNonNegFinite(raw, 'median', ctx);
  const max = readNullableNonNegFinite(raw, 'max', ctx);

  const allNull = min === null && median === null && max === null;
  const allPresent = min !== null && median !== null && max !== null;
  if (!allNull && !allPresent) {
    throw new BenchmarkError(`${ctx} must have either all-null or all-numeric min/median/max.`);
  }
  if (allPresent && (min > median || median > max)) {
    throw new BenchmarkError(
      `${ctx} violates ordering min (${String(min)}) <= median (${String(median)}) <= max (${String(max)}).`,
    );
  }
  return { min, median, max };
}

export function validateWindowsMonitorSummary(raw: unknown, label: string): WindowsMonitorSummary {
  if (!isPlainObject(raw)) {
    throw new BenchmarkError(`${label} must be a JSON object.`);
  }
  if (raw.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new BenchmarkError(`${label}.schemaVersion must be 1.`);
  }
  const status = raw.monitorStatus;
  if (
    status !== 'completed' &&
    status !== 'parent_nonzero_exit' &&
    status !== 'supervisor_timeout' &&
    status !== 'monitor_error'
  ) {
    throw new BenchmarkError(`${label}.monitorStatus is invalid.`);
  }
  if (raw.phaseAttributionMethod !== 'approximate-monitor-stdout-event-receipt') {
    throw new BenchmarkError(
      `${label}.phaseAttributionMethod must be "approximate-monitor-stdout-event-receipt".`,
    );
  }
  if (!isPlainObject(raw.auditArtifacts)) {
    throw new BenchmarkError(`${label}.auditArtifacts must be an object.`);
  }
  const lifecycleEventsFile = readStr(
    raw.auditArtifacts,
    'lifecycleEventsFile',
    `${label}.auditArtifacts`,
  );
  const samplesFile = readStr(raw.auditArtifacts, 'samplesFile', `${label}.auditArtifacts`);
  if (!isSafeArtifactBasename(lifecycleEventsFile) || !isSafeArtifactBasename(samplesFile)) {
    throw new BenchmarkError(`${label}.auditArtifacts filenames must be safe basenames.`);
  }

  if (!isPlainObject(raw.parentIdentity)) {
    throw new BenchmarkError(`${label}.parentIdentity must be an object.`);
  }
  const parentIdentity = {
    pid: readNonNegInt(raw.parentIdentity, 'pid', `${label}.parentIdentity`),
    startTimeUtc: readNullableStr(raw.parentIdentity, 'startTimeUtc', `${label}.parentIdentity`),
    exitCode: readNullableInt(raw.parentIdentity, 'exitCode', `${label}.parentIdentity`),
  };

  if (!Array.isArray(raw.childIdentities)) {
    throw new BenchmarkError(`${label}.childIdentities must be an array.`);
  }
  const childIdentities: ObservedChildIdentity[] = [];
  for (let i = 0; i < raw.childIdentities.length; i += 1) {
    const item: unknown = raw.childIdentities[i];
    const ctx = `${label}.childIdentities[${String(i)}]`;
    if (!isPlainObject(item)) {
      throw new BenchmarkError(`${ctx} must be an object.`);
    }
    const obsStatus = item.observationStatus;
    if (
      obsStatus !== 'confirmed_closed' &&
      obsStatus !== 'observed_exited' &&
      obsStatus !== 'handle_unavailable' &&
      obsStatus !== 'still_running'
    ) {
      throw new BenchmarkError(`${ctx}.observationStatus is invalid.`);
    }
    const firstOff = readNullableNonNegFinite(item, 'firstSampleOffsetMs', ctx);
    const lastOff = readNullableNonNegFinite(item, 'lastSampleOffsetMs', ctx);
    if (firstOff !== null && lastOff !== null && firstOff > lastOff) {
      throw new BenchmarkError(`${ctx} firstSampleOffsetMs cannot exceed lastSampleOffsetMs.`);
    }
    childIdentities.push({
      iterationIndex: readNonNegInt(item, 'iterationIndex', ctx),
      pid: readNonNegInt(item, 'pid', ctx),
      startTimeUtc: readNullableStr(item, 'startTimeUtc', ctx),
      spawnEventEmittedAtUtc: readNullableStr(item, 'spawnEventEmittedAtUtc', ctx),
      spawnEventReceivedAtUtc: readNullableStr(item, 'spawnEventReceivedAtUtc', ctx),
      spawnEventReceivedOffsetMs: readNullableNonNegFinite(item, 'spawnEventReceivedOffsetMs', ctx),
      pidBindingDurationMs: readNullableNonNegFinite(item, 'pidBindingDurationMs', ctx),
      eventDeliveryLatencyMs: readNullableNonNegFinite(item, 'eventDeliveryLatencyMs', ctx),
      firstValidSampleAtUtc: readNullableStr(item, 'firstValidSampleAtUtc', ctx),
      firstSampleOffsetMs: firstOff,
      lastSampleOffsetMs: lastOff,
      creationToFirstSampleMs: readNullableNonNegFinite(item, 'creationToFirstSampleMs', ctx),
      pairedSampleCount: readNonNegInt(item, 'pairedSampleCount', ctx),
      observationStatus: obsStatus,
    });
  }

  if (!isPlainObject(raw.sampling)) {
    throw new BenchmarkError(`${label}.sampling must be an object.`);
  }
  const sCtx = `${label}.sampling`;
  const totalSamples = readNonNegInt(raw.sampling, 'totalSamples', sCtx);
  const startupWindowSamples = readNonNegInt(raw.sampling, 'startupWindowSamples', sCtx);
  const parserWindowSamples = readNonNegInt(raw.sampling, 'parserWindowSamples', sCtx);
  const artifactPersistenceWindowSamples = readNonNegInt(
    raw.sampling,
    'artifactPersistenceWindowSamples',
    sCtx,
  );
  const finalRecordWriteWindowSamples = readNonNegInt(
    raw.sampling,
    'finalRecordWriteWindowSamples',
    sCtx,
  );
  const validChildSamples = readNonNegInt(raw.sampling, 'validChildSamples', sCtx);
  const pairedParserWindowSamples = readNonNegInt(raw.sampling, 'pairedParserWindowSamples', sCtx);

  if (
    startupWindowSamples +
      parserWindowSamples +
      artifactPersistenceWindowSamples +
      finalRecordWriteWindowSamples !==
    totalSamples
  ) {
    throw new BenchmarkError(
      `${sCtx} window sample counts do not sum to totalSamples (${String(totalSamples)}).`,
    );
  }
  if (pairedParserWindowSamples > parserWindowSamples) {
    throw new BenchmarkError(
      `${sCtx}.pairedParserWindowSamples (${String(pairedParserWindowSamples)}) exceeds parserWindowSamples (${String(parserWindowSamples)}).`,
    );
  }
  if (pairedParserWindowSamples > validChildSamples) {
    throw new BenchmarkError(
      `${sCtx}.pairedParserWindowSamples (${String(pairedParserWindowSamples)}) exceeds validChildSamples (${String(validChildSamples)}).`,
    );
  }

  const sampling = {
    requestedIntervalMs: readNonNegFinite(raw.sampling, 'requestedIntervalMs', sCtx),
    windowStartUtc: readStr(raw.sampling, 'windowStartUtc', sCtx),
    windowEndUtc: readStr(raw.sampling, 'windowEndUtc', sCtx),
    totalSamples,
    startupWindowSamples,
    parserWindowSamples,
    artifactPersistenceWindowSamples,
    finalRecordWriteWindowSamples,
    validChildSamples,
    pairedParserWindowSamples,
    observedGapCount: readNonNegInt(raw.sampling, 'observedGapCount', sCtx),
    missingCounterCount: readNonNegInt(raw.sampling, 'missingCounterCount', sCtx),
    counterReadFailureCount: readNonNegInt(raw.sampling, 'counterReadFailureCount', sCtx),
    actualIntervalMs: validateNumericSummary(
      raw.sampling.actualIntervalMs,
      `${sCtx}.actualIntervalMs`,
    ),
    tickDurationMs: validateNumericSummary(raw.sampling.tickDurationMs, `${sCtx}.tickDurationMs`),
    maxParentChildSkewMs: readNullableNonNegFinite(raw.sampling, 'maxParentChildSkewMs', sCtx),
  };

  if (!isPlainObject(raw.parserExecutionWindowMemory)) {
    throw new BenchmarkError(`${label}.parserExecutionWindowMemory must be an object.`);
  }
  const pCtx = `${label}.parserExecutionWindowMemory`;
  const parserExecutionWindowMemory = {
    parentSampledWorkingSetPeakBytes: readNullableNonNegInt(
      raw.parserExecutionWindowMemory,
      'parentSampledWorkingSetPeakBytes',
      pCtx,
    ),
    parentSampledPrivateMemoryPeakBytes: readNullableNonNegInt(
      raw.parserExecutionWindowMemory,
      'parentSampledPrivateMemoryPeakBytes',
      pCtx,
    ),
    childSampledWorkingSetPeakBytes: readNullableNonNegInt(
      raw.parserExecutionWindowMemory,
      'childSampledWorkingSetPeakBytes',
      pCtx,
    ),
    childOsReportedPeakWorkingSetBytes: readNullableNonNegInt(
      raw.parserExecutionWindowMemory,
      'childOsReportedPeakWorkingSetBytes',
      pCtx,
    ),
    childSampledPrivateMemoryPeakBytes: readNullableNonNegInt(
      raw.parserExecutionWindowMemory,
      'childSampledPrivateMemoryPeakBytes',
      pCtx,
    ),
    maxSameIterationCombinedWorkingSetBytes: readNullableNonNegInt(
      raw.parserExecutionWindowMemory,
      'maxSameIterationCombinedWorkingSetBytes',
      pCtx,
    ),
    maxSameIterationCombinedPrivateMemoryBytes: readNullableNonNegInt(
      raw.parserExecutionWindowMemory,
      'maxSameIterationCombinedPrivateMemoryBytes',
      pCtx,
    ),
  };

  if (!isPlainObject(raw.fullParentLifetimeMemory)) {
    throw new BenchmarkError(`${label}.fullParentLifetimeMemory must be an object.`);
  }
  const fCtx = `${label}.fullParentLifetimeMemory`;
  const fullParentLifetimeMemory = {
    parentSampledWorkingSetPeakBytes: readNullableNonNegInt(
      raw.fullParentLifetimeMemory,
      'parentSampledWorkingSetPeakBytes',
      fCtx,
    ),
    parentOsReportedPeakWorkingSetBytes: readNullableNonNegInt(
      raw.fullParentLifetimeMemory,
      'parentOsReportedPeakWorkingSetBytes',
      fCtx,
    ),
    parentSampledPrivateMemoryPeakBytes: readNullableNonNegInt(
      raw.fullParentLifetimeMemory,
      'parentSampledPrivateMemoryPeakBytes',
      fCtx,
    ),
  };

  if (!Array.isArray(raw.quarantinedOwnedProcesses)) {
    throw new BenchmarkError(`${label}.quarantinedOwnedProcesses must be an array.`);
  }
  const quarantinedOwnedProcesses: QuarantinedOwnedProcess[] = [];
  for (let i = 0; i < raw.quarantinedOwnedProcesses.length; i += 1) {
    const item: unknown = raw.quarantinedOwnedProcesses[i];
    const qCtx = `${label}.quarantinedOwnedProcesses[${String(i)}]`;
    if (!isPlainObject(item)) {
      throw new BenchmarkError(`${qCtx} must be an object.`);
    }
    const role = item.role;
    if (role !== 'parent' && role !== 'child') {
      throw new BenchmarkError(`${qCtx}.role must be "parent" or "child".`);
    }
    quarantinedOwnedProcesses.push({
      role,
      pid: readNonNegInt(item, 'pid', qCtx),
      startTimeUtc: readNullableStr(item, 'startTimeUtc', qCtx),
    });
  }

  return {
    schemaVersion: 1,
    monitorStatus: status,
    platform: readStr(raw, 'platform', label),
    phaseAttributionMethod: 'approximate-monitor-stdout-event-receipt',
    counterSemantics: readStr(raw, 'counterSemantics', label),
    clockDomainNotes: readStr(raw, 'clockDomainNotes', label),
    auditArtifacts: {
      lifecycleEventsFile,
      samplesFile,
    },
    parentIdentity,
    childIdentities,
    sampling,
    parserExecutionWindowMemory,
    fullParentLifetimeMemory,
    failureDetails: readNullableStr(raw, 'failureDetails', label),
    quarantinedOwnedProcesses,
  };
}

export function validateBenchmarkAnalysisStats(raw: unknown, ctx: string): AnalysisStats {
  const parsed = analysisStatsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BenchmarkError(
      `${ctx} failed AnalysisStats validation: ${parsed.error.issues[0]?.message ?? 'invalid stats'}`,
    );
  }
  return parsed.data;
}

export function summarizeNumbers(values: readonly number[]): NumericSummary {
  if (values.length === 0) {
    return { min: null, median: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const first = sorted[0] ?? null;
  const last = sorted[sorted.length - 1] ?? null;
  const mid = Math.floor(sorted.length / 2);
  let median: number | null;
  if (sorted.length % 2 === 1) {
    median = sorted[mid] ?? null;
  } else {
    const lo = sorted[mid - 1];
    const hi = sorted[mid];
    median = lo !== undefined && hi !== undefined ? Number(((lo + hi) / 2).toFixed(2)) : null;
  }
  return {
    min: first !== null ? Number(first.toFixed(2)) : null,
    median,
    max: last !== null ? Number(last.toFixed(2)) : null,
  };
}

export function formatMiB(bytes: number | null): string {
  if (bytes === null) {
    return 'N/A';
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatKiBAsMiB(kib: number | null): string {
  if (kib === null) {
    return 'N/A';
  }
  return `${(kib / 1024).toFixed(2)} MiB`;
}
