import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { LogLevel } from './env.js';

export const REDACTED_CENSOR = '[REDACTED]' as const;

export const LOG_REDACT_PATHS: readonly string[] = [
  'authorization',
  '*.authorization',
  '*.*.authorization',
  'headers.authorization',
  'req.headers.authorization',
  'res.headers.authorization',
  '*.headers.authorization',
  'GITHUB_TOKEN',
  '*.GITHUB_TOKEN',
  'githubToken',
  '*.githubToken',
  'GEMINI_API_KEY',
  '*.GEMINI_API_KEY',
  'geminiApiKey',
  '*.geminiApiKey',
  'apiKey',
  '*.apiKey',
  'password',
  '*.password',
];

export interface CreateLoggerOptions {
  readonly service: string;
  readonly level?: LogLevel;
  readonly redactPaths?: readonly string[];
}

export function createLogger(
  options: CreateLoggerOptions,
  destination?: DestinationStream,
): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service },
    redact: {
      paths: [...LOG_REDACT_PATHS, ...(options.redactPaths ?? [])],
      censor: REDACTED_CENSOR,
    },
  };

  return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}

export type { DestinationStream, Logger };
