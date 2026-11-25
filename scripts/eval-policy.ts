import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
  validateRepoRelativePath,
  type AnalysisOutput,
  type AnalysisStats,
  type ExtractedEdge,
  type ExtractedNode,
} from '@archon/core';

export const RECALL_TARGET_THRESHOLD = 0.95;
const HEX_40_RE = /^[0-9a-f]{40}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;

export type FrozenRepoId = 'zustand' | 'nextjs-subscription-payments' | 'taxonomy';

export interface CanonicalImportIdentity {
  readonly sourceQualifiedName: string;
  readonly targetQualifiedName: string;
  readonly edgeType: 'IMPORTS';
}

export interface CanonicalCallIdentity {
  readonly sourceQualifiedName: string;
  readonly targetQualifiedName: string;
  readonly edgeType: 'CALLS';
  readonly callSiteLine: number;
}

export interface ExpectedImportRecord extends CanonicalImportIdentity {
  readonly evidence: string;
}

export interface ExpectedCallRecord extends CanonicalCallIdentity {
  readonly evidence: string;
}

export interface AnnotatedFileProvenance {
  readonly path: string;
  readonly status: 'complete';
  readonly gitBlobId: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ReferencedFileProvenance {
  readonly path: string;
  readonly role: string;
  readonly gitBlobId: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ExcludedOrUncertainCandidate {
  readonly filePath: string;
  readonly line: number;
  readonly expression: string;
  readonly classification: 'excluded' | 'uncertain';
  readonly reason: string;
  readonly notes: string;
}

export interface ScoringPolicyMetadata {
  readonly importsIdentity: string;
  readonly callsIdentity: string;
  readonly scopeFiltering: string;
  readonly uncertainCandidatePolicy: string;
  readonly zeroDenominatorPolicy: string;
}

export interface GroundTruthManifest {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly commitSha: string;
  readonly annotationMethod: string;
  readonly samplingRationale: string;
  readonly scoringPolicy: ScoringPolicyMetadata;
  readonly selectedSourceFiles: readonly string[];
  readonly annotatedFileProvenance: readonly AnnotatedFileProvenance[];
  readonly referencedTargetAndConfigProvenance: readonly ReferencedFileProvenance[];
  readonly expectedImports: readonly ExpectedImportRecord[];
  readonly expectedCalls: readonly ExpectedCallRecord[];
  readonly excludedOrUncertainCandidates: readonly ExcludedOrUncertainCandidate[];
  readonly notes: readonly string[];
}

export interface FrozenRepoSpec {
  readonly id: FrozenRepoId;
  readonly repository: string;
  readonly commitSha: string;
  readonly manifestRelativePath: string;
  readonly manifestSha256: string;
  readonly inventoriedSourceCount: number;
  readonly inventoriedConfigCount: number;
  readonly selectedSourceFiles: readonly string[];
  readonly expectedImportsCount: number;
  readonly expectedPrimaryCallsCount: number;
  readonly expectedBroaderCallsCount: number;
  readonly wrapperExtensionCalls: readonly CanonicalCallIdentity[];
}

export const PAYMENTS_WRAPPER_EXTENSION_CALLS: readonly CanonicalCallIdentity[] = [
  {
    sourceQualifiedName: 'app/page.tsx::fn:PricingPage',
    targetQualifiedName: 'utils/supabase/queries.ts::sym:getUser',
    edgeType: 'CALLS',
    callSiteLine: 12,
  },
  {
    sourceQualifiedName: 'app/page.tsx::fn:PricingPage',
    targetQualifiedName: 'utils/supabase/queries.ts::sym:getProducts',
    edgeType: 'CALLS',
    callSiteLine: 13,
  },
  {
    sourceQualifiedName: 'app/page.tsx::fn:PricingPage',
    targetQualifiedName: 'utils/supabase/queries.ts::sym:getSubscription',
    edgeType: 'CALLS',
    callSiteLine: 14,
  },
];

export const FROZEN_EVAL_REPOS: Readonly<Record<FrozenRepoId, FrozenRepoSpec>> = {
  zustand: {
    id: 'zustand',
    repository: 'pmndrs/zustand',
    commitSha: '9fed2eb2f3af672da9f7bf694b996df3831fc207',
    manifestRelativePath: 'scripts/ground-truth/zustand.json',
    manifestSha256: 'f51de18e9df3ae8ba5f0f9c95f3c4f0758b5df6dd4969d55ba3abce526148739',
    inventoriedSourceCount: 49,
    inventoriedConfigCount: 5,
    selectedSourceFiles: [
      'src/index.ts',
      'src/vanilla.ts',
      'src/react.ts',
      'src/traditional.ts',
      'src/middleware.ts',
      'src/middleware/combine.ts',
      'src/middleware/persist.ts',
      'src/react/shallow.ts',
      'src/vanilla/shallow.ts',
      'tests/vanilla/basic.test.ts',
    ],
    expectedImportsCount: 14,
    expectedPrimaryCallsCount: 31,
    expectedBroaderCallsCount: 31,
    wrapperExtensionCalls: [],
  },
  'nextjs-subscription-payments': {
    id: 'nextjs-subscription-payments',
    repository: 'vercel/nextjs-subscription-payments',
    commitSha: 'bdd0813206e47e6b218d42f15a7976c8a0d3c3eb',
    manifestRelativePath: 'scripts/ground-truth/nextjs-subscription-payments.json',
    manifestSha256: '11e5976ebd0d121fd4f0e5935a4e51458649f29f0c4f3197a6fd798336d72dc0',
    inventoriedSourceCount: 56,
    inventoriedConfigCount: 2,
    selectedSourceFiles: [
      'app/page.tsx',
      'app/api/webhooks/route.ts',
      'app/signin/[id]/page.tsx',
      'components/ui/Pricing/Pricing.tsx',
      'components/ui/Button/Button.tsx',
      'components/ui/Button/index.ts',
      'utils/auth-helpers/server.ts',
      'utils/supabase/queries.ts',
      'utils/stripe/server.ts',
      'utils/helpers.ts',
    ],
    expectedImportsCount: 33,
    expectedPrimaryCallsCount: 90,
    expectedBroaderCallsCount: 93,
    wrapperExtensionCalls: PAYMENTS_WRAPPER_EXTENSION_CALLS,
  },
  taxonomy: {
    id: 'taxonomy',
    repository: 'shadcn-ui/taxonomy',
    commitSha: '298a8857c7128a0d121e7f699dfd729f23b3966d',
    manifestRelativePath: 'scripts/ground-truth/taxonomy.json',
    manifestSha256: '968e99b0ab8a122aa31051a0cf5c7177672484134485408f0538b0b12861d03c',
    inventoriedSourceCount: 129,
    inventoriedConfigCount: 2,
    selectedSourceFiles: [
      'app/(dashboard)/dashboard/page.tsx',
      'app/api/posts/[postId]/route.ts',
      'app/(editor)/editor/[postId]/page.tsx',
      'components/post-operations.tsx',
      'components/user-auth-form.tsx',
      'components/ui/button.tsx',
      'lib/subscription.ts',
      'lib/toc.ts',
      'lib/utils.ts',
      'lib/exceptions.ts',
    ],
    expectedImportsCount: 30,
    expectedPrimaryCallsCount: 39,
    expectedBroaderCallsCount: 39,
    wrapperExtensionCalls: [],
  },
};

export interface EdgeSetMetrics<T> {
  readonly expectedCount: number;
  readonly predictedCount: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly duplicateExpectedCount: number;
  readonly duplicatePredictedCount: number;
  readonly falsePositives: readonly T[];
  readonly falseNegatives: readonly T[];
}

export interface AggregateScopeMetrics {
  readonly annotatedFilesCount: number;
  readonly expectedCount: number;
  readonly predictedCount: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly meetsRecallTarget: boolean | null;
}

export interface WrapperExtensionEvaluation {
  readonly expectedExtensions: readonly CanonicalCallIdentity[];
  readonly matchedExtensions: readonly CanonicalCallIdentity[];
  readonly missedExtensions: readonly CanonicalCallIdentity[];
  readonly metrics: EdgeSetMetrics<CanonicalCallIdentity>;
}

export interface GraphIntegrityResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

export interface RepositoryScoreResult {
  readonly repository: string;
  readonly commitSha: string;
  readonly annotatedFilesCount: number;
  readonly totalGraphImportsCount: number;
  readonly totalGraphCallsCount: number;
  readonly scopedPredictedImportsCount: number;
  readonly scopedPredictedCallsCount: number;
  readonly unscoredWrapperExtensionPredictions: readonly CanonicalCallIdentity[];
  readonly groupedExclusionRecordsCount: number;
  readonly declaredUncertainCandidatesCount: number;
  readonly imports: EdgeSetMetrics<CanonicalImportIdentity>;
  readonly primaryCalls: EdgeSetMetrics<CanonicalCallIdentity>;
  readonly broaderCalls: EdgeSetMetrics<CanonicalCallIdentity>;
  readonly wrapperExtensions: WrapperExtensionEvaluation;
  readonly graphIntegrity: GraphIntegrityResult;
  readonly graphDigest: string;
}

export interface AggregateEvaluationMetrics {
  readonly imports: AggregateScopeMetrics;
  readonly primaryCalls: AggregateScopeMetrics;
  readonly broaderCalls: AggregateScopeMetrics;
  readonly wrapperExtensions: AggregateScopeMetrics;
  readonly totalUnscoredWrapperExtensionPredictions: number;
  readonly totalGroupedExclusionRecords: number;
  readonly totalDeclaredUncertainCandidates: number;
}

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationError';
  }
}

export function compareCodePoint(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function sha256BufferHex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function gitBlobSha1Hex(buffer: Buffer): string {
  const header = Buffer.from(`blob ${String(buffer.byteLength)}\0`, 'utf8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

export function isFrozenRepoId(value: string): value is FrozenRepoId {
  return value === 'zustand' || value === 'nextjs-subscription-payments' || value === 'taxonomy';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonUnknown(rawText: string, label: string): unknown {
  try {
    const parsed: unknown = JSON.parse(rawText);
    return parsed;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : 'invalid JSON';
    throw new EvaluationError(`Failed to parse ${label} as JSON: ${detail}`);
  }
}

function readRequiredString(obj: Record<string, unknown>, field: string, context: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EvaluationError(`${context}.${field} must be a non-empty string.`);
  }
  return value;
}

function readNonNegativeSafeInt(
  obj: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new EvaluationError(`${context}.${field} must be a non-negative safe integer.`);
  }
  return value;
}

function readPositiveSafeInt(obj: Record<string, unknown>, field: string, context: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new EvaluationError(`${context}.${field} must be a positive safe integer.`);
  }
  return value;
}

function readHexString(
  obj: Record<string, unknown>,
  field: string,
  regex: RegExp,
  context: string,
): string {
  const value = readRequiredString(obj, field, context);
  if (!regex.test(value)) {
    throw new EvaluationError(`${context}.${field} is not a valid lowercase hex digest.`);
  }
  return value;
}

function readStringArray(
  obj: Record<string, unknown>,
  field: string,
  context: string,
): readonly string[] {
  const value = obj[field];
  if (!Array.isArray(value)) {
    throw new EvaluationError(`${context}.${field} must be an array.`);
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new EvaluationError(`${context}.${field}[${String(i)}] must be a non-empty string.`);
    }
    result.push(item);
  }
  return result;
}

function unescapeQualifiedFilePath(escaped: string): string {
  return escaped
    .replace(/%3A/gi, ':')
    .replace(/%40/gi, '@')
    .replace(/%23/gi, '#')
    .replace(/%25/gi, '%');
}

export function extractFilePathFromQualifiedName(qualifiedName: string): string {
  if (qualifiedName.startsWith('file:')) {
    const raw = unescapeQualifiedFilePath(qualifiedName.slice('file:'.length));
    return validateRepoRelativePath(raw);
  }
  const sepIdx = qualifiedName.indexOf('::');
  if (sepIdx <= 0) {
    throw new EvaluationError(
      `Invalid qualifiedName "${qualifiedName}": expected "file:<path>" or "<path>::<symbol>".`,
    );
  }
  const raw = unescapeQualifiedFilePath(qualifiedName.slice(0, sepIdx));
  return validateRepoRelativePath(raw);
}

/**
 * Collision-safe canonical serialization for IMPORTS edges:
 * JSON tuple `[sourceQualifiedName, targetQualifiedName, "IMPORTS"]`.
 */
export function serializeImportIdentity(identity: CanonicalImportIdentity): string {
  return JSON.stringify([
    identity.sourceQualifiedName,
    identity.targetQualifiedName,
    identity.edgeType,
  ]);
}

/**
 * Collision-safe canonical serialization for CALLS edges:
 * JSON tuple `[sourceQualifiedName, targetQualifiedName, "CALLS", callSiteLine]`.
 */
export function serializeCallIdentity(identity: CanonicalCallIdentity): string {
  return JSON.stringify([
    identity.sourceQualifiedName,
    identity.targetQualifiedName,
    identity.edgeType,
    identity.callSiteLine,
  ]);
}

export function compareImportIdentities(
  a: CanonicalImportIdentity,
  b: CanonicalImportIdentity,
): number {
  const srcCmp = compareCodePoint(a.sourceQualifiedName, b.sourceQualifiedName);
  if (srcCmp !== 0) {
    return srcCmp;
  }
  const tgtCmp = compareCodePoint(a.targetQualifiedName, b.targetQualifiedName);
  if (tgtCmp !== 0) {
    return tgtCmp;
  }
  return compareCodePoint(a.edgeType, b.edgeType);
}

export function compareCallIdentities(a: CanonicalCallIdentity, b: CanonicalCallIdentity): number {
  const srcCmp = compareCodePoint(a.sourceQualifiedName, b.sourceQualifiedName);
  if (srcCmp !== 0) {
    return srcCmp;
  }
  const tgtCmp = compareCodePoint(a.targetQualifiedName, b.targetQualifiedName);
  if (tgtCmp !== 0) {
    return tgtCmp;
  }
  const typeCmp = compareCodePoint(a.edgeType, b.edgeType);
  if (typeCmp !== 0) {
    return typeCmp;
  }
  return a.callSiteLine - b.callSiteLine;
}

export function formatImportIdentity(edge: CanonicalImportIdentity): string {
  return `${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}`;
}

export function formatCallIdentity(edge: CanonicalCallIdentity): string {
  return `${edge.sourceQualifiedName} -> ${edge.targetQualifiedName} @L${String(edge.callSiteLine)}`;
}

export function formatPercent(value: number | null): string {
  if (value === null) {
    return 'N/A';
  }
  return `${(value * 100).toFixed(2)}%`;
}

export function meetsRecallTarget(
  recall: number | null,
  threshold: number = RECALL_TARGET_THRESHOLD,
): boolean | null {
  if (recall === null) {
    return null;
  }
  return recall >= threshold;
}

/**
 * Strictly validates an unknown JSON value into a trusted `GroundTruthManifest`,
 * optionally enforcing exact match against a frozen repository specification.
 */
export function parseAndValidateManifest(
  rawValue: unknown,
  frozenSpec?: FrozenRepoSpec,
): GroundTruthManifest {
  if (!isRecord(rawValue)) {
    throw new EvaluationError('Manifest root must be a JSON object.');
  }

  if (rawValue.schemaVersion !== 1) {
    throw new EvaluationError('manifest.schemaVersion must be 1.');
  }

  const repository = readRequiredString(rawValue, 'repository', 'manifest');
  const commitSha = readHexString(rawValue, 'commitSha', HEX_40_RE, 'manifest');
  const annotationMethod = readRequiredString(rawValue, 'annotationMethod', 'manifest');
  const samplingRationale = readRequiredString(rawValue, 'samplingRationale', 'manifest');

  const rawPolicy = rawValue.scoringPolicy;
  if (!isRecord(rawPolicy)) {
    throw new EvaluationError('manifest.scoringPolicy must be an object.');
  }
  const scoringPolicy: ScoringPolicyMetadata = {
    importsIdentity: readRequiredString(rawPolicy, 'importsIdentity', 'manifest.scoringPolicy'),
    callsIdentity: readRequiredString(rawPolicy, 'callsIdentity', 'manifest.scoringPolicy'),
    scopeFiltering: readRequiredString(rawPolicy, 'scopeFiltering', 'manifest.scoringPolicy'),
    uncertainCandidatePolicy: readRequiredString(
      rawPolicy,
      'uncertainCandidatePolicy',
      'manifest.scoringPolicy',
    ),
    zeroDenominatorPolicy: readRequiredString(
      rawPolicy,
      'zeroDenominatorPolicy',
      'manifest.scoringPolicy',
    ),
  };

  const rawSelected = readStringArray(rawValue, 'selectedSourceFiles', 'manifest');
  if (rawSelected.length === 0) {
    throw new EvaluationError('manifest.selectedSourceFiles must not be empty.');
  }
  const selectedSourceFiles: string[] = [];
  const selectedSet = new Set<string>();
  for (let i = 0; i < rawSelected.length; i += 1) {
    const file = rawSelected[i];
    if (file === undefined) {
      continue;
    }
    const normalized = validateRepoRelativePath(file);
    if (normalized !== file) {
      throw new EvaluationError(
        `manifest.selectedSourceFiles[${String(i)}] must be a normalized POSIX relative path (got "${file}").`,
      );
    }
    if (selectedSet.has(normalized)) {
      throw new EvaluationError(`Duplicate selectedSourceFiles entry: "${normalized}".`);
    }
    selectedSet.add(normalized);
    selectedSourceFiles.push(normalized);
  }

  // Annotated file provenance
  const rawAnnotated = rawValue.annotatedFileProvenance;
  if (!Array.isArray(rawAnnotated)) {
    throw new EvaluationError('manifest.annotatedFileProvenance must be an array.');
  }
  const annotatedFileProvenance: AnnotatedFileProvenance[] = [];
  const annotatedSeen = new Set<string>();
  for (let i = 0; i < rawAnnotated.length; i += 1) {
    const entry: unknown = rawAnnotated[i];
    const ctx = `manifest.annotatedFileProvenance[${String(i)}]`;
    if (!isRecord(entry)) {
      throw new EvaluationError(`${ctx} must be an object.`);
    }
    const filePath = validateRepoRelativePath(readRequiredString(entry, 'path', ctx));
    if (!selectedSet.has(filePath)) {
      throw new EvaluationError(`${ctx}.path "${filePath}" is not in selectedSourceFiles.`);
    }
    if (annotatedSeen.has(filePath)) {
      throw new EvaluationError(`Duplicate annotatedFileProvenance entry for "${filePath}".`);
    }
    if (entry.status !== 'complete') {
      throw new EvaluationError(`${ctx}.status must be "complete".`);
    }
    annotatedSeen.add(filePath);
    annotatedFileProvenance.push({
      path: filePath,
      status: 'complete',
      gitBlobId: readHexString(entry, 'gitBlobId', HEX_40_RE, ctx),
      sha256: readHexString(entry, 'sha256', HEX_64_RE, ctx),
      byteLength: readNonNegativeSafeInt(entry, 'byteLength', ctx),
    });
  }
  if (annotatedSeen.size !== selectedSet.size) {
    throw new EvaluationError(
      `annotatedFileProvenance count (${String(annotatedSeen.size)}) does not match selectedSourceFiles count (${String(selectedSet.size)}).`,
    );
  }

  // Referenced target and config provenance
  const rawReferenced = rawValue.referencedTargetAndConfigProvenance;
  if (!Array.isArray(rawReferenced)) {
    throw new EvaluationError('manifest.referencedTargetAndConfigProvenance must be an array.');
  }
  const referencedTargetAndConfigProvenance: ReferencedFileProvenance[] = [];
  const referencedSeen = new Set<string>();
  for (let i = 0; i < rawReferenced.length; i += 1) {
    const entry: unknown = rawReferenced[i];
    const ctx = `manifest.referencedTargetAndConfigProvenance[${String(i)}]`;
    if (!isRecord(entry)) {
      throw new EvaluationError(`${ctx} must be an object.`);
    }
    const filePath = validateRepoRelativePath(readRequiredString(entry, 'path', ctx));
    if (referencedSeen.has(filePath)) {
      throw new EvaluationError(
        `Duplicate referencedTargetAndConfigProvenance entry for "${filePath}".`,
      );
    }
    referencedSeen.add(filePath);
    referencedTargetAndConfigProvenance.push({
      path: filePath,
      role: readRequiredString(entry, 'role', ctx),
      gitBlobId: readHexString(entry, 'gitBlobId', HEX_40_RE, ctx),
      sha256: readHexString(entry, 'sha256', HEX_64_RE, ctx),
      byteLength: readNonNegativeSafeInt(entry, 'byteLength', ctx),
    });
  }

  const allKnownProvenanceFiles = new Set<string>([...annotatedSeen, ...referencedSeen]);

  // Expected IMPORTS
  const rawImports = rawValue.expectedImports;
  if (!Array.isArray(rawImports)) {
    throw new EvaluationError('manifest.expectedImports must be an array.');
  }
  const expectedImports: ExpectedImportRecord[] = [];
  const importKeys = new Set<string>();
  for (let i = 0; i < rawImports.length; i += 1) {
    const entry: unknown = rawImports[i];
    const ctx = `manifest.expectedImports[${String(i)}]`;
    if (!isRecord(entry)) {
      throw new EvaluationError(`${ctx} must be an object.`);
    }
    if (entry.edgeType !== 'IMPORTS') {
      throw new EvaluationError(`${ctx}.edgeType must be "IMPORTS".`);
    }
    const sourceQualifiedName = readRequiredString(entry, 'sourceQualifiedName', ctx);
    const targetQualifiedName = readRequiredString(entry, 'targetQualifiedName', ctx);
    if (!sourceQualifiedName.startsWith('file:') || !targetQualifiedName.startsWith('file:')) {
      throw new EvaluationError(
        `${ctx} IMPORTS source and target must both use "file:<path>" qualified names.`,
      );
    }
    const sourceFile = extractFilePathFromQualifiedName(sourceQualifiedName);
    const targetFile = extractFilePathFromQualifiedName(targetQualifiedName);
    if (!selectedSet.has(sourceFile)) {
      throw new EvaluationError(
        `${ctx} source file "${sourceFile}" is not in selectedSourceFiles.`,
      );
    }
    if (sourceFile === targetFile) {
      throw new EvaluationError(`${ctx} cannot contain a self-import for "${sourceFile}".`);
    }
    if (!allKnownProvenanceFiles.has(targetFile)) {
      throw new EvaluationError(
        `${ctx} target file "${targetFile}" is missing from manifest provenance records.`,
      );
    }
    const record: ExpectedImportRecord = {
      sourceQualifiedName,
      targetQualifiedName,
      edgeType: 'IMPORTS',
      evidence: readRequiredString(entry, 'evidence', ctx),
    };
    const key = serializeImportIdentity(record);
    if (importKeys.has(key)) {
      throw new EvaluationError(
        `Duplicate canonical expectedImports identity: ${formatImportIdentity(record)}.`,
      );
    }
    importKeys.add(key);
    expectedImports.push(record);
  }

  // Expected CALLS
  const rawCalls = rawValue.expectedCalls;
  if (!Array.isArray(rawCalls)) {
    throw new EvaluationError('manifest.expectedCalls must be an array.');
  }
  const expectedCalls: ExpectedCallRecord[] = [];
  const callKeys = new Set<string>();
  for (let i = 0; i < rawCalls.length; i += 1) {
    const entry: unknown = rawCalls[i];
    const ctx = `manifest.expectedCalls[${String(i)}]`;
    if (!isRecord(entry)) {
      throw new EvaluationError(`${ctx} must be an object.`);
    }
    if (entry.edgeType !== 'CALLS') {
      throw new EvaluationError(`${ctx}.edgeType must be "CALLS".`);
    }
    const sourceQualifiedName = readRequiredString(entry, 'sourceQualifiedName', ctx);
    const targetQualifiedName = readRequiredString(entry, 'targetQualifiedName', ctx);
    const sourceFile = extractFilePathFromQualifiedName(sourceQualifiedName);
    const targetFile = extractFilePathFromQualifiedName(targetQualifiedName);
    if (!selectedSet.has(sourceFile)) {
      throw new EvaluationError(
        `${ctx} source file "${sourceFile}" is not in selectedSourceFiles.`,
      );
    }
    if (!allKnownProvenanceFiles.has(targetFile)) {
      throw new EvaluationError(
        `${ctx} target file "${targetFile}" is missing from manifest provenance records.`,
      );
    }
    const record: ExpectedCallRecord = {
      sourceQualifiedName,
      targetQualifiedName,
      edgeType: 'CALLS',
      callSiteLine: readPositiveSafeInt(entry, 'callSiteLine', ctx),
      evidence: readRequiredString(entry, 'evidence', ctx),
    };
    const key = serializeCallIdentity(record);
    if (callKeys.has(key)) {
      throw new EvaluationError(
        `Duplicate canonical expectedCalls identity: ${formatCallIdentity(record)}.`,
      );
    }
    callKeys.add(key);
    expectedCalls.push(record);
  }

  // Excluded or uncertain candidates
  const rawCandidates = rawValue.excludedOrUncertainCandidates;
  if (!Array.isArray(rawCandidates)) {
    throw new EvaluationError('manifest.excludedOrUncertainCandidates must be an array.');
  }
  const excludedOrUncertainCandidates: ExcludedOrUncertainCandidate[] = [];
  for (let i = 0; i < rawCandidates.length; i += 1) {
    const entry: unknown = rawCandidates[i];
    const ctx = `manifest.excludedOrUncertainCandidates[${String(i)}]`;
    if (!isRecord(entry)) {
      throw new EvaluationError(`${ctx} must be an object.`);
    }
    const filePath = validateRepoRelativePath(readRequiredString(entry, 'filePath', ctx));
    if (!selectedSet.has(filePath)) {
      throw new EvaluationError(`${ctx}.filePath "${filePath}" is not in selectedSourceFiles.`);
    }
    const classification = entry.classification;
    if (classification !== 'excluded' && classification !== 'uncertain') {
      throw new EvaluationError(`${ctx}.classification must be "excluded" or "uncertain".`);
    }
    excludedOrUncertainCandidates.push({
      filePath,
      line: readPositiveSafeInt(entry, 'line', ctx),
      expression: readRequiredString(entry, 'expression', ctx),
      classification,
      reason: readRequiredString(entry, 'reason', ctx),
      notes: readRequiredString(entry, 'notes', ctx),
    });
  }

  const notes = readStringArray(rawValue, 'notes', 'manifest');

  // Optional frozen-specification enforcement
  if (frozenSpec !== undefined) {
    if (repository !== frozenSpec.repository) {
      throw new EvaluationError(
        `Manifest repository mismatch: expected "${frozenSpec.repository}", got "${repository}".`,
      );
    }
    if (commitSha !== frozenSpec.commitSha) {
      throw new EvaluationError(
        `Manifest commitSha mismatch: expected "${frozenSpec.commitSha}", got "${commitSha}".`,
      );
    }
    if (
      selectedSourceFiles.length !== frozenSpec.selectedSourceFiles.length ||
      !frozenSpec.selectedSourceFiles.every((file, idx) => selectedSourceFiles[idx] === file)
    ) {
      throw new EvaluationError(
        `Manifest selectedSourceFiles does not match frozen sample for "${frozenSpec.id}".`,
      );
    }
    if (expectedImports.length !== frozenSpec.expectedImportsCount) {
      throw new EvaluationError(
        `Manifest expectedImports count mismatch for "${frozenSpec.id}": expected ${String(frozenSpec.expectedImportsCount)}, got ${String(expectedImports.length)}.`,
      );
    }
    if (expectedCalls.length !== frozenSpec.expectedBroaderCallsCount) {
      throw new EvaluationError(
        `Manifest expectedCalls count mismatch for "${frozenSpec.id}": expected ${String(frozenSpec.expectedBroaderCallsCount)}, got ${String(expectedCalls.length)}.`,
      );
    }
    for (const ext of frozenSpec.wrapperExtensionCalls) {
      const extKey = serializeCallIdentity(ext);
      if (!callKeys.has(extKey)) {
        throw new EvaluationError(
          `Declared wrapper-extension identity missing from manifest expectedCalls: ${formatCallIdentity(ext)}.`,
        );
      }
    }
  }

  return {
    schemaVersion: 1,
    repository,
    commitSha,
    annotationMethod,
    samplingRationale,
    scoringPolicy,
    selectedSourceFiles,
    annotatedFileProvenance,
    referencedTargetAndConfigProvenance,
    expectedImports,
    expectedCalls,
    excludedOrUncertainCandidates,
    notes,
  };
}

/**
 * Verifies the manifest file's raw SHA-256 digest BEFORE parsing JSON,
 * then strictly validates its schema and frozen specification invariants.
 */
export async function verifyAndLoadFrozenManifest(
  manifestPath: string,
  expectedSha256: string,
  frozenSpec?: FrozenRepoSpec,
): Promise<{ readonly manifest: GroundTruthManifest; readonly actualSha256: string }> {
  const rawBytes = await readFile(manifestPath);
  const actualSha256 = sha256BufferHex(rawBytes);
  const normalizedExpected = expectedSha256.toLowerCase();

  if (actualSha256 !== normalizedExpected) {
    throw new EvaluationError(
      `Frozen manifest SHA-256 mismatch for "${manifestPath}": expected ${normalizedExpected}, got ${actualSha256}.`,
    );
  }

  const parsed = parseJsonUnknown(rawBytes.toString('utf8'), manifestPath);
  const manifest = parseAndValidateManifest(parsed, frozenSpec);
  return { manifest, actualSha256 };
}

/**
 * Validates graph structural integrity and emitted-count consistency on an `AnalysisOutput`.
 * Missing endpoints, duplicate nodes, invalid metadata, and duplicate graph edges are reported
 * as explicit violations (never silently dropped).
 */
export function validateGraphIntegrity(
  output: AnalysisOutput,
  maxCallSiteSnippetChars: number = DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
): GraphIntegrityResult {
  const violations: string[] = [];
  const nodeMap = new Map<string, ExtractedNode>();

  let folderCount = 0;
  let fileCount = 0;
  let functionCount = 0;
  let classCount = 0;
  let symbolCount = 0;

  for (const node of output.nodes) {
    if (nodeMap.has(node.qualifiedName)) {
      violations.push(`Duplicate node qualifiedName: "${node.qualifiedName}".`);
    } else {
      nodeMap.set(node.qualifiedName, node);
    }

    switch (node.nodeType) {
      case 'folder':
        folderCount += 1;
        break;
      case 'file':
        fileCount += 1;
        break;
      case 'function':
        functionCount += 1;
        break;
      case 'class':
        classCount += 1;
        break;
      case 'symbol':
        symbolCount += 1;
        break;
    }
  }

  for (const node of output.nodes) {
    if (node.parentQualifiedName !== null && !nodeMap.has(node.parentQualifiedName)) {
      violations.push(
        `Missing parentQualifiedName "${node.parentQualifiedName}" referenced by "${node.qualifiedName}".`,
      );
    }
  }

  const seenImportKeys = new Set<string>();
  const seenCallKeys = new Set<string>();
  let importsCount = 0;
  let callsCount = 0;

  for (const edge of output.edges) {
    if (!nodeMap.has(edge.sourceQualifiedName)) {
      violations.push(
        `Missing source endpoint node "${edge.sourceQualifiedName}" on ${edge.edgeType} edge to "${edge.targetQualifiedName}".`,
      );
    }
    if (!nodeMap.has(edge.targetQualifiedName)) {
      violations.push(
        `Missing target endpoint node "${edge.targetQualifiedName}" on ${edge.edgeType} edge from "${edge.sourceQualifiedName}".`,
      );
    }

    if (edge.edgeType === 'IMPORTS') {
      importsCount += 1;
      if (edge.sourceQualifiedName === edge.targetQualifiedName) {
        violations.push(`Self-import edge emitted for "${edge.sourceQualifiedName}".`);
      }
      if (edge.callSiteLine !== null || edge.callSiteSnippet !== null) {
        violations.push(
          `IMPORTS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" must have null callSiteLine and callSiteSnippet.`,
        );
      }
      const key = serializeImportIdentity({
        sourceQualifiedName: edge.sourceQualifiedName,
        targetQualifiedName: edge.targetQualifiedName,
        edgeType: 'IMPORTS',
      });
      if (seenImportKeys.has(key)) {
        violations.push(
          `Duplicate graph IMPORTS edge: "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}".`,
        );
      } else {
        seenImportKeys.add(key);
      }
    } else {
      callsCount += 1;
      if (
        edge.callSiteLine === null ||
        !Number.isSafeInteger(edge.callSiteLine) ||
        edge.callSiteLine < 1
      ) {
        violations.push(
          `CALLS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" has invalid callSiteLine (${String(edge.callSiteLine)}).`,
        );
      } else {
        const key = serializeCallIdentity({
          sourceQualifiedName: edge.sourceQualifiedName,
          targetQualifiedName: edge.targetQualifiedName,
          edgeType: 'CALLS',
          callSiteLine: edge.callSiteLine,
        });
        if (seenCallKeys.has(key)) {
          violations.push(
            `Duplicate graph CALLS edge: "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName} @L${String(edge.callSiteLine)}".`,
          );
        } else {
          seenCallKeys.add(key);
        }
      }

      if (edge.callSiteSnippet === null) {
        violations.push(
          `CALLS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" has null callSiteSnippet.`,
        );
      } else {
        if (edge.callSiteSnippet.length > maxCallSiteSnippetChars) {
          violations.push(
            `CALLS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" snippet length (${String(edge.callSiteSnippet.length)}) exceeds cap (${String(maxCallSiteSnippetChars)}).`,
          );
        }
        if (edge.callSiteSnippet.includes('\r')) {
          violations.push(
            `CALLS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" snippet contains unnormalized CR characters.`,
          );
        }
      }
    }
  }

  const statChecks: readonly [string, number, number][] = [
    ['folderNodeCount', output.stats.folderNodeCount, folderCount],
    ['fileNodeCount', output.stats.fileNodeCount, fileCount],
    ['functionNodeCount', output.stats.functionNodeCount, functionCount],
    ['classNodeCount', output.stats.classNodeCount, classCount],
    ['symbolNodeCount', output.stats.symbolNodeCount, symbolCount],
    ['importsEdgeCount', output.stats.importsEdgeCount, importsCount],
    ['callsEdgeCount', output.stats.callsEdgeCount, callsCount],
  ];

  for (const [statName, reported, actual] of statChecks) {
    if (reported !== actual) {
      violations.push(
        `AnalysisStats.${statName} (${String(reported)}) does not match emitted count (${String(actual)}).`,
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Pure set-based precision/recall/F1 computation.
 * Deduplicates inputs into sets so duplicate items can never inflate TP, FP, or FN,
 * and returns `null` for any metric with a zero denominator (never coerced to 100%).
 */
export function computeEdgeSetMetrics<T>(
  expectedItems: readonly T[],
  predictedItems: readonly T[],
  serialize: (item: T) => string,
  compare: (a: T, b: T) => number,
): EdgeSetMetrics<T> {
  const expectedMap = new Map<string, T>();
  let duplicateExpectedCount = 0;
  for (const item of expectedItems) {
    const key = serialize(item);
    if (expectedMap.has(key)) {
      duplicateExpectedCount += 1;
    } else {
      expectedMap.set(key, item);
    }
  }

  const predictedMap = new Map<string, T>();
  let duplicatePredictedCount = 0;
  for (const item of predictedItems) {
    const key = serialize(item);
    if (predictedMap.has(key)) {
      duplicatePredictedCount += 1;
    } else {
      predictedMap.set(key, item);
    }
  }

  let tp = 0;
  const falsePositives: T[] = [];
  const falseNegatives: T[] = [];

  for (const [key, item] of predictedMap.entries()) {
    if (expectedMap.has(key)) {
      tp += 1;
    } else {
      falsePositives.push(item);
    }
  }

  for (const [key, item] of expectedMap.entries()) {
    if (!predictedMap.has(key)) {
      falseNegatives.push(item);
    }
  }

  falsePositives.sort(compare);
  falseNegatives.sort(compare);

  const fp = falsePositives.length;
  const fn = falseNegatives.length;
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = 2 * tp + fp + fn === 0 ? null : (2 * tp) / (2 * tp + fp + fn);

  return {
    expectedCount: expectedMap.size,
    predictedCount: predictedMap.size,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    duplicateExpectedCount,
    duplicatePredictedCount,
    falsePositives,
    falseNegatives,
  };
}

/**
 * Computes a deterministic SHA-256 digest of the serializable graph DTOs and stats
 * (explicitly excluding wall-clock timing and memory observations).
 */
export function computeGraphOutputDigest(output: AnalysisOutput): string {
  const canonicalStats: AnalysisStats = {
    discoveredFilesCount: output.stats.discoveredFilesCount,
    parsedFilesCount: output.stats.parsedFilesCount,
    skippedSyntaxErrorFilesCount: output.stats.skippedSyntaxErrorFilesCount,
    skippedOversizedFilesCount: output.stats.skippedOversizedFilesCount,
    configFilesCount: output.stats.configFilesCount,
    folderNodeCount: output.stats.folderNodeCount,
    fileNodeCount: output.stats.fileNodeCount,
    functionNodeCount: output.stats.functionNodeCount,
    classNodeCount: output.stats.classNodeCount,
    symbolNodeCount: output.stats.symbolNodeCount,
    importsEdgeCount: output.stats.importsEdgeCount,
    callsEdgeCount: output.stats.callsEdgeCount,
    totalBytesRead: output.stats.totalBytesRead,
    truncatedWarningsCount: output.stats.truncatedWarningsCount,
  };

  const payload = JSON.stringify({
    nodes: output.nodes,
    edges: output.edges,
    warnings: output.warnings,
    stats: canonicalStats,
  });

  return sha256BufferHex(Buffer.from(payload, 'utf8'));
}

function toCanonicalImport(edge: ExtractedEdge): CanonicalImportIdentity {
  return {
    sourceQualifiedName: edge.sourceQualifiedName,
    targetQualifiedName: edge.targetQualifiedName,
    edgeType: 'IMPORTS',
  };
}

function toCanonicalCall(edge: ExtractedEdge): CanonicalCallIdentity {
  if (edge.callSiteLine === null) {
    throw new EvaluationError(
      `CALLS edge "${edge.sourceQualifiedName} -> ${edge.targetQualifiedName}" is missing callSiteLine.`,
    );
  }
  return {
    sourceQualifiedName: edge.sourceQualifiedName,
    targetQualifiedName: edge.targetQualifiedName,
    edgeType: 'CALLS',
    callSiteLine: edge.callSiteLine,
  };
}

/**
 * Pure, deterministic scoring function comparing an `AnalysisOutput` against a validated
 * `GroundTruthManifest` and exact wrapper-extension identities.
 * - Validates graph integrity before scoring (rejecting missing endpoints or duplicate graph edges).
 * - Filters predicted edges strictly by emitted `sourceNode.filePath` membership in `selectedSourceFiles`.
 * - Missing expected target nodes remain scoreable and count naturally as FNs.
 */
export function scoreRepositoryAnalysis(options: {
  readonly manifest: GroundTruthManifest;
  readonly output: AnalysisOutput;
  readonly wrapperExtensionCalls?: readonly CanonicalCallIdentity[];
  readonly maxCallSiteSnippetChars?: number;
}): RepositoryScoreResult {
  const { manifest, output } = options;
  const wrapperExtensions = options.wrapperExtensionCalls ?? [];
  const maxSnippetChars = options.maxCallSiteSnippetChars ?? DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS;

  const graphIntegrity = validateGraphIntegrity(output, maxSnippetChars);
  if (!graphIntegrity.valid) {
    throw new EvaluationError(
      `Graph integrity validation failed with ${String(graphIntegrity.violations.length)} violation(s): ${graphIntegrity.violations.join(' | ')}`,
    );
  }

  // Verify every declared wrapper-extension identity exists in manifest.expectedCalls
  const expectedCallKeySet = new Set(manifest.expectedCalls.map(serializeCallIdentity));
  const extensionKeySet = new Set<string>();
  const uniqueExtensions: CanonicalCallIdentity[] = [];
  for (const ext of wrapperExtensions) {
    const key = serializeCallIdentity(ext);
    if (!expectedCallKeySet.has(key)) {
      throw new EvaluationError(
        `Declared wrapper-extension identity is not present in manifest.expectedCalls: ${formatCallIdentity(ext)}.`,
      );
    }
    if (!extensionKeySet.has(key)) {
      extensionKeySet.add(key);
      uniqueExtensions.push(ext);
    }
  }
  uniqueExtensions.sort(compareCallIdentities);

  // Resolve source-file membership strictly from emitted ExtractedNode.filePath
  const nodeByQualifiedName = new Map<string, ExtractedNode>();
  for (const node of output.nodes) {
    nodeByQualifiedName.set(node.qualifiedName, node);
  }
  const selectedFileSet = new Set(manifest.selectedSourceFiles);

  const scopedPredictedImports: CanonicalImportIdentity[] = [];
  const scopedPredictedCalls: CanonicalCallIdentity[] = [];
  let totalGraphImportsCount = 0;
  let totalGraphCallsCount = 0;

  for (const edge of output.edges) {
    if (edge.edgeType === 'IMPORTS') {
      totalGraphImportsCount += 1;
    } else {
      totalGraphCallsCount += 1;
    }

    const sourceNode = nodeByQualifiedName.get(edge.sourceQualifiedName);
    if (sourceNode === undefined) {
      throw new EvaluationError(
        `Source node "${edge.sourceQualifiedName}" missing during scope filtering.`,
      );
    }

    if (!selectedFileSet.has(sourceNode.filePath)) {
      continue;
    }

    if (edge.edgeType === 'IMPORTS') {
      scopedPredictedImports.push(toCanonicalImport(edge));
    } else {
      scopedPredictedCalls.push(toCanonicalCall(edge));
    }
  }

  const importsMetrics = computeEdgeSetMetrics(
    manifest.expectedImports.map((e): CanonicalImportIdentity => ({
      sourceQualifiedName: e.sourceQualifiedName,
      targetQualifiedName: e.targetQualifiedName,
      edgeType: 'IMPORTS',
    })),
    scopedPredictedImports,
    serializeImportIdentity,
    compareImportIdentities,
  );

  const broaderExpectedCalls: CanonicalCallIdentity[] = manifest.expectedCalls.map((e) => ({
    sourceQualifiedName: e.sourceQualifiedName,
    targetQualifiedName: e.targetQualifiedName,
    edgeType: 'CALLS',
    callSiteLine: e.callSiteLine,
  }));

  const broaderCallsMetrics = computeEdgeSetMetrics(
    broaderExpectedCalls,
    scopedPredictedCalls,
    serializeCallIdentity,
    compareCallIdentities,
  );

  // Primary CALLS: remove ONLY exact canonical identities in extensionKeySet from expected & predicted
  const primaryExpectedCalls = broaderExpectedCalls.filter(
    (edge) => !extensionKeySet.has(serializeCallIdentity(edge)),
  );
  const primaryPredictedCalls: CanonicalCallIdentity[] = [];
  const unscoredWrapperExtensionPredictions: CanonicalCallIdentity[] = [];

  for (const edge of scopedPredictedCalls) {
    if (extensionKeySet.has(serializeCallIdentity(edge))) {
      unscoredWrapperExtensionPredictions.push(edge);
    } else {
      primaryPredictedCalls.push(edge);
    }
  }
  unscoredWrapperExtensionPredictions.sort(compareCallIdentities);

  const primaryCallsMetrics = computeEdgeSetMetrics(
    primaryExpectedCalls,
    primaryPredictedCalls,
    serializeCallIdentity,
    compareCallIdentities,
  );

  const wrapperExtensionMetrics = computeEdgeSetMetrics(
    uniqueExtensions,
    unscoredWrapperExtensionPredictions,
    serializeCallIdentity,
    compareCallIdentities,
  );

  const groupedExclusionRecordsCount = manifest.excludedOrUncertainCandidates.filter(
    (c) => c.classification === 'excluded',
  ).length;
  const declaredUncertainCandidatesCount = manifest.excludedOrUncertainCandidates.filter(
    (c) => c.classification === 'uncertain',
  ).length;

  return {
    repository: manifest.repository,
    commitSha: manifest.commitSha,
    annotatedFilesCount: manifest.selectedSourceFiles.length,
    totalGraphImportsCount,
    totalGraphCallsCount,
    scopedPredictedImportsCount: scopedPredictedImports.length,
    scopedPredictedCallsCount: scopedPredictedCalls.length,
    unscoredWrapperExtensionPredictions,
    groupedExclusionRecordsCount,
    declaredUncertainCandidatesCount,
    imports: importsMetrics,
    primaryCalls: primaryCallsMetrics,
    broaderCalls: broaderCallsMetrics,
    wrapperExtensions: {
      expectedExtensions: uniqueExtensions,
      matchedExtensions: unscoredWrapperExtensionPredictions,
      missedExtensions: wrapperExtensionMetrics.falseNegatives,
      metrics: wrapperExtensionMetrics,
    },
    graphIntegrity,
    graphDigest: computeGraphOutputDigest(output),
  };
}

function microAverageScope(
  entries: readonly {
    readonly annotatedFilesCount: number;
    readonly expectedCount: number;
    readonly predictedCount: number;
    readonly tp: number;
    readonly fp: number;
    readonly fn: number;
  }[],
): AggregateScopeMetrics {
  let annotatedFilesCount = 0;
  let expectedCount = 0;
  let predictedCount = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const entry of entries) {
    annotatedFilesCount += entry.annotatedFilesCount;
    expectedCount += entry.expectedCount;
    predictedCount += entry.predictedCount;
    tp += entry.tp;
    fp += entry.fp;
    fn += entry.fn;
  }

  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = 2 * tp + fp + fn === 0 ? null : (2 * tp) / (2 * tp + fp + fn);

  return {
    annotatedFilesCount,
    expectedCount,
    predictedCount,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    meetsRecallTarget: meetsRecallTarget(recall),
  };
}

/**
 * Aggregates metrics across repositories strictly by micro-averaging raw TP, FP, and FN counts
 * (never averaging per-repository percentages).
 */
export function aggregateRepositoryScores(
  scores: readonly RepositoryScoreResult[],
): AggregateEvaluationMetrics {
  const imports = microAverageScope(
    scores.map((s) => ({
      annotatedFilesCount: s.annotatedFilesCount,
      expectedCount: s.imports.expectedCount,
      predictedCount: s.imports.predictedCount,
      tp: s.imports.tp,
      fp: s.imports.fp,
      fn: s.imports.fn,
    })),
  );
  const primaryCalls = microAverageScope(
    scores.map((s) => ({
      annotatedFilesCount: s.annotatedFilesCount,
      expectedCount: s.primaryCalls.expectedCount,
      predictedCount: s.primaryCalls.predictedCount,
      tp: s.primaryCalls.tp,
      fp: s.primaryCalls.fp,
      fn: s.primaryCalls.fn,
    })),
  );
  const broaderCalls = microAverageScope(
    scores.map((s) => ({
      annotatedFilesCount: s.annotatedFilesCount,
      expectedCount: s.broaderCalls.expectedCount,
      predictedCount: s.broaderCalls.predictedCount,
      tp: s.broaderCalls.tp,
      fp: s.broaderCalls.fp,
      fn: s.broaderCalls.fn,
    })),
  );
  const wrapperExtensions = microAverageScope(
    scores.map((s) => ({
      annotatedFilesCount: s.annotatedFilesCount,
      expectedCount: s.wrapperExtensions.metrics.expectedCount,
      predictedCount: s.wrapperExtensions.metrics.predictedCount,
      tp: s.wrapperExtensions.metrics.tp,
      fp: s.wrapperExtensions.metrics.fp,
      fn: s.wrapperExtensions.metrics.fn,
    })),
  );

  let totalUnscoredWrapperExtensionPredictions = 0;
  let totalGroupedExclusionRecords = 0;
  let totalDeclaredUncertainCandidates = 0;

  for (const s of scores) {
    totalUnscoredWrapperExtensionPredictions += s.unscoredWrapperExtensionPredictions.length;
    totalGroupedExclusionRecords += s.groupedExclusionRecordsCount;
    totalDeclaredUncertainCandidates += s.declaredUncertainCandidatesCount;
  }

  return {
    imports,
    primaryCalls,
    broaderCalls,
    wrapperExtensions,
    totalUnscoredWrapperExtensionPredictions,
    totalGroupedExclusionRecords,
    totalDeclaredUncertainCandidates,
  };
}
