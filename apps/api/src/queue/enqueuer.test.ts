import { describe, expect, it } from 'vitest';
import {
  createBullMqIngestionEnqueuer,
  type EnqueueQueueLike,
  type IngestionJobPayload,
} from './enqueuer.js';

const SAMPLE_PAYLOAD: IngestionJobPayload = {
  repoId: '00000000-0000-4000-8000-000000000001',
  jobId: '00000000-0000-4000-8000-000000000002',
  owner: 'pmndrs',
  name: 'zustand',
  commitSha: '9fed2eb2f3af672da9f7bf694b996df3831fc207',
};

describe('createBullMqIngestionEnqueuer', () => {
  it('enqueues with jobId equal to ingestion_jobs.id and returns bullmqJobId', async () => {
    const calls: { data: IngestionJobPayload; jobId?: string }[] = [];

    const fakeQueue: EnqueueQueueLike = {
      add: (_name, data, opts) => {
        calls.push({ data, jobId: opts.jobId });
        return Promise.resolve({ id: opts.jobId });
      },
    };

    const enqueuer = createBullMqIngestionEnqueuer({
      queue: fakeQueue,
      timeoutMs: 500,
    });

    const result = await enqueuer.enqueue(SAMPLE_PAYLOAD);

    expect(result).toEqual({ bullmqJobId: SAMPLE_PAYLOAD.jobId });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.jobId).toBe(SAMPLE_PAYLOAD.jobId);
  });

  it('rejects promptly on timeout without unhandled rejection when Redis stalls and later rejects', async () => {
    let triggerLateReject: ((err: Error) => void) | undefined;

    const stallingQueue: EnqueueQueueLike = {
      add: () =>
        new Promise((_resolve, reject) => {
          triggerLateReject = reject;
        }),
    };

    const enqueuer = createBullMqIngestionEnqueuer({
      queue: stallingQueue,
      timeoutMs: 30,
    });

    await expect(enqueuer.enqueue(SAMPLE_PAYLOAD)).rejects.toThrow(/Timed out after 30 ms/);

    // Triggering a late rejection after timeout must NOT cause an unhandled rejection.
    triggerLateReject?.(new Error('late redis disconnect'));

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  });

  it('propagates immediate Redis enqueue errors to the caller', async () => {
    const brokenQueue: EnqueueQueueLike = {
      add: () => Promise.reject(new Error('ECONNREFUSED')),
    };

    const enqueuer = createBullMqIngestionEnqueuer({
      queue: brokenQueue,
      timeoutMs: 500,
    });

    await expect(enqueuer.enqueue(SAMPLE_PAYLOAD)).rejects.toThrow('ECONNREFUSED');
  });
});
