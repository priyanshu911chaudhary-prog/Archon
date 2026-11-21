import { REPOSITORY_STATUSES } from '@archon/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { IngestionService } from '../services/ingestion-service.js';

const getJobParamsSchema = z.object({
  jobId: z.uuid(),
});

const getJobResponseSchema = z.object({
  jobId: z.uuid(),
  repoId: z.uuid(),
  status: z.enum(REPOSITORY_STATUSES),
  progressPct: z.number().int().min(0).max(100),
  stats: z.object({
    fileCount: z.number().int().nonnegative(),
    skippedFilesCount: z.number().int().nonnegative(),
    emptyJsTs: z.boolean(),
  }),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export interface JobsRouteOptions {
  readonly ingestionService: IngestionService;
}

export function registerJobsRoute(app: FastifyInstance, options: JobsRouteOptions): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    '/api/v1/jobs/:jobId',
    {
      schema: {
        params: getJobParamsSchema,
        response: {
          200: getJobResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const jobStatus = await options.ingestionService.getJobStatus(request.params.jobId);
      return reply.code(200).send(jobStatus);
    },
  );
}
