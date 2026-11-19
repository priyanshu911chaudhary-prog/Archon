import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REDACTED_CENSOR, createLogger, type DestinationStream } from './logger.js';

const logRecordSchema = z
  .object({
    service: z.string(),
    msg: z.string(),
    req: z
      .object({
        headers: z.object({
          authorization: z.string(),
          'user-agent': z.string(),
        }),
      })
      .optional(),
    GITHUB_TOKEN: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    config: z
      .object({
        GITHUB_TOKEN: z.string(),
        GEMINI_API_KEY: z.string(),
        hubThreshold: z.number(),
      })
      .optional(),
  })
  .loose();

describe('createLogger', () => {
  it('redacts authorization headers, GITHUB_TOKEN, and GEMINI_API_KEY at top-level and nested paths', () => {
    const rawLines: string[] = [];
    const destination: DestinationStream = {
      write(chunk: string): void {
        rawLines.push(chunk);
      },
    };

    const logger = createLogger({ service: 'api-test', level: 'info' }, destination);

    const secretBearer = 'Bearer super_secret_jwt_value';
    const secretGithub = 'ghp_top_secret_github_pat_999';
    const secretGemini = 'AIzaSyTopSecretGeminiKey999';

    logger.info(
      {
        req: {
          headers: {
            authorization: secretBearer,
            'user-agent': 'archon-test-agent',
          },
        },
        GITHUB_TOKEN: secretGithub,
        GEMINI_API_KEY: secretGemini,
        config: {
          GITHUB_TOKEN: secretGithub,
          GEMINI_API_KEY: secretGemini,
          hubThreshold: 30,
        },
      },
      'incoming request',
    );

    expect(rawLines).toHaveLength(1);
    const serialized = rawLines[0] ?? '';

    // Raw secrets must never leak anywhere in serialized log output
    expect(serialized).not.toContain(secretBearer);
    expect(serialized).not.toContain(secretGithub);
    expect(serialized).not.toContain(secretGemini);

    const parsed = logRecordSchema.parse(JSON.parse(serialized));
    expect(parsed.service).toBe('api-test');
    expect(parsed.msg).toBe('incoming request');
    expect(parsed.req?.headers.authorization).toBe(REDACTED_CENSOR);
    expect(parsed.req?.headers['user-agent']).toBe('archon-test-agent');
    expect(parsed.GITHUB_TOKEN).toBe(REDACTED_CENSOR);
    expect(parsed.GEMINI_API_KEY).toBe(REDACTED_CENSOR);
    expect(parsed.config?.GITHUB_TOKEN).toBe(REDACTED_CENSOR);
    expect(parsed.config?.GEMINI_API_KEY).toBe(REDACTED_CENSOR);
    expect(parsed.config?.hubThreshold).toBe(30);
  });
});
