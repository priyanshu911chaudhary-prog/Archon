import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POOL_MAX,
  buildPoolConfig,
  resolvePoolSsl,
  sanitizeDatabaseTarget,
} from './client.js';
import { DbError, extractPgErrorInfo, isPgUniqueViolation } from './errors.js';
import { ACTIVE_REPO_UNIQUE_INDEX, computeExpiresAt } from './repository.js';
import { isEmptyJsTsRepository } from './schema.js';

describe('resolvePoolSsl and buildPoolConfig', () => {
  it('disables SSL when sslmode is absent or disable, and verifies certs for require/verify-full', () => {
    expect(resolvePoolSsl('postgresql://user:pass@db.local:5432/archon')).toBe(false);
    expect(resolvePoolSsl('postgresql://user:pass@db.local:5432/archon?sslmode=disable')).toBe(
      false,
    );
    expect(
      resolvePoolSsl('postgresql://user:pass@ep-demo.neon.tech/neondb?sslmode=require'),
    ).toEqual({ rejectUnauthorized: true });
    expect(
      resolvePoolSsl('postgresql://user:pass@ep-demo.neon.tech/neondb?sslmode=verify-full'),
    ).toEqual({ rejectUnauthorized: true });
    expect(resolvePoolSsl('postgresql://user:pass@host/db?sslmode=no-verify')).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('defaults Pool max to 5 for Neon free tier and strips credentials in sanitized target', () => {
    const config = buildPoolConfig({
      databaseUrl:
        'postgresql://archon:super_secret_pw@ep-demo.neon.tech:5432/neondb?sslmode=require',
    });

    expect(config.max).toBe(DEFAULT_POOL_MAX);
    expect(config.max).toBe(5);
    expect(config.ssl).toEqual({ rejectUnauthorized: true });

    const target = sanitizeDatabaseTarget(
      'postgresql://archon:super_secret_pw@ep-demo.neon.tech:5432/neondb?sslmode=require',
    );
    expect(target).toBe('ep-demo.neon.tech:5432/neondb');
    expect(target).not.toContain('super_secret_pw');
  });
});

describe('extractPgErrorInfo and isPgUniqueViolation', () => {
  it('extracts SQLSTATE 23505 from both direct pg errors and Drizzle-wrapped cause chains', () => {
    const direct = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: ACTIVE_REPO_UNIQUE_INDEX,
    });
    expect(extractPgErrorInfo(direct)).toEqual({
      code: '23505',
      constraint: ACTIVE_REPO_UNIQUE_INDEX,
    });
    expect(isPgUniqueViolation(direct, ACTIVE_REPO_UNIQUE_INDEX)).toBe(true);
    expect(isPgUniqueViolation(direct, 'other_index')).toBe(false);

    const wrapped = new Error('Failed query: insert into repositories', { cause: direct });
    expect(isPgUniqueViolation(wrapped, ACTIVE_REPO_UNIQUE_INDEX)).toBe(true);
    expect(isPgUniqueViolation(new Error('network timeout'))).toBe(false);
  });
});

describe('schema and expiry helpers', () => {
  it('derives emptyJsTs strictly from status === ready and fileCount === 0', () => {
    expect(isEmptyJsTsRepository({ status: 'ready', fileCount: 0 })).toBe(true);
    expect(isEmptyJsTsRepository({ status: 'ready', fileCount: 49 })).toBe(false);
    expect(isEmptyJsTsRepository({ status: 'queued', fileCount: 0 })).toBe(false);
    expect(isEmptyJsTsRepository({ status: 'failed', fileCount: 0 })).toBe(false);
  });

  it('computes NULL expiry for sample repos and future timestamp for user repos', () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    expect(computeExpiresAt(now, 7, true)).toBeNull();
    expect(computeExpiresAt(now, 7, false)?.toISOString()).toBe('2026-11-28T12:00:00.000Z');
    expect(() => computeExpiresAt(now, 0, false)).toThrow(DbError);
  });
});
