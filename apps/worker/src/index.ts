import { CORE_ENGINE_ID } from '@archon/core';
import { ARCHON_VERSION } from '@archon/shared';

export const WORKER_SERVICE_INFO = {
  service: 'worker',
  version: ARCHON_VERSION,
  engine: CORE_ENGINE_ID,
} as const;

export {
  TarballExtractionError,
  type TarballExtractionErrorCode,
  type TarballExtractionErrorOptions,
} from './extractor/errors.js';
export {
  withExtractedRepo,
  type ExtractGitHubTarballOptions,
  type ExtractedRepoWorkspace,
  type ExtractionStats,
} from './extractor/github-tarball.js';
export {
  assertSafeWritePath,
  buildSafeDestinationPath,
  parseAndValidateTarEntryPath,
  type ParsedTarEntryPath,
} from './extractor/path-guard.js';

export {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  NonRetryableIngestionError,
  STAGE_PROGRESS,
  classifyIngestionError,
  createIngestionJobProcessor,
  isFinalJobAttempt,
  type ClassifiedIngestionError,
  type CreateIngestionProcessorDependencies,
  type ExtractRepoFn,
  type IngestionProcessorJob,
  type ParseWorkspaceFn,
} from './processor.js';

export {
  DEFAULT_INGESTION_QUEUE_NAME,
  DEFAULT_JOB_ATTEMPTS,
  DEFAULT_JOB_BACKOFF_MS,
  DEFAULT_REMOVE_ON_COMPLETE_COUNT,
  DEFAULT_REMOVE_ON_FAIL_COUNT,
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
  DEFAULT_WORKER_CONCURRENCY,
  DEFAULT_WORKER_DRAIN_DELAY_SEC,
  DEFAULT_WORKER_LOCK_DURATION_MS,
  DEFAULT_WORKER_MAX_STALLED_COUNT,
  DEFAULT_WORKER_STALLED_INTERVAL_MS,
  INGESTION_JOB_NAME,
  closeWorkerWithTimeout,
  createIngestionQueue,
  createIngestionWorker,
  enqueueIngestionJob,
  shutdownWorkerResources,
  type CloseWorkerResult,
  type CreateIngestionQueueOptions,
  type CreateIngestionWorkerOptions,
  type EnqueuedIngestionJobResult,
  type IngestionBullMqJob,
  type IngestionQueue,
  type IngestionQueueJobData,
  type IngestionWorker,
  type ShutdownWorkerResourcesInput,
} from './queue.js';

export {
  RedisConfigError,
  closeRedisClient,
  createFastFailRedisClient,
  waitForRedisReady,
  parseBullMqConnectionOptions,
  sanitizeRedisTarget,
  type CreateFastFailRedisClientOptions,
  type RedisConnectionConfig,
  computeFastFailRetryDelay,
  FAST_FAIL_RECONNECT_BASE_MS,
  FAST_FAIL_RECONNECT_MAX_MS,
} from './redis.js';
