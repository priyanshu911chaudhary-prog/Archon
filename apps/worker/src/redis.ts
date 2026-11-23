import type { Logger } from '@archon/shared';
import { Redis, type RedisOptions } from 'ioredis';

const DEFAULT_REDIS_PORT = 6379;
const FAST_FAIL_MAX_RETRIES_PER_REQUEST = 2;
const FAST_FAIL_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REDIS_CLOSE_TIMEOUT_MS = 3_000;

export class RedisConfigError extends Error {
  readonly code = 'REDIS_CONFIG_ERROR' as const;

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RedisConfigError';
  }
}

export interface RedisConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly db?: number;
  readonly tls?: Record<string, never>;
  readonly maxRetriesPerRequest: null;
  readonly enableReadyCheck: false;
}

interface ParsedRedisUrlParts {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly db?: number;
  readonly useTls: boolean;
}

function decodeCredentialComponent(raw: string, fieldName: string): string {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    throw new RedisConfigError(`Invalid percent-encoding in Redis URL ${fieldName}.`, {
      cause: err,
    });
  }
}

function parseRedisUrlParts(redisUrl: string): ParsedRedisUrlParts {
  const trimmed = redisUrl.trim();
  if (trimmed.length === 0) {
    throw new RedisConfigError('REDIS_URL must not be empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new RedisConfigError('REDIS_URL is not a valid URL.', { cause: err });
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new RedisConfigError(
      `REDIS_URL must use redis:// or rediss:// protocol (received ${parsed.protocol}).`,
    );
  }

  if (parsed.hostname.length === 0) {
    throw new RedisConfigError('REDIS_URL must include a hostname.');
  }

  let port = DEFAULT_REDIS_PORT;
  if (parsed.port.length > 0) {
    if (!/^\d+$/.test(parsed.port)) {
      throw new RedisConfigError(`REDIS_URL contains an invalid port: ${parsed.port}`);
    }
    const numericPort = Number.parseInt(parsed.port, 10);
    if (numericPort < 1 || numericPort > 65535) {
      throw new RedisConfigError(`REDIS_URL port out of range (1-65535): ${numericPort}`);
    }
    port = numericPort;
  }

  const username =
    parsed.username.length > 0 ? decodeCredentialComponent(parsed.username, 'username') : undefined;
  const password =
    parsed.password.length > 0 ? decodeCredentialComponent(parsed.password, 'password') : undefined;

  let db: number | undefined;
  if (parsed.pathname.length > 0 && parsed.pathname !== '/') {
    const match = /^\/(\d+)$/.exec(parsed.pathname);
    if (!match?.[1]) {
      throw new RedisConfigError(
        `REDIS_URL database path must be a non-negative integer (received "${parsed.pathname}").`,
      );
    }
    const parsedDb = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(parsedDb)) {
      throw new RedisConfigError(`REDIS_URL database index is out of range: ${parsed.pathname}`);
    }
    db = parsedDb;
  }

  return {
    host: parsed.hostname,
    port,
    username,
    password,
    db,
    useTls: parsed.protocol === 'rediss:',
  };
}

/**
 * Parses REDIS_URL into a tightly typed plain connection config object for BullMQ
 * Queue/Worker (`maxRetriesPerRequest: null`, `enableReadyCheck: false`).
 * Never passes an ioredis instance to BullMQ and never hardcodes a port.
 */
export function parseBullMqConnectionOptions(redisUrl: string): RedisConnectionConfig {
  const parts = parseRedisUrlParts(redisUrl);

  return {
    host: parts.host,
    port: parts.port,
    ...(parts.username !== undefined ? { username: parts.username } : {}),
    ...(parts.password !== undefined ? { password: parts.password } : {}),
    ...(parts.db !== undefined ? { db: parts.db } : {}),
    ...(parts.useTls ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

export interface CreateFastFailRedisClientOptions {
  readonly redisUrl: string;
  readonly logger?: Pick<Logger, 'warn'>;
  readonly lazyConnect?: boolean;
}

/**
 * Creates a fast-fail ioredis client for API health checks, rate limiting, and
 * integration-test reachability checks (never shared with BullMQ blocking connections).
 */
export function createFastFailRedisClient(options: CreateFastFailRedisClientOptions): Redis {
  const parts = parseRedisUrlParts(options.redisUrl);

  const redisOptions: RedisOptions = {
    host: parts.host,
    port: parts.port,
    ...(parts.username !== undefined ? { username: parts.username } : {}),
    ...(parts.password !== undefined ? { password: parts.password } : {}),
    ...(parts.db !== undefined ? { db: parts.db } : {}),
    ...(parts.useTls ? { tls: {} } : {}),
    maxRetriesPerRequest: FAST_FAIL_MAX_RETRIES_PER_REQUEST,
    connectTimeout: FAST_FAIL_CONNECT_TIMEOUT_MS,
    enableOfflineQueue: false,
    lazyConnect: options.lazyConnect ?? false,
    retryStrategy: () => null,
  };

  const client = new Redis(redisOptions);
  const target = `${parts.host}:${parts.port}`;

  // Attach error listener so an unreachable Redis rejects commands cleanly instead of crashing Node
  client.on('error', (err: Error) => {
    options.logger?.warn({ err: err.message, target }, 'Fast-fail Redis client error');
  });

  return client;
}

/**
 * Resolves once the fast-fail client is connected, or rejects if it cannot connect in time.
 * Needed because enableOfflineQueue is false, so commands sent before connect are rejected.
 */
export async function waitForRedisReady(
  client: Redis,
  timeoutMs: number = FAST_FAIL_CONNECT_TIMEOUT_MS,
): Promise<void> {
  if (client.status === 'ready') {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis did not become ready within ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref();

    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error('Redis connection ended before becoming ready.'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('error', onError);
      client.off('end', onEnd);
    };

    client.once('ready', onReady);
    client.once('error', onError);
    client.once('end', onEnd);
  });
}

/**
 * Closes an ioredis client gracefully via QUIT with a timeout fallback to disconnect().
 */
export interface ClosableRedisClient {
  quit(): Promise<unknown>;
  disconnect(): void;
}

export async function closeRedisClient(
  client: ClosableRedisClient,
  timeoutMs: number = DEFAULT_REDIS_CLOSE_TIMEOUT_MS,
): Promise<void> {
  const quitPromise = client.quit().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
    timer.unref();
  });

  try {
    const outcome = await Promise.race([quitPromise.then(() => 'closed' as const), timeoutPromise]);
    if (outcome === 'timeout') {
      client.disconnect();
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Formats a Redis URL as `host:port` without ever leaking credentials in logs or errors.
 */
export function sanitizeRedisTarget(redisUrl: string): string {
  try {
    const parts = parseRedisUrlParts(redisUrl);
    return `${parts.host}:${parts.port}`;
  } catch {
    return '<invalid-redis-url>';
  }
}
