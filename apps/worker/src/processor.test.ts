import type {
  IngestionJobRecord,
  IngestionRepository,
  RepositoryRecord,
  RepositoryStatus,
  TouchHeartbeatResult,
  TransitionJobStageInput,
  TransitionJobStageResult,
} from '@archon/db';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { TarballExtractionError } from './extractor/errors.js';
import type { ExtractedRepoWorkspace } from './extractor/github-tarball.js';
import {
  STAGE_PROGRESS,
  classifyIngestionError,
  createIngestionJobProcessor,
  isFinalJobAttempt,
  type ExtractRepoFn,
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
  } = {},
) {
  const transitions: TransitionJobStageInput[] = [];
  let heartbeatCount = 0;

  const repository: Pick<IngestionRepository, 'transitionJobStage' | 'touchJobHeartbeat'> = {
    transitionJobStage(input): Promise<TransitionJobStageResult> {
      transitions.push(input);
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
  const logs: { level: 'info' | 'warn' | 'error'; msg: string }[] = [];
  const logger = {
    info(_obj: unknown, msg?: string): void {
      logs.push({ level: 'info', msg: msg ?? String(_obj) });
    },
    warn(_obj: unknown, msg?: string): void {
      logs.push({ level: 'warn', msg: msg ?? String(_obj) });
    },
    error(_obj: unknown, msg?: string): void {
      logs.push({ level: 'error', msg: msg ?? String(_obj) });
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

describe('isFinalJobAttempt and classifyIngestionError', () => {
  it('computes final attempt strictly from 0-indexed job.attemptsMade and job.opts.attempts', () => {
    expect(isFinalJobAttempt({ attemptsMade: 0, opts: { attempts: 2 } })).toBe(false);
    expect(isFinalJobAttempt({ attemptsMade: 1, opts: { attempts: 2 } })).toBe(true);
    expect(isFinalJobAttempt({ attemptsMade: 0, opts: { attempts: 1 } })).toBe(true);
    expect(isFinalJobAttempt({ attemptsMade: 0, opts: {} })).toBe(true);
  });

  it('classifies non-retryable vs retryable errors according to the approved retry table', () => {
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
    ];

    for (const err of nonRetryable) {
      expect(classifyIngestionError(err).retryable, `Expected non-retryable: ${err.code}`).toBe(
        false,
      );
    }

    const retryable = [
      new TarballExtractionError({ code: 'TARBALL_TIMEOUT', message: 'timed out' }),
      new TarballExtractionError({ code: 'TARBALL_RATE_LIMITED', message: 'rate limit' }),
      new TarballExtractionError({ code: 'TARBALL_UPSTREAM_ERROR', message: '502' }),
      new TarballExtractionError({
        code: 'TARBALL_PARSE_ERROR',
        retryable: true,
        message: 'truncated stream',
      }),
      new Error('unexpected runtime failure'),
    ];

    for (const err of retryable) {
      expect(classifyIngestionError(err).retryable).toBe(true);
    }
    expect(classifyIngestionError(new Error('boom')).errorCode).toBe('WORKER_ERROR');
  });
});

describe('createIngestionJobProcessor', () => {
  it('executes cloning -> parsing -> parseWorkspace -> building_graph -> ready and persists file counts', async () => {
    const { repository, transitions } = makeFakeRepository();
    const { logger } = makeFakeLogger();
    const parsedFiles: string[][] = [];

    const fakeExtract: ExtractRepoFn = async (_opts, callback) => {
      return callback(SAMPLE_WORKSPACE);
    };

    const processJob = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: fakeExtract,
      parseWorkspace: (workspace) => {
        parsedFiles.push([...workspace.supportedFiles]);
        return Promise.resolve();
      },
    });

    await processJob(makeJob());

    expect(transitions.map((t) => [t.toStatus, t.progressPct])).toEqual([
      ['cloning', STAGE_PROGRESS.cloning],
      ['parsing', STAGE_PROGRESS.parsing],
      ['building_graph', STAGE_PROGRESS.buildingGraph],
      ['ready', STAGE_PROGRESS.ready],
    ]);
    expect(transitions[1]?.fileCount).toBe(2);
    expect(transitions[1]?.skippedFilesCount).toBe(3);
    expect(parsedFiles).toEqual([['src/index.ts', 'src/react.ts']]);
  });

  it('starts heartbeat during processing, stops on completion/terminal, and logs heartbeat failures without throwing', async () => {
    const heartbeatsState = { calls: 0 };
    const { repository } = makeFakeRepository({
      onHeartbeat: () => {
        heartbeatsState.calls += 1;
        if (heartbeatsState.calls === 1) {
          return Promise.reject(new Error('temporary DB hiccup'));
        }
        return Promise.resolve({ updated: true, updatedAt: new Date() });
      },
    });
    const { logger, logs } = makeFakeLogger();

    const processJob = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 15,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parseWorkspace: () =>
        new Promise((resolve) => {
          setTimeout(resolve, 65);
        }),
    });

    await processJob(makeJob());

    const countAtEnd = heartbeatsState.calls;
    expect(countAtEnd).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('heartbeat'))).toBe(true);

    // Confirm interval is cleared after completion (no further ticks)
    await new Promise((resolve) => {
      setTimeout(resolve, 45);
    });
    expect(heartbeatsState.calls).toBe(countAtEnd);

    // Also confirm heartbeat stops early if touchJobHeartbeat returns { updated: false }
    const terminalHeartbeats = { calls: 0 };
    const terminalRepo = makeFakeRepository({
      onHeartbeat: () => {
        terminalHeartbeats.calls += 1;
        return Promise.resolve({ updated: false });
      },
    });
    const processTerminal = createIngestionJobProcessor({
      repository: terminalRepo.repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 15,
      extractRepo: async (_opts, callback) => callback(SAMPLE_WORKSPACE),
      parseWorkspace: () =>
        new Promise((resolve) => {
          setTimeout(resolve, 70);
        }),
    });

    await processTerminal(makeJob());
    expect(terminalHeartbeats.calls).toBe(1);
  });

  it('marks Postgres failed immediately and throws UnrecoverableError on non-retryable errors (attempt 1 of 2)', async () => {
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

  it('leaves Postgres non-terminal on retryable attempt 1 of 2, and marks failed on final attempt 2 of 2', async () => {
    const retryableErr = new TarballExtractionError({
      code: 'TARBALL_PARSE_ERROR',
      retryable: true,
      message: 'Truncated gzip stream',
    });

    // Attempt 1 of 2 (attemptsMade = 0) -> do NOT mark failed
    const firstRun = makeFakeRepository();
    const firstLogger = makeFakeLogger();
    const processFirst = createIngestionJobProcessor({
      repository: firstRun.repository,
      logger: firstLogger.logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: () => Promise.reject(retryableErr),
    });

    await expect(processFirst(makeJob({ attemptsMade: 0, opts: { attempts: 2 } }))).rejects.toBe(
      retryableErr,
    );
    expect(firstRun.transitions.map((t) => t.toStatus)).toEqual(['cloning']);

    // Attempt 2 of 2 (attemptsMade = 1, final) -> mark failed with errorCode
    const finalRun = makeFakeRepository();
    const finalLogger = makeFakeLogger();
    const processFinal = createIngestionJobProcessor({
      repository: finalRun.repository,
      logger: finalLogger.logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: () => Promise.reject(retryableErr),
    });

    await expect(processFinal(makeJob({ attemptsMade: 1, opts: { attempts: 2 } }))).rejects.toBe(
      retryableErr,
    );
    expect(finalRun.transitions.map((t) => t.toStatus)).toEqual(['cloning', 'failed']);
    expect(finalRun.transitions[1]?.errorCode).toBe('TARBALL_PARSE_ERROR');
  });

  it('stops early without downloading when initial transition returns applied: false', async () => {
    const { repository, transitions } = makeFakeRepository({ rejectAtStage: 'cloning' });
    const { logger } = makeFakeLogger();
    const extractState = { called: false };

    const processJob = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 0,
      extractRepo: async (_opts, callback) => {
        extractState.called = true;
        return callback(SAMPLE_WORKSPACE);
      },
    });

    await processJob(makeJob());

    expect(transitions.map((t) => t.toStatus)).toEqual(['cloning']);
    expect(extractState.called).toBe(false);
  });
});
