import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalysisOutput, ExtractedEdge, ExtractedNode } from '@archon/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EvaluationError,
  FROZEN_EVAL_REPOS,
  PAYMENTS_WRAPPER_EXTENSION_CALLS,
  aggregateRepositoryScores,
  compareCallIdentities,
  compareImportIdentities,
  computeEdgeSetMetrics,
  computeGraphOutputDigest,
  gitBlobSha1Hex,
  meetsRecallTarget,
  parseAndValidateManifest,
  scoreRepositoryAnalysis,
  serializeCallIdentity,
  serializeImportIdentity,
  sha256BufferHex,
  validateGraphIntegrity,
  verifyAndLoadFrozenManifest,
  type CanonicalCallIdentity,
  type CanonicalImportIdentity,
  type FrozenRepoId,
  type GroundTruthManifest,
} from './eval-policy.js';
import {
  buildAggregatedReport,
  formatMarkdownReport,
  isMainModule,
  parseAndValidateRunRecord,
  runCli,
  type SingleRepoRunRecord,
} from './evaluate-recall.js';
import { verifyPinnedSnapshot } from './snapshot-verifier.js';

const FAKE_SHA1 = 'a'.repeat(40);
const FAKE_SHA256 = 'b'.repeat(64);

function makeNode(
  qualifiedName: string,
  nodeType: ExtractedNode['nodeType'],
  filePath: string,
  parentQualifiedName: string | null = null,
): ExtractedNode {
  return {
    nodeType,
    name: qualifiedName.split(':').at(-1) ?? qualifiedName,
    qualifiedName,
    filePath,
    parentQualifiedName,
    isExported: nodeType === 'function' || nodeType === 'class' || nodeType === 'symbol',
    startLine: nodeType === 'folder' ? null : 1,
    endLine: nodeType === 'folder' ? null : 10,
    contentHash: nodeType === 'folder' ? null : FAKE_SHA256,
    snippet: nodeType === 'folder' ? null : 'code',
  };
}

function makeImportEdge(src: string, tgt: string): ExtractedEdge {
  return {
    sourceQualifiedName: src,
    targetQualifiedName: tgt,
    edgeType: 'IMPORTS',
    callSiteLine: null,
    callSiteSnippet: null,
  };
}

function makeCallEdge(src: string, tgt: string, line: number, snippet = 'fn()'): ExtractedEdge {
  return {
    sourceQualifiedName: src,
    targetQualifiedName: tgt,
    edgeType: 'CALLS',
    callSiteLine: line,
    callSiteSnippet: snippet,
  };
}

function makeOutput(
  nodes: readonly ExtractedNode[],
  edges: readonly ExtractedEdge[],
): AnalysisOutput {
  let folderNodeCount = 0;
  let fileNodeCount = 0;
  let functionNodeCount = 0;
  let classNodeCount = 0;
  let symbolNodeCount = 0;
  for (const n of nodes) {
    if (n.nodeType === 'folder') folderNodeCount += 1;
    else if (n.nodeType === 'file') fileNodeCount += 1;
    else if (n.nodeType === 'function') functionNodeCount += 1;
    else if (n.nodeType === 'class') classNodeCount += 1;
    else symbolNodeCount += 1;
  }
  const importsEdgeCount = edges.filter((e) => e.edgeType === 'IMPORTS').length;
  const callsEdgeCount = edges.filter((e) => e.edgeType === 'CALLS').length;

  return {
    nodes,
    edges,
    warnings: [],
    stats: {
      discoveredFilesCount: fileNodeCount,
      parsedFilesCount: fileNodeCount,
      skippedSyntaxErrorFilesCount: 0,
      skippedOversizedFilesCount: 0,
      configFilesCount: 0,
      folderNodeCount,
      fileNodeCount,
      functionNodeCount,
      classNodeCount,
      symbolNodeCount,
      importsEdgeCount,
      callsEdgeCount,
      totalBytesRead: 100,
      truncatedWarningsCount: 0,
    },
  };
}

function makeSyntheticManifest(overrides: Partial<GroundTruthManifest> = {}): GroundTruthManifest {
  const selectedSourceFiles = overrides.selectedSourceFiles ?? ['src/a.ts'];
  return {
    schemaVersion: 1,
    repository: 'org/synthetic',
    commitSha: overrides.commitSha ?? FAKE_SHA1,
    annotationMethod: 'synthetic-unit-test',
    samplingRationale: 'unit test fixture',
    scoringPolicy: {
      importsIdentity: 'sourceQualifiedName + targetQualifiedName + edgeType',
      callsIdentity: 'sourceQualifiedName + targetQualifiedName + edgeType + callSiteLine',
      scopeFiltering: 'node.filePath in selectedSourceFiles',
      uncertainCandidatePolicy: 'none',
      zeroDenominatorPolicy: 'null / N/A',
    },
    selectedSourceFiles,
    annotatedFileProvenance:
      overrides.annotatedFileProvenance ??
      selectedSourceFiles.map((file) => ({
        path: file,
        status: 'complete' as const,
        gitBlobId: FAKE_SHA1,
        sha256: FAKE_SHA256,
        byteLength: 10,
      })),
    referencedTargetAndConfigProvenance: overrides.referencedTargetAndConfigProvenance ?? [
      {
        path: 'src/b.ts',
        role: 'target',
        gitBlobId: FAKE_SHA1,
        sha256: FAKE_SHA256,
        byteLength: 10,
      },
    ],
    expectedImports: overrides.expectedImports ?? [],
    expectedCalls: overrides.expectedCalls ?? [],
    excludedOrUncertainCandidates: overrides.excludedOrUncertainCandidates ?? [],
    notes: overrides.notes ?? ['synthetic'],
  };
}

describe('Recall evaluator policy, scoring, and snapshot verification (Stage C-A)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function createTempGitRepo(
    files: Readonly<Record<string, Buffer | string>>,
  ): Promise<{ readonly repoDir: string; readonly headSha: string; readonly bundlePath: string }> {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'archon-eval-test-'));
    tempDirs.push(baseDir);

    const repoDir = path.join(baseDir, 'repo');
    const emptyHooks = path.join(baseDir, 'empty-hooks');
    await mkdir(repoDir, { recursive: true });
    await mkdir(emptyHooks, { recursive: true });

    const git = (args: readonly string[]): string =>
      execFileSync(
        'git',
        [
          '-C',
          repoDir,
          '-c',
          `core.hooksPath=${emptyHooks}`,
          '-c',
          'core.autocrlf=false',
          '-c',
          'core.symlinks=false',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { encoding: 'utf8' },
      ).trim();

    git(['init', '-q']);
    git(['config', 'user.name', 'Archon Test']);
    git(['config', 'user.email', 'test@archon.local']);

    const bundleFiles: {
      readonly path: string;
      readonly kind: 'source' | 'config';
      readonly gitBlobId: string;
      readonly sha256: string;
      readonly byteLength: number;
    }[] = [];

    for (const [relPath, content] of Object.entries(files)) {
      const absPath = path.join(repoDir, ...relPath.split('/'));
      await mkdir(path.dirname(absPath), { recursive: true });
      const rawBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      await writeFile(absPath, rawBuf);

      if (relPath !== '.gitignore') {
        const isConfig = relPath.endsWith('tsconfig.json') || relPath.endsWith('package.json');
        bundleFiles.push({
          path: relPath,
          kind: isConfig ? 'config' : 'source',
          gitBlobId: gitBlobSha1Hex(rawBuf),
          sha256: sha256BufferHex(rawBuf),
          byteLength: rawBuf.byteLength,
        });
      }
    }

    git(['add', '--all']);
    git(['commit', '-q', '-m', 'init']);
    const headSha = git(['rev-parse', 'HEAD']);

    const bundlePath = path.join(baseDir, 'bundle.json');
    const bundlePayload = {
      schemaVersion: 1,
      repository: 'org/synthetic',
      commitSha: headSha,
      sourceCount: bundleFiles.filter((f) => f.kind === 'source').length,
      configCount: bundleFiles.filter((f) => f.kind === 'config').length,
      skippedSpecialEntries: 0,
      files: bundleFiles,
    };
    await writeFile(bundlePath, JSON.stringify(bundlePayload, null, 2), 'utf8');

    return { repoDir, headSha, bundlePath };
  }

  it('computes exact TP/FP/FN, precision, recall, and F1 across perfect, missing, unexpected, and mixed IMPORTS/CALLS sets', () => {
    const nodes = [
      makeNode('file:src/a.ts', 'file', 'src/a.ts'),
      makeNode('file:src/b.ts', 'file', 'src/b.ts'),
      makeNode('file:src/c.ts', 'file', 'src/c.ts'),
      makeNode('src/a.ts::fn:run', 'function', 'src/a.ts', 'file:src/a.ts'),
      makeNode('src/b.ts::fn:helper', 'function', 'src/b.ts', 'file:src/b.ts'),
      makeNode('src/c.ts::fn:extra', 'function', 'src/c.ts', 'file:src/c.ts'),
    ];

    const manifest = makeSyntheticManifest({
      referencedTargetAndConfigProvenance: [
        {
          path: 'src/b.ts',
          role: 'target',
          gitBlobId: FAKE_SHA1,
          sha256: FAKE_SHA256,
          byteLength: 10,
        },
        {
          path: 'src/c.ts',
          role: 'target',
          gitBlobId: FAKE_SHA1,
          sha256: FAKE_SHA256,
          byteLength: 10,
        },
      ],
      expectedImports: [
        {
          sourceQualifiedName: 'file:src/a.ts',
          targetQualifiedName: 'file:src/b.ts',
          edgeType: 'IMPORTS',
          evidence: 'L1',
        },
      ],
      expectedCalls: [
        {
          sourceQualifiedName: 'src/a.ts::fn:run',
          targetQualifiedName: 'src/b.ts::fn:helper',
          edgeType: 'CALLS',
          callSiteLine: 3,
          evidence: 'L3',
        },
        {
          sourceQualifiedName: 'src/a.ts::fn:run',
          targetQualifiedName: 'src/b.ts::fn:helper',
          edgeType: 'CALLS',
          callSiteLine: 7,
          evidence: 'L7',
        },
      ],
    });

    // Perfect IMPORTS (1/1), mixed CALLS (1 TP @L3, 1 FN @L7, 1 FP @L9)
    const output = makeOutput(nodes, [
      makeImportEdge('file:src/a.ts', 'file:src/b.ts'),
      makeCallEdge('src/a.ts::fn:run', 'src/b.ts::fn:helper', 3),
      makeCallEdge('src/a.ts::fn:run', 'src/c.ts::fn:extra', 9),
    ]);

    const res = scoreRepositoryAnalysis({ manifest, output });
    expect(res.imports.tp).toBe(1);
    expect(res.imports.fp).toBe(0);
    expect(res.imports.fn).toBe(0);
    expect(res.imports.precision).toBe(1);
    expect(res.imports.recall).toBe(1);
    expect(res.imports.f1).toBe(1);

    expect(res.primaryCalls.tp).toBe(1);
    expect(res.primaryCalls.fp).toBe(1);
    expect(res.primaryCalls.fn).toBe(1);
    expect(res.primaryCalls.precision).toBe(0.5);
    expect(res.primaryCalls.recall).toBe(0.5);
    expect(res.primaryCalls.f1).toBe(0.5);
    expect(res.primaryCalls.falsePositives).toEqual([
      {
        sourceQualifiedName: 'src/a.ts::fn:run',
        targetQualifiedName: 'src/c.ts::fn:extra',
        edgeType: 'CALLS',
        callSiteLine: 9,
      },
    ]);
    expect(res.primaryCalls.falseNegatives).toEqual([
      {
        sourceQualifiedName: 'src/a.ts::fn:run',
        targetQualifiedName: 'src/b.ts::fn:helper',
        edgeType: 'CALLS',
        callSiteLine: 7,
      },
    ]);
  });

  it('deduplicates duplicate expected/predicted identities in set metrics so duplicates cannot inflate TP, while preserving distinct CALLS lines', () => {
    const callL4: CanonicalCallIdentity = {
      sourceQualifiedName: 'src/a.ts::fn:run',
      targetQualifiedName: 'src/b.ts::fn:helper',
      edgeType: 'CALLS',
      callSiteLine: 4,
    };
    const callL8: CanonicalCallIdentity = {
      sourceQualifiedName: 'src/a.ts::fn:run',
      targetQualifiedName: 'src/b.ts::fn:helper',
      edgeType: 'CALLS',
      callSiteLine: 8,
    };

    const metrics = computeEdgeSetMetrics(
      [callL4, callL4, callL8],
      [callL4, callL4, callL4, callL8],
      serializeCallIdentity,
      compareCallIdentities,
    );

    expect(metrics.expectedCount).toBe(2);
    expect(metrics.predictedCount).toBe(2);
    expect(metrics.tp).toBe(2);
    expect(metrics.fp).toBe(0);
    expect(metrics.fn).toBe(0);
    expect(metrics.duplicateExpectedCount).toBe(1);
    expect(metrics.duplicatePredictedCount).toBe(2);
  });

  it('handles empty expected/predicted sets and undefined denominators independently without coercing null to 100%', () => {
    const imp: CanonicalImportIdentity = {
      sourceQualifiedName: 'file:src/a.ts',
      targetQualifiedName: 'file:src/b.ts',
      edgeType: 'IMPORTS',
    };

    // Both empty -> precision, recall, F1 are all null
    const bothEmpty = computeEdgeSetMetrics(
      [],
      [],
      serializeImportIdentity,
      compareImportIdentities,
    );
    expect(bothEmpty.precision).toBeNull();
    expect(bothEmpty.recall).toBeNull();
    expect(bothEmpty.f1).toBeNull();
    expect(meetsRecallTarget(bothEmpty.recall)).toBeNull();

    // Expected non-empty, predicted empty -> precision null, recall 0, F1 0
    const noPredictions = computeEdgeSetMetrics(
      [imp],
      [],
      serializeImportIdentity,
      compareImportIdentities,
    );
    expect(noPredictions.precision).toBeNull();
    expect(noPredictions.recall).toBe(0);
    expect(noPredictions.f1).toBe(0);

    // Expected empty, predicted non-empty -> precision 0, recall null, F1 0
    const onlyFp = computeEdgeSetMetrics(
      [],
      [imp],
      serializeImportIdentity,
      compareImportIdentities,
    );
    expect(onlyFp.precision).toBe(0);
    expect(onlyFp.recall).toBeNull();
    expect(onlyFp.f1).toBe(0);
  });

  it('filters predicted edges strictly by emitted node.filePath rather than qualifiedName prefixes, counting selected->unselected and excluding unselected->selected', () => {
    // Use a synthetic qualifiedName whose prefix does NOT match filePath to prove filtering uses node.filePath
    const nodes = [
      makeNode('file:src/a.ts', 'file', 'src/a.ts'),
      makeNode('file:src/b.ts', 'file', 'src/b.ts'),
      makeNode('custom-prefix::fn:inSelected', 'function', 'src/a.ts', 'file:src/a.ts'),
      makeNode('src/a.ts::fn:actuallyInUnselected', 'function', 'src/b.ts', 'file:src/b.ts'),
    ];

    const manifest = makeSyntheticManifest({
      selectedSourceFiles: ['src/a.ts'],
      expectedCalls: [
        {
          sourceQualifiedName: 'src/a.ts::fn:run',
          targetQualifiedName: 'src/b.ts::fn:helper',
          edgeType: 'CALLS',
          callSiteLine: 2,
          evidence: 'L2',
        },
      ],
    });

    // Edge 1: source node has filePath 'src/a.ts' (selected) -> unselected target (MUST BE SCORED as FP)
    // Edge 2: source node has filePath 'src/b.ts' (unselected) even though QN starts with 'src/a.ts::' -> selected target (MUST BE EXCLUDED)
    const output = makeOutput(nodes, [
      makeCallEdge('custom-prefix::fn:inSelected', 'src/a.ts::fn:actuallyInUnselected', 5),
      makeCallEdge('src/a.ts::fn:actuallyInUnselected', 'custom-prefix::fn:inSelected', 8),
    ]);

    const res = scoreRepositoryAnalysis({ manifest, output });
    expect(res.scopedPredictedCallsCount).toBe(1);
    expect(res.primaryCalls.falsePositives).toEqual([
      {
        sourceQualifiedName: 'custom-prefix::fn:inSelected',
        targetQualifiedName: 'src/a.ts::fn:actuallyInUnselected',
        edgeType: 'CALLS',
        callSiteLine: 5,
      },
    ]);
  });

  it('detects missing endpoints, duplicate nodes, and duplicate graph edges as graph-integrity violations and rejects them in scoreRepositoryAnalysis', () => {
    const fileA = makeNode('file:src/a.ts', 'file', 'src/a.ts');
    const fileB = makeNode('file:src/b.ts', 'file', 'src/b.ts');

    // Missing source endpoint must NOT be silently dropped
    const missingSrcOutput = makeOutput(
      [fileA, fileB],
      [makeCallEdge('src/a.ts::fn:missingSource', 'file:src/b.ts', 3)],
    );
    const missingIntegrity = validateGraphIntegrity(missingSrcOutput);
    expect(missingIntegrity.valid).toBe(false);
    expect(missingIntegrity.violations.some((v) => v.includes('Missing source endpoint'))).toBe(
      true,
    );
    expect(() =>
      scoreRepositoryAnalysis({ manifest: makeSyntheticManifest(), output: missingSrcOutput }),
    ).toThrow(EvaluationError);

    // Duplicate graph edge must be flagged
    const dupEdgeOutput = makeOutput(
      [fileA, fileB],
      [
        makeImportEdge('file:src/a.ts', 'file:src/b.ts'),
        makeImportEdge('file:src/a.ts', 'file:src/b.ts'),
      ],
    );
    const dupIntegrity = validateGraphIntegrity(dupEdgeOutput);
    expect(dupIntegrity.valid).toBe(false);
    expect(dupIntegrity.violations.some((v) => v.includes('Duplicate graph IMPORTS'))).toBe(true);

    // Duplicate node must be flagged
    const dupNodeOutput = makeOutput([fileA, fileA], []);
    expect(validateGraphIntegrity(dupNodeOutput).valid).toBe(false);
  });

  it('counts missing expected target nodes as false negatives without discarding them or failing evaluation', () => {
    // Target file `src/b.ts` was never emitted in output.nodes (e.g. skipped UTF-16LE file)
    const nodes = [
      makeNode('file:src/a.ts', 'file', 'src/a.ts'),
      makeNode('src/a.ts::fn:run', 'function', 'src/a.ts', 'file:src/a.ts'),
    ];
    const manifest = makeSyntheticManifest({
      expectedImports: [
        {
          sourceQualifiedName: 'file:src/a.ts',
          targetQualifiedName: 'file:src/b.ts',
          edgeType: 'IMPORTS',
          evidence: 'L1',
        },
      ],
      expectedCalls: [
        {
          sourceQualifiedName: 'src/a.ts::fn:run',
          targetQualifiedName: 'src/b.ts::fn:missingTarget',
          edgeType: 'CALLS',
          callSiteLine: 4,
          evidence: 'L4',
        },
      ],
    });

    const res = scoreRepositoryAnalysis({ manifest, output: makeOutput(nodes, []) });
    expect(res.imports.fn).toBe(1);
    expect(res.imports.recall).toBe(0);
    expect(res.primaryCalls.fn).toBe(1);
    expect(res.primaryCalls.recall).toBe(0);
  });

  it('applies exact-identity wrapper-extension filtering for primary vs broader CALLS and keeps wrong-line predictions as false positives', () => {
    const nodes = [
      makeNode('file:app/page.tsx', 'file', 'app/page.tsx'),
      makeNode('file:utils/supabase/queries.ts', 'file', 'utils/supabase/queries.ts'),
      makeNode('file:utils/supabase/server.ts', 'file', 'utils/supabase/server.ts'),
      makeNode('app/page.tsx::fn:PricingPage', 'function', 'app/page.tsx', 'file:app/page.tsx'),
      makeNode(
        'utils/supabase/queries.ts::sym:getUser',
        'symbol',
        'utils/supabase/queries.ts',
        'file:utils/supabase/queries.ts',
      ),
      makeNode(
        'utils/supabase/queries.ts::sym:getProducts',
        'symbol',
        'utils/supabase/queries.ts',
        'file:utils/supabase/queries.ts',
      ),
      makeNode(
        'utils/supabase/queries.ts::sym:getSubscription',
        'symbol',
        'utils/supabase/queries.ts',
        'file:utils/supabase/queries.ts',
      ),
      makeNode(
        'utils/supabase/server.ts::fn:createClient',
        'function',
        'utils/supabase/server.ts',
        'file:utils/supabase/server.ts',
      ),
    ];

    const manifest = makeSyntheticManifest({
      selectedSourceFiles: ['app/page.tsx'],
      referencedTargetAndConfigProvenance: [
        {
          path: 'utils/supabase/queries.ts',
          role: 'target',
          gitBlobId: FAKE_SHA1,
          sha256: FAKE_SHA256,
          byteLength: 10,
        },
        {
          path: 'utils/supabase/server.ts',
          role: 'target',
          gitBlobId: FAKE_SHA1,
          sha256: FAKE_SHA256,
          byteLength: 10,
        },
      ],
      expectedCalls: [
        {
          sourceQualifiedName: 'app/page.tsx::fn:PricingPage',
          targetQualifiedName: 'utils/supabase/server.ts::fn:createClient',
          edgeType: 'CALLS',
          callSiteLine: 10,
          evidence: 'L10',
        },
        ...PAYMENTS_WRAPPER_EXTENSION_CALLS.map((ext) => ({ ...ext, evidence: 'wrapper' })),
      ],
    });

    // Predictions:
    // - createClient @L10 (TP in primary & broader)
    // - getUser @L12 (EXACT extension match -> unscored in primary, TP in broader)
    // - getProducts @L99 (WRONG LINE -> NOT exempt! FP in BOTH primary and broader)
    // - getSubscription @L14 missed (absent in primary, FN in broader)
    const output = makeOutput(nodes, [
      makeCallEdge('app/page.tsx::fn:PricingPage', 'utils/supabase/server.ts::fn:createClient', 10),
      makeCallEdge('app/page.tsx::fn:PricingPage', 'utils/supabase/queries.ts::sym:getUser', 12),
      makeCallEdge(
        'app/page.tsx::fn:PricingPage',
        'utils/supabase/queries.ts::sym:getProducts',
        99,
      ),
    ]);

    const res = scoreRepositoryAnalysis({
      manifest,
      output,
      wrapperExtensionCalls: PAYMENTS_WRAPPER_EXTENSION_CALLS,
    });

    // Primary CALLS: expected=1 (createClient), predicted=2 (createClient + wrong-line getProducts)
    expect(res.primaryCalls.expectedCount).toBe(1);
    expect(res.primaryCalls.predictedCount).toBe(2);
    expect(res.primaryCalls.tp).toBe(1);
    expect(res.primaryCalls.fp).toBe(1);
    expect(res.primaryCalls.fn).toBe(0);
    expect(res.unscoredWrapperExtensionPredictions).toEqual([PAYMENTS_WRAPPER_EXTENSION_CALLS[0]]);

    // Broader CALLS: expected=4, predicted=3 (TP=2: createClient + getUser, FP=1: L99, FN=2: getProducts@13 + getSubscription@14)
    expect(res.broaderCalls.expectedCount).toBe(4);
    expect(res.broaderCalls.tp).toBe(2);
    expect(res.broaderCalls.fp).toBe(1);
    expect(res.broaderCalls.fn).toBe(2);

    // Wrapper extensions reported separately: matched 1, missed 2
    expect(res.wrapperExtensions.matchedExtensions).toHaveLength(1);
    expect(res.wrapperExtensions.missedExtensions).toHaveLength(2);
  });

  it('micro-averages raw TP/FP/FN counts across repositories and checks the 95% target at full precision', () => {
    const makeSimpleScore = (expectedCount: number, tpCount: number) => {
      const nodes = [
        makeNode('file:src/a.ts', 'file', 'src/a.ts'),
        makeNode('file:src/b.ts', 'file', 'src/b.ts'),
        makeNode('src/a.ts::fn:run', 'function', 'src/a.ts', 'file:src/a.ts'),
        makeNode('src/b.ts::fn:leaf', 'function', 'src/b.ts', 'file:src/b.ts'),
      ];
      const expectedCalls = Array.from({ length: expectedCount }, (_, idx) => ({
        sourceQualifiedName: 'src/a.ts::fn:run',
        targetQualifiedName: 'src/b.ts::fn:leaf',
        edgeType: 'CALLS' as const,
        callSiteLine: idx + 1,
        evidence: `L${String(idx + 1)}`,
      }));
      const predictedEdges = Array.from({ length: tpCount }, (_, idx) =>
        makeCallEdge('src/a.ts::fn:run', 'src/b.ts::fn:leaf', idx + 1),
      );
      return scoreRepositoryAnalysis({
        manifest: makeSyntheticManifest({ expectedCalls }),
        output: makeOutput(nodes, predictedEdges),
      });
    };

    // Repo 1: 1/1 (100%), Repo 2: 188/198 (94.9494...%)
    // Unweighted macro average would be ~97.47%, but raw micro-average is 189/199 = 0.9497487... (< 0.95!)
    const score1 = makeSimpleScore(1, 1);
    const score2 = makeSimpleScore(198, 188);
    const agg = aggregateRepositoryScores([score1, score2]);

    expect(agg.primaryCalls.tp).toBe(189);
    expect(agg.primaryCalls.fn).toBe(10);
    expect(agg.primaryCalls.expectedCount).toBe(199);
    expect(agg.primaryCalls.recall).toBeCloseTo(189 / 199, 10);
    expect(agg.primaryCalls.meetsRecallTarget).toBe(false);
    expect(meetsRecallTarget(0.9499999)).toBe(false);
    expect(meetsRecallTarget(0.95)).toBe(true);
  });

  it('orders mismatch reports deterministically and computes graph digests independent of timing/memory', () => {
    const nodes = [
      makeNode('file:src/a.ts', 'file', 'src/a.ts'),
      makeNode('file:src/b.ts', 'file', 'src/b.ts'),
      makeNode('src/a.ts::fn:run', 'function', 'src/a.ts', 'file:src/a.ts'),
      makeNode('src/b.ts::fn:alpha', 'function', 'src/b.ts', 'file:src/b.ts'),
      makeNode('src/b.ts::fn:zeta', 'function', 'src/b.ts', 'file:src/b.ts'),
    ];
    const manifest = makeSyntheticManifest({
      expectedCalls: [
        {
          sourceQualifiedName: 'src/a.ts::fn:run',
          targetQualifiedName: 'src/b.ts::fn:zeta',
          edgeType: 'CALLS',
          callSiteLine: 20,
          evidence: 'L20',
        },
        {
          sourceQualifiedName: 'src/a.ts::fn:run',
          targetQualifiedName: 'src/b.ts::fn:alpha',
          edgeType: 'CALLS',
          callSiteLine: 5,
          evidence: 'L5',
        },
      ],
    });
    const output = makeOutput(nodes, [
      makeCallEdge('src/a.ts::fn:run', 'src/b.ts::fn:zeta', 99),
      makeCallEdge('src/a.ts::fn:run', 'src/b.ts::fn:alpha', 12),
    ]);

    const res1 = scoreRepositoryAnalysis({ manifest, output });
    const res2 = scoreRepositoryAnalysis({ manifest, output });

    expect(res1.primaryCalls.falseNegatives.map((e) => e.targetQualifiedName)).toEqual([
      'src/b.ts::fn:alpha',
      'src/b.ts::fn:zeta',
    ]);
    expect(res1.primaryCalls.falsePositives.map((e) => e.targetQualifiedName)).toEqual([
      'src/b.ts::fn:alpha',
      'src/b.ts::fn:zeta',
    ]);
    expect(computeGraphOutputDigest(output)).toBe(res1.graphDigest);
    expect(res1.graphDigest).toBe(res2.graphDigest);
  });

  it('rejects invalid manifest schemas, duplicate provenance records, duplicate canonical edges, invalid callSiteLine values, and missing extension identities', () => {
    const valid = makeSyntheticManifest();

    // Bad schema version
    expect(() => parseAndValidateManifest({ ...valid, schemaVersion: 2 })).toThrow(EvaluationError);

    // Duplicate provenance
    expect(() =>
      parseAndValidateManifest({
        ...valid,
        annotatedFileProvenance: [
          valid.annotatedFileProvenance[0],
          valid.annotatedFileProvenance[0],
        ],
      }),
    ).toThrow(EvaluationError);

    // Duplicate canonical edge
    const dupCall = {
      sourceQualifiedName: 'src/a.ts::fn:run',
      targetQualifiedName: 'src/b.ts::fn:helper',
      edgeType: 'CALLS',
      callSiteLine: 3,
      evidence: 'L3',
    };
    expect(() =>
      parseAndValidateManifest({
        ...valid,
        expectedCalls: [dupCall, dupCall],
      }),
    ).toThrow(EvaluationError);

    // Invalid callSiteLine (0)
    expect(() =>
      parseAndValidateManifest({
        ...valid,
        expectedCalls: [{ ...dupCall, callSiteLine: 0 }],
      }),
    ).toThrow(EvaluationError);

    // Declared wrapper extension missing from expectedCalls
    expect(() =>
      scoreRepositoryAnalysis({
        manifest: valid,
        output: makeOutput([makeNode('file:src/a.ts', 'file', 'src/a.ts')], []),
        wrapperExtensionCalls: PAYMENTS_WRAPPER_EXTENSION_CALLS,
      }),
    ).toThrow(EvaluationError);
  });

  it('rejects tampered manifest SHA-256 digests before parsing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-manifest-hash-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(makeSyntheticManifest()), 'utf8');

    await expect(verifyAndLoadFrozenManifest(manifestPath, '0'.repeat(64))).rejects.toThrow(
      /SHA-256 mismatch/,
    );
  });

  it('verifies a clean temporary Git snapshot authoritatively and rejects modified files, tampered bundles with fabricated hashes, and unexpected gitignored files', async () => {
    const aText = 'export const a = 1;\n';
    const bText = 'export const b = 2;\n';
    const { repoDir, headSha, bundlePath } = await createTempGitRepo({
      '.gitignore': 'ignored-extra.ts\n',
      'src/a.ts': aText,
      'src/b.ts': bText,
    });

    const aBuf = Buffer.from(aText, 'utf8');
    const bBuf = Buffer.from(bText, 'utf8');
    const manifest = makeSyntheticManifest({
      commitSha: headSha,
      annotatedFileProvenance: [
        {
          path: 'src/a.ts',
          status: 'complete',
          gitBlobId: gitBlobSha1Hex(aBuf),
          sha256: sha256BufferHex(aBuf),
          byteLength: aBuf.byteLength,
        },
      ],
      referencedTargetAndConfigProvenance: [
        {
          path: 'src/b.ts',
          role: 'target',
          gitBlobId: gitBlobSha1Hex(bBuf),
          sha256: sha256BufferHex(bBuf),
          byteLength: bBuf.byteLength,
        },
      ],
    });

    // Clean snapshot passes
    const verified = await verifyPinnedSnapshot({
      repoRoot: repoDir,
      bundlePath,
      manifest,
      expectedSourceCount: 2,
      expectedConfigCount: 0,
    });
    expect(verified.supportedFiles).toEqual(['src/a.ts', 'src/b.ts']);

    // Unexpected gitignored supported file is rejected even though `git status` is clean
    const ignoredFilePath = path.join(repoDir, 'ignored-extra.ts');
    await writeFile(ignoredFilePath, 'export const sneak = 1;\n', 'utf8');
    await expect(verifyPinnedSnapshot({ repoRoot: repoDir, bundlePath, manifest })).rejects.toThrow(
      /Unexpected supported\/config file/,
    );
    await rm(ignoredFilePath, { force: true });

    // Tampered external bundle with fabricated matching hashes CANNOT authenticate a modified checkout
    const tamperedText = 'export const a = 999;\n';
    const tamperedBuf = Buffer.from(tamperedText, 'utf8');
    await writeFile(path.join(repoDir, 'src', 'a.ts'), tamperedBuf);
    const fabricatedBundlePath = path.join(path.dirname(bundlePath), 'tampered-bundle.json');
    await writeFile(
      fabricatedBundlePath,
      JSON.stringify({
        schemaVersion: 1,
        repository: 'org/synthetic',
        commitSha: headSha,
        sourceCount: 2,
        configCount: 0,
        skippedSpecialEntries: 0,
        files: [
          {
            path: 'src/a.ts',
            kind: 'source',
            gitBlobId: gitBlobSha1Hex(tamperedBuf),
            sha256: sha256BufferHex(tamperedBuf),
            byteLength: tamperedBuf.byteLength,
          },
          {
            path: 'src/b.ts',
            kind: 'source',
            gitBlobId: gitBlobSha1Hex(bBuf),
            sha256: sha256BufferHex(bBuf),
            byteLength: bBuf.byteLength,
          },
        ],
      }),
      'utf8',
    );
    await expect(
      verifyPinnedSnapshot({
        repoRoot: repoDir,
        bundlePath: fabricatedBundlePath,
        manifest,
      }),
    ).rejects.toThrow(/working tree is not clean/);

    // Even if checkout is restored clean, a tampered bundle with a fabricated blob ID fails against authoritative `git ls-tree HEAD`
    await writeFile(path.join(repoDir, 'src', 'a.ts'), aBuf);
    await expect(
      verifyPinnedSnapshot({
        repoRoot: repoDir,
        bundlePath: fabricatedBundlePath,
        manifest,
      }),
    ).rejects.toThrow(/Git blob SHA-1 mismatch between git ls-tree HEAD/);
  });

  it('verifies non-UTF-8 (UTF-16LE BOM) source files on raw original bytes without UTF-8 round-trip rejection', async () => {
    const utf16Bom = Buffer.from([0xff, 0xfe]);
    const utf16Body = Buffer.from('export type Row = { id: string };\r\n', 'utf16le');
    const utf16Raw = Buffer.concat([utf16Bom, utf16Body]);
    const aText = "import type { Row } from './types_db';\nexport type R = Row;\n";
    const aBuf = Buffer.from(aText, 'utf8');

    const { repoDir, headSha, bundlePath } = await createTempGitRepo({
      'src/a.ts': aBuf,
      'src/types_db.ts': utf16Raw,
    });

    const manifest = makeSyntheticManifest({
      commitSha: headSha,
      annotatedFileProvenance: [
        {
          path: 'src/a.ts',
          status: 'complete',
          gitBlobId: gitBlobSha1Hex(aBuf),
          sha256: sha256BufferHex(aBuf),
          byteLength: aBuf.byteLength,
        },
      ],
      referencedTargetAndConfigProvenance: [
        {
          path: 'src/types_db.ts',
          role: 'target',
          gitBlobId: gitBlobSha1Hex(utf16Raw),
          sha256: sha256BufferHex(utf16Raw),
          byteLength: utf16Raw.byteLength,
        },
      ],
    });

    const verified = await verifyPinnedSnapshot({
      repoRoot: repoDir,
      bundlePath,
      manifest,
      expectedSourceCount: 2,
      expectedConfigCount: 0,
    });
    expect(verified.supportedFiles).toEqual(['src/a.ts', 'src/types_db.ts']);
    expect(verified.totalSupportedBytes).toBe(aBuf.byteLength + utf16Raw.byteLength);
  });

  it('guards CLI execution across Windows/POSIX paths so importing evaluate-recall never runs analysis', () => {
    const selfPath = fileURLToPath(import.meta.url);
    expect(isMainModule(import.meta.url, undefined)).toBe(false);
    expect(isMainModule(import.meta.url, '')).toBe(false);
    expect(isMainModule(import.meta.url, path.join(path.dirname(selfPath), 'other.ts'))).toBe(
      false,
    );
    expect(isMainModule(import.meta.url, selfPath)).toBe(true);
    if (process.platform === 'win32') {
      expect(isMainModule(import.meta.url, selfPath.toUpperCase())).toBe(true);
    }
  });
  function makeSyntheticRunRecord(options: {
    readonly repoId: FrozenRepoId;
    readonly durationMs?: number;
    readonly importsFpCount?: number;
    readonly importsFnCount?: number;
    readonly primaryCallsFpCount?: number;
    readonly primaryCallsFnCount?: number;
    readonly matchedExtensionCount?: number;
    readonly skipLoadingLibFiles?: boolean;
    readonly maxCallSiteSnippetChars?: number;
    readonly graphDigest?: string;
    readonly nodeVersion?: string;
  }): SingleRepoRunRecord {
    const spec = FROZEN_EVAL_REPOS[options.repoId];
    const importsFpCount = options.importsFpCount ?? 0;
    const importsFnCount = options.importsFnCount ?? 0;
    const primaryCallsFpCount = options.primaryCallsFpCount ?? 0;
    const primaryCallsFnCount = options.primaryCallsFnCount ?? 0;
    const matchedExtensionCount = options.matchedExtensionCount ?? 0;

    const importsTp = spec.expectedImportsCount - importsFnCount;
    const primaryTp = spec.expectedPrimaryCallsCount - primaryCallsFnCount;
    const extExpected = spec.wrapperExtensionCalls;
    const matchedExts = extExpected.slice(0, matchedExtensionCount);
    const missedExts = extExpected.slice(matchedExtensionCount);
    const broaderTp = primaryTp + matchedExts.length;

    const makeFakeImportList = (
      prefix: string,
      count: number,
    ): readonly CanonicalImportIdentity[] =>
      Array.from({ length: count }, (_, idx) => ({
        sourceQualifiedName: `file:${spec.selectedSourceFiles[0] ?? 'src/a.ts'}`,
        targetQualifiedName: `file:src/${prefix}_${String(idx)}.ts`,
        edgeType: 'IMPORTS' as const,
      }));

    const makeFakeCallList = (prefix: string, count: number): readonly CanonicalCallIdentity[] =>
      Array.from({ length: count }, (_, idx) => ({
        sourceQualifiedName: `${spec.selectedSourceFiles[0] ?? 'src/a.ts'}::fn:caller`,
        targetQualifiedName: `src/${prefix}.ts::fn:target`,
        edgeType: 'CALLS' as const,
        callSiteLine: idx + 1,
      }));

    const buildMetrics = <T>(
      expectedCount: number,
      tp: number,
      fpItems: readonly T[],
      fnItems: readonly T[],
    ) => {
      const fp = fpItems.length;
      const fn = fnItems.length;
      const predictedCount = tp + fp;
      return {
        expectedCount,
        predictedCount,
        tp,
        fp,
        fn,
        precision: tp + fp === 0 ? null : tp / (tp + fp),
        recall: tp + fn === 0 ? null : tp / (tp + fn),
        f1: 2 * tp + fp + fn === 0 ? null : (2 * tp) / (2 * tp + fp + fn),
        duplicateExpectedCount: 0,
        duplicatePredictedCount: 0,
        falsePositives: fpItems,
        falseNegatives: fnItems,
      };
    };

    const importsMetrics = buildMetrics(
      spec.expectedImportsCount,
      importsTp,
      makeFakeImportList('fp_imp', importsFpCount),
      makeFakeImportList('fn_imp', importsFnCount),
    );
    const primaryFpCalls = makeFakeCallList('fp_call', primaryCallsFpCount);
    const primaryFnCalls = makeFakeCallList('fn_call', primaryCallsFnCount);
    const primaryMetrics = buildMetrics(
      spec.expectedPrimaryCallsCount,
      primaryTp,
      primaryFpCalls,
      primaryFnCalls,
    );
    const broaderMetrics = buildMetrics(spec.expectedBroaderCallsCount, broaderTp, primaryFpCalls, [
      ...primaryFnCalls,
      ...missedExts,
    ]);
    const extMetrics = buildMetrics(extExpected.length, matchedExts.length, [], missedExts);

    const totalGraphImports = importsMetrics.predictedCount + 10;
    const totalGraphCalls = broaderMetrics.predictedCount + 20;

    return {
      schemaVersion: 1,
      repoId: spec.id,
      manifestRelativePath: spec.manifestRelativePath,
      manifestSha256: spec.manifestSha256,
      analysisOptions: {
        skipLoadingLibFiles: options.skipLoadingLibFiles ?? false,
        maxCallSiteSnippetChars: options.maxCallSiteSnippetChars ?? 512,
      },
      environment: {
        nodeVersion: options.nodeVersion ?? 'v24.0.0',
        platform: 'win32',
        osRelease: '10.0.22631',
        arch: 'x64',
        bundledTypeScriptVersion: '6.0.2',
      },
      snapshotInventory: {
        supportedFilesCount: spec.inventoriedSourceCount,
        configFilesCount: spec.inventoriedConfigCount,
        totalSupportedBytes: 50_000,
        totalConfigBytes: 1_000,
      },
      analysisDurationMs: options.durationMs ?? 500,
      memory: {
        baselineHeapUsedBytes: 20_000_000,
        postAnalysisHeapUsedBytes: 55_000_000,
        baselineRssBytes: 60_000_000,
        postAnalysisRssBytes: 120_000_000,
        processLifetimeMaxRssKiB: 130_000,
      },
      stats: {
        discoveredFilesCount: spec.inventoriedSourceCount,
        parsedFilesCount: spec.inventoriedSourceCount,
        skippedSyntaxErrorFilesCount: 0,
        skippedOversizedFilesCount: 0,
        configFilesCount: spec.inventoriedConfigCount,
        folderNodeCount: 5,
        fileNodeCount: spec.inventoriedSourceCount,
        functionNodeCount: 40,
        classNodeCount: 2,
        symbolNodeCount: 15,
        importsEdgeCount: totalGraphImports,
        callsEdgeCount: totalGraphCalls,
        totalBytesRead: 51_000,
        truncatedWarningsCount: 0,
      },
      warnings: [],
      score: {
        repository: spec.repository,
        commitSha: spec.commitSha,
        annotatedFilesCount: spec.selectedSourceFiles.length,
        totalGraphImportsCount: totalGraphImports,
        totalGraphCallsCount: totalGraphCalls,
        scopedPredictedImportsCount: importsMetrics.predictedCount,
        scopedPredictedCallsCount: broaderMetrics.predictedCount,
        unscoredWrapperExtensionPredictions: matchedExts,
        groupedExclusionRecordsCount: 10,
        declaredUncertainCandidatesCount: 0,
        imports: importsMetrics,
        primaryCalls: primaryMetrics,
        broaderCalls: broaderMetrics,
        wrapperExtensions: {
          expectedExtensions: extExpected,
          matchedExtensions: matchedExts,
          missedExtensions: missedExts,
          metrics: extMetrics,
        },
        graphIntegrity: {
          valid: true,
          violations: [],
        },
        graphDigest: options.graphDigest ?? sha256BufferHex(Buffer.from(spec.id, 'utf8')),
      },
    };
  }

  it('rejects out-of-bounds expected CALLS lines, out-of-bounds exclusion lines, and config files listed in selectedSourceFiles during snapshot verification', async () => {
    const aText = 'export function run() {\n  return 1;\n}\n'; // exactly 3 lines
    const bText = 'export const b = 2;\n';
    const tsconfigText = '{ "compilerOptions": {} }\n';
    const { repoDir, headSha, bundlePath } = await createTempGitRepo({
      'src/a.ts': aText,
      'src/b.ts': bText,
      'tsconfig.json': tsconfigText,
    });

    const aBuf = Buffer.from(aText, 'utf8');
    const bBuf = Buffer.from(bText, 'utf8');
    const cfgBuf = Buffer.from(tsconfigText, 'utf8');

    const baseProvenance = {
      commitSha: headSha,
      annotatedFileProvenance: [
        {
          path: 'src/a.ts',
          status: 'complete' as const,
          gitBlobId: gitBlobSha1Hex(aBuf),
          sha256: sha256BufferHex(aBuf),
          byteLength: aBuf.byteLength,
        },
      ],
      referencedTargetAndConfigProvenance: [
        {
          path: 'src/b.ts',
          role: 'target',
          gitBlobId: gitBlobSha1Hex(bBuf),
          sha256: sha256BufferHex(bBuf),
          byteLength: bBuf.byteLength,
        },
        {
          path: 'tsconfig.json',
          role: 'config',
          gitBlobId: gitBlobSha1Hex(cfgBuf),
          sha256: sha256BufferHex(cfgBuf),
          byteLength: cfgBuf.byteLength,
        },
      ],
    };

    // 1. Out-of-bounds expected CALLS callSiteLine (line 4 on a 3-line file ending in LF)
    const badCallManifest = makeSyntheticManifest({
      ...baseProvenance,
      expectedCalls: [
        {
          sourceQualifiedName: 'src/a.ts::fn:run',
          targetQualifiedName: 'src/b.ts::fn:b',
          edgeType: 'CALLS',
          callSiteLine: 4,
          evidence: 'out of bounds',
        },
      ],
    });
    await expect(
      verifyPinnedSnapshot({ repoRoot: repoDir, bundlePath, manifest: badCallManifest }),
    ).rejects.toThrow(/Expected CALLS callSiteLine 4 is out of bounds/);

    // 2. Out-of-bounds exclusion record line (line 5 on a 3-line file)
    const badExclusionManifest = makeSyntheticManifest({
      ...baseProvenance,
      excludedOrUncertainCandidates: [
        {
          filePath: 'src/a.ts',
          line: 5,
          expression: 'console.log()',
          classification: 'excluded',
          reason: 'stdlib',
          notes: 'out of bounds',
        },
      ],
    });
    await expect(
      verifyPinnedSnapshot({ repoRoot: repoDir, bundlePath, manifest: badExclusionManifest }),
    ).rejects.toThrow(/Manifest excluded record line 5 is out of bounds/);

    // 3. Config file mistakenly listed inside selectedSourceFiles
    const configAsSelectedManifest = makeSyntheticManifest({
      commitSha: headSha,
      selectedSourceFiles: ['src/a.ts', 'tsconfig.json'],
      annotatedFileProvenance: [
        ...baseProvenance.annotatedFileProvenance,
        {
          path: 'tsconfig.json',
          status: 'complete' as const,
          gitBlobId: gitBlobSha1Hex(cfgBuf),
          sha256: sha256BufferHex(cfgBuf),
          byteLength: cfgBuf.byteLength,
        },
      ],
      referencedTargetAndConfigProvenance: [
        {
          path: 'src/b.ts',
          role: 'target',
          gitBlobId: gitBlobSha1Hex(bBuf),
          sha256: sha256BufferHex(bBuf),
          byteLength: bBuf.byteLength,
        },
      ],
    });
    await expect(
      verifyPinnedSnapshot({ repoRoot: repoDir, bundlePath, manifest: configAsSelectedManifest }),
    ).rejects.toThrow(/classified as "config", expected supported "source"/);
  });

  it('loads and validates all three actual frozen ground-truth manifests against FROZEN_EVAL_REPOS without snapshots or network', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const orderedIds: readonly FrozenRepoId[] = [
      'zustand',
      'nextjs-subscription-payments',
      'taxonomy',
    ];

    let totalSelectedFiles = 0;
    let totalImports = 0;
    let totalPrimaryCalls = 0;
    let totalBroaderCalls = 0;
    let totalUncertain = 0;

    for (const id of orderedIds) {
      const spec = FROZEN_EVAL_REPOS[id];
      const manifestPath = path.resolve(repoRoot, ...spec.manifestRelativePath.split('/'));
      const { manifest, actualSha256 } = await verifyAndLoadFrozenManifest(
        manifestPath,
        spec.manifestSha256,
        spec,
      );

      expect(actualSha256).toBe(spec.manifestSha256);
      expect(manifest.repository).toBe(spec.repository);
      expect(manifest.commitSha).toBe(spec.commitSha);
      expect(manifest.selectedSourceFiles).toEqual(spec.selectedSourceFiles);
      expect(manifest.expectedImports).toHaveLength(spec.expectedImportsCount);
      expect(manifest.expectedCalls).toHaveLength(spec.expectedBroaderCallsCount);

      const extensionKeys = new Set(spec.wrapperExtensionCalls.map(serializeCallIdentity));
      const primaryCallsCount = manifest.expectedCalls.filter(
        (c) => !extensionKeys.has(serializeCallIdentity(c)),
      ).length;
      expect(primaryCallsCount).toBe(spec.expectedPrimaryCallsCount);

      const uncertainCount = manifest.excludedOrUncertainCandidates.filter(
        (c) => c.classification === 'uncertain',
      ).length;
      expect(uncertainCount).toBe(0);

      totalSelectedFiles += manifest.selectedSourceFiles.length;
      totalImports += manifest.expectedImports.length;
      totalPrimaryCalls += primaryCallsCount;
      totalBroaderCalls += manifest.expectedCalls.length;
      totalUncertain += uncertainCount;
    }

    expect(totalSelectedFiles).toBe(30);
    expect(totalImports).toBe(77);
    expect(totalPrimaryCalls).toBe(160);
    expect(totalBroaderCalls).toBe(163);
    expect(totalUncertain).toBe(0);
  });

  it('rejects malformed, incomplete, wrong-digest, wrong-commit, and arithmetically inconsistent run records', () => {
    const valid = makeSyntheticRunRecord({ repoId: 'zustand' });
    expect(parseAndValidateRunRecord(valid, 'valid').repoId).toBe('zustand');

    // Malformed / incomplete objects
    expect(() => parseAndValidateRunRecord(null, 'null')).toThrow(EvaluationError);
    expect(() =>
      parseAndValidateRunRecord({ schemaVersion: 1, repoId: 'zustand' }, 'partial'),
    ).toThrow(EvaluationError);

    // Non-finite timing or negative memory
    expect(() =>
      parseAndValidateRunRecord({ ...valid, analysisDurationMs: Number.NaN }, 'nan-duration'),
    ).toThrow(EvaluationError);
    expect(() =>
      parseAndValidateRunRecord(
        { ...valid, memory: { ...valid.memory, baselineRssBytes: -1 } },
        'neg-mem',
      ),
    ).toThrow(EvaluationError);

    // Wrong frozen manifest digest
    expect(() =>
      parseAndValidateRunRecord({ ...valid, manifestSha256: '0'.repeat(64) }, 'bad-digest'),
    ).toThrow(/manifestSha256 mismatch/);

    // Wrong pinned commit SHA
    expect(() =>
      parseAndValidateRunRecord(
        { ...valid, score: { ...valid.score, commitSha: '0'.repeat(40) } },
        'bad-commit',
      ),
    ).toThrow(/commitSha mismatch/);

    // Arithmetically inconsistent metrics (tp + fn !== expectedCount)
    expect(() =>
      parseAndValidateRunRecord(
        {
          ...valid,
          score: {
            ...valid.score,
            imports: { ...valid.score.imports, tp: valid.score.imports.tp - 1 },
          },
        },
        'bad-arith',
      ),
    ).toThrow(/arithmetic mismatch/);

    // Invalid graph integrity cannot be aggregated
    expect(() =>
      parseAndValidateRunRecord(
        {
          ...valid,
          score: {
            ...valid.score,
            graphIntegrity: { valid: false, violations: ['broken endpoint'] },
          },
        },
        'bad-integrity',
      ),
    ).toThrow(/graphIntegrity must be valid/);
  });

  it('enforces baseline aggregation invariants (coverage, 3 runs/repo, skipLoadingLibFiles: false, consistent options/env, digests, scores, unique CLI paths) and labels partial mode explicitly', async () => {
    const z1 = makeSyntheticRunRecord({ repoId: 'zustand', durationMs: 100 });
    const z2 = makeSyntheticRunRecord({ repoId: 'zustand', durationMs: 120 });
    const z3 = makeSyntheticRunRecord({ repoId: 'zustand', durationMs: 110 });
    const p1 = makeSyntheticRunRecord({ repoId: 'nextjs-subscription-payments', durationMs: 200 });
    const p2 = makeSyntheticRunRecord({ repoId: 'nextjs-subscription-payments', durationMs: 210 });
    const p3 = makeSyntheticRunRecord({ repoId: 'nextjs-subscription-payments', durationMs: 220 });
    const t1 = makeSyntheticRunRecord({ repoId: 'taxonomy', durationMs: 300 });
    const t2 = makeSyntheticRunRecord({ repoId: 'taxonomy', durationMs: 310 });
    const t3 = makeSyntheticRunRecord({ repoId: 'taxonomy', durationMs: 320 });

    // 1. Missing repository rejected in baseline mode
    expect(() => buildAggregatedReport([z1, z2, z3, p1, p2, p3])).toThrow(
      /missing required repository "taxonomy"/,
    );

    // 2. Wrong repetition count (2 instead of 3) rejected in baseline mode
    expect(() => buildAggregatedReport([z1, z2, p1, p2, p3, t1, t2, t3])).toThrow(
      /requires exactly 3 fresh-process runs for "zustand"/,
    );

    // 3. skipLoadingLibFiles: true rejected in official baseline mode
    const noLibRuns = [
      makeSyntheticRunRecord({ repoId: 'zustand', skipLoadingLibFiles: true }),
      makeSyntheticRunRecord({ repoId: 'zustand', skipLoadingLibFiles: true }),
      makeSyntheticRunRecord({ repoId: 'zustand', skipLoadingLibFiles: true }),
      makeSyntheticRunRecord({ repoId: 'nextjs-subscription-payments', skipLoadingLibFiles: true }),
      makeSyntheticRunRecord({ repoId: 'nextjs-subscription-payments', skipLoadingLibFiles: true }),
      makeSyntheticRunRecord({ repoId: 'nextjs-subscription-payments', skipLoadingLibFiles: true }),
      makeSyntheticRunRecord({ repoId: 'taxonomy', skipLoadingLibFiles: true }),
      makeSyntheticRunRecord({ repoId: 'taxonomy', skipLoadingLibFiles: true }),
      makeSyntheticRunRecord({ repoId: 'taxonomy', skipLoadingLibFiles: true }),
    ];
    expect(() => buildAggregatedReport(noLibRuns)).toThrow(
      /Official baseline report requires skipLoadingLibFiles: false/,
    );

    // 4. Mixed analysisOptions or inconsistent environment rejected even in partial mode
    expect(() =>
      buildAggregatedReport(
        [z1, makeSyntheticRunRecord({ repoId: 'zustand', maxCallSiteSnippetChars: 256 })],
        { mode: 'partial' },
      ),
    ).toThrow(/Inconsistent analysisOptions/);
    expect(() =>
      buildAggregatedReport(
        [z1, makeSyntheticRunRecord({ repoId: 'zustand', nodeVersion: 'v22.0.0' })],
        { mode: 'partial' },
      ),
    ).toThrow(/Inconsistent runtime\/compiler environment/);

    // 5. Mismatched graphDigest across repetitions rejected
    const badDigestZ2 = makeSyntheticRunRecord({
      repoId: 'zustand',
      graphDigest: 'f'.repeat(64),
    });
    expect(() => buildAggregatedReport([z1, badDigestZ2], { mode: 'partial' })).toThrow(
      /Non-deterministic graphDigest/,
    );

    // 6. Same digest but different repeated score payload rejected
    const differentScoreZ2 = makeSyntheticRunRecord({
      repoId: 'zustand',
      importsFnCount: 1,
      graphDigest: z1.score.graphDigest,
    });
    expect(() => buildAggregatedReport([z1, differentScoreZ2], { mode: 'partial' })).toThrow(
      /Inconsistent repeated score payload/,
    );

    // 7. Partial mode succeeds when explicitly requested and labels Markdown as PARTIAL
    const partialReport = buildAggregatedReport([z1], { mode: 'partial' });
    expect(partialReport.reportMode).toBe('partial');
    expect(formatMarkdownReport(partialReport)).toContain('PARTIAL — Not Official Baseline');

    // 8. CLI `report` rejects duplicate input run files
    const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-dup-run-'));
    tempDirs.push(dir);
    const runFile = path.join(dir, 'z1.json');
    await writeFile(runFile, JSON.stringify(z1), 'utf8');
    await expect(
      runCli(['report', '--run', runFile, '--run', runFile, '--partial']),
    ).rejects.toThrow(/Duplicate input run file/);
  });

  it('aggregates nine valid fresh-process run records across all three repositories into an exact three-repository micro-average', () => {
    // Zustand: IMPORTS 14/14 (0 FP, 0 FN), Primary CALLS 30/31 (1 FP, 1 FN)
    const zRuns = [120, 100, 140].map((durationMs) =>
      makeSyntheticRunRecord({
        repoId: 'zustand',
        durationMs,
        primaryCallsFpCount: 1,
        primaryCallsFnCount: 1,
      }),
    );

    // Payments: IMPORTS 30/33 (0 FP, 3 FN), Primary CALLS 88/90 (2 FP, 2 FN), 1/3 wrapper extensions matched
    const pRuns = [300, 260, 280].map((durationMs) =>
      makeSyntheticRunRecord({
        repoId: 'nextjs-subscription-payments',
        durationMs,
        importsFnCount: 3,
        primaryCallsFpCount: 2,
        primaryCallsFnCount: 2,
        matchedExtensionCount: 1,
      }),
    );

    // Taxonomy: IMPORTS 30/30 (0 FP, 0 FN), Primary CALLS 38/39 (0 FP, 1 FN)
    const tRuns = [510, 490, 500].map((durationMs) =>
      makeSyntheticRunRecord({
        repoId: 'taxonomy',
        durationMs,
        primaryCallsFnCount: 1,
      }),
    );

    const report = buildAggregatedReport([...zRuns, ...pRuns, ...tRuns]);
    expect(report.reportMode).toBe('baseline');
    expect(report.repositories).toHaveLength(3);

    // Each repo has 3 runs and exact median durations (120, 280, 500)
    expect(report.repositories.map((r) => r.runCount)).toEqual([3, 3, 3]);
    expect(report.repositories.map((r) => r.medianDurationMs)).toEqual([120, 280, 500]);

    // Micro-averaged ONCE per repository (NOT 3x):
    // IMPORTS: expected = 14+33+30 = 77, TP = 14+30+30 = 74, FP = 0, FN = 3
    expect(report.aggregate.imports.annotatedFilesCount).toBe(30);
    expect(report.aggregate.imports.expectedCount).toBe(77);
    expect(report.aggregate.imports.tp).toBe(74);
    expect(report.aggregate.imports.fp).toBe(0);
    expect(report.aggregate.imports.fn).toBe(3);
    expect(report.aggregate.imports.recall).toBeCloseTo(74 / 77, 12);
    expect(report.aggregate.imports.meetsRecallTarget).toBe(true);

    // Primary CALLS: expected = 31+90+39 = 160, TP = 30+88+38 = 156, FP = 1+2+0 = 3, FN = 1+2+1 = 4
    expect(report.aggregate.primaryCalls.expectedCount).toBe(160);
    expect(report.aggregate.primaryCalls.tp).toBe(156);
    expect(report.aggregate.primaryCalls.fp).toBe(3);
    expect(report.aggregate.primaryCalls.fn).toBe(4);
    expect(report.aggregate.primaryCalls.recall).toBeCloseTo(156 / 160, 12);
    expect(report.aggregate.primaryCalls.meetsRecallTarget).toBe(true);

    // Broader CALLS: expected = 31+93+39 = 163, TP = 156+1 = 157, FP = 3, FN = 4+2 = 6
    expect(report.aggregate.broaderCalls.expectedCount).toBe(163);
    expect(report.aggregate.broaderCalls.tp).toBe(157);
    expect(report.aggregate.broaderCalls.fp).toBe(3);
    expect(report.aggregate.broaderCalls.fn).toBe(6);
    expect(report.aggregate.broaderCalls.recall).toBeCloseTo(157 / 163, 12);
    expect(report.aggregate.wrapperExtensions.tp).toBe(1);
    expect(report.aggregate.wrapperExtensions.fn).toBe(2);
    expect(report.aggregate.totalUnscoredWrapperExtensionPredictions).toBe(1);

    const md = formatMarkdownReport(report);
    expect(md).toContain('Official Baseline');
  });
});
