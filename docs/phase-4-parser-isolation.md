# Phase 4: Parser Isolation and Production Validation

Phase 4 adds isolated static analysis to the production ingestion lifecycle. This report records the implementation and local verification evidence from the parser-isolation branch based on commit `ea66fb6ee5656b77ca399d9e3492cb62e3375d9f`.

The tracked report is a sanitized summary. Raw benchmark records, source bundles and external experiment controllers remain outside Git.

## Architecture and implementation

The Fastify API accepts public GitHub repositories and creates ingestion jobs. BullMQ workers acquire pinned commit tarballs into bounded ephemeral workspaces.

The production parser adapter passes explicit source and configuration inventories to a fresh compiled Node.js child process. Only the child loads the static-analysis compiler runtime.

- Shared graph DTOs and versioned single-request IPC contracts provide strict runtime and semantic validation.
- Responses are correlated with request IDs and checked for graph consistency, inventory constraints and serialized size.
- Parent and child communicate using JSON IPC.
- The parser child receives a minimal environment allowlist rather than inheriting application credentials or arbitrary Node.js flags.
- Target repository dependencies are never installed, and target source code is not executed.
- Production parser errors map to bounded, sanitized persisted errors.
- Automated import-isolation tests verify that the tested compiled parent entrypoints do not load the heavy compiler runtime.

The parent supervises cancellation, timeouts, child termination and cleanup. If termination or cleanup cannot be confirmed, the runner permanently latches fatal state and retains active ownership rather than releasing a workspace that a child might still be using.

The shared lifecycle coordinates standalone and embedded workers, startup ownership, HTTP shutdown, active job completion, database heartbeats, queue closure, Redis closure and PostgreSQL pool closure. The stale-job sweeper can recover abandoned nonterminal records when invoked; this does not release unresolved process ownership.

Validated analysis results pass through an explicit no-op handoff boundary before the repository becomes ready. Graph persistence is deferred to Phase 5.

## Production configuration

| Setting                        | Value                                         |
| ------------------------------ | --------------------------------------------- |
| Standard library loading       | Disabled explicitly at the production adapter |
| Child V8 old-space limit       | 256 MiB                                       |
| Parser timeout                 | 60,000 ms                                     |
| Serialized IPC response budget | 32 MiB                                        |
| Termination grace              | 2,000 ms                                      |
| Kill confirmation              | 3,000 ms                                      |
| Worker concurrency             | 1                                             |
| Supported source-file cap      | 500                                           |
| Repository-size cap            | 50 MiB                                        |
| Configuration-file cap         | 50                                            |
| Individual source-file cap     | 1 MiB                                         |
| File snippet cap               | 8,192 characters                              |
| Symbol snippet cap             | 4,096 characters                              |
| Call-site snippet cap          | 512 characters                                |

The old-space limit is not a total process-memory limit. The timeout initiates termination supervision; it does not guarantee that every cleanup operation settles within 60 seconds.

Core and lower-level runner defaults retain standard library loading. The production adapter explicitly selects `skipLoadingLibFiles: true`, with no automatic library-enabled fallback. The three frozen repository digests remained unchanged in tested configurations, but synthetic library-dependent resolution can differ.

## Verification scope

| Activity                             | Count |
| ------------------------------------ | ----: |
| Automated unit tests                 |   283 |
| Docker-backed integration tests      |    10 |
| Automated test suites                |    35 |
| Frozen evaluator executions          |    30 |
| Parser-only benchmark executions     |    87 |
| Integrated Linux live ingestion jobs |     3 |

These activities measure different properties and are not combined into one test count.

The final implementation regression passed clean, formatting, strict ESLint, typecheck, unit tests, build, integration tests and five immutable SHA-256 checks.

## Frozen static-analysis evaluation

The evaluator used 30 purposively selected source files out of 234 inventoried source files, with 10 annotated files per repository. AI-assisted annotations were frozen before initial predictions.

| Repository                          | Frozen commit                              |
| ----------------------------------- | ------------------------------------------ |
| pmndrs/zustand                      | `9fed2eb2f3af672da9f7bf694b996df3831fc207` |
| vercel/nextjs-subscription-payments | `bdd0813206e47e6b218d42f15a7976c8a0d3c3eb` |
| shadcn-ui/taxonomy                  | `298a8857c7128a0d121e7f699dfd729f23b3966d` |

| Scope         | Baseline TP / FP / FN | Corrected TP / FP / FN | Baseline recall | Corrected recall | Corrected F1 |
| ------------- | --------------------- | ---------------------- | --------------: | ---------------: | -----------: |
| IMPORTS       | 74 / 0 / 3            | 77 / 0 / 0             |          96.10% |             100% |         100% |
| Primary CALLS | 156 / 0 / 4           | 160 / 0 / 0            |          97.50% |             100% |         100% |
| Broader CALLS | 156 / 0 / 7           | 160 / 0 / 3            |          95.71% |           98.16% |       99.07% |

All corrected scopes recorded 100% sampled precision. BOM-aware source decoding and conservative JSX function-object augmentation resolution recovered the seven primary baseline misses.

Three predeclared broader React cache-wrapper relationships remain unsupported.

The evaluator recorded nine baseline runs, nine corrected runs, nine repeated corrected runs and three fresh-snapshot smoke runs. Corrected outputs reproduced the expected graph digests.

See the [evaluation documentation](../scripts/README.md) for the frozen scoring policy, baseline F1 values, source acquisition and reproduction procedures.

The corrected evaluation is a regression benchmark, not a human-certified or held-out generalization result.

## Parser-only isolation benchmarks

The 87 successful parser-only executions comprise three initial smoke runs, 18 Windows comparative runs, 60 sequential Windows retention runs and six constrained Linux runs.

### Windows comparative and retention experiments

The 18-run matrix tested three repositories, two standard-library configurations and three fresh-process repetitions. All runs reproduced the reference graph digests.

| Repository            | Median combined working set, libraries enabled | Median combined working set, libraries disabled |
| --------------------- | ---------------------------------------------: | ----------------------------------------------: |
| Zustand               |                                     376.29 MiB |                                      316.80 MiB |
| Subscription Payments |                                     269.25 MiB |                                      199.47 MiB |
| Taxonomy              |                                     293.54 MiB |                                      242.27 MiB |

The six retention sessions reused a lightweight parent for ten consecutive fresh parser children per session, without forced garbage collection. All 60 executions reproduced the expected graph digests and confirmed child cleanup.

No progressive parent-memory accumulation was demonstrated in these sessions. This does not prove the absence of memory leaks.

### Linux parser-only memory matrix

The Linux experiments used a 512 MiB memory limit with swap disabled, with one run per repository and library configuration.

| Repository            | Libraries enabled cgroup peak | Libraries disabled cgroup peak |
| --------------------- | ----------------------------: | -----------------------------: |
| Zustand               |                    224.85 MiB |                     160.74 MiB |
| Subscription Payments |                    171.10 MiB |                     122.98 MiB |
| Taxonomy              |                    182.96 MiB |                     142.17 MiB |

All six runs passed without OOM or swap usage and reproduced the reference graph digests.

Windows working-set and private-memory observations, child pre-send RSS and Linux cgroup memory have different accounting semantics. They are not interchangeable.

## Windows production ingestion and shutdown

Both standalone and embedded production ingestion smoke tests processed Zustand commit `5d66d53be80363b94491868b41325ea058fd16bb`, which differs from the frozen evaluation commit.

Each produced 49 parsed source files, 90 skipped archive files, 170 nodes, 66 IMPORTS edges, 630 CALLS edges, zero warnings and zero leftover extraction workspaces.

The PostgreSQL-recorded job durations were 4,065 ms in standalone mode and 4,064 ms in embedded mode. The embedded smoke also verified BullMQ completion with one attempt.

During initial API shutdown testing, both modes required a second Ctrl+C. Investigation found that `buildApp()` declared but never invoked its `onAppCreated` ownership callback.

Restoring `deps.onAppCreated?.(app)` immediately after Fastify construction and adding a targeted HTTP ownership regression test corrected the defect.

Both compiled API modes subsequently closed naturally after one native Ctrl+C, including Fastify HTTP closure and resource disposal, with application and PowerShell exit codes of zero.

## Integrated Linux 512 MiB memory gate

The actual production entrypoint `node apps/api/dist/server.js` ran as PID 1 with `NODE_ENV=production` and `RUN_EMBEDDED_WORKER=true`.

Runtime: Docker Desktop WSL2, Linux amd64, Node 24.14.0, npm 11.9.0 and bundled TypeScript 6.0.2.

Integrated image:

`archon-linux-integrated:20261127-012841`

Image ID:

`sha256:9c8281b02241d2bce2852ad148c9cda3c6a42f7d6efdfb6cd0e1864b8fe198b7`

Pinned base:

`node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8`

The service container included Fastify, BullMQ, database and Redis clients, and isolated parser children. PostgreSQL and Redis servers were external to its measured cgroup.

| Metric                                |            Result |
| ------------------------------------- | ----------------: |
| memory.max                            | 536,870,912 bytes |
| memory.swap.max                       |                 0 |
| Recovery attachment idle current      |         43.14 MiB |
| Attachment cumulative peak            |         49.67 MiB |
| Maximum observed cumulative peak      |        194.95 MiB |
| Exact observed peak bytes             |       204,419,072 |
| Percentage of memory limit            |            38.08% |
| Numerical remaining margin            |        317.05 MiB |
| Provisional engineering target        |           410 MiB |
| Pre-shutdown current                  |         80.52 MiB |
| Readable cgroup samples               |                27 |
| Observed swap, OOM and limit pressure |                 0 |
| Container restarts                    |                 0 |

The local evidence audit confirmed monotonically nondecreasing cumulative memory peaks.

### Sequential live workload

| Repository            | Resolved commit                            | Frozen SHA match |
| --------------------- | ------------------------------------------ | ---------------- |
| Zustand               | `5d66d53be80363b94491868b41325ea058fd16bb` | No               |
| Subscription Payments | `bdd0813206e47e6b218d42f15a7976c8a0d3c3eb` | Yes              |
| Taxonomy              | `298a8857c7128a0d121e7f699dfd729f23b3966d` | Yes              |

| Repository            | Parsed files | Nodes | IMPORTS | CALLS | Warnings |
| --------------------- | -----------: | ----: | ------: | ----: | -------: |
| Zustand               |           49 |   170 |      66 |   630 |        0 |
| Subscription Payments |           56 |   187 |     103 |   172 |        0 |
| Taxonomy              |          129 |   500 |     258 |   377 |        0 |
| Total                 |          234 |   857 |     427 | 1,179 |        0 |

| Repository            | Child analysis (ms) | Parser E2E (ms) | DB job (ms) | Sampled job current maximum (MiB) |
| --------------------- | ------------------: | --------------: | ----------: | --------------------------------: |
| Zustand               |             2311.32 |         3512.68 |        4771 |                            188.40 |
| Subscription Payments |              848.57 |         1637.06 |        2692 |                            170.28 |
| Taxonomy              |             1293.62 |         2008.38 |        3188 |                            176.27 |

All three public API requests returned HTTP 202 with `reused=false`. All jobs became ready at 100%, completed in BullMQ on their first attempt and left no extraction workspaces.

There were zero syntax-error skips, oversized source-file skips or analysis warnings. The combined graph contained 1,606 edges.

### Recovery, shutdown and evidence audit

The initial experiment controller failed health polling. Its typed-string default incorrectly attached a JSON body to GET requests; this defect was confirmed, although the original HTTP exception was not captured.

The first recovery attempt failed PID 1 inspection. Native argument quoting was corrected, together with an independently identified stdin-handling defect in the attachment validator.

The successful recovery attached to the same healthy running container without rebuilding, restarting or resetting memory counters. No production ingestion failed during these controller attachment attempts.

A single genuine SIGTERM produced confirmed application shutdown and natural container exit with code zero. The application shutdown log duration was 13 ms. Docker reported no OOM kill and no restarts.

The E.3 local evidence consistency audit accepted the results. Ownership-verified cleanup removed the stopped smoke container, isolated PostgreSQL database and smoke queue. Redis DB 14 returned to zero keys. Shared infrastructure and benchmark images were preserved.

## Preserved external evidence

The following artifact paths are relative to the external `results/parser-isolation-benchmarks/` directory. They are not tracked repository files.

Hashes were verified against the previously recorded local inspection before this report was written.

| External relative path                                                                     | Bytes | SHA-256                                                            |
| ------------------------------------------------------------------------------------------ | ----: | ------------------------------------------------------------------ |
| `matrix-windows-20261126-185846/reports/comparative-summary.json`                          | 32346 | `e74b1e74cf8d560b8f701faf0807d5a3a15d7c6b9cbabf256190810152b9d9f7` |
| `matrix-windows-20261126-185846/reports/graph-diff-and-ndjson-audit.json`                  |  6843 | `a647f4ac5569148f953f19d0e14ed9de5d39c5ee11f1119569c0faac9cff9f04` |
| `retention-windows-20261126-191737/retention-summary.json`                                 | 51529 | `2e9c0a72762f3ddfbb36f3c59a3caf38d90927fbbe51e1c5378cc791e12ac130` |
| `linux-cgroup-20261126-195826/linux-matrix-summary.json`                                   | 32871 | `952710f2b367e8dfcf6db0af506190dd1f55d1859efc172e11d0cc8906b22861` |
| `linux-integrated-e43-20261127-012841/e2-recovery-20261127-015128/e2-recovery-result.json` | 13841 | `7cc5ad795f00fa078fa941697bb4016d22d97332ac74fc7de0e7aafcae42a2c2` |
| `linux-integrated-e43-20261127-012841/e3-acceptance-audit.json`                            | 13733 | `d680db6b5d6e9bc0b73884f570fe025c2555e3c32d8017ca95160afb7efa025b` |
| `linux-integrated-e43-20261127-012841/e3-acceptance-summary.md`                            |  4688 | `f3d472b29c31c56c9d4440a4574780c936af66c2c918da101d9ab3df3ae5e5af` |

## Reproduction scope and limitations

- The repository provides the evaluator and Windows parser benchmark helpers. External Linux and retention controllers and raw evidence remain outside Git.
- The 194.95 MiB value is the highest observed cumulative cgroup peak, not an independent peak for each repository or a guaranteed exact peak through process exit.
- Memory counters were not reset. The recovery attachment baseline followed an extended idle period.
- Lightweight monitoring helpers ran inside the measured cgroup; their overhead was not independently measured.
- Three sequential live ingestions are smoke observations, not a statistically valid p95 benchmark. Database job durations exclude initial API prechecks.
- Matching graph counts in production smokes do not establish graph-digest parity or independent recall verification.
- The sampled recall evaluation does not establish universal accuracy or held-out generalization.
- The measured numerical memory margin is not guaranteed capacity for arbitrary 500-file repositories or future features.
- Persistent graph storage, blast-radius queries, embeddings, AI reports, visualization and cloud deployment remain future work.
- Phase 5 graph persistence requires separate transaction, correctness and memory validation.
- Local constrained Linux verification does not establish compatibility with a particular cloud hosting provider.
