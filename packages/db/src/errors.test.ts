import { describe, expect, it } from 'vitest';
import {
  DbError,
  PG_DEADLOCK_DETECTED_CODE,
  PG_LOCK_NOT_AVAILABLE_CODE,
  PG_QUERY_CANCELED_CODE,
  PG_SERIALIZATION_FAILURE_CODE,
  PG_STATEMENT_COMPLETION_UNKNOWN_CODE,
  PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE,
  PG_TRANSACTION_TIMEOUT_CODE,
  PG_UNIQUE_VIOLATION_CODE,
  classifyDbError,
  extractPgErrorInfo,
  isPgConnectionError,
  isPgDeadlock,
  isPgLockNotAvailable,
  isPgOutcomeUnknown,
  isPgQueryCanceled,
  isPgSerializationFailure,
  isPgTransactionTimeout,
  isPgUniqueViolation,
  type DbErrorCategory,
} from './errors.js';

function pgErr(code: string, message = 'pg error', constraint?: string): Error {
  return Object.assign(
    new Error(message),
    constraint !== undefined ? { code, constraint } : { code },
  );
}

function wrapWithCode(code: string, cause: unknown, message = 'wrapper error'): Error {
  return Object.assign(new Error(message, { cause }), { code });
}

describe('packages/db/src/errors', () => {
  it('handles unique violations and constraint matching through nested causes', () => {
    const raw = pgErr(PG_UNIQUE_VIOLATION_CODE, 'duplicate key', 'idx_repos_active');
    const drizzleWrapped = new Error('Failed query', { cause: raw });

    expect(extractPgErrorInfo(drizzleWrapped)).toEqual({
      code: PG_UNIQUE_VIOLATION_CODE,
      constraint: 'idx_repos_active',
    });
    expect(isPgUniqueViolation(drizzleWrapped)).toBe(true);
    expect(isPgUniqueViolation(drizzleWrapped, 'idx_repos_active')).toBe(true);
    expect(isPgUniqueViolation(drizzleWrapped, 'other_constraint')).toBe(false);
    expect(isPgUniqueViolation(pgErr(PG_UNIQUE_VIOLATION_CODE), 'idx_repos_active')).toBe(true);
    expect(classifyDbError(drizzleWrapped)).toEqual({
      category: 'unique_violation',
      retryable: false,
      commitOutcomeUncertain: false,
      pgCode: PG_UNIQUE_VIOLATION_CODE,
    });
  });

  it('prevents outer wrapper codes from masking nested PG errors and falls back to DbError.pgCode', () => {
    const wrappedDeadlock = wrapWithCode(
      'DRIZZLE_WRAPPER_ERR',
      pgErr(PG_DEADLOCK_DETECTED_CODE, 'deadlock'),
    );
    expect(extractPgErrorInfo(wrappedDeadlock)).toEqual({ code: PG_DEADLOCK_DETECTED_CODE });
    expect(isPgDeadlock(wrappedDeadlock)).toBe(true);

    const dbFallback = new DbError('DB_QUERY_ERROR', 'safe', {
      pgCode: PG_LOCK_NOT_AVAILABLE_CODE,
    });
    expect(extractPgErrorInfo(dbFallback)).toEqual({ code: PG_LOCK_NOT_AVAILABLE_CODE });
    expect(classifyDbError(dbFallback)).toEqual({
      category: 'lock_not_available',
      retryable: true,
      commitOutcomeUncertain: false,
      pgCode: PG_LOCK_NOT_AVAILABLE_CODE,
    });
  });

  it.each<{
    readonly code: string;
    readonly category: DbErrorCategory;
    readonly retryable: boolean;
    readonly uncertain: boolean;
    readonly predicate: (err: unknown) => boolean;
  }>([
    {
      code: PG_LOCK_NOT_AVAILABLE_CODE,
      category: 'lock_not_available',
      retryable: true,
      uncertain: false,
      predicate: isPgLockNotAvailable,
    },
    {
      code: PG_DEADLOCK_DETECTED_CODE,
      category: 'deadlock',
      retryable: true,
      uncertain: false,
      predicate: isPgDeadlock,
    },
    {
      code: PG_SERIALIZATION_FAILURE_CODE,
      category: 'serialization_failure',
      retryable: true,
      uncertain: false,
      predicate: isPgSerializationFailure,
    },
    {
      code: PG_QUERY_CANCELED_CODE,
      category: 'query_canceled',
      retryable: true,
      uncertain: false,
      predicate: isPgQueryCanceled,
    },
    {
      code: PG_TRANSACTION_TIMEOUT_CODE,
      category: 'transaction_timeout',
      retryable: true,
      uncertain: true,
      predicate: isPgTransactionTimeout,
    },
    {
      code: PG_STATEMENT_COMPLETION_UNKNOWN_CODE,
      category: 'uncertain_outcome',
      retryable: true,
      uncertain: true,
      predicate: isPgOutcomeUnknown,
    },
    {
      code: PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE,
      category: 'uncertain_outcome',
      retryable: true,
      uncertain: true,
      predicate: isPgOutcomeUnknown,
    },
  ])(
    'classifies SQLSTATE $code as $category',
    ({ code, category, retryable, uncertain, predicate }) => {
      const err = new Error('outer', { cause: pgErr(code) });
      expect(predicate(err)).toBe(true);
      expect(classifyDbError(err)).toEqual({
        category,
        retryable,
        commitOutcomeUncertain: uncertain,
        pgCode: code,
      });
    },
  );

  it.each<readonly [string, unknown]>([
    ['SQLSTATE 08006', pgErr('08006', 'connection failure')],
    ['admin shutdown 57P01', pgErr('57P01', 'terminating connection')],
    ['Node ECONNRESET', pgErr('ECONNRESET', 'socket hang up')],
    ['pg termination msg', new Error('Connection terminated unexpectedly')],
    ['DbError connection', new DbError('DB_CONNECTION_ERROR', 'unreachable')],
  ])('classifies transient connection failure (%s) as retryable and uncertain', (_label, err) => {
    expect(isPgConnectionError(err)).toBe(true);
    expect(classifyDbError(err)).toMatchObject({
      category: 'connection_error',
      retryable: true,
      commitOutcomeUncertain: true,
    });
  });

  it.each<readonly [string, unknown, string | undefined]>([
    ['closed pool', new Error('Cannot use a pool after calling end on the pool'), undefined],
    ['protocol violation 08P01', pgErr('08P01', 'protocol violation'), '08P01'],
    ['foreign key 23503', pgErr('23503', 'fk violation'), '23503'],
    ['undefined table 42P01', pgErr('42P01', 'missing relation'), '42P01'],
    ['generic Error', new Error('unexpected failure'), undefined],
    ['null primitive', null, undefined],
  ])('classifies permanent or unrecognized error (%s) as non-retryable', (_label, err, pgCode) => {
    expect(isPgConnectionError(err)).toBe(false);
    expect(classifyDbError(err)).toEqual({
      category: 'non_retryable',
      retryable: false,
      commitOutcomeUncertain: false,
      ...(pgCode !== undefined ? { pgCode } : {}),
    });
  });

  it('handles circular cause chains and bounds large AggregateError traversal safely', () => {
    interface MutableCauseError extends Error {
      cause?: unknown;
    }
    const a: MutableCauseError = new Error('cycle-a');
    const b: MutableCauseError = new Error('cycle-b');
    a.cause = b;
    b.cause = a;
    expect(classifyDbError(a)).toEqual({
      category: 'non_retryable',
      retryable: false,
      commitOutcomeUncertain: false,
    });

    const largeList = Array.from({ length: 100_000 }, (_, i) => new Error(`noise-${String(i)}`));
    largeList[2] = pgErr(PG_DEADLOCK_DETECTED_CODE);
    largeList[99_999] = pgErr(PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE);
    const hugeAgg = new AggregateError(largeList, 'bounded aggregate');

    expect(classifyDbError(hugeAgg)).toEqual({
      category: 'deadlock',
      retryable: true,
      commitOutcomeUncertain: false,
      pgCode: PG_DEADLOCK_DETECTED_CODE,
    });
  });

  it('preserves commitOutcomeUncertain in mixed lock, connection, and closed-pool chains', () => {
    const lockAndUnknown = new AggregateError([
      pgErr(PG_LOCK_NOT_AVAILABLE_CODE),
      pgErr(PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE),
    ]);
    expect(classifyDbError(lockAndUnknown)).toEqual({
      category: 'uncertain_outcome',
      retryable: true,
      commitOutcomeUncertain: true,
      pgCode: PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE,
    });

    const lockAndReset = new AggregateError([
      pgErr(PG_LOCK_NOT_AVAILABLE_CODE),
      pgErr('ECONNRESET'),
    ]);
    expect(classifyDbError(lockAndReset)).toEqual({
      category: 'lock_not_available',
      retryable: true,
      commitOutcomeUncertain: true,
      pgCode: PG_LOCK_NOT_AVAILABLE_CODE,
    });

    const closedAndUnknown = new AggregateError([
      new Error('Cannot use a pool after calling end on the pool'),
      pgErr(PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE),
    ]);
    expect(classifyDbError(closedAndUnknown)).toEqual({
      category: 'uncertain_outcome',
      retryable: false,
      commitOutcomeUncertain: true,
      pgCode: PG_TRANSACTION_RESOLUTION_UNKNOWN_CODE,
    });

    const closedAndReset = new AggregateError([
      new Error('Cannot use a pool after calling end on the pool'),
      pgErr('ECONNRESET'),
    ]);
    expect(classifyDbError(closedAndReset)).toEqual({
      category: 'non_retryable',
      retryable: false,
      commitOutcomeUncertain: true,
      pgCode: 'ECONNRESET',
    });
  });

  it('never leaks raw credentials, SQL parameters, or sensitive text in classification output', () => {
    const secret = 'SENSITIVE_DB_CRED_AND_SQL_PARAM_999';
    const raw = Object.assign(new Error(`postgres://user:${secret}@host/db`), {
      code: PG_DEADLOCK_DETECTED_CODE,
      detail: `Key (snippet)=(${secret})`,
      parameters: [secret],
    });
    const classified = classifyDbError(new Error(`Query failed: ${secret}`, { cause: raw }));
    const serialized = JSON.stringify(classified);

    expect(serialized).not.toContain(secret);
    expect(Object.keys(classified).sort()).toEqual([
      'category',
      'commitOutcomeUncertain',
      'pgCode',
      'retryable',
    ]);
  });
});
