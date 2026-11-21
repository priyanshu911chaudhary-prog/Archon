import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.js';

export const DEFAULT_POOL_MAX = 5;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export type ArchonDatabase = NodePgDatabase<typeof schema>;

export interface CreateDbClientOptions {
  readonly databaseUrl: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
}

export interface DbClient {
  readonly db: ArchonDatabase;
  readonly pool: Pool;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Derives explicit `node-postgres` SSL settings from the `sslmode` query parameter
 * in DATABASE_URL so local Docker (`127.0.0.1`, no sslmode) stays plain TCP while
 * Neon (`?sslmode=require` / `verify-full`) enforces certificate verification.
 */
export function resolvePoolSsl(databaseUrl: string): PoolConfig['ssl'] {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return undefined;
  }

  const sslmode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
  if (!sslmode || sslmode === 'disable') {
    return false;
  }
  if (sslmode === 'no-verify') {
    return { rejectUnauthorized: false };
  }
  if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') {
    return { rejectUnauthorized: true };
  }
  return undefined;
}

/**
 * Returns `host:port/database` without ever exposing credentials in logs or errors.
 */
export function sanitizeDatabaseTarget(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    const portPart = parsed.port ? `:${parsed.port}` : '';
    const dbPart = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return `${parsed.hostname}${portPart}${dbPart}`;
  } catch {
    return '<invalid-database-url>';
  }
}

export function buildPoolConfig(options: CreateDbClientOptions): PoolConfig {
  const ssl = resolvePoolSsl(options.databaseUrl);
  const config: PoolConfig = {
    connectionString: options.databaseUrl,
    max: options.max ?? DEFAULT_POOL_MAX,
    idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  };

  if (ssl !== undefined) {
    config.ssl = ssl;
  }

  return config;
}

export function createDbClient(options: CreateDbClientOptions): DbClient {
  const pool = new Pool(buildPoolConfig(options));
  const db = drizzle(pool, { schema });
  let closed = false;

  return {
    db,
    pool,
    async ping(): Promise<boolean> {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await pool.end();
    },
  };
}
