import type { Logger } from '@archon/shared';
import { Queue, Worker, type Job, type QueueOptions, type WorkerOptions } from 'bullmq';
import {
  closeRedisClient,
  parseBullMqConnectionOptions,
  type RedisConnectionConfig,
} from './redis.js';

export const DEFAULT_INGESTION_QUEUE_NAME = 'archon-ingestion' as const;
export const INGESTION_JOB_NAME = 'ingest-repo' as const;

export const DEFAULT_JOB_ATTEMPTS = 2;
export const DEFAULT_JOB_BACKOFF_MS = 5_000;
export const DEFAULT_REMOVE_ON_COMPLETE_COUNT = 50;
export const DEFAULT_REMOVE_ON_FAIL_COUNT = 100;

export const DEFAULT_WORKER_CONCURRENCY = 1;
export const DEFAULT_WORKER_LOCK_DURATION_MS = 60_000;
export const DEFAULT_WORKER_STALLED_INTERVAL_MS = 120_000;
export const DEFAULT_WORKER_DRAIN_DELAY_SEC = 30;
export const DEFAULT_WORKER_MAX_STALLED_COUNT = 1;
export const DEFAULT_WORKER_CLOSE_TIMEOUT_MS = 15_000;

export interface IngestionQueueJobData {
  readonly repoId: string;
  readonly jobId: string;
  readonly owner: string;
  readonly name: string;
  readonly commitSha: string;
}

export type IngestionQueue = Queue<IngestionQueueJobData, void, typeof INGESTION_JOB_NAME>;
export type IngestionWorker = Worker<IngestionQueueJobData, void, typeof INGESTION_JOB_NAME>;
export type IngestionBullMqJob = Job<IngestionQueueJobData, void, typeof INGESTION_JOB_NAME>;

export interface CreateIngestionQueueOptions {
  readonly redisUrl?: string;
  readonly connection?: RedisConnectionConfig;
  readonly queueName?: string;
  readonly prefix?: string;
  readonly skipWaitingForReady?: boolean;
  readonly attempts?: number;
  readonly backoffDelayMs?: number;
}

export interface CreateIngestionWorkerOptions {
  readonly redisUrl?: string;
  readonly connection?: RedisConnectionConfig;
  readonly processor: (job: IngestionBullMqJob) => Promise<void>;
  readonly queueName?: string;
  readonly prefix?: string;
  readonly lockDuration?: number;
  readonly stalledInterval?: number;
  readonly drainDelay?: number;
  readonly maxStalledCount?: number;
  readonly autorun?: boolean;
  readonly logger?: Pick<Logger, 'error' | 'warn'>;
}

export interface EnqueuedIngestionJobResult {
  readonly bullmqJobId: string;
}

function resolveConnection(options: {
  readonly redisUrl?: string;
  readonly connection?: RedisConnectionConfig;
}): RedisConnectionConfig {
  if (options.connection !== undefined) {
    return options.connection;
  }
  if (options.redisUrl !== undefined) {
    return parseBullMqConnectionOptions(options.redisUrl);
  }
  throw new Error('Either redisUrl or connection must be provided.');
}

export function createIngestionQueue(options: CreateIngestionQueueOptions): IngestionQueue {
  const connection = resolveConnection(options);
  const queueName = options.queueName ?? DEFAULT_INGESTION_QUEUE_NAME;

  const queueOptions: QueueOptions = {
    connection,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    ...(options.skipWaitingForReady !== undefined
      ? { skipWaitingForReady: options.skipWaitingForReady }
      : {}),
    defaultJobOptions: {
      attempts: options.attempts ?? DEFAULT_JOB_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: options.backoffDelayMs ?? DEFAULT_JOB_BACKOFF_MS,
      },
      removeOnComplete: { count: DEFAULT_REMOVE_ON_COMPLETE_COUNT },
      removeOnFail: { count: DEFAULT_REMOVE_ON_FAIL_COUNT },
    },
  };

  return new Queue<IngestionQueueJobData, void, typeof INGESTION_JOB_NAME>(queueName, queueOptions);
}

/**
 * Enqueues an ingestion job using the Postgres `ingestion_jobs.id` UUID as BullMQ `jobId`
 * (no colons allowed by BullMQ custom job IDs) to guarantee idempotent dispatch.
 */
export async function enqueueIngestionJob(
  queue: {
    add(
      name: typeof INGESTION_JOB_NAME,
      data: IngestionQueueJobData,
      opts: { jobId: string },
    ): Promise<{ readonly id?: string }>;
  },
  payload: IngestionQueueJobData,
): Promise<EnqueuedIngestionJobResult> {
  if (payload.jobId.length === 0 || payload.jobId.includes(':')) {
    throw new Error(`Invalid ingestion jobId for BullMQ: "${payload.jobId}"`);
  }

  const job = await queue.add(INGESTION_JOB_NAME, payload, {
    jobId: payload.jobId,
  });

  return {
    bullmqJobId: job.id ?? payload.jobId,
  };
}

export function createIngestionWorker(options: CreateIngestionWorkerOptions): IngestionWorker {
  const connection = resolveConnection(options);
  const queueName = options.queueName ?? DEFAULT_INGESTION_QUEUE_NAME;

  const workerOptions: WorkerOptions = {
    connection,
    concurrency: DEFAULT_WORKER_CONCURRENCY,
    lockDuration: options.lockDuration ?? DEFAULT_WORKER_LOCK_DURATION_MS,
    stalledInterval: options.stalledInterval ?? DEFAULT_WORKER_STALLED_INTERVAL_MS,
    drainDelay: options.drainDelay ?? DEFAULT_WORKER_DRAIN_DELAY_SEC,
    maxStalledCount: options.maxStalledCount ?? DEFAULT_WORKER_MAX_STALLED_COUNT,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    ...(options.autorun !== undefined ? { autorun: options.autorun } : {}),
  };

  const worker = new Worker<IngestionQueueJobData, void, typeof INGESTION_JOB_NAME>(
    queueName,
    options.processor,
    workerOptions,
  );

  worker.on('error', (err: Error) => {
    options.logger?.error({ err: err.message, queueName }, 'BullMQ ingestion worker error');
  });

  return worker;
}

export type WorkerCloseObservation =
  | {
      readonly closed: true;
      readonly timedOut: false;
    }
  | {
      readonly closed: false;
      readonly timedOut: true;
      readonly pendingClose: Promise<void>;
    }
  | {
      readonly closed: false;
      readonly timedOut: false;
      readonly error: unknown;
    };

/**
 * Initiates a single graceful BullMQ `worker.close()` call and observes it up to `timeoutMs`.
 *
 * Confirmed BullMQ 6.7.8 behavior: `Worker.close(force)` caches `this.closing` on the first
 * invocation, so calling `worker.close(true)` later returns the original closing promise
 * rather than escalating. This helper therefore NEVER issues a fake second `worker.close(true)`.
 * On timeout, it returns `{ closed: false, timedOut: true, pendingClose }` so callers can
 * preserve ownership without prematurely closing Redis/PostgreSQL or dropping the close promise.
 */
export async function closeWorkerWithTimeout(
  worker: Pick<IngestionWorker, 'close'>,
  timeoutMs: number = DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
): Promise<WorkerCloseObservation> {
  let closePromise: Promise<void>;
  try {
    closePromise = worker.close();
  } catch (err: unknown) {
    return { closed: false, timedOut: false, error: err };
  }

  // Prevent unhandled rejection if closePromise rejects after observation timeout elapses
  closePromise.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    timer.unref();
  });

  const settledPromise = closePromise.then(
    (): { readonly kind: 'closed' } => ({ kind: 'closed' }),
    (err: unknown): { readonly kind: 'rejected'; readonly error: unknown } => ({
      kind: 'rejected',
      error: err,
    }),
  );

  try {
    const outcome = await Promise.race([settledPromise, timeoutPromise]);
    if (outcome.kind === 'closed') {
      return { closed: true, timedOut: false };
    }
    if (outcome.kind === 'rejected') {
      return { closed: false, timedOut: false, error: outcome.error };
    }
    return { closed: false, timedOut: true, pendingClose: closePromise };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface ShutdownWorkerResourcesInput {
  readonly worker?: Pick<IngestionWorker, 'close'>;
  readonly queue?: Pick<IngestionQueue, 'close'>;
  readonly redisClients?: readonly {
    quit(): Promise<unknown>;
    disconnect(): void;
  }[];
  readonly closeDb?: () => Promise<void>;
  readonly workerCloseTimeoutMs?: number;
  readonly logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

async function closeDownstreamResources(input: ShutdownWorkerResourcesInput): Promise<0 | 1> {
  let exitCode: 0 | 1 = 0;

  if (input.queue !== undefined) {
    input.logger?.info('Shutdown step 2/4: closing BullMQ queue');
    try {
      await input.queue.close();
    } catch (err) {
      input.logger?.error(
        { errorMessage: err instanceof Error ? err.message : 'Queue close error' },
        'Error closing BullMQ queue',
      );
      exitCode = 1;
    }
  }

  if (input.redisClients !== undefined && input.redisClients.length > 0) {
    input.logger?.info('Shutdown step 3/4: closing Redis clients');
    for (const client of input.redisClients) {
      try {
        await closeRedisClient(client);
      } catch (err) {
        input.logger?.error(
          { errorMessage: err instanceof Error ? err.message : 'Redis close error' },
          'Error closing Redis client',
        );
        exitCode = 1;
      }
    }
  }

  if (input.closeDb !== undefined) {
    input.logger?.info('Shutdown step 4/4: closing PostgreSQL pool');
    try {
      await input.closeDb();
    } catch (err) {
      input.logger?.error(
        { errorMessage: err instanceof Error ? err.message : 'PostgreSQL close error' },
        'Error closing PostgreSQL pool',
      );
      exitCode = 1;
    }
  }

  return exitCode;
}

export interface ShutdownWorkerResourcesResult {
  readonly exitCode: 0 | 1;
  /** True only when worker closure was confirmed before downstream disposal. */
  readonly ownershipConfirmed: boolean;
  /** True only when Queue/Redis/PostgreSQL disposal completed without errors. */
  readonly downstreamClosed: boolean;
  /** Backwards-compatible alias for `ownershipConfirmed && downstreamClosed`. */
  readonly confirmed: boolean;
  readonly timedOut: boolean;
  /** Present when worker closure exceeded the observation window; resolves after deferred cleanup. */
  readonly pendingCleanup?: Promise<{
    readonly exitCode: 0 | 1;
    readonly ownershipConfirmed: boolean;
    readonly downstreamClosed: boolean;
  }>;
}

/**
 * Fail-closed ordered graceful shutdown for worker resources:
 * 1. Observe single graceful `worker.close()`.
 * 2. Only when worker closure is confirmed, close Queue -> Redis -> PostgreSQL (last).
 * 3. If worker closure times out or rejects, do NOT close Queue/Redis/PostgreSQL underneath
 *    potentially active work; retain `pendingCleanup` when a close promise is still pending.
 */
export async function shutdownWorkerResources(
  input: ShutdownWorkerResourcesInput,
): Promise<ShutdownWorkerResourcesResult> {
  if (input.worker !== undefined) {
    input.logger?.info('Shutdown step 1/4: closing BullMQ worker');
    const observation = await closeWorkerWithTimeout(
      input.worker,
      input.workerCloseTimeoutMs ?? DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
    );

    if (!observation.closed) {
      if (observation.timedOut) {
        input.logger?.warn(
          'BullMQ worker close did not complete within observation window; keeping queue/Redis/PostgreSQL open pending confirmed closure',
        );
        const pendingCleanup = observation.pendingClose.then(
          async () => {
            const downstreamExit = await closeDownstreamResources(input);
            return {
              exitCode: 1 as const,
              ownershipConfirmed: true,
              downstreamClosed: downstreamExit === 0,
            };
          },
          () => ({
            exitCode: 1 as const,
            ownershipConfirmed: false,
            downstreamClosed: false,
          }),
        );
        return {
          exitCode: 1,
          ownershipConfirmed: false,
          downstreamClosed: false,
          confirmed: false,
          timedOut: true,
          pendingCleanup,
        };
      }

      input.logger?.error(
        {
          errorMessage:
            observation.error instanceof Error
              ? observation.error.message
              : 'BullMQ worker close rejected',
        },
        'BullMQ worker close rejected; refusing to close queue/Redis/PostgreSQL without confirmed worker closure',
      );
      return {
        exitCode: 1,
        ownershipConfirmed: false,
        downstreamClosed: false,
        confirmed: false,
        timedOut: false,
      };
    }
  }

  const exitCode = await closeDownstreamResources(input);
  const downstreamClosed = exitCode === 0;
  return {
    exitCode,
    ownershipConfirmed: true,
    downstreamClosed,
    confirmed: downstreamClosed,
    timedOut: false,
  };
}
