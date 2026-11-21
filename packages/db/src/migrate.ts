import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, loadEnv } from '@archon/shared';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDbClient, sanitizeDatabaseTarget, type ArchonDatabase } from './client.js';
import { DbError, extractPgErrorInfo } from './errors.js';

/**
 * Resolves `packages/db/drizzle` relative to this module, working identically
 * whether executed from `src/migrate.ts` (tsx/vitest) or `dist/migrate.js` (compiled).
 */
export function getMigrationsFolder(): string {
  return path.resolve(import.meta.dirname, '..', 'drizzle');
}

export async function runMigrations(
  db: ArchonDatabase,
  migrationsFolder: string = getMigrationsFolder(),
): Promise<void> {
  try {
    await migrate(db, { migrationsFolder });
  } catch (err) {
    const pgInfo = extractPgErrorInfo(err);
    throw new DbError('DB_MIGRATION_ERROR', 'Failed to apply Drizzle SQL migrations.', {
      cause: err,
      pgCode: pgInfo.code,
    });
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ service: 'db-migrate', level: env.LOG_LEVEL });
  const target = sanitizeDatabaseTarget(env.DATABASE_URL);
  const migrationsFolder = getMigrationsFolder();

  const client = createDbClient({ databaseUrl: env.DATABASE_URL, max: 1 });
  try {
    logger.info({ target }, 'Applying Drizzle SQL migrations');
    await runMigrations(client.db, migrationsFolder);
    logger.info({ target }, 'Drizzle SQL migrations applied successfully');
  } finally {
    await client.close();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Migration failed: ${message}\n`);
    process.exitCode = 1;
  });
}
