import type { FastifyRateLimitStore } from '@fastify/rate-limit';
import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_INCR_LUA,
  createRedisRateLimitStore,
  type RedisRateLimitClient,
} from './redis-rate-limit-store.js';

interface RecordedEvalCall {
  readonly script: string;
  readonly numberOfKeys: number;
  readonly args: readonly (string | number)[];
}

function makeFakeLogger() {
  const warnings: { obj: unknown; msg?: string }[] = [];
  return {
    warnings,
    logger: {
      warn(obj: unknown, msg?: string): void {
        warnings.push({ obj, msg });
      },
    },
  };
}

function invokeIncr(
  store: FastifyRateLimitStore,
  key: string,
  timeWindowMs: number,
  max: number,
): Promise<{ error: Error | null; result?: { current: number; ttl: number } }> {
  return new Promise((resolve) => {
    store.incr(
      key,
      (error, result) => {
        resolve({ error, result });
      },
      timeWindowMs,
      max,
    );
  });
}

describe('createRedisRateLimitStore', () => {
  it('evaluates atomic Lua script with per-route child key prefixes and returns current + ttl', async () => {
    const calls: RecordedEvalCall[] = [];
    const counters = new Map<string, number>();

    const fakeClient: RedisRateLimitClient = {
      status: 'ready',
      eval(script, numberOfKeys, ...args) {
        calls.push({ script, numberOfKeys, args });
        const redisKey = String(args[0] ?? '');
        const windowMs = Number(args[1] ?? 0);
        const nextCount = (counters.get(redisKey) ?? 0) + 1;
        counters.set(redisKey, nextCount);
        return Promise.resolve([nextCount, nextCount === 1 ? windowMs : windowMs - 100]);
      },
    };

    const { logger, warnings } = makeFakeLogger();
    const StoreCtor = createRedisRateLimitStore({
      client: fakeClient,
      keyPrefix: 'test:rl:',
      logger,
    });

    const rootStore = new StoreCtor({ timeWindow: 60_000 });

    // Simulate real @fastify/rate-limit@11.3.0 runtime child() call with routeInfo
    const reposChild = rootStore.child({
      method: 'POST',
      url: '/api/v1/repos',
      path: '/api/v1/repos',
      prefix: '',
      handler: () => undefined,
    });
    const otherChild = rootStore.child({
      method: 'POST',
      url: '/api/v1/risk-report',
      path: '/api/v1/risk-report',
      prefix: '',
      handler: () => undefined,
    });

    const hit1 = await invokeIncr(reposChild, '198.51.100.10', 3_600_000, 5);
    const hit2 = await invokeIncr(reposChild, '198.51.100.10', 3_600_000, 5);
    const otherHit = await invokeIncr(otherChild, '198.51.100.10', 3_600_000, 5);

    expect(hit1).toEqual({ error: null, result: { current: 1, ttl: 3_600_000 } });
    expect(hit2).toEqual({ error: null, result: { current: 2, ttl: 3_599_900 } });
    expect(otherHit).toEqual({ error: null, result: { current: 1, ttl: 3_600_000 } });

    expect(calls[0]?.script).toBe(RATE_LIMIT_INCR_LUA);
    expect(calls[0]?.numberOfKeys).toBe(1);
    expect(calls[0]?.args[0]).toBe('test:rl:POST:/api/v1/repos:198.51.100.10');
    expect(calls[2]?.args[0]).toBe('test:rl:POST:/api/v1/risk-report:198.51.100.10');
    expect(warnings).toHaveLength(0);
  });

  it('fails fast with a warning and skips eval when Redis client status is not ready', async () => {
    const evalState = { called: false };
    const fakeClient: RedisRateLimitClient = {
      status: 'reconnecting',
      eval() {
        evalState.called = true;
        return Promise.resolve([1, 60_000]);
      },
    };

    const { logger, warnings } = makeFakeLogger();
    const StoreCtor = createRedisRateLimitStore({ client: fakeClient, logger });
    const store = new StoreCtor({});

    const outcome = await invokeIncr(store, '198.51.100.10', 60_000, 5);

    expect(evalState.called).toBe(false);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error?.message).toContain('not ready');
    expect(outcome.result).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('logs a warning and passes error to callback when eval rejects or returns malformed data', async () => {
    const failingClient: RedisRateLimitClient = {
      status: 'ready',
      eval: () =>
        Promise.reject(new Error('READONLY You cannot write against a read only replica')),
    };

    const firstLogs = makeFakeLogger();
    const FailingStore = createRedisRateLimitStore({
      client: failingClient,
      logger: firstLogs.logger,
    });
    const failOutcome = await invokeIncr(new FailingStore({}), '198.51.100.10', 60_000, 5);

    expect(failOutcome.error).toBeInstanceOf(Error);
    expect(failOutcome.error?.message).toContain('READONLY');
    expect(firstLogs.warnings).toHaveLength(1);

    const malformedClient: RedisRateLimitClient = {
      status: 'ready',
      eval: () => Promise.resolve('unexpected-string'),
    };
    const secondLogs = makeFakeLogger();
    const MalformedStore = createRedisRateLimitStore({
      client: malformedClient,
      logger: secondLogs.logger,
    });
    const badOutcome = await invokeIncr(new MalformedStore({}), '198.51.100.10', 60_000, 5);

    expect(badOutcome.error).toBeInstanceOf(Error);
    expect(secondLogs.warnings).toHaveLength(1);
  });

  it('shares one Redis graph-read bucket across GET and HEAD graph endpoints while preserving ingestion keys', async () => {
    const keys: string[] = [];
    const counters = new Map<string, number>();
    const fakeClient: RedisRateLimitClient = {
      status: 'ready',
      eval(_script, _n, ...args) {
        const key = String(args[0] ?? '');
        const win = Number(args[1] ?? 60_000);
        keys.push(key);
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return Promise.resolve([next, win]);
      },
    };
    const { logger } = makeFakeLogger();
    const StoreCtor = createRedisRateLimitStore({ client: fakeClient, logger });
    const root = new StoreCtor({ timeWindow: 60_000 });

    const graphGet = root.child({
      method: 'GET',
      url: '/api/v1/repos/:repoId/graph',
      path: '/api/v1/repos/:repoId/graph',
      prefix: '',
      handler: () => undefined,
    });
    const hubsHead = root.child({
      method: 'HEAD',
      url: '/api/v1/repos/:repoId/hubs',
      path: '/api/v1/repos/:repoId/hubs',
      prefix: '',
      handler: () => undefined,
    });
    const ingestPost = root.child({
      method: 'POST',
      url: '/api/v1/repos',
      path: '/api/v1/repos',
      prefix: '',
      handler: () => undefined,
    });

    const g1 = await invokeIncr(graphGet, '198.51.100.10', 60_000, 120);
    const g2 = await invokeIncr(hubsHead, '198.51.100.10', 60_000, 120);
    const i1 = await invokeIncr(ingestPost, '198.51.100.10', 3_600_000, 5);

    expect(g1.result?.current).toBe(1);
    expect(g2.result?.current).toBe(2);
    expect(i1.result?.current).toBe(1);
    expect(keys).toEqual([
      'archon:rl:graph:198.51.100.10',
      'archon:rl:graph:198.51.100.10',
      'archon:rl:ingest:POST:/api/v1/repos:198.51.100.10',
    ]);
  });
});
