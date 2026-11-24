import type { Logger } from '@archon/shared';
import type {
  FastifyRateLimitOptions,
  FastifyRateLimitStore,
  FastifyRateLimitStoreCtor,
} from '@fastify/rate-limit';
import { z } from 'zod';

export const DEFAULT_RATE_LIMIT_KEY_PREFIX = 'archon:rl:ingest:' as const;
const DEFAULT_FALLBACK_TIME_WINDOW_MS = 60 * 60 * 1000;

/**
 * Atomic single-command Lua script modelled on @fastify/rate-limit's built-in RedisStore:
 * - Increments counter for KEYS[1]
 * - Sets PEXPIRE on first hit (or heals a missing TTL if PTTL < 0)
 * - Returns [current, ttlMs]
 */
export const RATE_LIMIT_INCR_LUA = [
  "local current = redis.call('INCR', KEYS[1])",
  'if current == 1 then',
  "  redis.call('PEXPIRE', KEYS[1], ARGV[1])",
  '  return { current, tonumber(ARGV[1]) }',
  'end',
  "local ttl = redis.call('PTTL', KEYS[1])",
  'if ttl < 0 then',
  "  redis.call('PEXPIRE', KEYS[1], ARGV[1])",
  '  ttl = tonumber(ARGV[1])',
  'end',
  'return { current, ttl }',
].join('\n');

/**
 * Minimal structural Redis client contract satisfied directly by ioredis without casts or `any`.
 */
export interface RedisRateLimitClient {
  readonly status: string;
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface CreateRedisRateLimitStoreOptions {
  readonly client: RedisRateLimitClient;
  readonly keyPrefix?: string;
  readonly logger: Pick<Logger, 'warn'>;
}

const evalResultSchema = z.tuple([z.number().int().nonnegative(), z.number().int()]);

type StoreIncrCallback = (error: Error | null, result?: { current: number; ttl: number }) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatMethod(rawMethod: unknown): string | undefined {
  if (typeof rawMethod === 'string' && rawMethod.trim().length > 0) {
    return rawMethod.trim().toUpperCase();
  }
  if (Array.isArray(rawMethod)) {
    const parts = rawMethod.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
    if (parts.length > 0) {
      return parts.map((p) => p.trim().toUpperCase()).join(',');
    }
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Extracts route scope and optional timeWindow from @fastify/rate-limit's child() argument.
 * At runtime v11.3.0 passes `mergedRateLimitParams` (`{ routeInfo: { method, url }, timeWindow }`),
 * whereas the TypeScript .d.ts declares `RouteOptions & { path, prefix }`. Both shapes are supported.
 */
function extractRouteScopeAndWindow(raw: unknown): {
  readonly scope: string;
  readonly timeWindowMs?: number;
} {
  if (!isRecord(raw)) {
    return { scope: 'global' };
  }

  const timeWindowRaw = raw.timeWindow;
  const timeWindowMs =
    typeof timeWindowRaw === 'number' && Number.isFinite(timeWindowRaw) && timeWindowRaw > 0
      ? Math.trunc(timeWindowRaw)
      : undefined;

  // 1. Real @fastify/rate-limit@11.3.0 runtime shape: mergedRateLimitParams.routeInfo
  if (isRecord(raw.routeInfo)) {
    const method = formatMethod(raw.routeInfo.method);
    const url = readNonEmptyString(raw.routeInfo.url) ?? readNonEmptyString(raw.routeInfo.path);
    if (method !== undefined && url !== undefined) {
      return { scope: `${method}:${url}`, timeWindowMs };
    }
    if (url !== undefined) {
      return { scope: url, timeWindowMs };
    }
  }

  // 2. Direct RouteOptions & { path, prefix } shape from .d.ts
  const method = formatMethod(raw.method);
  const routePath =
    readNonEmptyString(raw.url) ?? readNonEmptyString(raw.path) ?? readNonEmptyString(raw.prefix);

  if (method !== undefined && routePath !== undefined) {
    return { scope: `${method}:${routePath}`, timeWindowMs };
  }
  if (routePath !== undefined) {
    return { scope: routePath, timeWindowMs };
  }

  return { scope: 'global', timeWindowMs };
}

interface InternalStoreDeps {
  readonly client: RedisRateLimitClient;
  readonly basePrefix: string;
  readonly logger: Pick<Logger, 'warn'>;
}

class RedisRateLimitStoreInstance implements FastifyRateLimitStore {
  constructor(
    protected readonly deps: InternalStoreDeps,
    protected readonly routeScope: string,
    protected readonly defaultTimeWindowMs: number,
  ) {}

  incr(key: string, callback: StoreIncrCallback, timeWindow?: number, _max?: number): void {
    const windowMs =
      typeof timeWindow === 'number' && Number.isFinite(timeWindow) && timeWindow > 0
        ? Math.trunc(timeWindow)
        : this.defaultTimeWindowMs;

    if (this.deps.client.status !== 'ready') {
      const notReadyErr = new Error(
        `Redis rate-limit client is not ready (status: ${this.deps.client.status}).`,
      );
      this.deps.logger.warn(
        { redisStatus: this.deps.client.status, routeScope: this.routeScope },
        'Redis rate-limit store unavailable; failing open via skipOnError',
      );
      callback(notReadyErr);
      return;
    }

    const redisKey = `${this.deps.basePrefix}${this.routeScope}:${key}`;

    this.deps.client
      .eval(RATE_LIMIT_INCR_LUA, 1, redisKey, windowMs)
      .then((rawResult: unknown) => {
        const parsed = evalResultSchema.safeParse(rawResult);
        if (!parsed.success) {
          const invalidErr = new Error('Redis rate-limit Lua script returned unexpected payload.');
          this.deps.logger.warn(
            { routeScope: this.routeScope },
            'Invalid Redis rate-limit response; failing open via skipOnError',
          );
          callback(invalidErr);
          return;
        }

        const [current, rawTtl] = parsed.data;
        callback(null, { current, ttl: Math.max(0, rawTtl) });
      })
      .catch((err: unknown) => {
        const error =
          err instanceof Error
            ? err
            : new Error('Redis rate-limit evaluation failed.', { cause: err });
        this.deps.logger.warn(
          { err: error.message, routeScope: this.routeScope },
          'Redis rate-limit store error; failing open via skipOnError',
        );
        callback(error);
      });
  }

  child(routeOptions: Parameters<FastifyRateLimitStore['child']>[0]): FastifyRateLimitStore {
    const extracted = extractRouteScopeAndWindow(routeOptions);
    const nextWindow = extracted.timeWindowMs ?? this.defaultTimeWindowMs;
    return new RedisRateLimitStoreInstance(this.deps, extracted.scope, nextWindow);
  }
}

/**
 * Typed factory returning a FastifyRateLimitStoreCtor closed over our fast-fail Redis client.
 * Avoids @fastify/rate-limit's `redis?: any` option completely.
 */
export function createRedisRateLimitStore(
  options: CreateRedisRateLimitStoreOptions,
): FastifyRateLimitStoreCtor {
  const deps: InternalStoreDeps = {
    client: options.client,
    basePrefix: options.keyPrefix ?? DEFAULT_RATE_LIMIT_KEY_PREFIX,
    logger: options.logger,
  };

  return class ArchonRedisRateLimitStore extends RedisRateLimitStoreInstance {
    constructor(pluginOptions: FastifyRateLimitOptions) {
      const extracted = extractRouteScopeAndWindow(pluginOptions);
      super(deps, extracted.scope, extracted.timeWindowMs ?? DEFAULT_FALLBACK_TIME_WINDOW_MS);
    }
  };
}
