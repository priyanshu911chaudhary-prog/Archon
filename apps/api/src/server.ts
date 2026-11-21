import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbClient, createIngestionRepository } from '@archon/db';
import { createLogger, loadEnv } from '@archon/shared';
import { buildApp } from './app.js';
import { GitHubPrecheckClient } from './github/precheck.js';
import { createStubIngestionEnqueuer } from './queue/enqueuer.js';

export async function startServer(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });
  const dbClient = createDbClient({ databaseUrl: env.DATABASE_URL });
  const repository = createIngestionRepository(dbClient.db);

  const githubPrecheck = new GitHubPrecheckClient({
    token: env.GITHUB_TOKEN,
    maxSupportedFiles: env.MAX_SUPPORTED_FILES,
    maxRepoSizeMb: env.MAX_REPO_SIZE_MB,
    logger,
  });

  const enqueuer = createStubIngestionEnqueuer(logger);

  const app = await buildApp({
    env,
    logger,
    repository,
    checkDbHealth: () => dbClient.ping(),
    githubPrecheck,
    enqueuer,
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    let exitCode = 0;
    try {
      await app.close();
    } catch (err) {
      logger.error({ err, signal }, 'Error closing Fastify server');
      exitCode = 1;
    }

    try {
      await dbClient.close();
    } catch (err) {
      logger.error({ err, signal }, 'Error closing PostgreSQL pool');
      exitCode = 1;
    }

    logger.info({ signal, exitCode }, 'Shutdown complete');
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
        trustProxyHops: env.TRUST_PROXY_HOPS,
        webOrigin: env.WEB_ORIGIN,
      },
      'Archon API server listening',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to start Archon API server');
    await dbClient.close();
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
