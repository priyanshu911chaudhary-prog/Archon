# Archon Project Handoff and Context Guide

This document provides durable engineering context for continuing Archon across development phases, contributors, and AI-assisted sessions.

## 1. Document Purpose and Freshness

- Actual current source code is authoritative for implementation behavior. Distinguish committed revisions from uncommitted local changes.
- Actual execution evidence is authoritative for test, benchmark, and build results.
- Historical discussions and design proposals may be stale.
- Verify the active branch, HEAD, and working-tree status before proposing changes.
- Update this document at major implementation milestones.

### Verified implementation baseline

- Active branch: `feat/phase-5-graph-persistence` at code commit `f47877d169e6e44623f176965700e7bcc790f31d` (Phase 5.1–5.6 complete; Phase 5.7 documentation and PR preparation on top of `f47877d`).
- Local regression baseline: **356 passing tests across 42 suites** (319 unit + 37 Docker-backed integration tests).
- Prior merged milestones: PR #10 (`b2fc5aa`), PR #11 (`785433a`), and PR #12 (`4d4d18e`).
- Next implementation milestone after merging Phase 5: **Phase 6: Graph Query APIs, Blast Radius and Hub Detection** (starting with Phase 6.1 architecture review).

This document does not replace inspecting actual source code.

## 2. Product Vision and Original Requirements

Archon is a Codebase Archaeologist and Impact-Analysis Engine for developers working with public JavaScript and TypeScript repositories.

Its intended users include onboarding engineers, developers refactoring shared modules, and reviewers evaluating downstream change risks.

Archon separates deterministic structural truth from semantic AI reasoning. Dependency graph extraction must remain independent of any LLM.

| Capability                   | Original requirement                                            | Implementation status     |
| ---------------------------- | --------------------------------------------------------------- | ------------------------- |
| Repository ingestion         | Public JS/TS repositories, up to 500 supported files and 50 MiB | Implemented               |
| Static dependency extraction | At least 95% sampled static-edge recall target                  | Implemented and evaluated |
| Graph persistence            | PostgreSQL nodes and edges with atomic publication and fencing  | Implemented (Phase 5)     |
| Graph query APIs             | Persisted graph read endpoints and snippet retrieval            | Planned (Phase 6)         |
| Blast radius                 | Direct callers/importers and 2-3 hop transitive impact          | Planned (Phase 6)         |
| Hub detection                | Configurable incoming-edge threshold, default 30                | Planned (Phase 6)         |
| Semantic zoom                | Folder, file, and callable graph navigation                     | Planned                   |
| AI risk reports              | Exact file and line citations                                   | Planned                   |
| Sample repositories          | Pre-indexed demonstration experience                            | Planned                   |
| Semantic search              | Embeddings with keyword fallback                                | Planned                   |
| Optional features            | Diff analysis and export                                        | Deferred                  |

Original performance stretch targets:

- Index a 200-file repository in under 30 seconds p95.
- Execute blast-radius queries in under 200 milliseconds p95.
- Generate AI risk reports in under 8 seconds p95.
- Reduce pre-refactor impact analysis to under two minutes.

These targets have not all been established by measurement.

MVP non-goals include private repositories, GitHub OAuth, additional programming languages, automated patches, automated PR creation, live webhook synchronization, and dynamic runtime dispatch analysis.

## 3. Constraints and Technology Stack

### Development constraints

- Strict zero-cost MVP budget.
- Original three-week solo-development plan is a historical planning target.
- Free-tier hosting and API quotas must be reverified before deployment.
- Resource consumption and operational complexity must remain appropriate for a portfolio MVP.

### Implemented stack

- Node.js 24 and npm 11.
- npm workspaces.
- Native ESM and TypeScript NodeNext project references.
- Fastify, Zod, and Pino.
- PostgreSQL, Drizzle ORM, and pg.
- Redis, ioredis, and BullMQ.
- ts-morph 28.0.0 with bundled TypeScript 6.0.2.
- Vitest, ESLint, Prettier, Husky, and commitlint.
- GitHub Actions with required Quality, Dependency Audit, and Secret Scan checks.

### Planned stack

- Next.js App Router, React Flow, Tailwind, and TanStack Query.
- Gemini API for citation-grounded risk reports and embeddings.
- Vercel frontend hosting.
- Render API and embedded worker hosting.
- Neon PostgreSQL and Upstash Redis.

These hosting services are planned, not verified production deployments.

## 4. Monorepo Organization

| Path              | Responsibility                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api`        | Fastify API, GitHub prechecks, ingestion service, queue integration, and optional embedded worker |
| `apps/worker`     | BullMQ processing, tarball extraction, isolated parser execution, and lifecycle supervision       |
| `apps/web`        | Reserved frontend workspace; application not yet implemented                                      |
| `packages/core`   | Deterministic static analysis and graph extraction                                                |
| `packages/db`     | PostgreSQL schema, migrations, graph validation/batching, ownership fencing, and repositories     |
| `packages/shared` | Environment validation, logging, shared graph contracts, and parser IPC                           |
| `scripts`         | Evaluation tooling, frozen ground truth, and parser benchmarks                                    |
| `docs`            | Engineering documentation and validation reports                                                  |

The static-analysis core remains independent of HTTP, PostgreSQL, Redis, and LLM services.

## 5. Completed Milestones

| Phase          | Completed scope                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Phase 0        | PRD, architecture, initial data-model proposals, and roadmap                                      |
| Phase 1        | Monorepo, TypeScript tooling, shared infrastructure, and local Docker services                    |
| Phase 2        | CI, dependency auditing, secret scanning, and branch protection                                   |
| Phase 3        | Repository ingestion, safe archive extraction, PostgreSQL state management, and BullMQ processing |
| Phase 4.1-4.2a | Workspace discovery, config loading, deterministic nodes, and IMPORTS extraction                  |
| Phase 4.2b     | CALLS extraction, JSX support, frozen evaluation, and targeted parser corrections                 |
| Phase 4.3      | Parser subprocess isolation, production integration, lifecycle supervision, and memory validation |
| Phase 4.5      | Incremental development workflow and durable project context                                      |
| Phase 5.1-5.2  | Graph persistence architecture review, `nodes`/`edges` schema, constraints, and migration `0001`  |
| Phase 5.3      | Delivery-generation fencing, `NOWAIT` heartbeats, enqueue safety, legacy recovery, expiry safety  |
| Phase 5.4-5.5  | Graph validation/batch planner, atomic publication, COMMIT reconciliation, count invariants       |
| Phase 5.6-5.7  | Constrained 512 MiB Linux persistence benchmark, evidence audit, documentation, and PR prep       |

Key implementation checkpoints:

- PR #8 (`a2cc2a5`), PR #9 (`ea66fb6`), PR #10 (`b2fc5aa`), PR #11 (`785433a`), PR #12 (`4d4d18e`).
- Phase 5 branch (`81f644d` -> `f47877d`): Atomic PostgreSQL graph persistence, ownership fencing, legacy recovery, failure testing, and constrained Linux resource validation.

## 6. Current Ingestion Architecture

Normal ingestion flow:

1. Receive `POST /api/v1/repos`.
2. Validate the GitHub URL and resolve the repository commit.
3. Check repository size and supported-file limits.
4. Create or reuse PostgreSQL records (`createOrGetActive` atomically supersedes legacy-ready rows with `graph_persisted_at IS NULL` and preserves retained sample identity; `createOrGetVerifiedEmpty` atomically persists verified empty repos).
5. Enqueue BullMQ work (`bullmqJobId === jobId`); enqueue failures invoke pre-claim `failQueuedJobOnEnqueueError`, while post-enqueue `attachBullMqJobId` runs in a separate `try/catch`.
6. Worker captures `job.attemptsStarted` and `job.id` synchronously, claims DB ownership via `claimIngestionAttempt` under repository-first locks, and starts five-outcome `NOWAIT` heartbeats.
7. Safely extract the pinned archive, tracking `oversizedSupportedFilesCount` separately from general skips.
8. Run isolated `parser-child.js` analysis and validate IPC/graph integrity.
9. Transition to `building_graph` at 85% progress (fenced).
10. Validate graph/counts (`prepareGraphPersistencePlan` + `resolvePublicationCounts`) and run single-transaction `publishRepositoryGraph` (`<= 200` nodes, `<= 500` edges, `<= 1 MiB` batch budget, cooperative `AbortSignal` checks), setting `graph_persisted_at`, exact counts, and `ready` at 100%.
11. Reconcile uncertain `COMMIT` outcomes via locked `reconcilePublishedAttempt` before retry or fenced failure.

Implemented endpoints:

- `GET /api/v1/health`: PostgreSQL and Redis health, worker mode, and uptime.
- `POST /api/v1/repos`: accepts `githubUrl`, schedules ingestion, recovers legacy-ready rows, or reuses persisted-ready/active snapshots.
- `GET /api/v1/jobs/:jobId`: job status, progress, authoritative file/skip statistics (`emptyJsTs` derived from persisted-ready + `fileCount === 0`), and sanitized errors.

### Historical Phase 4 vs. Current Production Behavior

In Phase 4, production workers invoked `noopAnalysisResultHandoff` and executed a separate conditional `ready` transition without persisted graph rows or a publication marker. In Phase 5, `noopAnalysisResultHandoff` has been removed from both standalone and embedded workers, `transitionJobStage` rejects `'ready'`, and every completed ingestion atomically persists `nodes` and `edges` to PostgreSQL before reaching `ready`. Read/query HTTP endpoints over persisted graphs remain Phase 6 work.

## 7. Static-Analysis Architecture

The core engine extracts:

- Folder, file, function, class, and symbol nodes.
- Parent-child relationships.
- IMPORTS edges between files.
- CALLS edges between resolved internal graph nodes.

Important implementation characteristics:

- Deterministic qualified names with escaped delimiters and collision disambiguation.
- Local JSONC tsconfig/jsconfig loading and bounded extends resolution.
- Native TypeScript module resolution over a restricted virtual workspace.
- Static imports, barrel re-exports, and supported literal CommonJS require calls.
- Conservative resolution of functions, methods, constructors, and JSX components.
- Recognized React memo and forwardRef wrappers.
- Narrow JSX function-object property augmentation support.
- Type-only, ambient, signature-only, and ambiguous-call exclusions.
- Strict BOM-aware UTF-8 and UTF-16 source decoding.
- Rejection of malformed encodings and unsupported UTF-32 BOMs.
- One-indexed line numbers and LF-normalized content hashes.
- Bounded snippets: 8192 file, 4096 symbol, and 512 call-site characters.

The analyzer never installs target dependencies or executes target source code.

Limitations include unresolved external dependencies, dynamic dispatch, ambiguous types, unsupported wrappers, and syntax-invalid source files.

Three predeclared React.cache wrapper relationships remain unsupported in the broader evaluation scope.

Refer to the actual core implementation for exact behavior and supported syntax.

## 8. Database Implementation Status

Implemented schema tables in `packages/db/src/schema.ts` (migrations `0000` and `0001`):

- `repositories` (with `graph_persisted_at` CHECK `"graph_persisted_at" IS NULL OR "status" = 'ready'`).
- `ingestion_jobs` (with `attempt_generation >= 0`).
- `nodes` (composite `(repo_id, id)` and `(repo_id, qualified_name)` uniqueness, `nodes_repo_parent_fk`, 2048 UTF-8 byte `qualified_name` check, folder vs. non-folder metadata checks, parent/type indexes).
- `edges` (composite source/target cascade FKs, `IMPORTS`/`CALLS` checks, partial unique edge indexes, forward/reverse traversal indexes).

Implemented repository and persistence guarantees (`packages/db/src/repository.ts`, `graph-persistence.ts`, `errors.ts`): PG 17 bounded transactions, mandatory `IngestionAttemptOwnership` fencing, repository-first locking, `NOWAIT` heartbeats, pre-claim enqueue-failure fencing, atomic legacy-ready recovery with retained sample-identity preservation, explicit `createOrGetVerifiedEmpty`, bounded `SKIP LOCKED` stale-job sweeping and terminal-only expiration deletion, pre-transaction graph validation/batching, single-transaction `publishRepositoryGraph`, locked `reconcilePublishedAttempt`, and authoritative count validation (`resolvePublicationCounts`).

## 9. Parser Isolation and Resource Ownership

| Setting                         | Production configuration             |
| ------------------------------- | ------------------------------------ |
| Standard library loading        | Disabled                             |
| V8 old-space limit              | 256 MiB                              |
| Parser timeout                  | 60,000 ms                            |
| Serialized IPC response budget  | 32 MiB                               |
| Termination grace               | 2,000 ms                             |
| Forced termination confirmation | 3,000 ms                             |
| Worker concurrency              | One per worker instance              |
| Supported source cap            | 500                                  |
| Config-file cap                 | 50                                   |
| Per-file byte cap               | 1 MiB                                |
| Total-byte ceiling              | 50 MiB, subject to configured limits |

The lower-level core and parser runner retain library loading enabled by default. Production explicitly disables it.

Important invariants:

- Use a fixed compiled parser entrypoint.
- Pass a minimal child environment without application credentials.
- Validate versioned IPC requests and responses.
- Validate graph integrity before production handoff.
- Confirm process termination and associated resource cleanup.
- Preserve the first terminal failure reason.
- Permanently latch fatal supervision failures.
- Do not delete temporary workspaces while child ownership is unresolved.
- Do not close shared Redis or PostgreSQL resources while dependent work remains unresolved.
- Preserve cancellation checkpoints and lifecycle ownership.

V8 old-space is not a complete process-memory limit. Subprocess isolation reduces fault propagation but is not an OS security sandbox and cannot eliminate shared-cgroup OOM risk.

Disabling standard library loading preserved the three frozen reference graphs but is not universally equivalent to library-enabled analysis.

## 10. Verified Phase 4 and Phase 5 Results

### Phase 5 automated verification and Linux persistence benchmark (`f47877d`)

- **Automated baseline:** **319 unit tests across 35 suites** + **37 Docker-backed integration tests across 7 suites** = **356 passing tests across 42 suites**; formatting, typecheck, build, strict ESLint, and `git diff --check` passed.
- **Phase 5.6 constrained Linux benchmark (`archon-phase56-bench:f47877d-20261127-230834`, 512 MiB, swap disabled, standalone worker + local tarballs, external PG/Redis):** 11/11 sequential jobs completed (9/9 frozen real runs matched Phase 4 Linux reference outputs under persistence-only `nodes`/`edges` projections; 2/2 synthetic 480-file runs emitted 2,897 nodes and 3,252 edges across 15/7 batches with identical repeat projections; **8,365 nodes** and **11,322 edges** persisted total).
- **Cgroup memory & hygiene:** Startup idle `45.54 MiB` -> final idle `96.29 MiB` (`+50.75 MiB`, does not prove leak-free long-term operation); pre-shutdown kernel `memory.peak` = **211.11 MiB** (`221,368,320` bytes, `41.23%`); `0` OOM/OOM-kill/`max`/swap events; `0` failed jobs, duplicate/dangling rows, or leftover workspaces; graceful exit `0`; verified non-forced cleanup. Standalone/local-tarball scope is not equivalent to Phase 4's embedded live smoke (`194.95 MiB`), and does not establish p95 latency or universal 500-file capacity. See [docs/phase-5-graph-persistence.md](./phase-5-graph-persistence.md).

### Historical Phase 4 automated verification (`b2fc5aa`)

- 283 passing unit tests across 33 suites.
- 10 passing Docker-backed integration tests across 2 suites.
- Total local regression baseline: 293 tests across 35 suites.
- Required GitHub Actions checks passed on the merged Phase 4 baseline.
- Final secret scan reported zero findings.

### Frozen sampled accuracy evaluation

The evaluation covers 30 purposively selected source files out of 234 supported files across three pinned repositories.

| Scope         | Baseline TP/FP/FN | Corrected TP/FP/FN | Corrected precision | Corrected recall | Corrected F1 |
| ------------- | ----------------- | ------------------ | ------------------- | ---------------- | ------------ |
| IMPORTS       | 74/0/3            | 77/0/0             | 100%                | 100%             | 100%         |
| Primary CALLS | 156/0/4           | 160/0/0            | 100%                | 100%             | 100%         |
| Broader CALLS | 156/0/7           | 160/0/3            | 100%                | 98.16%           | 99.07%       |

Corrections addressed BOM-aware source decoding and narrow JSX function-object augmentation support without changing frozen evaluation denominators.

Evaluator executions:

- 9 baseline runs.
- 9 corrected runs.
- 9 repeated corrected runs.
- 3 fresh-snapshot smoke runs.
- Total: 30 executions.

The 21 post-correction executions reproduced their respective corrected reference graph digests. Baseline graphs preceded the corrections.

The frozen repositories are:

- pmndrs/zustand at `9fed2eb2f3af672da9f7bf694b996df3831fc207`.
- vercel/nextjs-subscription-payments at `bdd0813206e47e6b218d42f15a7976c8a0d3c3eb`.
- shadcn-ui/taxonomy at `298a8857c7128a0d121e7f699dfd729f23b3966d`.

### Parser-only isolation benchmarks

- 3 initial smoke executions.
- 18 Windows comparative executions.
- 60 Windows sequential retention executions.
- 6 constrained Linux parser-only executions.
- Total: 87 parser-only executions.

The tested frozen graph digests remained consistent across the comparative library-loading modes.

The sequential retention experiment did not demonstrate progressive parent-memory accumulation. This is not proof that memory leaks are impossible.

### Integrated Linux service gate

Three sequential live repository ingestions completed inside a service container constrained to 512 MiB with swap disabled.

| Metric                                         | Observed result   |
| ---------------------------------------------- | ----------------- |
| Maximum observed cumulative cgroup memory peak | 204,419,072 bytes |
| Peak in MiB                                    | 194.95 MiB        |
| Observed memory utilization                    | 38.08%            |
| Readable cgroup observations                   | 27                |
| Parsed source files                            | 234               |
| Graph nodes                                    | 857               |
| IMPORTS edges                                  | 427               |
| CALLS edges                                    | 1179              |
| Total edges                                    | 1606              |
| Analysis warnings                              | 0                 |
| Observed OOM, swap, and restarts               | 0                 |
| Leftover extraction workspaces                 | 0                 |
| Natural service exit code                      | 0                 |

The final evidence audit and isolated smoke-resource cleanup passed.

The live Zustand revision differed from its frozen evaluation revision. Matching graph counts do not establish exact graph digest parity.

### Reporting limitations

- Sampled accuracy is not universal static-analysis accuracy.
- The evaluation is not held-out generalization evidence.
- The integrated service gate is not a p95 latency benchmark.
- The tested repositories do not prove arbitrary 500-file capacity.
- Graph persistence was absent from the integrated memory workload.
- PostgreSQL and Redis clients were already included in the service architecture.
- Future graph-writing buffers and query workloads require separate validation.
- Observed memory margin is not guaranteed future capacity.

Detailed methodology and results are maintained in the existing Phase 4 report and evaluation guide.

## 11. Important Engineering Lessons

### Source and tooling

- Inspect exact current source before proposing changes.
- Preserve NodeNext-compatible relative import specifiers.
- Do not rely on undeclared hoisted workspace dependencies.
- Use ts-morph's bundled TypeScript compiler for compiler API consistency.
- Preserve frozen evaluation manifests and denominators.
- Do not reinterpret historical metrics to improve apparent results.

### Windows development

- Use Windows PowerShell 5.1-compatible commands.
- Do not use double-ampersand command chaining.
- Check native-command exit codes.
- Wrap multistep commands in guarded script blocks.
- Use absolute paths for .NET filesystem APIs.
- Preserve UTF-8 without BOM and repository line-ending rules.
- Wrap potentially empty command-output collections in arrays before accessing Count.
- Use explicit file arguments or per-path loops when native array forwarding is unreliable.
- Use local PostgreSQL port 5432 and Redis port 6380.
- Do not interfere with unrelated services using Redis port 6379.

### Lifecycle and security

- A timeout does not establish confirmed resource termination.
- BullMQ 6.7.8 caches its worker close promise; calling close again with forced shutdown does not reliably escalate the original operation.
- Preserve cancellation, heartbeat drainage, and shared resource ownership.
- Do not expose raw errors, source snippets, or credentials through public failure messages.
- Resolve synthetic secret-scan false positives without weakening scanner rules.

### Important Phase 4 incidents

The Windows HTTP shutdown defect was corrected by restoring the application ownership callback in `buildApp`. Subsequent standalone and embedded shutdown tests verified natural exit after one Ctrl+C.

An external PowerShell benchmark controller failed startup health polling. Empty GET-body coercion was the likely cause, but the original HTTP exception was not captured.

The first recovery attempt also encountered native quoting and stdin-handling problems. A corrected controller recovered the same running service container without rebuilding, restarting, or resetting its memory peak. No production ingestion failed during the accepted run.

A synthetic test-fixture secret-scan false positive was corrected narrowly before the final Phase 4 commit. The security scanner was not disabled.

## 12. Known Limitations and Technical Debt

- Graph query APIs, blast-radius traversal, and hub detection are not implemented yet (Phase 6).
- Interactive frontend (`apps/web`), AI risk reports, vector embeddings, semantic search, and cloud deployment are not yet implemented.
- Observed `+50.75 MiB` idle memory increase across 11 sequential standalone worker jobs warrants monitoring under longer worker lifetimes.
- Original p95 stretch targets (200-file indexing, blast-radius queries, AI reports) remain unverified.
- A known moderate dev-dependency audit finding remains in the `drizzle-kit` dependency chain.
- Conservative static-analysis limitations remain.

Do not introduce unrelated dependency upgrades or repeat accepted benchmarks without a concrete reason.

## 13. Remaining Roadmap

- **Phase 6:** Graph Query APIs, Blast Radius and Hub Detection.
- **Phase 7:** Citation-grounded Gemini risk reports.
- **Phase 8:** Interactive semantic-zoom architecture map.
- **Phase 9:** Blast-radius UI and snippet inspection.
- **Phase 10:** Embeddings and semantic search.
- **Phase 11:** End-to-end testing, hardening, observability, deployment, and sample repository seeding.
- **Phase 12:** Final documentation and release.

### Immediate next scope

**Phase 6.1** is a read-only architecture review for Graph Query APIs, Blast Radius and Hub Detection covering persisted-ready snapshot gating (`status = 'ready' AND graph_persisted_at IS NOT NULL`), query API contracts and validation, cycle-safe bounded traversal (2–3 hops) using `idx_edges_forward_lookup` / `idx_edges_reverse_lookup`, configurable `HUB_THRESHOLD` (default 30), payload bounds, and integration/latency testing. No Phase 6 implementation is authorized by this handoff.

## 14. Starting a New AI Conversation

1. Read the contribution and development workflow guide.
2. Read this project handoff.
3. Verify actual branch, HEAD, and working-tree state.
4. Supply relevant current source files.
5. Supply actual evidence required for the task.
6. Confirm source contents are genuinely accessible.
7. Identify stale context and missing information.
8. Obtain architecture or implementation-batch approval.
9. Implement one coherent batch.
10. Verify actual results.
11. Explicitly stage, commit, and push the approved checkpoint.
12. Complete checkpoint review before starting the next batch.

Observed limitations in the tested Gemini environment:

- Historical project context was useful but incomplete.
- ZIP attachments exposed entry listings without readable file contents.
- Native GitHub imports exposed metadata only.
- Plain-text source and evidence bundles were readable.

These are environment-specific observations, not universal claims about Gemini.

Refresh affected source files after commits. Do not assume previously supplied snapshots automatically synchronize.

The developer retains control over all repository operations.

## 15. Authoritative References

- [Project README](../README.md)
- [Contribution and Development Workflow](../CONTRIBUTING.md)
- [Phase 5 Graph Persistence Report](./phase-5-graph-persistence.md)
- [Phase 4 Parser Isolation and Validation Report](./phase-4-parser-isolation.md)
- [Evaluation and Benchmark Reproduction Guide](../scripts/README.md)

### Preserved external evidence

The following evidence is stored outside Git under `C:\dev\archon-eval\`:

- `results/baseline/baseline-report.json`
- `results/post-correction-1/post-correction-report.json`
- `results/parser-isolation-benchmarks/matrix-windows-20261126-185846/reports/comparative-summary.json`
- `results/parser-isolation-benchmarks/matrix-windows-20261126-185846/reports/graph-diff-and-ndjson-audit.json`
- `results/parser-isolation-benchmarks/retention-windows-20261126-191737/retention-summary.json`
- `results/parser-isolation-benchmarks/linux-cgroup-20261126-195826/linux-matrix-summary.json`
- `results/parser-isolation-benchmarks/linux-integrated-e43-20261127-012841/e2-recovery-20261127-015128/e2-recovery-result.json`
- `results/parser-isolation-benchmarks/linux-integrated-e43-20261127-012841/e3-acceptance-audit.json`
- `results/parser-isolation-benchmarks/linux-integrated-e43-20261127-012841/e3-acceptance-summary.md`
- `results/phase-5-6-persistence-bench-20261127-230834/build-provenance.json`
- `results/phase-5-6-persistence-bench-20261127-230834/workloads/workloads-manifest.json`
- `results/phase-5-6-persistence-bench-rerun-20261127-231642/benchmark-report.json`
- `results/phase-5-6-persistence-bench-rerun-20261127-231642/benchmark-report.md`
- `results/phase-5-6-persistence-bench-rerun-20261127-231642/pre-cleanup-audit.json`
- `results/phase-5-6-persistence-bench-rerun-20261127-231642/cleanup-record.json`

Preserve the original evidence and immutable evaluation manifests. Do not commit raw experiment records or downloaded repository snapshots.
