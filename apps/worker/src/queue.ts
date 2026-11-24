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

export interface CloseWorkerResult {
  readonly timedOut: boolean;
}

/**
 * Closes a BullMQ Worker gracefully with a hard timeout so a stuck job can never
 * block process exit during SIGINT/SIGTERM.
 */
export async function closeWorkerWithTimeout(
  worker: Pick<IngestionWorker, 'close'>,
  timeoutMs: number = DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
): Promise<CloseWorkerResult> {
  const closePromise = worker.close();
  // Prevent unhandled rejection if closePromise rejects after timeout wins the race
  closePromise.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
    timer.unref();
  });

  try {
    const outcome = await Promise.race([
      closePromise.then(() => 'closed' as const),
      timeoutPromise,
    ]);
    if (outcome === 'timeout') {
      const forceClose = worker.close(true);
      forceClose.catch(() => undefined);
      return { timedOut: true };
    }
    return { timedOut: false };
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

/**
 * Shared ordered graceful shutdown for both standalone worker.ts and embedded API mode:
 * 1. worker.close() with timeout
 * 2. queue.close()
 * 3. fast-fail Redis clients
 * 4. Postgres pool last (so final stage updates always commit cleanly)
 */
export async function shutdownWorkerResources(
  input: ShutdownWorkerResourcesInput,
): Promise<{ readonly exitCode: 0 | 1 }> {
  let exitCode: 0 | 1 = 0;

  if (input.worker !== undefined) {
    input.logger?.info('Shutdown step 1/4: closing BullMQ worker');
    try {
      const result = await closeWorkerWithTimeout(
        input.worker,
        input.workerCloseTimeoutMs ?? DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
      );
      if (result.timedOut) {
        input.logger?.warn('BullMQ worker close timed out; forced close triggered');
        exitCode = 1;
      }
    } catch (err) {
      input.logger?.error({ err }, 'Error closing BullMQ worker');
      exitCode = 1;
    }
  }

  if (input.queue !== undefined) {
    input.logger?.info('Shutdown step 2/4: closing BullMQ queue');
    try {
      await input.queue.close();
    } catch (err) {
      input.logger?.error({ err }, 'Error closing BullMQ queue');
      exitCode = 1;
    }
  }

  if (input.redisClients !== undefined && input.redisClients.length > 0) {
    input.logger?.info('Shutdown step 3/4: closing Redis clients');
    for (const client of input.redisClients) {
      try {
        await closeRedisClient(client);
      } catch (err) {
        input.logger?.error({ err }, 'Error closing Redis client');
        exitCode = 1;
      }
    }
  }

  if (input.closeDb !== undefined) {
    input.logger?.info('Shutdown step 4/4: closing PostgreSQL pool');
    try {
      await input.closeDb();
    } catch (err) {
      input.logger?.error({ err }, 'Error closing PostgreSQL pool');
      exitCode = 1;
    }
  }

  return { exitCode };
}
