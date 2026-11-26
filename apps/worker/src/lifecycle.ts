import type { Logger } from '@archon/shared';
import type { ParserIntegrationError, SafeParserFatalNotification } from './parser-integration.js';
import { IngestionCancelledError, type IngestionProcessorJob } from './processor.js';
import {
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
  type IngestionQueue,
  type IngestionWorker,
} from './queue.js';
import { closeRedisClient, type ClosableRedisClient } from './redis.js';

export type WorkerServiceLifecyclePhase =
  | 'initializing'
  | 'running'
  | 'shutting_down'
  | 'quarantined_fatal'
  | 'unconfirmed_shutdown'
  | 'closed';

export type ShutdownTriggerReason =
  | 'SIGINT'
  | 'SIGTERM'
  | 'FATAL_PARSER_STATE'
  | 'INFRASTRUCTURE_FAILURE'
  | 'WORKER_RUN_ERROR'
  | 'STARTUP_FAILURE'
  | 'EXPLICIT';

export interface UnconfirmedShutdownInfo {
  readonly reason: ShutdownTriggerReason;
  readonly timedOut: boolean;
  readonly startupPending: boolean;
  readonly workerCloseRejected: boolean;
  readonly httpCloseRejected: boolean;
  readonly activeJobPending: boolean;
  readonly fatalLatched: boolean;
  readonly fatalNotification: SafeParserFatalNotification | null;
}

export interface ShutdownOutcome {
  readonly confirmed: boolean;
  readonly timedOut: boolean;
  readonly fatal: boolean;
  readonly exitCode: 0 | 1;
  readonly phase: WorkerServiceLifecyclePhase;
  readonly pendingCleanup?: Promise<ShutdownOutcome>;
}

export interface SignalTargetLike {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface WrapProcessorOptions {
  /**
   * When true, jobs dispatched by BullMQ after shutdown/fatal is latched (while DB is still open)
   * are delegated into the processor so step-1 cancellation/fatal guards can perform final-attempt
   * PostgreSQL failure bookkeeping without running extraction or parsing.
   */
  readonly delegateStoppedToProcessor?: boolean;
}

export interface WorkerServiceLifecycleOptions {
  readonly serviceName: 'worker' | 'api';
  readonly closeTimeoutMs?: number;
  readonly logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly setExitCode?: (code: 0 | 1) => void;
  readonly onUnconfirmedShutdown?: (info: UnconfirmedShutdownInfo) => void;
  readonly onLateCleanupComplete?: (outcome: ShutdownOutcome) => void;
}

export interface WorkerServiceLifecycle {
  readonly shutdownSignal: AbortSignal;
  readonly fatalSignal: AbortSignal;
  readonly getPhase: () => WorkerServiceLifecyclePhase;
  readonly isShuttingDown: () => boolean;
  readonly isFatal: () => boolean;
  readonly hasActiveJob: () => boolean;
  readonly isStartupOwned: () => boolean;
  /** Acquires the startup ownership barrier so shutdown waits before disposing shared resources. */
  readonly beginStartup: () => void;
  /** Releases the startup ownership barrier (idempotent; must be called before awaiting shutdown). */
  readonly endStartupOwnership: () => void;
  /** Transitions to `running` (if not shutting down/fatal) and releases the startup barrier. */
  readonly markRunning: () => void;
  /** Returns the active shutdown promise if shutdown has started, or null otherwise. */
  readonly waitForShutdown: () => Promise<ShutdownOutcome> | null;
  readonly setHttpClose: (closeHttp: () => Promise<void>) => void;
  readonly setWorker: (worker: Pick<IngestionWorker, 'close'>) => void;
  readonly setQueue: (queue: Pick<IngestionQueue, 'close'>) => void;
  readonly addRedisClient: (client: ClosableRedisClient) => void;
  readonly setCloseDb: (closeDb: () => Promise<void>) => void;
  readonly wrapProcessor: <TJob extends IngestionProcessorJob>(
    processor: (job: TJob) => Promise<void>,
    options?: WrapProcessorOptions,
  ) => (job: TJob) => Promise<void>;
  readonly triggerFatal: (notification: SafeParserFatalNotification) => void;
  readonly triggerInfrastructureFailure: (error: ParserIntegrationError) => void;
  readonly shutdown: (reason: ShutdownTriggerReason) => Promise<ShutdownOutcome>;
  readonly installSignalHandlers: (target?: SignalTargetLike) => void;
  readonly removeSignalHandlers: () => void;
}

function isFailureTriggerReason(reason: ShutdownTriggerReason): boolean {
  return (
    reason === 'FATAL_PARSER_STATE' ||
    reason === 'INFRASTRUCTURE_FAILURE' ||
    reason === 'WORKER_RUN_ERROR' ||
    reason === 'STARTUP_FAILURE'
  );
}

/**
 * Shared idempotent lifecycle & shutdown coordinator for standalone worker and embedded API worker.
 *
 * Guarantees & honest boundaries:
 * - Pre-publishes a single shared shutdown promise before firing `AbortSignal` or resource hooks
 *   so synchronous reentrancy always coalesces into one shutdown and one `worker.close()` call.
 * - Startup ownership barrier prevents premature DB/Redis/Queue disposal while async startup
 *   steps are still acquiring resources, without deadlocking when startup releases before awaiting.
 * - Requires confirmed worker closure, active job/heartbeat settlement, AND confirmed HTTP closure
 *   before disposing shared Queue/Redis/PostgreSQL or removing signal listeners.
 * - Failure exit status is strictly monotonic: fatal, infrastructure, startup, run-loop, timeout,
 *   or close rejections latch `exitCode = 1` permanently, even if late cleanup succeeds.
 */
export function createWorkerServiceLifecycle(
  options: WorkerServiceLifecycleOptions,
): WorkerServiceLifecycle {
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_WORKER_CLOSE_TIMEOUT_MS;
  const rawSetExitCode =
    options.setExitCode ??
    ((code: 0 | 1) => {
      process.exitCode = code;
    });

  const safeSetExitCode = (code: 0 | 1): void => {
    try {
      rawSetExitCode(code);
    } catch {
      // Never allow exit-code setter errors to disrupt lifecycle cleanup
    }
  };

  const safeLog = (
    level: 'info' | 'warn' | 'error',
    obj: Record<string, unknown>,
    msg: string,
  ): void => {
    try {
      options.logger?.[level](obj, msg);
    } catch {
      // Logger failures must never prevent cancellation or resource cleanup
    }
  };

  const safeNotifyUnconfirmed = (info: UnconfirmedShutdownInfo): void => {
    try {
      options.onUnconfirmedShutdown?.(info);
    } catch {
      // Supervision callback errors must not disrupt deferred cleanup retention
    }
  };

  const safeNotifyLateCleanup = (outcome: ShutdownOutcome): void => {
    try {
      options.onLateCleanupComplete?.(outcome);
    } catch {
      // Notification errors must not cause unhandled rejections
    }
  };

  const shutdownAbortController = new AbortController();
  const fatalAbortController = new AbortController();

  const resources: {
    closeHttp: (() => Promise<void>) | undefined;
    worker: Pick<IngestionWorker, 'close'> | undefined;
    queue: Pick<IngestionQueue, 'close'> | undefined;
    redisClients: ClosableRedisClient[];
    closeDb: (() => Promise<void>) | undefined;
  } = {
    closeHttp: undefined,
    worker: undefined,
    queue: undefined,
    redisClients: [],
    closeDb: undefined,
  };

  const state: {
    phase: WorkerServiceLifecyclePhase;
    shutdownLatched: boolean;
    fatalLatched: boolean;
    failureLatched: boolean;
    fatalNotification: SafeParserFatalNotification | null;
    shutdownPromise: Promise<ShutdownOutcome> | null;
    activeJobs: Set<Promise<void>>;
    startupOwned: boolean;
    startupReleasedPromise: Promise<void>;
    resolveStartupReleased: (() => void) | null;
    signalTarget: SignalTargetLike | null;
    onSigInt: (() => void) | null;
    onSigTerm: (() => void) | null;
  } = {
    phase: 'initializing',
    shutdownLatched: false,
    fatalLatched: false,
    failureLatched: false,
    fatalNotification: null,
    shutdownPromise: null,
    activeJobs: new Set(),
    startupOwned: false,
    startupReleasedPromise: Promise.resolve(),
    resolveStartupReleased: null,
    signalTarget: null,
    onSigInt: null,
    onSigTerm: null,
  };

  const latchFailure = (): void => {
    state.failureLatched = true;
    safeSetExitCode(1);
  };

  const computeFinalExitCode = (downstreamExit: 0 | 1): 0 | 1 => {
    if (state.failureLatched || state.fatalLatched || downstreamExit === 1) {
      return 1;
    }
    return 0;
  };

  const beginStartup = (): void => {
    if (state.startupOwned) {
      return;
    }
    state.startupOwned = true;
    state.startupReleasedPromise = new Promise<void>((resolve) => {
      state.resolveStartupReleased = resolve;
    });
  };

  const endStartupOwnership = (): void => {
    if (!state.startupOwned) {
      return;
    }
    state.startupOwned = false;
    const resolver = state.resolveStartupReleased;
    state.resolveStartupReleased = null;
    resolver?.();
  };

  const removeSignalHandlers = (): void => {
    if (state.signalTarget !== null) {
      if (state.onSigInt !== null) {
        state.signalTarget.removeListener('SIGINT', state.onSigInt);
      }
      if (state.onSigTerm !== null) {
        state.signalTarget.removeListener('SIGTERM', state.onSigTerm);
      }
      state.signalTarget = null;
      state.onSigInt = null;
      state.onSigTerm = null;
    }
  };

  const closeDownstreamInOrder = async (): Promise<0 | 1> => {
    let downstreamExit: 0 | 1 = 0;

    if (resources.queue !== undefined) {
      safeLog('info', { service: options.serviceName }, 'Shutdown: closing BullMQ queue');
      try {
        await resources.queue.close();
      } catch (err) {
        safeLog(
          'error',
          {
            service: options.serviceName,
            errorMessage: err instanceof Error ? err.message : 'Queue close failed',
          },
          'Error closing BullMQ queue',
        );
        latchFailure();
        downstreamExit = 1;
      }
    }

    if (resources.redisClients.length > 0) {
      safeLog('info', { service: options.serviceName }, 'Shutdown: closing Redis clients');
      for (const client of resources.redisClients) {
        try {
          await closeRedisClient(client);
        } catch (err) {
          safeLog(
            'error',
            {
              service: options.serviceName,
              errorMessage: err instanceof Error ? err.message : 'Redis close failed',
            },
            'Error closing Redis client',
          );
          latchFailure();
          downstreamExit = 1;
        }
      }
    }

    if (resources.closeDb !== undefined) {
      safeLog('info', { service: options.serviceName }, 'Shutdown: closing PostgreSQL pool');
      try {
        await resources.closeDb();
      } catch (err) {
        safeLog(
          'error',
          {
            service: options.serviceName,
            errorMessage: err instanceof Error ? err.message : 'PostgreSQL close failed',
          },
          'Error closing PostgreSQL pool',
        );
        latchFailure();
        downstreamExit = 1;
      }
    }

    return downstreamExit;
  };

  const awaitActiveJobsSnapshot = async (): Promise<void> => {
    while (state.activeJobs.size > 0) {
      await Promise.allSettled([...state.activeJobs]);
    }
  };

  const shutdown = (reason: ShutdownTriggerReason): Promise<ShutdownOutcome> => {
    if (isFailureTriggerReason(reason)) {
      latchFailure();
    }

    if (state.shutdownPromise !== null) {
      safeLog(
        'info',
        { service: options.serviceName, reason, phase: state.phase },
        'Shutdown already in progress; coalescing duplicate trigger',
      );
      return state.shutdownPromise;
    }

    // Publish one shared shutdown promise synchronously BEFORE abort dispatch or any callback
    // so synchronous reentrancy from abort listeners or resource hooks coalesces cleanly.
    let resolveShutdown!: (outcome: ShutdownOutcome) => void;
    const sharedPromise = new Promise<ShutdownOutcome>((resolve) => {
      resolveShutdown = resolve;
    });
    state.shutdownPromise = sharedPromise;

    state.shutdownLatched = true;
    if (!state.fatalLatched) {
      state.phase = 'shutting_down';
    }

    // Abort active ingestion immediately (never wait for HTTP keep-alives before cancelling parser)
    if (!shutdownAbortController.signal.aborted) {
      try {
        shutdownAbortController.abort();
      } catch {
        // Listener exceptions during abort dispatch must not prevent shutdown execution
      }
    }

    safeLog(
      'info',
      { service: options.serviceName, reason, fatalLatched: state.fatalLatched },
      'Service graceful shutdown initiated',
    );

    const runShutdown = async (): Promise<ShutdownOutcome> => {
      interface OwnershipResults {
        readonly workerResult: { readonly closed: boolean; readonly error?: unknown };
        readonly httpResult: { readonly closed: boolean; readonly error?: unknown };
      }

      const executeOwnershipDrain = async (): Promise<OwnershipResults> => {
        // Wait for startup ownership barrier first so shared resources cannot be disposed while
        // async startup steps are still acquiring or registering resources.
        await state.startupReleasedPromise;

        // Single graceful BullMQ worker close (never a second fake worker.close(true))
        let workerClosePromise: Promise<{ readonly closed: boolean; readonly error?: unknown }>;
        if (resources.worker !== undefined) {
          safeLog('info', { service: options.serviceName }, 'Shutdown: closing BullMQ worker');
          try {
            const rawClose = resources.worker.close();
            workerClosePromise = rawClose.then(
              () => ({ closed: true }),
              (err: unknown) => ({ closed: false, error: err }),
            );
          } catch (err: unknown) {
            workerClosePromise = Promise.resolve({ closed: false, error: err });
          }
        } else {
          workerClosePromise = Promise.resolve({ closed: true });
        }

        // Initiate HTTP shutdown concurrently with worker close and active job drain
        let httpClosePromise: Promise<{ readonly closed: boolean; readonly error?: unknown }>;
        if (resources.closeHttp !== undefined) {
          safeLog(
            'info',
            { service: options.serviceName },
            'Shutdown: closing Fastify HTTP server',
          );
          try {
            httpClosePromise = resources.closeHttp().then(
              () => ({ closed: true }),
              (err: unknown) => ({ closed: false, error: err }),
            );
          } catch (err: unknown) {
            httpClosePromise = Promise.resolve({ closed: false, error: err });
          }
        } else {
          httpClosePromise = Promise.resolve({ closed: true });
        }

        const [workerResult, , httpResult] = await Promise.all([
          workerClosePromise,
          awaitActiveJobsSnapshot(),
          httpClosePromise,
        ]);

        return { workerResult, httpResult };
      };

      const ownershipDrainPromise = executeOwnershipDrain();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ readonly timedOut: true }>((resolve) => {
        timer = setTimeout(() => {
          resolve({ timedOut: true });
        }, closeTimeoutMs);
        timer.unref();
      });

      const raceOutcome = await Promise.race([
        ownershipDrainPromise.then((res) => ({ timedOut: false as const, ...res })),
        timeoutPromise,
      ]);

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      const failClosedUnconfirmed = (
        info: UnconfirmedShutdownInfo,
        errorDetail: string,
      ): ShutdownOutcome => {
        latchFailure();
        state.phase = state.fatalLatched ? 'quarantined_fatal' : 'unconfirmed_shutdown';
        safeLog(
          'error',
          {
            service: options.serviceName,
            ...info,
            errorDetail,
          },
          'Shutdown ownership unconfirmed; keeping queue/Redis/PostgreSQL open and retaining signal handlers',
        );
        safeNotifyUnconfirmed(info);
        return {
          confirmed: false,
          timedOut: info.timedOut,
          fatal: state.fatalLatched,
          exitCode: 1,
          phase: state.phase,
        };
      };

      // Observation timeout path: keep Queue/Redis/PostgreSQL open & retain signal handlers
      if (raceOutcome.timedOut) {
        latchFailure();
        state.phase = state.fatalLatched ? 'quarantined_fatal' : 'unconfirmed_shutdown';

        const timeoutInfo: UnconfirmedShutdownInfo = {
          reason,
          timedOut: true,
          startupPending: state.startupOwned,
          workerCloseRejected: false,
          httpCloseRejected: false,
          activeJobPending: state.activeJobs.size > 0,
          fatalLatched: state.fatalLatched,
          fatalNotification: state.fatalNotification,
        };
        safeLog(
          'error',
          {
            service: options.serviceName,
            ...timeoutInfo,
          },
          'Shutdown observation window elapsed without confirmed closure; keeping resources open pending confirmed cleanup or external supervision',
        );
        safeNotifyUnconfirmed(timeoutInfo);

        const pendingCleanup = ownershipDrainPromise.then(async ({ workerResult, httpResult }) => {
          if (
            !workerResult.closed ||
            !httpResult.closed ||
            state.activeJobs.size > 0 ||
            state.startupOwned
          ) {
            const lateRejectInfo: UnconfirmedShutdownInfo = {
              reason,
              timedOut: true,
              startupPending: state.startupOwned,
              workerCloseRejected: !workerResult.closed,
              httpCloseRejected: !httpResult.closed,
              activeJobPending: state.activeJobs.size > 0,
              fatalLatched: state.fatalLatched,
              fatalNotification: state.fatalNotification,
            };
            return failClosedUnconfirmed(
              lateRejectInfo,
              !workerResult.closed
                ? workerResult.error instanceof Error
                  ? workerResult.error.message
                  : 'Worker close rejected after timeout'
                : httpResult.error instanceof Error
                  ? httpResult.error.message
                  : 'HTTP close rejected after timeout',
            );
          }

          await closeDownstreamInOrder();
          removeSignalHandlers();
          if (!state.fatalLatched) {
            state.phase = 'closed';
          }
          // Monotonic failure latch: timeout already latched failure, so exitCode MUST remain 1
          const finalExit = computeFinalExitCode(1);
          safeSetExitCode(finalExit);
          const lateOutcome: ShutdownOutcome = {
            confirmed: true,
            timedOut: true,
            fatal: state.fatalLatched,
            exitCode: finalExit,
            phase: state.phase,
          };
          safeLog(
            'info',
            {
              service: options.serviceName,
              fatal: state.fatalLatched,
              exitCode: finalExit,
            },
            'Deferred shutdown cleanup completed after late ownership confirmation',
          );
          safeNotifyLateCleanup(lateOutcome);
          return lateOutcome;
        });

        return {
          confirmed: false,
          timedOut: true,
          fatal: state.fatalLatched,
          exitCode: 1,
          phase: state.phase,
          pendingCleanup,
        };
      }

      // Immediate rejection path: BOTH worker closure AND HTTP closure must be confirmed
      if (!raceOutcome.workerResult.closed || !raceOutcome.httpResult.closed) {
        const rejectInfo: UnconfirmedShutdownInfo = {
          reason,
          timedOut: false,
          startupPending: state.startupOwned,
          workerCloseRejected: !raceOutcome.workerResult.closed,
          httpCloseRejected: !raceOutcome.httpResult.closed,
          activeJobPending: state.activeJobs.size > 0,
          fatalLatched: state.fatalLatched,
          fatalNotification: state.fatalNotification,
        };
        const detail = !raceOutcome.workerResult.closed
          ? raceOutcome.workerResult.error instanceof Error
            ? raceOutcome.workerResult.error.message
            : 'BullMQ worker close rejected'
          : raceOutcome.httpResult.error instanceof Error
            ? raceOutcome.httpResult.error.message
            : 'Fastify HTTP close rejected';
        return failClosedUnconfirmed(rejectInfo, detail);
      }

      // Confirmed worker + active jobs + HTTP closure -> dispose Queue -> Redis -> PostgreSQL last
      const downstreamExit = await closeDownstreamInOrder();
      removeSignalHandlers();

      const exitCode = computeFinalExitCode(downstreamExit);
      if (!state.fatalLatched) {
        state.phase = 'closed';
      }
      safeSetExitCode(exitCode);
      safeLog(
        'info',
        { service: options.serviceName, reason, exitCode, phase: state.phase },
        'Service shutdown complete',
      );

      return {
        confirmed: true,
        timedOut: false,
        fatal: state.fatalLatched,
        exitCode,
        phase: state.phase,
      };
    };

    void runShutdown()
      .then(resolveShutdown)
      .catch(() => {
        latchFailure();
        state.phase = state.fatalLatched ? 'quarantined_fatal' : 'unconfirmed_shutdown';
        resolveShutdown({
          confirmed: false,
          timedOut: false,
          fatal: state.fatalLatched,
          exitCode: 1,
          phase: state.phase,
        });
      });

    return sharedPromise;
  };

  const triggerFatal = (notification: SafeParserFatalNotification): void => {
    state.fatalLatched = true;
    state.fatalNotification ??= notification;
    state.phase = 'quarantined_fatal';
    latchFailure();

    if (!fatalAbortController.signal.aborted) {
      try {
        fatalAbortController.abort();
      } catch {
        // Listener errors must not prevent fatal quarantine shutdown
      }
    }

    safeLog(
      'error',
      {
        service: options.serviceName,
        fatal: notification,
      },
      'Fatal parser state latched; blocking further ingestion work and initiating local worker quarantine shutdown',
    );

    void shutdown('FATAL_PARSER_STATE');
  };

  const triggerInfrastructureFailure = (error: ParserIntegrationError): void => {
    if (error.fatal) {
      state.fatalLatched = true;
      state.phase = 'quarantined_fatal';
      if (!fatalAbortController.signal.aborted) {
        try {
          fatalAbortController.abort();
        } catch {
          // Listener errors must not prevent shutdown
        }
      }
    }
    latchFailure();
    safeLog(
      'error',
      {
        service: options.serviceName,
        parserError: error.toSafeLogObject(),
      },
      'Parser infrastructure failure observed; initiating local worker shutdown',
    );
    void shutdown(error.fatal ? 'FATAL_PARSER_STATE' : 'INFRASTRUCTURE_FAILURE');
  };

  const wrapProcessor = <TJob extends IngestionProcessorJob>(
    processor: (job: TJob) => Promise<void>,
    wrapOptions: WrapProcessorOptions = {},
  ): ((job: TJob) => Promise<void>) => {
    const delegateStopped = wrapOptions.delegateStoppedToProcessor === true;

    return (job: TJob): Promise<void> => {
      if (state.phase === 'closed') {
        return Promise.reject(new IngestionCancelledError());
      }
      if ((state.fatalLatched || state.shutdownLatched) && !delegateStopped) {
        return Promise.reject(new IngestionCancelledError());
      }

      const jobPromise = processor(job);
      const tracked = jobPromise.then(
        () => undefined,
        () => undefined,
      );
      state.activeJobs.add(tracked);
      void tracked.finally(() => {
        state.activeJobs.delete(tracked);
      });
      return jobPromise;
    };
  };

  const installSignalHandlers = (target: SignalTargetLike = process): void => {
    if (state.signalTarget !== null) {
      return;
    }
    const onSigInt = (): void => {
      void shutdown('SIGINT');
    };
    const onSigTerm = (): void => {
      void shutdown('SIGTERM');
    };
    state.signalTarget = target;
    state.onSigInt = onSigInt;
    state.onSigTerm = onSigTerm;
    target.on('SIGINT', onSigInt);
    target.on('SIGTERM', onSigTerm);
  };

  return {
    shutdownSignal: shutdownAbortController.signal,
    fatalSignal: fatalAbortController.signal,
    getPhase: () => state.phase,
    isShuttingDown: () => state.shutdownLatched,
    isFatal: () => state.fatalLatched,
    hasActiveJob: () => state.activeJobs.size > 0,
    isStartupOwned: () => state.startupOwned,
    beginStartup,
    endStartupOwnership,
    markRunning: () => {
      endStartupOwnership();
      if (state.phase === 'initializing' && !state.shutdownLatched && !state.fatalLatched) {
        state.phase = 'running';
      }
    },
    waitForShutdown: () => state.shutdownPromise,
    setHttpClose: (closeHttp) => {
      resources.closeHttp = closeHttp;
    },
    setWorker: (worker) => {
      resources.worker = worker;
    },
    setQueue: (queue) => {
      resources.queue = queue;
    },
    addRedisClient: (client) => {
      resources.redisClients.push(client);
    },
    setCloseDb: (closeDb) => {
      resources.closeDb = closeDb;
    },
    wrapProcessor,
    triggerFatal,
    triggerInfrastructureFailure,
    shutdown,
    installSignalHandlers,
    removeSignalHandlers,
  };
}
