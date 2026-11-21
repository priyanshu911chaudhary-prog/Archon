import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import { AppApiError } from './errors.js';

export const INGEST_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Abstraction for rate-limit storage. Only the in-memory store exists for now;
 * Step 3.3 adds a Redis variant here once ioredis is installed and verified.
 */
export interface RateLimitStoreConfig {
  readonly kind: 'memory';
}

export function createInMemoryRateLimitStore(): RateLimitStoreConfig {
  return { kind: 'memory' };
}

export function buildRateLimitPluginOptions(_store: RateLimitStoreConfig): RateLimitPluginOptions {
  return {
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
    // Key strictly on Fastify's computed request.ip (honours the trustProxy hop count)
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
}
