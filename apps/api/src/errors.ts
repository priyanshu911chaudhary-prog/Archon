import { DbError } from '@archon/db';
import { InvalidGitHubUrlError } from '@archon/shared';
import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { GitHubPrecheckError } from './github/precheck.js';

export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

export interface AppApiErrorOptions {
  readonly code: string;
  readonly statusCode: number;
  readonly message: string;
  readonly retryAfterSec?: number;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class AppApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryAfterSec?: number;
  readonly details?: Record<string, unknown>;

  constructor(options: AppApiErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppApiError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryAfterSec = options.retryAfterSec;
    this.details = options.details;
  }
}

export function buildErrorEnvelope(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorEnvelope {
  if (details !== undefined) {
    return { error: { code, message, details } };
  }
  return { error: { code, message } };
}

interface FastifyHttpErrorShape {
  readonly statusCode: number;
  readonly code?: string;
  readonly message: string;
}

function isFastifyHttpError(err: unknown): err is FastifyHttpErrorShape {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as Record<string, unknown>;
  return typeof candidate.statusCode === 'number' && typeof candidate.message === 'string';
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send(buildErrorEnvelope('NOT_FOUND', 'Route not found.'));
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((issue) => ({
        path: issue.instancePath,
        message: issue.message ?? 'Invalid value',
      }));
      return reply
        .code(400)
        .send(buildErrorEnvelope('VALIDATION_ERROR', 'Request validation failed.', { issues }));
    }

    if (isResponseSerializationError(err)) {
      request.log.error({ err }, 'Response serialization failed');
      return reply
        .code(500)
        .send(buildErrorEnvelope('INTERNAL_ERROR', 'An unexpected internal error occurred.'));
    }

    if (err instanceof InvalidGitHubUrlError) {
      return reply.code(err.statusCode).send(buildErrorEnvelope(err.code, err.message));
    }

    if (err instanceof GitHubPrecheckError) {
      if (err.retryAfterSec !== undefined) {
        reply.header('Retry-After', String(err.retryAfterSec));
      }
      return reply
        .code(err.statusCode)
        .send(buildErrorEnvelope(err.code, err.message, err.details));
    }

    if (err instanceof AppApiError) {
      if (err.retryAfterSec !== undefined) {
        reply.header('Retry-After', String(err.retryAfterSec));
      }
      return reply
        .code(err.statusCode)
        .send(buildErrorEnvelope(err.code, err.message, err.details));
    }

    if (err instanceof DbError) {
      request.log.error({ err, dbCode: err.code, pgCode: err.pgCode }, 'Database operation failed');
      const statusCode = err.code === 'DB_CONNECTION_ERROR' ? 503 : 500;
      return reply
        .code(statusCode)
        .send(buildErrorEnvelope('DATABASE_ERROR', 'Database temporarily unavailable.'));
    }

    if (isFastifyHttpError(err)) {
      if (err.statusCode === 413) {
        return reply
          .code(413)
          .send(
            buildErrorEnvelope(
              'PAYLOAD_TOO_LARGE',
              'Request body exceeds the maximum allowed size.',
            ),
          );
      }
      if (err.statusCode === 415) {
        return reply
          .code(415)
          .send(
            buildErrorEnvelope('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.'),
          );
      }
      if (err.statusCode === 400) {
        return reply
          .code(400)
          .send(buildErrorEnvelope('BAD_REQUEST', 'Malformed request payload.'));
      }
    }

    request.log.error({ err }, 'Unhandled request error');
    return reply
      .code(500)
      .send(buildErrorEnvelope('INTERNAL_ERROR', 'An unexpected internal error occurred.'));
  });
}
