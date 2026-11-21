import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'error']),
  redis: z.enum(['ok', 'error', 'not_configured']),
  workerMode: z.enum(['embedded', 'external']),
  uptimeSec: z.number().int().nonnegative(),
});

export interface HealthRouteOptions {
  readonly checkDbHealth: () => Promise<boolean>;
  readonly workerMode: 'embedded' | 'external';
  readonly startedAtMs: number;
  readonly now?: () => number;
}

export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const nowFn = options.now ?? (() => Date.now());

  typedApp.get(
    '/api/v1/health',
    {
      schema: {
        response: {
          200: healthResponseSchema,
          503: healthResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const dbOk = await options.checkDbHealth();
      const uptimeSec = Math.max(0, Math.floor((nowFn() - options.startedAtMs) / 1000));

      const payload = {
        status: dbOk ? ('ok' as const) : ('degraded' as const),
        db: dbOk ? ('ok' as const) : ('error' as const),
        redis: 'not_configured' as const,
        workerMode: options.workerMode,
        uptimeSec,
      };

      return reply.code(dbOk ? 200 : 503).send(payload);
    },
  );
}
