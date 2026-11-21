import type { Logger } from '@archon/shared';

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
 * Step 3.2b-ii placeholder enqueuer: logs a structured warning and returns
 * `bullmqJobId: null` without modifying the DB row, leaving the job in `queued`
 * so the stale-job sweep remains honest until BullMQ is attached in Step 3.3.
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
