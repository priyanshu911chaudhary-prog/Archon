import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '@archon/shared';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPoolConfig,
  createDbClient,
  sanitizeDatabaseTarget,
  type DbClient,
} from './client.js';
import { extractPgErrorInfo } from './errors.js';
import { getMigrationsFolder, runMigrations } from './migrate.js';
import {
  MAX_QUALIFIED_NAME_UTF8_BYTES,
  edges,
  ingestionJobs,
  nodes,
  repositories,
} from './schema.js';

const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';
const PG_FK_VIOLATION = '23503';
const VALID_HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

interface JournalFileShape {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly {
    readonly idx: number;
    readonly version: string;
    readonly when: number;
    readonly tag: string;
    readonly breakpoints: boolean;
  }[];
}

function replaceDatabaseName(databaseUrl: string, newDbName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${newDbName}`;
  return parsed.toString();
}

async function expectPgError(
  operation: () => Promise<unknown>,
  expectedCode: string,
  expectedConstraint?: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await operation();
  } catch (err) {
    caught = err;
  }
  expect(caught).not.toBeNull();
  const info = extractPgErrorInfo(caught);
  expect(info.code).toBe(expectedCode);
  if (expectedConstraint !== undefined) {
    expect(info.constraint).toBe(expectedConstraint);
  }
}

async function createPhase4BaselineMigrationsDir(): Promise<string> {
  const realMigrationsDir = getMigrationsFolder();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'archon-phase4-mig-'));
  const tempMetaDir = path.join(tempDir, 'meta');
  await mkdir(tempMetaDir, { recursive: true });

  await copyFile(
    path.join(realMigrationsDir, '0000_worthless_carmella_unuscione.sql'),
    path.join(tempDir, '0000_worthless_carmella_unuscione.sql'),
  );
  await copyFile(
    path.join(realMigrationsDir, 'meta', '0000_snapshot.json'),
    path.join(tempMetaDir, '0000_snapshot.json'),
  );

  const rawJournal = await readFile(path.join(realMigrationsDir, 'meta', '_journal.json'), 'utf8');
  const parsedJournal = JSON.parse(rawJournal) as JournalFileShape;
  const baselineEntry = parsedJournal.entries.find(
    (entry) => entry.idx === 0 && entry.tag === '0000_worthless_carmella_unuscione',
  );
  if (baselineEntry === undefined) {
    throw new Error('Missing migration 0000 journal entry.');
  }

  const baselineJournal: JournalFileShape = {
    version: parsedJournal.version,
    dialect: parsedJournal.dialect,
    entries: [baselineEntry],
  };
  await writeFile(
    path.join(tempMetaDir, '_journal.json'),
    `${JSON.stringify(baselineJournal, null, 2)}\n`,
    'utf8',
  );

  return tempDir;
}

describe('Graph schema and migrations (PostgreSQL integration)', () => {
  const suffix = randomBytes(6).toString('hex');
  const freshDbName = `archon_schema_fresh_${suffix}`;
  const upgradeDbName = `archon_schema_upgrade_${suffix}`;

  let baseDatabaseUrl = '';
  let adminPool: Pool | undefined;
  let freshClient: DbClient | undefined;
  let upgradeClient: DbClient | undefined;
  let tempBaselineDir: string | undefined;

  async function seedRepo(
    client: DbClient,
    overrides: Partial<typeof repositories.$inferInsert> = {},
  ): Promise<string> {
    const inserted = await client.db
      .insert(repositories)
      .values({
        githubUrl: 'https://github.com/acme/demo',
        owner: 'acme',
        name: `demo-${randomBytes(4).toString('hex')}`,
        defaultBranch: 'main',
        commitSha: randomBytes(20).toString('hex'),
        status: 'building_graph',
        ...overrides,
      })
      .returning({ id: repositories.id });

    const row = inserted[0];
    if (row === undefined) {
      throw new Error('Failed to insert test repository.');
    }
    return row.id;
  }

  beforeAll(async () => {
    const env = loadEnv();
    baseDatabaseUrl = env.DATABASE_URL;
    const target = sanitizeDatabaseTarget(baseDatabaseUrl);
    adminPool = new Pool(buildPoolConfig({ databaseUrl: baseDatabaseUrl, max: 2 }));

    try {
      await adminPool.query('SELECT 1');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`PostgreSQL is unreachable at ${target}. Root cause: ${detail}`, {
        cause: err,
      });
    }

    await adminPool.query(`CREATE DATABASE "${freshDbName}"`);
    freshClient = createDbClient({
      databaseUrl: replaceDatabaseName(baseDatabaseUrl, freshDbName),
      max: 5,
    });
    await runMigrations(freshClient.db);
  });

  afterAll(async () => {
    if (freshClient !== undefined) {
      await freshClient.close();
    }
    if (upgradeClient !== undefined) {
      await upgradeClient.close();
    }
    if (tempBaselineDir !== undefined) {
      await rm(tempBaselineDir, { recursive: true, force: true });
    }
    if (adminPool !== undefined) {
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS "${freshDbName}" WITH (FORCE)`);
        await adminPool.query(`DROP DATABASE IF EXISTS "${upgradeDbName}" WITH (FORCE)`);
      } finally {
        await adminPool.end();
      }
    }
  });

  it('upgrades a populated Phase 4 database cleanly, preserves historical rows, and repeats as a no-op', async () => {
    if (adminPool === undefined) {
      throw new Error('Expected initialized adminPool.');
    }

    await adminPool.query(`CREATE DATABASE "${upgradeDbName}"`);
    upgradeClient = createDbClient({
      databaseUrl: replaceDatabaseName(baseDatabaseUrl, upgradeDbName),
      max: 3,
    });

    tempBaselineDir = await createPhase4BaselineMigrationsDir();
    await runMigrations(upgradeClient.db, tempBaselineDir);

    const migBefore = await upgradeClient.pool.query<{
      readonly hash: string;
      readonly created_at: string;
    }>('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC');
    expect(migBefore.rows).toHaveLength(1);
    const baselineHash = migBefore.rows[0]?.hash;
    expect(baselineHash).toBeDefined();

    // Populate genuine Phase 4 rows (ready + failed) using only Phase 4 columns
    const readyRepoId = randomUUID();
    const failedRepoId = randomUUID();
    const readyJobId = randomUUID();
    const failedJobId = randomUUID();

    await upgradeClient.pool.query(
      `INSERT INTO repositories
        (id, github_url, owner, name, default_branch, commit_sha, status, file_count, size_kb)
       VALUES
        ($1, 'https://github.com/acme/legacy-ready', 'acme', 'legacy-ready', 'main', $2, 'ready', 42, 500),
        ($3, 'https://github.com/acme/legacy-failed', 'acme', 'legacy-failed', 'main', $4, 'failed', 10, 120)`,
      [readyRepoId, 'a'.repeat(40), failedRepoId, 'b'.repeat(40)],
    );

    await upgradeClient.pool.query(
      `INSERT INTO ingestion_jobs
        (id, repo_id, stage, progress_pct, duration_ms, error_detail)
       VALUES
        ($1, $2, 'ready', 100, 1234, NULL),
        ($3, $4, 'failed', 20, 456, 'TARBALL_TIMEOUT')`,
      [readyJobId, readyRepoId, failedJobId, failedRepoId],
    );

    // Upgrade to full Phase 5.2 migration set
    await runMigrations(upgradeClient.db);

    const migAfterUpgrade = await upgradeClient.pool.query<{
      readonly hash: string;
      readonly created_at: string;
    }>('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC');
    expect(migAfterUpgrade.rows).toHaveLength(2);
    expect(migAfterUpgrade.rows[0]?.hash).toBe(baselineHash);

    // Verify historical rows preserved with graph_persisted_at = NULL and attempt_generation = 0
    const [readyRepo] = await upgradeClient.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, readyRepoId));
    expect(readyRepo?.status).toBe('ready');
    expect(readyRepo?.fileCount).toBe(42);
    expect(readyRepo?.graphPersistedAt).toBeNull();

    const [failedRepo] = await upgradeClient.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, failedRepoId));
    expect(failedRepo?.status).toBe('failed');
    expect(failedRepo?.graphPersistedAt).toBeNull();

    const [readyJob] = await upgradeClient.db
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.id, readyJobId));
    expect(readyJob?.stage).toBe('ready');
    expect(readyJob?.attemptGeneration).toBe(0);

    const [failedJob] = await upgradeClient.db
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.id, failedJobId));
    expect(failedJob?.stage).toBe('failed');
    expect(failedJob?.errorDetail).toBe('TARBALL_TIMEOUT');
    expect(failedJob?.attemptGeneration).toBe(0);

    // Repeated migration-runner execution is a clean no-op
    await runMigrations(upgradeClient.db);
    const migAfterRepeat = await upgradeClient.pool.query<{ readonly id: number }>(
      'SELECT id FROM drizzle.__drizzle_migrations',
    );
    expect(migAfterRepeat.rows).toHaveLength(2);
  });

  it('accepts valid nodes, hierarchy, edges, Unicode, exact 2048B boundary, superseded status, and whole-repo cascade delete', async () => {
    if (freshClient === undefined) {
      throw new Error('Expected initialized freshClient.');
    }

    const repoA = await seedRepo(freshClient, {
      status: 'ready',
      graphPersistedAt: new Date('2026-11-27T10:00:00.000Z'),
    });
    const repoB = await seedRepo(freshClient, { status: 'building_graph' });

    // Verify superseded is valid on repositories and excluded from active partial unique index
    const sharedSha = 'c'.repeat(40);
    await seedRepo(freshClient, {
      owner: 'acme',
      name: 'superseded-demo',
      commitSha: sharedSha,
      status: 'superseded',
    });
    const replacementRepoId = await seedRepo(freshClient, {
      owner: 'acme',
      name: 'superseded-demo',
      commitSha: sharedSha,
      status: 'queued',
    });
    expect(replacementRepoId).toBeDefined();

    // Job for repoA to verify cascade deletion covers jobs too
    await freshClient.db.insert(ingestionJobs).values({
      repoId: repoA,
      stage: 'ready',
      progressPct: 100,
      attemptGeneration: 2,
    });

    const folderId = randomUUID();
    const file1Id = randomUUID();
    const file2Id = randomUUID();
    const classId = randomUUID();
    const fnId = randomUUID();
    const symId = randomUUID();
    const boundaryAsciiId = randomUUID();
    const boundaryUnicodeId = randomUUID();

    const exact2048Ascii = 'a'.repeat(MAX_QUALIFIED_NAME_UTF8_BYTES);
    // 512 * 4 UTF-8 bytes = 2048 UTF-8 bytes (1024 UTF-16 code units)
    const exact2048Rocket = '\u{1F680}'.repeat(512);
    expect(Buffer.byteLength(exact2048Ascii, 'utf8')).toBe(2048);
    expect(Buffer.byteLength(exact2048Rocket, 'utf8')).toBe(2048);

    await freshClient.db.insert(nodes).values([
      {
        id: folderId,
        repoId: repoA,
        nodeType: 'folder',
        name: 'src',
        qualifiedName: 'folder:src',
        filePath: 'src',
        parentNodeId: null,
        isExported: false,
        startLine: null,
        endLine: null,
        contentHash: null,
        snippet: null,
      },
      {
        id: file1Id,
        repoId: repoA,
        nodeType: 'file',
        name: 'helper.ts',
        qualifiedName: 'file:src/helper.ts',
        filePath: 'src/helper.ts',
        parentNodeId: folderId,
        isExported: false,
        startLine: 1,
        endLine: 10,
        contentHash: VALID_HASH,
        snippet: 'export function helper() { return "\u{1F680}"; }',
      },
      {
        id: file2Id,
        repoId: repoA,
        nodeType: 'file',
        name: 'index.ts',
        qualifiedName: 'file:src/index.ts',
        filePath: 'src/index.ts',
        parentNodeId: folderId,
        isExported: false,
        startLine: 1,
        endLine: 20,
        contentHash: VALID_HASH,
        snippet: '',
      },
      {
        id: classId,
        repoId: repoA,
        nodeType: 'class',
        name: 'Runner',
        qualifiedName: 'src/index.ts::class:Runner',
        filePath: 'src/index.ts',
        parentNodeId: file2Id,
        isExported: true,
        startLine: 2,
        endLine: 15,
        contentHash: VALID_HASH,
        snippet: 'export class Runner {}',
      },
      {
        id: fnId,
        repoId: repoA,
        nodeType: 'function',
        name: 'run',
        qualifiedName: 'src/index.ts::class:Runner::method:run',
        filePath: 'src/index.ts',
        parentNodeId: classId,
        isExported: false,
        startLine: 4,
        endLine: 12,
        contentHash: VALID_HASH,
        snippet: 'run() { return this.run(); }',
      },
      {
        id: symId,
        repoId: repoA,
        nodeType: 'symbol',
        name: 'Rocket\u{1F680}',
        qualifiedName: 'src/helper.ts::sym:Rocket\u{1F680}',
        filePath: 'src/helper.ts',
        parentNodeId: file1Id,
        isExported: true,
        startLine: 8,
        endLine: 8,
        contentHash: VALID_HASH,
        snippet: 'export const Rocket = "\u{1F680}";',
      },
      {
        id: boundaryAsciiId,
        repoId: repoA,
        nodeType: 'symbol',
        name: 'maxAscii',
        qualifiedName: exact2048Ascii,
        filePath: 'src/helper.ts',
        parentNodeId: file1Id,
        isExported: true,
        startLine: 9,
        endLine: 9,
        contentHash: VALID_HASH,
        snippet: 'export const maxAscii = 1;',
      },
      {
        id: boundaryUnicodeId,
        repoId: repoA,
        nodeType: 'symbol',
        name: 'maxUnicode',
        qualifiedName: exact2048Rocket,
        filePath: 'src/helper.ts',
        parentNodeId: file1Id,
        isExported: true,
        startLine: 10,
        endLine: 10,
        contentHash: VALID_HASH,
        snippet: 'export const maxUnicode = "\u{1F680}";',
      },
    ]);

    // Identical qualified_name in a different repository must succeed
    const repoBFolderId = randomUUID();
    await freshClient.db.insert(nodes).values({
      id: repoBFolderId,
      repoId: repoB,
      nodeType: 'folder',
      name: 'src',
      qualifiedName: 'folder:src',
      filePath: 'src',
      parentNodeId: null,
      isExported: false,
      startLine: null,
      endLine: null,
      contentHash: null,
      snippet: null,
    });

    // Valid IMPORTS, CALLS at different lines, and recursive CALLS
    await freshClient.db.insert(edges).values([
      {
        repoId: repoA,
        sourceNodeId: file2Id,
        targetNodeId: file1Id,
        edgeType: 'IMPORTS',
        callSiteLine: null,
        callSiteSnippet: null,
      },
      {
        repoId: repoA,
        sourceNodeId: fnId,
        targetNodeId: symId,
        edgeType: 'CALLS',
        callSiteLine: 5,
        callSiteSnippet: 'Rocket()',
      },
      {
        repoId: repoA,
        sourceNodeId: fnId,
        targetNodeId: symId,
        edgeType: 'CALLS',
        callSiteLine: 9,
        callSiteSnippet: 'Rocket()',
      },
      {
        repoId: repoA,
        sourceNodeId: fnId,
        targetNodeId: fnId,
        edgeType: 'CALLS',
        callSiteLine: 10,
        callSiteSnippet: 'this.run()',
      },
    ]);

    // Whole-repository cascade delete must remove jobs, edges, and multi-level node hierarchy
    await freshClient.db.delete(repositories).where(eq(repositories.id, repoA));

    expect(await freshClient.db.select().from(nodes).where(eq(nodes.repoId, repoA))).toHaveLength(
      0,
    );
    expect(await freshClient.db.select().from(edges).where(eq(edges.repoId, repoA))).toHaveLength(
      0,
    );
    expect(
      await freshClient.db.select().from(ingestionJobs).where(eq(ingestionJobs.repoId, repoA)),
    ).toHaveLength(0);

    // Repo B remains completely intact
    expect(await freshClient.db.select().from(nodes).where(eq(nodes.repoId, repoB))).toHaveLength(
      1,
    );
  });

  it('rejects all invalid repository, job, node, and edge states via PostgreSQL constraints', async () => {
    if (freshClient === undefined) {
      throw new Error('Expected initialized freshClient.');
    }
    const pool = freshClient.pool;
    const repoA = await seedRepo(freshClient, { status: 'building_graph' });
    const repoB = await seedRepo(freshClient, { status: 'building_graph' });

    const nodeA1 = randomUUID();
    const nodeA2 = randomUUID();
    const nodeB1 = randomUUID();

    await freshClient.db.insert(nodes).values([
      {
        id: nodeA1,
        repoId: repoA,
        nodeType: 'file',
        name: 'a1.ts',
        qualifiedName: 'file:a1.ts',
        filePath: 'a1.ts',
        parentNodeId: null,
        isExported: false,
        startLine: 1,
        endLine: 5,
        contentHash: VALID_HASH,
        snippet: 'export const a1 = 1;',
      },
      {
        id: nodeA2,
        repoId: repoA,
        nodeType: 'file',
        name: 'a2.ts',
        qualifiedName: 'file:a2.ts',
        filePath: 'a2.ts',
        parentNodeId: null,
        isExported: false,
        startLine: 1,
        endLine: 5,
        contentHash: VALID_HASH,
        snippet: 'export const a2 = 2;',
      },
      {
        id: nodeB1,
        repoId: repoB,
        nodeType: 'file',
        name: 'b1.ts',
        qualifiedName: 'file:b1.ts',
        filePath: 'b1.ts',
        parentNodeId: null,
        isExported: false,
        startLine: 1,
        endLine: 5,
        contentHash: VALID_HASH,
        snippet: 'export const b1 = 1;',
      },
    ]);

    // 1. Published timestamp on non-ready repository
    for (const nonReadyStatus of ['queued', 'building_graph', 'failed', 'superseded']) {
      await expectPgError(
        () =>
          pool.query(
            `INSERT INTO repositories
              (github_url, owner, name, default_branch, commit_sha, status, graph_persisted_at)
             VALUES ('https://github.com/acme/bad', 'acme', $1, 'main', $2, $3, now())`,
            [`bad-${nonReadyStatus}`, randomBytes(20).toString('hex'), nonReadyStatus],
          ),
        PG_CHECK_VIOLATION,
        'repositories_graph_persisted_at_check',
      );
    }

    // 2. Superseded is NOT permitted as an ingestion_jobs.stage
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO ingestion_jobs (repo_id, stage, progress_pct) VALUES ($1, 'superseded', 100)`,
          [repoA],
        ),
      PG_CHECK_VIOLATION,
      'ingestion_jobs_stage_check',
    );

    // 3. Negative attempt_generation
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO ingestion_jobs (repo_id, stage, progress_pct, attempt_generation)
           VALUES ($1, 'queued', 0, -1)`,
          [repoA],
        ),
      PG_CHECK_VIOLATION,
      'ingestion_jobs_attempt_generation_check',
    );

    // 4. Duplicate qualified_name within one repository
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO nodes
            (repo_id, node_type, name, qualified_name, file_path, is_exported, start_line, end_line, content_hash, snippet)
           VALUES ($1, 'file', 'dup.ts', 'file:a1.ts', 'dup.ts', false, 1, 1, $2, '')`,
          [repoA, VALID_HASH],
        ),
      PG_UNIQUE_VIOLATION,
      'nodes_repo_id_qualified_name_unique',
    );

    // 5. Empty qualified_name and qualified_name > 2048 UTF-8 bytes (ASCII + multi-byte)
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO nodes
            (repo_id, node_type, name, qualified_name, file_path, is_exported, start_line, end_line, content_hash, snippet)
           VALUES ($1, 'file', 'empty.ts', '', 'empty.ts', false, 1, 1, $2, '')`,
          [repoA, VALID_HASH],
        ),
      PG_CHECK_VIOLATION,
      'nodes_qualified_name_check',
    );

    for (const oversizedQn of ['a'.repeat(2049), '\u{1F680}'.repeat(513)]) {
      await expectPgError(
        () =>
          pool.query(
            `INSERT INTO nodes
              (repo_id, node_type, name, qualified_name, file_path, is_exported, start_line, end_line, content_hash, snippet)
             VALUES ($1, 'symbol', 'big', $2, 'a1.ts', true, 1, 1, $3, 'x')`,
            [repoA, oversizedQn, VALID_HASH],
          ),
        PG_CHECK_VIOLATION,
        'nodes_qualified_name_check',
      );
    }

    // 6. Invalid node_type and edge_type
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO nodes
            (repo_id, node_type, name, qualified_name, file_path, is_exported, start_line, end_line, content_hash, snippet)
           VALUES ($1, 'module', 'm', 'mod:m', 'm.ts', false, 1, 1, $2, 'x')`,
          [repoA, VALID_HASH],
        ),
      PG_CHECK_VIOLATION,
      'nodes_node_type_check',
    );

    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type)
           VALUES ($1, $2, $3, 'EXTENDS')`,
          [repoA, nodeA1, nodeA2],
        ),
      PG_CHECK_VIOLATION,
      'edges_edge_type_check',
    );

    // 7. Invalid folder metadata (exported, start_line, end_line, content_hash, snippet)
    const invalidFolderCases: readonly (readonly [
      boolean,
      number | null,
      number | null,
      string | null,
      string | null,
    ])[] = [
      [true, null, null, null, null],
      [false, 1, null, null, null],
      [false, null, 1, null, null],
      [false, null, null, VALID_HASH, null],
      [false, null, null, null, ''],
    ];
    for (let i = 0; i < invalidFolderCases.length; i += 1) {
      const tuple = invalidFolderCases[i];
      if (tuple === undefined) {
        continue;
      }
      await expectPgError(
        () =>
          pool.query(
            `INSERT INTO nodes
              (repo_id, node_type, name, qualified_name, file_path, is_exported, start_line, end_line, content_hash, snippet)
             VALUES ($1, 'folder', 'bad', $2, 'bad', $3, $4, $5, $6, $7)`,
            [repoA, `folder:bad-${String(i)}`, tuple[0], tuple[1], tuple[2], tuple[3], tuple[4]],
          ),
        PG_CHECK_VIOLATION,
        'nodes_folder_metadata_check',
      );
    }

    // 8. Missing non-folder metadata, invalid line ranges, and invalid content hashes
    const invalidNonFolderCases: readonly (readonly [
      number | null,
      number | null,
      string | null,
      string | null,
    ])[] = [
      [null, 5, VALID_HASH, 'x'],
      [1, null, VALID_HASH, 'x'],
      [1, 5, null, 'x'],
      [1, 5, VALID_HASH, null],
      [0, 5, VALID_HASH, 'x'],
      [5, 4, VALID_HASH, 'x'],
      [1, 5, 'A'.repeat(64), 'x'],
      [1, 5, 'a'.repeat(63), 'x'],
      [1, 5, 'g'.repeat(64), 'x'],
    ];
    for (let i = 0; i < invalidNonFolderCases.length; i += 1) {
      const tuple = invalidNonFolderCases[i];
      if (tuple === undefined) {
        continue;
      }
      await expectPgError(
        () =>
          pool.query(
            `INSERT INTO nodes
              (repo_id, node_type, name, qualified_name, file_path, is_exported, start_line, end_line, content_hash, snippet)
             VALUES ($1, 'function', 'badFn', $2, 'a1.ts', false, $3, $4, $5, $6)`,
            [repoA, `a1.ts::fn:bad-${String(i)}`, tuple[0], tuple[1], tuple[2], tuple[3]],
          ),
        PG_CHECK_VIOLATION,
        'nodes_non_folder_metadata_check',
      );
    }

    // 9. Self-parenting
    const selfId = randomUUID();
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO nodes
            (id, repo_id, node_type, name, qualified_name, file_path, parent_node_id, is_exported)
           VALUES ($1, $2, 'folder', 'self', 'folder:self', 'self', $1, false)`,
          [selfId, repoA],
        ),
      PG_CHECK_VIOLATION,
      'nodes_no_self_parent_check',
    );

    // 10. Cross-repository parent relationship
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO nodes
            (repo_id, node_type, name, qualified_name, file_path, parent_node_id, is_exported, start_line, end_line, content_hash, snippet)
           VALUES ($1, 'file', 'cross.ts', 'file:cross.ts', 'cross.ts', $2, false, 1, 1, $3, 'x')`,
          [repoA, nodeB1, VALID_HASH],
        ),
      PG_FK_VIOLATION,
      'nodes_repo_parent_fk',
    );

    // 11. Cross-repository source and target endpoints (tested independently)
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type)
           VALUES ($1, $2, $3, 'IMPORTS')`,
          [repoA, nodeB1, nodeA1],
        ),
      PG_FK_VIOLATION,
      'edges_repo_source_node_fk',
    );

    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type)
           VALUES ($1, $2, $3, 'IMPORTS')`,
          [repoA, nodeA1, nodeB1],
        ),
      PG_FK_VIOLATION,
      'edges_repo_target_node_fk',
    );

    // 12. IMPORTS invalid metadata, self-IMPORTS, and duplicate IMPORTS
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type, call_site_line)
           VALUES ($1, $2, $3, 'IMPORTS', 1)`,
          [repoA, nodeA1, nodeA2],
        ),
      PG_CHECK_VIOLATION,
      'edges_imports_metadata_check',
    );

    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type, call_site_snippet)
           VALUES ($1, $2, $3, 'IMPORTS', 'import x')`,
          [repoA, nodeA1, nodeA2],
        ),
      PG_CHECK_VIOLATION,
      'edges_imports_metadata_check',
    );

    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type)
           VALUES ($1, $2, $2, 'IMPORTS')`,
          [repoA, nodeA1],
        ),
      PG_CHECK_VIOLATION,
      'edges_imports_metadata_check',
    );

    await pool.query(
      `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type)
       VALUES ($1, $2, $3, 'IMPORTS')`,
      [repoA, nodeA1, nodeA2],
    );
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type)
           VALUES ($1, $2, $3, 'IMPORTS')`,
          [repoA, nodeA1, nodeA2],
        ),
      PG_UNIQUE_VIOLATION,
      'idx_edges_unique_imports',
    );

    // 13. CALLS with NULL line, nonpositive line, NULL snippet, and duplicate same-line CALLS
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type, call_site_line, call_site_snippet)
           VALUES ($1, $2, $3, 'CALLS', NULL, 'fn()')`,
          [repoA, nodeA1, nodeA2],
        ),
      PG_CHECK_VIOLATION,
      'edges_calls_metadata_check',
    );

    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type, call_site_line, call_site_snippet)
           VALUES ($1, $2, $3, 'CALLS', 0, 'fn()')`,
          [repoA, nodeA1, nodeA2],
        ),
      PG_CHECK_VIOLATION,
      'edges_calls_metadata_check',
    );

    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type, call_site_line, call_site_snippet)
           VALUES ($1, $2, $3, 'CALLS', 3, NULL)`,
          [repoA, nodeA1, nodeA2],
        ),
      PG_CHECK_VIOLATION,
      'edges_calls_metadata_check',
    );

    await pool.query(
      `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type, call_site_line, call_site_snippet)
       VALUES ($1, $2, $3, 'CALLS', 7, 'a2()')`,
      [repoA, nodeA1, nodeA2],
    );
    await expectPgError(
      () =>
        pool.query(
          `INSERT INTO edges (repo_id, source_node_id, target_node_id, edge_type, call_site_line, call_site_snippet)
           VALUES ($1, $2, $3, 'CALLS', 7, 'a2()')`,
          [repoA, nodeA1, nodeA2],
        ),
      PG_UNIQUE_VIOLATION,
      'idx_edges_unique_calls',
    );
  });
});
