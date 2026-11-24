import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbClient, createIngestionRepository, sanitizeDatabaseTarget } from '@archon/db';
import { createLogger, loadEnv } from '@archon/shared';
import {
  DEFAULT_INGESTION_QUEUE_NAME,
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
  createFastFailRedisClient,
  createIngestionJobProcessor,
  createIngestionQueue,
  createIngestionWorker,
  sanitizeRedisTarget,
  shutdownWorkerResources,
  waitForRedisReady,
  type IngestionWorker,
} from '@archon/worker';
import { buildApp } from './app.js';
import { GitHubPrecheckClient } from './github/precheck.js';
import { createBullMqIngestionEnqueuer } from './queue/enqueuer.js';
import { createRedisRateLimitStoreConfig } from './rate-limit.js';
import { createRedisRateLimitStore } from './redis-rate-limit-store.js';

const STARTUP_REDIS_READY_TIMEOUT_MS = 5_000;

export async function startServer(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });
  const dbTarget = sanitizeDatabaseTarget(env.DATABASE_URL);
  const redisTarget = sanitizeRedisTarget(env.REDIS_URL);

  const dbClient = createDbClient({ databaseUrl: env.DATABASE_URL });
  const repository = createIngestionRepository(dbClient.db);

  const apiRedis = createFastFailRedisClient({
    redisUrl: env.REDIS_URL,
    logger,
    reconnect: true,
  });

  // Decision 2: wait briefly for Redis on startup; if unreachable, log warning and boot in degraded mode
  try {
    await waitForRedisReady(apiRedis, STARTUP_REDIS_READY_TIMEOUT_MS);
    logger.info({ redisTarget }, 'API Redis client ready');
  } catch (err) {
    logger.warn(
      {
        redisTarget,
        err: err instanceof Error ? err.message : String(err),
      },
      'Redis unavailable at startup; starting API in degraded mode',
    );
  }

  const checkRedisHealth = async (): Promise<boolean> => {
    if (apiRedis.status !== 'ready') {
      return false;
    }
    try {
      const pong: string = await apiRedis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  };

  const ingestionQueue = createIngestionQueue({
    redisUrl: env.REDIS_URL,
    queueName: DEFAULT_INGESTION_QUEUE_NAME,
    skipWaitingForReady: true,
  });

  const enqueuer = createBullMqIngestionEnqueuer({
    queue: ingestionQueue,
  });

  const rateLimitStoreCtor = createRedisRateLimitStore({
    client: apiRedis,
    logger,
  });
  const rateLimitStore = createRedisRateLimitStoreConfig(rateLimitStoreCtor);

  const githubPrecheck = new GitHubPrecheckClient({
    token: env.GITHUB_TOKEN,
    maxSupportedFiles: env.MAX_SUPPORTED_FILES,
    maxRepoSizeMb: env.MAX_REPO_SIZE_MB,
    logger,
  });

  let embeddedWorker: IngestionWorker | undefined;
  if (env.RUN_EMBEDDED_WORKER) {
    const processor = createIngestionJobProcessor({
      repository,
      logger,
      githubToken: env.GITHUB_TOKEN,
      maxSupportedFiles: env.MAX_SUPPORTED_FILES,
      maxRepoSizeMb: env.MAX_REPO_SIZE_MB,
    });
    embeddedWorker = createIngestionWorker({
      redisUrl: env.REDIS_URL,
      queueName: DEFAULT_INGESTION_QUEUE_NAME,
      processor,
      logger,
    });
    logger.info(
      { queueName: DEFAULT_INGESTION_QUEUE_NAME, redisTarget },
      'Embedded BullMQ ingestion worker started',
    );
  }

  const app = await buildApp({
    env,
    logger,
    repository,
    checkDbHealth: () => dbClient.ping(),
    checkRedisHealth,
    githubPrecheck,
    enqueuer,
    rateLimitStore,
  });

  const shutdownState = { inProgress: false };
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownState.inProgress) {
      return;
    }
    shutdownState.inProgress = true;
    logger.info({ signal }, 'API graceful shutdown initiated');

    let httpExitCode: 0 | 1 = 0;
    logger.info('Shutdown step 0/4: closing Fastify HTTP server');
    try {
      await app.close();
    } catch (err) {
      logger.error({ err, signal }, 'Error closing Fastify server');
      httpExitCode = 1;
    }

    const workerShutdown = await shutdownWorkerResources({
      worker: embeddedWorker,
      queue: ingestionQueue,
      redisClients: [apiRedis],
      closeDb: () => dbClient.close(),
      workerCloseTimeoutMs: DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
      logger,
    });

    const exitCode: 0 | 1 = httpExitCode === 1 || workerShutdown.exitCode === 1 ? 1 : 0;
    logger.info({ signal, exitCode }, 'API shutdown complete');
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  try {
    await app.listen({ host: '0.0.0.0', port: env.PORT });
    logger.info(
      {
        port: env.PORT,
        nodeEnv: env.NODE_ENV,
        dbTarget,
        redisTarget,
        trustProxyHops: env.TRUST_PROXY_HOPS,
        webOrigin: env.WEB_ORIGIN,
        embeddedWorker: env.RUN_EMBEDDED_WORKER,
      },
      'Archon API server listening',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to start Archon API server');
    await shutdownWorkerResources({
      worker: embeddedWorker,
      queue: ingestionQueue,
      redisClients: [apiRedis],
      closeDb: () => dbClient.close(),
      workerCloseTimeoutMs: DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
      logger,
    });
    throw new Error('Failed to start Archon API server', { cause: err });
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  startServer().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal API startup error: ${message}\n`);
    process.exitCode = 1;
  });
}
