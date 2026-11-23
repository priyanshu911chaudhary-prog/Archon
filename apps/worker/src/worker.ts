import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbClient, createIngestionRepository, sanitizeDatabaseTarget } from '@archon/db';
import { createLogger, loadEnv } from '@archon/shared';
import { createIngestionJobProcessor } from './processor.js';
import {
  DEFAULT_INGESTION_QUEUE_NAME,
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
  createIngestionQueue,
  createIngestionWorker,
  shutdownWorkerResources,
} from './queue.js';
import { createFastFailRedisClient, waitForRedisReady, sanitizeRedisTarget } from './redis.js';

export async function startWorker(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });
  const dbTarget = sanitizeDatabaseTarget(env.DATABASE_URL);
  const redisTarget = sanitizeRedisTarget(env.REDIS_URL);

  const dbClient = createDbClient({ databaseUrl: env.DATABASE_URL });
  const healthRedis = createFastFailRedisClient({ redisUrl: env.REDIS_URL, logger });

  const dbOk = await dbClient.ping();
  if (!dbOk) {
    await shutdownWorkerResources({
      redisClients: [healthRedis],
      closeDb: () => dbClient.close(),
      logger,
    });
    throw new Error(`PostgreSQL is unreachable at ${dbTarget}.`);
  }

  try {
    await waitForRedisReady(healthRedis);
    const pong: string = await healthRedis.ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected Redis PING response: ${pong}`);
    }
  } catch (err) {
    await shutdownWorkerResources({
      redisClients: [healthRedis],
      closeDb: () => dbClient.close(),
      logger,
    });
    throw new Error(`Redis is unreachable at ${redisTarget}.`, { cause: err });
  }

  const repository = createIngestionRepository(dbClient.db);
  const processor = createIngestionJobProcessor({
    repository,
    logger,
    githubToken: env.GITHUB_TOKEN,
    maxSupportedFiles: env.MAX_SUPPORTED_FILES,
    maxRepoSizeMb: env.MAX_REPO_SIZE_MB,
  });

  const queue = createIngestionQueue({
    redisUrl: env.REDIS_URL,
    queueName: DEFAULT_INGESTION_QUEUE_NAME,
  });

  const worker = createIngestionWorker({
    redisUrl: env.REDIS_URL,
    queueName: DEFAULT_INGESTION_QUEUE_NAME,
    processor,
    logger,
  });

  const shutdownState = { inProgress: false };
  const handleShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownState.inProgress) {
      return;
    }
    shutdownState.inProgress = true;
    logger.info({ signal }, 'Worker graceful shutdown initiated');

    const { exitCode } = await shutdownWorkerResources({
      worker,
      queue,
      redisClients: [healthRedis],
      closeDb: () => dbClient.close(),
      workerCloseTimeoutMs: DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
      logger,
    });

    logger.info({ signal, exitCode }, 'Worker shutdown complete');
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => {
    void handleShutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void handleShutdown('SIGTERM');
  });

  logger.info(
    {
      queueName: DEFAULT_INGESTION_QUEUE_NAME,
      dbTarget,
      redisTarget,
      nodeEnv: env.NODE_ENV,
    },
    'Archon BullMQ worker listening',
  );
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  startWorker().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal worker startup error: ${message}\n`);
    process.exitCode = 1;
  });
}
