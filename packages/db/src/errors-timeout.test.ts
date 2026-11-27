import { describe, expect, it } from 'vitest';
import {
  DbError,
  PG_QUERY_CANCELED_CODE,
  PG_TRANSACTION_TIMEOUT_CODE,
  classifyDbError,
  isPgStatementTimeout,
} from './errors.js';

describe('packages/db/src/errors timeout classification', () => {
  it('matches confirmed statement timeouts directly and when wrapped', () => {
    const pgTimeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: PG_QUERY_CANCELED_CODE,
    });

    expect(isPgStatementTimeout(pgTimeout)).toBe(true);
    expect(classifyDbError(pgTimeout).category).toBe('query_canceled');

    const wrapped = new DbError('DB_QUERY_ERROR', 'sanitized outer', {
      pgCode: PG_QUERY_CANCELED_CODE,
      cause: pgTimeout,
    });

    expect(isPgStatementTimeout(wrapped)).toBe(true);
  });

  it('distinguishes cancellation, transaction timeout, connection errors and unrelated messages', () => {
    const userCancel = Object.assign(new Error('canceling statement due to user request'), {
      code: PG_QUERY_CANCELED_CODE,
    });

    expect(isPgStatementTimeout(userCancel)).toBe(false);
    expect(classifyDbError(userCancel).category).toBe('query_canceled');

    const misleadingWrapper = new Error('canceling statement due to statement timeout', {
      cause: userCancel,
    });

    expect(isPgStatementTimeout(misleadingWrapper)).toBe(false);

    const txTimeout = Object.assign(
      new Error('terminating connection due to transaction timeout'),
      { code: PG_TRANSACTION_TIMEOUT_CODE },
    );

    expect(isPgStatementTimeout(txTimeout)).toBe(false);
    expect(classifyDbError(txTimeout).category).toBe('transaction_timeout');

    const connInner = Object.assign(new Error('connection terminated unexpectedly'), {
      code: '08006',
    });

    const wrappedConn = new Error('canceling statement due to statement timeout', {
      cause: connInner,
    });

    expect(isPgStatementTimeout(wrappedConn)).toBe(false);
    expect(classifyDbError(wrappedConn).category).toBe('connection_error');

    const unrelated = new Error('canceling statement due to statement timeout');

    expect(isPgStatementTimeout(unrelated)).toBe(false);
    expect(classifyDbError(unrelated).category).toBe('non_retryable');
  });
});
