# Archon

Codebase archaeologist and blast-radius impact-analysis engine for TypeScript/JavaScript repositories.

Archon's design strictly separates **deterministic structural truth** (AST-extracted `IMPORTS` and `CALLS` dependency graphs) from **semantic reasoning** (planned citation-grounded Gemini AI risk reports).

## Implementation Status

Archon is built incrementally. The following sections distinguish implemented capabilities from the planned architecture.

### Implemented

- **Repository ingestion and job lifecycle:** Fastify API (`apps/api`), BullMQ worker (`apps/worker`), PostgreSQL (`packages/db`) for repository and job state, and Redis for queue infrastructure.
- **Deterministic static analysis engine (`packages/core`):** In-memory `ts-morph` (`28.0.0`, bundled TypeScript `6.0.2`) extraction of folder, file, function, class and symbol nodes; `IMPORTS` edges with direct barrel hops and local `tsconfig` aliases; and `CALLS` edges for supported functions, methods, constructors, `super()`, static CommonJS patterns and unambiguous internal JSX components, including recognized React `memo`/`forwardRef` wrappers and supported function-object augmentations. Supports strict BOM-aware UTF-8/UTF-16 source decoding without installing target dependencies or executing target source code.
- **Reproducible sampled-file evaluation (`scripts/`):** Local-directory precision, recall and F1 evaluation against SHA-256-frozen, AI-assisted reference manifests for three pinned open-source repositories.

- **Parser subprocess isolation and production worker integration:** A dedicated compiled Node.js parser child with versioned IPC, strict graph validation, bounded response size, memory and timeout controls, cancellation and fatal-state supervision, and a minimal child environment. Standalone and embedded worker modes use a shared resource-ownership lifecycle. Validated analysis results reach an explicit no-op handoff boundary before graph persistence.

### Planned / Not Yet Integrated

- **Persistent dependency graphs (Phase 5):** Store extracted nodes and edges in PostgreSQL.
- **Blast-radius query API:** Transitive impact traversal and dependency queries.
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
|   |-- db/           # PostgreSQL schema and repositories
|   `-- shared/       # Environment, graph and IPC contracts
|-- docs/             # Architecture and validation documentation
`-- scripts/          # Evaluator, frozen manifests and benchmarks
```

## Static Analysis & Sampled Evaluation

The Phase 4 local verification baseline records **283 unit tests across 33 suites** and **10 Docker-backed integration tests across 2 suites**, for **293 passing tests across 35 suites**. Integration coverage includes the real isolated parser child, PostgreSQL repository state, BullMQ job execution and lifecycle coordination.

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

See the [Phase 4 parser isolation and validation report](./docs/phase-4-parser-isolation.md) for detailed measurements, architecture, evidence references and limitations.

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

For standalone static analysis evaluation, follow [scripts/README.md](./scripts/README.md). Production parser integration is complete. Persistent graph storage is the next implementation phase.

<!-- CI bootstrap verified -->
