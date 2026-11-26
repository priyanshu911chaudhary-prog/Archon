import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AnalysisOutput } from '@archon/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { runMeasuredBenchmarkParent } from './benchmark-parser-parent.js';
import {
  aggregateBenchmarkRuns,
  formatBenchmarkMarkdown,
  runScoreCli,
  scorePersistedBenchmarkRun,
  scoreRunDirectory,
  validateScoredBenchmarkRunRecord,
} from './benchmark-parser-score.js';
import {
  BENCHMARK_SCHEMA_VERSION,
  BenchmarkError,
  WINDOWS_CLOCK_DOMAIN_NOTES,
  WINDOWS_COUNTER_SEMANTICS,
  validateParentBenchmarkRunRecord,
  validatePreparedSnapshotInventory,
  validateWindowsMonitorSummary,
  writeFileExclusiveJson,
  type ParentBenchmarkRunRecord,
  type PreparedSnapshotInventory,
  type ScoredBenchmarkRunRecord,
  type WindowsMonitorSummary,
} from './benchmark-parser-types.js';
import {
  FROZEN_EVAL_REPOS,
  computeGraphOutputDigest,
  verifyAndLoadFrozenManifest,
  type FrozenRepoId,
  type GroundTruthManifest,
} from './eval-policy.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPILED_PARENT_PATH = path.join(REPO_ROOT, 'scripts', 'dist', 'benchmark-parser-parent.js');
const COMPILED_SCORE_PATH = path.join(REPO_ROOT, 'scripts', 'dist', 'benchmark-parser-score.js');
const VALID_SHA256 = 'a'.repeat(64);
const REAL_CHILD_TIMEOUT_MS = 25_000;

interface ImportProbeResult {
  readonly loadedUrls: readonly string[];
  readonly resolvedSpecifiers: readonly string[];
  readonly exportedKeys: readonly string[];
}

function runFreshImportProbe(entryFilePath: string, invokeRunnerLoader = false): ImportProbeResult {
  if (!existsSync(entryFilePath)) {
    throw new Error(
      `Missing compiled artifact "${entryFilePath}". Run "npm run build" before running import-isolation tests.`,
    );
  }

  const probeCode = [
    "import { registerHooks } from 'node:module';",
    'const loadedUrls = new Set();',
    'const resolvedSpecifiers = new Set();',
    'registerHooks({',
    '  resolve(specifier, context, nextResolve) {',
    '    resolvedSpecifiers.add(specifier);',
    '    const res = nextResolve(specifier, context);',
    '    if (res && typeof res.url === "string") loadedUrls.add(res.url);',
    '    return res;',
    '  },',
    '  load(url, context, nextLoad) {',
    '    loadedUrls.add(url);',
    '    return nextLoad(url, context);',
    '  },',
    '});',
    'const mod = await import(process.argv[1]);',
    ...(invokeRunnerLoader ? ['await mod.loadCompiledParserRunnerModule();'] : []),
    'process.stdout.write(JSON.stringify({',
    '  loadedUrls: [...loadedUrls],',
    '  resolvedSpecifiers: [...resolvedSpecifiers],',
    '  exportedKeys: Object.keys(mod),',
    '}));',
  ].join('\n');

  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', probeCode, pathToFileURL(entryFilePath).href],
    {
      cwd: REPO_ROOT,
      env: {
        NODE_ENV: 'test',
        ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
        ...(process.env.Path !== undefined ? { Path: process.env.Path } : {}),
        ...(process.env.SYSTEMROOT !== undefined ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...(process.env.SystemRoot !== undefined ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      encoding: 'utf8',
    },
  );

  return JSON.parse(stdout) as ImportProbeResult;
}

function makeParentRecord(
  repoId: FrozenRepoId,
  overrides: Partial<ParentBenchmarkRunRecord> = {},
  seed = 1,
): ParentBenchmarkRunRecord {
  const spec = FROZEN_EVAL_REPOS[repoId];
  const reqSuffix = String(seed).padStart(12, '0');
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runStatus: 'success',
    parentTopology: 'lightweight-parser-only-parent',
    parentRunnerMode: 'instrumented-spawn-pid-hook',
    instrumentationOverheadNotes: 'test record',
    repoId,
    repository: spec.repository,
    commitSha: spec.commitSha,
    manifestRelativePath: spec.manifestRelativePath,
    manifestSha256: spec.manifestSha256,
    environment: {
      nodeVersion: 'v24.14.0',
      platform: 'win32',
      osRelease: '10.0.26200',
      arch: 'x64',
      bundledTypeScriptVersion: '6.0.2',
    },
    parentProcess: {
      pid: 10_000 + seed,
      startedAtUtc: `2026-01-01T00:00:${String(seed).padStart(2, '0')}.000Z`,
    },
    runnerConfig: {
      parserTimeoutMs: 60_000,
      maxOldSpaceSizeMb: 256,
      maxResponseBytes: 32 * 1024 * 1024,
      terminateGraceMs: 2_000,
      killConfirmationMs: 3_000,
      skipLoadingLibFiles: false,
      maxSupportedFiles: 500,
      maxConfigFiles: 50,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileSnippetChars: 8192,
      maxSymbolSnippetChars: 4096,
      maxCallSiteSnippetChars: 512,
      maxWarnings: 200,
      maxExtendsDepth: 10,
    },
    snapshotInventory: {
      supportedFilesCount: spec.inventoriedSourceCount,
      configFilesCount: spec.inventoriedConfigCount,
      totalSupportedBytes: 100_000,
      totalConfigBytes: 1_000,
    },
    parentStartup: {
      importsLoadedDurationMs: 12.5,
      heapUsedBytes: 10_000_000,
      rssBytes: 40_000_000,
    },
    iterations: [
      {
        iterationIndex: 1,
        status: 'success',
        requestId: `11111111-2222-4333-8444-${reqSuffix}`,
        childPid: 20_000 + seed,
        finalRunnerState: 'IDLE',
        isFatal: false,
        hasActiveChild: false,
        metrics: {
          endToEndDurationMs: 1_200,
          childAnalysisDurationMs: 1_100,
          childPreSendMemory: {
            baselineHeapUsedBytes: 15_000_000,
            postHeapUsedBytes: 90_000_000,
            baselineRssBytes: 50_000_000,
            postRssBytes: 220_000_000,
            maxRssKiB: 230_000,
          },
          serializedResponseBytes: 150_000,
          parentValidationDurationMs: 4.5,
          parentMemory: {
            baselineHeapUsedBytes: 12_000_000,
            postHeapUsedBytes: 18_000_000,
            baselineRssBytes: 42_000_000,
            postRssBytes: 52_000_000,
          },
          exitCode: 0,
          signal: null,
        },
        graphArtifactFileName: 'graph-output-iter1.json',
        artifactPersistence: {
          durationMs: 3.1,
          graphFileBytes: 150_000,
          postPersistParentHeapUsedBytes: 19_000_000,
          postPersistParentRssBytes: 53_000_000,
        },
        error: null,
        fatalEvent: null,
      },
    ],
    parentMemoryBeforeFinalRecordWrite: {
      heapUsedBytes: 19_000_000,
      rssBytes: 53_000_000,
      preFinalRecordWriteMaxRssKiB: 54_000,
    },
    ...overrides,
  };
}

function makeMonitorSummary(
  overrides: Partial<WindowsMonitorSummary> = {},
  seed = 1,
): WindowsMonitorSummary {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    monitorStatus: 'completed',
    platform: 'win32',
    phaseAttributionMethod: 'approximate-monitor-stdout-event-receipt',
    counterSemantics: WINDOWS_COUNTER_SEMANTICS,
    clockDomainNotes: WINDOWS_CLOCK_DOMAIN_NOTES,
    auditArtifacts: {
      lifecycleEventsFile: 'windows-lifecycle-events.json',
      samplesFile: 'windows-samples.ndjson',
    },
    parentIdentity: {
      pid: 10_000 + seed,
      startTimeUtc: '2026-01-01T00:00:00.000Z',
      exitCode: 0,
    },
    childIdentities: [
      {
        iterationIndex: 1,
        pid: 20_000 + seed,
        startTimeUtc: '2026-01-01T00:00:00.050Z',
        spawnEventEmittedAtUtc: '2026-01-01T00:00:00.055Z',
        spawnEventReceivedAtUtc: '2026-01-01T00:00:00.060Z',
        spawnEventReceivedOffsetMs: 60.0,
        pidBindingDurationMs: 1.2,
        eventDeliveryLatencyMs: 5.0,
        firstValidSampleAtUtc: '2026-01-01T00:00:00.085Z',
        firstSampleOffsetMs: 85.0,
        lastSampleOffsetMs: 1_180.0,
        creationToFirstSampleMs: 35.0,
        pairedSampleCount: 44,
        observationStatus: 'confirmed_closed',
      },
    ],
    sampling: {
      requestedIntervalMs: 25,
      windowStartUtc: '2026-01-01T00:00:00.000Z',
      windowEndUtc: '2026-01-01T00:00:01.300Z',
      totalSamples: 50,
      startupWindowSamples: 2,
      parserWindowSamples: 45,
      artifactPersistenceWindowSamples: 2,
      finalRecordWriteWindowSamples: 1,
      validChildSamples: 44,
      pairedParserWindowSamples: 44,
      observedGapCount: 0,
      missingCounterCount: 0,
      counterReadFailureCount: 0,
      actualIntervalMs: { min: 24.5, median: 25.1, max: 31.0 },
      tickDurationMs: { min: 0.4, median: 0.9, max: 3.2 },
      maxParentChildSkewMs: 0.8,
    },
    parserExecutionWindowMemory: {
      parentSampledWorkingSetPeakBytes: 55_000_000,
      parentSampledPrivateMemoryPeakBytes: 30_000_000,
      childSampledWorkingSetPeakBytes: 225_000_000,
      childOsReportedPeakWorkingSetBytes: 235_000_000,
      childSampledPrivateMemoryPeakBytes: 195_000_000,
      maxSameIterationCombinedWorkingSetBytes: 270_000_000,
      maxSameIterationCombinedPrivateMemoryBytes: 215_000_000,
    },
    fullParentLifetimeMemory: {
      parentSampledWorkingSetPeakBytes: 58_000_000,
      parentOsReportedPeakWorkingSetBytes: 60_000_000,
      parentSampledPrivateMemoryPeakBytes: 32_000_000,
    },
    failureDetails: null,
    quarantinedOwnedProcesses: [],
    ...overrides,
  };
}

function buildMinimalMatchingOutput(manifest: GroundTruthManifest): AnalysisOutput {
  const filePaths = new Set<string>(manifest.selectedSourceFiles);
  for (const ref of manifest.referencedTargetAndConfigProvenance) {
    if (ref.role !== 'config') {
      filePaths.add(ref.path);
    }
  }
  const nodes: {
    readonly nodeType: 'file' | 'function' | 'symbol';
    readonly name: string;
    readonly qualifiedName: string;
    readonly filePath: string;
    readonly parentQualifiedName: string | null;
    readonly isExported: boolean;
    readonly startLine: number;
    readonly endLine: number;
    readonly contentHash: string;
    readonly snippet: string;
  }[] = [];

  const seenQns = new Set<string>();
  for (const fp of [...filePaths].sort()) {
    const qn = `file:${fp}`;
    seenQns.add(qn);
    nodes.push({
      nodeType: 'file',
      name: path.posix.basename(fp),
      qualifiedName: qn,
      filePath: fp,
      parentQualifiedName: null,
      isExported: false,
      startLine: 1,
      endLine: 10,
      contentHash: VALID_SHA256,
      snippet: '',
    });
  }

  const ensureEndpoint = (qn: string): void => {
    if (seenQns.has(qn)) {
      return;
    }
    seenQns.add(qn);
    const sep = qn.indexOf('::');
    const fp = qn.slice(0, sep);
    const isSym = qn.includes('::sym:');
    nodes.push({
      nodeType: isSym ? 'symbol' : 'function',
      name: qn.split(':').at(-1) ?? 'fn',
      qualifiedName: qn,
      filePath: fp,
      parentQualifiedName: `file:${fp}`,
      isExported: true,
      startLine: 1,
      endLine: 10,
      contentHash: VALID_SHA256,
      snippet: '',
    });
  };

  for (const c of manifest.expectedCalls) {
    ensureEndpoint(c.sourceQualifiedName);
    ensureEndpoint(c.targetQualifiedName);
  }

  const edges = [
    ...manifest.expectedImports.map((e) => ({
      sourceQualifiedName: e.sourceQualifiedName,
      targetQualifiedName: e.targetQualifiedName,
      edgeType: 'IMPORTS' as const,
      callSiteLine: null,
      callSiteSnippet: null,
    })),
    ...manifest.expectedCalls.map((e) => ({
      sourceQualifiedName: e.sourceQualifiedName,
      targetQualifiedName: e.targetQualifiedName,
      edgeType: 'CALLS' as const,
      callSiteLine: e.callSiteLine,
      callSiteSnippet: 'call()',
    })),
  ];

  const fileNodeCount = nodes.filter((n) => n.nodeType === 'file').length;
  const functionNodeCount = nodes.filter((n) => n.nodeType === 'function').length;
  const symbolNodeCount = nodes.filter((n) => n.nodeType === 'symbol').length;

  return {
    nodes,
    edges,
    warnings: [],
    stats: {
      discoveredFilesCount: fileNodeCount,
      parsedFilesCount: fileNodeCount,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 0,
      folderNodeCount: 0,
      fileNodeCount,
      functionNodeCount,
      classNodeCount: 0,
      symbolNodeCount,
      importsEdgeCount: manifest.expectedImports.length,
      callsEdgeCount: manifest.expectedCalls.length,
      totalBytesRead: 100,
      truncatedWarningsCount: 0,
    },
  };
}

describe('Parser subprocess benchmark harness (Batch 4.3C.1 final acceptance)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function loadFrozenManifest(repoId: FrozenRepoId): Promise<GroundTruthManifest> {
    const spec = FROZEN_EVAL_REPOS[repoId];
    const manifestPath = path.resolve(REPO_ROOT, ...spec.manifestRelativePath.split('/'));
    const { manifest } = await verifyAndLoadFrozenManifest(manifestPath, spec.manifestSha256, spec);
    return manifest;
  }

  it('strictly validates PreparedSnapshotInventory, ParentBenchmarkRunRecord, and WindowsMonitorSummary including ordering, sample sums, traversal basenames, and exclusive writes', async () => {
    const spec = FROZEN_EVAL_REPOS.zustand;
    const validInv: PreparedSnapshotInventory = {
      schemaVersion: 1,
      repoId: 'zustand',
      repository: spec.repository,
      commitSha: spec.commitSha,
      manifestRelativePath: spec.manifestRelativePath,
      manifestSha256: spec.manifestSha256,
      canonicalRoot: path.resolve('tmp-zustand'),
      supportedFiles: ['src/index.ts'],
      configFiles: ['tsconfig.json'],
      totalSupportedBytes: 100,
      totalConfigBytes: 50,
      bundledTypeScriptVersion: '6.0.2',
      preparedAtUtc: '2026-01-01T00:00:00.000Z',
    };
    expect(validatePreparedSnapshotInventory(validInv, 'valid').repoId).toBe('zustand');
    expect(() =>
      validatePreparedSnapshotInventory({ ...validInv, commitSha: 'bad-sha' }, 'bad-sha'),
    ).toThrow(BenchmarkError);

    // Parent record full validation: status-dependent nullability & traversal graph filename rejected
    const validParent = makeParentRecord('zustand');
    expect(validateParentBenchmarkRunRecord(validParent, 'valid-parent').repoId).toBe('zustand');
    expect(() =>
      validateParentBenchmarkRunRecord(
        {
          ...validParent,
          iterations: [{ ...validParent.iterations[0], graphArtifactFileName: '../escape.json' }],
        },
        'traversal-graph',
      ),
    ).toThrow(BenchmarkError);
    expect(() =>
      validateParentBenchmarkRunRecord(
        {
          ...validParent,
          iterations: [{ ...validParent.iterations[0], metrics: null }],
        },
        'success-null-metrics',
      ),
    ).toThrow(BenchmarkError);

    // Monitor validation: summary ordering min <= median <= max & window sum check
    const validMonitor = makeMonitorSummary();
    expect(validateWindowsMonitorSummary(validMonitor, 'valid-mon').monitorStatus).toBe(
      'completed',
    );
    expect(() =>
      validateWindowsMonitorSummary(
        {
          ...validMonitor,
          sampling: {
            ...validMonitor.sampling,
            actualIntervalMs: { min: 40, median: 25, max: 30 },
          },
        },
        'bad-order',
      ),
    ).toThrow(/violates ordering/);
    expect(() =>
      validateWindowsMonitorSummary(
        {
          ...validMonitor,
          sampling: { ...validMonitor.sampling, totalSamples: 99 },
        },
        'bad-sum',
      ),
    ).toThrow(/do not sum to totalSamples/);

    // Exclusive write rejects overwrite with EEXIST
    const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-bench-excl-'));
    tempDirs.push(dir);
    const outFile = path.join(dir, 'artifact.json');
    await writeFileExclusiveJson(outFile, { ok: true });
    await expect(writeFileExclusiveJson(outFile, { ok: false })).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('separates executionStatus from benchmarkAccepted: rejects with-lib digest mismatch for acceptance while accepting skipLoadingLibFiles=true runs without digest parity', async () => {
    const manifest = await loadFrozenManifest('zustand');
    const output = buildMinimalMatchingOutput(manifest);

    // 1. With-lib run whose synthetic graph has a non-reference digest: execution succeeds, accuracyAccepted=false, benchmarkAccepted=false
    const withLibScored = scorePersistedBenchmarkRun({
      runId: 'zustand-withlib-mismatch',
      manifest,
      parentRecord: makeParentRecord('zustand'),
      persistedGraphOutput: output,
      windowsMonitor: makeMonitorSummary(),
    });
    expect(withLibScored.executionStatus).toBe('success');
    expect(withLibScored.graphDigest).toBe(computeGraphOutputDigest(output));
    expect(withLibScored.matchesWithLibReferenceDigest).toBe(false);
    expect(withLibScored.accuracyAccepted).toBe(false);
    expect(withLibScored.memoryAccepted).toBe(true);
    expect(withLibScored.benchmarkAccepted).toBe(false);
    expect(withLibScored.acceptanceReasons[0]).toContain(
      'does not match expected reference digest',
    );
    expect(withLibScored.score?.imports.tp).toBe(14);
    expect(withLibScored.score?.primaryCalls.tp).toBe(31);
    expect(validateScoredBenchmarkRunRecord(withLibScored, 'withlib').benchmarkAccepted).toBe(
      false,
    );

    // 2. Without-lib run: digest difference vs with-lib reference is NOT an execution failure or accuracy rejection
    const withoutLibParent = makeParentRecord('zustand', {
      runnerConfig: { ...makeParentRecord('zustand').runnerConfig, skipLoadingLibFiles: true },
    });
    const withoutLibScored = scorePersistedBenchmarkRun({
      runId: 'zustand-nolib-ok',
      manifest,
      parentRecord: withoutLibParent,
      persistedGraphOutput: output,
      windowsMonitor: makeMonitorSummary(),
    });
    expect(withoutLibScored.executionStatus).toBe('success');
    expect(withoutLibScored.matchesWithLibReferenceDigest).toBe(false);
    expect(withoutLibScored.accuracyAccepted).toBe(true);
    expect(withoutLibScored.memoryAccepted).toBe(true);
    expect(withoutLibScored.benchmarkAccepted).toBe(true);
    expect(withoutLibScored.acceptanceReasons).toEqual([]);
    expect(validateScoredBenchmarkRunRecord(withoutLibScored, 'nolib').benchmarkAccepted).toBe(
      true,
    );
  });

  it('enforces preliminary memory-coverage acceptance (handle_unavailable, zero paired samples, PID mismatch) while preserving raw execution and accuracy evidence', async () => {
    const manifest = await loadFrozenManifest('zustand');
    const output = buildMinimalMatchingOutput(manifest);
    const noLibParent = makeParentRecord('zustand', {
      runnerConfig: { ...makeParentRecord('zustand').runnerConfig, skipLoadingLibFiles: true },
    });

    // 1. Child handle unavailable + 0 paired samples -> memoryAccepted=false, accuracyAccepted=true, score preserved
    const baseMon = makeMonitorSummary();
    const firstChild = baseMon.childIdentities[0];
    if (firstChild === undefined) {
      throw new Error('Expected child identity fixture.');
    }
    const unavailableMon = makeMonitorSummary({
      childIdentities: [
        { ...firstChild, observationStatus: 'handle_unavailable', pairedSampleCount: 0 },
      ],
      sampling: { ...baseMon.sampling, validChildSamples: 0, pairedParserWindowSamples: 0 },
      parserExecutionWindowMemory: {
        ...baseMon.parserExecutionWindowMemory,
        childSampledWorkingSetPeakBytes: null,
        maxSameIterationCombinedWorkingSetBytes: null,
      },
    });
    const scoredLowCov = scorePersistedBenchmarkRun({
      runId: 'zustand-low-cov',
      manifest,
      parentRecord: noLibParent,
      persistedGraphOutput: output,
      windowsMonitor: unavailableMon,
    });
    expect(scoredLowCov.executionStatus).toBe('success');
    expect(scoredLowCov.accuracyAccepted).toBe(true);
    expect(scoredLowCov.memoryAccepted).toBe(false);
    expect(scoredLowCov.benchmarkAccepted).toBe(false);
    expect(scoredLowCov.score?.primaryCalls.tp).toBe(31);
    expect(scoredLowCov.acceptanceReasons.some((r) => r.includes('handle_unavailable'))).toBe(true);
    expect(scoredLowCov.acceptanceReasons.some((r) => r.includes('paired parent+child'))).toBe(
      true,
    );

    // 2. Parent PID mismatch between parentRecord and monitor -> memoryAccepted=false
    const mismatchedPidMon = makeMonitorSummary({
      parentIdentity: { ...baseMon.parentIdentity, pid: 99_999 },
    });
    const scoredPidMismatch = scorePersistedBenchmarkRun({
      runId: 'zustand-pid-mismatch',
      manifest,
      parentRecord: noLibParent,
      persistedGraphOutput: output,
      windowsMonitor: mismatchedPidMon,
    });
    expect(scoredPidMismatch.memoryAccepted).toBe(false);
    expect(scoredPidMismatch.benchmarkAccepted).toBe(false);
    expect(scoredPidMismatch.acceptanceReasons.some((r) => r.includes('Monitor parent PID'))).toBe(
      true,
    );
  });

  it('preserves failed parent runs, fatal runs, monitor timeouts, and missing artifacts without fabricating zero-edge scores', async () => {
    const manifest = await loadFrozenManifest('zustand');

    const timeoutParent = makeParentRecord('zustand', {
      runStatus: 'error',
      iterations: [
        {
          iterationIndex: 1,
          status: 'error',
          requestId: '11111111-2222-4333-8444-555555555555',
          childPid: 20_002,
          finalRunnerState: 'IDLE',
          isFatal: false,
          hasActiveChild: false,
          metrics: null,
          graphArtifactFileName: null,
          artifactPersistence: null,
          error: {
            code: 'PARSER_TIMEOUT',
            message: 'Parser child process exceeded its execution timeout.',
            retryable: false,
            fatal: false,
            startupFailure: false,
            exitCode: null,
            signal: 'SIGTERM',
          },
          fatalEvent: null,
        },
      ],
    });
    const scoredTimeout = scorePersistedBenchmarkRun({
      runId: 'zustand-timeout',
      manifest,
      parentRecord: timeoutParent,
      persistedGraphOutput: null,
      windowsMonitor: makeMonitorSummary({ monitorStatus: 'parent_nonzero_exit' }),
    });
    expect(scoredTimeout.executionStatus).toBe('failed');
    expect(scoredTimeout.benchmarkAccepted).toBe(false);
    expect(scoredTimeout.score).toBeNull();
    expect(scoredTimeout.graphDigest).toBeNull();
    expect(scoredTimeout.failureReason).toContain('PARSER_TIMEOUT');

    // Monitor supervisor timeout keeps executionStatus='success' if graph valid, but memoryAccepted=false & benchmarkAccepted=false
    const scoredMonTimeout = scorePersistedBenchmarkRun({
      runId: 'zustand-mon-timeout',
      manifest,
      parentRecord: makeParentRecord('zustand', {
        runnerConfig: { ...makeParentRecord('zustand').runnerConfig, skipLoadingLibFiles: true },
      }),
      persistedGraphOutput: buildMinimalMatchingOutput(manifest),
      windowsMonitor: makeMonitorSummary({
        monitorStatus: 'supervisor_timeout',
        failureDetails: 'Supervisor deadline expired.',
        quarantinedOwnedProcesses: [{ role: 'parent', pid: 10_001, startTimeUtc: null }],
      }),
    });
    expect(scoredMonTimeout.memoryAccepted).toBe(false);
    expect(scoredMonTimeout.benchmarkAccepted).toBe(false);
    expect(scoredMonTimeout.acceptanceReasons.some((r) => r.includes('supervisor_timeout'))).toBe(
      true,
    );
  });

  it('preserves missing graph files and malformed monitor artifacts cleanly in scoreRunDirectory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-bench-corrupt-'));
    tempDirs.push(dir);

    const parentRec = makeParentRecord('zustand', {
      runnerConfig: { ...makeParentRecord('zustand').runnerConfig, skipLoadingLibFiles: true },
    });
    const parentPath = path.join(dir, 'parent-run-record.json');
    const badMonitorPath = path.join(dir, 'windows-monitor.json');
    await writeFileExclusiveJson(parentPath, parentRec);
    await writeFile(badMonitorPath, '{ invalid json', 'utf8');

    // Missing graph-output-iter1.json + malformed windows-monitor.json -> recorded cleanly as failed/unaccepted
    const scoredPath = path.join(dir, 'scored-run.json');
    const scored = await scoreRunDirectory({
      runDir: dir,
      runId: 'zustand-corrupt-run',
      parentRecordPath: parentPath,
      monitorPath: badMonitorPath,
      outPath: scoredPath,
    });
    expect(scored.executionStatus).toBe('failed');
    expect(scored.benchmarkAccepted).toBe(false);
    expect(scored.memoryAccepted).toBe(false);
    expect(scored.windowsMonitor).toBeNull();
    expect(scored.parentRecord?.repoId).toBe('zustand');
    expect(scored.acceptanceReasons.some((r) => r.includes('Monitor artifact invalid'))).toBe(true);
    expect(scored.failureReason).toContain('Graph artifact load/validation error');
  });

  it('aggregates 9 accepted runs with once-per-repo micro-averaging and rejects mixed config/env/OS, duplicate runIds/records, digest drift, and multi-iteration records', async () => {
    const zManifest = await loadFrozenManifest('zustand');
    const pManifest = await loadFrozenManifest('nextjs-subscription-payments');
    const tManifest = await loadFrozenManifest('taxonomy');

    const zOut = buildMinimalMatchingOutput(zManifest);
    const pOut = buildMinimalMatchingOutput(pManifest);
    const tOut = buildMinimalMatchingOutput(tManifest);

    // Use skipLoadingLibFiles=true so synthetic minimal graphs satisfy benchmarkAccepted=true
    const makeScored = (
      repoId: FrozenRepoId,
      manifest: GroundTruthManifest,
      output: AnalysisOutput,
      idx: number,
      opts: {
        readonly skipLib?: boolean;
        readonly platform?: string;
        readonly terminateGraceMs?: number;
      } = {},
    ): ScoredBenchmarkRunRecord => {
      const seed =
        (repoId === 'zustand' ? 10 : repoId === 'nextjs-subscription-payments' ? 20 : 30) + idx;
      const baseParent = makeParentRecord(repoId, {}, seed);
      const parentRecord: ParentBenchmarkRunRecord = {
        ...baseParent,
        environment: {
          ...baseParent.environment,
          ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
        },
        runnerConfig: {
          ...baseParent.runnerConfig,
          skipLoadingLibFiles: opts.skipLib ?? true,
          ...(opts.terminateGraceMs !== undefined
            ? { terminateGraceMs: opts.terminateGraceMs }
            : {}),
        },
      };
      return scorePersistedBenchmarkRun({
        runId: `${repoId}-run${String(idx)}`,
        manifest,
        parentRecord,
        persistedGraphOutput: output,
        windowsMonitor: makeMonitorSummary({}, seed),
      });
    };

    const nineRuns = [
      makeScored('zustand', zManifest, zOut, 1),
      makeScored('zustand', zManifest, zOut, 2),
      makeScored('zustand', zManifest, zOut, 3),
      makeScored('nextjs-subscription-payments', pManifest, pOut, 1),
      makeScored('nextjs-subscription-payments', pManifest, pOut, 2),
      makeScored('nextjs-subscription-payments', pManifest, pOut, 3),
      makeScored('taxonomy', tManifest, tOut, 1),
      makeScored('taxonomy', tManifest, tOut, 2),
      makeScored('taxonomy', tManifest, tOut, 3),
    ];

    const report = aggregateBenchmarkRuns(nineRuns, { expectedRunsPerRepo: 3 });
    expect(report.complete).toBe(true);
    expect(report.accepted).toBe(true);
    expect(report.hasFailures).toBe(false);
    expect(report.hasUnacceptedRuns).toBe(false);
    expect(report.aggregateAccuracy?.imports.expectedCount).toBe(77);
    expect(report.aggregateAccuracy?.primaryCalls.expectedCount).toBe(160);
    expect(report.repositories[0]?.osMaxSameIterationCombinedWorkingSetBytes.median).toBe(
      270_000_000,
    );
    expect(formatBenchmarkMarkdown(report)).toContain('COMPLETE & ACCEPTED');

    // Mixed OS platform (win32 vs linux) rejected
    expect(() =>
      aggregateBenchmarkRuns([
        makeScored('zustand', zManifest, zOut, 1, { platform: 'win32' }),
        makeScored('zustand', zManifest, zOut, 2, { platform: 'linux' }),
      ]),
    ).toThrow(/Inconsistent runtime environment/);

    // Mixed runnerConfig field (terminateGraceMs) rejected
    expect(() =>
      aggregateBenchmarkRuns([
        makeScored('zustand', zManifest, zOut, 1, { terminateGraceMs: 2_000 }),
        makeScored('zustand', zManifest, zOut, 2, { terminateGraceMs: 5_000 }),
      ]),
    ).toThrow(/Inconsistent runnerConfig/);

    // Duplicate runId rejected
    expect(() =>
      aggregateBenchmarkRuns([
        makeScored('zustand', zManifest, zOut, 1),
        makeScored('zustand', zManifest, zOut, 1),
      ]),
    ).toThrow(/Duplicate runId/);

    // Duplicate underlying execution record with different runId rejected
    const origRun = makeScored('zustand', zManifest, zOut, 1);
    expect(() =>
      aggregateBenchmarkRuns([origRun, { ...origRun, runId: 'zustand-renamed-copy' }]),
    ).toThrow(/Duplicate run record/);

    // Multi-iteration repeated-job record rejected by single-run aggregator
    const iterA = makeParentRecord('zustand', {}, 1).iterations[0];
    const iterB = makeParentRecord('zustand', {}, 2).iterations[0];

    if (iterA === undefined || iterB === undefined) {
      throw new Error('Expected iteration fixtures.');
    }

    const multiIterParent = makeParentRecord('zustand', {
      runnerConfig: {
        ...makeParentRecord('zustand').runnerConfig,
        skipLoadingLibFiles: true,
      },
      iterations: [iterA, { ...iterB, iterationIndex: 2 }],
    });
    const multiIterScored = scorePersistedBenchmarkRun({
      runId: 'zustand-repeated-job',
      manifest: zManifest,
      parentRecord: multiIterParent,
      persistedGraphOutput: zOut,
      windowsMonitor: makeMonitorSummary({}, 1),
    });
    expect(() => aggregateBenchmarkRuns([multiIterScored])).toThrow(/multi-iteration repeated-job/);

    // Non-deterministic graphDigest across repetitions rejected
    const alteredOut: AnalysisOutput = { ...zOut, stats: { ...zOut.stats, totalBytesRead: 999 } };
    expect(() =>
      aggregateBenchmarkRuns([
        makeScored('zustand', zManifest, zOut, 1),
        makeScored('zustand', zManifest, alteredOut, 2),
      ]),
    ).toThrow(/Non-deterministic graphDigest/);
  });

  it('preserves unaccepted with-lib digest-mismatch runs without marking aggregate accepted, and rejects duplicate CLI --run files', async () => {
    const zManifest = await loadFrozenManifest('zustand');
    const zOut = buildMinimalMatchingOutput(zManifest);

    // With-lib run whose synthetic graph does not match the real 49-file digest -> complete execution but NOT accepted
    const unacceptedRun = scorePersistedBenchmarkRun({
      runId: 'zustand-withlib-unaccepted',
      manifest: zManifest,
      parentRecord: makeParentRecord('zustand', {}, 1),
      persistedGraphOutput: zOut,
      windowsMonitor: makeMonitorSummary({}, 1),
    });
    const report = aggregateBenchmarkRuns([unacceptedRun], { expectedRunsPerRepo: 1 });
    expect(report.accepted).toBe(false);
    expect(report.hasUnacceptedRuns).toBe(true);
    expect(report.failedOrUnacceptedRunSummaries).toHaveLength(1);
    expect(formatBenchmarkMarkdown(report)).toContain('UNACCEPTED — FAILED ACCEPTANCE GATE');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-bench-cli-dup-'));
    tempDirs.push(dir);
    const runFile = path.join(dir, 'r1.json');
    await writeFileExclusiveJson(runFile, unacceptedRun);
    await expect(runScoreCli(['aggregate', '--run', runFile, '--run', runFile])).rejects.toThrow(
      /Duplicate --run file/,
    );
  });

  it('fresh-process import isolation: measured benchmark parent never loads @archon/core, ts-morph, TS, parser-child, worker barrel, or evaluator modules', () => {
    const probe = runFreshImportProbe(COMPILED_PARENT_PATH, true);
    expect(probe.exportedKeys).toContain('runMeasuredBenchmarkParent');
    expect(probe.exportedKeys).toContain('loadCompiledParserRunnerModule');

    const combined = [...probe.loadedUrls, ...probe.resolvedSpecifiers].map((s) => s.toLowerCase());
    const forbiddenPatterns = [
      '@archon/core',
      '/packages/core/dist/',
      'ts-morph',
      '/typescript/lib/typescript',
      'parser-child',
      'snapshot-verifier',
      'evaluate-recall',
      'eval-policy',
      '/apps/worker/dist/index.js',
      'bullmq',
      'ioredis',
    ];
    for (const pattern of forbiddenPatterns) {
      expect(
        combined.some((entry) => entry.includes(pattern)),
        `Measured benchmark parent unexpectedly loaded forbidden dependency "${pattern}": ${JSON.stringify(probe.loadedUrls)}`,
      ).toBe(false);
    }
    expect(combined.some((entry) => entry.includes('/apps/worker/dist/parser-runner.js'))).toBe(
      true,
    );
  }, 15_000);

  it('positive control: import-isolation probe detects heavy compiler & evaluator imports when loading benchmark-parser-score', () => {
    const probe = runFreshImportProbe(COMPILED_SCORE_PATH, false);
    const combined = [...probe.loadedUrls, ...probe.resolvedSpecifiers].map((s) => s.toLowerCase());
    expect(combined.some((entry) => entry.includes('eval-policy'))).toBe(true);
    expect(combined.some((entry) => entry.includes('snapshot-verifier'))).toBe(true);
    expect(combined.some((entry) => entry.includes('/packages/core/dist/'))).toBe(true);
    expect(combined.some((entry) => entry.includes('ts-morph'))).toBe(true);
  }, 15_000);

  it(
    'executes lightweight measured benchmark parent end-to-end in instrumented and public modes recording pre-final-write memory boundaries',
    async () => {
      const baseDir = await mkdtemp(path.join(os.tmpdir(), 'archon-bench-e2e-'));
      tempDirs.push(baseDir);

      const repoDir = path.join(baseDir, 'mini-repo');
      await mkdir(path.join(repoDir, 'src'), { recursive: true });
      await writeFile(
        path.join(repoDir, 'src', 'a.ts'),
        'export function add(x: number, y: number): number { return x + y; }\n',
        'utf8',
      );
      await writeFile(
        path.join(repoDir, 'src', 'b.ts'),
        "import { add } from './a';\nexport function main(): number { return add(1, 2); }\n",
        'utf8',
      );

      const spec = FROZEN_EVAL_REPOS.zustand;
      const invPath = path.join(baseDir, 'prepared-inventory.json');
      const inventory: PreparedSnapshotInventory = {
        schemaVersion: 1,
        repoId: 'zustand',
        repository: spec.repository,
        commitSha: spec.commitSha,
        manifestRelativePath: spec.manifestRelativePath,
        manifestSha256: spec.manifestSha256,
        canonicalRoot: repoDir,
        supportedFiles: ['src/a.ts', 'src/b.ts'],
        configFiles: [],
        totalSupportedBytes: 120,
        totalConfigBytes: 0,
        bundledTypeScriptVersion: '6.0.2',
        preparedAtUtc: new Date().toISOString(),
      };
      await writeFileExclusiveJson(invPath, inventory);

      const outDir1 = path.join(baseDir, 'run-inst');
      const outRec1 = path.join(outDir1, 'parent-run-record.json');
      const rec1 = await runMeasuredBenchmarkParent({
        inventoryPath: invPath,
        outRecordPath: outRec1,
        outDir: outDir1,
        mode: 'instrumented-spawn-pid-hook',
        skipLoadingLibFiles: true,
        parserTimeoutMs: 20_000,
        emitEvents: false,
      });
      expect(rec1.runStatus).toBe('success');
      expect(rec1.iterations[0]?.childPid).toBeTypeOf('number');
      expect(rec1.parentMemoryBeforeFinalRecordWrite.preFinalRecordWriteMaxRssKiB).toBeGreaterThan(
        0,
      );
      expect(validateParentBenchmarkRunRecord(rec1, 'e2e-rec1').runStatus).toBe('success');

      const graphText = await readFile(path.join(outDir1, 'graph-output-iter1.json'), 'utf8');
      const graph = JSON.parse(graphText) as AnalysisOutput;
      expect(graph.stats.importsEdgeCount).toBe(1);
      expect(graph.stats.callsEdgeCount).toBe(1);

      const outDir2 = path.join(baseDir, 'run-pub');
      const outRec2 = path.join(outDir2, 'parent-run-record.json');
      const rec2 = await runMeasuredBenchmarkParent({
        inventoryPath: invPath,
        outRecordPath: outRec2,
        outDir: outDir2,
        mode: 'public-createParserRunner',
        skipLoadingLibFiles: true,
        parserTimeoutMs: 20_000,
        emitEvents: false,
      });
      expect(rec2.runStatus).toBe('success');
      expect(rec2.iterations[0]?.childPid).toBeNull();
    },
    REAL_CHILD_TIMEOUT_MS,
  );
});
