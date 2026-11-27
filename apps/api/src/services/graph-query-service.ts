import {
  DEFAULT_GRAPH_QUERY_LIMITS,
  DbError,
  GraphQueryError,
  REPOSITORY_STATUSES,
  classifyDbError,
  isPgStatementTimeout,
  type GetBlastRadiusInput,
  type GetNodeDetailInput,
  type GetNodeEdgesInput,
  type GetRepositoryGraphInput,
  type GetRepositoryHubsInput,
  type GraphQueryErrorCode,
  type GraphQueryRepository,
} from '@archon/db';
import {
  GRAPH_ZOOM_LEVELS,
  type BlastRadiusResponse,
  type Logger,
  type NodeDetailResponse,
  type NodeEdgesResponse,
  type RepositoryGraphViewResponse,
  type RepositoryHubsResponse,
} from '@archon/shared';
import { AppApiError } from '../errors.js';
import type { GraphQueryAdmissionGate } from '../graph-admission.js';

export interface GraphQueryServiceDependencies {
  readonly repository: GraphQueryRepository;
  readonly admission: GraphQueryAdmissionGate;
  readonly logger: Pick<Logger, 'warn' | 'error'>;
  readonly defaultHubThreshold: number;
  readonly maxResponseBytes?: number;
  readonly now?: () => Date;
}

export interface GraphQueryService {
  getRepositoryGraph(
    input: Omit<GetRepositoryGraphInput, 'now'>,
  ): Promise<RepositoryGraphViewResponse>;
  getNodeDetail(input: Omit<GetNodeDetailInput, 'now'>): Promise<NodeDetailResponse>;
  getNodeEdges(input: Omit<GetNodeEdgesInput, 'now'>): Promise<NodeEdgesResponse>;
  getBlastRadius(input: Omit<GetBlastRadiusInput, 'now'>): Promise<BlastRadiusResponse>;
  getRepositoryHubs(input: Omit<GetRepositoryHubsInput, 'now'>): Promise<RepositoryHubsResponse>;
}

const SAFE_REPO_STATUS_SET = new Set<string>(REPOSITORY_STATUSES);
const SAFE_ZOOM_LEVEL_SET = new Set<string>(GRAPH_ZOOM_LEVELS);
const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_STAGE_RE = /^[a-z][a-z0-9_]{1,47}$/;

const NUMERIC_DETAIL_BOUNDS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  maxScannedNodes: [1, 1_000_000],
  maxScannedRawEdges: [1, 10_000_000],
  maxReturnedNodes: [1, 1_000_000],
  maxReturnedEdges: [1, 1_000_000],
  returnedEdges: [0, 1_000_000],
  maxResponseBytes: [1, 16 * 1024 * 1024],
  maxContainmentDepth: [1, 1_024],
  maxFrontierSize: [1, 1_000_000],
  maxSeedNodes: [1, 1_000_000],
  maxVisitedStates: [1, 1_000_000],
  visitedStates: [0, 1_000_000],
  maxCumulativeRawEdges: [1, 10_000_000],
  maxEvidenceItems: [1, 1_000_000],
  discoveredLayerSize: [0, 1_000_000],
  hop: [1, 3],
});

function sanitizeErrorDetails(
  raw: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'status' && typeof value === 'string' && SAFE_REPO_STATUS_SET.has(value)) {
      safe.status = value;
      continue;
    }
    if (key === 'suggestedLevel' && typeof value === 'string' && SAFE_ZOOM_LEVEL_SET.has(value)) {
      safe.suggestedLevel = value;
      continue;
    }
    if (key === 'errorCode' && typeof value === 'string' && SAFE_ERROR_CODE_RE.test(value)) {
      safe.errorCode = value;
      continue;
    }
    if (key === 'stage' && typeof value === 'string' && SAFE_STAGE_RE.test(value)) {
      safe.stage = value;
      continue;
    }
    const bounds = NUMERIC_DETAIL_BOUNDS[key];
    if (
      bounds !== undefined &&
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= bounds[0] &&
      value <= bounds[1]
    ) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

const FIXED_GRAPH_ERROR_MAP: Readonly<
  Record<
    GraphQueryErrorCode,
    {
      readonly statusCode: number;
      readonly code: string;
      readonly message: string;
      readonly allowDetails: boolean;
    }
  >
> = Object.freeze({
  INVALID_QUERY: {
    statusCode: 400,
    code: 'VALIDATION_ERROR',
    message: 'Invalid graph query parameters.',
    allowDetails: false,
  },
  INVALID_CURSOR: {
    statusCode: 400,
    code: 'INVALID_CURSOR',
    message: 'Pagination cursor is invalid or does not match query parameters.',
    allowDetails: false,
  },
  REPO_NOT_FOUND: {
    statusCode: 404,
    code: 'REPO_NOT_FOUND',
    message: 'Repository not found.',
    allowDetails: false,
  },
  NODE_NOT_FOUND: {
    statusCode: 404,
    code: 'NODE_NOT_FOUND',
    message: 'Node not found in repository.',
    allowDetails: false,
  },
  GRAPH_NOT_READY: {
    statusCode: 409,
    code: 'GRAPH_NOT_READY',
    message: 'Repository graph is not ready yet.',
    allowDetails: true,
  },
  LEGACY_GRAPH_UNAVAILABLE: {
    statusCode: 409,
    code: 'LEGACY_GRAPH_UNAVAILABLE',
    message: 'Repository graph was not persisted and requires re-ingestion.',
    allowDetails: false,
  },
  REPO_INGESTION_FAILED: {
    statusCode: 409,
    code: 'REPO_INGESTION_FAILED',
    message: 'Repository ingestion failed.',
    allowDetails: true,
  },
  REPO_SUPERSEDED: {
    statusCode: 409,
    code: 'REPO_SUPERSEDED',
    message: 'Repository snapshot has been superseded by a newer ingestion.',
    allowDetails: false,
  },
  REPO_EXPIRED: {
    statusCode: 410,
    code: 'REPO_EXPIRED',
    message: 'Repository snapshot has expired and must be re-ingested.',
    allowDetails: false,
  },
  INVALID_SCOPE_NODE: {
    statusCode: 422,
    code: 'INVALID_SCOPE_NODE',
    message: 'Requested scope node is not valid for this graph zoom level.',
    allowDetails: false,
  },
  GRAPH_SCOPE_REQUIRED: {
    statusCode: 422,
    code: 'GRAPH_SCOPE_REQUIRED',
    message: 'Requested graph view exceeds unscoped limits; narrow the scope.',
    allowDetails: true,
  },
  GRAPH_BUDGET_EXCEEDED: {
    statusCode: 422,
    code: 'GRAPH_BUDGET_EXCEEDED',
    message: 'Graph query exceeded processing budget; narrow the requested scope.',
    allowDetails: true,
  },
  BLAST_RADIUS_BUDGET_EXCEEDED: {
    statusCode: 422,
    code: 'BLAST_RADIUS_BUDGET_EXCEEDED',
    message: 'Blast-radius traversal exceeded processing budget; reduce depth or narrow target.',
    allowDetails: true,
  },
  GRAPH_RESPONSE_TOO_LARGE: {
    statusCode: 422,
    code: 'GRAPH_RESPONSE_TOO_LARGE',
    message: 'Graph query response exceeds maximum allowed size; narrow the requested scope.',
    allowDetails: true,
  },
  GRAPH_CONTAINMENT_INVALID: {
    statusCode: 500,
    code: 'GRAPH_DATA_INTEGRITY_ERROR',
    message: 'Persisted repository graph failed integrity validation.',
    allowDetails: false,
  },
});

function mapGraphQueryError(
  err: GraphQueryError,
  logger: Pick<Logger, 'warn' | 'error'>,
  operation: string,
): AppApiError {
  const spec = FIXED_GRAPH_ERROR_MAP[err.code];
  if (err.code === 'GRAPH_CONTAINMENT_INVALID') {
    logger.error(
      { operation, errorCode: err.code },
      'Persisted graph containment integrity check failed',
    );
  }
  const details = spec.allowDetails ? sanitizeErrorDetails(err.details) : undefined;
  return new AppApiError({
    code: spec.code,
    statusCode: spec.statusCode,
    message: spec.message,
    ...(details !== undefined ? { details } : {}),
  });
}

/**
 * Translates every graph-read exception into a sanitized AppApiError with fixed public text
 * and zero raw `err.message`, `err.name`, `cause`, SQL parameters, or snippets in responses/logs.
 */
function translateGraphReadError(
  err: unknown,
  logger: Pick<Logger, 'warn' | 'error'>,
  operation: string,
): AppApiError {
  if (err instanceof AppApiError) {
    return err;
  }
  if (err instanceof GraphQueryError) {
    return mapGraphQueryError(err, logger, operation);
  }

  const classification = classifyDbError(err);

  if (
    classification.category === 'transaction_timeout' ||
    (classification.category === 'query_canceled' && isPgStatementTimeout(err))
  ) {
    logger.warn(
      { operation, dbCategory: classification.category, pgCode: classification.pgCode },
      'Graph query timed out',
    );
    return new AppApiError({
      code: 'GRAPH_QUERY_TIMEOUT',
      statusCode: 504,
      message: 'Graph query timed out before completion.',
    });
  }

  if (classification.category === 'query_canceled') {
    logger.warn(
      { operation, dbCategory: classification.category, pgCode: classification.pgCode },
      'Graph query was canceled',
    );
    return new AppApiError({
      code: 'GRAPH_QUERY_CANCELED',
      statusCode: 503,
      message: 'Graph query was canceled before completion.',
    });
  }

  if (
    classification.category === 'connection_error' ||
    (err instanceof DbError && err.code === 'DB_CONNECTION_ERROR')
  ) {
    logger.error(
      { operation, dbCategory: classification.category, pgCode: classification.pgCode },
      'Graph query failed due to database connection error',
    );
    return new AppApiError({
      code: 'DATABASE_ERROR',
      statusCode: 503,
      message: 'Database temporarily unavailable.',
    });
  }

  if (err instanceof DbError || classification.pgCode !== undefined) {
    logger.error(
      {
        operation,
        dbCategory: classification.category,
        dbCode: err instanceof DbError ? err.code : undefined,
        pgCode: classification.pgCode,
      },
      'Graph query database error',
    );
    return new AppApiError({
      code: 'DATABASE_ERROR',
      statusCode: 500,
      message: 'Database query failed.',
    });
  }

  logger.error({ operation, errorCategory: 'unexpected_error' }, 'Unexpected graph query failure');
  return new AppApiError({
    code: 'INTERNAL_ERROR',
    statusCode: 500,
    message: 'An unexpected internal error occurred.',
  });
}

export function createGraphQueryService(deps: GraphQueryServiceDependencies): GraphQueryService {
  const nowFn = deps.now ?? (() => new Date());
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_GRAPH_QUERY_LIMITS.maxResponseBytes;

  async function executeAdmitted<T>(operation: string, work: () => Promise<T>): Promise<T> {
    if (deps.admission.isStopped()) {
      throw new AppApiError({
        code: 'SERVICE_UNAVAILABLE',
        statusCode: 503,
        retryAfterSec: 1,
        message: 'Graph query service is shutting down.',
      });
    }
    const release = deps.admission.tryAcquire();
    if (release === null) {
      throw new AppApiError({
        code: deps.admission.isStopped() ? 'SERVICE_UNAVAILABLE' : 'GRAPH_QUERY_BUSY',
        statusCode: 503,
        retryAfterSec: 1,
        message: deps.admission.isStopped()
          ? 'Graph query service is shutting down.'
          : 'Graph query capacity is currently saturated. Please try again shortly.',
      });
    }

    try {
      const response = await work();
      const byteLength = Buffer.byteLength(JSON.stringify(response), 'utf8');
      if (byteLength > maxResponseBytes) {
        throw new GraphQueryError(
          'GRAPH_RESPONSE_TOO_LARGE',
          'Graph query response exceeds maximum allowed byte budget.',
          { maxResponseBytes },
        );
      }
      return response;
    } catch (err) {
      throw translateGraphReadError(err, deps.logger, operation);
    } finally {
      release();
    }
  }

  return {
    getRepositoryGraph(input) {
      return executeAdmitted('getRepositoryGraph', () =>
        deps.repository.getRepositoryGraph({
          ...input,
          hubThreshold: input.hubThreshold ?? deps.defaultHubThreshold,
          now: nowFn(),
        }),
      );
    },
    getNodeDetail(input) {
      return executeAdmitted('getNodeDetail', () =>
        deps.repository.getNodeDetail({
          ...input,
          hubThreshold: input.hubThreshold ?? deps.defaultHubThreshold,
          now: nowFn(),
        }),
      );
    },
    getNodeEdges(input) {
      return executeAdmitted('getNodeEdges', () =>
        deps.repository.getNodeEdges({
          ...input,
          now: nowFn(),
        }),
      );
    },
    getBlastRadius(input) {
      return executeAdmitted('getBlastRadius', () =>
        deps.repository.getBlastRadius({
          ...input,
          hubThreshold: input.hubThreshold ?? deps.defaultHubThreshold,
          now: nowFn(),
        }),
      );
    },
    getRepositoryHubs(input) {
      return executeAdmitted('getRepositoryHubs', () =>
        deps.repository.getRepositoryHubs({
          ...input,
          threshold: input.threshold ?? deps.defaultHubThreshold,
          now: nowFn(),
        }),
      );
    },
  };
}
