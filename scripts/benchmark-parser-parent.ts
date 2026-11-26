import { fork } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
  DEFAULT_MAX_CONFIG_FILES,
  DEFAULT_MAX_EXTENDS_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILE_SNIPPET_CHARS,
  DEFAULT_MAX_IPC_RESPONSE_BYTES,
  DEFAULT_MAX_SUPPORTED_FILES,
  DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_WARNINGS,
} from '@archon/shared';
import type {
  ParserRunMetrics,
  ParserRunner,
  ParserRunnerError,
  ParserRunnerFatalEvent,
  ParserRunnerOptions,
  ParserRunnerTestHooks,
  ParserSpawnArgs,
} from '../apps/worker/src/parser-runner.js';
import {
  BENCHMARK_EVENT_PREFIX,
  BENCHMARK_SCHEMA_VERSION,
  BenchmarkError,
  isPlainObject,
  parseBenchmarkJson,
  validatePreparedSnapshotInventory,
  writeFileExclusiveJson,
  type BenchmarkRunnerConfigRecord,
  type ParentBenchmarkRunRecord,
  type ParentErrorRecord,
  type ParentFatalEventRecord,
  type ParentIterationRecord,
  type ParentRunnerMode,
} from './benchmark-parser-types.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARCHON_ROOT = path.resolve(MODULE_DIR, path.basename(MODULE_DIR) === 'dist' ? '../..' : '..');
const COMPILED_PARSER_RUNNER_PATH = path.join(
  ARCHON_ROOT,
  'apps',
  'worker',
  'dist',
  'parser-runner.js',
);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OLD_SPACE_MB = 256;
const DEFAULT_TERMINATE_GRACE_MS = 2_000;
const DEFAULT_KILL_CONFIRMATION_MS = 3_000;

export interface LoadedParserRunnerModule {
  readonly createParserRunner: (options?: ParserRunnerOptions) => ParserRunner;
  readonly createParserRunnerForTesting: (
    options: ParserRunnerOptions,
    testHooks: ParserRunnerTestHooks,
  ) => ParserRunner;
  readonly ParserRunnerError: typeof ParserRunnerError;
}

function isLoadedParserRunnerModule(value: unknown): value is LoadedParserRunnerModule {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    typeof value.createParserRunner === 'function' &&
    typeof value.createParserRunnerForTesting === 'function' &&
    typeof value.ParserRunnerError === 'function'
  );
}

/**
 * Dynamically loads ONLY the compiled `apps/worker/dist/parser-runner.js` module so this
 * lightweight measured parent never imports the worker barrel (`apps/worker/dist/index.js`),
 * BullMQ, Redis, PostgreSQL, `@archon/core`, `ts-morph`, or bundled TypeScript.
 */
export async function loadCompiledParserRunnerModule(): Promise<LoadedParserRunnerModule> {
  const runnerUrl = pathToFileURL(COMPILED_PARSER_RUNNER_PATH).href;
  const loaded: unknown = await import(runnerUrl);
  if (!isLoadedParserRunnerModule(loaded)) {
    throw new BenchmarkError(
      `Compiled parser runner at "${COMPILED_PARSER_RUNNER_PATH}" did not export expected runner API.`,
    );
  }
  return loaded;
}

function emitLifecycleEvent(payload: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${BENCHMARK_EVENT_PREFIX}${JSON.stringify(payload)}\n`);
}

function serializeRunnerError(
  err: unknown,
  RunnerErrorCtor: typeof ParserRunnerError,
): ParentErrorRecord {
  if (err instanceof RunnerErrorCtor) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      fatal: err.fatal,
      startupFailure: err.startupFailure,
      ...(err.coreErrorCode !== undefined ? { coreErrorCode: err.coreErrorCode } : {}),
      exitCode: err.exitCode ?? null,
      signal: err.signal ?? null,
    };
  }
  return {
    code: 'UNEXPECTED_PARENT_ERROR',
    message: err instanceof Error ? err.message : 'Unexpected parent benchmark error.',
    retryable: false,
    fatal: false,
    startupFailure: false,
    exitCode: null,
    signal: null,
  };
}

export interface MeasuredParentOptions {
  readonly inventoryPath: string;
  readonly outRecordPath: string;
  readonly outDir: string;
  readonly mode?: ParentRunnerMode;
  readonly repetitions?: number;
  readonly skipLoadingLibFiles?: boolean;
  readonly maxOldSpaceSizeMb?: number;
  readonly parserTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly terminateGraceMs?: number;
  readonly killConfirmationMs?: number;
  readonly emitEvents?: boolean;
}

export async function runMeasuredBenchmarkParent(
  options: MeasuredParentOptions,
): Promise<ParentBenchmarkRunRecord> {
  const startedAtUtc = new Date().toISOString();
  const processStartMs = performance.now();

  const inventoryRaw = await readFile(options.inventoryPath, 'utf8');
  const inventory = validatePreparedSnapshotInventory(
    parseBenchmarkJson(inventoryRaw, options.inventoryPath),
    options.inventoryPath,
  );

  const runnerModule = await loadCompiledParserRunnerModule();
  const importsLoadedDurationMs = Number(
    Math.max(0, performance.now() - processStartMs).toFixed(2),
  );
  const startupMem = process.memoryUsage();

  const emitEvents = options.emitEvents ?? true;
  const parentRunnerMode: ParentRunnerMode = options.mode ?? 'instrumented-spawn-pid-hook';
  const repetitions = options.repetitions ?? 1;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 50) {
    throw new BenchmarkError(
      `repetitions must be an integer in [1, 50] (received ${String(repetitions)}).`,
    );
  }

  const runnerConfig: BenchmarkRunnerConfigRecord = {
    parserTimeoutMs: options.parserTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOldSpaceSizeMb: options.maxOldSpaceSizeMb ?? DEFAULT_OLD_SPACE_MB,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_IPC_RESPONSE_BYTES,
    terminateGraceMs: options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    killConfirmationMs: options.killConfirmationMs ?? DEFAULT_KILL_CONFIRMATION_MS,
    skipLoadingLibFiles: options.skipLoadingLibFiles ?? false,
    maxSupportedFiles: DEFAULT_MAX_SUPPORTED_FILES,
    maxConfigFiles: DEFAULT_MAX_CONFIG_FILES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
    maxFileSnippetChars: DEFAULT_MAX_FILE_SNIPPET_CHARS,
    maxSymbolSnippetChars: DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
    maxCallSiteSnippetChars: DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
    maxWarnings: DEFAULT_MAX_WARNINGS,
    maxExtendsDepth: DEFAULT_MAX_EXTENDS_DEPTH,
  };

  if (emitEvents) {
    emitLifecycleEvent({
      event: 'parent_imports_loaded',
      pid: process.pid,
      importsLoadedDurationMs,
      heapUsedBytes: startupMem.heapUsed,
      rssBytes: startupMem.rss,
      timestampUtc: new Date().toISOString(),
    });
  }

  const iterationState: {
    currentIteration: number;
    childPid: number | null;
    fatalEvent: ParentFatalEventRecord | null;
  } = {
    currentIteration: 0,
    childPid: null,
    fatalEvent: null,
  };

  const runnerOptions: ParserRunnerOptions = {
    parserTimeoutMs: runnerConfig.parserTimeoutMs,
    maxOldSpaceSizeMb: runnerConfig.maxOldSpaceSizeMb,
    maxResponseBytes: runnerConfig.maxResponseBytes,
    terminateGraceMs: runnerConfig.terminateGraceMs,
    killConfirmationMs: runnerConfig.killConfirmationMs,
    skipLoadingLibFiles: runnerConfig.skipLoadingLibFiles,
    onFatalState: (event: ParserRunnerFatalEvent) => {
      const fatalRecord: ParentFatalEventRecord = {
        code: event.error.code,
        requestId: event.requestId,
        pid: event.pid ?? null,
        processExited: event.processExited,
        timestampUtc: new Date().toISOString(),
      };
      iterationState.fatalEvent = fatalRecord;
      if (emitEvents) {
        emitLifecycleEvent({
          event: 'fatal_state',
          iterationIndex: iterationState.currentIteration,
          ...fatalRecord,
        });
      }
      const fatalFilePath = path.join(
        options.outDir,
        `fatal-state-iter${String(iterationState.currentIteration)}.json`,
      );
      void writeFileExclusiveJson(fatalFilePath, {
        schemaVersion: BENCHMARK_SCHEMA_VERSION,
        repoId: inventory.repoId,
        iterationIndex: iterationState.currentIteration,
        parentPid: process.pid,
        fatalEvent: fatalRecord,
      }).catch(() => {
        // Ignore secondary disk error during fatal notification
      });
    },
  };

  const runner: ParserRunner =
    parentRunnerMode === 'instrumented-spawn-pid-hook'
      ? runnerModule.createParserRunnerForTesting(runnerOptions, {
          // Uses the exact compiled entrypoint, execPath, execArgv, cwd, env, serialization,
          // stdio, and full entrypoint validation of the production runner — adding only
          // lightweight stdout child-PID lifecycle markers for external OS monitoring.
          spawnChild: (args: ParserSpawnArgs) => {
            const child = fork(args.entrypointPath, [], {
              execPath: args.execPath,
              execArgv: [...args.execArgv],
              cwd: args.cwd,
              env: { ...args.env },
              serialization: 'json',
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
            iterationState.childPid = child.pid ?? null;
            if (emitEvents && child.pid !== undefined) {
              emitLifecycleEvent({
                event: 'child_spawned',
                iterationIndex: iterationState.currentIteration,
                childPid: child.pid,
                timestampUtc: new Date().toISOString(),
              });
            }
            child.on('close', (exitCode, signal) => {
              if (emitEvents && child.pid !== undefined) {
                emitLifecycleEvent({
                  event: 'child_closed',
                  iterationIndex: iterationState.currentIteration,
                  childPid: child.pid,
                  exitCode,
                  signal,
                  timestampUtc: new Date().toISOString(),
                });
              }
            });
            return child;
          },
        })
      : runnerModule.createParserRunner(runnerOptions);

  const iterations: ParentIterationRecord[] = [];
  let overallStatus: ParentBenchmarkRunRecord['runStatus'] = 'success';

  for (let i = 1; i <= repetitions; i += 1) {
    iterationState.currentIteration = i;
    iterationState.childPid = null;
    iterationState.fatalEvent = null;

    if (emitEvents) {
      emitLifecycleEvent({
        event: 'parser_run_start',
        iterationIndex: i,
        timestampUtc: new Date().toISOString(),
      });
    }

    try {
      const runResult = await runner.run({
        rootDir: inventory.canonicalRoot,
        supportedFiles: inventory.supportedFiles,
        configFiles: inventory.configFiles,
        maxSupportedFiles: runnerConfig.maxSupportedFiles,
        maxConfigFiles: runnerConfig.maxConfigFiles,
        maxFileBytes: runnerConfig.maxFileBytes,
        maxTotalBytes: runnerConfig.maxTotalBytes,
        maxFileSnippetChars: runnerConfig.maxFileSnippetChars,
        maxSymbolSnippetChars: runnerConfig.maxSymbolSnippetChars,
        maxCallSiteSnippetChars: runnerConfig.maxCallSiteSnippetChars,
        maxWarnings: runnerConfig.maxWarnings,
        maxExtendsDepth: runnerConfig.maxExtendsDepth,
        skipLoadingLibFiles: runnerConfig.skipLoadingLibFiles,
      });

      const runMetrics: ParserRunMetrics = runResult.metrics;

      if (emitEvents) {
        emitLifecycleEvent({
          event: 'parser_run_settled',
          iterationIndex: i,
          status: 'success',
          requestId: runResult.requestId,
          childPid: iterationState.childPid,
          timestampUtc: new Date().toISOString(),
        });
      }

      // Window C: graph artifact serialization & exclusive persistence (explicitly after parser settlement)
      const persistStartMs = performance.now();
      const graphFileName = `graph-output-iter${String(i)}.json`;
      const graphFilePath = path.join(options.outDir, graphFileName);
      const graphFileBytes = await writeFileExclusiveJson(graphFilePath, runResult.output);
      const persistDurationMs = Number(Math.max(0, performance.now() - persistStartMs).toFixed(2));
      const postPersistMem = process.memoryUsage();

      if (emitEvents) {
        emitLifecycleEvent({
          event: 'artifacts_persisted',
          iterationIndex: i,
          graphFileBytes,
          persistDurationMs,
          timestampUtc: new Date().toISOString(),
        });
      }

      iterations.push({
        iterationIndex: i,
        status: 'success',
        requestId: runResult.requestId,
        childPid: iterationState.childPid,
        finalRunnerState: runner.getState(),
        isFatal: runner.isFatal(),
        hasActiveChild: runner.hasActiveChild(),
        metrics: runMetrics,
        graphArtifactFileName: graphFileName,
        artifactPersistence: {
          durationMs: persistDurationMs,
          graphFileBytes,
          postPersistParentHeapUsedBytes: postPersistMem.heapUsed,
          postPersistParentRssBytes: postPersistMem.rss,
        },
        error: null,
        fatalEvent: iterationState.fatalEvent,
      });
    } catch (err: unknown) {
      const serializedError = serializeRunnerError(err, runnerModule.ParserRunnerError);
      const iterStatus: ParentIterationRecord['status'] =
        runner.isFatal() || serializedError.fatal ? 'fatal' : 'error';
      if (iterStatus === 'fatal') {
        overallStatus = 'fatal';
      } else if (overallStatus === 'success') {
        overallStatus = 'error';
      }

      if (emitEvents) {
        emitLifecycleEvent({
          event: 'parser_run_settled',
          iterationIndex: i,
          status: iterStatus,
          errorCode: serializedError.code,
          childPid: iterationState.childPid,
          timestampUtc: new Date().toISOString(),
        });
      }

      iterations.push({
        iterationIndex: i,
        status: iterStatus,
        requestId:
          err instanceof runnerModule.ParserRunnerError && err.requestId !== undefined
            ? err.requestId
            : null,
        childPid: iterationState.childPid,
        finalRunnerState: runner.getState(),
        isFatal: runner.isFatal(),
        hasActiveChild: runner.hasActiveChild(),
        metrics: null,
        graphArtifactFileName: null,
        artifactPersistence: null,
        error: serializedError,
        fatalEvent: iterationState.fatalEvent,
      });

      if (runner.isFatal()) {
        break;
      }
    }
  }

  // Window D: final parent record writing (explicitly separated from parser execution & graph persistence)
  if (emitEvents) {
    emitLifecycleEvent({
      event: 'final_record_writing',
      timestampUtc: new Date().toISOString(),
    });
  }

  const preFinalWriteMem = process.memoryUsage();
  const preFinalWriteMaxRssKiB = process.resourceUsage().maxRSS;

  const record: ParentBenchmarkRunRecord = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runStatus: overallStatus,
    parentTopology: 'lightweight-parser-only-parent',
    parentRunnerMode,
    instrumentationOverheadNotes:
      parentRunnerMode === 'instrumented-spawn-pid-hook'
        ? 'Uses createParserRunnerForTesting strictly to mirror production fork() arguments with full entrypoint validation and emit single-line stdout child PID lifecycle markers for external OS memory sampling. Not a measurement of the full production API+worker process.'
        : 'Uses public createParserRunner() with zero spawn-hook instrumentation. Not a measurement of the full production API+worker process.',
    repoId: inventory.repoId,
    repository: inventory.repository,
    commitSha: inventory.commitSha,
    manifestRelativePath: inventory.manifestRelativePath,
    manifestSha256: inventory.manifestSha256,
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      bundledTypeScriptVersion: inventory.bundledTypeScriptVersion,
    },
    parentProcess: {
      pid: process.pid,
      startedAtUtc,
    },
    runnerConfig,
    snapshotInventory: {
      supportedFilesCount: inventory.supportedFiles.length,
      configFilesCount: inventory.configFiles.length,
      totalSupportedBytes: inventory.totalSupportedBytes,
      totalConfigBytes: inventory.totalConfigBytes,
    },
    parentStartup: {
      importsLoadedDurationMs,
      heapUsedBytes: startupMem.heapUsed,
      rssBytes: startupMem.rss,
    },
    iterations,
    parentMemoryBeforeFinalRecordWrite: {
      heapUsedBytes: preFinalWriteMem.heapUsed,
      rssBytes: preFinalWriteMem.rss,
      preFinalRecordWriteMaxRssKiB: preFinalWriteMaxRssKiB,
    },
  };

  await writeFileExclusiveJson(options.outRecordPath, record);
  return record;
}

function getFlag(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

function parseOptionalIntFlag(args: readonly string[], flag: string): number | undefined {
  const raw = getFlag(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num)) {
    throw new BenchmarkError(`Flag ${flag} must be a safe integer (received "${raw}").`);
  }
  return num;
}

function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1.trim().length === 0) {
    return false;
  }
  const metaPath = fileURLToPath(metaUrl);
  try {
    const cMeta = realpathSync(metaPath);
    const cArgv = realpathSync(path.resolve(argv1));
    return process.platform === 'win32'
      ? cMeta.toLowerCase() === cArgv.toLowerCase()
      : cMeta === cArgv;
  } catch {
    const rMeta = path.resolve(metaPath);
    const rArgv = path.resolve(argv1);
    return process.platform === 'win32'
      ? rMeta.toLowerCase() === rArgv.toLowerCase()
      : rMeta === rArgv;
  }
}

export async function runParentCli(argv: readonly string[]): Promise<void> {
  const inventoryPath = getFlag(argv, '--inventory');
  const outRecordPath = getFlag(argv, '--out-record');
  const outDir = getFlag(argv, '--out-dir');
  const modeArg = getFlag(argv, '--mode');

  if (inventoryPath === undefined || outRecordPath === undefined || outDir === undefined) {
    throw new BenchmarkError(
      'Usage: node scripts/dist/benchmark-parser-parent.js --inventory <file> --out-record <file> --out-dir <dir> [--mode instrumented|public] [--repetitions <n>] [--skip-lib-files] [--max-old-space-mb <n>] [--timeout-ms <n>] [--max-response-bytes <n>]',
    );
  }

  let mode: ParentRunnerMode = 'instrumented-spawn-pid-hook';
  if (modeArg === 'public') {
    mode = 'public-createParserRunner';
  } else if (modeArg !== undefined && modeArg !== 'instrumented') {
    throw new BenchmarkError(`Invalid --mode "${modeArg}" (expected "instrumented" or "public").`);
  }

  const repetitions = parseOptionalIntFlag(argv, '--repetitions');
  const maxOldSpaceSizeMb = parseOptionalIntFlag(argv, '--max-old-space-mb');
  const parserTimeoutMs = parseOptionalIntFlag(argv, '--timeout-ms');
  const maxResponseBytes = parseOptionalIntFlag(argv, '--max-response-bytes');

  const record = await runMeasuredBenchmarkParent({
    inventoryPath,
    outRecordPath,
    outDir,
    mode,
    ...(repetitions !== undefined ? { repetitions } : {}),
    skipLoadingLibFiles: argv.includes('--skip-lib-files'),
    ...(maxOldSpaceSizeMb !== undefined ? { maxOldSpaceSizeMb } : {}),
    ...(parserTimeoutMs !== undefined ? { parserTimeoutMs } : {}),
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
  });

  if (record.runStatus !== 'success') {
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runParentCli(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`BENCHMARK_PARENT_ERROR: ${message}\n`);
    process.exitCode = 1;
  });
}
