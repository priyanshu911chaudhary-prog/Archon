# Archon

Codebase archaeologist and blast-radius impact-analysis engine for TypeScript/JavaScript repositories.

Archon's design strictly separates **deterministic structural truth** (AST-extracted `IMPORTS` and `CALLS` dependency graphs) from **semantic reasoning** (planned citation-grounded Gemini AI risk reports).

## Implementation Status

Archon is built incrementally. The following sections distinguish implemented capabilities from the planned architecture.

### Implemented

- **Repository ingestion and job lifecycle:** Fastify API (`apps/api`), BullMQ worker (`apps/worker`), PostgreSQL (`packages/db`) for repository and job state, and Redis for queue infrastructure.
- **Deterministic static analysis engine (`packages/core`):** In-memory `ts-morph` (`28.0.0`, bundled TypeScript `6.0.2`) extraction of folder, file, function, class and symbol nodes; `IMPORTS` edges with direct barrel hops and local `tsconfig` aliases; and `CALLS` edges for supported functions, methods, constructors, `super()`, static CommonJS patterns and unambiguous internal JSX components, including recognized React `memo`/`forwardRef` wrappers and supported function-object augmentations. Supports strict BOM-aware UTF-8/UTF-16 source decoding without installing target dependencies or executing target source code.
- **Reproducible sampled-file evaluation (`scripts/`):** Local-directory precision, recall and F1 evaluation against SHA-256-frozen, AI-assisted reference manifests for three pinned open-source repositories.

- **Parser subprocess isolation (`apps/worker`):** A dedicated compiled Node.js parser child (`skipLoadingLibFiles: true`, 256 MiB V8 old-space, 60 s timeout, 32 MiB IPC budget, concurrency 1) with versioned IPC, strict graph validation, cancellation and fatal-state supervision, and a minimal child environment. Standalone and embedded worker modes share one resource-ownership lifecycle.
- **Atomic PostgreSQL graph persistence and ownership fencing (`packages/db`, `apps/worker`, `apps/api`):** Persists extracted `nodes` and `edges` atomically in bounded PostgreSQL 17 transactions (`<= 200` nodes, `<= 500` edges, `<= 1 MiB` batch budget) together with `graph_persisted_at` and the `ready` transition (`progress_pct = 100`). Enforces BullMQ `attemptsStarted` delivery-generation fencing, five-outcome `NOWAIT` heartbeats, locked uncertain-`COMMIT` reconciliation, atomic legacy-ready recovery, verified-empty creation, terminal-only expiration deletion, and authoritative extraction/parser file-and-skip count accounting.
- **Graph query APIs, deterministic blast radius and hub detection (`packages/shared`, `packages/db`, `apps/api`):** Read-only `REPEATABLE READ READ ONLY` HTTP endpoints for folder/file/function semantic zoom (`GET /api/v1/repos/:repoId/graph`), node detail and snippet retrieval (`GET /api/v1/repos/:repoId/nodes/:nodeId`), cursor-paginated edge evidence (`GET /api/v1/repos/:repoId/nodes/:nodeId/edges`), bounded 1–3 hop reverse-edge blast radius (`GET /api/v1/repos/:repoId/nodes/:nodeId/blast-radius`), and configurable hub detection (`GET /api/v1/repos/:repoId/hubs`, strict `inDegreeDistinct > HUB_THRESHOLD` default `30`), protected by shared graph-read Redis rate limiting and bounded concurrency admission (`2` embedded / `3` standalone).

### Planned / Not Yet Integrated

- **Interactive architecture visualization:** Next.js dependency graph inspector.
- **Semantic search and AI risk reports:** Vector embeddings and citation-grounded Gemini analysis.
- **Cloud deployment:** Hosted production deployment and verification remain planned.

## Workspace Structure

```text
archon/
|-- apps/
|   |-- api/          # Fastify API and embedded worker integration
|   `-- worker/       # Ingestion, parser child, runner and lifecycle
|-- packages/
|   |-- core/         # Deterministic static analysis
|   |-- db/           # PostgreSQL schema, migrations, graph persistence and repositories
|   `-- shared/       # Environment, graph and IPC contracts
|-- docs/             # Architecture and validation documentation
`-- scripts/          # Evaluator, frozen manifests and benchmarks
```

## Static Analysis & Sampled Evaluation

The Phase 6 local verification baseline (`76ab23f`, pending Phase 6 PR merge) records **334 unit tests across 39 suites** and **45 Docker-backed integration tests across 10 suites**, for **379 passing tests across 49 suites** (up from 356 in Phase 5 and 293 in Phase 4). Integration coverage exercises real PostgreSQL 17 + Redis 7 graph zoom, blast-radius BFS with independent oracles, hub boundaries, shared Redis rate limiting, ownership fencing, atomic graph publication, compiled parser-child execution, and graceful lifecycle shutdown.

The post-correction regression evaluation scored a purposive sample of 30 of 234 supported source files (approximately 12.8%) across `pmndrs/zustand`, `vercel/nextjs-subscription-payments` and `shadcn-ui/taxonomy`, all pinned to specific commits.

| Evaluation scope | Recovered / expected | Precision | Recall |     F1 |
| :--------------- | -------------------: | --------: | -----: | -----: |
| `IMPORTS`        |              77 / 77 |      100% |   100% |   100% |
| Primary `CALLS`  |            160 / 160 |      100% |   100% |   100% |
| Broader `CALLS`  |            160 / 163 |      100% | 98.16% | 99.07% |

All 237 primary reference relationships were recovered with zero sampled false positives. The three remaining broader-reference misses involve intentionally unsupported `React.cache()` wrapper-extension cases.

All three corrected graphs were deterministic across three fresh-process runs per repository. Full-repository extraction produced 857 nodes and 1,606 edges across 234 parsed source files with zero analysis warnings. Only the annotated source-file scope was scored for accuracy.

These are regression results on frozen, AI-assisted, pre-prediction-reviewed reference manifests, not universal accuracy claims or a held-out generalization benchmark. See [the evaluation documentation](./scripts/README.md) for the methodology, original baseline, measured results, limitations and reproduction commands.

## Parser Isolation and Production Memory Validation

The production worker uses an isolated parser child with a 256 MiB V8 old-space limit, a 60-second parser timeout, a 32 MiB IPC response budget, and worker concurrency of one. Production explicitly disables standard library loading, based on the measured frozen-repository benchmark results.

The integrated Linux service memory gate exercised the actual compiled Fastify API, embedded BullMQ worker and isolated parser child under a 512 MiB cgroup memory limit with swap disabled. PostgreSQL and Redis servers remained external to the measured container.

| Measurement                             | Observed result |
| --------------------------------------- | --------------: |
| Maximum observed cumulative cgroup peak |      194.95 MiB |
| Percentage of 512 MiB limit             |          38.08% |
| Sequential live ingestions completed    |           3 / 3 |
| Source files parsed                     |             234 |
| Extracted graph nodes                   |             857 |
| Extracted IMPORTS and CALLS edges       |           1,606 |
| Analysis warnings                       |               0 |
| Observed swap, OOM events and restarts  |               0 |
| Natural container exit code             |               0 |

These are three sequential local Linux smoke observations, not a p95 benchmark, proof of arbitrary 500-file support, or a memory guarantee for future graph persistence.

See the [Phase 4 parser isolation and validation report](./docs/phase-4-parser-isolation.md) for the preserved historical Phase 4 baseline (API + embedded worker with the historical `noopAnalysisResultHandoff`, zero graph writes).

### Phase 5.6 Atomic Graph Persistence Benchmark (512 MiB Linux Cgroup)

Phase 5.6 validated full standalone-worker ingestion (mounted local tarballs, isolated `parser-child.js`, graph planning, and atomic PostgreSQL publication) in one persistent container (`memory.max = 512 MiB`, `memory.swap.max = 0`, external PostgreSQL 17 and Redis 7):

- **Workloads completed:** 11/11 sequential ingestions (3 cycles × 3 frozen repos with 9/9 exact persistence-only `nodes`/`edges` projection matches + 2 identical runs of a deterministic 480-file synthetic stress workload emitting 2,897 nodes and 3,252 edges across 15/7 batches per run; **8,365 nodes** and **11,322 edges** total).
- **Cgroup memory & hygiene:** Pre-shutdown kernel `memory.peak` = **211.11 MiB** (`221,368,320` bytes, `41.23%`), startup -> final idle `memory.current` = `45.54` -> `96.29 MiB` (`+50.75 MiB`), zero OOM/OOM-kill/`max`/swap events, zero failed jobs/duplicate rows/leftover workspaces, graceful exit `0`, and verified non-forced cleanup.
- **Caveats:** Standalone/local-tarball scope differs from Phase 4's embedded live smoke; parity covers persisted `nodes`/`edges` projections only (not full `AnalysisOutput` digests); synthetic runs test repeat determinism only; observed `+50.75 MiB` idle growth does not prove leak-free long-term operation; and results do not establish p95 latency or universal 500-file capacity. See [docs/phase-5-graph-persistence.md](./docs/phase-5-graph-persistence.md).

### Phase 6.5 Graph Query API & Blast-Radius Validation (512 MiB Linux Cgroup)

Phase 6.5 validated all five HTTP graph endpoints under `512 MiB` (`memory.swap.max = 0`, external PostgreSQL 17 and Redis 7) across combined original, supplemental, and final recovery runs (no production code changes required):

- **Latency & correctness:** 700/700 valid primary blast-radius responses across 7 workloads (p95 `6.00 ms`–`48.86 ms`, all `< 200 ms`, 7/7 representative node-hop oracle parity), 150/150 valid secondary endpoint responses (p95 `13.41 ms`–`114.28 ms`), and verified non-overlapping edge pagination (`10.51 ms` / `8.73 ms`, `n = 1` each).
- **Resources & guards:** Pre-shutdown cgroup peaks of **75.07 MiB** standalone (`+24.84 MiB` idle delta) and **188.46 MiB** embedded (`+10.16 MiB` idle delta), zero recorded OOM events with swap disabled, verified `422` scope/budget rejections, shared `429` rate-limit isolation and recovery, embedded parser/read overlap, and active-DB `SIGTERM` drain (`HTTP 200`, `exit 0`). Local Docker observations are not hosted production latency or leak-free guarantees. See [docs/phase-6-graph-queries.md](./docs/phase-6-graph-queries.md).

## Prerequisites

- Node.js 24 LTS (see `.nvmrc`)
- npm 11+
- Git
- Docker Desktop (Linux containers / WSL2 backend on Windows)

## Quick Start (Windows PowerShell)

Run from the Archon repository root. Create a local `.env` only if one does not already exist, and configure it using `.env.example`. Never commit credentials or `.env` files.

```powershell
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
}

npm install
npm run docker:up
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Run the existing integration suite with the local PostgreSQL and Redis containers healthy:

```powershell
docker compose ps
npm run test:integration
```

Local Docker endpoints use PostgreSQL at `127.0.0.1:5432` and Redis at `127.0.0.1:6380`. The integration tests use the configured local environment rather than a production database.

For standalone static analysis evaluation and benchmark context, follow [scripts/README.md](./scripts/README.md). Graph Query APIs, Blast Radius and Hub Detection (Phase 6) are complete on `feat/phase-6-graph-queries` (pending PR merge); **Phase 7** (Citation-Grounded Gemini Risk Reports) is the next implementation milestone.

<!-- CI bootstrap verified -->

## Development and Project Handoff

- [Contributing and Development Workflow](CONTRIBUTING.md) — development standards, incremental Git checkpoints, verification requirements, and contribution rules.
- [Phase 6 Graph Queries & Blast-Radius Report](docs/phase-6-graph-queries.md) — HTTP query contracts, semantic zoom, bounded BFS blast radius, hub semantics, rate limiting, admission, and Linux benchmark evidence.
- [Phase 5 Graph Persistence Report](docs/phase-5-graph-persistence.md) — schema, ownership fencing, legacy recovery, atomic publication, count invariants, and Linux benchmark evidence.
- [Phase 4 Parser Isolation Report](docs/phase-4-parser-isolation.md) — preserved historical Phase 4 parser isolation and embedded-worker smoke baseline.
- [Project Handoff and Context Guide](docs/project-handoff.md) — architecture, implementation status, verified results, known limitations, and continuation guidance.
