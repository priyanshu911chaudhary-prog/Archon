import type { IngestionRepository } from '@archon/db';
import type { AppEnv, Logger } from '@archon/shared';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { registerErrorHandlers } from './errors.js';
import type { GitHubPrecheckClient } from './github/precheck.js';
import type { IngestionJobEnqueuer } from './queue/enqueuer.js';
import {
  buildRateLimitPluginOptions,
  createInMemoryRateLimitStore,
  type RateLimitStoreConfig,
} from './rate-limit.js';
import { registerHealthRoute } from './routes/health.js';
import { registerJobsRoute } from './routes/jobs.js';
import { registerReposRoute } from './routes/repos.js';
import { createIngestionService } from './services/ingestion-service.js';

export const API_BODY_LIMIT_BYTES = 2048;

export interface BuildAppDependencies {
  readonly env: AppEnv;
  readonly logger: Logger;
  readonly repository: IngestionRepository;
  readonly checkDbHealth: () => Promise<boolean>;
  readonly checkRedisHealth?: () => Promise<boolean>;
  readonly githubPrecheck: Pick<GitHubPrecheckClient, 'precheckRepository'>;
  readonly enqueuer: IngestionJobEnqueuer;
  readonly rateLimitStore?: RateLimitStoreConfig;
  readonly rateLimitWindowMs?: number;
  readonly staleJobThresholdMs?: number;
  readonly onAppCreated?: (app: FastifyInstance) => void;
  readonly now?: () => Date;
}

export async function buildApp(deps: BuildAppDependencies): Promise<FastifyInstance> {
  // Hop-count trust via a function (never boolean `true`): trust only the first N
  // addresses counted from the socket; 0 disables proxy trust entirely.
  const trustedHops = deps.env.TRUST_PROXY_HOPS;
  const trustProxy: boolean | ((address: string, hop: number) => boolean) =
    trustedHops === 0 ? false : (_address: string, hop: number): boolean => hop < trustedHops;

  const loggerInstance: FastifyBaseLogger = deps.logger;

  const app = Fastify({
    loggerInstance,
    trustProxy,
    bodyLimit: API_BODY_LIMIT_BYTES,
  });

  deps.onAppCreated?.(app);

  try {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(helmet, {
      contentSecurityPolicy: false,
    });

    await app.register(cors, {
      origin: (origin, callback) => {
        // Non-browser clients send no Origin header; allow them (CORS only governs browsers).
        if (origin === undefined || origin === deps.env.WEB_ORIGIN) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      methods: ['GET', 'POST', 'OPTIONS'],
    });

    const store = deps.rateLimitStore ?? createInMemoryRateLimitStore();
    await app.register(rateLimit, buildRateLimitPluginOptions(store));

    registerErrorHandlers(app);

    const nowFn = deps.now ?? (() => new Date());
    const startedAtMs = nowFn().getTime();

    const ingestionService = createIngestionService({
      repository: deps.repository,
      githubPrecheck: deps.githubPrecheck,
      enqueuer: deps.enqueuer,
      logger: deps.logger,
      staleJobThresholdMs: deps.staleJobThresholdMs,
      now: nowFn,
    });

    registerHealthRoute(app, {
      checkDbHealth: deps.checkDbHealth,
      checkRedisHealth: deps.checkRedisHealth,
      workerMode: deps.env.RUN_EMBEDDED_WORKER ? 'embedded' : 'external',
      startedAtMs,
      now: () => nowFn().getTime(),
    });

    registerReposRoute(app, {
      ingestionService,
      rateLimitPerHour: deps.env.INGEST_RATE_LIMIT_PER_HOUR,
      rateLimitWindowMs: deps.rateLimitWindowMs,
    });

    registerJobsRoute(app, {
      ingestionService,
    });

    return await app;
  } catch (err) {
    // When caller owns the Fastify instance via `onAppCreated`, defer closing to its coordinated
    // lifecycle shutdown so an `app.close()` rejection is never silently masked.
    if (deps.onAppCreated !== undefined) {
      throw err;
    }
    try {
      await app.close();
    } catch (closeErr) {
      throw new AggregateError(
        [err, closeErr],
        'Failed to construct Fastify app and failed to close partial instance.',
        { cause: closeErr },
      );
    }
    throw err;
  }
}
