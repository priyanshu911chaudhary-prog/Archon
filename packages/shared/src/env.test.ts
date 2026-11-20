import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEV_WEB_ORIGIN,
  EnvValidationError,
  findRepoRoot,
  loadEnv,
  parseEnv,
} from './env.js';

const BASE_VALID_ENV: Record<string, string | undefined> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://archon:secret@127.0.0.1:5432/archon',
  REDIS_URL: 'redis://127.0.0.1:6380',
  GITHUB_TOKEN: 'ghp_test_token_123',
};

describe('parseEnv', () => {
  it('applies documented defaults for optional and numeric/boolean variables', () => {
    const env = parseEnv(BASE_VALID_ENV);

    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: 4000,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgresql://archon:secret@127.0.0.1:5432/archon',
      REDIS_URL: 'redis://127.0.0.1:6380',
      GITHUB_TOKEN: 'ghp_test_token_123',
      GEMINI_API_KEY: undefined,
      WEB_ORIGIN: DEFAULT_DEV_WEB_ORIGIN,
      INGEST_RATE_LIMIT_PER_HOUR: 5,
      TRUST_PROXY_HOPS: 1,
      MAX_SUPPORTED_FILES: 500,
      MAX_REPO_SIZE_MB: 50,
      HUB_THRESHOLD: 30,
      RUN_EMBEDDED_WORKER: false,
    });
  });

  it('parses explicit production overrides including WEB_ORIGIN, rate limit, and trust proxy hops', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgres://user:pass@ep-cool.neon.tech/neondb?sslmode=require',
      REDIS_URL: 'rediss://default:pass@upstash.io:6379',
      GITHUB_TOKEN: 'ghp_prod_token',
      GEMINI_API_KEY: 'AIzaSyTestKey',
      WEB_ORIGIN: 'https://archon.vercel.app',
      INGEST_RATE_LIMIT_PER_HOUR: '12',
      TRUST_PROXY_HOPS: '2',
      MAX_SUPPORTED_FILES: '300',
      MAX_REPO_SIZE_MB: '25',
      HUB_THRESHOLD: '45',
      RUN_EMBEDDED_WORKER: 'true',
    });

    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('warn');
    expect(env.GEMINI_API_KEY).toBe('AIzaSyTestKey');
    expect(env.WEB_ORIGIN).toBe('https://archon.vercel.app');
    expect(env.INGEST_RATE_LIMIT_PER_HOUR).toBe(12);
    expect(env.TRUST_PROXY_HOPS).toBe(2);
    expect(env.MAX_SUPPORTED_FILES).toBe(300);
    expect(env.MAX_REPO_SIZE_MB).toBe(25);
    expect(env.HUB_THRESHOLD).toBe(45);
    expect(env.RUN_EMBEDDED_WORKER).toBe(true);
  });

  it('parses RUN_EMBEDDED_WORKER="false" and "0" strictly as false (not truthy string)', () => {
    expect(parseEnv({ ...BASE_VALID_ENV, RUN_EMBEDDED_WORKER: 'false' }).RUN_EMBEDDED_WORKER).toBe(
      false,
    );
    expect(parseEnv({ ...BASE_VALID_ENV, RUN_EMBEDDED_WORKER: '0' }).RUN_EMBEDDED_WORKER).toBe(
      false,
    );
    expect(parseEnv({ ...BASE_VALID_ENV, RUN_EMBEDDED_WORKER: '1' }).RUN_EMBEDDED_WORKER).toBe(
      true,
    );
  });

  it('allows GITHUB_TOKEN to be omitted in test mode, but requires it in dev/prod', () => {
    const testEnv = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: BASE_VALID_ENV.DATABASE_URL,
      REDIS_URL: BASE_VALID_ENV.REDIS_URL,
      GITHUB_TOKEN: '',
    });
    expect(testEnv.GITHUB_TOKEN).toBeUndefined();
    expect(testEnv.WEB_ORIGIN).toBe(DEFAULT_DEV_WEB_ORIGIN);

    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        DATABASE_URL: BASE_VALID_ENV.DATABASE_URL,
        REDIS_URL: BASE_VALID_ENV.REDIS_URL,
        WEB_ORIGIN: 'https://archon.vercel.app',
      }),
    ).toThrow(EnvValidationError);
  });

  it('requires explicit WEB_ORIGIN in production and rejects malformed origins', () => {
    expect(() =>
      parseEnv({
        ...BASE_VALID_ENV,
        NODE_ENV: 'production',
      }),
    ).toThrow(EnvValidationError);

    const invalidOrigins = [
      'https://archon.vercel.app/',
      'https://archon.vercel.app/dashboard',
      'https://archon.vercel.app?foo=1',
      'https://archon.vercel.app#hash',
      'https://user:pass@archon.vercel.app',
      'ftp://archon.vercel.app',
      'not-a-url',
    ];

    for (const origin of invalidOrigins) {
      expect(() => parseEnv({ ...BASE_VALID_ENV, WEB_ORIGIN: origin })).toThrow(EnvValidationError);
    }
  });

  it('rejects non-integer or out-of-range TRUST_PROXY_HOPS and INGEST_RATE_LIMIT_PER_HOUR', () => {
    expect(parseEnv({ ...BASE_VALID_ENV, TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(0);

    for (const badHops of ['true', '-1', '6', '1.5']) {
      expect(() => parseEnv({ ...BASE_VALID_ENV, TRUST_PROXY_HOPS: badHops })).toThrow(
        EnvValidationError,
      );
    }

    for (const badLimit of ['0', '-5', '1001', 'five']) {
      expect(() => parseEnv({ ...BASE_VALID_ENV, INGEST_RATE_LIMIT_PER_HOUR: badLimit })).toThrow(
        EnvValidationError,
      );
    }
  });

  it('fails fast and lists ALL invalid/missing variables in one readable error', () => {
    let caught: unknown;
    try {
      parseEnv({
        NODE_ENV: 'development',
        PORT: '70000',
        DATABASE_URL: 'https://not-postgres.example.com',
        REDIS_URL: 'not-a-url',
        WEB_ORIGIN: 'https://archon.vercel.app/',
        INGEST_RATE_LIMIT_PER_HOUR: '0',
        TRUST_PROXY_HOPS: 'true',
        MAX_SUPPORTED_FILES: '500abc',
        RUN_EMBEDDED_WORKER: 'maybe',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    if (!(caught instanceof EnvValidationError)) {
      throw new Error('Expected EnvValidationError');
    }

    const paths = caught.issues.map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'PORT',
        'DATABASE_URL',
        'REDIS_URL',
        'WEB_ORIGIN',
        'INGEST_RATE_LIMIT_PER_HOUR',
        'TRUST_PROXY_HOPS',
        'MAX_SUPPORTED_FILES',
        'RUN_EMBEDDED_WORKER',
      ]),
    );
    expect(caught.message).toContain('Invalid environment configuration:');
    expect(caught.message).toContain('WEB_ORIGIN');
    expect(caught.message).toContain('TRUST_PROXY_HOPS');
  });
});

describe('findRepoRoot and loadEnv', () => {
  it('resolves the workspace root without depending on the checkout folder name', () => {
    const repoRoot = findRepoRoot();
    expect(existsSync(path.join(repoRoot, 'package.json'))).toBe(true);
    expect(existsSync(path.join(repoRoot, 'packages', 'shared', 'package.json'))).toBe(true);
  });

  it('loads variables from an explicit .env file path via dotenv', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'archon-env-test-'));
    const tempEnvFile = path.join(tempDir, '.env');
    const savedKeys = [
      'DATABASE_URL',
      'REDIS_URL',
      'GITHUB_TOKEN',
      'NODE_ENV',
      'HUB_THRESHOLD',
      'WEB_ORIGIN',
      'INGEST_RATE_LIMIT_PER_HOUR',
      'TRUST_PROXY_HOPS',
    ];
    const backup = Object.fromEntries(savedKeys.map((k) => [k, process.env[k]]));

    try {
      for (const key of savedKeys) {
        Reflect.deleteProperty(process.env, key);
      }

      writeFileSync(
        tempEnvFile,
        [
          'NODE_ENV=test',
          'DATABASE_URL=postgresql://archon:pass@127.0.0.1:5432/archon',
          'REDIS_URL=redis://127.0.0.1:6380',
          'HUB_THRESHOLD=42',
          'INGEST_RATE_LIMIT_PER_HOUR=10',
          'TRUST_PROXY_HOPS=2',
        ].join('\n'),
        'utf8',
      );

      const env = loadEnv({ envFilePath: tempEnvFile, loadDotenvFile: true });
      expect(env.HUB_THRESHOLD).toBe(42);
      expect(env.INGEST_RATE_LIMIT_PER_HOUR).toBe(10);
      expect(env.TRUST_PROXY_HOPS).toBe(2);
      expect(env.NODE_ENV).toBe('test');
    } finally {
      for (const [key, value] of Object.entries(backup)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
