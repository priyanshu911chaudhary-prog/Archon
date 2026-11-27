export const PG_UNIQUE_VIOLATION_CODE = '23505' as const;
export const PG_LOCK_NOT_AVAILABLE_CODE = '55P03' as const;
export const PG_DEADLOCK_DETECTED_CODE = '40P01' as const;
export const PG_QUERY_CANCELED_CODE = '57014' as const;
export const PG_TRANSACTION_TIMEOUT_CODE = '25P04' as const;
export const PG_SERIALIZATION_FAILURE_CODE = '40001' as const;
export const PG_STATEMENT_COMPLETION_UNKNOWN_CODE = '40003' as const;
export const PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE = '08007' as const;

const PG_SQLSTATE_RE = /^(?=.*\d)[0-9A-Z]{5}$/;
const PG_TRANSIENT_CONN_CODES = new Set(['08000', '08001', '08003', '08006']);
const PG_SHUTDOWN_CODES = new Set(['57P01', '57P02', '57P03']);
const NODE_CONN_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNABORTED',
  'ERR_SOCKET_CLOSED',
]);
const PG_POOL_CLOSED_MSG_RE = /cannot use a pool after calling end/i;
const PG_CONN_MSG_RE =
  /connection terminated|client has encountered a connection error|timeout exceeded when trying to connect/i;

export interface PgErrorInfo {
  readonly code?: string;
  readonly constraint?: string;
}

export type DbErrorCode =
  | 'DB_CONNECTION_ERROR'
  | 'DB_MIGRATION_ERROR'
  | 'DB_VALIDATION_ERROR'
  | 'DB_CONFLICT_UNRESOLVED'
  | 'DB_QUERY_ERROR';

export type DbErrorCategory =
  | 'lock_not_available'
  | 'deadlock'
  | 'serialization_failure'
  | 'query_canceled'
  | 'transaction_timeout'
  | 'uncertain_outcome'
  | 'connection_error'
  | 'unique_violation'
  | 'non_retryable';

export interface DbErrorClassification {
  readonly category: DbErrorCategory;
  /** Indicates a retry candidate only, NOT unconditional permission to replay a write. */
  readonly retryable: boolean;
  /**
   * True when commit or statement resolution is unknown and requires authoritative DB
   * reconciliation; `false` does NOT prove rollback (transaction phase and DB state decide).
   */
  readonly commitOutcomeUncertain: boolean;
  readonly pgCode?: string;
}

export class DbError extends Error {
  readonly code: DbErrorCode;
  readonly pgCode?: string;

  constructor(code: DbErrorCode, message: string, options?: { cause?: unknown; pgCode?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DbError';
    this.code = code;
    this.pgCode = options?.pgCode;
  }
}

const SQLSTATE_MAP = new Map<string, readonly [DbErrorCategory, boolean, boolean]>([
  [PG_LOCK_NOT_AVAILABLE_CODE, ['lock_not_available', true, false]],
  [PG_DEADLOCK_DETECTED_CODE, ['deadlock', true, false]],
  [PG_SERIALIZATION_FAILURE_CODE, ['serialization_failure', true, false]],
  [PG_QUERY_CANCELED_CODE, ['query_canceled', true, false]],
  [PG_TRANSACTION_TIMEOUT_CODE, ['transaction_timeout', true, true]],
  [PG_STATEMENT_COMPLETION_UNKNOWN_CODE, ['uncertain_outcome', true, true]],
  [PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE, ['uncertain_outcome', true, true]],
  [PG_UNIQUE_VIOLATION_CODE, ['unique_violation', false, false]],
]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isUnknownArray = (v: unknown): v is readonly unknown[] => Array.isArray(v);

const MAX_ERROR_CHAIN_NODES = 16;
const MAX_ERROR_CHAIN_SCAN_STEPS = 64;
const PG_UNCERTAIN_SQLSTATES = new Set<string>([
  PG_TRANSACTION_TIMEOUT_CODE,
  PG_STATEMENT_COMPLETION_UNKNOWN_CODE,
  PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE,
]);

function walkErrorChain(err: unknown): readonly unknown[] {
  if (!isRecord(err)) {
    return [];
  }
  const visited: unknown[] = [];
  const seen = new Set<unknown>([err]);
  const queue: unknown[] = [err];
  let head = 0;
  let scanSteps = 0;

  const enqueue = (candidate: unknown): void => {
    if (queue.length < MAX_ERROR_CHAIN_NODES && isRecord(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      queue.push(candidate);
    }
  };

  while (head < queue.length && visited.length < MAX_ERROR_CHAIN_NODES) {
    const current = queue[head];
    head += 1;
    if (!isRecord(current)) {
      continue;
    }
    visited.push(current);
    if (current.cause !== undefined && scanSteps < MAX_ERROR_CHAIN_SCAN_STEPS) {
      scanSteps += 1;
      enqueue(current.cause);
    }
    if (isUnknownArray(current.errors)) {
      for (
        let i = 0;
        i < current.errors.length &&
        queue.length < MAX_ERROR_CHAIN_NODES &&
        scanSteps < MAX_ERROR_CHAIN_SCAN_STEPS;
        i += 1
      ) {
        scanSteps += 1;
        enqueue(current.errors[i]);
      }
    }
  }
  return visited;
}

function codePriority(code: string): number {
  if (PG_UNCERTAIN_SQLSTATES.has(code)) {
    return 5;
  }
  if (SQLSTATE_MAP.has(code)) {
    return 4;
  }
  if (PG_TRANSIENT_CONN_CODES.has(code) || PG_SHUTDOWN_CODES.has(code)) {
    return 3;
  }
  if (PG_SQLSTATE_RE.test(code)) {
    return 2;
  }
  if (NODE_CONN_CODES.has(code)) {
    return 1;
  }
  return 0;
}

function extractPgErrorInfoFromChain(chain: readonly unknown[]): PgErrorInfo {
  let best: PgErrorInfo | undefined;
  let bestPriority = -1;

  const consider = (code: string, constraint?: string): void => {
    const priority = codePriority(code);
    if (
      priority > bestPriority ||
      (priority === bestPriority && best?.constraint === undefined && constraint !== undefined)
    ) {
      best = constraint !== undefined ? { code, constraint } : { code };
      bestPriority = priority;
    }
  };

  for (const node of chain) {
    if (node instanceof DbError) {
      if (node.pgCode !== undefined) {
        consider(node.pgCode);
      }
      continue;
    }
    if (isRecord(node) && typeof node.code === 'string') {
      const constraint = typeof node.constraint === 'string' ? node.constraint : undefined;
      consider(node.code, constraint);
    }
  }

  return best ?? {};
}

export function extractPgErrorInfo(err: unknown): PgErrorInfo {
  return extractPgErrorInfoFromChain(walkErrorChain(err));
}

export function isPgUniqueViolation(err: unknown, expectedConstraint?: string): boolean {
  const info = extractPgErrorInfo(err);
  if (info.code !== PG_UNIQUE_VIOLATION_CODE) {
    return false;
  }
  return expectedConstraint === undefined || info.constraint === undefined
    ? true
    : info.constraint === expectedConstraint;
}

export const isPgLockNotAvailable = (err: unknown): boolean =>
  extractPgErrorInfo(err).code === PG_LOCK_NOT_AVAILABLE_CODE;
export const isPgDeadlock = (err: unknown): boolean =>
  extractPgErrorInfo(err).code === PG_DEADLOCK_DETECTED_CODE;
export const isPgQueryCanceled = (err: unknown): boolean =>
  extractPgErrorInfo(err).code === PG_QUERY_CANCELED_CODE;
export const isPgTransactionTimeout = (err: unknown): boolean =>
  extractPgErrorInfo(err).code === PG_TRANSACTION_TIMEOUT_CODE;
export const isPgSerializationFailure = (err: unknown): boolean =>
  extractPgErrorInfo(err).code === PG_SERIALIZATION_FAILURE_CODE;
export const isPgOutcomeUnknown = (err: unknown): boolean => {
  const code = extractPgErrorInfo(err).code;
  return (
    code === PG_STATEMENT_COMPLETION_UNKNOWN_CODE || code === PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE
  );
};

function isPoolClosedError(chain: readonly unknown[]): boolean {
  return chain.some((node) => node instanceof Error && PG_POOL_CLOSED_MSG_RE.test(node.message));
}

function isTransientConnCode(code: string | undefined): boolean {
  return (
    code !== undefined &&
    (PG_TRANSIENT_CONN_CODES.has(code) || PG_SHUTDOWN_CODES.has(code) || NODE_CONN_CODES.has(code))
  );
}

function hasTransientConnectionSignal(chain: readonly unknown[]): boolean {
  for (const node of chain) {
    if (node instanceof DbError) {
      if (node.code === 'DB_CONNECTION_ERROR' || isTransientConnCode(node.pgCode)) {
        return true;
      }
      continue;
    }
    if (node instanceof Error && PG_CONN_MSG_RE.test(node.message)) {
      return true;
    }
    if (isRecord(node) && typeof node.code === 'string' && isTransientConnCode(node.code)) {
      return true;
    }
  }
  return false;
}

export function isPgConnectionError(err: unknown): boolean {
  const chain = walkErrorChain(err);
  return !isPoolClosedError(chain) && hasTransientConnectionSignal(chain);
}

export function classifyDbError(err: unknown): DbErrorClassification {
  const chain = walkErrorChain(err);
  const pgCode = extractPgErrorInfoFromChain(chain).code;
  const poolClosed = isPoolClosedError(chain);
  const hasConnSignal = hasTransientConnectionSignal(chain);
  const mapped = pgCode !== undefined ? SQLSTATE_MAP.get(pgCode) : undefined;

  if (mapped !== undefined) {
    const [category, retryable, baseUncertain] = mapped;
    return {
      category,
      retryable: poolClosed ? false : retryable,
      commitOutcomeUncertain: baseUncertain || hasConnSignal,
      ...(pgCode !== undefined ? { pgCode } : {}),
    };
  }
  if (poolClosed) {
    return {
      category: 'non_retryable',
      retryable: false,
      commitOutcomeUncertain: hasConnSignal,
      ...(pgCode !== undefined ? { pgCode } : {}),
    };
  }
  if (hasConnSignal) {
    return {
      category: 'connection_error',
      retryable: true,
      commitOutcomeUncertain: true,
      ...(pgCode !== undefined ? { pgCode } : {}),
    };
  }
  return {
    category: 'non_retryable',
    retryable: false,
    commitOutcomeUncertain: false,
    ...(pgCode !== undefined ? { pgCode } : {}),
  };
}
