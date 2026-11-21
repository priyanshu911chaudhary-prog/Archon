import { REPOSITORY_STATUSES } from '@archon/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { INGEST_RATE_LIMIT_WINDOW_MS } from '../rate-limit.js';
import type { IngestionService } from '../services/ingestion-service.js';

// Strict object schema: public POST /api/v1/repos accepts ONLY { githubUrl } (no sha field)
const createRepoBodySchema = z
  .object({
    githubUrl: z.string().min(1),
  })
  .strict();

const createRepoResponseSchema = z.object({
  repoId: z.uuid(),
  jobId: z.uuid(),
  status: z.enum(REPOSITORY_STATUSES),
  reused: z.boolean(),
});

export interface ReposRouteOptions {
  readonly ingestionService: IngestionService;
  readonly rateLimitPerHour: number;
  readonly rateLimitWindowMs?: number;
}

export function registerReposRoute(app: FastifyInstance, options: ReposRouteOptions): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/api/v1/repos',
    {
      config: {
        rateLimit: {
          max: options.rateLimitPerHour,
          timeWindow: options.rateLimitWindowMs ?? INGEST_RATE_LIMIT_WINDOW_MS,
          keyGenerator: (request) => request.ip,
        },
      },
      schema: {
        body: createRepoBodySchema,
        response: {
          200: createRepoResponseSchema,
          202: createRepoResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await options.ingestionService.ingestRepository({
        githubUrl: request.body.githubUrl,
      });
      return reply.code(result.httpStatus).send(result.body);
    },
  );
}
