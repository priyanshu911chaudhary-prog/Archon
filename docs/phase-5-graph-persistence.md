# Phase 5: Atomic Graph Persistence, Ownership Fencing and Resource Validation

Phase 5 replaces the Phase 4 no-op handoff and separate `ready` transition with atomic PostgreSQL graph persistence, delivery-generation ownership fencing, legacy-ready recovery, hardened expiration safety, authoritative file/skip count accounting, and constrained Linux resource validation.

This report summarizes implementation and audited evidence through commit `f47877d169e6e44623f176965700e7bcc790f31d` on `feat/phase-5-graph-persistence`. Raw benchmark records, container logs, tarballs, and external controllers remain outside Git.

## Phase 5 Commits

- `81f644d` — `feat(db): add graph nodes and edges schema and migration`
- `1a10450` — `test(worker): verify BullMQ delivery generation across retries and stalls`
- `7a37ebd` — `feat(db): fence ingestion mutations by delivery generation`
- `e0712b3` — `feat(db): recover legacy repositories and protect graph expiry`
- `61ce104` — `feat(db): persist repository graphs atomically`
- `f47877d` — `fix(ingestion): harden graph publication and file accounting`

## 1. Schema and Migrations

Committed PostgreSQL migrations in `packages/db/drizzle/`:

- `0000_worthless_carmella_unuscione.sql` — `repositories`, `ingestion_jobs`, status/progress checks, cascade FK, and `idx_repos_active_owner_name_sha`.
- `0001_faithful_molly_hayes.sql` — adds `repositories.graph_persisted_at` (`"graph_persisted_at" IS NULL OR "status" = 'ready'`), `ingestion_jobs.attempt_generation >= 0`, `nodes`, and `edges`:
  - `nodes`: `repo_id` cascade FK, unique `(repo_id, id)` and `(repo_id, qualified_name)`, composite parent FK `nodes_repo_parent_fk (repo_id, parent_node_id) -> nodes (repo_id, id)` (`ON DELETE NO ACTION`), `octet_length(qualified_name)` in `1..2048` UTF-8 bytes, no-self-parent check, strict folder vs. non-folder metadata checks (`start_line`, `end_line`, 64-char lowercase SHA-256 `content_hash`, non-null `snippet`), and parent/type indexes.
  - `edges`: `repo_id` cascade FK, composite source/target FKs (`ON DELETE CASCADE`), `IMPORTS` vs. `CALLS` metadata checks (rejecting self-imports while allowing recursive `CALLS`), partial unique indexes `idx_edges_unique_imports` and `idx_edges_unique_calls`, and forward/reverse traversal indexes.

## 2. Ownership Fencing, Legacy Recovery and Expiration Safety

- **Mandatory ownership fencing (`packages/db/src/repository.ts`, `apps/worker/src/processor.ts`):** Workers capture BullMQ `job.attemptsStarted` (ownership generation) and `job.id` synchronously before any `await`, keeping `attemptsStarted` distinct from 0-indexed `attemptsMade` (retry exhaustion). Every worker mutation requires a committed `IngestionAttemptOwnership` token under repository-first row locking (`repositories -> ingestion_jobs`) and PG 17 bounded transactions (`lock_timeout`, `statement_timeout`, `transaction_timeout`; defaults `3s/5s/10s`, publication `5s/15s/45s`). No unfenced worker fallback exists.
- **Claim, transitions, and `NOWAIT` heartbeats:** `claimIngestionAttempt` enforces `incomingGeneration > storedGeneration`, validates UUIDs/SHA/`bullmqJobId === jobId`, backfills nullable `bullmq_job_id`, and rejects stale/terminal/mismatched claims without mutation. `transitionJobStage` excludes `'ready'`, rechecks locked ownership, and generates fresh post-lock timestamps in production. `touchJobHeartbeat` uses `NOWAIT` locking returning `updated`, `busy` (strictly clean `55P03` via `isBusyLockContentionError`), `ownership_lost`, `terminal`, or `missing`; ownership loss cancels only the obsolete job via a per-job `AbortController`.
- **Enqueue safety and bounded sweeper:** `failQueuedJobOnEnqueueError` permits pre-claim failure only at `status = 'queued'`, `stage = 'queued'`, `attempt_generation = 0`. In `apps/api/src/services/ingestion-service.ts`, Redis enqueue and `attachBullMqJobId` run in separate `try/catch` blocks so DB attachment failures never mark accepted jobs failed, and raw DB/Redis errors are never logged or leaked on API error causes. `sweepStaleJobs` uses cursor-paginated `FOR UPDATE SKIP LOCKED` batches bounded by `batchSize`, `maxBatches`, and `maxDurationMs`, leaving historical terminal jobs untouched.
- **Legacy-ready recovery and expiration (`e0712b3`):** Rows with `status = 'ready'` and `graph_persisted_at IS NULL` cannot bypass recovery via early API reuse or expiry extension; `createOrGetActive` and `createOrGetVerifiedEmpty` atomically mark them `superseded` under row lock and create a fresh replacement while preserving historical records and retained `is_sample = true` / `expires_at = NULL` identity across public retries. `createOrGetVerifiedEmpty` atomically persists empty graphs without backfilling legacy rows. `deleteExpiredRepositories` deletes only non-sample **terminal** rows in bounded `SKIP LOCKED` batches, preserving cascading deletes of jobs, nodes, and edges.

## 3. Atomic Graph Publication, COMMIT Reconciliation and Count Invariants

- **Pre-transaction validation and batching (`packages/db/src/graph-persistence.ts`):** `prepareGraphPersistencePlan` validates `AnalysisOutput` in-place (without cloning): unique `qualifiedName`, `1..2048` UTF-8 bytes, NUL/unpaired-surrogate rejection on identity fields, NUL rejection + `toWellFormed()` normalization on snippets, iterative parent-before-child ordering and cycle detection, edge uniqueness/metadata, and full `validateAnalysisGraph` stats/warning checks. Preallocated node/edge rows are split into bounded batches (`<= 200` nodes, `<= 500` edges, `<= 1 MiB` UTF-8 variable-data budget, rejecting oversized singleton records).
- **Single-transaction publication (`publishRepositoryGraph`):** Requires locked ownership and `building_graph` stage on both rows, inserts all node and edge batches while checking cooperative `AbortSignal` between batches and before the transaction callback returns, writes authoritative file/skip counts, sets `graph_persisted_at`, and transitions repository and job to `ready` with enforced `progress_pct = 100`. Both standalone (`apps/worker/src/worker.ts`) and embedded (`apps/api/src/server.ts`) workers execute unconditional atomic publication; `noopAnalysisResultHandoff` is removed from production wiring and `@archon/worker` exports.
- **Uncertain COMMIT reconciliation (`reconcilePublishedAttempt`):** On uncertain DB errors (`08007`, `40003`, `25P04`, connection drop), the processor acquires repository-first locks requiring exact stored `bullmq_job_id` identity: `published_by_owner` exits cleanly as succeeded; `ownership_lost`/`terminal`/`missing`/`identity_mismatch` exits cleanly without overwriting newer state; `still_owned_unpublished` confirms rollback (retrying or marking fenced `failed` on final attempt); failed reconciliation preserves non-terminal state without error-message equality checks.
- **File and skip count invariants (`f47877d`):** `github-tarball.ts` tracks `oversizedSupportedFilesCount` separately from general skips and oversized configs. `publishRepositoryGraph` requires `extractionStats: PublicationExtractionStats`, and `resolvePublicationCounts` validates parser stats against `extractionStats.supportedFilesCount` (rejecting over-reporting or unaccounted drops instead of masking via `Math.max()`):
  - `fileCount = extractionStats.supportedFilesCount + extractionStats.oversizedSupportedFilesCount`
  - `skippedFilesCount = extractionStats.skippedFilesCount + (extractionStats.supportedFilesCount - output.stats.parsedFilesCount)`
  - `isEmptyJsTsRepository` derives `emptyJsTs` from `status === 'ready'`, `graphPersistedAt !== null`, and `fileCount === 0`, cleanly distinguishing genuinely empty JS/TS repos from all-oversized or all-syntax-invalid repos.

## 4. Automated Verification Baseline (`f47877d`)

- **Unit tests (`npx vitest run`):** 319 passed across 35 suites.
- **Integration tests (`vitest.integration.config.ts`):** 37 passed across 7 real PostgreSQL 17 + Redis 7 suites (`schema`, `repository`, `ownership`, `legacy-recovery`, `graph-persistence`, `worker`, `bullmq-delivery`).
- **Total:** **356 passing tests across 42 suites**, with `format:check`, `typecheck`, `build`, strict `lint` (`--max-warnings=0`), and `git diff --check` green.

## 5. Phase 5.6 Resource Benchmark and Persistence Parity

- **Image & runtime:** `archon-phase56-bench:f47877d-20261127-230834` (`sha256:f096075d18b77b37b2c9d7a5ec5b13ee1d5bfae2a5e6711413201ba3df1abe0d`), base `node:24.14.0-bookworm-slim`, Node `v24.14.0` (`linux/x64`), Docker Desktop WSL2, cgroup v2 `memory.max = 536,870,912` bytes (`512.00 MiB`), `memory.swap.max = 0`, `--pids-limit=256`.
- **Measured scope:** One persistent standalone worker container executing local mounted tarball extraction, isolated `parser-child.js`, graph planning, and atomic PostgreSQL publication across 11 sequential jobs (3 cycles × 3 frozen repos + 2 runs of a deterministic 480-file synthetic stress workload). PostgreSQL (`archon-postgres`), Redis (`archon-redis` DB 15), controller, DB parity scoring, and evidence storage stayed external to the measured cgroup.

### Cgroup Memory Summary

| Metric                                                  |                                  Observed Result |
| :------------------------------------------------------ | -----------------------------------------------: |
| Kernel `memory.max` / `memory.swap.max`                 |         `536,870,912` bytes (`512.00 MiB`) / `0` |
| Startup idle `memory.current`                           |                 `47,755,264` bytes (`45.54 MiB`) |
| Session kernel `memory.peak` (pre-shutdown)             | **`221,368,320` bytes (`211.11 MiB`, `41.23%`)** |
| Final idle `memory.current` (after 11 jobs + 2s settle) |                `100,966,400` bytes (`96.29 MiB`) |
| Observed idle delta (final − startup)                   |           **`+53,211,136` bytes (`+50.75 MiB`)** |
| Kernel `memory.events` (`oom` / `oom_kill` / `max`)     |            `0 / 0 / 0` across all 24 checkpoints |
| Graceful `SIGTERM` exit code / `OOMKilled`              |                                    `0` / `false` |
| Phase 4 integrated smoke peak (different scope)         |               `194.95 MiB` (`204,419,072` bytes) |

### Per-Run Results (9 Frozen Real + 2 Synthetic 480-File Stress Runs)

|   # | Workload (Commit)                           | Cycle | Nodes | Edges | Files/Skip | Batches (N/E) | Parser (ms) | Publish (ms) | E2E (ms) | Post-Job Current (MiB) | Cumulative Peak (MiB) | Verification     |
| --: | :------------------------------------------ | ----: | ----: | ----: | :--------: | :-----------: | ----------: | -----------: | -------: | ---------------------: | --------------------: | :--------------- |
|   1 | `zustand` (`9fed2eb2`)                      |     1 |   170 |   696 |   49/90    |      1/2      |      1538.1 |         70.0 |   1746.5 |                  55.54 |                186.80 | Exact projection |
|   2 | `nextjs-subscription-payments` (`bdd08132`) |     1 |   187 |   275 |   56/32    |      1/1      |       840.3 |         48.0 |    967.4 |                  57.49 |                186.80 | Exact projection |
|   3 | `taxonomy` (`298a8857`)                     |     1 |   500 |   635 |   129/57   |      3/2      |      1128.5 |         93.8 |   1338.5 |                  65.12 |                186.80 | Exact projection |
|   4 | `zustand` (`9fed2eb2`)                      |     2 |   170 |   696 |   49/90    |      1/2      |      1572.6 |         73.3 |   1725.7 |                  65.43 |                199.35 | Exact projection |
|   5 | `nextjs-subscription-payments` (`bdd08132`) |     2 |   187 |   275 |   56/32    |      1/1      |       768.7 |         36.1 |    871.4 |                  67.73 |                199.35 | Exact projection |
|   6 | `taxonomy` (`298a8857`)                     |     2 |   500 |   635 |   129/57   |      3/2      |      1020.0 |         93.9 |   1230.9 |                  65.85 |                199.35 | Exact projection |
|   7 | `zustand` (`9fed2eb2`)                      |     3 |   170 |   696 |   49/90    |      1/2      |      1474.4 |         55.7 |   1615.6 |                  68.19 |                199.35 | Exact projection |
|   8 | `nextjs-subscription-payments` (`bdd08132`) |     3 |   187 |   275 |   56/32    |      1/1      |       743.9 |         40.6 |    849.0 |                  69.86 |                199.35 | Exact projection |
|   9 | `taxonomy` (`298a8857`)                     |     3 |   500 |   635 |   129/57   |      3/2      |      1087.9 |         83.1 |   1274.8 |                  71.64 |                199.35 | Exact projection |
|  10 | `synthetic-stress-480` (`55555555`)         |     1 | 2,897 | 3,252 |   480/1    |     15/7      |      1257.9 |        392.8 |   1847.2 |                  87.34 |                210.59 | Repeat baseline  |
|  11 | `synthetic-stress-480` (`55555555`)         |     2 | 2,897 | 3,252 |   480/1    |     15/7      |      1182.9 |        392.8 |   1765.4 |                  96.28 |                211.11 | Identical repeat |

### Verified Persistence-Only Projection Digests (`archon-persisted-graph-projection-v1`)

Persisted `nodes` and `edges` rows were independently reconstructed from PostgreSQL (resolving parent/endpoint UUIDs to `qualified_name`) and compared as a deterministic persistence-only projection (10 node columns, 5 edge columns) against the Phase 4 Linux reference `graph-output-iter1.json` files (`run1-zustand-without-lib`, `run3-nextjs-subscription-payments-without-lib`, `run5-taxonomy-without-lib`), without fabricating `warnings`/`stats` or claiming full `computeGraphOutputDigest` equality:

- `pmndrs/zustand` (`9fed2eb2f3af672da9f7bf694b996df3831fc207`): `e79e61e5e88e9ae5c274271eeeccf5f2a637f8518cc04332537d608d51cfd5e0` (3/3 exact match)
- `vercel/nextjs-subscription-payments` (`bdd0813206e47e6b218d42f15a7976c8a0d3c3eb`): `cb9dec6ebe1415172bf4c1c1da15b0f5c5c2bd8b3c9afeb695e13c14763047a8` (3/3 exact match)
- `shadcn-ui/taxonomy` (`298a8857c7128a0d121e7f699dfd729f23b3966d`): `b461abd2522cbe61c4548c4c865c603be38a4fdb996bef133ffd1d34379b593c` (3/3 exact match)
- `archon-bench/synthetic-stress-480` (`5555555555555555555555555555555555555555`): `966f501af5d71cb0fbcf96acb333b39cf9e07bf483198d3e2c370cdec022a8bd` (2/2 identical repeat determinism only)

### Independent Audit, Cleanup and Preserved External Evidence Hashes

All 12 read-only audit checks passed: 11/11 repos persisted ready, 11/11 DB jobs valid (`ready`, `100%`, generation `1`, `bullmq_job_id = id`, `error_detail IS NULL`), **8,365 nodes** and **11,322 edges** with zero duplicate/dangling rows, BullMQ `11 completed / 0 failed`, `0` leftover workspaces, `container-stderr.log` empty (`0` bytes), sanitized inspect with env keys only, and non-forced verified cleanup (`archon-p56-worker-92329eaf40` stopped/removed, Redis DB 15 prefix `archon_p56_92329eaf40` obliterated with `0` remaining keys, isolated DB `archon_p56_bench_92329eaf40` dropped after confirming `0` active backends). The audit compared parsed `runs/*.json` records against `benchmark-report.json`'s `runs` array via serialized JSON structural comparison (not raw file byte-for-byte equality).

External directory (outside Git): `C:\dev\archon-eval\results\phase-5-6-persistence-bench-rerun-20261127-231642\` (reusing image/workloads from `C:\dev\archon-eval\results\phase-5-6-persistence-bench-20261127-230834\`; harness at `C:\dev\archon-eval\linux-bench-scripts\phase-5-6\`):

| External Artifact                                                                         |  Bytes | SHA-256                                                            |
| :---------------------------------------------------------------------------------------- | -----: | :----------------------------------------------------------------- |
| `benchmark-report.json`                                                                   | 64,985 | `e5e1c55adc2c4812aa09bb1ce09aff9bf179a7189204dbe97e0a3d949ffd9e93` |
| `benchmark-report.md`                                                                     |  4,867 | `8a79ad515bb254529619564f9bb5a84b142df6529fd2ff1efed80f39b404e238` |
| `pre-cleanup-audit.json`                                                                  |  2,121 | `8442938e8fe8801cbb22e0ebaee310233ecc4ab047d0f41713f42f3f7fe43190` |
| `cleanup-record.json`                                                                     |    630 | `54ba987a694d12f7a5f748653135d109b7e4573719c47c0806164bb87459771a` |
| `rerun-provenance.json`                                                                   |    890 | `15d74da59be1b783d16d486cc83e6f1ba596ec13fce97cc2dfd331835b225e4a` |
| `container-inspect-sanitized.json`                                                        |    789 | `0529b1ff89202099d09628e37bc8c0558d139535759de1a19c4c27a8e61ed6e6` |
| `cgroup-checkpoints.ndjson`                                                               | 11,483 | `2607096d78105ad8dd509154b03e5c9f2ce677a93b503c2186a392bfaffdc545` |
| `container-stdout.ndjson`                                                                 | 14,299 | `51c9c1e72d905b13e54d9bef18fbdd74449d4bb057d5a43e831ad24f9b8a9691` |
| `container-stderr.log`                                                                    |      0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docker-stats-samples.ndjson`                                                             |  1,847 | `2c6c3bf62381e8bc95de4a187137558d3b96e5f87e9e41c524ad39f033b695c3` |
| `runs/job-01-zustand-c1.json`                                                             |  4,554 | `d8cbc2827325290de45445054dc91df4162a482a160fc851479df3e80b718ae9` |
| `runs/job-02-nextjs-subscription-payments-c1.json`                                        |  4,667 | `36448c05188446839380eaae6bf35c279c7a5ac0f2a800cdefc6153501c7c1bd` |
| `runs/job-03-taxonomy-c1.json`                                                            |  4,575 | `371dcb8c641abb92203483077988e8085882d34e80f824bc7a4e40269b831f25` |
| `runs/job-04-zustand-c2.json`                                                             |  4,576 | `b31587724f30d9e8fb21a2debe166eb1a533cadb1b34a4e40af2e40f7120e69f` |
| `runs/job-05-nextjs-subscription-payments-c2.json`                                        |  4,679 | `f968872c7c2db5f747c4ececa791acfacef255e3dd7245c62e705cbdb0d74cbb` |
| `runs/job-06-taxonomy-c2.json`                                                            |  4,583 | `f532fef3e2c3cdb0c174d6193eb02e9ac7a5f74630d5ec856e827f1c156547c8` |
| `runs/job-07-zustand-c3.json`                                                             |  4,575 | `9c1437d3cb7ac6895979261a0cfd933fc8f76b78c3aa4a2ffb3cf70fbf7ed91d` |
| `runs/job-08-nextjs-subscription-payments-c3.json`                                        |  4,676 | `0e84d7534b43a7666bec7cfb4c798ca2d6a6e533806ae4132999ab46023d56a6` |
| `runs/job-09-taxonomy-c3.json`                                                            |  4,586 | `d9aff91be23c1f48d925ce31f56b06b44d316d11445c02c66846bfbafa57faf7` |
| `runs/job-10-synthetic-stress-480-c1.json`                                                |  4,418 | `42ee702854ff8ffc1b547f35f40a64aca9d9f6a71684ac5be17c50f6ef492f5c` |
| `runs/job-11-synthetic-stress-480-c2.json`                                                |  4,667 | `1974fd8bfff1dd2108b0ed748729ef3946f8bf7d6b6ffafdf53391e673febed7` |
| Reused `../phase-5-6-persistence-bench-20261127-230834/build-provenance.json`             |    366 | `c239bf7db9cdac4952d482d5351b4450c7ba6fee9a67c266d0fdc003cc536832` |
| Reused `../phase-5-6-persistence-bench-20261127-230834/workloads/workloads-manifest.json` |  2,571 | `0c2cf80687d8e18f61f721b11be0470fe339b743977c45a4f5a20bc93faef256` |

## 6. Known Limitations and Caveats

- **Standalone/local-tarball scope vs. Phase 4:** Phase 5.6 measured a standalone worker reading local mounted tarballs (excluding HTTP and live GitHub latency), which is not directly equivalent to the Phase 4 embedded-worker live smoke (`194.95 MiB`, zero graph writes).
- **Persistence-only parity:** Compares only persisted `nodes` and `edges` columns; `warnings`/`stats` are excluded and full `computeGraphOutputDigest` parity is not claimed.
- **Synthetic workload:** Tests multi-batch stress and repeat determinism only, not independent static-analysis accuracy or arbitrary real-world 500-file complexity.
- **Idle memory growth (`+50.75 MiB`):** Startup idle `45.54 MiB` rose to `96.29 MiB` across 11 runs (notably after the two 480-file runs); this does **not** prove leak-free operation under indefinite worker lifetimes.
- **Pre-shutdown peak and capacity:** `211.11 MiB` (`221,368,320` bytes) is the cumulative pre-shutdown kernel `memory.peak`, not an independent per-repo peak, p95 latency benchmark, or universal hosting-tier capacity guarantee.
- **Next phase:** Graph Query APIs, Blast Radius, and Hub Detection are scoped to **Phase 6**.
