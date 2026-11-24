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
  readonly checkRedisHealth?: () => Promise<boolean>;
  readonly workerMode: 'embedded' | 'external';
  readonly startedAtMs: number;
  readonly now?: () => number;
}

async function runHealthProbe(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
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
      const dbOk = await runHealthProbe(options.checkDbHealth);

      let redisStatus: 'ok' | 'error' | 'not_configured';
      let redisHealthy: boolean;
      if (options.checkRedisHealth === undefined) {
        redisStatus = 'not_configured';
        redisHealthy = true;
      } else {
        redisHealthy = await runHealthProbe(options.checkRedisHealth);
        redisStatus = redisHealthy ? 'ok' : 'error';
      }

      const overallHealthy = dbOk && redisHealthy;
      const uptimeSec = Math.max(0, Math.floor((nowFn() - options.startedAtMs) / 1000));

      const payload = {
        status: overallHealthy ? ('ok' as const) : ('degraded' as const),
        db: dbOk ? ('ok' as const) : ('error' as const),
        redis: redisStatus,
        workerMode: options.workerMode,
        uptimeSec,
      };

      return reply.code(overallHealthy ? 200 : 503).send(payload);
    },
  );
}
