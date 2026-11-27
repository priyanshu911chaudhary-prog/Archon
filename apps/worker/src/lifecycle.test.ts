import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  createWorkerServiceLifecycle,
  type ShutdownOutcome,
  type SignalTargetLike,
  type UnconfirmedShutdownInfo,
} from './lifecycle.js';
import { IngestionCancelledError, type IngestionProcessorJob } from './processor.js';
import { closeWorkerWithTimeout, shutdownWorkerResources } from './queue.js';
import { ParserIntegrationError, classifyParserRunnerError } from './parser-integration.js';
import { ParserRunnerError } from './parser-runner.js';

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

class FakeSignalTarget extends EventEmitter implements SignalTargetLike {
  override on(event: 'SIGINT' | 'SIGTERM', listener: () => void): this {
    return super.on(event, listener);
  }
  override removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): this {
    return super.removeListener(event, listener);
  }
}

function makeDummyJob(): IngestionProcessorJob {
  return {
    id: 'job-1',
    data: {
      repoId: '00000000-0000-4000-8000-000000000001',
      jobId: '00000000-0000-4000-8000-000000000002',
      owner: 'pmndrs',
      name: 'zustand',
      commitSha: '9fed2eb2f3af672da9f7bf694b996df3831fc207',
    },
    attemptsMade: 0,
    attemptsStarted: 1,
    opts: { attempts: 2 },
  };
}

describe('WorkerServiceLifecycle & fail-closed BullMQ shutdown (Batch 4.3D.2)', () => {
  it('executes single graceful worker.close() without ever calling worker.close(true) and closes Queue -> Redis -> PostgreSQL in strict order', async () => {
    const events: string[] = [];
    const workerCloseCalls: (boolean | undefined)[] = [];
    const exitCodes: (0 | 1)[] = [];

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 500,
      setExitCode: (code) => {
        exitCodes.push(code);
      },
    });
    const sigTarget = new FakeSignalTarget();
    lifecycle.installSignalHandlers(sigTarget);

    lifecycle.setWorker({
      close: (force?: boolean) => {
        workerCloseCalls.push(force);
        events.push('worker.close');
        return Promise.resolve();
      },
    });
    lifecycle.setQueue({
      close: () => {
        events.push('queue.close');
        return Promise.resolve();
      },
    });
    lifecycle.addRedisClient({
      quit: () => {
        events.push('redis.quit');
        return Promise.resolve('OK');
      },
      disconnect: () => {
        events.push('redis.disconnect');
      },
    });
    lifecycle.setCloseDb(() => {
      events.push('db.close');
      return Promise.resolve();
    });
    lifecycle.markRunning();

    const outcome = await lifecycle.shutdown('SIGTERM');

    expect(outcome.confirmed).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.phase).toBe('closed');
    expect(workerCloseCalls).toEqual([undefined]); // NEVER calls worker.close(true)
    expect(events).toEqual(['worker.close', 'queue.close', 'redis.quit', 'db.close']);
    expect(exitCodes).toEqual([0]);
    // Signal handlers removed cleanly ONLY after confirmed shutdown
    expect(sigTarget.listenerCount('SIGINT')).toBe(0);
    expect(sigTarget.listenerCount('SIGTERM')).toBe(0);
  });

  it('signals ingestion cancellation immediately during embedded API shutdown without waiting for HTTP connections to drain', async () => {
    const events: string[] = [];
    const httpCloseDeferred = createDeferred();
    const workerCloseDeferred = createDeferred();

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'api',
      closeTimeoutMs: 500,
      setExitCode: () => undefined,
    });

    lifecycle.shutdownSignal.addEventListener('abort', () => {
      events.push('shutdownSignal.aborted');
    });
    lifecycle.setHttpClose(() => {
      events.push('http.close.start');
      return httpCloseDeferred.promise.then(() => {
        events.push('http.close.done');
      });
    });
    lifecycle.setWorker({
      close: () => {
        events.push('worker.close.start');
        return workerCloseDeferred.promise.then(() => {
          events.push('worker.close.done');
        });
      },
    });
    lifecycle.setCloseDb(() => {
      events.push('db.close');
      return Promise.resolve();
    });

    const shutdownPromise = lifecycle.shutdown('SIGTERM');
    await Promise.resolve();

    // Parser cancellation & worker.close() MUST already be initiated while HTTP is still draining
    expect(lifecycle.shutdownSignal.aborted).toBe(true);
    expect(events).toEqual(['shutdownSignal.aborted', 'worker.close.start', 'http.close.start']);

    workerCloseDeferred.resolve();
    httpCloseDeferred.resolve();
    const outcome = await shutdownPromise;
    expect(outcome.confirmed).toBe(true);
    expect(events.at(-1)).toBe('db.close');
  });

  it('keeps repeated SIGINT/SIGTERM triggers idempotent and never starts duplicate worker.close() calls', async () => {
    let workerCloseCount = 0;
    const workerCloseDeferred = createDeferred();
    const workerCloseStarted = createDeferred();
    const sigTarget = new FakeSignalTarget();

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 500,
      setExitCode: () => undefined,
    });
    lifecycle.installSignalHandlers(sigTarget);
    lifecycle.setWorker({
      close: () => {
        workerCloseCount += 1;
        workerCloseStarted.resolve();
        return workerCloseDeferred.promise;
      },
    });

    // Repeated SIGINT + SIGTERM while shutdown is still pending
    sigTarget.emit('SIGINT');
    sigTarget.emit('SIGINT');
    sigTarget.emit('SIGTERM');
    const p1 = lifecycle.shutdown('SIGTERM');
    const p2 = lifecycle.shutdown('SIGINT');

    expect(p1).toBe(p2);
    expect(lifecycle.shutdownSignal.aborted).toBe(true);

    await workerCloseStarted.promise;

    expect(workerCloseCount).toBe(1);
    // Persistent listeners remain attached while shutdown is still in progress
    expect(sigTarget.listenerCount('SIGINT')).toBe(1);
    expect(sigTarget.listenerCount('SIGTERM')).toBe(1);

    workerCloseDeferred.resolve();
    const outcome = await p1;
    expect(workerCloseCount).toBe(1);
    expect(outcome.confirmed).toBe(true);
    expect(sigTarget.listenerCount('SIGINT')).toBe(0);
    expect(sigTarget.listenerCount('SIGTERM')).toBe(0);
  });

  it('on observation timeout, refuses to close Queue/Redis/PostgreSQL prematurely, retains signal listeners, and completes ordered cleanup on late closure', async () => {
    const workerCloseDeferred = createDeferred();
    const closedResources: string[] = [];
    const unconfirmedEvents: UnconfirmedShutdownInfo[] = [];
    const lateEvents: ShutdownOutcome[] = [];
    const exitCodes: (0 | 1)[] = [];
    const sigTarget = new FakeSignalTarget();

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 30,
      setExitCode: (code) => {
        exitCodes.push(code);
      },
      onUnconfirmedShutdown: (info) => {
        unconfirmedEvents.push(info);
      },
      onLateCleanupComplete: (outcome) => {
        lateEvents.push(outcome);
      },
    });
    lifecycle.installSignalHandlers(sigTarget);

    let closeCallCount = 0;
    lifecycle.setWorker({
      close: () => {
        closeCallCount += 1;
        return workerCloseDeferred.promise;
      },
    });
    lifecycle.setQueue({
      close: () => {
        closedResources.push('queue');
        return Promise.resolve();
      },
    });
    lifecycle.addRedisClient({
      quit: () => {
        closedResources.push('redis');
        return Promise.resolve('OK');
      },
      disconnect: () => undefined,
    });
    lifecycle.setCloseDb(() => {
      closedResources.push('db');
      return Promise.resolve();
    });

    const outcome = await lifecycle.shutdown('SIGTERM');

    expect(outcome.confirmed).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.phase).toBe('unconfirmed_shutdown');
    expect(closeCallCount).toBe(1); // NO fake second worker.close(true)
    expect(closedResources).toEqual([]); // DB/Redis/Queue MUST stay open!
    expect(unconfirmedEvents).toHaveLength(1);
    expect(exitCodes).toEqual([1]);
    // Signal handlers remain installed while unconfirmed
    expect(sigTarget.listenerCount('SIGTERM')).toBe(1);

    // Late worker close finally settles -> ordered cleanup runs now
    workerCloseDeferred.resolve();
    const lateOutcome = await outcome.pendingCleanup;
    expect(lateOutcome?.confirmed).toBe(true);
    expect(closedResources).toEqual(['queue', 'redis', 'db']);
    expect(lateEvents).toHaveLength(1);
    expect(sigTarget.listenerCount('SIGTERM')).toBe(0);
  });

  it('distinguishes rejected worker.close() from confirmed closure and refuses to close DB/Redis prematurely', async () => {
    const closedResources: string[] = [];
    const unconfirmedEvents: UnconfirmedShutdownInfo[] = [];

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 500,
      setExitCode: () => undefined,
      onUnconfirmedShutdown: (info) => {
        unconfirmedEvents.push(info);
      },
    });
    lifecycle.setWorker({
      close: () => Promise.reject(new Error('Redis connection dropped during close')),
    });
    lifecycle.setCloseDb(() => {
      closedResources.push('db');
      return Promise.resolve();
    });

    const outcome = await lifecycle.shutdown('SIGTERM');
    expect(outcome.confirmed).toBe(false);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(unconfirmedEvents[0]?.workerCloseRejected).toBe(true);
    expect(closedResources).toEqual([]);
  });

  it('synchronously latches fatal quarantine, aborts fatalSignal, blocks new jobs, preserves active workspace/DB until late close, and stays permanently fatal', async () => {
    const activeJobDeferred = createDeferred();
    const workerCloseDeferred = createDeferred();
    const closedResources: string[] = [];

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 30,
      setExitCode: () => undefined,
    });
    lifecycle.setWorker({
      close: () => workerCloseDeferred.promise,
    });
    lifecycle.setCloseDb(() => {
      closedResources.push('db');
      return Promise.resolve();
    });

    const wrapped = lifecycle.wrapProcessor(() => activeJobDeferred.promise);
    const activeRun = wrapped(makeDummyJob());
    expect(lifecycle.hasActiveJob()).toBe(true);

    // Fatal callback fires while active parser job remains pending
    lifecycle.triggerFatal({
      persistedCode: 'PARSER_FATAL_TERMINATION',
      runnerCode: 'FATAL_TERMINATION_UNCONFIRMED',
      safeMessage: 'Parser termination could not be confirmed; worker requires restart.',
      requestId: '11111111-2222-4333-8444-555555555555',
      pid: 99_999,
      processExited: false,
    });

    expect(lifecycle.isFatal()).toBe(true);
    expect(lifecycle.fatalSignal.aborted).toBe(true);
    expect(lifecycle.shutdownSignal.aborted).toBe(true);
    expect(lifecycle.getPhase()).toBe('quarantined_fatal');

    // New jobs are blocked synchronously
    await expect(wrapped(makeDummyJob())).rejects.toBeInstanceOf(IngestionCancelledError);

    // Observation timeout expires while job + worker close are pending -> DB stays open!
    const shutdownOutcome = await lifecycle.shutdown('FATAL_PARSER_STATE');
    expect(shutdownOutcome.confirmed).toBe(false);
    expect(shutdownOutcome.fatal).toBe(true);
    expect(closedResources).toEqual([]);

    // Late OS exit finally resolves active job and worker close -> DB closes, lifecycle stays fatal
    activeJobDeferred.resolve();
    await activeRun;
    workerCloseDeferred.resolve();
    const lateOutcome = await shutdownOutcome.pendingCleanup;
    expect(lateOutcome?.confirmed).toBe(true);
    expect(lateOutcome?.fatal).toBe(true);
    expect(closedResources).toEqual(['db']);
    expect(lifecycle.isFatal()).toBe(true);
    expect(lifecycle.getPhase()).toBe('quarantined_fatal');
  });

  it('waits for active wrapped job (and its heartbeat drain) even if worker.close() resolves early', async () => {
    const activeJobDeferred = createDeferred();
    const events: string[] = [];

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 500,
      setExitCode: () => undefined,
    });
    lifecycle.setWorker({
      close: () => {
        events.push('worker.close.resolved');
        return Promise.resolve();
      },
    });
    lifecycle.setCloseDb(() => {
      events.push('db.close');
      return Promise.resolve();
    });

    const wrapped = lifecycle.wrapProcessor(async () => {
      await activeJobDeferred.promise;
      events.push('activeJob.settled');
    });
    const runPromise = wrapped(makeDummyJob());

    const shutdownPromise = lifecycle.shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['worker.close.resolved']); // DB MUST NOT close before activeJob settles!

    activeJobDeferred.resolve();
    await runPromise;
    const outcome = await shutdownPromise;
    expect(outcome.confirmed).toBe(true);
    expect(events).toEqual(['worker.close.resolved', 'activeJob.settled', 'db.close']);
  });

  it('releases only actually acquired resources on partial startup failure', async () => {
    const closed: string[] = [];
    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'api',
      closeTimeoutMs: 500,
      setExitCode: () => undefined,
    });

    // Simulate startup acquiring DB + Redis, then failing before Queue/Worker/HTTP are created
    lifecycle.setCloseDb(() => {
      closed.push('db');
      return Promise.resolve();
    });
    lifecycle.addRedisClient({
      quit: () => {
        closed.push('redis');
        return Promise.resolve('OK');
      },
      disconnect: () => undefined,
    });

    const outcome = await lifecycle.shutdown('STARTUP_FAILURE');
    expect(outcome.confirmed).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(closed).toEqual(['redis', 'db']);
  });

  it('supports API mode without worker (RUN_EMBEDDED_WORKER=false) closing HTTP -> Queue -> Redis -> DB cleanly', async () => {
    const closed: string[] = [];
    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'api',
      closeTimeoutMs: 500,
      setExitCode: () => undefined,
    });
    lifecycle.setHttpClose(() => {
      closed.push('http');
      return Promise.resolve();
    });
    lifecycle.setQueue({
      close: () => {
        closed.push('queue');
        return Promise.resolve();
      },
    });
    lifecycle.addRedisClient({
      quit: () => {
        closed.push('redis');
        return Promise.resolve('OK');
      },
      disconnect: () => undefined,
    });
    lifecycle.setCloseDb(() => {
      closed.push('db');
      return Promise.resolve();
    });

    const outcome = await lifecycle.shutdown('SIGTERM');
    expect(outcome.confirmed).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(closed).toEqual(['http', 'queue', 'redis', 'db']);
  });

  it('closeWorkerWithTimeout & shutdownWorkerResources never call worker.close(true) and keep downstream resources open on timeout/rejection', async () => {
    const closeCalls: (boolean | undefined)[] = [];
    const pending = createDeferred();
    let dbClosed = false;

    const obs = await closeWorkerWithTimeout(
      {
        close: (force?: boolean) => {
          closeCalls.push(force);
          return pending.promise;
        },
      },
      25,
    );
    expect(obs.closed).toBe(false);
    expect(obs.timedOut).toBe(true);
    expect(closeCalls).toEqual([undefined]);

    const res = await shutdownWorkerResources({
      worker: {
        close: () => Promise.reject(new Error('close boom')),
      },
      closeDb: () => {
        dbClosed = true;
        return Promise.resolve();
      },
      workerCloseTimeoutMs: 50,
    });
    expect(res.confirmed).toBe(false);
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(dbClosed).toBe(false);

    pending.resolve();
  });
  it('refuses to dispose shared Queue/Redis/PostgreSQL and retains signal handlers on immediate HTTP close rejection even when worker closes cleanly', async () => {
    const closedResources: string[] = [];
    const unconfirmed: UnconfirmedShutdownInfo[] = [];
    const exitCodes: (0 | 1)[] = [];
    const sigTarget = new FakeSignalTarget();

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'api',
      closeTimeoutMs: 500,
      setExitCode: (code) => {
        exitCodes.push(code);
      },
      onUnconfirmedShutdown: (info) => {
        unconfirmed.push(info);
      },
    });
    lifecycle.installSignalHandlers(sigTarget);
    lifecycle.setWorker({ close: () => Promise.resolve() });
    lifecycle.setHttpClose(() => Promise.reject(new Error('HTTP keep-alive close rejected')));
    lifecycle.setQueue({
      close: () => {
        closedResources.push('queue');
        return Promise.resolve();
      },
    });
    lifecycle.addRedisClient({
      quit: () => {
        closedResources.push('redis');
        return Promise.resolve('OK');
      },
      disconnect: () => undefined,
    });
    lifecycle.setCloseDb(() => {
      closedResources.push('db');
      return Promise.resolve();
    });

    const outcome = await lifecycle.shutdown('SIGTERM');
    expect(outcome.confirmed).toBe(false);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.phase).toBe('unconfirmed_shutdown');
    expect(closedResources).toEqual([]);
    expect(exitCodes).toEqual([1]);
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0]?.httpCloseRejected).toBe(true);
    expect(unconfirmed[0]?.workerCloseRejected).toBe(false);
    expect(sigTarget.listenerCount('SIGTERM')).toBe(1);
    lifecycle.removeSignalHandlers();
  });

  it('treats synchronous HTTP close throw identically to HTTP close rejection without disposing downstream resources', async () => {
    const closedResources: string[] = [];
    const unconfirmed: UnconfirmedShutdownInfo[] = [];

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'api',
      closeTimeoutMs: 500,
      setExitCode: () => undefined,
      onUnconfirmedShutdown: (info) => {
        unconfirmed.push(info);
      },
    });
    lifecycle.setWorker({ close: () => Promise.resolve() });
    lifecycle.setHttpClose(() => {
      throw new Error('sync HTTP close throw');
    });
    lifecycle.setCloseDb(() => {
      closedResources.push('db');
      return Promise.resolve();
    });

    const outcome = await lifecycle.shutdown('SIGTERM');
    expect(outcome.confirmed).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(unconfirmed[0]?.httpCloseRejected).toBe(true);
    expect(closedResources).toEqual([]);
  });

  it('refuses deferred downstream disposal when HTTP close rejects AFTER the observation timeout elapses', async () => {
    const httpCloseDeferred = createDeferred();
    const closedResources: string[] = [];
    const unconfirmed: UnconfirmedShutdownInfo[] = [];
    const sigTarget = new FakeSignalTarget();

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'api',
      closeTimeoutMs: 25,
      setExitCode: () => undefined,
      onUnconfirmedShutdown: (info) => {
        unconfirmed.push(info);
      },
    });
    lifecycle.installSignalHandlers(sigTarget);
    lifecycle.setWorker({ close: () => Promise.resolve() });
    lifecycle.setHttpClose(() => httpCloseDeferred.promise);
    lifecycle.setCloseDb(() => {
      closedResources.push('db');
      return Promise.resolve();
    });

    const outcome = await lifecycle.shutdown('SIGTERM');
    expect(outcome.confirmed).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(closedResources).toEqual([]);

    // HTTP close rejects after observation timeout -> deferred cleanup MUST NOT dispose DB
    httpCloseDeferred.reject(new Error('late HTTP close failure'));
    const deferredOutcome = await outcome.pendingCleanup;
    expect(deferredOutcome?.confirmed).toBe(false);
    expect(deferredOutcome?.exitCode).toBe(1);
    expect(closedResources).toEqual([]);
    expect(unconfirmed.some((u) => u.httpCloseRejected)).toBe(true);
    expect(sigTarget.listenerCount('SIGTERM')).toBe(1);
    lifecycle.removeSignalHandlers();
  });

  it('startup ownership barrier prevents premature DB disposal when SIGTERM arrives mid-startup and disposes late-registered resources cleanly without deadlock', async () => {
    const events: string[] = [];
    const listenDeferred = createDeferred();
    const sigTarget = new FakeSignalTarget();

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'api',
      closeTimeoutMs: 500,
      setExitCode: () => undefined,
    });
    lifecycle.beginStartup();
    lifecycle.installSignalHandlers(sigTarget);

    lifecycle.setCloseDb(() => {
      events.push('db.close');
      return Promise.resolve();
    });

    // Simulate async startup in progress (e.g. app.listen)
    let workerStarted = false;
    const startupFlow = (async () => {
      await listenDeferred.promise;
      // Late resource registered right before startup releases ownership
      lifecycle.setHttpClose(() => {
        events.push('http.close');
        return Promise.resolve();
      });
      if (lifecycle.isShuttingDown()) {
        lifecycle.endStartupOwnership();
        const pending = lifecycle.waitForShutdown();
        if (pending !== null) {
          await pending;
        }
        return;
      }
      workerStarted = true;
      lifecycle.markRunning();
    })();

    // SIGTERM fires while app.listen is still pending
    const shutdownPromise = lifecycle.shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    // DB MUST NOT be closed while startup still owns resources
    expect(events).toEqual([]);

    // Startup finishes listen, registers httpClose, releases ownership -> shutdown completes cleanly
    listenDeferred.resolve();
    await startupFlow;
    const outcome = await shutdownPromise;

    expect(workerStarted).toBe(false);
    expect(outcome.confirmed).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(events).toEqual(['http.close', 'db.close']);
    expect(sigTarget.listenerCount('SIGTERM')).toBe(0);
  });

  it('startup ownership timeout keeps shared resources open until late startup release, then disposes cleanly with exitCode 1', async () => {
    const events: string[] = [];
    const unconfirmed: UnconfirmedShutdownInfo[] = [];

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 25,
      setExitCode: () => undefined,
      onUnconfirmedShutdown: (info) => {
        unconfirmed.push(info);
      },
    });
    lifecycle.beginStartup();
    lifecycle.setCloseDb(() => {
      events.push('db.close');
      return Promise.resolve();
    });

    const outcome = await lifecycle.shutdown('SIGTERM');
    expect(outcome.confirmed).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(unconfirmed[0]?.startupPending).toBe(true);
    expect(events).toEqual([]);

    // Startup finally unwinds -> deferred cleanup closes DB and preserves monotonic exitCode 1
    lifecycle.endStartupOwnership();
    const lateOutcome = await outcome.pendingCleanup;
    expect(lateOutcome?.confirmed).toBe(true);
    expect(lateOutcome?.exitCode).toBe(1);
    expect(events).toEqual(['db.close']);
  });

  it('preserves monotonic failure exitCode 1 when fatal notification arrives during an active ordinary SIGTERM shutdown', async () => {
    const workerCloseDeferred = createDeferred();
    const exitCodes: (0 | 1)[] = [];

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 500,
      setExitCode: (code) => {
        exitCodes.push(code);
      },
    });
    lifecycle.setWorker({ close: () => workerCloseDeferred.promise });
    lifecycle.setCloseDb(() => Promise.resolve());

    const shutdownPromise = lifecycle.shutdown('SIGTERM');
    await Promise.resolve();

    // Fatal notification arrives AFTER ordinary SIGTERM shutdown began
    lifecycle.triggerFatal({
      persistedCode: 'PARSER_FATAL_CLEANUP',
      runnerCode: 'FATAL_CLEANUP_UNCONFIRMED',
      safeMessage: 'Parser resource cleanup could not be confirmed; worker requires restart.',
      requestId: '11111111-2222-4333-8444-555555555555',
      pid: 42_000,
      processExited: true,
    });

    workerCloseDeferred.resolve();
    const outcome = await shutdownPromise;
    expect(outcome.confirmed).toBe(true);
    expect(outcome.fatal).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(exitCodes.at(-1)).toBe(1);
    expect(lifecycle.isFatal()).toBe(true);
  });

  it('preserves monotonic failure exitCode 1 when infrastructure failure arrives during graceful shutdown', async () => {
    const workerCloseDeferred = createDeferred();
    const exitCodes: (0 | 1)[] = [];

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 500,
      setExitCode: (code) => {
        exitCodes.push(code);
      },
    });
    lifecycle.setWorker({ close: () => workerCloseDeferred.promise });

    const shutdownPromise = lifecycle.shutdown('SIGINT');
    await Promise.resolve();

    const infraErr = new ParserIntegrationError(
      classifyParserRunnerError(
        new ParserRunnerError({
          code: 'MISSING_ENTRYPOINT',
          message: 'missing',
          retryable: false,
          startupFailure: true,
        }),
      ),
    );
    lifecycle.triggerInfrastructureFailure(infraErr);

    workerCloseDeferred.resolve();
    const outcome = await shutdownPromise;
    expect(outcome.confirmed).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(exitCodes.at(-1)).toBe(1);
  });

  it('coalesces synchronous shutdown reentrancy from an abort listener into one promise and one worker.close() call', async () => {
    let workerCloseCalls = 0;
    let reentrantPromise: Promise<ShutdownOutcome> | undefined;

    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 500,
      setExitCode: () => undefined,
    });
    lifecycle.setWorker({
      close: () => {
        workerCloseCalls += 1;
        return Promise.resolve();
      },
    });

    lifecycle.shutdownSignal.addEventListener('abort', () => {
      reentrantPromise = lifecycle.shutdown('SIGINT');
    });

    const outerPromise = lifecycle.shutdown('SIGTERM');
    expect(reentrantPromise).toBe(outerPromise);

    const outcome = await outerPromise;
    expect(outcome.confirmed).toBe(true);
    expect(workerCloseCalls).toBe(1);
  });

  it('survives throwing logger and supervision callbacks without disrupting cancellation or resource cleanup', async () => {
    let dbClosed = false;
    const lifecycle = createWorkerServiceLifecycle({
      serviceName: 'worker',
      closeTimeoutMs: 500,
      setExitCode: () => {
        throw new Error('exitCode hook error');
      },
      logger: {
        info: () => {
          throw new Error('logger info failed');
        },
        warn: () => {
          throw new Error('logger warn failed');
        },
        error: () => {
          throw new Error('logger error failed');
        },
      },
    });
    lifecycle.setWorker({ close: () => Promise.resolve() });
    lifecycle.setCloseDb(() => {
      dbClosed = true;
      return Promise.resolve();
    });

    const outcome = await lifecycle.shutdown('SIGTERM');
    expect(outcome.confirmed).toBe(true);
    expect(dbClosed).toBe(true);
  });
});
