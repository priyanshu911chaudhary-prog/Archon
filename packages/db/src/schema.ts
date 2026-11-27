import type { EdgeType, NodeType } from '@archon/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const MAX_QUALIFIED_NAME_UTF8_BYTES = 2048 as const;

export const REPOSITORY_STATUSES = [
  'queued',
  'cloning',
  'parsing',
  'building_graph',
  'ready',
  'failed',
  'superseded',
] as const;

export type RepositoryStatus = (typeof REPOSITORY_STATUSES)[number];

export const ACTIVE_REPOSITORY_STATUSES = [
  'queued',
  'cloning',
  'parsing',
  'building_graph',
  'ready',
] as const;

export const TERMINAL_REPOSITORY_STATUSES = ['ready', 'failed', 'superseded'] as const;

export const INGESTION_JOB_STAGES = [
  'queued',
  'cloning',
  'parsing',
  'building_graph',
  'ready',
  'failed',
] as const;

export type IngestionJobStage = (typeof INGESTION_JOB_STAGES)[number];

export const TERMINAL_INGESTION_JOB_STAGES = ['ready', 'failed'] as const;

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
    graphPersistedAt: timestamp('graph_persisted_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'repositories_status_check',
      sql`"status" IN ('queued', 'cloning', 'parsing', 'building_graph', 'ready', 'failed', 'superseded')`,
    ),
    check(
      'repositories_embedding_status_check',
      sql`"embedding_status" IN ('pending', 'processing', 'ready', 'degraded', 'failed')`,
    ),
    check(
      'repositories_graph_persisted_at_check',
      sql`"graph_persisted_at" IS NULL OR "status" = 'ready'`,
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
    stage: text('stage').$type<IngestionJobStage>().notNull(),
    progressPct: integer('progress_pct').notNull().default(0),
    attemptGeneration: integer('attempt_generation').notNull().default(0),
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
    check('ingestion_jobs_attempt_generation_check', sql`"attempt_generation" >= 0`),
    index('idx_ingestion_jobs_repo_created').on(table.repoId, table.createdAt),
  ],
);

export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    nodeType: text('node_type').$type<NodeType>().notNull(),
    name: text('name').notNull(),
    qualifiedName: text('qualified_name').notNull(),
    filePath: text('file_path').notNull(),
    parentNodeId: uuid('parent_node_id'),
    isExported: boolean('is_exported').notNull().default(false),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    contentHash: text('content_hash'),
    snippet: text('snippet'),
  },
  (table) => [
    unique('nodes_repo_id_id_unique').on(table.repoId, table.id),
    unique('nodes_repo_id_qualified_name_unique').on(table.repoId, table.qualifiedName),
    foreignKey({
      name: 'nodes_repo_parent_fk',
      columns: [table.repoId, table.parentNodeId],
      foreignColumns: [table.repoId, table.id],
    }).onDelete('no action'),
    check(
      'nodes_node_type_check',
      sql`"node_type" IN ('folder', 'file', 'function', 'class', 'symbol')`,
    ),
    check(
      'nodes_qualified_name_check',
      sql`octet_length("qualified_name") >= 1 AND octet_length("qualified_name") <= 2048`,
    ),
    check('nodes_no_self_parent_check', sql`"parent_node_id" IS NULL OR "parent_node_id" <> "id"`),
    check(
      'nodes_folder_metadata_check',
      sql`"node_type" <> 'folder' OR ("is_exported" = false AND "start_line" IS NULL AND "end_line" IS NULL AND "content_hash" IS NULL AND "snippet" IS NULL)`,
    ),
    check(
      'nodes_non_folder_metadata_check',
      sql`"node_type" = 'folder' OR ("start_line" IS NOT NULL AND "end_line" IS NOT NULL AND "start_line" >= 1 AND "end_line" >= "start_line" AND "content_hash" IS NOT NULL AND length("content_hash") = 64 AND "content_hash" ~ '^[0-9a-f]{64}$' AND "snippet" IS NOT NULL)`,
    ),
    index('idx_nodes_repo_parent').on(table.repoId, table.parentNodeId),
    index('idx_nodes_repo_type').on(table.repoId, table.nodeType),
  ],
);

export const edges = pgTable(
  'edges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    sourceNodeId: uuid('source_node_id').notNull(),
    targetNodeId: uuid('target_node_id').notNull(),
    edgeType: text('edge_type').$type<EdgeType>().notNull(),
    callSiteLine: integer('call_site_line'),
    callSiteSnippet: text('call_site_snippet'),
  },
  (table) => [
    foreignKey({
      name: 'edges_repo_source_node_fk',
      columns: [table.repoId, table.sourceNodeId],
      foreignColumns: [nodes.repoId, nodes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'edges_repo_target_node_fk',
      columns: [table.repoId, table.targetNodeId],
      foreignColumns: [nodes.repoId, nodes.id],
    }).onDelete('cascade'),
    check('edges_edge_type_check', sql`"edge_type" IN ('IMPORTS', 'CALLS')`),
    check(
      'edges_imports_metadata_check',
      sql`"edge_type" <> 'IMPORTS' OR ("call_site_line" IS NULL AND "call_site_snippet" IS NULL AND "source_node_id" <> "target_node_id")`,
    ),
    check(
      'edges_calls_metadata_check',
      sql`"edge_type" <> 'CALLS' OR ("call_site_line" IS NOT NULL AND "call_site_line" >= 1 AND "call_site_snippet" IS NOT NULL)`,
    ),
    uniqueIndex('idx_edges_unique_imports')
      .on(table.repoId, table.sourceNodeId, table.targetNodeId)
      .where(sql`"edge_type" = 'IMPORTS'`),
    uniqueIndex('idx_edges_unique_calls')
      .on(table.repoId, table.sourceNodeId, table.targetNodeId, table.callSiteLine)
      .where(sql`"edge_type" = 'CALLS'`),
    index('idx_edges_reverse_lookup').on(table.repoId, table.targetNodeId, table.edgeType),
    index('idx_edges_forward_lookup').on(table.repoId, table.sourceNodeId, table.edgeType),
  ],
);

export type RepositoryRecord = typeof repositories.$inferSelect;
export type NewRepositoryRecord = typeof repositories.$inferInsert;
export type IngestionJobRecord = typeof ingestionJobs.$inferSelect;
export type NewIngestionJobRecord = typeof ingestionJobs.$inferInsert;
export type NodeRecord = typeof nodes.$inferSelect;
export type NewNodeRecord = typeof nodes.$inferInsert;
export type EdgeRecord = typeof edges.$inferSelect;
export type NewEdgeRecord = typeof edges.$inferInsert;

/**
 * Derived emptyJsTs indicator (no extra DB column): true when ingestion finished
 * cleanly with a persisted graph (`status === 'ready'`, `graphPersistedAt !== null`)
 * and zero supported TS/JS sources encountered (`fileCount === 0`, including oversized
 * supported sources). General skipped files (e.g., README.md, Python files, or oversized
 * config files) do not disqualify an empty JS/TS repository.
 */
export function isEmptyJsTsRepository(
  repo: Pick<RepositoryRecord, 'status' | 'fileCount'> & {
    readonly graphPersistedAt?: Date | null;
  },
): boolean {
  if (repo.status !== 'ready' || repo.fileCount !== 0) {
    return false;
  }
  return repo.graphPersistedAt === undefined ? true : repo.graphPersistedAt !== null;
}
