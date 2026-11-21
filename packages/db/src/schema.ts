import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const REPOSITORY_STATUSES = [
  'queued',
  'cloning',
  'parsing',
  'building_graph',
  'ready',
  'failed',
] as const;

export type RepositoryStatus = (typeof REPOSITORY_STATUSES)[number];

export const ACTIVE_REPOSITORY_STATUSES = [
  'queued',
  'cloning',
  'parsing',
  'building_graph',
  'ready',
] as const;

export const TERMINAL_REPOSITORY_STATUSES = ['ready', 'failed'] as const;

export const EMBEDDING_STATUSES = ['pending', 'processing', 'ready', 'degraded', 'failed'] as const;

export type EmbeddingStatus = (typeof EMBEDDING_STATUSES)[number];

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    githubUrl: text('github_url').notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch').notNull(),
    commitSha: text('commit_sha').notNull(),
    status: text('status').$type<RepositoryStatus>().notNull(),
    embeddingStatus: text('embedding_status').$type<EmbeddingStatus>().notNull().default('pending'),
    isSample: boolean('is_sample').notNull().default(false),
    fileCount: integer('file_count').notNull().default(0),
    skippedFilesCount: integer('skipped_files_count').notNull().default(0),
    sizeKb: integer('size_kb').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'repositories_status_check',
      sql`"status" IN ('queued', 'cloning', 'parsing', 'building_graph', 'ready', 'failed')`,
    ),
    check(
      'repositories_embedding_status_check',
      sql`"embedding_status" IN ('pending', 'processing', 'ready', 'degraded', 'failed')`,
    ),
    uniqueIndex('idx_repos_active_owner_name_sha')
      .on(table.owner, table.name, table.commitSha)
      .where(sql`"status" IN ('queued', 'cloning', 'parsing', 'building_graph', 'ready')`),
  ],
);

export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    bullmqJobId: text('bullmq_job_id'),
    stage: text('stage').$type<RepositoryStatus>().notNull(),
    progressPct: integer('progress_pct').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    errorDetail: text('error_detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'ingestion_jobs_stage_check',
      sql`"stage" IN ('queued', 'cloning', 'parsing', 'building_graph', 'ready', 'failed')`,
    ),
    check('ingestion_jobs_progress_pct_check', sql`"progress_pct" >= 0 AND "progress_pct" <= 100`),
    index('idx_ingestion_jobs_repo_created').on(table.repoId, table.createdAt),
  ],
);

export type RepositoryRecord = typeof repositories.$inferSelect;
export type NewRepositoryRecord = typeof repositories.$inferInsert;
export type IngestionJobRecord = typeof ingestionJobs.$inferSelect;
export type NewIngestionJobRecord = typeof ingestionJobs.$inferInsert;

/**
 * Derived emptyJsTs indicator (no extra DB column): true when ingestion finished
 * cleanly with zero supported TS/JS files (e.g. a 100% Python repo).
 */
export function isEmptyJsTsRepository(
  repo: Pick<RepositoryRecord, 'status' | 'fileCount'>,
): boolean {
  return repo.status === 'ready' && repo.fileCount === 0;
}
