import { randomBytes } from 'node:crypto';
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
import { createLogger, loadEnv } from '@archon/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGzippedUstar, type UstarFixtureEntry } from './extractor/tar-test-utils.js';
import { createIngestionJobProcessor } from './processor.js';
import {
  closeWorkerWithTimeout,
  createIngestionQueue,
  createIngestionWorker,
  enqueueIngestionJob,
  type IngestionQueue,
  type IngestionWorker,
} from './queue.js';
import {
  closeRedisClient,
  createFastFailRedisClient,
  waitForRedisReady,
  sanitizeRedisTarget,
} from './redis.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

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

describe('BullMQ ingestion worker (PostgreSQL + Redis integration)', () => {
  const suffix = randomBytes(6).toString('hex');
  const testDbName = `archon_worker_test_${suffix}`;
  const queueName = `archon-ingestion-test-${suffix}`;
  const queuePrefix = `archon_test_${suffix}`;

  let redisUrl = '';
  let adminPool: Pool | undefined;
  let dbClient: DbClient | undefined;
  let repository: IngestionRepository;
  let queue: IngestionQueue | undefined;
  let tempBaseDir = '';

  const activeWorkers: IngestionWorker[] = [];
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
    const isolatedDbUrl = replaceDatabaseName(env.DATABASE_URL, testDbName);
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
    while (activeWorkers.length > 0) {
      const w = activeWorkers.pop();
      if (w) {
        await closeWorkerWithTimeout(w, 5_000);
      }
    }

    if (queue) {
      try {
        await queue.obliterate({ force: true });
      } catch {
        // Ignore cleanup errors if queue is already empty
      }
      await queue.close();
    }

    if (tempBaseDir) {
      await rm(tempBaseDir, { recursive: true, force: true });
    }

    if (dbClient) {
      await dbClient.close();
    }

    if (adminPool) {
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
      } finally {
        await adminPool.end();
      }
    }
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
      parseWorkspace: (workspace) => {
        parsedRelativeFiles.push(...workspace.supportedFiles);
        return Promise.resolve();
      },
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

    await closeWorkerWithTimeout(worker, 5_000);
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

    await closeWorkerWithTimeout(worker, 5_000);
    activeWorkers.pop();
  });
});
