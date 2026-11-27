# Archon Project Handoff and Context Guide

This document provides durable engineering context for continuing Archon across development phases, contributors, and AI-assisted sessions.

## 1. Document Purpose and Freshness

- Actual current source code is authoritative for implementation behavior. Distinguish committed revisions from uncommitted local changes.
- Actual execution evidence is authoritative for test, benchmark, and build results.
- Historical discussions and design proposals may be stale.
- Verify the active branch, HEAD, and working-tree status before proposing changes.
- Update this document at major implementation milestones.

### Verified implementation baseline

- Implementation commit: `b2fc5aa14b2b20c786d82f58e2022b367fb7eb07`.
- Merged PR #10: parser subprocess isolation and production lifecycle integration.
- Development workflow checkpoint: `8dfe6f1`, introducing `CONTRIBUTING.md`.
- Phase 4.5 introduces documentation and process improvements only. Consult Git history for its merge status.
- The next implementation milestone is Phase 5.1 architecture review.

This document does not replace inspecting actual source code.

## 2. Product Vision and Original Requirements

Archon is a Codebase Archaeologist and Impact-Analysis Engine for developers working with public JavaScript and TypeScript repositories.

Its intended users include onboarding engineers, developers refactoring shared modules, and reviewers evaluating downstream change risks.

Archon separates deterministic structural truth from semantic AI reasoning. Dependency graph extraction must remain independent of any LLM.

| Capability                   | Original requirement                                            | Implementation status     |
| ---------------------------- | --------------------------------------------------------------- | ------------------------- |
| Repository ingestion         | Public JS/TS repositories, up to 500 supported files and 50 MiB | Implemented               |
| Static dependency extraction | At least 95% sampled static-edge recall target                  | Implemented and evaluated |
| Graph persistence            | PostgreSQL nodes and edges                                      | Planned                   |
| Blast radius                 | Direct callers/importers and 2-3 hop transitive impact          | Planned                   |
| Hub detection                | Configurable incoming-edge threshold, default 30                | Planned                   |
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
| `packages/db`     | PostgreSQL schema, migrations, client, and ingestion repository                                   |
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

Key merged implementation checkpoints:

- PR #8: `a2cc2a5` - Static-analysis foundation.
- PR #9: `ea66fb6` - CALLS extraction and accuracy evaluation.
- PR #10: `b2fc5aa` - Parser subprocess isolation and production lifecycle.

Phase 5 implementation has not started at this baseline.

## 6. Current Ingestion Architecture

Normal ingestion flow:

1. Receive `POST /api/v1/repos`.
2. Validate the GitHub URL and resolve the repository commit.
3. Check repository size and supported-file limits.
4. Create or reuse PostgreSQL repository and ingestion-job records.
5. Enqueue BullMQ ingestion work.
6. Claim the job and start database heartbeats.
7. Download and safely extract the pinned GitHub archive.
8. Provide explicit supported-source and config inventories.
9. Execute analysis in an isolated parser child.
10. Validate the versioned IPC response and graph integrity.
11. Transition to `building_graph` at 85% progress.
12. Invoke the analysis-result handoff.
13. Conditionally transition to `ready` at 100% progress.

Implemented endpoints:

- `GET /api/v1/health`: PostgreSQL and Redis health, worker mode, and uptime.
- `POST /api/v1/repos`: accepts `githubUrl`, schedules ingestion or reuses an existing repository.
- `GET /api/v1/jobs/:jobId`: job status, progress, file statistics, and sanitized errors.

### Critical current-state distinction

For normally processed non-empty repositories, `ready` confirms successful ingestion, isolated analysis, and in-memory graph validation.

Repositories with no supported source files may become ready through the existing empty-repository fast path.

The current `AnalysisResultHandoff` invokes `noopAnalysisResultHandoff`.

Graph nodes and edges are not yet persisted or queryable in PostgreSQL.

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

The implemented schema at the Phase 4 baseline contains:

- `repositories`
- `ingestion_jobs`

Existing infrastructure includes:

- Repository and job status constraints.
- Job progress constraints.
- Repository-to-job cascade deletion.
- Partial active/ready repository uniqueness.
- Race-safe repository creation or reuse.
- Conditional terminal-state protection.
- Periodic 30-second heartbeats.
- Ten-minute stale-job recovery.
- Seven-day non-sample repository expiration.
- Sample repository expiration exemption.

The original PRD graph schema is a design proposal, not the implemented database schema.

Graph node and edge tables, graph ownership constraints, and graph publication transactions remain Phase 5 work.

Graph persistence and the repository/job ready transition must be designed together.

The final persistence schema, migration, transaction API, and retry-fencing strategy have not yet been approved.

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

## 10. Verified Phase 4 Results

### Automated verification

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

- Graph persistence is not implemented.
- Blast-radius query endpoints are not implemented.
- Hub detection is not implemented.
- Interactive frontend is not implemented.
- AI risk reports and embeddings are not implemented.
- Semantic search is not implemented.
- Hosted production deployment remains unverified.
- Original performance stretch targets remain incompletely validated.
- A known moderate dev-dependency audit finding remains in the drizzle-kit dependency chain.
- Conservative static-analysis limitations remain.
- Phase 5 requires separate persistence correctness and resource validation.

Do not introduce unrelated dependency upgrades or repeat accepted benchmarks without a concrete reason.

## 13. Remaining Roadmap

Historical product roadmap:

- Phase 5: Graph persistence, deterministic blast-radius queries, and hub detection.
- Phase 6: Citation-grounded Gemini risk reports.
- Phase 7: Interactive semantic-zoom architecture map.
- Phase 8: Blast-radius UI and snippet inspection.
- Phase 9: Embeddings and semantic search.
- Phase 10: End-to-end testing, hardening, and observability.
- Phase 11: Deployment and sample repository seeding.
- Phase 12: Final documentation and release.

### Immediate next scope

Phase 5.1 is a read-only database schema and graph-persistence architecture review.

The review must address:

1. Actual current database schema and migrations.
2. Exact graph DTO-to-database mapping.
3. Repository ownership and qualified-name identity.
4. Parent and edge endpoint integrity.
5. Nullable edge uniqueness.
6. Atomic graph publication and repository/job ready state.
7. Existing ready snapshots and empty-repository semantics.
8. Idempotency, retries, and uncertain commit outcomes.
9. Concurrent and stale-attempt fencing.
10. Bounded batching and resource consumption.
11. Cancellation, rollback, and transaction ownership.
12. Expiration and stale-job recovery interactions.
13. Real PostgreSQL and Redis integration tests.
14. Persistence-aware integrated Linux memory validation.

Graph persistence, blast-radius queries, and hub detection must be separately scoped and reviewed.

No final schema or production implementation is authorized by this handoff.

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
- [Phase 4 Parser Isolation and Validation Report](./phase-4-parser-isolation.md)
- [Evaluation and Benchmark Reproduction Guide](../scripts/README.md)

### Preserved external evidence

The following evidence is stored outside Git:

- `results/baseline/baseline-report.json`
- `results/post-correction-1/post-correction-report.json`
- `results/parser-isolation-benchmarks/matrix-windows-20261126-185846/reports/comparative-summary.json`
- `results/parser-isolation-benchmarks/matrix-windows-20261126-185846/reports/graph-diff-and-ndjson-audit.json`
- `results/parser-isolation-benchmarks/retention-windows-20261126-191737/retention-summary.json`
- `results/parser-isolation-benchmarks/linux-cgroup-20261126-195826/linux-matrix-summary.json`
- `results/parser-isolation-benchmarks/linux-integrated-e43-20261127-012841/e2-recovery-20261127-015128/e2-recovery-result.json`
- `results/parser-isolation-benchmarks/linux-integrated-e43-20261127-012841/e3-acceptance-audit.json`
- `results/parser-isolation-benchmarks/linux-integrated-e43-20261127-012841/e3-acceptance-summary.md`

Preserve the original evidence and immutable evaluation manifests. Do not commit raw experiment records or downloaded repository snapshots.
