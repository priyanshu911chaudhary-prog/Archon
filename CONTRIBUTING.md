# Contributing to Archon

This document defines the permanent development workflow, verification standards, and collaboration rules for Archon. It applies to solo development, AI-assisted implementation, and any future external contributions.

**Conventions used in this guide:**

- **Mandatory** rules use **must** / **must not** and are required for every accepted checkpoint or pull request.
- **Recommended** practices use **should** / **prefer** and represent the default engineering standard unless a concrete reason justifies a narrower alternative.

---

## 1. Development Principles

- **Deterministic structural truth:** Static analysis and dependency graph extraction must remain deterministic and independent of LLM reasoning.
- **Source authority:** The actual current source code is authoritative for implementation behavior. Distinguish committed revisions from uncommitted local changes. Historical discussions or design notes must not override current source.
- **Evidence authority:** Actual local or CI execution output is authoritative for test, build, and benchmark results. Expected outcomes must never be reported as passed results.
- **Scoped changes:** Keep changes focused, minimal, and reviewable. Do not bundle unrelated refactors into feature or documentation batches.
- **Zero-cost MVP constraint:** Archon must remain within its strict $0/month free-tier hosting and API budget.
- **Dependency discipline:** Do not add dependencies without a clear, justified need.
- **Preserve accepted behavior:** Preserve existing accepted behavior, contracts, and test baselines unless a change is intentional and explicitly verified.

---

## 2. Git Workflow

- **Protected `main` branch:** Direct implementation pushes to `main` are prohibited. All changes must land through a pull request.
- **Feature branches:** Create a dedicated feature branch per coherent unit of work (for example `feat/...`, `fix/...`, `docs/...`, `chore/...`).
- **Conventional Commits:** Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`, `ci:`).
- **Squash merge:** Pull requests must be squash-merged into `main` only after required checks pass.
- **History integrity:** Do not force-push or rewrite shared branch history without explicit authorization.
- **PR sizing:** Prefer smaller, independently reviewable and mergeable pull requests over monolithic phase-wide PRs.

> **Why incremental branch commits still matter:** Squash merging collapses a feature branch into one clean commit on `main`, but incremental commits on the active feature branch provide recoverable checkpoints during development, isolate regressions, and keep reviews manageable.

---

## 3. Mandatory Incremental Checkpoints

Do not accumulate an entire development phase as uncommitted local work. Every completed logical implementation batch **must** end with an explicit Git checkpoint:

1. **Focused implementation:** Complete one coherent, scoped batch.
2. **Local verification:** Run the appropriate verification commands for that batch.
3. **Changed-file review:** Inspect `git status` and diffs to confirm only intended files changed.
4. **Explicit staging allowlist:** Stage only the exact intended file paths.
5. **Staged-content & security review:** Run `git diff --cached --check` and inspect staged changes for unintended artifacts or secrets.
6. **Conventional Commit:** After review and developer authorization, commit with an accurate Conventional Commit message.
7. **Push:** Push the checkpoint commit to the active feature branch.
8. **Review gate:** Wait for checkpoint review and confirmation before starting the next batch.

**When to create a checkpoint:**

- After completed schema or data-model changes.
- After completed implementation units.
- After verified bug fixes.
- After meaningful test additions.
- After documentation updates.
- Before risky refactors, provided the existing work is independently valid.

**When not to commit:**

- Commits are not required after every individual file edit.
- Do not commit known broken code merely to satisfy a checkpoint schedule.

---

## 4. Verification Policy

Distinguish intermediate checkpoint verification from final PR acceptance gates.

### Intermediate Checkpoints (Focused Verification)

Run the checks relevant to the modified scope:

- Relevant formatting (`prettier --check` on modified files or workspace format check).
- Relevant strict ESLint checks.
- Typechecking and/or build when TypeScript interfaces, exports, or compiled entrypoints change.
- Focused unit or integration tests covering the modified modules.
- `git diff --check` (and `git diff --cached --check` after staging).
- Staged-content review and appropriate secret scanning.

### Final PR Acceptance Gates (Full Verification)

Before merging a PR into `main`, complete the required verification below. Documentation-only changes may use focused local checks while still requiring all mandatory GitHub CI checks.

- Full formatting check (`npm run format:check`).
- Full strict lint (`npm run lint`).
- Full typecheck (`npm run typecheck`).
- Full unit test suite (`npm test`).
- Full workspace build (`npm run build`).
- Relevant real-service integration tests (`npm run test:integration` with local Docker services healthy).
- Required GitHub Actions CI checks, dependency audit, and secret-scanning policies.

### Benchmarks & Reporting Honesty

- Do not repeat previously accepted expensive benchmarks unless an implementation change invalidates their evidence.
- Never present expected or predicted test outcomes as actual execution results.

---

## 5. Staging and Security

- **Explicit staging only:** Always stage files using an explicit path allowlist (`git add -- <paths>`). Avoid `git add .` and `git add -A` as the default workflow.
- **Forbidden artifacts:** Never commit credentials, `.env` files, `node_modules/`, compiled output (`dist/`, `*.tsbuildinfo`), coverage reports, raw experiment records, or downloaded target repository snapshots.
- **Immutable evaluation manifests:** Preserve existing frozen ground-truth manifests and their SHA-256 digests; never alter them to improve metrics.
- **Filename hygiene vs. secret scanning:** Checking staged filenames for forbidden paths is not a substitute for content-based secret scanning.
- **Handling security findings:** Never disable security or secret-scanning checks to bypass genuine findings. If a synthetic test fixture triggers a false positive, investigate it and resolve the fixture narrowly without weakening the scanner.
- **Unrelated local changes:** Preserve unrelated local changes rather than sweeping them into a checkpoint or discarding them silently.

---

## 6. Windows Development & Linux Compatibility

Local development runs on Windows using native **Windows PowerShell 5.1** while targeting **Linux** in containers and production. All commands and scripts must respect both environments:

- **PowerShell 5.1 syntax:** Do not use `&&` command chaining. Place commands on separate lines and check `$LASTEXITCODE` explicitly after every native command (`git`, `npm`, `npx`, `node`, `docker`).
- **File encoding & line endings:** Save source, config, and Markdown files as **UTF-8 without BOM** with **LF** line endings (follow the repository `.gitattributes` rules for file-specific line endings). Avoid PowerShell 5.1 `Out-File` or `echo >` for code/config files.
- **.NET file APIs:** Always pass **absolute filesystem paths** (for example via `Join-Path (Get-Location).Path ...`) when calling `[System.IO.File]::WriteAllText` or other .NET APIs, because .NET's working directory can differ from PowerShell's current location.
- **StrictMode & empty arrays:** Use `Set-StrictMode -Version Latest` and wrap command outputs in `@(...)` before checking `.Count` so single-item or empty results behave predictably.
- **Quoting:** Avoid fragile nested native-command quoting. Use explicit file arguments or iterate over file paths when native argument-array forwarding is unreliable.
- **Local service ports:** Local Docker Compose binds PostgreSQL to `127.0.0.1:5432` and Redis to `127.0.0.1:6380` (do not hardcode `6379`).
- **POSIX paths:** Normalize application-level repository paths to POSIX forward slashes for Linux production parity.

---

## 7. AI-Assisted Development Workflow

Archon uses a structured multi-role workflow:

- **Gemini (Implementation Partner):** Produces scoped implementation proposals, source code, focused tests, PowerShell-compatible execution commands, and explicit Git checkpoint instructions.
- **ChatGPT (Independent Reviewer):** Performs independent architecture, correctness, security, and resource-ownership review; verifies actual execution evidence; and accepts or rejects completed batches.
- **Developer (Owner & Operator):** Executes commands locally, reviews and authorizes all changes, supplies actual terminal output, and retains sole control over Git and GitHub operations.

**Hard rule for AI assistants:** AI assistants must never claim to have executed commands, observed terminal output, or inspected files that were not actually accessible in their context.

---

## 8. Source-Context Freshness

- **Identify revisions:** Every supplied source snapshot should identify its Git commit revision where possible.
- **Avoid stale assumptions:** Historical conversations and previously uploaded snapshots become stale after new commits. Refresh relevant source files after implementation checkpoints.
- **Request exact files:** If an exact current file is required, request that specific file rather than reconstructing it from memory.
- **Environment-specific transfer:** In this Gemini environment, prefer targeted plain-text source bundles or explicit read-only terminal excerpts. Do not assume ZIP entry listings establish readable source access, and do not assume native GitHub repository imports automatically synchronize new commits.

---

## 9. Phase Handoff Policy

At the end of each major phase, update the durable project handoff documentation (`docs/project-handoff.md`) with:

- Completed capabilities.
- Verified Git revision and merged PR number.
- Current automated test baseline.
- Important architectural decisions.
- Known limitations and outstanding technical debt.
- Next approved implementation scope.
- References to preserved evaluation and benchmark evidence.

Start a fresh AI conversation when an existing thread becomes unwieldy, seeding it from the durable handoff document and current plain-text source files.
