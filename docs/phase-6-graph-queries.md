# Phase 6: Graph Query APIs, Deterministic Blast Radius and Hub Detection

Phase 6 exposes read-only HTTP query APIs over PostgreSQL-persisted dependency graphs, adding folder/file/function semantic zoom, deterministic reverse-edge blast-radius traversal, configurable hub detection, cursor-paginated node/edge inspection, shared graph-read rate limiting, and bounded concurrency admission.

This report covers the implementation on branch `feat/phase-6-graph-queries` at commit `76ab23f327ea1fd9da031fbf04901d8452c36770` (pending PR merge to `main`). No new database migrations or runtime dependencies were added. Raw benchmark records and external harness scripts remain outside Git.

## Phase 6 Commits

- `9ef2962` — `feat(db): implement bounded graph queries and semantic zoom`
- `8a5df35` — `feat(db): implement deterministic blast-radius analysis`
- `76ab23f` — `feat(api): expose graph queries and blast-radius endpoints`

## 1. Architecture & Endpoints

All five `GET` endpoints (plus Fastify's auto-exposed `HEAD` handlers) reuse `createGraphQueryRepository(dbClient.db)` inside `REPEATABLE READ READ ONLY` bounded PostgreSQL 17 transactions (`lock_timeout = 1s`, `statement_timeout = 3s`, `transaction_timeout = 5s`). Read requests never mutate `expires_at` or acquire row locks (PostgreSQL still takes standard `ACCESS SHARE` table locks).

| Endpoint (`GET` / `HEAD`)                          | Query Parameters (Strict Zod)                                                                                                                                                                                                |     Snippets Included?     | Pagination / Completeness                                                                     |
| :------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------: | :-------------------------------------------------------------------------------------------- |
| `/api/v1/repos/:repoId/graph`                      | `level` (`folder\|file\|function`, default `file`), `scopeNodeId` (UUID), `filePath` (`function` only, mutually exclusive with `scopeNodeId`), `includeImports` (`true\|false`, default `true`), `hubThreshold` (`1..10000`) |             No             | Complete scoped view; fails loudly with `422 GRAPH_SCOPE_REQUIRED` or `GRAPH_BUDGET_EXCEEDED` |
| `/api/v1/repos/:repoId/nodes/:nodeId`              | `hubThreshold` (`1..10000`), `childrenLimit` (`1..100`, default `50`), `childrenCursor` (<= 512 chars)                                                                                                                       | Single node `snippet` only | Keyset cursor pagination on direct children (`children.page.nextCursor`)                      |
| `/api/v1/repos/:repoId/nodes/:nodeId/edges`        | `direction` (`incoming\|outgoing`, default `incoming`), `edgeType` (`all\|IMPORTS\|CALLS`, default `all`), `peerNodeId` (UUID), `limit` (`1..100`, default `50`), `cursor`                                                   |     `callSiteSnippet`      | Keyset cursor pagination (`page.nextCursor`)                                                  |
| `/api/v1/repos/:repoId/nodes/:nodeId/blast-radius` | `maxDepth` (`1..3`, default `2`), `hubThreshold` (`1..10000`)                                                                                                                                                                |             No             | Complete bounded BFS; fails loudly with `422 BLAST_RADIUS_BUDGET_EXCEEDED`                    |
| `/api/v1/repos/:repoId/hubs`                       | `threshold` (`1..10000`, default `env.HUB_THRESHOLD = 30`), `scope` (`all\|file\|callable\|file_rollup`, default `all`), `limit` (`1..100`, default `50`), `cursor`                                                          |             No             | Keyset cursor pagination (`page.nextCursor`)                                                  |

All UUID path/query parameters are normalized to lowercase before cursor binding and DB queries. Unknown query keys, duplicate query parameters, malformed integers/booleans, and conflicting scope parameters are rejected with `400 VALIDATION_ERROR`. Responses are validated against strict shared Zod schemas without silent field stripping.

## 2. Semantic Zoom, Blast Radius, Hubs & Cursors

- **Semantic zoom (`/graph`):** `level=folder` returns immediate children of root (`parent_node_id IS NULL`, including root files) or a scoped folder, projecting descendant edges onto visible containers with zero dangling canvas edges. `level=file` covers all files or a scoped folder subtree. `level=function` returns the scoped file or folder subtree with full containment context (including nested classes/methods). `includeImports` applies consistently across all zoom levels.
- **Deterministic blast radius (`/blast-radius`):** Uses bounded reverse-frontier SQL BFS (`maxDepth` `1..3`, default `2`). Callable/class/symbol targets traverse reverse `CALLS` only (`calls_only`); file and folder targets seed target file(s) and exported declarations (`is_exported = true`), exclude the target subtree from external impact, and propagate conservatively (`conservative_file_wide_structural` — static reachability, not runtime execution certainty). Distinct file and callable states are tracked separately, containment projection is zero-hop, full frontier layers are processed before committing shortest-hop causes, top-level file-scope `CALLS` stay deduplicated by UUID, and overlapping `calls_symbol` / `calls_exported_symbol` reasons are preserved without duplicating call-site evidence.
- **Hub metrics & threshold semantics:** Node-level hub status uses distinct external incoming dependents (`source_node_id <> target_node_id`) strictly greater than threshold (`inDegreeDistinct > threshold`, default `30`; `29`/`30` are false, `31` is true). Raw incoming edge rows (`rawIncomingEdgeCount`), importer/caller splits, and file-rollup degree (`dependentFileCount`: distinct external files importing a file or calling its exported declarations; `isFileRollupHub`) are reported separately and consistently across `/graph`, `/nodes/:nodeId`, `/blast-radius`, and `/hubs`.
- **Cursor pagination:** Compact base64url JSON cursors (`v: 1`, `<= 512` chars) store only UUIDs and numeric sort scalars (supporting `2048`-byte UTF-8 `qualified_name`s) bound via an unsigned SHA-256 parameter-consistency hash (not cryptographic tamper authentication) to `(endpoint, repoId, effective query parameters)`. Hub cursors additionally validate anchor membership and exact numeric sort values against the bound `(scope, threshold)` hub set.

## 3. Readiness Gating, Budgets, Rate Limiting, Admission & Shutdown

- **Repository readiness & expiry gating:** Unknown/purged -> `404 REPO_NOT_FOUND`; active ingestion -> `409 GRAPH_NOT_READY`; Phase 4 legacy `ready` (`graph_persisted_at IS NULL`) -> `409 LEGACY_GRAPH_UNAVAILABLE`; failed -> `409 REPO_INGESTION_FAILED`; superseded -> `409 REPO_SUPERSEDED`; logically expired (`!isSample && expiresAt <= now`) -> `410 REPO_EXPIRED`; verified-empty persisted repos (`fileCount = 0`) -> `200` with empty collections.
- **Budgets & sanitized errors:** Every query enforces qualifying-row ceilings before aggregation/sorting, containment depth/frontier/visited caps, and a `2 MiB` serialized UTF-8 response cap (failing loudly with `422` — never silently truncating). `GraphQueryService` emits fixed safe public messages, validates allowlisted detail keys/ranges, distinguishes confirmed PostgreSQL `57014` statement timeouts / `25P04` transaction timeouts (`504 GRAPH_QUERY_TIMEOUT`) from generic `57014` cancellations (`503 GRAPH_QUERY_CANCELED`) and connection errors (`503 DATABASE_ERROR`), and never logs raw SQL, parameters, or snippets.
- **Shared graph-read rate limiting:** All five graph routes (`GET` and `HEAD`) share one per-IP bucket (`archon:rl:graph:<ip>`, default `120 req / 60 s`) in both Redis and in-memory stores, preserving `POST /api/v1/repos` on its separate `archon:rl:ingest:POST:/api/v1/repos:<ip>` bucket, TTL semantics, `request.ip` proxy trust, and `skipOnError: true` fail-open policy.
- **Concurrency admission & graceful shutdown:** `GraphQueryAdmissionGate` enforces proposed in-process caps of `2` (embedded worker mode) or `3` (standalone mode) shared across all five `GET`/`HEAD` routes (not reserved DB connections), failing fast with `503 GRAPH_QUERY_BUSY` (`Retry-After: 1`). Permits release strictly once after underlying DB work settles (even on client disconnect). Fastify `preClose` and `lifecycle.shutdownSignal` stop new admissions immediately, and `onClose` drains `admission.waitForIdle()` before closing shared PostgreSQL/Redis resources.

## 4. Automated Test Baseline (`76ab23f`)

- **Unit tests (`npx vitest run`):** **334 passed across 39 suites** (shared graph/blast-radius contracts, PG timeout classification, Redis shared-bucket store, Fastify graph routes, strict validation, error/log sanitization, admission saturation/disconnect/shutdown, and fail-open rate limiting).
- **Integration tests (`vitest.integration.config.ts`):** **45 passed across 10 suites** (real PostgreSQL 17 + Redis 7: graph zoom/hubs/pagination + independent oracle, blast-radius BFS + independent oracle, concurrent expiration `REPEATABLE READ` consistency, and full Fastify HTTP + Redis integration).
- **Total:** **379 passing tests across 49 suites**, with `format:check`, `typecheck`, `build`, strict `lint`, and `git diff --check` green.

## 5. Phase 6.5 Performance & Resource Validation

### Methodology & Combined Acceptance Scope

Phase 6.5 ran against a fresh Linux image built from `git archive` of commit `76ab23f327ea1fd9da031fbf04901d8452c36770` (`archon-phase65-bench:76ab23f-20261128-015659`, ID `sha256:115bcfd0cf7b0e067a23987bd621bf24029ab41060d2b2cb9b15b25ee13171c1`, `node:24.14.0-bookworm-slim`, `linux/x64`), constrained to `memory.max = 536,870,912` bytes (`512 MiB`) and `memory.swap.max = 0`, with PostgreSQL 17 and Redis 7 external to the measured containers.

> **Combined-run disclosure:** Acceptance was **not** achieved in one uninterrupted run. It combines three external runs against the same unchanged image and commit (no production code changes were required):
>
> 1. **Original run** (`phase-6-5-graph-api-bench-rerun-20261128-020725`): 700 primary + 150 secondary + 2 edge-pagination valid HTTP responses, `EXPLAIN (ANALYZE, BUFFERS)` plans, cgroup v2 memory samples, and standalone/embedded admission occupancy logs. Aborted at the final guard container due to an external harness config mismatch (`maxScannedRawEdges = 10` without lowering `maxReturnedEdges`).
> 2. **Supplemental run** (`phase-6-5-supplemental-20261128-021247`): Passed default-budget unscoped `422 GRAPH_SCOPE_REQUIRED`, tight-budget `422 BLAST_RADIUS_BUDGET_EXCEEDED`, non-overlapping edge pagination, and embedded parser/read temporal overlap. Rate-limit sub-test hit `422` on the tight-budget container, active-DB shutdown exited `137` (`oomKilled: false`, empty stderr; the cause was not conclusively established; the subsequent non-keepalive recovery succeeded), and 9 historical Redis DB 15 keys remained.
> 3. **Final recovery run** (`phase-6-5-final-recovery-20261128-021824`): Passed normal-budget shared rate limiting (`[200, 200, 200, 429 RATE_LIMITED]`, ingestion `400`, recovery `200`), active-DB lock-wait `SIGTERM` drain using `node:http` with `Connection: close` (schema-valid HTTP `200`, natural `exitCode: 0`, 43 ms recorded lifecycle close interval), and historical Redis DB 15 cleanup (`0` remaining `archon_p65_*` keys). All 11 final combined gates passed.

### Primary Blast-Radius Latency (100 Measured Requests Each, Warmup Excluded)

| Workload (Frozen Commit / Fixture) | Samples (Valid) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) | Avg Bytes |    Node-Hop Oracle     |
| :--------------------------------- | :-------------: | -------: | -------: | -------: | -------: | --------: | :--------------------: |
| `blast_zustand_callable_high_d2`   |    100 / 100    |    12.14 |    14.89 |    18.16 |    23.11 |    22,013 | Exact (representative) |
| `blast_payments_file_high_d2`      |    100 / 100    |    16.76 |    20.71 |    22.24 |    22.85 |    29,021 | Exact (representative) |
| `blast_taxonomy_file_high_d2`      |    100 / 100    |    36.17 |    44.27 |    48.29 |    51.17 |   232,307 | Exact (representative) |
| `blast_synthetic_callable_low_d1`  |    100 / 100    |     4.38 |     6.00 |     7.19 |     7.81 |     1,439 | Exact (representative) |
| `blast_synthetic_callable_high_d3` |    100 / 100    |    12.68 |    17.16 |    19.32 |    20.05 |     8,875 | Exact (representative) |
| `blast_synthetic_file_high_d2`     |    100 / 100    |    17.47 |    21.61 |    23.19 |    24.27 |     9,061 | Exact (representative) |
| `blast_synthetic_folder_med_d2`    |    100 / 100    |    39.64 |    48.86 |    52.29 |    53.12 |   126,387 | Exact (representative) |

All 7 primary workloads achieved `p95 < 200 ms` (range `6.00 ms`–`48.86 ms`). Note: the benchmark oracle verified node-hop set parity, not full independent response-field equality (the Phase 6.2/6.3 PostgreSQL integration suites provide additional targeted correctness coverage).

### Secondary Endpoint Latency (30 Measured Requests Each) & Edge Pagination

| Workload                     | Samples (Valid) | p50 (ms) | p95 (ms) | Max (ms) | Avg Bytes |
| :--------------------------- | :-------------: | -------: | -------: | -------: | --------: |
| `graph_taxonomy_folder`      |     30 / 30     |    18.51 |    22.91 |    23.08 |     8,207 |
| `graph_payments_file`        |     30 / 30     |    14.74 |    17.53 |    17.95 |    53,643 |
| `graph_synthetic_fn_scoped`  |     30 / 30     |    10.05 |    13.41 |    13.62 |     3,620 |
| `node_detail_synthetic_high` |     30 / 30     |    11.10 |    13.83 |    14.16 |     3,271 |
| `hubs_synthetic_all`         |     30 / 30     |    95.29 |   114.28 |   116.05 |    22,873 |

Edge pagination continuation was validated separately (`n = 1` per page, not a percentile distribution): page 1 observed `10.51 ms` (`4,650` bytes) and page 2 via `nextCursor` observed `8.73 ms` (`4,486` bytes) with zero overlapping `edgeId`s.

### `EXPLAIN (ANALYZE, BUFFERS)` SQL Plan Audit

Five captured actual Drizzle-generated queries against `synthetic-stress-480` (2,897 nodes, 3,252 edges; heuristic category labels) executed in `0.058 ms`–`1.053 ms` with **0 shared read blocks** across all five plans, using `nodes_repo_id_id_unique`, `idx_edges_unique_imports`, `idx_edges_unique_calls`, `idx_edges_reverse_lookup`, and `idx_nodes_repo_type`.

- **Optimization watch item (non-blocking):** The `hubs_or_nodes` exported-target selection returned `15` rows while two `Bitmap Index Scan` nodes on `idx_nodes_repo_type` scanned `480` and `2,400` rows (`162` shared hit blocks, `1.053 ms`). Acceptable for Phase 6, but a candidate for a future composite/partial index if larger repositories are supported.

### Cgroup v2 Memory, Concurrency & Shutdown Observations

- **Pre-shutdown cgroup v2 memory (512 MiB limit, `swap.max = 0`, all `max`/`oom`/`oom_kill` events = `0`):**
  - Standalone container: peak **`78,716,928` bytes (`75.07 MiB`)**, idle delta **`+24.84 MiB`**.
  - Embedded container: peak **`197,615,616` bytes (`188.46 MiB`)**, idle delta **`+10.16 MiB`**.
  - These are pre-shutdown local observations, not leak-free guarantees.
- **Admission & overlap:** Original container event logs confirm overlapping admission occupancy of 3 standalone operations (with 600 ms artificial post-query delay) and 2 embedded operations (with 400 ms artificial post-query delay), plus standalone recovery entering after the first 3 settled; artificial delays are not real DB durations, and exact `503` saturation responses were not retained in the event logs (verified `503 GRAPH_QUERY_BUSY` behavior is covered by Phase 6.4 automated tests). In the supplemental run, an embedded HTTP blast-radius request (`readStartAt = 1795812197713`, `readEndAt = 1795812197766`) overlapped active parser execution (`1795812197691`–`1795812199083`), returning HTTP `200` while the concurrent ingestion reached `ready` with `graph_persisted_at IS NOT NULL`.
- **Active-DB `SIGTERM` shutdown:** Final recovery confirmed PostgreSQL lock wait (`activeDbWaitObserved = true`), `shutdown_signal_received` with `inFlight = 1`, schema-valid HTTP `200`, and natural `exitCode = 0` (`oomKilled = false`, empty stderr), with lifecycle logs from initiation through HTTP, BullMQ queue, Redis, and PostgreSQL pool closure spanning `43 ms` (recorded lifecycle interval, not full Docker stop latency).

## 6. Evidence Provenance & Limitations

All raw evidence lives outside Git under `C:\dev\archon-eval\results\` (harness at `C:\dev\archon-eval\linux-bench-scripts\phase-6-5\`). An independent read-only audit hashed **34 files** across the three runs (`21/21` existing inventory entries matched with zero mismatches; the 11 files in the original run were retrospectively hashed; audit bundle SHA-256: `d6fd25dfacfa8e20fc77ad0a83a491ca23346f20e33cc63f4c371b1156e7a6c4`):

- Original run (`phase-6-5-graph-api-bench-rerun-20261128-020725`): `requests.jsonl` (`572113fe0e98c46fb866aab4c9b29bf59d527904dcbc07c3311da2c458efef7c`), `explain-analyze.json` (`91c14dce9aeda765a989342ab9423b859277cce85f725c868d231f06219e4877`), `cgroup-samples.ndjson` (`038bd72568261b3fe9c2953963ccc5d4847c35ffb10f7f7a88b853a7e6344fdf`), `seed-results.json` (`d89e1efc99560d94389b3620df40363e1b77915b9db0b9b12b6be427a83012b5`).
- Supplemental run (`phase-6-5-supplemental-20261128-021247`): `combined-acceptance-audit.json` (`bd291c4fb6d2b7fceaa0106101f38427fa477a52193c60d4d2b77463d4454a4c`), `sha256-inventory.json` (`27d9dc15dafb6bb4635522356e34c745f35abc2ff33e6338ac81bc79db485e66`).
- Final recovery (`phase-6-5-final-recovery-20261128-021824`): `final-combined-acceptance-audit.json` (`9c20594cf76e84f8e6138ce761ddefe16d7fb65ab7fbe405eb3619e77dc5a396`), `final-combined-acceptance-report.md` (`e81e7e2970844de743941015d4859b3cc7ec1719d6e9d1df483ef225064cf5ac`), `historical-redis-cleanup.json` (`ec4e471cf84c9cfcfa53e3e2b10b3392caea43816485551ceff4471764847758`), `sha256-inventory.json` (`b15d888f1f48b333ea0424b484f15980696ba5285b142d21c41f7b5cbce6c0c3`).

**Limitations:** Local Docker/WSL2 measurements with external PostgreSQL/Redis do not establish hosted cloud p95 latency; historical Redis cleanup verified key absence but did not establish full job-timestamp provenance; and AI risk reports, frontend visualization, embeddings, and cloud deployment remain future phases (next: **Phase 7** after Phase 6 PR merge).

## 7. Reproduction Boundary

The accepted benchmark used an external Windows PowerShell 5.1 / Docker
Desktop Linux harness with frozen Phase 5.6 tarballs, isolated PostgreSQL
databases, and Redis DB 15 queue and rate-limit namespaces.

The external harness directory contains:

- `Dockerfile.phase65`
- `container-api.mjs`
- `seed-and-audit.mjs`
- `run-bench-controller.mjs`
- `run-phase65-benchmark.ps1`
- `rerun-phase65-benchmark.ps1`
- `audit-original-run.mjs`
- `run-phase65-supplemental.mjs`
- `run-phase65-final-recovery.mjs`

Preserve the original evidence directories and their hashes when reviewing
or reproducing this benchmark. Use fresh isolated resource identities for
any new run. The retained results combine successful measurements and
targeted recoveries; they are not evidence of one uninterrupted run.

The external harness was iteratively repaired during validation and is
not distributed with this repository. Consequently, a fresh repository
clone alone is insufficient for exact reproduction of the historical
benchmark. The committed automated tests remain independently runnable
using the standard repository setup and Docker integration commands.

The original 200-file indexing p95 stretch target, hosted graph-query
latency, long-duration memory retention, and AI report latency remain
unverified.
