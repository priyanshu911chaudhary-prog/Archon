import {
  DbError,
  GraphPersistenceValidationError,
  GraphPublicationAbortedError,
  PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE,
  validateClaimIngestionAttemptInput,
  type ClaimIngestionAttemptInput,
  type ClaimIngestionAttemptResult,
  type IngestionAttemptOwnership,
  type IngestionJobRecord,
  type IngestionRepository,
  type PublishRepositoryGraphInput,
  type PublishRepositoryGraphResult,
  type ReconcilePublishedAttemptResult,
  type RepositoryRecord,
  type RepositoryStatus,
  type TouchHeartbeatResult,
  type TransitionJobStageInput,
  type TransitionJobStageResult,
} from '@archon/db';
import type { AnalysisOutput } from '@archon/shared';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { TarballExtractionError } from './extractor/errors.js';
import type { ExtractedRepoWorkspace } from './extractor/github-tarball.js';
import { createWorkerServiceLifecycle } from './lifecycle.js';
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
      discoveredFilesCount: 0,
      parsedFilesCount: 0,
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

function makeFakeRepoAndJob(
  status: RepositoryStatus,
  attemptGeneration = 1,
): {
  repository: RepositoryRecord;
  job: IngestionJobRecord;
} {
  const now = new Date('2026-11-23T06:00:00.000Z');
  return {
    repository: {
      graphPersistedAt: null,
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
      stage: status === 'superseded' ? 'ready' : status,
      attemptGeneration,
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
    readonly onClaim?: (input: ClaimIngestionAttemptInput) => Promise<ClaimIngestionAttemptResult>;
    readonly rejectAtStage?: TransitionJobStageInput['toStatus'];
    readonly rejectOutcome?: 'ownership_lost' | 'terminal';
    readonly onHeartbeat?: (
      ownership: IngestionAttemptOwnership,
      now?: Date,
    ) => Promise<TouchHeartbeatResult>;
    readonly onTransition?: (
      ownership: IngestionAttemptOwnership,
      input: TransitionJobStageInput,
    ) => Promise<TransitionJobStageResult> | undefined;
    readonly onPublish?: (
      ownership: IngestionAttemptOwnership,
      input: PublishRepositoryGraphInput,
    ) => Promise<PublishRepositoryGraphResult> | undefined;
    readonly onReconcile?: (
      ownership: IngestionAttemptOwnership,
    ) => Promise<ReconcilePublishedAttemptResult>;
  } = {},
) {
  const claims: ClaimIngestionAttemptInput[] = [];
  const transitions: {
    readonly ownership: IngestionAttemptOwnership;
    readonly input: TransitionJobStageInput;
  }[] = [];
  const publications: {
    readonly ownership: IngestionAttemptOwnership;
    readonly input: PublishRepositoryGraphInput;
  }[] = [];
  const reconciliations: IngestionAttemptOwnership[] = [];
  const heartbeatNowArgs: (Date | undefined)[] = [];
  let heartbeatCount = 0;

  const repository: Pick<
    IngestionRepository,
    | 'claimIngestionAttempt'
    | 'transitionJobStage'
    | 'touchJobHeartbeat'
    | 'publishRepositoryGraph'
    | 'reconcilePublishedAttempt'
  > = {
    claimIngestionAttempt(input): Promise<ClaimIngestionAttemptResult> {
      claims.push(input);
      if (options.onClaim !== undefined) {
        return options.onClaim(input);
      }
      const validated = validateClaimIngestionAttemptInput(input);
      if (!validated.ok) {
        return Promise.resolve(validated.rejection);
      }
      const pair = makeFakeRepoAndJob('cloning', validated.ownership.attemptGeneration);
      return Promise.resolve({
        outcome: 'claimed',
        ownership: validated.ownership,
        repository: pair.repository,
        job: pair.job,
      });
    },
    transitionJobStage(ownership, input): Promise<TransitionJobStageResult> {
      transitions.push({ ownership, input });
      const custom = options.onTransition?.(ownership, input);
      if (custom !== undefined) {
        return custom;
      }
      if (options.rejectAtStage === input.toStatus) {
        if (options.rejectOutcome === 'ownership_lost') {
          return Promise.resolve({
            outcome: 'ownership_lost',
            applied: false,
            storedGeneration: ownership.attemptGeneration + 1,
            expectedGeneration: ownership.attemptGeneration,
          });
        }
        return Promise.resolve({
          outcome: 'terminal',
          applied: false,
          status: 'failed',
        });
      }
      const pair = makeFakeRepoAndJob(input.toStatus, ownership.attemptGeneration);
      return Promise.resolve({
        outcome: 'applied',
        applied: true,
        repository: pair.repository,
        job: pair.job,
      });
    },
    touchJobHeartbeat(ownership, now): Promise<TouchHeartbeatResult> {
      heartbeatCount += 1;
      heartbeatNowArgs.push(now);
      if (options.onHeartbeat !== undefined) {
        return options.onHeartbeat(ownership, now);
      }
      return Promise.resolve({
        outcome: 'updated',
        updated: true,
        updatedAt: now ?? new Date(),
      });
    },
    publishRepositoryGraph(ownership, input): Promise<PublishRepositoryGraphResult> {
      publications.push({ ownership, input });
      const custom = options.onPublish?.(ownership, input);
      if (custom !== undefined) {
        return custom;
      }
      const pair = makeFakeRepoAndJob('ready', ownership.attemptGeneration);
      const now = input.now ?? new Date();
      return Promise.resolve({
        outcome: 'published',
        applied: true,
        repository: { ...pair.repository, graphPersistedAt: now },
        job: { ...pair.job, progressPct: 100 },
        persistedNodeCount: input.output.nodes.length,
        persistedEdgeCount: input.output.edges.length,
        nodeBatches: input.output.nodes.length > 0 ? 1 : 0,
        edgeBatches: input.output.edges.length > 0 ? 1 : 0,
      });
    },
    reconcilePublishedAttempt(ownership): Promise<ReconcilePublishedAttemptResult> {
      reconciliations.push(ownership);
      if (options.onReconcile !== undefined) {
        return options.onReconcile(ownership);
      }
      const pair = makeFakeRepoAndJob('building_graph', ownership.attemptGeneration);
      return Promise.resolve({
        outcome: 'still_owned_unpublished',
        repository: pair.repository,
        job: pair.job,
      });
    },
  };

  return {
    repository,
    claims,
    transitions,
    publications,
    reconciliations,
    heartbeatNowArgs,
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
    attemptsStarted: 1,
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

  it('classifies non-retryable vs retryable extraction, parser, DB, cancellation, and generic errors safely', () => {
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
      new DbError('DB_VALIDATION_ERROR', 'bad input'),
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

    const uncertainDb = new DbError('DB_QUERY_ERROR', 'tx unknown', {
      pgCode: PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE,
    });
    expect(classifyIngestionError(uncertainDb)).toMatchObject({
      retryable: true,
      errorCode: 'DATABASE_ERROR',
      commitOutcomeUncertain: true,
    });

    const generic = classifyIngestionError(new Error('SECRET_SNIPPET_IN_EXCEPTION'));
    expect(generic.errorCode).toBe('WORKER_ERROR');
    expect(generic.errorDetail).toBe('WORKER_ERROR');
    expect(generic.errorMessage).not.toContain('SECRET_SNIPPET');
  });
});

describe('createIngestionJobProcessor', () => {
  it('claims ownership then executes parsing -> parserAdapter -> building_graph -> handoff -> ready with exact inventory and AbortSignal propagation', async () => {
    const order: string[] = [];
    const { repository, claims, transitions, publications } = makeFakeRepository({
      onTransition: (_ownership, t) => {
        order.push(`db:${t.toStatus}`);
        return undefined;
      },
      onPublish: (_ownership, input) => {
        order.push('db:publish_ready');
        capturedSignals.push(input.signal);
        return undefined;
      },
    });
    const { logger } = makeFakeLogger();
    const shutdownCtrl = new AbortController();

    const capturedSignals: (AbortSignal | undefined)[] = [];
    const capturedParserInputs: {
      rootDir: string;
      supportedFiles: readonly string[];
      configFiles: readonly string[];
    }[] = [];
    const capturedHandoffs: AnalysisResultHandoffContext[] = [];

    const fakeExtract: ExtractRepoFn = async (opts, callback) => {
      capturedSignals.push(opts.signal);
      order.push('extract');
      return callback(SAMPLE_WORKSPACE);
    };

    const parserAdapter = makeFakeParserAdapter((workspace, opts) => {
      order.push('parse');
      capturedSignals.push(opts?.signal);
      capturedParserInputs.push({
        rootDir: workspace.rootDir,
        supportedFiles: workspace.supportedFiles,
        configFiles: workspace.configFiles,
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
      beforeGraphPublish: (ctx) => {
        order.push('handoff');
        capturedSignals.push(ctx.signal);
        capturedHandoffs.push(ctx);
        return Promise.resolve();
      },
    });

    await processJob(makeJob({ attemptsStarted: 2 }));

    expect(claims).toHaveLength(1);
    expect(claims[0]?.attemptGeneration).toBe(2);
    expect(order).toEqual([
      'extract',
      'db:parsing',
      'parse',
      'db:building_graph',
      'handoff',
      'db:publish_ready',
    ]);
    expect(
      transitions.map((t) => [
        t.ownership.attemptGeneration,
        t.input.toStatus,
        t.input.progressPct,
      ]),
    ).toEqual([
      [2, 'parsing', STAGE_PROGRESS.parsing],
      [2, 'building_graph', STAGE_PROGRESS.buildingGraph],
    ]);
    expect(publications).toHaveLength(1);
    expect(publications[0]?.ownership.attemptGeneration).toBe(2);
    expect(transitions[0]?.input.fileCount).toBe(2);
    expect(transitions[0]?.input.skippedFilesCount).toBe(3);
    expect(capturedParserInputs).toEqual([
      {
        rootDir: SAMPLE_WORKSPACE.rootDir,
        supportedFiles: SAMPLE_WORKSPACE.supportedFiles,
        configFiles: SAMPLE_WORKSPACE.configFiles,
      },
    ]);
    expect(capturedSignals).toHaveLength(4);
    expect(capturedSignals.every((s) => s !== undefined && !s.aborted)).toBe(true);
    expect(capturedHandoffs).toHaveLength(1);
    expect(capturedHandoffs[0]?.repositoryId).toBe(SAMPLE_JOB_DATA.repoId);
  });

  it('omits explicit now timestamp on DB mutations when deps.now is not provided (preserving post-lock DB timestamps)', async () => {
    const { repository, claims, transitions, publications, heartbeatNowArgs } =
      makeFakeRepository();
    const processJob = createIngestionJobProcessor({
      repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 10,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(
        () =>
          new Promise<ValidatedAnalysisResult>((resolve) => {
            setTimeout(() => {
              resolve(makeFakeValidatedResult());
            }, 30);
          }),
      ),
    });

    await processJob(makeJob());
    expect(claims[0]?.now).toBeUndefined();
    expect(transitions.every((t) => t.input.now === undefined)).toBe(true);
    expect(publications[0]?.input.now).toBeUndefined();
    expect(heartbeatNowArgs.length).toBeGreaterThanOrEqual(1);
    expect(heartbeatNowArgs.every((arg) => arg === undefined)).toBe(true);
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
            resolve({ outcome: 'updated', updated: true, updatedAt: new Date() });
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

    while (resolveSlowHeartbeat === undefined || releaseParse === undefined) {
      await new Promise((r) => setTimeout(r, 5));
    }

    releaseParse();
    await new Promise((r) => setTimeout(r, 25));
    expect(heartbeatFinished).toBe(false);
    expect(jobSettled).toBe(false);

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
        return Promise.resolve({ outcome: 'updated', updated: true, updatedAt: new Date() });
      },
    });
    let rejectLateParse: ((err: Error) => void) | undefined;

    const processJob = createIngestionJobProcessor({
      repository,
      logger: makeFakeLogger().logger,
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

    fatalCtrl.abort();
    const countAfterFatal = heartbeatCalls;
    await new Promise((r) => setTimeout(r, 45));

    expect(heartbeatCalls).toBe(countAfterFatal);
    expect(jobSettled).toBe(false);

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
    const securityErr = new TarballExtractionError({
      code: 'TARBALL_SECURITY_VIOLATION',
      message: 'Symlink rejected',
    });

    const processJob = createIngestionJobProcessor({
      repository,
      logger: makeFakeLogger().logger,
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
    expect(lastTransition?.input.toStatus).toBe('failed');
    expect(lastTransition?.input.errorCode).toBe('TARBALL_SECURITY_VIOLATION');
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
    expect(lastTransition?.input.toStatus).toBe('failed');
    expect(lastTransition?.input.errorCode).toBe('PARSER_FILE_LIMIT_EXCEEDED');
    expect(lastTransition?.input.errorDetail).toBe('FILE_LIMIT_EXCEEDED');
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
    const processFirst = createIngestionJobProcessor({
      repository: firstRun.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: () => Promise.reject(retryableErr),
      parserAdapter: makeFakeParserAdapter(),
    });
    await expect(processFirst(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }))).rejects.toBe(
      retryableErr,
    );
    expect(firstRun.transitions).toEqual([]);

    const finalRun = makeFakeRepository();
    const processFinal = createIngestionJobProcessor({
      repository: finalRun.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: () => Promise.reject(retryableErr),
      parserAdapter: makeFakeParserAdapter(),
    });
    await expect(processFinal(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).rejects.toBe(
      retryableErr,
    );
    expect(finalRun.transitions.map((t) => t.input.toStatus)).toEqual(['failed']);
    expect(finalRun.transitions[0]?.input.errorCode).toBe('TARBALL_PARSE_ERROR');

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
    expect(pNonFinalRepo.transitions.map((t) => t.input.toStatus)).toEqual(['parsing']);

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
    expect(pFinalRepo.transitions.map((t) => t.input.toStatus)).toEqual(['parsing', 'failed']);
    expect(pFinalRepo.transitions[1]?.input.errorCode).toBe('PARSER_CHILD_CRASHED');
  });

  it('stops early without downloading or running parser/handoff when claim or fenced transitions return applied: false', async () => {
    const parsingRepo = makeFakeRepository({
      rejectAtStage: 'parsing',
      rejectOutcome: 'ownership_lost',
    });
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

    const graphRepo = makeFakeRepository({
      rejectAtStage: 'building_graph',
      rejectOutcome: 'terminal',
    });
    let handoffCalled = false;
    const processGraph = createIngestionJobProcessor({
      repository: graphRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
      beforeGraphPublish: () => {
        handoffCalled = true;
        return Promise.resolve();
      },
    });
    await processGraph(makeJob());
    expect(handoffCalled).toBe(false);
    expect(graphRepo.transitions.map((t) => t.input.toStatus)).toEqual([
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
      beforeGraphPublish: () => Promise.reject(new Error(`DB insert failed near ${secretSnippet}`)),
    });

    await expect(processJob(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'An unexpected error occurred during repository ingestion.' &&
        !err.message.includes(secretSnippet),
    );

    expect(transitions.map((t) => t.input.toStatus)).toEqual([
      'parsing',
      'building_graph',
      'failed',
    ]);
    expect(JSON.stringify(transitions)).not.toContain(secretSnippet);
    expect(JSON.stringify(logs)).not.toContain(secretSnippet);
  });

  it('handles cancellation before parsing, during parsing, and after parsing before ready dispatch without marking ready', async () => {
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
    expect(repo1.transitions).toEqual([]);

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
    expect(repo2.transitions.map((t) => t.input.toStatus)).toEqual(['parsing', 'failed']);
    expect(repo2.transitions[1]?.input.errorCode).toBe('PARSER_CANCELLED');

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
      beforeGraphPublish: () => {
        cancelBeforeReady.abort();
        return Promise.resolve();
      },
    });
    await expect(p3(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }))).rejects.toBeInstanceOf(
      IngestionCancelledError,
    );
    expect(repo3.transitions.map((t) => t.input.toStatus)).toEqual(['parsing', 'building_graph']);
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
    expect(repo.transitions.map((t) => t.input.toStatus)).toEqual(['parsing']);
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
            resolve({ outcome: 'updated', updated: true, updatedAt: new Date() });
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

  it('never writes unfenced failure if shutdown latches before claim, and persists fenced failure before db.close if shutdown latches after claim', async () => {
    // 1. Shutdown latched BEFORE claim -> no claim, no unfenced failed transition
    const preClaimRepo = makeFakeRepository();
    const preCtrl = new AbortController();
    preCtrl.abort();
    const preProc = createIngestionJobProcessor({
      repository: preClaimRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      shutdownSignal: preCtrl.signal,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
    });
    await expect(
      preProc(makeJob({ attemptsMade: 1, opts: { attempts: 2 } })),
    ).rejects.toBeInstanceOf(IngestionCancelledError);
    expect(preClaimRepo.claims).toEqual([]);
    expect(preClaimRepo.transitions).toEqual([]);

    // 2. Shutdown latched AFTER claim on final attempt -> fenced failed persisted BEFORE db.close
    const events: string[] = [];
    const postClaimRepo = makeFakeRepository({
      onTransition: (_ownership, t) => {
        events.push(`db:${t.toStatus}`);
        return undefined;
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
    const baseProcessor = createIngestionJobProcessor({
      repository: postClaimRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      shutdownSignal: lifecycle.shutdownSignal,
      fatalSignal: lifecycle.fatalSignal,
      isFatalState: lifecycle.isFatal,
      extractRepo: async (_opts, callback) => {
        void lifecycle.shutdown('SIGTERM');
        return callback(SAMPLE_WORKSPACE);
      },
      parserAdapter: makeFakeParserAdapter(),
    });
    const wrapped = lifecycle.wrapProcessor(baseProcessor, { delegateStoppedToProcessor: true });
    lifecycle.setWorker({
      close: () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        }),
    });

    await expect(
      wrapped(makeJob({ attemptsMade: 1, attemptsStarted: 2, opts: { attempts: 2 } })),
    ).rejects.toBeInstanceOf(IngestionCancelledError);
    const outcome = await lifecycle.waitForShutdown();
    expect(outcome?.confirmed).toBe(true);
    expect(events).toEqual(['db:failed', 'db.close']);
  });

  it('skips extraction, parsing, and heartbeats on stale_generation or already_terminal claims, and rejects invalid/missing claims as UnrecoverableError', async () => {
    for (const skipOutcome of [
      { outcome: 'stale_generation' as const, storedGeneration: 3, incomingGeneration: 1 },
      { outcome: 'already_terminal' as const, status: 'ready' as const },
    ]) {
      let extractCalled = false;
      const { repository, transitions, getHeartbeatCount } = makeFakeRepository({
        onClaim: () => Promise.resolve(skipOutcome),
      });
      const processJob = createIngestionJobProcessor({
        repository,
        logger: makeFakeLogger().logger,
        maxSupportedFiles: 500,
        maxRepoSizeMb: 50,
        heartbeatIntervalMs: 10,
        extractRepo: async (_opts, callback) => {
          extractCalled = true;
          return callback(SAMPLE_WORKSPACE);
        },
        parserAdapter: makeFakeParserAdapter(),
      });

      await expect(processJob(makeJob())).resolves.toBeUndefined();
      expect(extractCalled).toBe(false);
      expect(transitions).toEqual([]);
      expect(getHeartbeatCount()).toBe(0);
    }

    for (const badOutcome of [
      { outcome: 'missing' as const },
      { outcome: 'identity_mismatch' as const, reason: 'commit_sha_mismatch' as const },
      { outcome: 'invalid_generation' as const, incomingGeneration: 0 },
    ]) {
      const { repository, transitions } = makeFakeRepository({
        onClaim: () => Promise.resolve(badOutcome),
      });
      const processJob = createIngestionJobProcessor({
        repository,
        logger: makeFakeLogger().logger,
        maxSupportedFiles: 500,
        maxRepoSizeMb: 50,
        heartbeatIntervalMs: 0,
        extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
        parserAdapter: makeFakeParserAdapter(),
      });

      await expect(processJob(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
      expect(transitions).toEqual([]);
    }
  });

  it('treats busy heartbeats as transient, cancels obsolete job cleanly on ownership_lost without failing DB or shutting down worker', async () => {
    let ticks = 0;
    const shutdownCtrl = new AbortController();
    const { repository, transitions } = makeFakeRepository({
      onHeartbeat: (ownership) => {
        ticks += 1;
        if (ticks === 1) {
          return Promise.resolve({ outcome: 'busy', updated: false });
        }
        return Promise.resolve({
          outcome: 'ownership_lost',
          updated: false,
          reason: 'stale_generation',
          storedGeneration: ownership.attemptGeneration + 1,
          expectedGeneration: ownership.attemptGeneration,
        });
      },
    });

    const parserCancelErr = makeParserIntegrationError('PARSER_CANCELLED', { retryable: true });
    let parserSignalAborted = false;

    const processJob = createIngestionJobProcessor({
      repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 10,
      shutdownSignal: shutdownCtrl.signal,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(
        (_ws, opts) =>
          new Promise<ValidatedAnalysisResult>((_resolve, reject) => {
            if (opts?.signal?.aborted === true) {
              parserSignalAborted = true;
              reject(parserCancelErr);
              return;
            }
            opts?.signal?.addEventListener(
              'abort',
              () => {
                parserSignalAborted = true;
                reject(parserCancelErr);
              },
              { once: true },
            );
          }),
      ),
    });

    await expect(
      processJob(makeJob({ attemptsMade: 1, opts: { attempts: 2 } })),
    ).resolves.toBeUndefined();
    expect(ticks).toBe(2);
    expect(parserSignalAborted).toBe(true);
    expect(shutdownCtrl.signal.aborted).toBe(false);
    expect(transitions.map((t) => t.input.toStatus)).toEqual(['parsing']);
  });

  it('never writes an unfenced or terminal failure when claim or transition throws an uncertain DB error', async () => {
    const uncertainErr = new DbError('DB_QUERY_ERROR', 'tx resolution unknown', {
      pgCode: PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE,
    });

    const claimFailRepo = makeFakeRepository({ onClaim: () => Promise.reject(uncertainErr) });
    const p1 = createIngestionJobProcessor({
      repository: claimFailRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
    });
    await expect(p1(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).rejects.toThrow(
      'Database temporarily unavailable during repository ingestion.',
    );
    expect(claimFailRepo.transitions).toEqual([]);

    // 2. Uncertain publish error reconciled as committed under our ownership -> completes cleanly
    const committedPubRepo = makeFakeRepository({
      onPublish: () => Promise.reject(uncertainErr),
      onReconcile: (ownership) => {
        const pair = makeFakeRepoAndJob('ready', ownership.attemptGeneration);
        return Promise.resolve({
          outcome: 'published_by_owner',
          repository: { ...pair.repository, graphPersistedAt: new Date() },
          job: { ...pair.job, progressPct: 100 },
        });
      },
    });
    const p2 = createIngestionJobProcessor({
      repository: committedPubRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
    });
    await expect(p2(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).resolves.toBeUndefined();
    expect(committedPubRepo.reconciliations).toHaveLength(1);
    expect(committedPubRepo.transitions.map((t) => t.input.toStatus)).toEqual([
      'parsing',
      'building_graph',
    ]);

    // 3. Uncertain publish error where reconciliation fails -> preserves non-terminal (no failed write)
    const unavailableReconcileRepo = makeFakeRepository({
      onPublish: () => Promise.reject(uncertainErr),
      onReconcile: () => Promise.reject(new Error('Connection terminated unexpectedly')),
    });
    const p3 = createIngestionJobProcessor({
      repository: unavailableReconcileRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
    });
    await expect(p3(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).rejects.toThrow(
      'Database temporarily unavailable during repository ingestion.',
    );
    expect(unavailableReconcileRepo.transitions.map((t) => t.input.toStatus)).toEqual([
      'parsing',
      'building_graph',
    ]);

    // 4. Uncertain publish error authoritatively confirmed rolled back on final attempt -> marks failed
    const confirmedRollbackRepo = makeFakeRepository({
      onPublish: () => Promise.reject(uncertainErr),
      onReconcile: (ownership) => {
        const pair = makeFakeRepoAndJob('building_graph', ownership.attemptGeneration);
        return Promise.resolve({
          outcome: 'still_owned_unpublished',
          repository: pair.repository,
          job: pair.job,
        });
      },
    });
    const p4 = createIngestionJobProcessor({
      repository: confirmedRollbackRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
    });
    await expect(p4(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).rejects.toThrow(
      'Database temporarily unavailable during repository ingestion.',
    );
    expect(confirmedRollbackRepo.transitions.map((t) => t.input.toStatus)).toEqual([
      'parsing',
      'building_graph',
      'failed',
    ]);

    // 5. GraphPersistenceValidationError -> non-retryable UnrecoverableError + fenced failed
    const invalidGraphRepo = makeFakeRepository({
      onPublish: () =>
        Promise.reject(
          new GraphPersistenceValidationError('PARENT_CYCLE_DETECTED', 'Cyclic parent graph'),
        ),
    });
    const p5 = createIngestionJobProcessor({
      repository: invalidGraphRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
    });
    await expect(p5(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(invalidGraphRepo.transitions.map((t) => t.input.toStatus)).toEqual([
      'parsing',
      'building_graph',
      'failed',
    ]);
    expect(invalidGraphRepo.transitions[2]?.input.errorCode).toBe('GRAPH_VALIDATION_ERROR');

    // 6. GraphPublicationAbortedError on shutdown -> throws IngestionCancelledError without failed on non-final
    const shutdownCtrl = new AbortController();
    const abortedPubRepo = makeFakeRepository({
      onPublish: () => {
        shutdownCtrl.abort();
        return Promise.reject(new GraphPublicationAbortedError());
      },
    });
    const p6 = createIngestionJobProcessor({
      repository: abortedPubRepo.repository,
      logger: makeFakeLogger().logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      shutdownSignal: shutdownCtrl.signal,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parserAdapter: makeFakeParserAdapter(),
    });
    await expect(p6(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }))).rejects.toBeInstanceOf(
      IngestionCancelledError,
    );
    expect(abortedPubRepo.transitions.map((t) => t.input.toStatus)).toEqual([
      'parsing',
      'building_graph',
    ]);
  });
});
