import { ARCHON_VERSION, CORE_ENGINE_ID } from '@archon/shared';

export const API_SERVICE_INFO = {
  service: 'api',
  version: ARCHON_VERSION,
  engine: CORE_ENGINE_ID,
} as const;

export { API_BODY_LIMIT_BYTES, buildApp, type BuildAppDependencies } from './app.js';
export {
  AppApiError,
  buildErrorEnvelope,
  registerErrorHandlers,
  type ApiErrorEnvelope,
  type AppApiErrorOptions,
} from './errors.js';
export {
  GitHubPrecheckClient,
  GitHubPrecheckError,
  type GitHubPrecheckClientOptions,
  type GitHubPrecheckErrorCode,
  type PrecheckRepositoryResult,
  type RepoHeadInfo,
} from './github/precheck.js';
export {
  DEFAULT_ENQUEUE_TIMEOUT_MS,
  createBullMqIngestionEnqueuer,
  createStubIngestionEnqueuer,
  type CreateBullMqEnqueuerOptions,
  type EnqueueIngestionResult,
  type IngestionJobEnqueuer,
  type IngestionJobPayload,
} from './queue/enqueuer.js';
export {
  INGEST_RATE_LIMIT_WINDOW_MS,
  createInMemoryRateLimitStore,
  createRedisRateLimitStoreConfig,
  type RateLimitStoreConfig,
} from './rate-limit.js';
export {
  DEFAULT_RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_INCR_LUA,
  createRedisRateLimitStore,
  type CreateRedisRateLimitStoreOptions,
  type RedisRateLimitClient,
} from './redis-rate-limit-store.js';
export {
  createIngestionService,
  type IngestRepositoryInput,
  type IngestRepositoryOutput,
  type IngestionService,
  type IngestionServiceDependencies,
  type JobStatusOutput,
} from './services/ingestion-service.js';
