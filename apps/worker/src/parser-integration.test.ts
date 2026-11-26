import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_ANALYSIS_ERROR_CODES,
  type AnalysisOutput,
  type CoreAnalysisErrorCode,
} from '@archon/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PARSER_PERSISTED_ERROR_CODES,
  PRODUCTION_PARSER_CONFIG,
  ParserIntegrationError,
  classifyParserRunnerError,
  createProductionParserAdapter,
  noopAnalysisResultHandoff,
  preflightProductionParserEntrypoint,
  resolveProductionParserLimitsFromEnv,
  validateProductionParserLimits,
  type ProductionParserLogEvent,
  type SafeParserFatalNotification,
} from './parser-integration.js';
import {
  PARSER_RUNNER_ERROR_CODES,
  ParserRunnerError,
  validateCompiledParserEntrypoint,
  type ParserRunInput,
  type ParserRunMetrics,
  type ParserRunResult,
  type ParserRunner,
  type ParserRunnerErrorCode,
  type ParserRunnerFatalEvent,
  type ParserRunnerOptions,
  type ParserRunnerState,
} from './parser-runner.js';

const REAL_CHILD_TIMEOUT_MS = 25_000;
const VALID_SHA256 = 'a'.repeat(64);
const SENSITIVE_SNIPPET_SENTINEL = 'SECRET_SOURCE_SNIPPET_SENTINEL_777';
const SENSITIVE_PATH_SENTINEL = 'C:\\private\\workspace\\SECRET_PATH_888';
const SENSITIVE_CAUSE_SENTINEL = 'SECRET_RAW_CAUSE_CREDENTIAL_999';

function makeSampleOutput(): AnalysisOutput {
  return {
    nodes: [
      {
        nodeType: 'file',
        name: 'entry.ts',
        qualifiedName: 'file:src/entry.ts',
        filePath: 'src/entry.ts',
        parentQualifiedName: null,
        isExported: false,
        startLine: 1,
        endLine: 3,
        contentHash: VALID_SHA256,
        snippet: `export const token = "${SENSITIVE_SNIPPET_SENTINEL}";`,
      },
    ],
    edges: [],
    warnings: [
      {
        code: 'INVALID_TSCONFIG',
        filePath: 'tsconfig.json',
        message: 'Ignored invalid tsconfig',
      },
    ],
    stats: {
      discoveredFilesCount: 1,
      parsedFilesCount: 1,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 1,
      folderNodeCount: 0,
      fileNodeCount: 1,
      functionNodeCount: 0,
      classNodeCount: 0,
      symbolNodeCount: 0,
      importsEdgeCount: 0,
      callsEdgeCount: 0,
      totalBytesRead: 64,
      truncatedWarningsCount: 0,
    },
  };
}

function makeSampleMetrics(): ParserRunMetrics {
  return {
    endToEndDurationMs: 120.5,
    childAnalysisDurationMs: 88.2,
    childPreSendMemory: {
      baselineHeapUsedBytes: 10_000_000,
      postHeapUsedBytes: 25_000_000,
      baselineRssBytes: 40_000_000,
      postRssBytes: 90_000_000,
      maxRssKiB: 92_000,
    },
    serializedResponseBytes: 1_024,
    parentValidationDurationMs: 1.5,
    parentMemory: {
      baselineHeapUsedBytes: 8_000_000,
      postHeapUsedBytes: 9_000_000,
      baselineRssBytes: 35_000_000,
      postRssBytes: 36_000_000,
    },
    exitCode: 0,
    signal: null,
  };
}

describe('production parser integration adapter & error classification (Batch 4.3D.1)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('locks exact Batch 4.3C.5 benchmarked production parser configuration and short persisted error codes', () => {
    expect(PRODUCTION_PARSER_CONFIG).toEqual({
      skipLoadingLibFiles: true,
      parserTimeoutMs: 60_000,
      maxOldSpaceSizeMb: 256,
      maxResponseBytes: 33_554_432,
      terminateGraceMs: 2_000,
      killConfirmationMs: 3_000,
      concurrency: 1,
      maxSupportedFiles: 500,
      maxConfigFiles: 50,
      maxFileBytes: 1_048_576,
      maxTotalBytes: 52_428_800,
      maxFileSnippetChars: 8_192,
      maxSymbolSnippetChars: 4_096,
      maxCallSiteSnippetChars: 512,
      maxWarnings: 200,
      maxExtendsDepth: 10,
    });

    for (const code of PARSER_PERSISTED_ERROR_CODES) {
      expect(code.length).toBeLessThanOrEqual(32);
    }
  });

  it('validates configured lower limits and rejects exceeding/invalid limits without silent clamping', () => {
    const fromEnv = resolveProductionParserLimitsFromEnv({
      MAX_SUPPORTED_FILES: 40,
      MAX_REPO_SIZE_MB: 12,
    });
    expect(fromEnv.maxSupportedFiles).toBe(40);
    expect(fromEnv.maxTotalBytes).toBe(12 * 1024 * 1024);
    expect(fromEnv.maxConfigFiles).toBe(50);

    const lowerCustom = validateProductionParserLimits({
      maxSupportedFiles: 10,
      maxConfigFiles: 5,
      maxFileBytes: 4096,
      maxTotalBytes: 8192,
      maxFileSnippetChars: 0,
      maxSymbolSnippetChars: 0,
      maxCallSiteSnippetChars: 0,
      maxWarnings: 0,
      maxExtendsDepth: 0,
    });
    expect(lowerCustom.maxSupportedFiles).toBe(10);
    expect(lowerCustom.maxCallSiteSnippetChars).toBe(0);

    // Reject values exceeding parser IPC ceilings or invalid numbers
    const invalidCases = [
      () =>
        resolveProductionParserLimitsFromEnv({ MAX_SUPPORTED_FILES: 501, MAX_REPO_SIZE_MB: 50 }),
      () =>
        resolveProductionParserLimitsFromEnv({ MAX_SUPPORTED_FILES: 500, MAX_REPO_SIZE_MB: 51 }),
      () => resolveProductionParserLimitsFromEnv({ MAX_SUPPORTED_FILES: 0, MAX_REPO_SIZE_MB: 10 }),
      () => validateProductionParserLimits({ maxTotalBytes: 52_428_801 }),
      () => validateProductionParserLimits({ maxFileBytes: -1 }),
      () => validateProductionParserLimits({ maxWarnings: 1.5 }),
      () => validateProductionParserLimits({ maxExtendsDepth: Number.NaN }),
    ];

    for (const call of invalidCases) {
      expect(call).toThrow(ParserIntegrationError);
      try {
        call();
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ParserIntegrationError);
        if (err instanceof ParserIntegrationError) {
          expect(err.persistedCode).toBe('PARSER_MISCONFIGURED');
          expect(err.startupFailure).toBe(true);
          expect(err.retryable).toBe(false);
        }
      }
    }
  });

  it('passes exact production config, explicit skipLoadingLibFiles=true, inventories, lower limits, and AbortSignal while logging safe scalars only', async () => {
    let capturedRunnerOptions: ParserRunnerOptions | undefined;
    const capturedRunInputs: ParserRunInput[] = [];
    const logs: ProductionParserLogEvent[] = [];

    const adapter = createProductionParserAdapter({
      limits: { maxSupportedFiles: 75, maxTotalBytes: 8 * 1024 * 1024 },
      logger: (event) => {
        logs.push(event);
        throw new Error(
          `Logger intentionally throws to test logging resilience: ${JSON.stringify(event)}`,
        );
      },
      runnerFactory: (opts) => {
        capturedRunnerOptions = opts;
        const fakeRunner: ParserRunner = {
          run: (input) => {
            capturedRunInputs.push(input);
            const result: ParserRunResult = {
              requestId: '11111111-2222-4333-8444-555555555555',
              output: makeSampleOutput(),
              metrics: makeSampleMetrics(),
            };
            return Promise.resolve(result);
          },
          getState: () => 'IDLE',
          isFatal: () => false,
          hasActiveChild: () => false,
        };
        return fakeRunner;
      },
    });

    expect(capturedRunnerOptions?.skipLoadingLibFiles).toBe(true);
    expect(capturedRunnerOptions?.parserTimeoutMs).toBe(60_000);
    expect(capturedRunnerOptions?.maxOldSpaceSizeMb).toBe(256);
    expect(capturedRunnerOptions?.maxResponseBytes).toBe(33_554_432);
    expect(capturedRunnerOptions?.terminateGraceMs).toBe(2_000);
    expect(capturedRunnerOptions?.killConfirmationMs).toBe(3_000);

    const abortCtrl = new AbortController();
    const res = await adapter.parseWorkspace(
      {
        rootDir: SENSITIVE_PATH_SENTINEL,
        supportedFiles: ['src/entry.ts'],
        configFiles: ['tsconfig.json'],
      },
      { signal: abortCtrl.signal },
    );

    expect(capturedRunInputs).toHaveLength(1);
    const runInput = capturedRunInputs[0];
    expect(runInput?.rootDir).toBe(SENSITIVE_PATH_SENTINEL);
    expect(runInput?.supportedFiles).toEqual(['src/entry.ts']);
    expect(runInput?.configFiles).toEqual(['tsconfig.json']);
    expect(runInput?.maxSupportedFiles).toBe(75);
    expect(runInput?.maxTotalBytes).toBe(8 * 1024 * 1024);
    expect(runInput?.skipLoadingLibFiles).toBe(true);
    expect(runInput?.signal).toBe(abortCtrl.signal);

    // Validated result returned cleanly and handoff contract accepts it
    expect(res.summary.parsedFilesCount).toBe(1);
    expect(res.summary.warningsCount).toBe(1);
    expect(res.summary.skipLoadingLibFiles).toBe(true);
    await expect(
      noopAnalysisResultHandoff({
        repositoryId: 'repo-1',
        jobId: 'job-1',
        commitSha: 'a'.repeat(40),
        result: res,
        signal: abortCtrl.signal,
      }),
    ).resolves.toBeUndefined();

    // Logs contain safe scalar counts & timings ONLY — never source snippets or workspace paths
    expect(logs).toHaveLength(1);
    expect(logs[0]?.type).toBe('analysis_completed');
    const serializedLog = JSON.stringify(logs);
    expect(serializedLog).not.toContain(SENSITIVE_SNIPPET_SENTINEL);
    expect(serializedLog).not.toContain(SENSITIVE_PATH_SENTINEL);
  });

  it(
    'executes real compiled parser-child with explicit skipLoadingLibFiles=true and passes startup preflight',
    async () => {
      const verifiedEntry = await preflightProductionParserEntrypoint();
      expect(verifiedEntry.toLowerCase().endsWith('parser-child.js')).toBe(true);

      const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-d1-real-'));
      tempDirs.push(dir);
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(
        path.join(dir, 'src', 'service.ts'),
        [
          'export class RepoService {',
          '  fetch(): number { return 1; }',
          '}',
          'export function getSync(): RepoService {',
          '  return new RepoService();',
          '}',
          'export async function getAsync(): Promise<RepoService> {',
          '  return new RepoService();',
          '}',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(dir, 'src', 'entry.ts'),
        [
          "import { RepoService, getAsync, getSync } from './service';",
          'export async function run(list: Array<RepoService>): Promise<number> {',
          '  const direct = getSync().fetch();',
          '  const awaited = (await getAsync()).fetch();',
          '  const mapped = list.map((item) => item.fetch());',
          '  return direct + awaited + mapped.length;',
          '}',
        ].join('\n'),
        'utf8',
      );

      const logs: ProductionParserLogEvent[] = [];
      const adapter = createProductionParserAdapter({
        logger: (e) => {
          logs.push(e);
        },
      });

      const result = await adapter.parseWorkspace({
        rootDir: dir,
        supportedFiles: ['src/service.ts', 'src/entry.ts'],
        configFiles: [],
      });

      // Confirms skipLoadingLibFiles=true is actually active (5 CALLS vs 7 when bundled libs enabled)
      expect(result.output.stats.importsEdgeCount).toBe(1);
      expect(result.output.stats.callsEdgeCount).toBe(5);
      expect(result.summary.skipLoadingLibFiles).toBe(true);
      expect(adapter.getState()).toBe('IDLE');
      expect(adapter.isFatal()).toBe(false);
      expect(adapter.hasActiveChild()).toBe(false);
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain(dir);
    },
    REAL_CHILD_TIMEOUT_MS,
  );

  it('exhaustively classifies all 19 ParserRunnerError codes preserving retryable/fatal/startupFailure flags without leaking raw messages or causes', () => {
    const retryableCodes = new Set<ParserRunnerErrorCode>([
      'SPAWN_FAILED',
      'IPC_SEND_FAILED',
      'UNEXPECTED_CHILD_EXIT',
      'PARSER_CANCELLED',
    ]);
    const startupCodes = new Set<ParserRunnerErrorCode>([
      'INVALID_RUNNER_CONFIG',
      'MISSING_ENTRYPOINT',
    ]);
    const fatalCodes = new Set<ParserRunnerErrorCode>([
      'FATAL_TERMINATION_UNCONFIRMED',
      'FATAL_CLEANUP_UNCONFIRMED',
    ]);

    expect(PARSER_RUNNER_ERROR_CODES).toHaveLength(19);

    for (const code of PARSER_RUNNER_ERROR_CODES) {
      const runnerErr = new ParserRunnerError({
        code,
        message: `Raw message with ${SENSITIVE_PATH_SENTINEL}`,
        retryable: retryableCodes.has(code),
        fatal: fatalCodes.has(code),
        startupFailure: startupCodes.has(code),
        ...(code === 'CORE_ANALYSIS_ERROR' ? { coreErrorCode: 'FILE_LIMIT_EXCEEDED' } : {}),
        requestId: '11111111-2222-4333-8444-555555555555',
        exitCode: 1,
        signal: null,
        cause: new Error(`Sensitive cause ${SENSITIVE_CAUSE_SENTINEL}`),
      });

      const classified = classifyParserRunnerError(runnerErr);
      expect(classified.runnerCode).toBe(code);
      expect(classified.retryable).toBe(runnerErr.retryable);
      expect(classified.fatal).toBe(runnerErr.fatal);
      expect(classified.startupFailure).toBe(runnerErr.startupFailure);
      expect(classified.persistedCode.length).toBeLessThanOrEqual(32);

      if (code === 'PARSER_CANCELLED') {
        expect(classified.disposition).toBe('cancelled');
      } else if (fatalCodes.has(code)) {
        expect(classified.disposition).toBe('fatal');
      } else if (startupCodes.has(code)) {
        expect(classified.disposition).toBe('startup_failure');
      } else if (retryableCodes.has(code)) {
        expect(classified.disposition).toBe('retryable');
      } else {
        expect(classified.disposition).toBe('non_retryable');
      }

      const integrationErr = new ParserIntegrationError(classified);
      const serialized = JSON.stringify({
        message: integrationErr.message,
        log: integrationErr.toSafeLogObject(),
      });
      expect(serialized).not.toContain(SENSITIVE_PATH_SENTINEL);
      expect(serialized).not.toContain(SENSITIVE_CAUSE_SENTINEL);
    }
  });

  it('exhaustively classifies all 4 CoreAnalysisErrorCode values and the missing-code fallback', () => {
    const expectedMap: Readonly<Record<CoreAnalysisErrorCode, string>> = {
      INVALID_WORKSPACE: 'PARSER_INVALID_WORKSPACE',
      PATH_TRAVERSAL_REJECTED: 'PARSER_PATH_TRAVERSAL',
      FILE_LIMIT_EXCEEDED: 'PARSER_FILE_LIMIT_EXCEEDED',
      SIZE_LIMIT_EXCEEDED: 'PARSER_SIZE_LIMIT_EXCEEDED',
    };

    expect(CORE_ANALYSIS_ERROR_CODES).toHaveLength(4);
    for (const coreCode of CORE_ANALYSIS_ERROR_CODES) {
      const err = new ParserRunnerError({
        code: 'CORE_ANALYSIS_ERROR',
        coreErrorCode: coreCode,
        message: `Raw ${SENSITIVE_PATH_SENTINEL}`,
        retryable: false,
      });
      const classified = classifyParserRunnerError(err);
      expect(classified.persistedCode).toBe(expectedMap[coreCode]);
      expect(classified.coreErrorCode).toBe(coreCode);
      expect(classified.disposition).toBe('non_retryable');
      expect(classified.retryable).toBe(false);
      expect(classified.safeMessage).not.toContain(SENSITIVE_PATH_SENTINEL);
    }

    // Fallback when coreErrorCode is omitted
    const fallback = classifyParserRunnerError(
      new ParserRunnerError({
        code: 'CORE_ANALYSIS_ERROR',
        message: `Raw ${SENSITIVE_PATH_SENTINEL}`,
        retryable: false,
      }),
    );
    expect(fallback.persistedCode).toBe('PARSER_ANALYSIS_REJECTED');
    expect(fallback.coreErrorCode).toBeNull();
  });

  it('sanitizes transient retryable, timeout, OOM, cancellation, and unexpected non-runner exceptions on both throw and log paths', async () => {
    const scenarios: readonly {
      readonly thrown: Error;
      readonly expectedCode: string;
      readonly expectedDisposition: string;
      readonly expectedRetryable: boolean;
    }[] = [
      {
        thrown: new ParserRunnerError({
          code: 'UNEXPECTED_CHILD_EXIT',
          message: `Crash ${SENSITIVE_CAUSE_SENTINEL}`,
          retryable: true,
          cause: new Error(SENSITIVE_PATH_SENTINEL),
        }),
        expectedCode: 'PARSER_CHILD_CRASHED',
        expectedDisposition: 'retryable',
        expectedRetryable: true,
      },
      {
        thrown: new ParserRunnerError({
          code: 'PARSER_TIMEOUT',
          message: `Timeout ${SENSITIVE_PATH_SENTINEL}`,
          retryable: false,
        }),
        expectedCode: 'PARSER_TIMEOUT',
        expectedDisposition: 'non_retryable',
        expectedRetryable: false,
      },
      {
        thrown: new ParserRunnerError({
          code: 'CONFIRMED_HEAP_EXHAUSTION',
          message: `OOM ${SENSITIVE_CAUSE_SENTINEL}`,
          retryable: false,
        }),
        expectedCode: 'PARSER_HEAP_EXHAUSTED',
        expectedDisposition: 'non_retryable',
        expectedRetryable: false,
      },
      {
        thrown: new ParserRunnerError({
          code: 'PARSER_CANCELLED',
          message: `Cancelled ${SENSITIVE_PATH_SENTINEL}`,
          retryable: true,
        }),
        expectedCode: 'PARSER_CANCELLED',
        expectedDisposition: 'cancelled',
        expectedRetryable: true,
      },
      {
        thrown: new Error(`Unexpected raw error ${SENSITIVE_CAUSE_SENTINEL}`),
        expectedCode: 'PARSER_INTERNAL_ERROR',
        expectedDisposition: 'non_retryable',
        expectedRetryable: false,
      },
    ];

    for (const sc of scenarios) {
      const logs: ProductionParserLogEvent[] = [];
      const adapter = createProductionParserAdapter({
        logger: (e) => {
          logs.push(e);
          throw new Error(
            `Logger intentionally throws to test logging resilience: ${JSON.stringify(e)}`,
          );
        },
        runnerFactory: () => ({
          run: () => Promise.reject(sc.thrown),
          getState: () => 'IDLE',
          isFatal: () => false,
          hasActiveChild: () => false,
        }),
      });

      await expect(
        adapter.parseWorkspace({
          rootDir: path.resolve('tmp-ws'),
          supportedFiles: [],
          configFiles: [],
        }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ParserIntegrationError &&
          err.persistedCode === sc.expectedCode &&
          err.disposition === sc.expectedDisposition &&
          err.retryable === sc.expectedRetryable &&
          !err.message.includes(SENSITIVE_CAUSE_SENTINEL) &&
          !err.message.includes(SENSITIVE_PATH_SENTINEL),
      );

      expect(logs).toHaveLength(1);
      expect(logs[0]?.type).toBe('analysis_failed');
      const logJson = JSON.stringify(logs);
      expect(logJson).not.toContain(SENSITIVE_CAUSE_SENTINEL);
      expect(logJson).not.toContain(SENSITIVE_PATH_SENTINEL);
    }
  });

  it('forwards sanitized fatal supervision notification synchronously without artificially settling a pending fatal parser promise', async () => {
    let triggerRunnerFatal: ((event: ParserRunnerFatalEvent) => void) | undefined;
    let runnerState: ParserRunnerState = 'RUNNING';
    let fatalLatched = false;
    let settled = false;
    let rejectPendingRun: ((err: Error) => void) | undefined;

    const fatalNotifications: SafeParserFatalNotification[] = [];
    const logs: ProductionParserLogEvent[] = [];

    const adapter = createProductionParserAdapter({
      logger: (e) => {
        logs.push(e);
        throw new Error(
          `Logger intentionally throws to test logging resilience: ${JSON.stringify(e)}`,
        );
      },
      onFatalState: (notification) => {
        fatalNotifications.push(notification);
      },
      runnerFactory: (opts) => {
        triggerRunnerFatal = opts.onFatalState;
        return {
          run: () => {
            if (fatalLatched) {
              return Promise.reject(
                new ParserRunnerError({
                  code: 'FATAL_TERMINATION_UNCONFIRMED',
                  message: `Raw fatal ${SENSITIVE_PATH_SENTINEL}`,
                  retryable: false,
                  fatal: true,
                }),
              );
            }
            return new Promise<ParserRunResult>((_resolve, reject) => {
              rejectPendingRun = reject;
            });
          },
          getState: () => runnerState,
          isFatal: () => fatalLatched,
          hasActiveChild: () => true,
        };
      },
    });

    const activePromise = adapter.parseWorkspace({
      rootDir: path.resolve('tmp-ws'),
      supportedFiles: [],
      configFiles: [],
    });
    void activePromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Runner latches FATAL_TERMINATION_UNCONFIRMED while promise remains intentionally pending
    fatalLatched = true;
    runnerState = 'FATAL_TERMINATION_UNCONFIRMED';
    triggerRunnerFatal?.({
      error: new ParserRunnerError({
        code: 'FATAL_TERMINATION_UNCONFIRMED',
        message: `Raw fatal ${SENSITIVE_PATH_SENTINEL}`,
        retryable: false,
        fatal: true,
        requestId: '11111111-2222-4333-8444-555555555555',
      }),
      requestId: '11111111-2222-4333-8444-555555555555',
      pid: 42_001,
      processExited: false,
    });

    await new Promise((r) => setTimeout(r, 30));

    // Pending promise MUST NOT be artificially settled (protects workspace lease!)
    expect(settled).toBe(false);
    expect(adapter.isFatal()).toBe(true);
    expect(adapter.getState()).toBe('FATAL_TERMINATION_UNCONFIRMED');
    expect(fatalNotifications).toHaveLength(1);
    expect(fatalNotifications[0]?.persistedCode).toBe('PARSER_FATAL_TERMINATION');
    expect(fatalNotifications[0]?.pid).toBe(42_001);
    expect(JSON.stringify(fatalNotifications)).not.toContain(SENSITIVE_PATH_SENTINEL);
    expect(logs[0]?.type).toBe('parser_fatal_state');

    // Subsequent call on fatally latched runner rejects immediately with sanitized fatal error
    await expect(
      adapter.parseWorkspace({
        rootDir: path.resolve('tmp-ws'),
        supportedFiles: [],
        configFiles: [],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserIntegrationError &&
        err.persistedCode === 'PARSER_FATAL_TERMINATION' &&
        err.fatal &&
        !err.retryable,
    );

    // Deferred OS close eventually rejects the original pending run cleanly
    rejectPendingRun?.(
      new ParserRunnerError({
        code: 'FATAL_TERMINATION_UNCONFIRMED',
        message: 'Deferred close',
        retryable: false,
        fatal: true,
      }),
    );
    await expect(activePromise).rejects.toBeInstanceOf(ParserIntegrationError);
  });

  it('wraps startup runner-factory failures in ParserIntegrationError without leaking raw messages', () => {
    expect(() =>
      createProductionParserAdapter({
        runnerFactory: () => {
          throw new ParserRunnerError({
            code: 'INVALID_RUNNER_CONFIG',
            message: `Bad config ${SENSITIVE_CAUSE_SENTINEL}`,
            retryable: false,
            startupFailure: true,
          });
        },
      }),
    ).toThrow(ParserIntegrationError);

    try {
      createProductionParserAdapter({
        runnerFactory: () => {
          throw new ParserRunnerError({
            code: 'INVALID_RUNNER_CONFIG',
            message: `Bad config ${SENSITIVE_CAUSE_SENTINEL}`,
            retryable: false,
            startupFailure: true,
          });
        },
      });
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ParserIntegrationError);
      if (err instanceof ParserIntegrationError) {
        expect(err.persistedCode).toBe('PARSER_MISCONFIGURED');
        expect(err.startupFailure).toBe(true);
        expect(err.message).not.toContain(SENSITIVE_CAUSE_SENTINEL);
      }
    }
  });

  it('reuses validateCompiledParserEntrypoint to reject missing compiled child entrypoints as startup failure', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'archon-d1-missing-entry-'));
    tempDirs.push(emptyDir);

    await expect(
      validateCompiledParserEntrypoint(path.join(emptyDir, 'parser-child.js'), emptyDir),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserRunnerError &&
        err.code === 'MISSING_ENTRYPOINT' &&
        err.startupFailure &&
        !err.retryable,
    );
  });
});
