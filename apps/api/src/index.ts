import { CORE_ENGINE_ID } from '@archon/core';
import { ARCHON_VERSION } from '@archon/shared';

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
  createStubIngestionEnqueuer,
  type EnqueueIngestionResult,
  type IngestionJobEnqueuer,
  type IngestionJobPayload,
} from './queue/enqueuer.js';
export {
  INGEST_RATE_LIMIT_WINDOW_MS,
  createInMemoryRateLimitStore,
  type RateLimitStoreConfig,
} from './rate-limit.js';
export {
  createIngestionService,
  type IngestRepositoryInput,
  type IngestRepositoryOutput,
  type IngestionService,
  type IngestionServiceDependencies,
  type JobStatusOutput,
} from './services/ingestion-service.js';
