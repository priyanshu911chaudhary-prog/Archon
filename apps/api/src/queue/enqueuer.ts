import type { Logger } from '@archon/shared';
import { enqueueIngestionJob } from '@archon/worker';
import type { IngestionQueueJobData } from '@archon/worker';

export interface EnqueueQueueLike {
  add(
    name: 'ingest-repo',
    data: IngestionQueueJobData,
    opts: { jobId: string },
  ): Promise<{ readonly id?: string }>;
}

export interface CreateBullMqEnqueuerOptions {
  readonly queue: EnqueueQueueLike;
  readonly timeoutMs?: number;
}

export const DEFAULT_ENQUEUE_TIMEOUT_MS = 3_000;

export interface IngestionJobPayload {
  readonly repoId: string;
  readonly jobId: string;
  readonly owner: string;
  readonly name: string;
  readonly commitSha: string;
}

export interface EnqueueIngestionResult {
  readonly bullmqJobId: string | null;
}

export interface IngestionJobEnqueuer {
  enqueue(payload: IngestionJobPayload): Promise<EnqueueIngestionResult>;
}

/**
 * Placeholder enqueuer retained for isolated unit tests: logs a warning and returns
 * `bullmqJobId: null` without modifying the DB row.
 */
export function createStubIngestionEnqueuer(logger: Pick<Logger, 'warn'>): IngestionJobEnqueuer {
  return {
    enqueue(payload: IngestionJobPayload): Promise<EnqueueIngestionResult> {
      logger.warn(
        {
          repoId: payload.repoId,
          jobId: payload.jobId,
          owner: payload.owner,
          name: payload.name,
          commitSha: payload.commitSha,
        },
        'Worker queue not attached yet; ingestion job remains queued',
      );
      return Promise.resolve({ bullmqJobId: null });
    },
  };
}

/**
 * Production BullMQ enqueuer with a short fail-fast timeout.
 * Errors or timeouts propagate to ingestion-service.ts, which marks the DB row failed
 * and returns 503 QUEUE_UNAVAILABLE.
 */
export function createBullMqIngestionEnqueuer(
  options: CreateBullMqEnqueuerOptions,
): IngestionJobEnqueuer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;

  return {
    async enqueue(payload: IngestionJobPayload): Promise<EnqueueIngestionResult> {
      const enqueuePromise = enqueueIngestionJob(options.queue, payload);
      // Prevent unhandled rejection if timeout wins the race before Redis rejects
      enqueuePromise.catch(() => undefined);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs} ms enqueueing ingestion job.`));
        }, timeoutMs);
        timer.unref();
      });

      try {
        const result = await Promise.race([enqueuePromise, timeoutPromise]);
        return { bullmqJobId: result.bullmqJobId };
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}
