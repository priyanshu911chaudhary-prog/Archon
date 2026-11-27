import {
  DEFAULT_BLAST_RADIUS_MAX_DEPTH,
  DEFAULT_GRAPH_PAGE_LIMIT,
  MAX_BLAST_RADIUS_MAX_DEPTH,
  MAX_GRAPH_CURSOR_CHARS,
  MAX_GRAPH_FILE_PATH_CHARS,
  MAX_GRAPH_PAGE_LIMIT,
  MAX_HUB_THRESHOLD,
  MIN_BLAST_RADIUS_MAX_DEPTH,
  MIN_HUB_THRESHOLD,
  blastRadiusResponseSchema,
  edgeDirectionSchema,
  edgeTypeFilterSchema,
  graphZoomLevelSchema,
  hubScopeSchema,
  nodeDetailResponseSchema,
  nodeEdgesResponseSchema,
  repositoryGraphViewResponseSchema,
  repositoryHubsResponseSchema,
} from '@archon/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DEFAULT_GRAPH_RATE_LIMIT_MAX, DEFAULT_GRAPH_RATE_LIMIT_WINDOW_MS } from '../rate-limit.js';
import type { GraphQueryService } from '../services/graph-query-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRICT_NON_NEG_INT_RE = /^\d+$/;

const canonicalUuidSchema = z
  .string()
  .regex(UUID_RE, 'Expected valid UUID.')
  .transform((value) => value.toLowerCase());

function strictQueryIntSchema(min: number, max: number) {
  return z
    .string()
    .regex(STRICT_NON_NEG_INT_RE, `Expected integer between ${String(min)} and ${String(max)}.`)
    .transform((value) => Number.parseInt(value, 10))
    .refine(
      (n) => Number.isSafeInteger(n) && n >= min && n <= max,
      `Expected integer between ${String(min)} and ${String(max)}.`,
    );
}

const strictQueryBoolSchema = z.enum(['true', 'false']).transform((value) => value === 'true');
const strictCursorSchema = z.string().min(1).max(MAX_GRAPH_CURSOR_CHARS);
const strictFilePathSchema = z.string().min(1).max(MAX_GRAPH_FILE_PATH_CHARS);

const repoParamsSchema = z.object({ repoId: canonicalUuidSchema }).strict();
const repoNodeParamsSchema = z
  .object({ repoId: canonicalUuidSchema, nodeId: canonicalUuidSchema })
  .strict();

const getGraphQuerySchema = z
  .object({
    level: graphZoomLevelSchema.optional(),
    scopeNodeId: canonicalUuidSchema.optional(),
    filePath: strictFilePathSchema.optional(),
    includeImports: strictQueryBoolSchema.optional(),
    hubThreshold: strictQueryIntSchema(MIN_HUB_THRESHOLD, MAX_HUB_THRESHOLD).optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.scopeNodeId !== undefined && query.filePath !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['filePath'],
        message: 'Cannot specify both scopeNodeId and filePath.',
      });
    }
    const effectiveLevel = query.level ?? 'file';
    if (query.filePath !== undefined && effectiveLevel !== 'function') {
      ctx.addIssue({
        code: 'custom',
        path: ['filePath'],
        message: 'filePath is supported only when level=function.',
      });
    }
  });

const getNodeDetailQuerySchema = z
  .object({
    hubThreshold: strictQueryIntSchema(MIN_HUB_THRESHOLD, MAX_HUB_THRESHOLD).optional(),
    childrenLimit: strictQueryIntSchema(1, MAX_GRAPH_PAGE_LIMIT).optional(),
    childrenCursor: strictCursorSchema.optional(),
  })
  .strict();

const getNodeEdgesQuerySchema = z
  .object({
    direction: edgeDirectionSchema.optional(),
    edgeType: edgeTypeFilterSchema.optional(),
    peerNodeId: canonicalUuidSchema.optional(),
    limit: strictQueryIntSchema(1, MAX_GRAPH_PAGE_LIMIT).optional(),
    cursor: strictCursorSchema.optional(),
  })
  .strict();

const getBlastRadiusQuerySchema = z
  .object({
    maxDepth: strictQueryIntSchema(
      MIN_BLAST_RADIUS_MAX_DEPTH,
      MAX_BLAST_RADIUS_MAX_DEPTH,
    ).optional(),
    hubThreshold: strictQueryIntSchema(MIN_HUB_THRESHOLD, MAX_HUB_THRESHOLD).optional(),
  })
  .strict();

const getHubsQuerySchema = z
  .object({
    threshold: strictQueryIntSchema(MIN_HUB_THRESHOLD, MAX_HUB_THRESHOLD).optional(),
    scope: hubScopeSchema.optional(),
    limit: strictQueryIntSchema(1, MAX_GRAPH_PAGE_LIMIT).optional(),
    cursor: strictCursorSchema.optional(),
  })
  .strict();

export interface GraphRoutesOptions {
  readonly graphQueryService: GraphQueryService;
  readonly rateLimitMax?: number;
  readonly rateLimitWindowMs?: number;
}

export function registerGraphRoutes(app: FastifyInstance, options: GraphRoutesOptions): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const sharedRateLimit = {
    max: options.rateLimitMax ?? DEFAULT_GRAPH_RATE_LIMIT_MAX,
    timeWindow: options.rateLimitWindowMs ?? DEFAULT_GRAPH_RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request: { readonly ip: string }) => request.ip,
  };

  typedApp.get(
    '/api/v1/repos/:repoId/graph',
    {
      config: { rateLimit: sharedRateLimit },
      schema: {
        params: repoParamsSchema,
        querystring: getGraphQuerySchema,
        response: { 200: repositoryGraphViewResponseSchema },
      },
    },
    async (request, reply) => {
      const payload = await options.graphQueryService.getRepositoryGraph({
        repoId: request.params.repoId,
        level: request.query.level ?? 'file',
        scopeNodeId: request.query.scopeNodeId,
        filePath: request.query.filePath,
        includeImports: request.query.includeImports ?? true,
        hubThreshold: request.query.hubThreshold,
      });
      return reply.code(200).send(payload);
    },
  );

  typedApp.get(
    '/api/v1/repos/:repoId/nodes/:nodeId',
    {
      config: { rateLimit: sharedRateLimit },
      schema: {
        params: repoNodeParamsSchema,
        querystring: getNodeDetailQuerySchema,
        response: { 200: nodeDetailResponseSchema },
      },
    },
    async (request, reply) => {
      const payload = await options.graphQueryService.getNodeDetail({
        repoId: request.params.repoId,
        nodeId: request.params.nodeId,
        hubThreshold: request.query.hubThreshold,
        childrenLimit: request.query.childrenLimit ?? DEFAULT_GRAPH_PAGE_LIMIT,
        childrenCursor: request.query.childrenCursor,
      });
      return reply.code(200).send(payload);
    },
  );

  typedApp.get(
    '/api/v1/repos/:repoId/nodes/:nodeId/edges',
    {
      config: { rateLimit: sharedRateLimit },
      schema: {
        params: repoNodeParamsSchema,
        querystring: getNodeEdgesQuerySchema,
        response: { 200: nodeEdgesResponseSchema },
      },
    },
    async (request, reply) => {
      const payload = await options.graphQueryService.getNodeEdges({
        repoId: request.params.repoId,
        nodeId: request.params.nodeId,
        direction: request.query.direction ?? 'incoming',
        edgeType: request.query.edgeType ?? 'all',
        peerNodeId: request.query.peerNodeId,
        limit: request.query.limit ?? DEFAULT_GRAPH_PAGE_LIMIT,
        cursor: request.query.cursor,
      });
      return reply.code(200).send(payload);
    },
  );

  typedApp.get(
    '/api/v1/repos/:repoId/nodes/:nodeId/blast-radius',
    {
      config: { rateLimit: sharedRateLimit },
      schema: {
        params: repoNodeParamsSchema,
        querystring: getBlastRadiusQuerySchema,
        response: { 200: blastRadiusResponseSchema },
      },
    },
    async (request, reply) => {
      const payload = await options.graphQueryService.getBlastRadius({
        repoId: request.params.repoId,
        nodeId: request.params.nodeId,
        maxDepth: request.query.maxDepth ?? DEFAULT_BLAST_RADIUS_MAX_DEPTH,
        hubThreshold: request.query.hubThreshold,
      });
      return reply.code(200).send(payload);
    },
  );

  typedApp.get(
    '/api/v1/repos/:repoId/hubs',
    {
      config: { rateLimit: sharedRateLimit },
      schema: {
        params: repoParamsSchema,
        querystring: getHubsQuerySchema,
        response: { 200: repositoryHubsResponseSchema },
      },
    },
    async (request, reply) => {
      const payload = await options.graphQueryService.getRepositoryHubs({
        repoId: request.params.repoId,
        threshold: request.query.threshold,
        scope: request.query.scope ?? 'all',
        limit: request.query.limit ?? DEFAULT_GRAPH_PAGE_LIMIT,
        cursor: request.query.cursor,
      });
      return reply.code(200).send(payload);
    },
  );
}
