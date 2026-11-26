import type {
  IngestionJobRecord,
  IngestionRepository,
  RepositoryRecord,
  RepositoryStatus,
  TouchHeartbeatResult,
  TransitionJobStageInput,
  TransitionJobStageResult,
} from '@archon/db';
import type { AnalysisOutput } from '@archon/shared';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { TarballExtractionError } from './extractor/errors.js';
import type { ExtractedRepoWorkspace } from './extractor/github-tarball.js';
import {
  ParserIntegrationError,
  classifyParserRunnerError,
  type AnalysisResultHandoffContext,
  type ValidatedAnalysisResult,
} from './parser-integration.js';
import { ParserRunnerError } from './parser-runner.js';
import {
  IngestionCancelledError,
  STAGE_PROGRESS,
  classifyIngestionError,
  createIngestionJobProcessor,
  isFinalJobAttempt,
  type ExtractRepoFn,
  type IngestionParserAdapter,
  type IngestionProcessorJob,
} from './processor.js';
import { createWorkerServiceLifecycle } from './lifecycle.js';

const SAMPLE_JOB_DATA = {
  repoId: '00000000-0000-4000-8000-000000000001',
  jobId: '00000000-0000-4000-8000-000000000002',
  owner: 'pmndrs',
  name: 'zustand',
  commitSha: '9fed2eb2f3af672da9f7bf694b996df3831fc207',
} as const;

const SAMPLE_WORKSPACE: ExtractedRepoWorkspace = {
  rootDir: '/tmp/fake-workspace',
  topLevelPrefix: 'pmndrs-zustand-9fed2eb',
  supportedFiles: ['src/index.ts', 'src/react.ts'],
  configFiles: ['package.json', 'tsconfig.json'],
  stats: {
    compressedBytes: 1200,
    decompressedBytes: 4096,
    writtenBytes: 2048,
    supportedFilesCount: 2,
    configFilesCount: 2,
    skippedFilesCount: 3,
    oversizedSkippedFilesCount: 0,
  },
};

function makeFakeValidatedResult(): ValidatedAnalysisResult {
  const output: AnalysisOutput = {
    nodes: [],
    edges: [],
    warnings: [],
    stats: {
      discoveredFilesCount: 2,
      parsedFilesCount: 2,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 2,
      folderNodeCount: 0,
      fileNodeCount: 0,
      functionNodeCount: 0,
      classNodeCount: 0,
      symbolNodeCount: 0,
      importsEdgeCount: 0,
      callsEdgeCount: 0,
      totalBytesRead: 2048,
      truncatedWarningsCount: 0,
    },
  };
  return {
    requestId: '11111111-2222-4333-8444-555555555555',
    output,
    metrics: {
      endToEndDurationMs: 50,
      childAnalysisDurationMs: 35,
      childPreSendMemory: {
        baselineHeapUsedBytes: 1_000,
        postHeapUsedBytes: 2_000,
        baselineRssBytes: 3_000,
        postRssBytes: 4_000,
        maxRssKiB: 5_000,
      },
      serializedResponseBytes: 512,
      parentValidationDurationMs: 1,
      parentMemory: {
        baselineHeapUsedBytes: 1_000,
        postHeapUsedBytes: 1_500,
        baselineRssBytes: 2_000,
        postRssBytes: 2_500,
      },
      exitCode: 0,
      signal: null,
    },
    summary: {
      requestId: '11111111-2222-4333-8444-555555555555',
      discoveredFilesCount: 2,
      parsedFilesCount: 2,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 2,
      folderNodeCount: 0,
      fileNodeCount: 0,
      functionNodeCount: 0,
      classNodeCount: 0,
      symbolNodeCount: 0,
      importsEdgeCount: 0,
      callsEdgeCount: 0,
      totalBytesRead: 2048,
      warningsCount: 0,
      truncatedWarningsCount: 0,
      childAnalysisDurationMs: 35,
      endToEndDurationMs: 50,
      parentValidationDurationMs: 1,
      serializedResponseBytes: 512,
      skipLoadingLibFiles: true,
    },
  };
}

function makeFakeParserAdapter(
  impl?: IngestionParserAdapter['parseWorkspace'],
  options: { readonly fatal?: boolean } = {},
): IngestionParserAdapter {
  return {
    parseWorkspace: impl ?? (() => Promise.resolve(makeFakeValidatedResult())),
    isFatal: () => options.fatal ?? false,
    getState: () => (options.fatal === true ? 'FATAL_TERMINATION_UNCONFIRMED' : 'IDLE'),
  };
}

function makeFakeRepoAndJob(status: RepositoryStatus): {
  repository: RepositoryRecord;
  job: IngestionJobRecord;
} {
  const now = new Date('2026-11-23T06:00:00.000Z');
  return {
    repository: {
      id: SAMPLE_JOB_DATA.repoId,
      githubUrl: 'https://github.com/pmndrs/zustand',
      owner: SAMPLE_JOB_DATA.owner,
      name: SAMPLE_JOB_DATA.name,
      defaultBranch: 'main',
      commitSha: SAMPLE_JOB_DATA.commitSha,
      status,
      embeddingStatus: 'pending',
      isSample: false,
      fileCount: 0,
      skippedFilesCount: 0,
      sizeKb: 100,
      errorCode: null,
      errorMessage: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    },
    job: {
      id: SAMPLE_JOB_DATA.jobId,
      repoId: SAMPLE_JOB_DATA.repoId,
      bullmqJobId: SAMPLE_JOB_DATA.jobId,
      stage: status,
      progressPct: 0,
      startedAt: now,
      finishedAt: null,
      durationMs: null,
      errorDetail: null,
      createdAt: now,
    },
  };
}

function makeFakeRepository(
  options: {
    readonly rejectAtStage?: RepositoryStatus;
    readonly onHeartbeat?: () => Promise<TouchHeartbeatResult>;
    readonly onTransition?: (input: TransitionJobStageInput) => void;
  } = {},
) {
  const transitions: TransitionJobStageInput[] = [];
  let heartbeatCount = 0;

  const repository: Pick<IngestionRepository, 'transitionJobStage' | 'touchJobHeartbeat'> = {
    transitionJobStage(input): Promise<TransitionJobStageResult> {
      transitions.push(input);
      options.onTransition?.(input);
      if (options.rejectAtStage === input.toStatus) {
        return Promise.resolve({ applied: false });
      }
      const pair = makeFakeRepoAndJob(input.toStatus);
      return Promise.resolve({
        applied: true,
        repository: pair.repository,
        job: pair.job,
      });
    },
    touchJobHeartbeat(_repoId, now): Promise<TouchHeartbeatResult> {
      heartbeatCount += 1;
      if (options.onHeartbeat) {
        return options.onHeartbeat();
      }
      return Promise.resolve({ updated: true, updatedAt: now ?? new Date() });
    },
  };

  return {
    repository,
    transitions,
    getHeartbeatCount: () => heartbeatCount,
  };
}

function makeFakeLogger() {
  const logs: { level: 'info' | 'warn' | 'error'; obj: unknown; msg: string }[] = [];
  const logger = {
    info(obj: unknown, msg?: string): void {
      logs.push({ level: 'info', obj, msg: msg ?? String(obj) });
    },
    warn(obj: unknown, msg?: string): void {
      logs.push({ level: 'warn', obj, msg: msg ?? String(obj) });
    },
    error(obj: unknown, msg?: string): void {
      logs.push({ level: 'error', obj, msg: msg ?? String(obj) });
    },
  };
  return { logger, logs };
}

function makeJob(overrides: Partial<IngestionProcessorJob> = {}): IngestionProcessorJob {
  return {
    id: SAMPLE_JOB_DATA.jobId,
    data: SAMPLE_JOB_DATA,
    attemptsMade: 0,
    opts: { attempts: 2 },
    ...overrides,
  };
}

function makeParserIntegrationError(
  code: ParserRunnerError['code'],
  opts: {
    readonly retryable: boolean;
    readonly fatal?: boolean;
    readonly startupFailure?: boolean;
    readonly coreErrorCode?:
      | 'FILE_LIMIT_EXCEEDED'
      | 'SIZE_LIMIT_EXCEEDED'
      | 'INVALID_WORKSPACE'
      | 'PATH_TRAVERSAL_REJECTED';
  },
): ParserIntegrationError {
  return new ParserIntegrationError(
    classifyParserRunnerError(
      new ParserRunnerError({
        code,
        message: 'RAW_INTERNAL_SENSITIVE_DETAIL',
        retryable: opts.retryable,
        fatal: opts.fatal,
        startupFailure: opts.startupFailure,
        coreErrorCode: opts.coreErrorCode,
        cause: new Error('RAW_CAUSE_SECRET_VALUE'),
      }),
    ),
  );
}

describe('isFinalJobAttempt and classifyIngestionError', () => {
  it('computes final attempt strictly from 0-indexed job.attemptsMade and job.opts.attempts', () => {
    expect(isFinalJobAttempt({ attemptsMade: 0, opts: { attempts: 2 } })).toBe(false);
    expect(isFinalJobAttempt({ attemptsMade: 1, opts: { attempts: 2 } })).toBe(true);
    expect(isFinalJobAttempt({ attemptsMade: 0, opts: { attempts: 1 } })).toBe(true);
    expect(isFinalJobAttempt({ attemptsMade: 0, opts: {} })).toBe(true);
  });

  it('classifies non-retryable vs retryable extraction, parser, cancellation, and generic errors safely', () => {
    const nonRetryable = [
      new TarballExtractionError({ code: 'TARBALL_SECURITY_VIOLATION', message: 'symlink' }),
      new TarballExtractionError({ code: 'TARBALL_SIZE_LIMIT_EXCEEDED', message: 'too big' }),
      new TarballExtractionError({ code: 'TARBALL_FILE_LIMIT_EXCEEDED', message: 'too many' }),
      new TarballExtractionError({ code: 'TARBALL_REDIRECT_REJECTED', message: 'bad host' }),
      new TarballExtractionError({
        code: 'TARBALL_PARSE_ERROR',
        retryable: false,
        message: 'corrupt header',
      }),
      makeParserIntegrationError('CORE_ANALYSIS_ERROR', {
        retryable: false,
        coreErrorCode: 'FILE_LIMIT_EXCEEDED',
      }),
      makeParserIntegrationError('PARSER_TIMEOUT', { retryable: false }),
      makeParserIntegrationError('CONFIRMED_HEAP_EXHAUSTION', { retryable: false }),
      makeParserIntegrationError('RESPONSE_TOO_LARGE', { retryable: false }),
      makeParserIntegrationError('INVALID_RESPONSE', { retryable: false }),
      makeParserIntegrationError('CHILD_INTERNAL_ERROR', { retryable: false }),
    ];

    for (const err of nonRetryable) {
      expect(classifyIngestionError(err).retryable).toBe(false);
    }

    const retryable = [
      new TarballExtractionError({ code: 'TARBALL_TIMEOUT', message: 'timed out' }),
      new TarballExtractionError({
        code: 'TARBALL_CANCELLED',
        message: 'cancelled',
        retryable: true,
      }),
      new TarballExtractionError({ code: 'TARBALL_RATE_LIMITED', message: 'rate limit' }),
      new TarballExtractionError({ code: 'TARBALL_UPSTREAM_ERROR', message: '502' }),
      new TarballExtractionError({
        code: 'TARBALL_PARSE_ERROR',
        retryable: true,
        message: 'truncated stream',
      }),
      makeParserIntegrationError('SPAWN_FAILED', { retryable: true }),
      makeParserIntegrationError('IPC_SEND_FAILED', { retryable: true }),
      makeParserIntegrationError('UNEXPECTED_CHILD_EXIT', { retryable: true }),
      makeParserIntegrationError('PARSER_CANCELLED', { retryable: true }),
      new IngestionCancelledError(),
      new Error('unexpected runtime failure'),
    ];

    for (const err of retryable) {
      expect(classifyIngestionError(err).retryable).toBe(true);
    }

    const generic = classifyIngestionError(new Error('SECRET_SNIPPET_IN_EXCEPTION'));
    expect(generic.errorCode).toBe('WORKER_ERROR');
    expect(generic.errorDetail).toBe('WORKER_ERROR');
    expect(generic.errorMessage).not.toContain('SECRET_SNIPPET');
  });
});

describe('createIngestionJobProcessor', () => {
  it('executes cloning -> parsing -> parserAdapter -> building_graph -> handoff -> ready with exact inventory and AbortSignal propagation', async () => {
    const order: string[] = [];
    const { repository, transitions } = makeFakeRepository({
      onTransition: (t) => {
        order.push(`db:${t.toStatus}`);
      },
    });
    const { logger } = makeFakeLogger();
    const shutdownCtrl = new AbortController();

    const capturedExtractSignals: (AbortSignal | undefined)[] = [];
    const capturedParserInputs: {
      rootDir: string;
      supportedFiles: readonly string[];
      configFiles: readonly string[];
      signal: AbortSignal | undefined;
    }[] = [];
    const capturedHandoffs: AnalysisResultHandoffContext[] = [];

    const fakeExtract: ExtractRepoFn = async (opts, callback) => {
      capturedExtractSignals.push(opts.signal);
      order.push('extract');
      return callback(SAMPLE_WORKSPACE);
    };

    const parserAdapter = makeFakeParserAdapter((workspace, opts) => {
      order.push('parse');
      capturedParserInputs.push({
        rootDir: workspace.rootDir,
        supportedFiles: workspace.supportedFiles,
        configFiles: workspace.configFiles,
        signal: opts?.signal,
      });
      return Promise.resolve(makeFakeValidatedResult());
    });

    const processJob = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: fakeExtract,
      parserAdapter,
      shutdownSignal: shutdownCtrl.signal,
      analysisResultHandoff: (ctx) => {
        order.push('handoff');
        capturedHandoffs.push(ctx);
        return Promise.resolve();
      },
    });

    await processJob(makeJob());

    expect(order).toEqual([
      'db:cloning',
      'extract',
      'db:parsing',
      'parse',
      'db:building_graph',
      'handoff',
      'db:ready',
    ]);
    expect(transitions.map((t) => [t.toStatus, t.progressPct])).toEqual([
      ['cloning', STAGE_PROGRESS.cloning],
      ['parsing', STAGE_PROGRESS.parsing],
      ['building_graph', STAGE_PROGRESS.buildingGraph],
      ['ready', STAGE_PROGRESS.ready],
    ]);
    expect(transitions[1]?.fileCount).toBe(2);
    expect(transitions[1]?.skippedFilesCount).toBe(3);
    expect(capturedExtractSignals).toEqual([shutdownCtrl.signal]);
    expect(capturedParserInputs).toEqual([
      {
        rootDir: SAMPLE_WORKSPACE.rootDir,
        supportedFiles: SAMPLE_WORKSPACE.supportedFiles,
        configFiles: SAMPLE_WORKSPACE.configFiles,
        signal: shutdownCtrl.signal,
      },
    ]);
    expect(capturedHandoffs).toHaveLength(1);
    expect(capturedHandoffs[0]?.repositoryId).toBe(SAMPLE_JOB_DATA.repoId);
    expect(capturedHandoffs[0]?.signal).toBe(shutdownCtrl.signal);
  });

  it('starts heartbeat during processing, drains outstanding heartbeat operation before returning, and logs heartbeat failures safely', async () => {
    const heartbeatsState = { calls: 0 };
    let resolveSlowHeartbeat: (() => void) | undefined;
    let heartbeatFinished = false;

    const { repository } = makeFakeRepository({
      onHeartbeat: () => {
        heartbeatsState.calls += 1;
        if (heartbeatsState.calls === 1) {
          return Promise.reject(new Error('temporary DB hiccup'));
        }
        return new Promise<TouchHeartbeatResult>((resolve) => {
          resolveSlowHeartbeat = () => {
            heartbeatFinished = true;
            resolve({ updated: true, updatedAt: new Date() });
          };
        });
      },
    });
    const { logger, logs } = makeFakeLogger();
    let releaseParse: (() => void) | undefined;

    const processJob = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 10,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(
        () =>
          new Promise<ValidatedAnalysisResult>((resolve) => {
            releaseParse = () => {
              resolve(makeFakeValidatedResult());
            };
          }),
      ),
    });

    let jobSettled = false;
    const jobPromise = processJob(makeJob()).then(() => {
      jobSettled = true;
    });

    // Wait until heartbeat #2 is in-flight
    while (resolveSlowHeartbeat === undefined || releaseParse === undefined) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Complete parsing while heartbeat #2 is still in-flight -> processor MUST wait for heartbeat drain
    releaseParse();
    await new Promise((r) => setTimeout(r, 25));
    expect(heartbeatFinished).toBe(false);
    expect(jobSettled).toBe(false);

    // Resolve in-flight heartbeat -> processor finishes cleanly and schedules no more ticks
    resolveSlowHeartbeat();
    await jobPromise;
    expect(jobSettled).toBe(true);
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('heartbeat'))).toBe(true);

    const countAtEnd = heartbeatsState.calls;
    await new Promise((r) => setTimeout(r, 35));
    expect(heartbeatsState.calls).toBe(countAtEnd);
  });

  it('stops scheduling new heartbeats synchronously on fatalSignal without settling a pending fatal parser promise', async () => {
    const fatalCtrl = new AbortController();
    let heartbeatCalls = 0;
    const { repository } = makeFakeRepository({
      onHeartbeat: () => {
        heartbeatCalls += 1;
        return Promise.resolve({ updated: true, updatedAt: new Date() });
      },
    });
    const { logger } = makeFakeLogger();
    let rejectLateParse: ((err: Error) => void) | undefined;

    const processJob = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 10,
      fatalSignal: fatalCtrl.signal,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(
        () =>
          new Promise<ValidatedAnalysisResult>((_resolve, reject) => {
            rejectLateParse = reject;
          }),
      ),
    });

    let jobSettled = false;
    const jobPromise = processJob(makeJob()).then(
      () => {
        jobSettled = true;
      },
      () => {
        jobSettled = true;
      },
    );

    while (heartbeatCalls < 1 || rejectLateParse === undefined) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Fatal signal fires while parser promise remains indefinitely pending
    fatalCtrl.abort();
    const countAfterFatal = heartbeatCalls;
    await new Promise((r) => setTimeout(r, 45));

    // Heartbeat scheduling stopped immediately AND pending parser promise did NOT settle prematurely
    expect(heartbeatCalls).toBe(countAfterFatal);
    expect(jobSettled).toBe(false);

    // Clean up test promise via deferred rejection
    rejectLateParse(
      makeParserIntegrationError('FATAL_TERMINATION_UNCONFIRMED', {
        retryable: false,
        fatal: true,
      }),
    );
    await jobPromise;
  });

  it('marks Postgres failed immediately and throws UnrecoverableError on non-retryable extraction errors (preserving cause)', async () => {
    const { repository, transitions } = makeFakeRepository();
    const { logger } = makeFakeLogger();
    const securityErr = new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: 'Symlink rejected',
    });

    const processJob = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: () => Promise.reject(securityErr),
      parserAdapter: makeFakeParserAdapter(),
    });

    let caught: unknown;
    try {
      await processJob(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnrecoverableError);
    if (caught instanceof Error) {
      expect(caught.cause).toBe(securityErr);
    }

    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition?.toStatus).toBe('failed');
    expect(lastTransition?.errorCode).toBe('TARBALL_SECURITY_VIOLATION');
  });

  it('marks Postgres failed immediately and throws sanitized UnrecoverableError without raw cause on deterministic parser errors', async () => {
    const { repository, transitions } = makeFakeRepository();
    const { logger, logs } = makeFakeLogger();
    const parserErr = makeParserIntegrationError('CORE_ANALYSIS_ERROR', {
      retryable: false,
      coreErrorCode: 'FILE_LIMIT_EXCEEDED',
    });

    const processJob = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(() => Promise.reject(parserErr)),
    });

    let caught: unknown;
    try {
      await processJob(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnrecoverableError);
    if (caught instanceof Error) {
      expect(caught.cause).toBeUndefined();
      expect(caught.message).toBe('Repository exceeds maximum allowed file count.');
      expect(caught.message).not.toContain('RAW_INTERNAL');
    }

    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition?.toStatus).toBe('failed');
    expect(lastTransition?.errorCode).toBe('PARSER_FILE_LIMIT_EXCEEDED');
    expect(lastTransition?.errorDetail).toBe('FILE_LIMIT_EXCEEDED');
    expect(JSON.stringify(logs)).not.toContain('RAW_INTERNAL');
    expect(JSON.stringify(logs)).not.toContain('RAW_CAUSE');
  });

  it('leaves Postgres non-terminal on retryable attempt 1 of 2, and marks failed on final attempt 2 of 2 (extraction & parser)', async () => {
    const retryableErr = new TarballExtractionError({
      code: 'TARBALL_PARSE_ERROR',
      retryable: true,
      message: 'Truncated gzip stream',
    });

    const firstRun = makeFakeRepository();
    const firstLogger = makeFakeLogger();
    const processFirst = createIngestionJobProcessor({
      repository: firstRun.repository,
      logger: firstLogger.logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: () => Promise.reject(retryableErr),
      parserAdapter: makeFakeParserAdapter(),
    });

    await expect(processFirst(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }))).rejects.toBe(
      retryableErr,
    );
    expect(firstRun.transitions.map((t) => t.toStatus)).toEqual(['cloning']);

    const finalRun = makeFakeRepository();
    const finalLogger = makeFakeLogger();
    const processFinal = createIngestionJobProcessor({
      repository: finalRun.repository,
      logger: finalLogger.logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: () => Promise.reject(retryableErr),
      parserAdapter: makeFakeParserAdapter(),
    });

    await expect(processFinal(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).rejects.toBe(
      retryableErr,
    );
    expect(finalRun.transitions.map((t) => t.toStatus)).toEqual(['cloning', 'failed']);
    expect(finalRun.transitions[1]?.errorCode).toBe('TARBALL_PARSE_ERROR');

    // Retryable parser crash on non-final vs final attempt (sanitized outward BullMQ error)
    const parserCrash = makeParserIntegrationError('UNEXPECTED_CHILD_EXIT', { retryable: true });
    const pNonFinalRepo = makeFakeRepository();
    const pNonFinal = createIngestionJobProcessor({
      repository: pNonFinalRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(() => Promise.reject(parserCrash)),
    });
    await expect(pNonFinal(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParserIntegrationError &&
        err.persistedCode === 'PARSER_CHILD_CRASHED' &&
        err.cause === undefined,
    );
    expect(pNonFinalRepo.transitions.map((t) => t.toStatus)).toEqual(['cloning', 'parsing']);

    const pFinalRepo = makeFakeRepository();
    const pFinal = createIngestionJobProcessor({
      repository: pFinalRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(() => Promise.reject(parserCrash)),
    });
    await expect(pFinal(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).rejects.toBe(
      parserCrash,
    );
    expect(pFinalRepo.transitions.map((t) => t.toStatus)).toEqual(['cloning', 'parsing', 'failed']);
    expect(pFinalRepo.transitions[2]?.errorCode).toBe('PARSER_CHILD_CRASHED');
  });

  it('stops early without downloading or running parser/handoff when conditional transitions return applied: false', async () => {
    // 1. Rejected at cloning
    const cloningRepo = makeFakeRepository({ rejectAtStage: 'cloning' });
    const extractState = { called: false };
    const processCloning = createIngestionJobProcessor({
      repository: cloningRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => {
        extractState.called = true;
        return callback(SAMPLE_WORKSPACE);
      },
      parserAdapter: makeFakeParserAdapter(),
    });
    await processCloning(makeJob());
    expect(cloningRepo.transitions.map((t) => t.toStatus)).toEqual(['cloning']);
    expect(extractState.called).toBe(false);

    // 2. Rejected at parsing -> parser never invoked
    const parsingRepo = makeFakeRepository({ rejectAtStage: 'parsing' });
    let parseCalled = false;
    const processParsing = createIngestionJobProcessor({
      repository: parsingRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(() => {
        parseCalled = true;
        return Promise.resolve(makeFakeValidatedResult());
      }),
    });
    await processParsing(makeJob());
    expect(parseCalled).toBe(false);

    // 3. Rejected at building_graph -> handoff and ready NEVER invoked
    const graphRepo = makeFakeRepository({ rejectAtStage: 'building_graph' });
    let handoffCalled = false;
    const processGraph = createIngestionJobProcessor({
      repository: graphRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
      analysisResultHandoff: () => {
        handoffCalled = true;
        return Promise.resolve();
      },
    });
    await processGraph(makeJob());
    expect(handoffCalled).toBe(false);
    expect(graphRepo.transitions.map((t) => t.toStatus)).toEqual([
      'cloning',
      'parsing',
      'building_graph',
    ]);
  });

  it('never commits ready and sanitizes outward BullMQ/DB/log errors when analysisResultHandoff fails with sensitive text', async () => {
    const { repository, transitions } = makeFakeRepository();
    const { logger, logs } = makeFakeLogger();
    const secretSnippet = 'SECRET_SOURCE_SNIPPET_IN_HANDOFF_ERR';

    const processJob = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
      analysisResultHandoff: () =>
        Promise.reject(new Error(`DB insert failed near ${secretSnippet}`)),
    });

    await expect(processJob(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'An unexpected error occurred during repository ingestion.' &&
        !err.message.includes(secretSnippet),
    );

    expect(transitions.map((t) => t.toStatus)).toEqual([
      'cloning',
      'parsing',
      'building_graph',
      'failed',
    ]);
    expect(JSON.stringify(transitions)).not.toContain(secretSnippet);
    expect(JSON.stringify(logs)).not.toContain(secretSnippet);
  });

  it('handles cancellation before parsing, during parsing, and after parsing before ready dispatch without marking ready', async () => {
    // 1. Cancellation before parsing (signal aborted during extraction)
    const cancelBeforeParse = new AbortController();
    let parseCalled = false;
    const repo1 = makeFakeRepository();
    const p1 = createIngestionJobProcessor({
      repository: repo1.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      shutdownSignal: cancelBeforeParse.signal,
      extractRepo: async (_opts, callback) => {
        cancelBeforeParse.abort();
        return callback(SAMPLE_WORKSPACE);
      },
      parserAdapter: makeFakeParserAdapter(() => {
        parseCalled = true;
        return Promise.resolve(makeFakeValidatedResult());
      }),
    });
    await expect(p1(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }))).rejects.toBeInstanceOf(
      IngestionCancelledError,
    );
    expect(parseCalled).toBe(false);
    expect(repo1.transitions.map((t) => t.toStatus)).toEqual(['cloning']);

    // 2. Cancellation during parsing -> ParserIntegrationError(PARSER_CANCELLED)
    const cancelDuringParse = new AbortController();
    const parserCancelErr = makeParserIntegrationError('PARSER_CANCELLED', { retryable: true });
    const repo2 = makeFakeRepository();
    const p2 = createIngestionJobProcessor({
      repository: repo2.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      shutdownSignal: cancelDuringParse.signal,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(() => {
        cancelDuringParse.abort();
        return Promise.reject(parserCancelErr);
      }),
    });
    await expect(p2(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).rejects.toBe(
      parserCancelErr,
    );
    expect(repo2.transitions.map((t) => t.toStatus)).toEqual(['cloning', 'parsing', 'failed']);
    expect(repo2.transitions[2]?.errorCode).toBe('PARSER_CANCELLED');

    // 3. Cancellation after handoff completes but before ready dispatch -> NEVER commits ready
    const cancelBeforeReady = new AbortController();
    const repo3 = makeFakeRepository();
    const p3 = createIngestionJobProcessor({
      repository: repo3.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      shutdownSignal: cancelBeforeReady.signal,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
      analysisResultHandoff: () => {
        cancelBeforeReady.abort();
        return Promise.resolve();
      },
    });
    await expect(p3(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }))).rejects.toBeInstanceOf(
      IngestionCancelledError,
    );
    expect(repo3.transitions.map((t) => t.toStatus)).toEqual([
      'cloning',
      'parsing',
      'building_graph',
    ]);
  });

  it('notifies infrastructure supervision synchronously on startup/fatal parser errors and allows bounded replacement retry on non-final settled attempt', async () => {
    const infraErrors: ParserIntegrationError[] = [];
    const startupErr = makeParserIntegrationError('MISSING_ENTRYPOINT', {
      retryable: false,
      startupFailure: true,
    });
    const repo = makeFakeRepository();

    const processJob = createIngestionJobProcessor({
      repository: repo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(() => Promise.reject(startupErr)),
      onInfrastructureFailure: (err) => {
        infraErrors.push(err);
      },
    });

    await expect(processJob(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }))).rejects.toBe(
      startupErr,
    );
    expect(infraErrors).toEqual([startupErr]);
    // Non-final settled infrastructure failure leaves DB non-terminal so a healthy replacement worker can retry
    expect(repo.transitions.map((t) => t.toStatus)).toEqual(['cloning', 'parsing']);
  });
  it('invokes onInfrastructureFailure synchronously BEFORE awaiting an in-flight heartbeat drain', async () => {
    const events: string[] = [];
    let resolveHeartbeat: (() => void) | undefined;
    let rejectParse: ((err: Error) => void) | undefined;

    const { repository } = makeFakeRepository({
      onHeartbeat: () =>
        new Promise<TouchHeartbeatResult>((resolve) => {
          events.push('heartbeat.start');
          resolveHeartbeat = () => {
            events.push('heartbeat.done');
            resolve({ updated: true, updatedAt: new Date() });
          };
        }),
    });

    const processJob = createIngestionJobProcessor({
      repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 10,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(
        () =>
          new Promise<ValidatedAnalysisResult>((_resolve, reject) => {
            rejectParse = reject;
          }),
      ),
      onInfrastructureFailure: () => {
        events.push('infra.notified');
      },
    });

    const runPromise = processJob(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }));
    while (resolveHeartbeat === undefined || rejectParse === undefined) {
      await new Promise((r) => setTimeout(r, 5));
    }

    rejectParse(
      makeParserIntegrationError('MISSING_ENTRYPOINT', {
        retryable: false,
        startupFailure: true,
      }),
    );

    // Yield microtasks: infrastructure callback MUST fire while heartbeat is still pending
    await new Promise((r) => setTimeout(r, 15));
    expect(events).toEqual(['heartbeat.start', 'infra.notified']);

    resolveHeartbeat();
    await expect(runPromise).rejects.toBeInstanceOf(ParserIntegrationError);
    expect(events).toEqual(['heartbeat.start', 'infra.notified', 'heartbeat.done']);
  });

  it('survives synchronous touchJobHeartbeat throws and throwing logger callbacks during heartbeat ticks without unhandled rejections', async () => {
    let hbCalls = 0;
    const { repository } = makeFakeRepository({
      onHeartbeat: () => {
        hbCalls += 1;
        throw new Error('synchronous DB client error');
      },
    });

    const throwingLogger = {
      info: () => {
        throw new Error('log info boom');
      },
      warn: () => {
        throw new Error('log warn boom');
      },
      error: () => {
        throw new Error('log error boom');
      },
    };

    const processJob = createIngestionJobProcessor({
      repository,
      logger: throwingLogger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 10,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(
        () =>
          new Promise<ValidatedAnalysisResult>((resolve) => {
            setTimeout(() => {
              resolve(makeFakeValidatedResult());
            }, 100);
          }),
      ),
    });

    await expect(processJob(makeJob())).resolves.toBeUndefined();
    expect(hbCalls).toBeGreaterThanOrEqual(2);
  });

  it('performs final-attempt DB failure bookkeeping without starting extraction when BullMQ dispatches a claimed job right after shutdown latches', async () => {
    const events: string[] = [];
    const { repository, transitions } = makeFakeRepository({
      onTransition: (t) => {
        events.push(`db:${t.toStatus}`);
      },
    });

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 500,
      setExitCode: () => undefined,
    });
    lifecycle.setCloseDb(() => {
      events.push('db.close');
      return Promise.resolve();
    });

    let extractCalled = false;
    let parseCalled = false;
    const baseProcessor = createIngestionJobProcessor({
      repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      shutdownSignal: lifecycle.shutdownSignal,
      fatalSignal: lifecycle.fatalSignal,
      isFatalState: lifecycle.isFatal,
      extractRepo: async (_opts, callback) => {
        extractCalled = true;
        return callback(SAMPLE_WORKSPACE);
      },
      parserAdapter: makeFakeParserAdapter(() => {
        parseCalled = true;
        return Promise.resolve(makeFakeValidatedResult());
      }),
    });

    const wrapped = lifecycle.wrapProcessor(baseProcessor, {
      delegateStoppedToProcessor: true,
    });

    // Latch shutdown before BullMQ dispatches the final attempt of an already-claimed job
    const workerCloseGate = new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    lifecycle.setWorker({ close: () => workerCloseGate });
    const shutdownPromise = lifecycle.shutdown('SIGTERM');

    await expect(
      wrapped(makeJob({ attemptsMade: 1, opts: { attempts: 2 } })),
    ).rejects.toBeInstanceOf(IngestionCancelledError);
    const outcome = await shutdownPromise;

    expect(extractCalled).toBe(false);
    expect(parseCalled).toBe(false);
    expect(transitions.map((t) => t.toStatus)).toEqual(['failed']);
    expect(transitions[0]?.errorCode).toBe('INGESTION_CANCELLED');
    expect(outcome.confirmed).toBe(true);
    // Final DB failure persisted strictly BEFORE PostgreSQL pool closed
    expect(events).toEqual(['db:failed', 'db.close']);
  });
});
