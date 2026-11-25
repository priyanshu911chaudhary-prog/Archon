# Static Analysis Precision & Recall Evaluation

Pure local-directory evaluator measuring `IMPORTS` and `CALLS` precision, recall, and F1 of `@archon/core`'s `analyzeRepository` against AI-assisted, pre-prediction-reviewed, SHA-256-frozen reference manifests for three pinned open-source repositories.

- **Zero network requests inside the evaluator:** Snapshot acquisition is strictly separated from evaluation.
- **Zero target dependency installation or target code execution:** The evaluator does not install target dependencies, run target lifecycle scripts or execute target source/configuration code. Snapshot acquisition disables Git hooks and symlink checkout.
- **Full-repository analysis, sampled-file scoring:** `analyzeRepository` analyzes the entire verified snapshot (`skipLoadingLibFiles: false`, `maxCallSiteSnippetChars: 512`) so declarations in unselected files remain valid targets. Predicted edges are filtered strictly by emitted `ExtractedNode.filePath` membership in `selectedSourceFiles`.

---

## Frozen Ground-Truth Manifests & Pinned Snapshots

| Repository                            | Pinned Commit SHA                          | Manifest                                                 | Frozen Manifest SHA-256                                            | Selected / Inventoried Source Files | Config Files | Expected `IMPORTS` | Primary `CALLS` | Broader `CALLS` | Grouped Exclusions |
| :------------------------------------ | :----------------------------------------- | :------------------------------------------------------- | :----------------------------------------------------------------- | :---------------------------------: | -----------: | -----------------: | --------------: | --------------: | -----------------: |
| `pmndrs/zustand`                      | `9fed2eb2f3af672da9f7bf694b996df3831fc207` | `scripts/ground-truth/zustand.json`                      | `f51de18e9df3ae8ba5f0f9c95f3c4f0758b5df6dd4969d55ba3abce526148739` |               10 / 49               |            5 |                 14 |              31 |              31 |                 66 |
| `vercel/nextjs-subscription-payments` | `bdd0813206e47e6b218d42f15a7976c8a0d3c3eb` | `scripts/ground-truth/nextjs-subscription-payments.json` | `11e5976ebd0d121fd4f0e5935a4e51458649f29f0c4f3197a6fd798336d72dc0` |               10 / 56               |            2 |                 33 |              90 |              93 |                 44 |
| `shadcn-ui/taxonomy`                  | `298a8857c7128a0d121e7f699dfd729f23b3966d` | `scripts/ground-truth/taxonomy.json`                     | `968e99b0ab8a122aa31051a0cf5c7177672484134485408f0538b0b12861d03c` |              10 / 129               |            2 |                 30 |              39 |              39 |                 47 |
| **Aggregate**                         | —                                          | —                                                        | —                                                                  |        **30 / 234 (~12.8%)**        |        **9** |             **77** |         **160** |         **163** |            **157** |

Declared uncertain candidates across all three manifests: **0**. The 157 exclusion entries are grouped supplementary audit records, not an exhaustive count of individual excluded expressions.

---

## Frozen Scoring Policy

1. **Canonical edge identities (collision-safe JSON tuples):**
   - `IMPORTS`: `(sourceQualifiedName, targetQualifiedName, "IMPORTS")`
   - `CALLS`: `(sourceQualifiedName, targetQualifiedName, "CALLS", callSiteLine)`
2. **Primary vs. Broader `CALLS`:**
   - Exactly three predeclared `React.cache()`-wrapped internal query calls in `vercel/nextjs-subscription-payments` separate Primary from Broader `CALLS`:
     - `app/page.tsx::fn:PricingPage -> utils/supabase/queries.ts::sym:getUser @L12`
     - `app/page.tsx::fn:PricingPage -> utils/supabase/queries.ts::sym:getProducts @L13`
     - `app/page.tsx::fn:PricingPage -> utils/supabase/queries.ts::sym:getSubscription @L14`
   - **Primary `CALLS`:** Removes ONLY these three exact canonical identities from both expected and predicted sets; exact predictions are reported separately as unscored wrapper-extension predictions. A wrong-line or wrong-target prediction is **not** exempt and counts as an FP.
   - **Broader `CALLS`:** Retains all three identities in the expected denominator so their omission stays visible.
3. **Source encoding (`types_db.ts`):** `vercel/nextjs-subscription-payments`'s `types_db.ts` (19,536 bytes) is committed as UTF-16LE with BOM. The three annotated incoming `IMPORTS` edges remain in the frozen IMPORTS reference set. Authoritative snapshot verification hashes raw on-disk bytes rather than UTF-8-decoded JSON strings.
4. **Metrics & aggregation:**
   - Set-based `TP`, `FP`, `FN` computed per repository; graph integrity (unique nodes, valid parents, existing endpoints, unique edges, consistent stats) is enforced before scoring.
   - Zero denominators return `null` (`N/A`), never `100%`.
   - Cross-repository aggregates micro-average raw summed `TP`, `FP`, and `FN` counts (never averaging per-repository percentages) and evaluate the 95% recall threshold at full precision.

---

## Measured Results (Original Baseline vs. Post-Correction Regression)

Both original evaluation rounds executed **9 fresh-process runs** (3 per repository) using the compiled entrypoint (`node scripts/dist/evaluate-recall.js`) under identical settings:

- **Runtime environment:** Node `v24.14.0`, bundled TypeScript `6.0.2`, `win32` / `x64`
- **Analysis options:** `skipLoadingLibFiles: false`, `maxCallSiteSnippetChars: 512`
- **Determinism:** Identical `graphDigest` across all 3 fresh-process repetitions for every repository in both rounds
- **Preserved external report artifacts (stored outside Git):**
  - Original baseline: `C:\dev\archon-eval\results\baseline\baseline-report.json` (SHA-256: `894d9a69f361484934a9969c740c668fb1ab9ebde352196b98aa55f63bd1b8f8`)
  - Post-correction regression: `C:\dev\archon-eval\results\post-correction-1\post-correction-report.json` (SHA-256: `9206f9efd756427d888128396b1f21d5d7527c04ca22bac1a65e7a70e69e31f0`)

### Aggregate Micro-Averaged Comparison (30 Sampled Files)

| Evaluation Round    | Scope               | Expected | Predicted |      TP |    FP |    FN |   Precision |      Recall |          F1 | >= 95% Target |
| :------------------ | :------------------ | -------: | --------: | ------: | ----: | ----: | ----------: | ----------: | ----------: | :-----------: |
| Original Baseline   | `IMPORTS`           |       77 |        74 |      74 |     0 |     3 |     100.00% |      96.10% |      98.01% |     PASS      |
| Original Baseline   | Primary `CALLS`     |      160 |       156 |     156 |     0 |     4 |     100.00% |      97.50% |      98.73% |     PASS      |
| Original Baseline   | Broader `CALLS`     |      163 |       156 |     156 |     0 |     7 |     100.00% |      95.71% |      97.81% |     PASS      |
| **Post-Correction** | **`IMPORTS`**       |   **77** |    **77** |  **77** | **0** | **0** | **100.00%** | **100.00%** | **100.00%** |   **PASS**    |
| **Post-Correction** | **Primary `CALLS`** |  **160** |   **160** | **160** | **0** | **0** | **100.00%** | **100.00%** | **100.00%** |   **PASS**    |
| **Post-Correction** | **Broader `CALLS`** |  **163** |   **160** | **160** | **0** | **3** | **100.00%** |  **98.16%** |  **99.07%** |   **PASS**    |

**Targeted corrections applied between baseline and post-correction:**

1. **D.1 BOM-aware source decoding (`packages/core/src/discovery.ts`):** Added strict UTF-8 / UTF-8 BOM / UTF-16LE BOM / UTF-16BE BOM decoding while rejecting malformed/truncated encodings and preserving raw-byte accounting. Recovered `types_db.ts` (`56/56` parsed, `0` warnings) and all three sampled Payments `IMPORTS` false negatives. The full Payments graph gained seven net `IMPORTS` edges.
2. **D.2 JSX function-object augmentation (`packages/core/src/calls-extractor.ts`):** Added a narrow `category === 'jsx'`-only check skipping top-level `Component.property = value` receiver `Identifier` declarations when the same underlying checker symbol has a concrete mapped function or `const` arrow/function-expression implementation in the same authoritative source file. Recovered all 4 sampled Taxonomy JSX `CALLS` FNs (`PostItem`, `EmptyPlaceholder`, `AlertDialogHeader`, `AlertDialogFooter`) and eight net `CALLS` edges across the full Taxonomy graph, with zero new sampled false positives. Zustand's full graph digest remained unchanged between rounds.

### Per-Repository Post-Correction Metrics, Graph Totals & Preliminary Performance

| Repository                              | Sampled `IMPORTS` | Sampled Primary `CALLS` | Sampled Broader `CALLS` | Parsed Files  | Total Graph Nodes | Total Graph `IMPORTS` | Total Graph `CALLS` | Warnings | Median Analysis Duration (3 runs) | Representative Process-Lifetime `maxRSS` | Canonical Graph Digest                                             |
| :-------------------------------------- | :---------------: | :---------------------: | :---------------------: | :-----------: | ----------------: | --------------------: | ------------------: | -------: | --------------------------------: | ---------------------------------------: | :----------------------------------------------------------------- |
| `pmndrs/zustand`                        |      14 / 14      |         31 / 31         |         31 / 31         |    49 / 49    |               170 |                    66 |                 630 |        0 |                        2251.16 ms |                318,808 KiB (~311.34 MiB) | `97124aa98acff926bc1ef4fe9b968aff6bf8b35f2987f92f61b7bbe0d98543af` |
| `vercel/nextjs-subscription-payments`   |      33 / 33      |         90 / 90         |         90 / 93         |    56 / 56    |               187 |                   103 |                 172 |        0 |                        1156.13 ms |                237,088 KiB (~231.53 MiB) | `530baa46477a8ebe5418639b31f65eeb1ee45b29ba1d1c42fe2e9b8c98aa3f9a` |
| `shadcn-ui/taxonomy`                    |      30 / 30      |         39 / 39         |         39 / 39         |   129 / 129   |               500 |                   258 |                 377 |        0 |                        1437.85 ms |                240,572 KiB (~234.93 MiB) | `de7edaea1ecc41aecb35baa6872b055a78aa90087e2b1c7a3908b60680534aed` |
| **Totals (Full Graph / Sampled Scope)** |    **77 / 77**    |      **160 / 160**      |      **160 / 163**      | **234 / 234** |           **857** |               **427** |           **1,179** |    **0** |                                 — |                                        — | —                                                                  |

---

### Historical Performance Comparison

| Repository | Original median (ms) | Corrected median (ms) | Original run-1 maxRSS (KiB) | Corrected run-1 maxRSS (KiB) |
| :--------- | -------------------: | --------------------: | --------------------------: | ---------------------------: |
| Zustand    |              2298.26 |               2251.16 |                      321600 |                       318808 |
| Payments   |              1052.01 |               1156.13 |                      221624 |                       237088 |
| Taxonomy   |              1663.83 |               1437.85 |                      256848 |                       240572 |

These memory values are representative process-lifetime high-water RSS measurements, not the maximum across every repetition.

### Additional Reproduction

A further nine-run experiment using regenerated source bundles and the existing verified pinned checkouts reproduced all three corrected full graph digests and all sampled accuracy counts (77/77 IMPORTS, 160/160 primary CALLS, 160/163 broader CALLS). The original and corrected report files remained unchanged.

This confirms repeatability of evaluation on those checkouts. The original documentation's fresh-fetch command failed because a Markdown link was embedded in its URL string; the corrected fresh-acquisition recipe below still requires a local smoke test.

## Methodological Honesty, Limitations & Step 4.3 Watch Items

- **Purposive sample (not random or exhaustive):** Only 30 of 234 inventoried source files (`~12.8%`) were scored. Do **not** generalize these numbers to universal repository-wide 100% precision or recall, and do **not** treat the 1,606 full-graph edges (`427 IMPORTS + 1,179 CALLS`) as independently verified.
- **Annotation provenance:** Reference manifests were prepared through AI-assisted source annotation and reviewed against the pinned source before analyzer predictions were generated. They are **not** human-certified ground truth.
- **Regression vs. held-out generalization:** The post-correction evaluation reuses the same frozen 30-file reference set used to diagnose D.1 and D.2. It is a regression evaluation, not an independent held-out generalization benchmark.
- **Historical baseline reproducibility:** The original baseline was generated from the pre-correction development working tree, before D.1 and D.2 were applied. There was no separate pre-correction commit. Reproducing that exact historical behavior requires restoring the corresponding source state; running the corrected implementation reproduces the corrected evaluation, not the historical baseline.
- **Intentionally unsupported wrapper extensions:** The 3 `React.cache()`-wrapped internal query calls in Payments remain unsupported and visible as FNs in Broader `CALLS` (`160 / 163`, `98.16%`).
- **Preliminary timing caveat:** Three fresh-process repetitions per repository measure analysis wall-clock duration only (excluding snapshot acquisition and verification). They are preliminary timing observations, not a statistically robust p95 benchmark; the PRD 200-file p95 end-to-end latency target remains unverified.
- **Memory watch item (Step 4.3 deployment concern):** Representative standalone evaluator process-lifetime `maxRSS` (`~311.34 MiB` Zustand, `~231.53 MiB` Payments, `~234.93 MiB` Taxonomy) exceeds the preliminary preferred `200 MiB` parser-process budget. `process.resourceUsage().maxRSS` reflects the full Node process lifetime (not isolated parser-child peak RSS), and combined API + worker + parser memory against the planned `512 MB` free hosting budget remains unverified until Step 4.3.

---

## Reproducing the Evaluation from Scratch

Keep downloaded snapshots, source bundles and reports outside the Archon workspace. The commands below use a fresh external directory, `C:\dev\archon-eval-repro`, and never overwrite the historical experiments in `C:\dev\archon-eval`. If the new directory already exists, choose a different unused path and update the same path consistently in Steps 2–5.

### Step 1 — Build Archon Prerequisites

```powershell
Set-Location C:\dev\archon
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }
```

Verify the exact frozen reference manifests before acquiring or analyzing snapshots:

```powershell
$expectedDigests = @{
    'scripts/ground-truth/zustand.json' = 'f51de18e9df3ae8ba5f0f9c95f3c4f0758b5df6dd4969d55ba3abce526148739'
    'scripts/ground-truth/nextjs-subscription-payments.json' = '11e5976ebd0d121fd4f0e5935a4e51458649f29f0c4f3197a6fd798336d72dc0'
    'scripts/ground-truth/taxonomy.json' = '968e99b0ab8a122aa31051a0cf5c7177672484134485408f0538b0b12861d03c'
}

foreach ($item in $expectedDigests.GetEnumerator()) {
    $actual = (Get-FileHash -Path $item.Key -Algorithm SHA256 -ErrorAction Stop).Hash.ToLower()

    if ($actual -ne $item.Value) {
        throw "Frozen manifest digest mismatch: $($item.Key)"
    }

    Write-Host "VERIFIED: $($item.Key)" -ForegroundColor Green
}
```

The build produces the shared/core workspace entrypoints and `scripts/dist/evaluate-recall.js`. The evaluator needs no running PostgreSQL or Redis instance and no target repository dependencies.

### Step 2 — Acquire the Three Pinned Snapshots

Use a trusted local Git installation and configuration (no untrusted external checkout filters). Network access is needed only for this acquisition and installation of Archon's own dependencies. The recipe disables repository hooks and symlink checkout, avoids automatic CRLF conversion, checks out exact pinned commits into new directories, and never runs target code or installs target packages. It does not force-checkout or overwrite any existing repositories.

```powershell
Set-Location C:\dev\archon

$evalRoot = 'C:\dev\archon-eval-repro'

if (Test-Path $evalRoot) {
    throw "Choose a fresh evaluation directory: $evalRoot"
}

New-Item -ItemType Directory -Path $evalRoot -ErrorAction Stop | Out-Null

$emptyHooksDir = Join-Path $evalRoot '_empty_hooks'
New-Item -ItemType Directory -Path $emptyHooksDir -ErrorAction Stop | Out-Null

$repos = @(
    @{
        Name = 'zustand'
        Repo = 'pmndrs/zustand'
        Sha = '9fed2eb2f3af672da9f7bf694b996df3831fc207'
    },
    @{
        Name = 'nextjs-subscription-payments'
        Repo = 'vercel/nextjs-subscription-payments'
        Sha = 'bdd0813206e47e6b218d42f15a7976c8a0d3c3eb'
    },
    @{
        Name = 'taxonomy'
        Repo = 'shadcn-ui/taxonomy'
        Sha = '298a8857c7128a0d121e7f699dfd729f23b3966d'
    }
)

foreach ($item in $repos) {
    $targetDir = Join-Path $evalRoot $item.Name
    $url = "https://github.com/$($item.Repo).git"

    New-Item -ItemType Directory -Path $targetDir -ErrorAction Stop | Out-Null

    git -C $targetDir init -q "--template=$emptyHooksDir"
    if ($LASTEXITCODE -ne 0) {
        throw "git init failed for $($item.Name)"
    }

    git -C $targetDir `
        -c core.symlinks=false `
        -c "core.hooksPath=$emptyHooksDir" `
        -c core.autocrlf=false `
        -c core.longpaths=true `
        fetch --depth=1 --no-tags $url $item.Sha

    if ($LASTEXITCODE -ne 0) {
        throw "git fetch failed for $($item.Name)"
    }

    git -C $targetDir `
        -c core.symlinks=false `
        -c "core.hooksPath=$emptyHooksDir" `
        -c core.autocrlf=false `
        -c core.longpaths=true `
        checkout --detach FETCH_HEAD

    if ($LASTEXITCODE -ne 0) {
        throw "git checkout failed for $($item.Name)"
    }

    $actualSha = (git -C $targetDir rev-parse HEAD).Trim()

    if ($LASTEXITCODE -ne 0 -or $actualSha -ne $item.Sha) {
        throw "Commit mismatch for $($item.Name)"
    }

    $dirty = git -C $targetDir status --porcelain --untracked-files=all

    if ($LASTEXITCODE -ne 0 -or $dirty) {
        throw "Snapshot is not clean: $($item.Name)"
    }

    Write-Host "VERIFIED: $($item.Name) $actualSha" -ForegroundColor Green
}
```

Stop if a fetch or checkout fails. Preserve the existing benchmark directories, and use a different fresh external path for a subsequent acquisition attempt rather than forcing an existing checkout.

### Step 3 — Generate Source Bundles

Run this block from the Archon repository root, after the successful build and snapshot acquisition. It uses the actual built shared filters (`isSupportedSourcePath`, `isRepoConfigPath`), NUL-delimited Git tree output and exact Git blob bytes. The external bundle contains `schemaVersion`, `repository`, `commitSha`, `sourceCount`, `configCount`, `skippedSpecialEntries`, and a `files` array with `path`, `kind`, `gitBlobId`, `sha256`, `byteLength` and informational `content` fields.

**Encoding note:** `sha256`, `gitBlobId` and `byteLength` represent raw bytes. The JSON `content` field is UTF-8 decoded for inspection and is lossy for UTF-16LE sources such as Payments' `types_db.ts`. The evaluator verifies raw on-disk bytes and Git blob identity against the pinned tree and manifest provenance, not a UTF-8 content round trip.

```powershell
Set-Location C:\dev\archon

@'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isRepoConfigPath,
  isSupportedSourcePath,
} from './packages/shared/dist/index.js';

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '__snapshots__',
  '.git',
]);
const REGULAR_GIT_MODES = new Set(['100644', '100755']);
const MAX_BUF = 32 * 1024 * 1024;

const REPOS = [
  {
    name: 'zustand',
    repo: 'pmndrs/zustand',
    sha: '9fed2eb2f3af672da9f7bf694b996df3831fc207',
    expectedSource: 49,
    expectedConfig: 5,
  },
  {
    name: 'nextjs-subscription-payments',
    repo: 'vercel/nextjs-subscription-payments',
    sha: 'bdd0813206e47e6b218d42f15a7976c8a0d3c3eb',
    expectedSource: 56,
    expectedConfig: 2,
  },
  {
    name: 'taxonomy',
    repo: 'shadcn-ui/taxonomy',
    sha: '298a8857c7128a0d121e7f699dfd729f23b3966d',
    expectedSource: 129,
    expectedConfig: 2,
  },
];

const evalRoot = 'C:\\dev\\archon-eval-repro';
const bundleDir = path.join(evalRoot, 'source-bundles');
await mkdir(bundleDir, { recursive: true });

function isInsideIgnoredDir(relPath) {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (IGNORED_DIRS.has(parts[i])) {
      return true;
    }
  }
  return false;
}

for (const item of REPOS) {
  const repoDir = path.join(evalRoot, item.name);
  const head = execFileSync(
    'git',
    ['-C', repoDir, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();

  if (head !== item.sha) {
    throw new Error(
      `HEAD mismatch for ${item.name}: expected ${item.sha}, got ${head}`,
    );
  }

  const rawTree = execFileSync(
    'git',
    ['-C', repoDir, 'ls-tree', '-r', '-z', 'HEAD'],
    { encoding: 'buffer', maxBuffer: MAX_BUF },
  );

  const files = [];
  let sourceCount = 0;
  let configCount = 0;

  for (const record of rawTree.toString('utf8').split('\0')) {
    if (record.length === 0) {
      continue;
    }

    const tabIdx = record.indexOf('\t');

    if (tabIdx < 0) {
      throw new Error('Malformed Git tree entry');
    }

    const [mode, objectType, gitBlobId] = record.slice(0, tabIdx).split(' ');
    const relPath = record.slice(tabIdx + 1);

    if (isInsideIgnoredDir(relPath)) {
      continue;
    }

    const isSource = isSupportedSourcePath(relPath);
    const isConfig = !isSource && isRepoConfigPath(relPath);

    if (!isSource && !isConfig) {
      continue;
    }

    if (objectType !== 'blob' || !REGULAR_GIT_MODES.has(mode)) {
      throw new Error(
        `Unsupported Git tree entry for ${relPath}: ${mode} ${objectType}`,
      );
    }

    const rawBytes = execFileSync(
      'git',
      ['-C', repoDir, 'cat-file', 'blob', gitBlobId],
      { encoding: 'buffer', maxBuffer: MAX_BUF },
    );
    const sha256 = createHash('sha256').update(rawBytes).digest('hex');

    if (isSource) {
      sourceCount += 1;
    } else {
      configCount += 1;
    }

    files.push({
      path: relPath,
      kind: isSource ? 'source' : 'config',
      gitBlobId,
      sha256,
      byteLength: rawBytes.byteLength,
      content: rawBytes.toString('utf8'),
    });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (
    sourceCount !== item.expectedSource ||
    configCount !== item.expectedConfig
  ) {
    throw new Error(
      `Inventory count mismatch for ${item.name}: ` +
        `got ${sourceCount}/${configCount}, ` +
        `expected ${item.expectedSource}/${item.expectedConfig}`,
    );
  }

  const bundle = {
    schemaVersion: 1,
    repository: item.repo,
    commitSha: item.sha,
    sourceCount,
    configCount,
    skippedSpecialEntries: 0,
    files,
  };

  const outFile = path.join(bundleDir, `${item.name}-sources.json`);

  await writeFile(outFile, `${JSON.stringify(bundle, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });

  console.log(
    `Generated ${outFile} (${sourceCount} source, ${configCount} config)`,
  );
}
'@ | node --input-type=module

if ($LASTEXITCODE -ne 0) {
    throw "Source bundle generation failed"
}
```

Expected inventory:

| Repository | Source files | Config files |
| :--------- | -----------: | -----------: |
| Zustand    |           49 |            5 |
| Payments   |           56 |            2 |
| Taxonomy   |          129 |            2 |
| **Total**  |      **234** |        **9** |

Bundle generation rejects unsupported Git entry types within the source/config inventory. The `wx` write flag refuses to overwrite any existing bundle.

Before every evaluation, `snapshot-verifier.ts` checks the exact pinned HEAD, clean Git status, authoritative Git tree inventory, bundle metadata, an independent filesystem inventory, raw-byte SHA-256 and Git blob identity, file byte lengths, and frozen manifest provenance. The verification rejects unexpected supported files, disallowed symlinks or dependency directories, and inconsistent metadata. Do not bypass a verification failure by editing the manifests.

### Step 4 — Verify Fresh Snapshot Acquisition (Optional Smoke Test)

One evaluation per repository is sufficient to smoke-test the new acquisition and bundle instructions. The runs below do not write output files and do not replace the complete nine-run protocol.

```powershell
Set-Location C:\dev\archon

$evalRoot = 'C:\dev\archon-eval-repro'

foreach ($repo in @('zustand', 'nextjs-subscription-payments', 'taxonomy')) {
    node scripts/dist/evaluate-recall.js run `
        --repo $repo `
        --repo-dir (Join-Path $evalRoot $repo) `
        --bundle (Join-Path $evalRoot "source-bundles\$repo-sources.json")

    if ($LASTEXITCODE -ne 0) {
        throw "Fresh snapshot verification failed: $repo"
    }
}
```

### Step 5 — Complete Nine-Run Fresh-Process Evaluation

Use the compiled entrypoint employed for the original measured experiments. Each repetition starts a separate Node process. Leave `--skip-lib-files` unset for the official library-enabled protocol.

```powershell
Set-Location C:\dev\archon

$evalRoot = 'C:\dev\archon-eval-repro'
$outDir = Join-Path $evalRoot 'results\repro-1'

if (Test-Path $outDir) {
    throw "Results directory already exists: $outDir"
}

New-Item -ItemType Directory -Path $outDir -Force -ErrorAction Stop | Out-Null

$repoIds = @('zustand', 'nextjs-subscription-payments', 'taxonomy')
$runArgs = @()

foreach ($repoId in $repoIds) {
    $repoDir = Join-Path $evalRoot $repoId
    $bundlePath = Join-Path $evalRoot "source-bundles\$repoId-sources.json"

    for ($i = 1; $i -le 3; $i++) {
        $outFile = Join-Path $outDir "$repoId-run-$i.json"

        node scripts/dist/evaluate-recall.js run `
            --repo $repoId `
            --repo-dir $repoDir `
            --bundle $bundlePath `
            --out $outFile

        if ($LASTEXITCODE -ne 0) {
            throw "Run $i failed for $repoId"
        }

        if (-not (Test-Path $outFile)) {
            throw "Missing run record: $outFile"
        }

        $runArgs += @('--run', $outFile)
    }
}

if ($runArgs.Count -ne 18) {
    throw "Expected exactly nine run records"
}

node scripts/dist/evaluate-recall.js report `
    @runArgs `
    --out-json (Join-Path $outDir 'repro-report.json') `
    --out-md (Join-Path $outDir 'repro-report.md')

if ($LASTEXITCODE -ne 0) {
    throw "Report aggregation failed"
}

Get-Content (Join-Path $outDir 'repro-report.md')
Get-FileHash -Path (Join-Path $outDir 'repro-report.json') -Algorithm SHA256
```

The complete report validates the three-by-three run protocol, matching analysis options and environment, deterministic graph digests and consistent scores. The internal `baseline` mode label describes the complete reporting protocol; it does not mean the corrected implementation recreates the historical pre-correction results.

Expected corrected results are 77/77 IMPORTS, 160/160 primary CALLS, 160/163 broader CALLS, zero sampled false positives and matching graph digests across repetitions. Timings, process memory, report generation timestamps and report-file hashes can vary between reproductions. Compare graph digests and metrics, not the entire generated report byte-for-byte.

## Supported CLI Entrypoints and Flags

Build Archon first so workspace imports resolve.

- **Compiled entrypoint (used for the official measurements):** `node scripts/dist/evaluate-recall.js`.
- **Source entrypoint (supported by the current root-resolution implementation):** `npx tsx scripts/evaluate-recall.ts`. The official recorded experiments used the compiled entrypoint.

| Command  | Flag               | Purpose                                                                                            |
| :------- | :----------------- | :------------------------------------------------------------------------------------------------- |
| `run`    | `--repo`           | Required frozen repository ID: `zustand`, `nextjs-subscription-payments` or `taxonomy`.            |
| `run`    | `--repo-dir`       | Required path to the pinned local checkout.                                                        |
| `run`    | `--bundle`         | Required path to its external source bundle JSON.                                                  |
| `run`    | `--out`            | Optional path for the JSON run record.                                                             |
| `run`    | `--skip-lib-files` | Experimental mode with `skipLoadingLibFiles: true`; not used in the official protocol.             |
| `report` | `--run`            | Repeat for each input run record. Duplicate input paths are rejected.                              |
| `report` | `--out-json`       | Optional aggregate JSON output path.                                                               |
| `report` | `--out-md`         | Optional Markdown output path.                                                                     |
| `report` | `--partial`        | Allows incomplete or experimental reporting; cannot substitute for the official nine-run protocol. |

### Partial Report Example

```powershell
node scripts/dist/evaluate-recall.js report `
    --run C:\dev\archon-eval-repro\results\repro-1\zustand-run-1.json `
    --partial

if ($LASTEXITCODE -ne 0) {
    throw "Partial report failed"
}
```

The output is labeled `PARTIAL — Not Official Baseline`. A single-run report is not evidence of repeat-run determinism. For library-disabled experiments, keep runs in separate output directories and use `--partial` with compatible run records.

## Verification and Repository Hygiene

The local Step 4.2b verification recorded 175 passing unit tests across 25 suites (63 core tests and 19 evaluator tests), 6 passing Docker-backed integration tests, and successful strict ESLint, TypeScript compilation, build and formatting checks. The integration tests cover existing PostgreSQL repository and BullMQ worker infrastructure; they do not establish production parser integration.

To reproduce the local quality sequence:

```powershell
npm run clean
if ($LASTEXITCODE -ne 0) { throw "clean failed" }

npm run format:check
if ($LASTEXITCODE -ne 0) { throw "format check failed" }

npm run lint
if ($LASTEXITCODE -ne 0) { throw "lint failed" }

npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }

npm test
if ($LASTEXITCODE -ne 0) { throw "unit tests failed" }

npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

# Requires healthy local Docker PostgreSQL and Redis.
docker compose ps
npm run test:integration
if ($LASTEXITCODE -ne 0) { throw "integration tests failed" }
```

Commit evaluator source, tests, documentation and the frozen reference manifests only. Keep downloaded target repositories, generated source bundles, raw run records, generated reports, dependency directories, compiled output, temporary diagnostics and credentials outside the tracked source tree. Do not change the frozen denominators or hashes to improve results.
