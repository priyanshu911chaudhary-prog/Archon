import { randomBytes, randomUUID } from 'node:crypto';
import { createLogger, loadEnv } from '@archon/shared';
import { Queue, Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeWorkerWithTimeout } from './queue.js';
import {
  closeRedisClient,
  createFastFailRedisClient,
  parseBullMqConnectionOptions,
  sanitizeRedisTarget,
  waitForRedisReady,
  type RedisConnectionConfig,
} from './redis.js';

const PG_MAX_INT32 = 2_147_483_647;

interface DeliveryTestPayload {
  readonly label: string;
}

interface DeliveryTestResult {
  readonly completedBy: 'worker-a' | 'worker-b';
  readonly attemptsStarted: number;
}

type DeliveryQueue = Queue<DeliveryTestPayload, DeliveryTestResult, 'delivery-test'>;
type DeliveryWorker = Worker<DeliveryTestPayload, DeliveryTestResult, 'delivery-test'>;
type DeliveryJob = Job<DeliveryTestPayload, DeliveryTestResult, 'delivery-test'>;

interface RecordedActivation {
  readonly workerLabel: 'worker-a' | 'worker-b';
  readonly jobId: string | undefined;
  readonly attemptsStarted: number;
  readonly attemptsMade: number;
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(timeoutMs)} ms waiting for ${label}.`));
    }, timeoutMs);
    timer.unref();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function confirmWorkerClosed(worker: DeliveryWorker, timeoutMs = 5_000): Promise<boolean> {
  const obs = await closeWorkerWithTimeout(worker, timeoutMs);
  if (obs.closed) {
    return true;
  }
  if (obs.timedOut) {
    try {
      await withTimeout(obs.pendingClose, timeoutMs, 'pending worker close');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Non-forced obliteration after confirmed worker closure.
 * Never swallows obliteration errors and always closes the queue connection.
 */
async function obliterateAndCloseQueue(queueToClean: DeliveryQueue): Promise<void> {
  try {
    await queueToClean.obliterate();
  } finally {
    await queueToClean.close();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Narrowly accepts only BullMQ moveToFinished lock-loss errors bound to the exact test job ID.
 * Any unrelated or unexpected error fails the test.
 */
function isExpectedObsoleteCompletionError(err: unknown, expectedJobId: string): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const escapedId = escapeRegExp(expectedJobId);
  const allowedPatterns: readonly RegExp[] = [
    new RegExp(`^Missing lock for job ${escapedId}\\. (?:finished|failed)$`),
    new RegExp(`^Lock mismatch for job ${escapedId}\\. Cmd (?:finished|failed) from \\w+$`),
  ];
  return allowedPatterns.some((pattern) => pattern.test(err.message));
}

function formatErrorSummary(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Contract-level model of the proposed PostgreSQL ownership claim rule
 * (`incomingGeneration > storedGeneration`). Actual PostgreSQL locking belongs to Batch 5.3B.
 */
class DeliveryGenerationClaimContract {
  private storedGeneration = 0;

  getStoredGeneration(): number {
    return this.storedGeneration;
  }

  tryClaim(incomingGeneration: number): {
    readonly accepted: boolean;
    readonly storedGeneration: number;
  } {
    if (
      !Number.isSafeInteger(incomingGeneration) ||
      incomingGeneration < 1 ||
      incomingGeneration > PG_MAX_INT32
    ) {
      return { accepted: false, storedGeneration: this.storedGeneration };
    }
    if (incomingGeneration > this.storedGeneration) {
      this.storedGeneration = incomingGeneration;
      return { accepted: true, storedGeneration: this.storedGeneration };
    }
    return { accepted: false, storedGeneration: this.storedGeneration };
  }
}

describe('BullMQ delivery generation verification (Redis integration)', () => {
  const suffix = randomBytes(6).toString('hex');
  const baseQueueName = `archon-delivery-test-${suffix}`;
  const queuePrefix = `archon_delivery_${suffix}`;
  const logger = createLogger({ service: 'bullmq-delivery-test', level: 'silent' });

  let connection: RedisConnectionConfig;
  const outstandingCaseOwnership = new Set<string>();

  beforeAll(async () => {
    const env = loadEnv();
    const redisUrl = env.REDIS_URL;
    const redisTarget = sanitizeRedisTarget(redisUrl);
    connection = parseBullMqConnectionOptions(redisUrl);

    const probeRedis = createFastFailRedisClient({ redisUrl, logger });
    try {
      await waitForRedisReady(probeRedis);
      const pong: string = await probeRedis.ping();
      if (pong !== 'PONG') {
        throw new Error(`Unexpected PING reply: ${pong}`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Redis is unreachable at ${redisTarget}. Check REDIS_URL in .env and run npm run docker:up. Root cause: ${detail}`,
        { cause: err },
      );
    } finally {
      await closeRedisClient(probeRedis);
    }
  });

  afterAll(() => {
    expect([...outstandingCaseOwnership]).toEqual([]);
  });

  it('Test A: increments attemptsStarted monotonically across a normal BullMQ retry under the same jobId', async () => {
    const caseQueueName = `${baseQueueName}-retry`;
    outstandingCaseOwnership.add(caseQueueName);

    const expectedJobId = randomUUID();
    const activations: RecordedActivation[] = [];
    const unexpectedWorkerErrors: unknown[] = [];
    const completed = createDeferred<string>();

    let caseQueue: DeliveryQueue | undefined;
    let worker: DeliveryWorker | undefined;
    let workerRun: Promise<void> | undefined;
    const lifecycleState = {
      workerClosed: false,
    };

    try {
      caseQueue = new Queue(caseQueueName, {
        connection,
        prefix: queuePrefix,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'fixed', delay: 50 },
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 100 },
        },
      });

      worker = new Worker(
        caseQueueName,
        (job: DeliveryJob): Promise<DeliveryTestResult> => {
          const entryGeneration = job.attemptsStarted;
          const entryMade = job.attemptsMade;
          activations.push({
            workerLabel: 'worker-a',
            jobId: job.id,
            attemptsStarted: entryGeneration,
            attemptsMade: entryMade,
          });

          if (activations.length === 1) {
            return Promise.reject(new Error('Controlled attempt-1 retryable test error'));
          }
          return Promise.resolve({
            completedBy: 'worker-a',
            attemptsStarted: entryGeneration,
          });
        },
        {
          connection,
          prefix: queuePrefix,
          concurrency: 1,
          drainDelay: 1,
          autorun: false,
        },
      );

      worker.on('error', (err: Error) => {
        unexpectedWorkerErrors.push(err);
      });
      worker.on('completed', (job: DeliveryJob) => {
        if (job.id === expectedJobId) {
          completed.resolve(job.id);
        }
      });

      workerRun = worker.run().catch((err: unknown) => {
        unexpectedWorkerErrors.push(err);
      });

      await caseQueue.add('delivery-test', { label: 'normal-retry' }, { jobId: expectedJobId });

      const completedId = await withTimeout(completed.promise, 10_000, 'Test A completion');
      expect(completedId).toBe(expectedJobId);

      // Confirm worker closure and run-loop settlement BEFORE asserting errors and final Redis state
      lifecycleState.workerClosed = await confirmWorkerClosed(worker, 5_000);
      await workerRun;
      expect(lifecycleState.workerClosed).toBe(true);

      expect(unexpectedWorkerErrors).toEqual([]);
      expect(activations).toHaveLength(2);
      const first = activations[0];
      const second = activations[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();

      if (first !== undefined && second !== undefined) {
        expect(first.jobId).toBe(expectedJobId);
        expect(second.jobId).toBe(expectedJobId);
        expect(first.attemptsStarted).toBe(1);
        expect(first.attemptsMade).toBe(0);
        expect(second.attemptsStarted).toBe(2);
        expect(second.attemptsMade).toBe(1);
        expect(second.attemptsStarted).toBeGreaterThan(first.attemptsStarted);
      }

      const finalJob = await caseQueue.getJob(expectedJobId);
      expect(finalJob).toBeDefined();
      expect(await finalJob?.getState()).toBe('completed');
      expect(finalJob?.attemptsStarted).toBe(2);
      expect(finalJob?.returnvalue).toEqual({
        completedBy: 'worker-a',
        attemptsStarted: 2,
      });

      process.stdout.write(
        `[5.3A-SUMMARY] Test A (normal-retry): ${JSON.stringify({
          jobId: expectedJobId,
          activations,
          finalState: 'completed',
          finalAttemptsStarted: finalJob?.attemptsStarted,
          finalReturnValue: finalJob?.returnvalue,
        })}\n`,
      );
    } finally {
      if (worker !== undefined && !lifecycleState.workerClosed) {
        lifecycleState.workerClosed = await confirmWorkerClosed(worker, 5_000);
      }
      if (workerRun !== undefined) {
        await workerRun;
      }
      const ownershipConfirmed = worker === undefined || lifecycleState.workerClosed;
      if (caseQueue !== undefined) {
        if (ownershipConfirmed) {
          await obliterateAndCloseQueue(caseQueue);
          outstandingCaseOwnership.delete(caseQueueName);
        } else {
          await caseQueue.close();
        }
      } else if (ownershipConfirmed) {
        outstandingCaseOwnership.delete(caseQueueName);
      }
    }
  }, 25_000);

  it('Test B: increments attemptsStarted on real BullMQ stalled recovery, preserves the newer result, and verifies claim ordering on measured generations', async () => {
    const caseQueueName = `${baseQueueName}-stalled`;
    outstandingCaseOwnership.add(caseQueueName);

    const expectedJobId = randomUUID();
    const workerAEntered = createDeferred();
    const releaseWorkerA = createDeferred();
    const workerAExited = createDeferred();
    const workerBCompleted = createDeferred<string>();

    const activations: RecordedActivation[] = [];
    const stalledEvents: string[] = [];
    const workerAErrors: unknown[] = [];
    const workerACompletedIds: (string | undefined)[] = [];
    const workerBErrors: unknown[] = [];

    const state = {
      workerAStarted: false,
      workerAInFlight: false,
      workerAExited: false,
      workerAStillActiveWhenWorkerBStarted: false,
      workerAClosed: false,
      workerBClosed: false,
    };

    let caseQueue: DeliveryQueue | undefined;
    let workerA: DeliveryWorker | undefined;
    let workerB: DeliveryWorker | undefined;
    let workerARun: Promise<void> | undefined;
    let workerBRun: Promise<void> | undefined;

    try {
      caseQueue = new Queue(caseQueueName, {
        connection,
        prefix: queuePrefix,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'fixed', delay: 50 },
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 100 },
        },
      });

      // Worker A disables lock renewal and stalled checks so its short lock expires naturally
      workerA = new Worker(
        caseQueueName,
        async (job: DeliveryJob): Promise<DeliveryTestResult> => {
          const entryGeneration = job.attemptsStarted;
          const entryMade = job.attemptsMade;
          activations.push({
            workerLabel: 'worker-a',
            jobId: job.id,
            attemptsStarted: entryGeneration,
            attemptsMade: entryMade,
          });
          state.workerAStarted = true;
          state.workerAInFlight = true;
          workerAEntered.resolve();
          try {
            await releaseWorkerA.promise;
            return {
              completedBy: 'worker-a',
              attemptsStarted: entryGeneration,
            };
          } finally {
            state.workerAInFlight = false;
            state.workerAExited = true;
            workerAExited.resolve();
          }
        },
        {
          connection,
          prefix: queuePrefix,
          concurrency: 1,
          lockDuration: 500,
          skipLockRenewal: true,
          skipStalledCheck: true,
          drainDelay: 1,
          autorun: false,
        },
      );

      workerA.on('error', (err: Error) => {
        workerAErrors.push(err);
      });
      workerA.on('completed', (job: DeliveryJob) => {
        workerACompletedIds.push(job.id);
      });
      workerA.on('failed', (_job: DeliveryJob | undefined, err: Error) => {
        workerAErrors.push(err);
      });

      workerB = new Worker(
        caseQueueName,
        (job: DeliveryJob): Promise<DeliveryTestResult> => {
          state.workerAStillActiveWhenWorkerBStarted = state.workerAInFlight;
          const entryGeneration = job.attemptsStarted;
          const entryMade = job.attemptsMade;
          activations.push({
            workerLabel: 'worker-b',
            jobId: job.id,
            attemptsStarted: entryGeneration,
            attemptsMade: entryMade,
          });
          return Promise.resolve({
            completedBy: 'worker-b',
            attemptsStarted: entryGeneration,
          });
        },
        {
          connection,
          prefix: queuePrefix,
          concurrency: 1,
          lockDuration: 5_000,
          stalledInterval: 200,
          maxStalledCount: 1,
          drainDelay: 1,
          autorun: false,
        },
      );

      workerB.on('error', (err: Error) => {
        workerBErrors.push(err);
      });
      workerB.on('failed', (_job: DeliveryJob | undefined, err: Error) => {
        workerBErrors.push(err);
      });
      workerB.on('stalled', (jobId: string) => {
        stalledEvents.push(jobId);
      });
      workerB.on('completed', (job: DeliveryJob) => {
        if (job.id === expectedJobId) {
          workerBCompleted.resolve(job.id);
        }
      });

      workerARun = workerA.run().catch((err: unknown) => {
        workerAErrors.push(err);
      });

      await caseQueue.add('delivery-test', { label: 'stalled-recovery' }, { jobId: expectedJobId });

      // 1. Wait deterministically for Worker A to enter its processor callback
      await withTimeout(workerAEntered.promise, 8_000, 'Worker A initial delivery');

      // 2. Start Worker B only while Worker A is actively blocked in its processor
      workerBRun = workerB.run().catch((err: unknown) => {
        workerBErrors.push(err);
      });

      // 3. Wait for BullMQ's real stalled-job recovery to reactivate and complete on Worker B
      const completedId = await withTimeout(
        workerBCompleted.promise,
        10_000,
        'Worker B stalled recovery completion',
      );
      expect(completedId).toBe(expectedJobId);
      expect(state.workerAStillActiveWhenWorkerBStarted).toBe(true);
      expect(stalledEvents).toContain(expectedJobId);

      // 4. Release Worker A and await its processor callback unwind
      releaseWorkerA.resolve();
      await withTimeout(workerAExited.promise, 5_000, 'Worker A processor unwind');

      // 5. Confirm BOTH workers have closed and settled BEFORE asserting errors and final Redis state
      state.workerAClosed = await confirmWorkerClosed(workerA, 5_000);
      state.workerBClosed = await confirmWorkerClosed(workerB, 5_000);
      await Promise.all([workerARun, workerBRun]);
      expect(state.workerAClosed).toBe(true);
      expect(state.workerBClosed).toBe(true);

      // 6. Verify worker errors strictly after settlement/closure
      expect(workerBErrors).toEqual([]);
      // Obsolete completion must not succeed, even if no error is emitted.
      expect(workerACompletedIds).toEqual([]);
      for (const err of workerAErrors) {
        expect(
          isExpectedObsoleteCompletionError(err, expectedJobId),
          `Unexpected Worker A error: ${formatErrorSummary(err)}`,
        ).toBe(true);
      }

      // 7. Verify measured delivery generations
      const actA = activations.find((a) => a.workerLabel === 'worker-a');
      const actB = activations.find((a) => a.workerLabel === 'worker-b');
      expect(activations).toHaveLength(2);
      expect(actA).toBeDefined();
      expect(actB).toBeDefined();

      if (actA !== undefined && actB !== undefined) {
        expect(actA.jobId).toBe(expectedJobId);
        expect(actB.jobId).toBe(expectedJobId);
        expect(actA.attemptsStarted).toBe(1);
        expect(actB.attemptsStarted).toBeGreaterThan(actA.attemptsStarted);
        expect(actB.attemptsStarted).toBe(2);
        expect(actA.attemptsMade).toBe(0);
        expect(actB.attemptsMade).toBe(0);

        // 8. Demonstrate proposed claim rule directly using actual measured generations
        const measuredClaim = new DeliveryGenerationClaimContract();
        expect(measuredClaim.tryClaim(actB.attemptsStarted)).toEqual({
          accepted: true,
          storedGeneration: actB.attemptsStarted,
        });
        expect(measuredClaim.tryClaim(actA.attemptsStarted)).toEqual({
          accepted: false,
          storedGeneration: actB.attemptsStarted,
        });
        expect(measuredClaim.tryClaim(actB.attemptsStarted)).toEqual({
          accepted: false,
          storedGeneration: actB.attemptsStarted,
        });
      }

      // 9. Verify final Redis job state after Worker A unwound and both workers closed:
      //    Worker A's obsolete return value must NOT overwrite Worker B's successful result.
      const finalJob = await caseQueue.getJob(expectedJobId);
      expect(finalJob).toBeDefined();
      expect(await finalJob?.getState()).toBe('completed');
      expect(finalJob?.attemptsStarted).toBe(2);
      expect(finalJob?.returnvalue).toEqual({
        completedBy: 'worker-b',
        attemptsStarted: 2,
      });

      process.stdout.write(
        `[5.3A-SUMMARY] Test B (stalled-recovery): ${JSON.stringify({
          jobId: expectedJobId,
          activations,
          workerAStillActiveWhenWorkerBStarted: state.workerAStillActiveWhenWorkerBStarted,
          workerAObservedErrors: workerAErrors.map(formatErrorSummary),
          workerACompletedIds,
          finalState: 'completed',
          finalAttemptsStarted: finalJob?.attemptsStarted,
          finalReturnValue: finalJob?.returnvalue,
        })}\n`,
      );
    } finally {
      releaseWorkerA.resolve();
      if (state.workerAStarted && !state.workerAExited) {
        await withTimeout(workerAExited.promise, 5_000, 'Worker A barrier unwind in finally');
      }
      if (workerA !== undefined && !state.workerAClosed) {
        state.workerAClosed = await confirmWorkerClosed(workerA, 5_000);
      }
      if (workerB !== undefined && !state.workerBClosed) {
        state.workerBClosed = await confirmWorkerClosed(workerB, 5_000);
      }
      if (workerARun !== undefined) {
        await workerARun;
      }
      if (workerBRun !== undefined) {
        await workerBRun;
      }

      const ownershipConfirmed =
        (workerA === undefined || state.workerAClosed) &&
        (workerB === undefined || state.workerBClosed) &&
        (!state.workerAStarted || state.workerAExited);

      if (caseQueue !== undefined) {
        if (ownershipConfirmed) {
          await obliterateAndCloseQueue(caseQueue);
          outstandingCaseOwnership.delete(caseQueueName);
        } else {
          await caseQueue.close();
        }
      } else if (ownershipConfirmed) {
        outstandingCaseOwnership.delete(caseQueueName);
      }
    }
  }, 25_000);

  it('Test C (synthetic contract): enforces incomingGeneration > storedGeneration and PostgreSQL int32 bounds', () => {
    const contract = new DeliveryGenerationClaimContract();
    expect(contract.getStoredGeneration()).toBe(0);

    // Invalid generations rejected without mutation
    for (const invalid of [0, -1, 1.5, Number.NaN, PG_MAX_INT32 + 1]) {
      expect(contract.tryClaim(invalid)).toEqual({ accepted: false, storedGeneration: 0 });
    }

    // Newer generation accepted; delayed older and equal generations rejected
    expect(contract.tryClaim(2)).toEqual({ accepted: true, storedGeneration: 2 });
    expect(contract.tryClaim(1)).toEqual({ accepted: false, storedGeneration: 2 });
    expect(contract.tryClaim(2)).toEqual({ accepted: false, storedGeneration: 2 });
    expect(contract.tryClaim(3)).toEqual({ accepted: true, storedGeneration: 3 });

    // Maximum PostgreSQL 32-bit signed integer boundary
    expect(contract.tryClaim(PG_MAX_INT32)).toEqual({
      accepted: true,
      storedGeneration: PG_MAX_INT32,
    });
    expect(contract.tryClaim(PG_MAX_INT32)).toEqual({
      accepted: false,
      storedGeneration: PG_MAX_INT32,
    });
    expect(contract.tryClaim(PG_MAX_INT32 + 1)).toEqual({
      accepted: false,
      storedGeneration: PG_MAX_INT32,
    });
  });
});
