export const DEFAULT_EMBEDDED_GRAPH_QUERY_CONCURRENCY = 2 as const;
export const DEFAULT_STANDALONE_GRAPH_QUERY_CONCURRENCY = 3 as const;

export interface GraphQueryAdmissionGate {
  readonly maxConcurrent: number;
  tryAcquire(): (() => void) | null;
  stop(): void;
  isStopped(): boolean;
  getInFlightCount(): number;
  waitForIdle(): Promise<void>;
}

/**
 * Proposed fail-fast concurrency admission gate shared across all five graph-read endpoints
 * (GET and auto-exposed HEAD). This is an in-process admission cap, NOT reserved PostgreSQL
 * pool connections. Permits are released strictly once when the underlying query settles.
 */
export function createGraphQueryAdmissionGate(maxConcurrent: number): GraphQueryAdmissionGate {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive integer.');
  }

  let inFlight = 0;
  let stopped = false;
  let idleResolvers: (() => void)[] = [];

  return {
    maxConcurrent,
    tryAcquire(): (() => void) | null {
      if (stopped || inFlight >= maxConcurrent) {
        return null;
      }
      inFlight += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        inFlight -= 1;
        if (inFlight === 0 && idleResolvers.length > 0) {
          const pending = idleResolvers;
          idleResolvers = [];
          for (const resolve of pending) {
            resolve();
          }
        }
      };
    },
    stop(): void {
      stopped = true;
    },
    isStopped(): boolean {
      return stopped;
    },
    getInFlightCount(): number {
      return inFlight;
    },
    waitForIdle(): Promise<void> {
      if (inFlight === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleResolvers.push(resolve);
      });
    },
  };
}
