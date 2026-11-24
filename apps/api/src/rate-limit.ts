import type { FastifyRateLimitStoreCtor, RateLimitPluginOptions } from '@fastify/rate-limit';
import { AppApiError } from './errors.js';

export const INGEST_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Discriminated rate-limit storage config. Uses @fastify/rate-limit's typed `store`
 * constructor for Redis (never the untyped `redis?: any` option).
 */
export type RateLimitStoreConfig =
  | { readonly kind: 'memory' }
  | { readonly kind: 'redis'; readonly store: FastifyRateLimitStoreCtor };

export function createInMemoryRateLimitStore(): RateLimitStoreConfig {
  return { kind: 'memory' };
}

export function createRedisRateLimitStoreConfig(
  store: FastifyRateLimitStoreCtor,
): RateLimitStoreConfig {
  return { kind: 'redis', store };
}

export function buildRateLimitPluginOptions(store: RateLimitStoreConfig): RateLimitPluginOptions {
  const baseOptions: RateLimitPluginOptions = {
    global: false,
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    // Always key strictly on Fastify's computed `request.ip` (respects trustProxy, never raw X-Forwarded-For)
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) => {
      const retryAfterSec = Math.max(1, Math.ceil(context.ttl / 1000));
      return new AppApiError({
        code: 'RATE_LIMITED',
        statusCode: 429,
        retryAfterSec,
        message: 'Ingestion rate limit exceeded. Please try again later.',
        details: { retryAfterSec },
      });
    },
  };

  if (store.kind === 'redis') {
    return {
      ...baseOptions,
      store: store.store,
      skipOnError: true,
    };
  }

  return baseOptions;
}
