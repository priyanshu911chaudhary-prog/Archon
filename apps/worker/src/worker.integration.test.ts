import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildPoolConfig,
  createDbClient,
  createIngestionRepository,
  runMigrations,
  sanitizeDatabaseTarget,
  type DbClient,
  type IngestionRepository,
} from '@archon/db';
import { createLogger, loadEnv, validateAnalysisGraph, type AnalysisOutput } from '@archon/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withExtractedRepo } from './extractor/github-tarball.js';
import { buildGzippedUstar, type UstarFixtureEntry } from './extractor/tar-test-utils.js';
import { createWorkerServiceLifecycle } from './lifecycle.js';
import {
  createProductionParserAdapter,
  type AnalysisResultHandoffContext,
  type ProductionParserLogEvent,
  type ValidatedAnalysisResult,
} from './parser-integration.js';
import {
  STAGE_PROGRESS,
  createIngestionJobProcessor,
  type ExtractRepoFn,
  type IngestionParserAdapter,
} from './processor.js';
import {
  closeWorkerWithTimeout,
  createIngestionQueue,
  createIngestionWorker,
  enqueueIngestionJob,
  type IngestionBullMqJob,
  type IngestionQueue,
  type IngestionWorker,
} from './queue.js';
import {
  closeRedisClient,
  createFastFailRedisClient,
  sanitizeRedisTarget,
  waitForRedisReady,
} from './redis.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REAL_PARSER_HELPER_SOURCE = [
  'export function helper(): number {',
  '  return 42;',
  '}',
  '',
].join('\n');
const REAL_PARSER_INDEX_SOURCE = [
  "import { helper } from './helper.js';",
  'export function run(): number {',
  '  return helper();',
  '}',
  '',
].join('\n');

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(timeoutMs)} ms waiting for ${label}.`));
    }, timeoutMs);
    timer.unref();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function replaceDatabaseName(databaseUrl: string, newDbName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${newDbName}`;
  return parsed.toString();
}

function extractUrl(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function createTarballMockFetch(
  owner: string,
  name: string,
  sha: string,
  entries: readonly UstarFixtureEntry[],
): typeof globalThis.fetch {
  const archive = buildGzippedUstar(entries);
  const apiUrl = `https://api.github.com/repos/${owner}/${name}/tarball/${sha}`;
  const codeloadUrl = `https://codeload.github.com/${owner}/${name}/legacy.tar.gz/${sha}`;

  return (input) => {
    const url = extractUrl(input);
    if (url === apiUrl) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: codeloadUrl } }),
      );
    }
    if (url === codeloadUrl) {
      return Promise.resolve(
        new Response(new Uint8Array(archive), {
          status: 200,
          headers: { 'content-type': 'application/x-gzip' },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
}

function createMultiRepoTarballMockFetch(
  repos: readonly {
    readonly owner: string;
    readonly name: string;
    readonly sha: string;
    readonly entries: readonly UstarFixtureEntry[];
  }[],
): typeof globalThis.fetch {
  const byUrl = new Map<string, () => Response>();
  for (const repo of repos) {
    const archive = buildGzippedUstar(repo.entries);
    const apiUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/tarball/${repo.sha}`;
    const codeloadUrl = `https://codeload.github.com/${repo.owner}/${repo.name}/legacy.tar.gz/${repo.sha}`;
    byUrl.set(
      apiUrl,
      () => new Response(null, { status: 302, headers: { location: codeloadUrl } }),
    );
    byUrl.set(
      codeloadUrl,
      () =>
        new Response(new Uint8Array(archive), {
          status: 200,
          headers: { 'content-type': 'application/x-gzip' },
        }),
    );
  }
  return (input) => {
    const factory = byUrl.get(extractUrl(input));
    return Promise.resolve(factory !== undefined ? factory() : new Response(null, { status: 404 }));
  };
}

function makeStandardFixtureEntries(prefix: string): readonly UstarFixtureEntry[] {
  return [
    { path: `${prefix}/`, typeFlag: '5' },
    { path: `${prefix}/src/`, typeFlag: '5' },
    { path: `${prefix}/src/helper.ts`, content: REAL_PARSER_HELPER_SOURCE },
    { path: `${prefix}/src/index.ts`, content: REAL_PARSER_INDEX_SOURCE },
    { path: `${prefix}/README.md`, content: '# fixture\n' },
  ];
}

function assertExpectedStandardGraph(output: AnalysisOutput): void {
  expect(validateAnalysisGraph(output)).toEqual({ valid: true, violations: [] });
  expect(output.warnings).toEqual([]);

  expect(output.stats.discoveredFilesCount).toBe(2);
  expect(output.stats.parsedFilesCount).toBe(2);
  expect(output.stats.skippedSyntaxErrorFilesCount).toBe(0);
  expect(output.stats.skippedOversizedFilesCount).toBe(0);
  expect(output.stats.configFilesCount).toBe(0);
  expect(output.stats.folderNodeCount).toBe(1);
  expect(output.stats.fileNodeCount).toBe(2);
  expect(output.stats.functionNodeCount).toBe(2);
  expect(output.stats.classNodeCount).toBe(0);
  expect(output.stats.symbolNodeCount).toBe(0);
  expect(output.stats.importsEdgeCount).toBe(1);
  expect(output.stats.callsEdgeCount).toBe(1);
  expect(output.stats.truncatedWarningsCount).toBe(0);

  expect(output.nodes).toHaveLength(5);
  expect(output.edges).toHaveLength(2);

  const nodeByQn = new Map(output.nodes.map((node) => [node.qualifiedName, node]));
  expect([...nodeByQn.keys()].sort()).toEqual([
    'file:src/helper.ts',
    'file:src/index.ts',
    'folder:src',
    'src/helper.ts::fn:helper',
    'src/index.ts::fn:run',
  ]);

  expect(nodeByQn.get('folder:src')).toMatchObject({
    nodeType: 'folder',
    name: 'src',
    filePath: 'src',
    parentQualifiedName: null,
    isExported: false,
    startLine: null,
    endLine: null,
    contentHash: null,
    snippet: null,
  });

  expect(nodeByQn.get('file:src/helper.ts')).toMatchObject({
    nodeType: 'file',
    name: 'helper.ts',
    filePath: 'src/helper.ts',
    parentQualifiedName: 'folder:src',
    isExported: false,
    startLine: 1,
  });

  expect(nodeByQn.get('file:src/index.ts')).toMatchObject({
    nodeType: 'file',
    name: 'index.ts',
    filePath: 'src/index.ts',
    parentQualifiedName: 'folder:src',
    isExported: false,
    startLine: 1,
  });

  expect(nodeByQn.get('src/helper.ts::fn:helper')).toMatchObject({
    nodeType: 'function',
    name: 'helper',
    filePath: 'src/helper.ts',
    parentQualifiedName: 'file:src/helper.ts',
    isExported: true,
    startLine: 1,
    endLine: 3,
  });

  expect(nodeByQn.get('src/index.ts::fn:run')).toMatchObject({
    nodeType: 'function',
    name: 'run',
    filePath: 'src/index.ts',
    parentQualifiedName: 'file:src/index.ts',
    isExported: true,
    startLine: 2,
    endLine: 4,
  });

  const importsEdges = output.edges.filter((edge) => edge.edgeType === 'IMPORTS');
  const callsEdges = output.edges.filter((edge) => edge.edgeType === 'CALLS');

  expect(importsEdges).toEqual([
    {
      sourceQualifiedName: 'file:src/index.ts',
      targetQualifiedName: 'file:src/helper.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    },
  ]);

  expect(callsEdges).toHaveLength(1);
  expect(callsEdges[0]).toMatchObject({
    sourceQualifiedName: 'src/index.ts::fn:run',
    targetQualifiedName: 'src/helper.ts::fn:helper',
    edgeType: 'CALLS',
    callSiteLine: 3,
  });
  expect(callsEdges[0]?.callSiteSnippet).toContain('helper()');
}

async function confirmWorkerClosed(worker: IngestionWorker, timeoutMs = 10_000): Promise<boolean> {
  const obs = await closeWorkerWithTimeout(worker, timeoutMs);
  if (obs.closed) {
    return true;
  }
  if (obs.timedOut) {
    try {
      await obs.pendingClose;
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function obliterateAndCloseQueue(queueToClean: IngestionQueue): Promise<void> {
  try {
    await queueToClean.obliterate({ force: true });
  } catch {
    // Ignore cleanup errors if queue is already empty
  }
  await queueToClean.close();
}

function makeFakeIntegrationParserAdapter(
  onParse?: (supportedFiles: readonly string[]) => void,
): IngestionParserAdapter {
  const emptyOutput: AnalysisOutput = {
    nodes: [],
    edges: [],
    warnings: [],
    stats: {
      discoveredFilesCount: 0,
      parsedFilesCount: 0,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 0,
      folderNodeCount: 0,
      fileNodeCount: 0,
      functionNodeCount: 0,
      classNodeCount: 0,
      symbolNodeCount: 0,
      importsEdgeCount: 0,
      callsEdgeCount: 0,
      totalBytesRead: 0,
      truncatedWarningsCount: 0,
    },
  };
  return {
    parseWorkspace: (workspace) => {
      onParse?.(workspace.supportedFiles);
      return Promise.resolve({
        requestId: '11111111-2222-4333-8444-555555555555',
        output: emptyOutput,
        metrics: {
          endToEndDurationMs: 1,
          childAnalysisDurationMs: 1,
          childPreSendMemory: {
            baselineHeapUsedBytes: 1,
            postHeapUsedBytes: 1,
            baselineRssBytes: 1,
            postRssBytes: 1,
            maxRssKiB: 1,
          },
          serializedResponseBytes: 1,
          parentValidationDurationMs: 1,
          parentMemory: {
            baselineHeapUsedBytes: 1,
            postHeapUsedBytes: 1,
            baselineRssBytes: 1,
            postRssBytes: 1,
          },
          exitCode: 0,
          signal: null,
        },
        summary: {
          requestId: '11111111-2222-4333-8444-555555555555',
          discoveredFilesCount: 0,
          parsedFilesCount: 0,
          skippedSyntaxErrorFilesCount: 0,
          skippedOversizedFilesCount: 0,
          configFilesCount: 0,
          folderNodeCount: 0,
          fileNodeCount: 0,
          functionNodeCount: 0,
          classNodeCount: 0,
          symbolNodeCount: 0,
          importsEdgeCount: 0,
          callsEdgeCount: 0,
          totalBytesRead: 0,
          warningsCount: 0,
          truncatedWarningsCount: 0,
          childAnalysisDurationMs: 1,
          endToEndDurationMs: 1,
          parentValidationDurationMs: 1,
          serializedResponseBytes: 1,
          skipLoadingLibFiles: true,
        },
      });
    },
    isFatal: () => false,
    getState: () => 'IDLE',
  };
}

describe('BullMQ ingestion worker (PostgreSQL + Redis integration)', () => {
  const suffix = randomBytes(6).toString('hex');
  const testDbName = `archon_worker_test_${suffix}`;
  const queueName = `archon-ingestion-test-${suffix}`;
  const queuePrefix = `archon_test_${suffix}`;

  let redisUrl = '';
  let isolatedDbUrl = '';
  let adminPool: Pool | undefined;
  let dbClient: DbClient | undefined;
  let repository: IngestionRepository;
  let queue: IngestionQueue | undefined;
  let tempBaseDir = '';

  const activeWorkers: IngestionWorker[] = [];
  const outstandingCaseOwnership = new Set<string>();
  const logger = createLogger({ service: 'worker-integration-test', level: 'silent' });

  beforeAll(async () => {
    const env = loadEnv();
    redisUrl = env.REDIS_URL;

    // 1. Verify PostgreSQL reachability first
    const pgTarget = sanitizeDatabaseTarget(env.DATABASE_URL);
    adminPool = new Pool(buildPoolConfig({ databaseUrl: env.DATABASE_URL, max: 2 }));
    try {
      await adminPool.query('SELECT 1');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `PostgreSQL is unreachable at ${pgTarget}. Check DATABASE_URL in .env and run npm run docker:up. Root cause: ${detail}`,
        { cause: err },
      );
    }

    // 2. Verify Redis reachability via fast-fail client (reads REDIS_URL from env only)
    const redisTarget = sanitizeRedisTarget(redisUrl);
    const probeRedis = createFastFailRedisClient({ redisUrl, logger });
    try {
      await waitForRedisReady(probeRedis);
      const pong: string = await probeRedis.ping();
      if (pong !== 'PONG') {
        throw new Error(`Unexpected PING reply: ${pong}`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Redis is unreachable at ${redisTarget}. Check REDIS_URL in .env and run npm run docker:up. Root cause: ${detail}`,
        { cause: err },
      );
    } finally {
      await closeRedisClient(probeRedis);
    }

    // 3. Create isolated ephemeral Postgres database & run committed migrations
    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    isolatedDbUrl = replaceDatabaseName(env.DATABASE_URL, testDbName);
    dbClient = createDbClient({ databaseUrl: isolatedDbUrl, max: 5 });
    await runMigrations(dbClient.db);
    repository = createIngestionRepository(dbClient.db);

    // 4. Create isolated temp base dir & unique BullMQ queue
    tempBaseDir = await mkdtemp(path.join(os.tmpdir(), 'archon-worker-int-'));
    queue = createIngestionQueue({
      redisUrl,
      queueName,
      prefix: queuePrefix,
      backoffDelayMs: 50,
    });
  });

  afterAll(async () => {
    let allWorkersConfirmedClosed = outstandingCaseOwnership.size === 0;
    while (activeWorkers.length > 0) {
      const w = activeWorkers.pop();
      if (w) {
        const closed = await confirmWorkerClosed(w, 10_000);
        if (!closed) {
          allWorkersConfirmedClosed = false;
        }
      }
    }

    if (allWorkersConfirmedClosed && queue) {
      await obliterateAndCloseQueue(queue);
    }

    if (allWorkersConfirmedClosed && tempBaseDir) {
      await rm(tempBaseDir, { recursive: true, force: true });
    }

    if (allWorkersConfirmedClosed && dbClient) {
      await dbClient.close();
    }

    if (allWorkersConfirmedClosed && adminPool) {
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
      } finally {
        await adminPool.end();
      }
    }

    expect([...outstandingCaseOwnership]).toEqual([]);
    expect(allWorkersConfirmedClosed).toBe(true);
  });

  it('enqueues a real BullMQ job, extracts mocked tarball, transitions Postgres to ready, and purges temp dir', async () => {
    if (!queue) {
      throw new Error('Expected initialized queue');
    }

    const owner = 'pmndrs';
    const name = 'zustand';
    const sha = '9fed2eb2f3af672da9f7bf694b996df3831fc207';
    const prefix = 'pmndrs-zustand-9fed2eb';

    const created = await repository.createOrGetActive({
      githubUrl: `https://github.com/${owner}/${name}`,
      owner,
      name,
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 100,
    });

    const parsedRelativeFiles: string[] = [];
    const mockFetch = createTarballMockFetch(owner, name, sha, [
      { path: `${prefix}/`, typeFlag: '5' },
      { path: `${prefix}/src/index.ts`, content: 'export const store = 1;\n' },
      { path: `${prefix}/src/helper.ts`, content: 'export const helper = () => 2;\n' },
      { path: `${prefix}/package.json`, content: '{"name":"zustand"}\n' },
      { path: `${prefix}/README.md`, content: '# zustand\n' },
    ]);

    const processor = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 50,
      tempBaseDir,
      fetchImpl: mockFetch,
      parserAdapter: makeFakeIntegrationParserAdapter((files) => {
        parsedRelativeFiles.push(...files);
      }),
    });

    const worker = createIngestionWorker({
      redisUrl,
      queueName,
      prefix: queuePrefix,
      drainDelay: 1,
      processor,
      logger,
    });
    activeWorkers.push(worker);

    const completedPromise = new Promise<string>((resolve, reject) => {
      worker.once('completed', (job) => {
        resolve(job.id ?? '');
      });
      worker.once('failed', (_job, err) => {
        reject(err);
      });
    });

    const enqueued = await enqueueIngestionJob(queue, {
      repoId: created.repository.id,
      jobId: created.job.id,
      owner,
      name,
      commitSha: sha,
    });
    expect(enqueued.bullmqJobId).toBe(created.job.id);

    const completedId = await completedPromise;
    expect(completedId).toBe(created.job.id);

    const loaded = await repository.findJobWithRepository(created.job.id);
    expect(loaded?.repository.status).toBe('ready');
    expect(loaded?.repository.fileCount).toBe(2);
    expect(loaded?.repository.skippedFilesCount).toBe(1);
    expect(loaded?.job.stage).toBe('ready');
    expect(loaded?.job.progressPct).toBe(100);
    expect(loaded?.job.bullmqJobId).toBe(created.job.id);
    expect(parsedRelativeFiles).toEqual(['src/helper.ts', 'src/index.ts']);

    // Ephemeral extraction directory must be completely purged
    expect(await readdir(tempBaseDir)).toEqual([]);

    const closeObs = await closeWorkerWithTimeout(worker, 5_000);
    expect(closeObs.closed).toBe(true);
    activeWorkers.pop();
  });

  it('marks Postgres failed on non-retryable symlink violation and leaves temp dir empty', async () => {
    if (!queue) {
      throw new Error('Expected initialized queue');
    }

    const owner = 'acme';
    const name = 'bad-archive';
    const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const prefix = 'acme-bad-archive-aaaaaaa';

    const created = await repository.createOrGetActive({
      githubUrl: `https://github.com/${owner}/${name}`,
      owner,
      name,
      defaultBranch: 'main',
      commitSha: sha,
      sizeKb: 10,
    });

    const mockFetch = createTarballMockFetch(owner, name, sha, [
      { path: `${prefix}/src/index.ts`, content: 'export const ok = true;\n' },
      { path: `${prefix}/src/evil.ts`, typeFlag: '2', linkName: '/etc/passwd' },
    ]);

    const processor = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 50,
      tempBaseDir,
      fetchImpl: mockFetch,
      parserAdapter: makeFakeIntegrationParserAdapter(),
    });

    const worker = createIngestionWorker({
      redisUrl,
      queueName,
      prefix: queuePrefix,
      drainDelay: 1,
      processor,
      logger,
    });
    activeWorkers.push(worker);

    const failedPromise = new Promise<{ jobId: string; attemptsMade: number }>((resolve) => {
      worker.once('failed', (job) => {
        resolve({
          jobId: job?.id ?? '',
          attemptsMade: job?.attemptsMade ?? 0,
        });
      });
    });

    await enqueueIngestionJob(queue, {
      repoId: created.repository.id,
      jobId: created.job.id,
      owner,
      name,
      commitSha: sha,
    });

    const failedInfo = await failedPromise;
    expect(failedInfo.jobId).toBe(created.job.id);
    // UnrecoverableError stops after attempt 1 without burning retry 2
    expect(failedInfo.attemptsMade).toBe(1);

    const loaded = await repository.findJobWithRepository(created.job.id);
    expect(loaded?.repository.status).toBe('failed');
    expect(loaded?.repository.errorCode).toBe('TARBALL_SECURITY_VIOLATION');
    expect(loaded?.job.stage).toBe('failed');

    // Ephemeral extraction directory must still be completely empty after failure
    expect(await readdir(tempBaseDir)).toEqual([]);

    const closeObs = await closeWorkerWithTimeout(worker, 5_000);
    expect(closeObs.closed).toBe(true);
    activeWorkers.pop();
  });

  // === BATCH 4.3D.3.1-B: REAL COMPILED-PARSER INTEGRATION TESTS ===

  it('executes real compiled parser-child end-to-end with exact graph assertions, verified stage ordering, workspace lifecycle, and sequential adapter reuse', async () => {
    const caseQueueName = `${queueName}-real-success`;
    outstandingCaseOwnership.add(caseQueueName);
    const caseTempDir = await mkdtemp(path.join(tempBaseDir, 'real-success-'));
    const caseQueue = createIngestionQueue({
      redisUrl,
      queueName: caseQueueName,
      prefix: queuePrefix,
      backoffDelayMs: 50,
    });

    const repo1 = {
      owner: 'archon-real-a',
      name: 'fixture-one',
      sha: '1111111111111111111111111111111111111111',
      prefix: 'archon-real-a-fixture-one-1111111',
    };
    const repo2 = {
      owner: 'archon-real-b',
      name: 'fixture-two',
      sha: '2222222222222222222222222222222222222222',
      prefix: 'archon-real-b-fixture-two-2222222',
    };

    const mockFetch = createMultiRepoTarballMockFetch([
      { ...repo1, entries: makeStandardFixtureEntries(repo1.prefix) },
      { ...repo2, entries: makeStandardFixtureEntries(repo2.prefix) },
    ]);

    const adapterLogs: ProductionParserLogEvent[] = [];
    const adapter = createProductionParserAdapter({
      limits: { maxSupportedFiles: 500, maxTotalBytes: 50 * 1024 * 1024 },
      logger: (event) => {
        adapterLogs.push(event);
      },
    });

    const observedWorkspaces: string[] = [];
    const workspaceExistsDuringHandoff: boolean[] = [];
    const workspaceExistsAtSettlement: boolean[] = [];
    const activeChildDuringHandoff: boolean[] = [];
    const dbStatusAtHandoff: (string | undefined)[] = [];
    const dbProgressAtHandoff: (number | undefined)[] = [];
    const capturedResults: ValidatedAnalysisResult[] = [];
    let latestWorkspaceDir = '';

    const extractRepo: ExtractRepoFn = (opts, callback) =>
      withExtractedRepo(opts, async (workspace) => {
        latestWorkspaceDir = workspace.rootDir;
        observedWorkspaces.push(workspace.rootDir);
        expect(existsSync(workspace.rootDir)).toBe(true);
        return callback(workspace);
      });

    const baseProcessor = createIngestionJobProcessor({
      repository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 50,
      tempBaseDir: caseTempDir,
      fetchImpl: mockFetch,
      extractRepo,
      parserAdapter: adapter,
      analysisResultHandoff: async (ctx: AnalysisResultHandoffContext) => {
        workspaceExistsDuringHandoff.push(existsSync(latestWorkspaceDir));
        activeChildDuringHandoff.push(adapter.hasActiveChild());
        const midState = await repository.findJobWithRepository(ctx.jobId);
        dbStatusAtHandoff.push(midState?.repository.status);
        dbProgressAtHandoff.push(midState?.job.progressPct);
        capturedResults.push(ctx.result);
      },
    });

    const processor = async (job: IngestionBullMqJob): Promise<void> => {
      await baseProcessor(job);
      // Verify temp workspace was purged before processor settlement
      workspaceExistsAtSettlement.push(existsSync(latestWorkspaceDir));
    };

    const worker = createIngestionWorker({
      redisUrl,
      queueName: caseQueueName,
      prefix: queuePrefix,
      drainDelay: 1,
      processor,
      logger,
    });

    try {
      // --- Job 1: Real compiled parser end-to-end ---
      const created1 = await repository.createOrGetActive({
        githubUrl: `https://github.com/${repo1.owner}/${repo1.name}`,
        owner: repo1.owner,
        name: repo1.name,
        defaultBranch: 'main',
        commitSha: repo1.sha,
        sizeKb: 10,
      });

      const done1 = createDeferred<string>();
      const onCompleted1 = (job: IngestionBullMqJob): void => {
        if (job.id === created1.job.id) {
          done1.resolve(job.id);
        }
      };
      const onFailed1 = (job: IngestionBullMqJob | undefined, err: Error): void => {
        if (job?.id === created1.job.id) {
          done1.reject(err);
        }
      };
      worker.on('completed', onCompleted1);
      worker.on('failed', onFailed1);

      await enqueueIngestionJob(caseQueue, {
        repoId: created1.repository.id,
        jobId: created1.job.id,
        owner: repo1.owner,
        name: repo1.name,
        commitSha: repo1.sha,
      });

      const completedId1 = await withTimeout(done1.promise, 20_000, 'Job 1 completion');
      worker.off('completed', onCompleted1);
      worker.off('failed', onFailed1);
      expect(completedId1).toBe(created1.job.id);

      const loaded1 = await repository.findJobWithRepository(created1.job.id);
      expect(loaded1?.repository.status).toBe('ready');
      expect(loaded1?.repository.fileCount).toBe(2);
      expect(loaded1?.repository.skippedFilesCount).toBe(1);
      expect(loaded1?.job.stage).toBe('ready');
      expect(loaded1?.job.progressPct).toBe(STAGE_PROGRESS.ready);
      expect(adapter.hasActiveChild()).toBe(false);
      expect(adapter.isFatal()).toBe(false);
      expect(adapter.getState()).toBe('IDLE');

      // --- Job 2: Sequential reuse of the exact same healthy production adapter ---
      const created2 = await repository.createOrGetActive({
        githubUrl: `https://github.com/${repo2.owner}/${repo2.name}`,
        owner: repo2.owner,
        name: repo2.name,
        defaultBranch: 'main',
        commitSha: repo2.sha,
        sizeKb: 10,
      });

      const done2 = createDeferred<string>();
      const onCompleted2 = (job: IngestionBullMqJob): void => {
        if (job.id === created2.job.id) {
          done2.resolve(job.id);
        }
      };
      const onFailed2 = (job: IngestionBullMqJob | undefined, err: Error): void => {
        if (job?.id === created2.job.id) {
          done2.reject(err);
        }
      };
      worker.on('completed', onCompleted2);
      worker.on('failed', onFailed2);

      await enqueueIngestionJob(caseQueue, {
        repoId: created2.repository.id,
        jobId: created2.job.id,
        owner: repo2.owner,
        name: repo2.name,
        commitSha: repo2.sha,
      });

      const completedId2 = await withTimeout(done2.promise, 20_000, 'Job 2 completion');
      worker.off('completed', onCompleted2);
      worker.off('failed', onFailed2);
      expect(completedId2).toBe(created2.job.id);

      const loaded2 = await repository.findJobWithRepository(created2.job.id);
      expect(loaded2?.repository.status).toBe('ready');
      expect(loaded2?.repository.fileCount).toBe(2);
      expect(loaded2?.repository.skippedFilesCount).toBe(1);
      expect(loaded2?.job.stage).toBe('ready');
      expect(loaded2?.job.progressPct).toBe(STAGE_PROGRESS.ready);

      // Verify exact independently specified graph, metrics, and sequential reuse invariants
      expect(capturedResults).toHaveLength(2);
      const res1 = capturedResults[0];
      const res2 = capturedResults[1];
      if (res1 === undefined || res2 === undefined) {
        throw new Error('Expected two captured analysis results.');
      }

      assertExpectedStandardGraph(res1.output);
      assertExpectedStandardGraph(res2.output);
      expect(res1.output).toEqual(res2.output);

      expect(res1.requestId).toMatch(UUID_RE);
      expect(res2.requestId).toMatch(UUID_RE);
      expect(res1.requestId).not.toBe(res2.requestId);
      expect(res1.summary.skipLoadingLibFiles).toBe(true);
      expect(res2.summary.skipLoadingLibFiles).toBe(true);
      expect(res1.metrics.exitCode).toBe(0);
      expect(res1.metrics.signal).toBeNull();
      expect(res1.metrics.serializedResponseBytes).toBeGreaterThan(0);
      expect(res1.metrics.endToEndDurationMs).toBeGreaterThanOrEqual(0);
      expect(res2.metrics.exitCode).toBe(0);

      expect(dbStatusAtHandoff).toEqual(['building_graph', 'building_graph']);
      expect(dbProgressAtHandoff).toEqual([
        STAGE_PROGRESS.buildingGraph,
        STAGE_PROGRESS.buildingGraph,
      ]);
      expect(workspaceExistsDuringHandoff).toEqual([true, true]);
      expect(workspaceExistsAtSettlement).toEqual([false, false]);
      expect(activeChildDuringHandoff).toEqual([false, false]);
      expect(observedWorkspaces).toHaveLength(2);
      expect(observedWorkspaces[0]).not.toBe(observedWorkspaces[1]);

      expect(adapter.hasActiveChild()).toBe(false);
      expect(adapter.isFatal()).toBe(false);
      expect(adapter.getState()).toBe('IDLE');
      expect(adapterLogs.filter((e) => e.type === 'analysis_completed')).toHaveLength(2);
      expect(await readdir(caseTempDir)).toEqual([]);
    } finally {
      const closed = await confirmWorkerClosed(worker, 10_000);
      expect(closed).toBe(true);
      expect(adapter.hasActiveChild()).toBe(false);
      await obliterateAndCloseQueue(caseQueue);
      await rm(caseTempDir, { recursive: true, force: true });
      outstandingCaseOwnership.delete(caseQueueName);
    }
  });

  it('persists deterministic real compiled-child SIZE_LIMIT_EXCEEDED rejection as non-retryable failure without burning retries or leaking source/paths', async () => {
    const caseQueueName = `${queueName}-real-size-reject`;
    outstandingCaseOwnership.add(caseQueueName);
    const caseTempDir = await mkdtemp(path.join(tempBaseDir, 'real-size-reject-'));
    const caseQueue = createIngestionQueue({
      redisUrl,
      queueName: caseQueueName,
      prefix: queuePrefix,
      backoffDelayMs: 50,
    });

    const sourceSentinel = 'ARCHON_REAL_CHILD_SOURCE_SENTINEL_404';
    const owner = 'archon-real-c';
    const name = 'over-byte-budget';
    const sha = '3333333333333333333333333333333333333333';
    const prefix = 'archon-real-c-over-byte-budget-3333333';

    const mockFetch = createTarballMockFetch(owner, name, sha, [
      { path: `${prefix}/`, typeFlag: '5' },
      {
        path: `${prefix}/src/helper.ts`,
        content: `export const sentinel = "${sourceSentinel}";\nexport function helper(): number { return 1; }\n`,
      },
      { path: `${prefix}/src/index.ts`, content: REAL_PARSER_INDEX_SOURCE },
    ]);

    const adapterLogs: ProductionParserLogEvent[] = [];
    // Valid test-only lower total-bytes cap (32 bytes): passes extractor (50 MiB), adapter config
    // validation, and parent IPC validation, then fails deterministically inside real parser-child.js
    const adapter = createProductionParserAdapter({
      limits: { maxTotalBytes: 32 },
      logger: (event) => {
        adapterLogs.push(event);
      },
    });

    const processorLogs: { level: string; obj: unknown; msg: string }[] = [];
    const capturingLogger = {
      info(obj: unknown, msg?: string): void {
        processorLogs.push({ level: 'info', obj, msg: msg ?? '' });
      },
      warn(obj: unknown, msg?: string): void {
        processorLogs.push({ level: 'warn', obj, msg: msg ?? '' });
      },
      error(obj: unknown, msg?: string): void {
        processorLogs.push({ level: 'error', obj, msg: msg ?? '' });
      },
    };

    let capturedWorkspaceDir = '';
    let handoffCalled = false;
    const extractRepo: ExtractRepoFn = (opts, callback) =>
      withExtractedRepo(opts, async (workspace) => {
        capturedWorkspaceDir = workspace.rootDir;
        return callback(workspace);
      });

    const processor = createIngestionJobProcessor({
      repository,
      logger: capturingLogger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 50,
      tempBaseDir: caseTempDir,
      fetchImpl: mockFetch,
      extractRepo,
      parserAdapter: adapter,
      analysisResultHandoff: () => {
        handoffCalled = true;
        return Promise.resolve();
      },
    });

    const worker = createIngestionWorker({
      redisUrl,
      queueName: caseQueueName,
      prefix: queuePrefix,
      drainDelay: 1,
      processor,
      logger,
    });

    try {
      const created = await repository.createOrGetActive({
        githubUrl: `https://github.com/${owner}/${name}`,
        owner,
        name,
        defaultBranch: 'main',
        commitSha: sha,
        sizeKb: 10,
      });

      const failedDeferred = createDeferred<{
        readonly jobId: string;
        readonly attemptsMade: number;
      }>();
      worker.on('failed', (job) => {
        if (job?.id === created.job.id) {
          failedDeferred.resolve({
            jobId: job.id,
            attemptsMade: job.attemptsMade,
          });
        }
      });

      await enqueueIngestionJob(caseQueue, {
        repoId: created.repository.id,
        jobId: created.job.id,
        owner,
        name,
        commitSha: sha,
      });

      const failedInfo = await withTimeout(failedDeferred.promise, 20_000, 'Test C failure event');
      expect(failedInfo.jobId).toBe(created.job.id);
      // Non-retryable UnrecoverableError MUST stop on attempt 1 without burning retry 2
      expect(failedInfo.attemptsMade).toBe(1);
      expect(handoffCalled).toBe(false);

      // Confirm the real compiled child executed and exited cleanly with exitCode 0 returning SIZE_LIMIT_EXCEEDED
      const failedLog = adapterLogs.find((e) => e.type === 'analysis_failed');
      expect(failedLog?.type).toBe('analysis_failed');
      if (failedLog?.type === 'analysis_failed') {
        expect(failedLog.error.runnerCode).toBe('CORE_ANALYSIS_ERROR');
        expect(failedLog.error.coreErrorCode).toBe('SIZE_LIMIT_EXCEEDED');
        expect(failedLog.error.persistedCode).toBe('PARSER_SIZE_LIMIT_EXCEEDED');
        expect(failedLog.error.disposition).toBe('non_retryable');
        expect(failedLog.error.retryable).toBe(false);
        expect(failedLog.error.exitCode).toBe(0);
        expect(failedLog.error.signal).toBeNull();
        expect(failedLog.error.requestId).toMatch(UUID_RE);
      }

      const loaded = await repository.findJobWithRepository(created.job.id);
      expect(loaded?.repository.status).toBe('failed');
      expect(loaded?.repository.errorCode).toBe('PARSER_SIZE_LIMIT_EXCEEDED');
      expect(loaded?.repository.errorMessage).toBe('Repository exceeds maximum allowed byte size.');
      expect(loaded?.job.stage).toBe('failed');
      expect(loaded?.job.errorDetail).toBe('SIZE_LIMIT_EXCEEDED');

      const bullJob = await caseQueue.getJob(created.job.id);
      const serializedOutputs = JSON.stringify({
        repo: loaded?.repository,
        job: loaded?.job,
        failedReason: bullJob?.failedReason,
        stacktrace: bullJob?.stacktrace,
        adapterLogs,
        processorLogs,
      });
      expect(serializedOutputs).not.toContain(sourceSentinel);
      expect(capturedWorkspaceDir.length).toBeGreaterThan(0);
      expect(serializedOutputs).not.toContain(capturedWorkspaceDir);

      expect(adapter.hasActiveChild()).toBe(false);
      expect(adapter.isFatal()).toBe(false);
      expect(adapter.getState()).toBe('IDLE');
      expect(existsSync(capturedWorkspaceDir)).toBe(false);
      expect(await readdir(caseTempDir)).toEqual([]);
    } finally {
      const closed = await confirmWorkerClosed(worker, 10_000);
      expect(closed).toBe(true);
      expect(adapter.hasActiveChild()).toBe(false);
      await obliterateAndCloseQueue(caseQueue);
      await rm(caseTempDir, { recursive: true, force: true });
      outstandingCaseOwnership.delete(caseQueueName);
    }
  });

  it('retries handoff failure after real compiled-child parsing up to attempts=2, sanitizes sensitive sentinels across DB/BullMQ/logs, and cleans all workspaces', async () => {
    const caseQueueName = `${queueName}-handoff-retry`;
    outstandingCaseOwnership.add(caseQueueName);
    const caseTempDir = await mkdtemp(path.join(tempBaseDir, 'handoff-retry-'));
    // Short isolated backoff; the processor wrapper observes DB state before attempt 2.
    const caseQueue = createIngestionQueue({
      redisUrl,
      queueName: caseQueueName,
      prefix: queuePrefix,
      attempts: 2,
      backoffDelayMs: 200,
    });

    const handoffSentinel = 'ARCHON_HANDOFF_SECRET_SENTINEL_909';
    const owner = 'archon-real-d';
    const name = 'handoff-retry-repo';
    const sha = '4444444444444444444444444444444444444444';
    const prefix = 'archon-real-d-handoff-retry-repo-4444444';

    const mockFetch = createTarballMockFetch(owner, name, sha, makeStandardFixtureEntries(prefix));

    const adapter = createProductionParserAdapter({
      limits: { maxSupportedFiles: 500, maxTotalBytes: 50 * 1024 * 1024 },
    });

    const processorLogs: { level: string; obj: unknown; msg: string }[] = [];
    const capturingLogger = {
      info(obj: unknown, msg?: string): void {
        processorLogs.push({ level: 'info', obj, msg: msg ?? '' });
      },
      warn(obj: unknown, msg?: string): void {
        processorLogs.push({ level: 'warn', obj, msg: msg ?? '' });
      },
      error(obj: unknown, msg?: string): void {
        processorLogs.push({ level: 'error', obj, msg: msg ?? '' });
      },
    };

    const capturedRequestIds: string[] = [];
    const capturedGraphs: AnalysisOutput[] = [];
    const observedWorkspaces: string[] = [];
    const dbStatusBeforeAttempt2: (string | undefined)[] = [];
    let handoffAttempts = 0;

    const extractRepo: ExtractRepoFn = (opts, callback) =>
      withExtractedRepo(opts, async (workspace) => {
        observedWorkspaces.push(workspace.rootDir);
        return callback(workspace);
      });

    const baseProcessor = createIngestionJobProcessor({
      repository,
      logger: capturingLogger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 50,
      tempBaseDir: caseTempDir,
      fetchImpl: mockFetch,
      extractRepo,
      parserAdapter: adapter,
      analysisResultHandoff: (ctx) => {
        handoffAttempts += 1;
        capturedRequestIds.push(ctx.result.requestId);
        capturedGraphs.push(ctx.result.output);

        return Promise.reject(
          new Error(`Simulated DB handoff error containing ${handoffSentinel}`),
        );
      },
    });

    const processor = async (job: IngestionBullMqJob): Promise<void> => {
      if (job.attemptsMade === 1) {
        const priorState = await repository.findJobWithRepository(job.data.jobId);
        dbStatusBeforeAttempt2.push(priorState?.repository.status);
      }

      await baseProcessor(job);
    };

    const worker = createIngestionWorker({
      redisUrl,
      queueName: caseQueueName,
      prefix: queuePrefix,
      drainDelay: 1,
      processor,
      logger,
    });

    try {
      const created = await repository.createOrGetActive({
        githubUrl: `https://github.com/${owner}/${name}`,
        owner,
        name,
        defaultBranch: 'main',
        commitSha: sha,
        sizeKb: 10,
      });

      const observedFailedAttempts: number[] = [];
      const terminalFailed = createDeferred<{ readonly attemptsMade: number }>();

      worker.on('failed', (job) => {
        if (job?.id !== created.job.id) {
          return;
        }

        observedFailedAttempts.push(job.attemptsMade);

        if (job.attemptsMade >= 2) {
          terminalFailed.resolve({ attemptsMade: job.attemptsMade });
        }
      });

      await enqueueIngestionJob(caseQueue, {
        repoId: created.repository.id,
        jobId: created.job.id,
        owner,
        name,
        commitSha: sha,
      });

      const finalFail = await withTimeout(
        terminalFailed.promise,
        25_000,
        'Test D terminal failed event (attempt 2 of 2)',
      );
      expect(finalFail.attemptsMade).toBe(2);
      expect(observedFailedAttempts).toEqual([1, 2]);
      expect(handoffAttempts).toBe(2);
      expect(capturedRequestIds).toHaveLength(2);
      expect(capturedRequestIds[0]).toMatch(UUID_RE);
      expect(capturedRequestIds[1]).toMatch(UUID_RE);
      expect(capturedRequestIds[0]).not.toBe(capturedRequestIds[1]);

      // Attempt 1 left the repository in building_graph before attempt 2 began.
      expect(dbStatusBeforeAttempt2).toEqual(['building_graph']);

      expect(capturedGraphs).toHaveLength(2);
      for (const graph of capturedGraphs) {
        assertExpectedStandardGraph(graph);
      }

      const loaded = await repository.findJobWithRepository(created.job.id);
      expect(loaded?.repository.status).toBe('failed');
      expect(loaded?.repository.errorCode).toBe('WORKER_ERROR');
      expect(loaded?.repository.errorMessage).toBe(
        'An unexpected error occurred during repository ingestion.',
      );
      expect(loaded?.job.stage).toBe('failed');
      expect(loaded?.job.errorDetail).toBe('WORKER_ERROR');

      const bullJob = await caseQueue.getJob(created.job.id);
      expect(bullJob).toBeDefined();
      expect(await bullJob?.getState()).toBe('failed');
      expect(bullJob?.failedReason).toBe(
        'An unexpected error occurred during repository ingestion.',
      );

      // Sensitive sentinel MUST NOT appear in PostgreSQL, BullMQ failedReason/stacktrace, or logs
      const allSerialized = JSON.stringify({
        repository: loaded?.repository,
        job: loaded?.job,
        failedReason: bullJob?.failedReason,
        stacktrace: bullJob?.stacktrace,
        processorLogs,
      });
      expect(allSerialized).not.toContain(handoffSentinel);

      expect(observedWorkspaces).toHaveLength(2);
      for (const dir of observedWorkspaces) {
        expect(existsSync(dir)).toBe(false);
      }
      expect(await readdir(caseTempDir)).toEqual([]);
      expect(adapter.hasActiveChild()).toBe(false);
      expect(adapter.isFatal()).toBe(false);
      expect(adapter.getState()).toBe('IDLE');
    } finally {
      const closed = await confirmWorkerClosed(worker, 10_000);
      expect(closed).toBe(true);
      expect(adapter.hasActiveChild()).toBe(false);
      await obliterateAndCloseQueue(caseQueue);
      await rm(caseTempDir, { recursive: true, force: true });
      outstandingCaseOwnership.delete(caseQueueName);
    }
  });

  // Note: Post-parser handoff cancellation integration test (NOT cancellation of an active parser child)
  it('gracefully shuts down via shared lifecycle during an active post-parser handoff without committing ready or prematurely disposing DB/Redis', async () => {
    const caseQueueName = `${queueName}-shutdown-handoff`;
    outstandingCaseOwnership.add(caseQueueName);
    const caseTempDir = await mkdtemp(path.join(tempBaseDir, 'shutdown-handoff-'));

    // Dedicated test-owned DB, Redis, Queue, Worker, Adapter & Lifecycle (never touches shared suite handles)
    const testDbClient = createDbClient({ databaseUrl: isolatedDbUrl, max: 3 });
    const testRepository = createIngestionRepository(testDbClient.db);
    const testRedis = createFastFailRedisClient({ redisUrl, logger });
    await waitForRedisReady(testRedis);

    // Single-attempt job explicitly used to deterministically assert terminal cancellation without a replacement worker
    const testQueue = createIngestionQueue({
      redisUrl,
      queueName: caseQueueName,
      prefix: queuePrefix,
      attempts: 1,
    });

    const owner = 'archon-real-e';
    const name = 'shutdown-handoff-repo';
    const sha = '5555555555555555555555555555555555555555';
    const prefix = 'archon-real-e-shutdown-handoff-repo-5555555';

    const mockFetch = createTarballMockFetch(owner, name, sha, makeStandardFixtureEntries(prefix));

    const events: string[] = [];
    const recordedExitCodes: (0 | 1)[] = [];
    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 10_000,
      logger,
      setExitCode: (code) => {
        recordedExitCodes.push(code);
      },
    });
    lifecycle.beginStartup();

    const adapter = createProductionParserAdapter({
      limits: { maxSupportedFiles: 500, maxTotalBytes: 50 * 1024 * 1024 },
      onFatalState: (fatal) => {
        lifecycle.triggerFatal(fatal);
      },
    });

    const handoffEntered = createDeferred();
    const releaseHandoff = createDeferred();
    let capturedWorkspaceDir = '';
    let capturedHandoffSignal: AbortSignal | undefined;
    let capturedResult: ValidatedAnalysisResult | undefined;

    const extractRepo: ExtractRepoFn = (opts, callback) =>
      withExtractedRepo(opts, async (workspace) => {
        capturedWorkspaceDir = workspace.rootDir;
        return callback(workspace);
      });

    const baseProcessor = createIngestionJobProcessor({
      repository: testRepository,
      logger,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      heartbeatIntervalMs: 50,
      tempBaseDir: caseTempDir,
      fetchImpl: mockFetch,
      extractRepo,
      parserAdapter: adapter,
      shutdownSignal: lifecycle.shutdownSignal,
      fatalSignal: lifecycle.fatalSignal,
      isFatalState: lifecycle.isFatal,
      onInfrastructureFailure: (err) => {
        lifecycle.triggerInfrastructureFailure(err);
      },
      analysisResultHandoff: async (ctx) => {
        capturedHandoffSignal = ctx.signal;
        capturedResult = ctx.result;
        handoffEntered.resolve();
        await releaseHandoff.promise;
      },
    });

    const processor = lifecycle.wrapProcessor(baseProcessor, {
      delegateStoppedToProcessor: true,
    });

    const testWorker = createIngestionWorker({
      redisUrl,
      queueName: caseQueueName,
      prefix: queuePrefix,
      drainDelay: 1,
      autorun: false,
      processor,
      logger,
    });

    let workerCloseCalls = 0;
    const workerCloseStarted = createDeferred();
    lifecycle.setWorker({
      close: async (force?: boolean) => {
        workerCloseCalls += 1;
        events.push(`worker.close.start:${String(force)}`);
        workerCloseStarted.resolve();
        await testWorker.close(force);
        events.push('worker.close.done');
      },
    });
    lifecycle.setQueue({
      close: async () => {
        events.push('queue.close');
        await testQueue.close();
      },
    });
    lifecycle.addRedisClient({
      quit: async () => {
        events.push('redis.quit');
        return testRedis.quit();
      },
      disconnect: () => {
        events.push('redis.disconnect');
        testRedis.disconnect();
      },
    });
    lifecycle.setCloseDb(async () => {
      events.push('db.close');
      await testDbClient.close();
    });

    lifecycle.markRunning();
    void testWorker.run().catch(() => undefined);

    try {
      const created = await testRepository.createOrGetActive({
        githubUrl: `https://github.com/${owner}/${name}`,
        owner,
        name,
        defaultBranch: 'main',
        commitSha: sha,
        sizeKb: 10,
      });

      await enqueueIngestionJob(testQueue, {
        repoId: created.repository.id,
        jobId: created.job.id,
        owner,
        name,
        commitSha: sha,
      });

      // Synchronize deterministically on post-parser handoff entry (zero guessed sleep)
      await withTimeout(handoffEntered.promise, 20_000, 'post-parser handoff entry');

      // At handoff boundary: real parser already completed, workspace exists, DB is building_graph
      expect(capturedResult).toBeDefined();
      if (capturedResult !== undefined) {
        assertExpectedStandardGraph(capturedResult.output);
      }
      expect(adapter.hasActiveChild()).toBe(false);
      expect(adapter.getState()).toBe('IDLE');
      expect(existsSync(capturedWorkspaceDir)).toBe(true);
      expect(capturedHandoffSignal).toBe(lifecycle.shutdownSignal);
      expect(capturedHandoffSignal?.aborted).toBe(false);

      const midLoaded = await repository.findJobWithRepository(created.job.id);
      expect(midLoaded?.repository.status).toBe('building_graph');
      expect(midLoaded?.job.stage).toBe('building_graph');

      // Trigger graceful SIGTERM shutdown while handoff is held pending
      const shutdownPromise = lifecycle.shutdown('SIGTERM');
      expect(lifecycle.shutdownSignal.aborted).toBe(true);
      expect(capturedHandoffSignal?.aborted).toBe(true);

      // Synchronize on actual worker.close() invocation while the handoff remains pending.
      await withTimeout(workerCloseStarted.promise, 5_000, 'worker close initiation');
      expect(workerCloseCalls).toBe(1);
      expect(existsSync(capturedWorkspaceDir)).toBe(true);
      expect(events).toEqual(['worker.close.start:undefined']);

      // Release handoff -> processor observes cancellation BEFORE ready, persists failed, cleans workspace
      releaseHandoff.resolve();
      const outcome = await withTimeout(shutdownPromise, 15_000, 'graceful lifecycle shutdown');

      expect(outcome.confirmed).toBe(true);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.fatal).toBe(false);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.phase).toBe('closed');
      expect(recordedExitCodes.at(-1)).toBe(0);
      expect(workerCloseCalls).toBe(1);

      // Verify strict resource disposal order: worker -> queue -> redis -> db
      expect(events).toEqual([
        'worker.close.start:undefined',
        'worker.close.done',
        'queue.close',
        'redis.quit',
        'db.close',
      ]);

      // Verify via still-open shared suite repository that DB persisted cancellation and NEVER ready
      const finalLoaded = await repository.findJobWithRepository(created.job.id);
      expect(finalLoaded?.repository.status).toBe('failed');
      expect(finalLoaded?.repository.errorCode).toBe('INGESTION_CANCELLED');
      expect(finalLoaded?.job.stage).toBe('failed');
      expect(finalLoaded?.job.errorDetail).toBe('INGESTION_CANCELLED');

      expect(existsSync(capturedWorkspaceDir)).toBe(false);
      expect(await readdir(caseTempDir)).toEqual([]);
      expect(adapter.hasActiveChild()).toBe(false);
      expect(adapter.isFatal()).toBe(false);
      expect(adapter.getState()).toBe('IDLE');
    } finally {
      // Always unblock the handoff before awaiting confirmed lifecycle ownership release.
      releaseHandoff.resolve();
      let teardownOutcome = await lifecycle.shutdown('EXPLICIT');

      if (!teardownOutcome.confirmed && teardownOutcome.pendingCleanup !== undefined) {
        teardownOutcome = await withTimeout(
          teardownOutcome.pendingCleanup,
          10_000,
          'deferred lifecycle cleanup',
        );
      }

      expect(teardownOutcome.confirmed).toBe(true);
      expect(adapter.hasActiveChild()).toBe(false);

      // Remove isolated test queue keys from Redis only after ownership is confirmed.
      const cleanupQueue = createIngestionQueue({
        redisUrl,
        queueName: caseQueueName,
        prefix: queuePrefix,
      });
      await obliterateAndCloseQueue(cleanupQueue);
      await rm(caseTempDir, { recursive: true, force: true });
      outstandingCaseOwnership.delete(caseQueueName);
    }
  });
});
