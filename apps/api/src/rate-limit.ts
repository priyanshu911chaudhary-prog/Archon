import type {
  FastifyRateLimitOptions,
  FastifyRateLimitStore,
  FastifyRateLimitStoreCtor,
  RateLimitPluginOptions,
} from '@fastify/rate-limit';
import { AppApiError } from './errors.js';

export const INGEST_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_GRAPH_RATE_LIMIT_MAX = 120;
export const DEFAULT_GRAPH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

export const GRAPH_READ_ROUTE_PATHS = [
  '/api/v1/repos/:repoId/graph',
  '/api/v1/repos/:repoId/nodes/:nodeId',
  '/api/v1/repos/:repoId/nodes/:nodeId/edges',
  '/api/v1/repos/:repoId/nodes/:nodeId/blast-radius',
  '/api/v1/repos/:repoId/hubs',
] as const;

const GRAPH_READ_ROUTE_PATH_SET = new Set<string>(GRAPH_READ_ROUTE_PATHS);
const DEFAULT_IN_MEMORY_MAX_KEYS = 10_000;

export function isGraphReadRouteUrl(url: string | undefined): boolean {
  return url !== undefined && GRAPH_READ_ROUTE_PATH_SET.has(url);
}

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

export interface ExtractedRateLimitScope {
  readonly scope: string;
  readonly isGraphRead: boolean;
  readonly timeWindowMs?: number;
}

/**
 * Extracts route scope, shared graph-read bucket membership, and optional timeWindow from
 * @fastify/rate-limit's child() argument (supporting both runtime `routeInfo` and `.d.ts` shapes).
 * All five graph-read routes (GET and auto-exposed HEAD) collapse into one shared `graph-read` bucket.
 */
export function extractRateLimitRouteScope(raw: unknown): ExtractedRateLimitScope {
  if (!isRecord(raw)) {
    return { scope: 'global', isGraphRead: false };
  }

  const timeWindowRaw = raw.timeWindow;
  const timeWindowMs =
    typeof timeWindowRaw === 'number' && Number.isFinite(timeWindowRaw) && timeWindowRaw > 0
      ? Math.trunc(timeWindowRaw)
      : undefined;

  let method: string | undefined;
  let url: string | undefined;

  if (isRecord(raw.routeInfo)) {
    method = formatMethod(raw.routeInfo.method);
    url = readNonEmptyString(raw.routeInfo.url) ?? readNonEmptyString(raw.routeInfo.path);
  }
  method ??= formatMethod(raw.method);
  url ??=
    readNonEmptyString(raw.url) ?? readNonEmptyString(raw.path) ?? readNonEmptyString(raw.prefix);

  if (isGraphReadRouteUrl(url)) {
    return { scope: 'graph-read', isGraphRead: true, timeWindowMs };
  }

  if (method !== undefined && url !== undefined) {
    return { scope: `${method}:${url}`, isGraphRead: false, timeWindowMs };
  }
  if (url !== undefined) {
    return { scope: url, isGraphRead: false, timeWindowMs };
  }

  return { scope: 'global', isGraphRead: false, timeWindowMs };
}

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

interface MemoryCounterEntry {
  current: number;
  expiresAtMs: number;
}

type StoreIncrCallback = (error: Error | null, result?: { current: number; ttl: number }) => void;

function createSharedBucketMemoryStoreCtor(): FastifyRateLimitStoreCtor {
  const counters = new Map<string, MemoryCounterEntry>();

  class SharedBucketMemoryStore implements FastifyRateLimitStore {
    constructor(
      private readonly scope: string,
      private readonly defaultTimeWindowMs: number,
    ) {}

    incr(key: string, callback: StoreIncrCallback, timeWindow?: number, _max?: number): void {
      const windowMs =
        typeof timeWindow === 'number' && Number.isFinite(timeWindow) && timeWindow > 0
          ? Math.trunc(timeWindow)
          : this.defaultTimeWindowMs;
      const nowMs = Date.now();
      const bucketKey = `${this.scope}:${key}`;
      const existing = counters.get(bucketKey);

      if (existing !== undefined && existing.expiresAtMs > nowMs) {
        existing.current += 1;
        callback(null, {
          current: existing.current,
          ttl: Math.max(0, existing.expiresAtMs - nowMs),
        });
        return;
      }

      if (counters.size >= DEFAULT_IN_MEMORY_MAX_KEYS) {
        for (const [k, entry] of counters) {
          if (entry.expiresAtMs <= nowMs) {
            counters.delete(k);
          }
        }
        if (counters.size >= DEFAULT_IN_MEMORY_MAX_KEYS) {
          const oldestKey = counters.keys().next().value;
          if (oldestKey !== undefined) {
            counters.delete(oldestKey);
          }
        }
      }

      counters.set(bucketKey, { current: 1, expiresAtMs: nowMs + windowMs });
      callback(null, { current: 1, ttl: windowMs });
    }

    child(routeOptions: Parameters<FastifyRateLimitStore['child']>[0]): FastifyRateLimitStore {
      const extracted = extractRateLimitRouteScope(routeOptions);
      return new SharedBucketMemoryStore(
        extracted.scope,
        extracted.timeWindowMs ?? this.defaultTimeWindowMs,
      );
    }
  }

  return class ArchonInMemoryRateLimitStore extends SharedBucketMemoryStore {
    constructor(pluginOptions: FastifyRateLimitOptions) {
      const extracted = extractRateLimitRouteScope(pluginOptions);
      super(extracted.scope, extracted.timeWindowMs ?? INGEST_RATE_LIMIT_WINDOW_MS);
    }
  };
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
    errorResponseBuilder: (request, context) => {
      const retryAfterSec = Math.max(1, Math.ceil(context.ttl / 1000));
      const isGraphRoute = isGraphReadRouteUrl(request.routeOptions.url);
      return new AppApiError({
        code: 'RATE_LIMITED',
        statusCode: 429,
        retryAfterSec,
        message: isGraphRoute
          ? 'Graph query rate limit exceeded. Please try again later.'
          : 'Ingestion rate limit exceeded. Please try again later.',
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

  return {
    ...baseOptions,
    store: createSharedBucketMemoryStoreCtor(),
  };
}
