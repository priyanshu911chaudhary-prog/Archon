# Archon

Codebase archaeologist and blast-radius impact-analysis engine for TypeScript/JavaScript repositories.

Archon's design strictly separates **deterministic structural truth** (AST-extracted `IMPORTS` and `CALLS` dependency graphs) from **semantic reasoning** (planned citation-grounded Gemini AI risk reports).

## Implementation Status

Archon is built incrementally. The following sections distinguish implemented capabilities from the planned architecture.

### Implemented

- **Repository ingestion and job lifecycle:** Fastify API (`apps/api`), BullMQ worker (`apps/worker`), PostgreSQL (`packages/db`) for repository and job state, and Redis for queue infrastructure.
- **Deterministic static analysis engine (`packages/core`):** In-memory `ts-morph` (`28.0.0`, bundled TypeScript `6.0.2`) extraction of folder, file, function, class and symbol nodes; `IMPORTS` edges with direct barrel hops and local `tsconfig` aliases; and `CALLS` edges for supported functions, methods, constructors, `super()`, static CommonJS patterns and unambiguous internal JSX components, including recognized React `memo`/`forwardRef` wrappers and supported function-object augmentations. Supports strict BOM-aware UTF-8/UTF-16 source decoding without installing target dependencies or executing target source code.
- **Reproducible sampled-file evaluation (`scripts/`):** Local-directory precision, recall and F1 evaluation against SHA-256-frozen, AI-assisted reference manifests for three pinned open-source repositories.

### Planned / Not Yet Integrated

- **Parser subprocess isolation and worker wiring (Step 4.3):** Forked parser execution, timeout and memory controls, and integration of `packages/core` into the ingestion worker. The current ingestion parsing hook is not yet connected to the static analysis engine.
- **Persistent dependency graphs (Phase 5):** Store extracted nodes and edges in PostgreSQL.
- **Blast-radius query API:** Transitive impact traversal and dependency queries.
- **Interactive architecture visualization:** Next.js dependency graph inspector.
- **Semantic search and AI risk reports:** Vector embeddings and citation-grounded Gemini analysis.

## Workspace Structure

```text
archon/
├── apps/
│   ├── api/          # Fastify REST API and ingestion job endpoints
│   └── worker/       # BullMQ background ingestion worker
├── packages/
│   ├── core/         # Deterministic static analysis (nodes, IMPORTS, CALLS)
│   ├── db/           # Drizzle schema, migrations and PostgreSQL repositories
│   └── shared/       # Shared schemas, path filters, env validation and logging
└── scripts/          # Local evaluator and frozen reference manifests
```

## Static Analysis & Sampled Evaluation

The Archon workspace passes **175 unit tests** across 25 suites, including 63 core analysis tests and 19 evaluator tests, plus **6 Docker-backed integration tests** covering existing PostgreSQL repository and BullMQ worker infrastructure.

The post-correction regression evaluation scored a purposive sample of 30 of 234 supported source files (approximately 12.8%) across `pmndrs/zustand`, `vercel/nextjs-subscription-payments` and `shadcn-ui/taxonomy`, all pinned to specific commits.

| Evaluation scope | Recovered / expected | Precision | Recall |     F1 |
| :--------------- | -------------------: | --------: | -----: | -----: |
| `IMPORTS`        |              77 / 77 |      100% |   100% |   100% |
| Primary `CALLS`  |            160 / 160 |      100% |   100% |   100% |
| Broader `CALLS`  |            160 / 163 |      100% | 98.16% | 99.07% |

All 237 primary reference relationships were recovered with zero sampled false positives. The three remaining broader-reference misses involve intentionally unsupported `React.cache()` wrapper-extension cases.

All three corrected graphs were deterministic across three fresh-process runs per repository. Full-repository extraction produced 857 nodes and 1,606 edges across 234 parsed source files with zero analysis warnings. Only the annotated source-file scope was scored for accuracy.

These are regression results on frozen, AI-assisted, pre-prediction-reviewed reference manifests, not universal accuracy claims or a held-out generalization benchmark. See [the evaluation documentation](./scripts/README.md) for the methodology, original baseline, measured results, limitations and reproduction commands.

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

For standalone static analysis evaluation, follow [scripts/README.md](./scripts/README.md). Production parser integration and graph persistence are upcoming steps.

<!-- CI bootstrap verified -->
