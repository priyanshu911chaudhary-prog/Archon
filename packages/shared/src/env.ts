import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

export interface EnvValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class EnvValidationError extends Error {
  readonly issues: readonly EnvValidationIssue[];

  constructor(issues: readonly EnvValidationIssue[]) {
    const formatted = issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n');
    super(`Invalid environment configuration:\n${formatted}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

const emptyToUndefined = (val: unknown): unknown =>
  typeof val === 'string' && val.trim() === '' ? undefined : val;

function intFromEnv(min: number, max: number, defaultValue: number) {
  return z.preprocess(
    (val) => {
      const normalized = emptyToUndefined(val);
      if (normalized === undefined) {
        return defaultValue;
      }
      if (typeof normalized === 'number') {
        return normalized;
      }
      if (typeof normalized === 'string' && /^-?\d+$/.test(normalized.trim())) {
        return Number.parseInt(normalized.trim(), 10);
      }
      return normalized;
    },
    z
      .number({ error: `Expected an integer between ${min} and ${max}` })
      .int({ error: `Expected an integer between ${min} and ${max}` })
      .min(min, { error: `Must be >= ${min}` })
      .max(max, { error: `Must be <= ${max}` }),
  );
}

function booleanFromEnv(defaultValue: boolean) {
  return z.preprocess(
    (val) => {
      const normalized = emptyToUndefined(val);
      if (normalized === undefined) {
        return defaultValue;
      }
      if (typeof normalized === 'boolean') {
        return normalized;
      }
      if (typeof normalized === 'string') {
        const lower = normalized.trim().toLowerCase();
        if (lower === 'true' || lower === '1') {
          return true;
        }
        if (lower === 'false' || lower === '0') {
          return false;
        }
      }
      return normalized;
    },
    z.boolean({ error: 'Expected boolean ("true", "false", "1", or "0")' }),
  );
}

const optionalNonEmptyString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const databaseUrlSchema = z.preprocess(
  emptyToUndefined,
  z
    .url({ error: 'Required valid PostgreSQL URL (postgres:// or postgresql://)' })
    .refine((url) => /^postgres(ql)?:\/\//i.test(url), {
      error: 'Must use postgres:// or postgresql:// protocol',
    }),
);

const redisUrlSchema = z.preprocess(
  emptyToUndefined,
  z
    .url({ error: 'Required valid Redis URL (redis:// or rediss://)' })
    .refine((url) => /^rediss?:\/\//i.test(url), {
      error: 'Must use redis:// or rediss:// protocol',
    }),
);

const webOriginSchema = z.preprocess(
  emptyToUndefined,
  z
    .url({ error: 'Must be a valid http:// or https:// origin (e.g. http://localhost:3000)' })
    .refine(
      (raw) => {
        if (raw.endsWith('/') || raw.includes('?') || raw.includes('#')) {
          return false;
        }
        try {
          const parsed = new URL(raw);
          const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
          return (
            isHttp && parsed.pathname === '/' && parsed.username === '' && parsed.password === ''
          );
        } catch {
          return false;
        }
      },
      {
        error:
          'Must be a clean http:// or https:// origin with no path, query, hash, credentials, or trailing slash',
      },
    )
    .optional(),
);

const logLevelValues = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof logLevelValues)[number];

export const DEFAULT_DEV_WEB_ORIGIN = 'http://localhost:3000' as const;

export const envSchema = z
  .object({
    NODE_ENV: z.preprocess(
      emptyToUndefined,
      z.enum(['development', 'test', 'production']).default('development'),
    ),
    PORT: intFromEnv(1, 65535, 4000),
    LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(logLevelValues).default('info')),
    DATABASE_URL: databaseUrlSchema,
    REDIS_URL: redisUrlSchema,
    GITHUB_TOKEN: optionalNonEmptyString,
    GEMINI_API_KEY: optionalNonEmptyString,
    WEB_ORIGIN: webOriginSchema,
    INGEST_RATE_LIMIT_PER_HOUR: intFromEnv(1, 1000, 5),
    TRUST_PROXY_HOPS: intFromEnv(0, 5, 1),
    MAX_SUPPORTED_FILES: intFromEnv(1, 10000, 500),
    MAX_REPO_SIZE_MB: intFromEnv(1, 1000, 50),
    HUB_THRESHOLD: intFromEnv(1, 10000, 30),
    RUN_EMBEDDED_WORKER: booleanFromEnv(false),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== 'test' && !data.GITHUB_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_TOKEN'],
        message: 'Required when NODE_ENV is not "test"',
      });
    }
    if (data.NODE_ENV === 'production' && !data.WEB_ORIGIN) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'Required when NODE_ENV is "production"',
      });
    }
  })
  .transform((data) => ({
    ...data,
    WEB_ORIGIN: data.WEB_ORIGIN ?? DEFAULT_DEV_WEB_ORIGIN,
  }));

export type AppEnv = Readonly<z.infer<typeof envSchema>>;

export function findRepoRoot(startDir: string = import.meta.dirname): string {
  let currentDir = path.resolve(startDir);

  for (let depth = 0; depth < 10; depth += 1) {
    const pkgPath = path.join(currentDir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && 'workspaces' in parsed) {
          return currentDir;
        }
      } catch {
        // Continue walking up if a nested package.json cannot be read
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return path.resolve(startDir, '../../..');
}

export function parseEnv(rawEnv: Record<string, string | undefined>): AppEnv {
  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const issues: EnvValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.map(String).join('.') : 'ENV',
      message: issue.message,
    }));
    throw new EnvValidationError(issues);
  }

  return Object.freeze(result.data);
}

export interface LoadEnvOptions {
  /** Override source env map (skips reading .env file unless loadDotenvFile is explicitly true). */
  readonly env?: Record<string, string | undefined>;
  /** Explicit path to a .env file; defaults to <repo-root>/.env. */
  readonly envFilePath?: string;
  /** Whether to load .env via dotenv before parsing. Defaults to true when `env` is omitted. */
  readonly loadDotenvFile?: boolean;
}

export function loadEnv(options: LoadEnvOptions = {}): AppEnv {
  const shouldLoadFile = options.loadDotenvFile ?? options.env === undefined;

  if (shouldLoadFile) {
    const envPath = options.envFilePath ?? path.join(findRepoRoot(), '.env');
    if (existsSync(envPath)) {
      loadDotenv({ path: envPath, quiet: true });
    }
  }

  return parseEnv(options.env ?? process.env);
}
