export {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  buildPoolConfig,
  createDbClient,
  resolvePoolSsl,
  sanitizeDatabaseTarget,
  type ArchonDatabase,
  type CreateDbClientOptions,
  type DbClient,
} from './client.js';

export {
  DbError,
  PG_UNIQUE_VIOLATION_CODE,
  extractPgErrorInfo,
  isPgUniqueViolation,
  type DbErrorCode,
  type PgErrorInfo,
} from './errors.js';

export { getMigrationsFolder, runMigrations } from './migrate.js';

export {
  ACTIVE_REPO_UNIQUE_INDEX,
  DEFAULT_REPO_TTL_DAYS,
  DEFAULT_STALE_JOB_THRESHOLD_MS,
  computeExpiresAt,
  createIngestionRepository,
  type CreateOrGetActiveRepoInput,
  type CreateOrGetActiveRepoResult,
  type IngestionRepository,
  type RepositoryWithJob,
  type SweepStaleJobsInput,
  type SweepStaleJobsResult,
  type TouchHeartbeatResult,
  type TransitionJobStageInput,
  type TransitionJobStageResult,
} from './repository.js';

export {
  ACTIVE_REPOSITORY_STATUSES,
  EMBEDDING_STATUSES,
  REPOSITORY_STATUSES,
  TERMINAL_REPOSITORY_STATUSES,
  ingestionJobs,
  isEmptyJsTsRepository,
  repositories,
  type EmbeddingStatus,
  type IngestionJobRecord,
  type NewIngestionJobRecord,
  type NewRepositoryRecord,
  type RepositoryRecord,
  type RepositoryStatus,
} from './schema.js';
