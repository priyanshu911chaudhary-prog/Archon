import type { Logger } from '@archon/shared';
import type {
  FastifyRateLimitOptions,
  FastifyRateLimitStore,
  FastifyRateLimitStoreCtor,
} from '@fastify/rate-limit';
import { z } from 'zod';
import { extractRateLimitRouteScope } from './rate-limit.js';

export const DEFAULT_RATE_LIMIT_KEY_PREFIX = 'archon:rl:ingest:' as const;
export const DEFAULT_GRAPH_RATE_LIMIT_KEY_PREFIX = 'archon:rl:graph:' as const;
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
  readonly graphKeyPrefix?: string;
  readonly logger: Pick<Logger, 'warn'>;
}

const evalResultSchema = z.tuple([z.number().int().nonnegative(), z.number().int()]);

type StoreIncrCallback = (error: Error | null, result?: { current: number; ttl: number }) => void;

interface InternalStoreDeps {
  readonly client: RedisRateLimitClient;
  readonly basePrefix: string;
  readonly graphPrefix: string;
  readonly logger: Pick<Logger, 'warn'>;
}

class RedisRateLimitStoreInstance implements FastifyRateLimitStore {
  constructor(
    protected readonly deps: InternalStoreDeps,
    protected readonly routeScope: string,
    protected readonly isGraphReadBucket: boolean,
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

    // All 5 graph-read routes (GET & HEAD) share one Redis key per IP (`archon:rl:graph:<ip>`).
    // Ingestion routes preserve exact existing key construction (`archon:rl:ingest:POST:/api/v1/repos:<ip>`).
    const redisKey = this.isGraphReadBucket
      ? `${this.deps.graphPrefix}${key}`
      : `${this.deps.basePrefix}${this.routeScope}:${key}`;

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
    const extracted = extractRateLimitRouteScope(routeOptions);
    const nextWindow = extracted.timeWindowMs ?? this.defaultTimeWindowMs;
    return new RedisRateLimitStoreInstance(
      this.deps,
      extracted.scope,
      extracted.isGraphRead,
      nextWindow,
    );
  }
}

/**
 * Typed factory returning a FastifyRateLimitStoreCtor closed over our fast-fail Redis client.
 * Avoids @fastify/rate-limit's `redis?: any` option completely.
 */
export function createRedisRateLimitStore(
  options: CreateRedisRateLimitStoreOptions,
): FastifyRateLimitStoreCtor {
  const basePrefix = options.keyPrefix ?? DEFAULT_RATE_LIMIT_KEY_PREFIX;
  const graphPrefix =
    options.graphKeyPrefix ??
    (basePrefix === DEFAULT_RATE_LIMIT_KEY_PREFIX
      ? DEFAULT_GRAPH_RATE_LIMIT_KEY_PREFIX
      : `${basePrefix}graph-read:`);

  const deps: InternalStoreDeps = {
    client: options.client,
    basePrefix,
    graphPrefix,
    logger: options.logger,
  };

  return class ArchonRedisRateLimitStore extends RedisRateLimitStoreInstance {
    constructor(pluginOptions: FastifyRateLimitOptions) {
      const extracted = extractRateLimitRouteScope(pluginOptions);
      super(
        deps,
        extracted.scope,
        extracted.isGraphRead,
        extracted.timeWindowMs ?? DEFAULT_FALLBACK_TIME_WINDOW_MS,
      );
    }
  };
}
