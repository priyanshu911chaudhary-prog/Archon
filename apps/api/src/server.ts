import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDbClient,
  createGraphQueryRepository,
  createIngestionRepository,
  sanitizeDatabaseTarget,
} from '@archon/db';
import { createLogger, loadEnv } from '@archon/shared';
import {
  DEFAULT_INGESTION_QUEUE_NAME,
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
  PRODUCTION_PARSER_CONFIG,
  createFastFailRedisClient,
  createIngestionJobProcessor,
  createIngestionQueue,
  createIngestionWorker,
  createProductionParserAdapter,
  createWorkerServiceLifecycle,
  preflightProductionParserEntrypoint,
  resolveProductionParserLimitsFromEnv,
  sanitizeRedisTarget,
  waitForRedisReady,
  type IngestionWorker,
  type ProductionParserLogEvent,
} from '@archon/worker';
import { buildApp } from './app.js';
import {
  DEFAULT_EMBEDDED_GRAPH_QUERY_CONCURRENCY,
  DEFAULT_STANDALONE_GRAPH_QUERY_CONCURRENCY,
  createGraphQueryAdmissionGate,
} from './graph-admission.js';
import { GitHubPrecheckClient } from './github/precheck.js';
import { createBullMqIngestionEnqueuer } from './queue/enqueuer.js';
import { createRedisRateLimitStoreConfig } from './rate-limit.js';
import { createRedisRateLimitStore } from './redis-rate-limit-store.js';

const STARTUP_REDIS_READY_TIMEOUT_MS = 5_000;

function logParserEvent(
  logger: Pick<ReturnType<typeof createLogger>, 'info' | 'warn' | 'error'>,
  event: ProductionParserLogEvent,
): void {
  if (event.type === 'analysis_completed') {
    logger.info({ summary: event.summary }, 'Embedded isolated static analysis completed');
  } else if (event.type === 'analysis_failed') {
    logger.warn({ parserError: event.error }, 'Embedded isolated static analysis failed');
  } else {
    logger.error(
      { fatal: event.fatal },
      'Embedded isolated parser entered fatal supervision state',
    );
  }
}

export async function startServer(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });
  const dbTarget = sanitizeDatabaseTarget(env.DATABASE_URL);
  const redisTarget = sanitizeRedisTarget(env.REDIS_URL);

  const lifecycle = createWorkerServiceLifecycle({
    serviceName: 'api',
    closeTimeoutMs: DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
    logger,
  });

  // Hold startup ownership barrier BEFORE installing signal handlers so early SIGINT/SIGTERM
  // waits for startup unwind before closing shared Queue/Redis/PostgreSQL resources.
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
    // Only activate parser preflight & adapter when embedded worker mode is enabled
    let parserAdapter: ReturnType<typeof createProductionParserAdapter> | undefined;
    if (env.RUN_EMBEDDED_WORKER) {
      await preflightProductionParserEntrypoint();
      if (await abortIfShutdownDuringStartup()) {
        return;
      }
      const parserLimits = resolveProductionParserLimitsFromEnv(env);
      parserAdapter = createProductionParserAdapter({
        limits: parserLimits,
        logger: (event) => {
          logParserEvent(logger, event);
        },
        onFatalState: (fatal) => {
          lifecycle.triggerFatal(fatal);
        },
      });
    }

    const dbClient = createDbClient({ databaseUrl: env.DATABASE_URL });
    lifecycle.setCloseDb(() => dbClient.close());
    const repository = createIngestionRepository(dbClient.db);
    const graphQueryRepository = createGraphQueryRepository(dbClient.db);
    const graphQueryAdmission = createGraphQueryAdmissionGate(
      env.RUN_EMBEDDED_WORKER
        ? DEFAULT_EMBEDDED_GRAPH_QUERY_CONCURRENCY
        : DEFAULT_STANDALONE_GRAPH_QUERY_CONCURRENCY,
    );
    if (lifecycle.shutdownSignal.aborted) {
      graphQueryAdmission.stop();
    } else {
      lifecycle.shutdownSignal.addEventListener(
        'abort',
        () => {
          graphQueryAdmission.stop();
        },
        { once: true },
      );
    }

    const apiRedis = createFastFailRedisClient({
      redisUrl: env.REDIS_URL,
      logger,
      reconnect: true,
    });
    lifecycle.addRedisClient(apiRedis);

    // Decision 2: wait briefly for Redis on startup; if unreachable, log warning and boot in degraded mode
    try {
      await waitForRedisReady(apiRedis, STARTUP_REDIS_READY_TIMEOUT_MS);
      logger.info({ redisTarget }, 'API Redis client ready');
    } catch (err) {
      if (await abortIfShutdownDuringStartup()) {
        return;
      }
      logger.warn(
        {
          redisTarget,
          err: err instanceof Error ? err.message : String(err),
        },
        'Redis unavailable at startup; starting API in degraded mode',
      );
    }

    if (await abortIfShutdownDuringStartup()) {
      return;
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
    lifecycle.setQueue(ingestionQueue);

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
    if (env.RUN_EMBEDDED_WORKER && parserAdapter !== undefined) {
      const baseProcessor = createIngestionJobProcessor({
        repository,
        logger,
        githubToken: env.GITHUB_TOKEN,
        maxSupportedFiles: env.MAX_SUPPORTED_FILES,
        maxRepoSizeMb: env.MAX_REPO_SIZE_MB,
        parserAdapter,
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

      embeddedWorker = createIngestionWorker({
        redisUrl: env.REDIS_URL,
        queueName: DEFAULT_INGESTION_QUEUE_NAME,
        processor,
        autorun: false,
        logger,
      });
      lifecycle.setWorker(embeddedWorker);
    }

    const app = await buildApp({
      env,
      logger,
      repository,
      graphQueryRepository,
      graphQueryAdmission,
      checkDbHealth: () => dbClient.ping(),
      checkRedisHealth,
      githubPrecheck,
      enqueuer,
      rateLimitStore,
      onAppCreated: (createdApp) => {
        // Register Fastify ownership immediately so even a partial-construction failure closes
        // through the coordinated lifecycle without suppressing app.close() rejections.
        lifecycle.setHttpClose(() => createdApp.close());
      },
    });

    if (await abortIfShutdownDuringStartup()) {
      return;
    }

    await app.listen({ host: '0.0.0.0', port: env.PORT });

    // Re-check immediately after app.listen() so shutdown during listen NEVER starts worker.run()
    // or logs service-listening.
    if (await abortIfShutdownDuringStartup()) {
      return;
    }

    lifecycle.markRunning();

    if (embeddedWorker !== undefined && !lifecycle.isShuttingDown() && !lifecycle.isFatal()) {
      void embeddedWorker.run().catch((runErr: unknown) => {
        if (!lifecycle.isShuttingDown()) {
          logger.error(
            {
              errorMessage:
                runErr instanceof Error ? runErr.message : 'Embedded worker run loop failed',
            },
            'Embedded BullMQ worker loop rejected',
          );
          void lifecycle.shutdown('WORKER_RUN_ERROR');
        }
      });
      logger.info(
        {
          queueName: DEFAULT_INGESTION_QUEUE_NAME,
          redisTarget,
          skipLoadingLibFiles: PRODUCTION_PARSER_CONFIG.skipLoadingLibFiles,
          maxOldSpaceSizeMb: PRODUCTION_PARSER_CONFIG.maxOldSpaceSizeMb,
          parserTimeoutMs: PRODUCTION_PARSER_CONFIG.parserTimeoutMs,
        },
        'Embedded BullMQ ingestion worker started',
      );
    }

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
    logger.error(
      { errorMessage: err instanceof Error ? err.message : 'Startup failure' },
      'Failed to start Archon API server',
    );
    // Release startup ownership BEFORE awaiting shutdown to guarantee zero deadlock
    lifecycle.endStartupOwnership();
    await lifecycle.shutdown('STARTUP_FAILURE');
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
