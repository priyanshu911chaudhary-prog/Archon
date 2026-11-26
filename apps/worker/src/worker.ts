import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbClient, createIngestionRepository, sanitizeDatabaseTarget } from '@archon/db';
import { createLogger, loadEnv } from '@archon/shared';
import { createWorkerServiceLifecycle } from './lifecycle.js';
import {
  PRODUCTION_PARSER_CONFIG,
  createProductionParserAdapter,
  noopAnalysisResultHandoff,
  preflightProductionParserEntrypoint,
  resolveProductionParserLimitsFromEnv,
  type ProductionParserLogEvent,
} from './parser-integration.js';
import { createIngestionJobProcessor } from './processor.js';
import {
  DEFAULT_INGESTION_QUEUE_NAME,
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
  createIngestionQueue,
  createIngestionWorker,
} from './queue.js';
import { createFastFailRedisClient, waitForRedisReady, sanitizeRedisTarget } from './redis.js';

function logParserEvent(
  logger: Pick<ReturnType<typeof createLogger>, 'info' | 'warn' | 'error'>,
  event: ProductionParserLogEvent,
): void {
  if (event.type === 'analysis_completed') {
    logger.info({ summary: event.summary }, 'Isolated static analysis completed');
  } else if (event.type === 'analysis_failed') {
    logger.warn({ parserError: event.error }, 'Isolated static analysis failed');
  } else {
    logger.error({ fatal: event.fatal }, 'Isolated parser entered fatal supervision state');
  }
}

export async function startWorker(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });
  const dbTarget = sanitizeDatabaseTarget(env.DATABASE_URL);
  const redisTarget = sanitizeRedisTarget(env.REDIS_URL);

  const lifecycle = createWorkerServiceLifecycle({
    serviceName: 'worker',
    closeTimeoutMs: DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
    logger,
  });

  // Acquire startup ownership barrier BEFORE installing signal handlers so an early
  // SIGINT/SIGTERM cannot dispose shared resources mid-startup.
  lifecycle.beginStartup();
  lifecycle.installSignalHandlers();

  const abortIfShutdownDuringStartup = async (): Promise<boolean> => {
    if (!lifecycle.isShuttingDown() && !lifecycle.isFatal()) {
      return false;
    }
    lifecycle.endStartupOwnership();
    const pending = lifecycle.waitForShutdown();
    if (pending !== null) {
      await pending;
    }
    return true;
  };

  try {
    await preflightProductionParserEntrypoint();
    if (await abortIfShutdownDuringStartup()) {
      return;
    }

    const parserLimits = resolveProductionParserLimitsFromEnv(env);
    const parserAdapter = createProductionParserAdapter({
      limits: parserLimits,
      logger: (event) => {
        logParserEvent(logger, event);
      },
      onFatalState: (fatal) => {
        lifecycle.triggerFatal(fatal);
      },
    });

    const dbClient = createDbClient({ databaseUrl: env.DATABASE_URL });
    lifecycle.setCloseDb(() => dbClient.close());

    const healthRedis = createFastFailRedisClient({ redisUrl: env.REDIS_URL, logger });
    lifecycle.addRedisClient(healthRedis);

    const dbOk = await dbClient.ping();
    if (await abortIfShutdownDuringStartup()) {
      return;
    }
    if (!dbOk) {
      throw new Error(`PostgreSQL is unreachable at ${dbTarget}.`);
    }

    try {
      await waitForRedisReady(healthRedis);
      const pong: string = await healthRedis.ping();
      if (pong !== 'PONG') {
        throw new Error(`Unexpected Redis PING response: ${pong}`);
      }
    } catch (err) {
      if (await abortIfShutdownDuringStartup()) {
        return;
      }
      throw new Error(`Redis is unreachable at ${redisTarget}.`, { cause: err });
    }

    if (await abortIfShutdownDuringStartup()) {
      return;
    }

    const repository = createIngestionRepository(dbClient.db);
    const baseProcessor = createIngestionJobProcessor({
      repository,
      logger,
      githubToken: env.GITHUB_TOKEN,
      maxSupportedFiles: env.MAX_SUPPORTED_FILES,
      maxRepoSizeMb: env.MAX_REPO_SIZE_MB,
      parserAdapter,
      analysisResultHandoff: noopAnalysisResultHandoff,
      shutdownSignal: lifecycle.shutdownSignal,
      fatalSignal: lifecycle.fatalSignal,
      isFatalState: lifecycle.isFatal,
      onInfrastructureFailure: (err) => {
        lifecycle.triggerInfrastructureFailure(err);
      },
    });
    const processor = lifecycle.wrapProcessor(baseProcessor, {
      delegateStoppedToProcessor: true,
    });

    const queue = createIngestionQueue({
      redisUrl: env.REDIS_URL,
      queueName: DEFAULT_INGESTION_QUEUE_NAME,
    });
    lifecycle.setQueue(queue);

    const worker = createIngestionWorker({
      redisUrl: env.REDIS_URL,
      queueName: DEFAULT_INGESTION_QUEUE_NAME,
      processor,
      autorun: false,
      logger,
    });
    lifecycle.setWorker(worker);

    if (await abortIfShutdownDuringStartup()) {
      return;
    }

    // Release startup barrier atomically before starting job intake
    lifecycle.markRunning();
    void worker.run().catch((runErr: unknown) => {
      if (!lifecycle.isShuttingDown()) {
        logger.error(
          { errorMessage: runErr instanceof Error ? runErr.message : 'Worker run loop failed' },
          'Standalone BullMQ worker loop rejected',
        );
        void lifecycle.shutdown('WORKER_RUN_ERROR');
      }
    });

    logger.info(
      {
        queueName: DEFAULT_INGESTION_QUEUE_NAME,
        dbTarget,
        redisTarget,
        nodeEnv: env.NODE_ENV,
        skipLoadingLibFiles: PRODUCTION_PARSER_CONFIG.skipLoadingLibFiles,
        maxOldSpaceSizeMb: PRODUCTION_PARSER_CONFIG.maxOldSpaceSizeMb,
        parserTimeoutMs: PRODUCTION_PARSER_CONFIG.parserTimeoutMs,
      },
      'Archon BullMQ worker listening',
    );
  } catch (err) {
    // Release startup ownership BEFORE awaiting shutdown to guarantee zero deadlock
    lifecycle.endStartupOwnership();
    await lifecycle.shutdown('STARTUP_FAILURE');
    throw err;
  }
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
