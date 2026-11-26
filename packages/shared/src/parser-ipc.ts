import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
  DEFAULT_MAX_CONFIG_FILES,
  DEFAULT_MAX_EXTENDS_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILE_SNIPPET_CHARS,
  DEFAULT_MAX_SUPPORTED_FILES,
  DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_WARNINGS,
  analysisOutputSchema,
  coreAnalysisErrorCodeSchema,
  validateAnalysisGraph,
  type AnalysisOutput,
  type CoreAnalysisErrorCode,
  type GraphValidationLimits,
} from './analysis-contracts.js';
import { isRepoConfigPath, isSupportedSourcePath, normalizePosixPath } from './repo-filter.js';

export const PARSER_IPC_PROTOCOL_VERSION = 1 as const;

/**
 * Provisional serialized UTF-8 JSON response cap (32 MiB).
 * Benchmark candidate only — this is an IPC payload budget, NOT a hard process-memory bound.
 * Future parent-side response validation runs after Node IPC deserialization.
 */
export const DEFAULT_MAX_IPC_RESPONSE_BYTES = 32 * 1024 * 1024;
/**
 * Minimum allowed IPC response budget (256 bytes). Verified to fit every fixed
 * `ANALYZE_ERROR` envelope (<= 227 UTF-8 bytes including a 36-char UUID `requestId`).
 */
export const MIN_IPC_RESPONSE_BYTES = 256;
export const MAX_IPC_ROOT_DIR_CHARS = 1024;
export const MAX_IPC_ERROR_MESSAGE_CHARS = 512;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;
const WINDOWS_DRIVE_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE_RE = /^\\\\[^\\/]+\\[^\\/]+/;

export const PARSER_IPC_ERROR_KINDS = [
  'CORE_ANALYSIS_ERROR',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'RESPONSE_TOO_LARGE',
  'PROTOCOL_ERROR',
] as const;
export type ParserIpcErrorKind = (typeof PARSER_IPC_ERROR_KINDS)[number];

export type ParserIpcErrorCode =
  | CoreAnalysisErrorCode
  | 'INVALID_IPC_REQUEST'
  | 'PARSER_INTERNAL_ERROR'
  | 'IPC_RESPONSE_TOO_LARGE'
  | 'IPC_PROTOCOL_ERROR';

/**
 * Fixed, bounded, public-safe IPC error messages that never echo raw absolute paths,
 * untrusted request payloads, unrecognized keys, stack traces, or credentials.
 */
export const SAFE_IPC_ERROR_MESSAGES = {
  INVALID_IPC_REQUEST: 'Invalid parser IPC request.',
  PARSER_INTERNAL_ERROR: 'Internal parser analysis failure.',
  SERIALIZATION_FAILED: 'Failed to serialize parser IPC response.',
  IPC_RESPONSE_TOO_LARGE: 'Parser response exceeds IPC byte limit.',
  DUPLICATE_REQUEST: 'Duplicate IPC request rejected.',
  INVALID_GRAPH_OUTPUT: 'Parser produced an invalid analysis graph.',
  INVALID_IPC_RESPONSE: 'Invalid parser IPC response.',
} as const;

const SAFE_CORE_ANALYSIS_ERROR_MESSAGES: Readonly<Record<CoreAnalysisErrorCode, string>> = {
  INVALID_WORKSPACE: 'Invalid or unreadable analysis workspace.',
  PATH_TRAVERSAL_REJECTED: 'Analysis rejected due to unsafe workspace path.',
  FILE_LIMIT_EXCEEDED: 'Repository exceeds maximum allowed file count.',
  SIZE_LIMIT_EXCEEDED: 'Repository exceeds maximum allowed byte size.',
};

const SAFE_SCHEMA_PATH_SEGMENTS = new Set([
  'protocolVersion',
  'type',
  'requestId',
  'input',
  'maxResponseBytes',
  'rootDir',
  'supportedFiles',
  'configFiles',
  'maxSupportedFiles',
  'maxConfigFiles',
  'maxFileBytes',
  'maxTotalBytes',
  'maxFileSnippetChars',
  'maxSymbolSnippetChars',
  'maxCallSiteSnippetChars',
  'maxWarnings',
  'maxExtendsDepth',
  'skipLoadingLibFiles',
  'output',
  'metrics',
  'error',
  'nodes',
  'edges',
  'warnings',
  'stats',
  'kind',
  'code',
  'message',
  'durationMs',
  'baselineHeapUsedBytes',
  'postHeapUsedBytes',
  'baselineRssBytes',
  'postRssBytes',
  'maxRssKiB',
]);
const ARRAY_INDEX_SEGMENT_RE = /^\d+$/;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function safeIntRangeSchema(min: number, max: number) {
  return z.number().int().min(min).max(max).refine(Number.isSafeInteger, 'Must be a safe integer.');
}

const nonNegativeSafeIntSchema = z
  .number()
  .int()
  .min(0)
  .refine(Number.isSafeInteger, 'Must be a safe integer.');

const nonNegativeFiniteNumberSchema = z
  .number()
  .min(0)
  .refine(Number.isFinite, 'Must be a finite non-negative number.');

export const parserIpcUuidSchema = z.string().regex(UUID_RE, 'Expected valid UUID requestId.');

export function getSafeCoreAnalysisErrorMessage(code: CoreAnalysisErrorCode): string {
  return SAFE_CORE_ANALYSIS_ERROR_MESSAGES[code];
}

/**
 * Validates that a candidate inventory entry is already a canonical repo-relative POSIX path
 * without traversal, absolute prefixes, Windows drive prefixes, backslashes, or control chars,
 * using `@archon/shared`'s authoritative `normalizePosixPath`.
 */
export function isCanonicalRepoRelativePosixPath(candidate: string): boolean {
  if (
    candidate.length === 0 ||
    hasControlChars(candidate) ||
    candidate.includes('\\') ||
    candidate.startsWith('/') ||
    WINDOWS_DRIVE_RE.test(candidate)
  ) {
    return false;
  }
  const segments = candidate.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return false;
    }
  }
  return normalizePosixPath(candidate) === candidate;
}

/**
 * Validates an OS-absolute workspace root directory path.
 * On Windows, rejects drive-relative paths (e.g. `/foo` or `C:foo`) by requiring either a
 * drive-rooted path (`C:\...` / `C:/...`) or a UNC share path (`\\server\share...`).
 */
export function isValidAbsoluteRootDir(
  rootDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (
    rootDir.length === 0 ||
    rootDir.length > MAX_IPC_ROOT_DIR_CHARS ||
    rootDir !== rootDir.trim() ||
    hasControlChars(rootDir)
  ) {
    return false;
  }
  if (platform === 'win32') {
    return (
      path.win32.isAbsolute(rootDir) &&
      (WINDOWS_DRIVE_ABSOLUTE_RE.test(rootDir) || WINDOWS_UNC_ABSOLUTE_RE.test(rootDir))
    );
  }
  return path.posix.isAbsolute(rootDir) && !WINDOWS_DRIVE_RE.test(rootDir);
}

/**
 * Formats an error string by stripping newlines/control characters and bounding length.
 * Note: formatting alone does NOT redact secrets or host paths; outbound IPC responses
 * must use fixed public-safe messages from `SAFE_IPC_ERROR_MESSAGES` /
 * `getSafeCoreAnalysisErrorMessage`.
 */
export function sanitizeIpcErrorMessage(rawMessage: string): string {
  const firstLine = rawMessage.split(/\r?\n/)[0] ?? '';
  let cleaned = '';
  for (let i = 0; i < firstLine.length; i += 1) {
    const code = firstLine.charCodeAt(i);
    cleaned += code < 0x20 || code === 0x7f ? ' ' : firstLine.charAt(i);
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return 'Parser error.';
  }
  if (collapsed.length <= MAX_IPC_ERROR_MESSAGE_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_IPC_ERROR_MESSAGE_CHARS - 3)}...`;
}

/**
 * Extracts a valid UUID `requestId` from an arbitrary untrusted message for error correlation.
 * Returns `null` when absent or invalid — never invents a synthetic UUID.
 */
export function extractValidIpcRequestId(rawMessage: unknown): string | null {
  if (typeof rawMessage !== 'object' || rawMessage === null || Array.isArray(rawMessage)) {
    return null;
  }
  const record = rawMessage as Readonly<Record<string, unknown>>;
  const candidate = record.requestId;
  if (typeof candidate === 'string' && UUID_RE.test(candidate)) {
    return candidate;
  }
  return null;
}

export const parserIpcAnalysisInputSchema = z
  .object({
    rootDir: z
      .string()
      .min(1)
      .max(MAX_IPC_ROOT_DIR_CHARS)
      .refine((value) => isValidAbsoluteRootDir(value), 'Invalid absolute workspace root path.'),
    supportedFiles: z.array(z.string().min(1)),
    configFiles: z.array(z.string().min(1)),
    maxSupportedFiles: safeIntRangeSchema(1, DEFAULT_MAX_SUPPORTED_FILES),
    maxConfigFiles: safeIntRangeSchema(1, DEFAULT_MAX_CONFIG_FILES),
    maxFileBytes: safeIntRangeSchema(1, DEFAULT_MAX_FILE_BYTES),
    maxTotalBytes: safeIntRangeSchema(1, DEFAULT_MAX_TOTAL_BYTES),
    maxFileSnippetChars: safeIntRangeSchema(0, DEFAULT_MAX_FILE_SNIPPET_CHARS),
    maxSymbolSnippetChars: safeIntRangeSchema(0, DEFAULT_MAX_SYMBOL_SNIPPET_CHARS),
    maxCallSiteSnippetChars: safeIntRangeSchema(0, DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS),
    maxWarnings: safeIntRangeSchema(0, DEFAULT_MAX_WARNINGS),
    maxExtendsDepth: safeIntRangeSchema(0, DEFAULT_MAX_EXTENDS_DEPTH),
    skipLoadingLibFiles: z.boolean(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.supportedFiles.length > input.maxSupportedFiles) {
      ctx.addIssue({
        code: 'custom',
        path: ['supportedFiles'],
        message: 'supportedFiles count exceeds maxSupportedFiles.',
      });
    }
    if (input.configFiles.length > input.maxConfigFiles) {
      ctx.addIssue({
        code: 'custom',
        path: ['configFiles'],
        message: 'configFiles count exceeds maxConfigFiles.',
      });
    }

    const seenSupported = new Set<string>();
    for (let i = 0; i < input.supportedFiles.length; i += 1) {
      const file = input.supportedFiles[i];
      if (file === undefined) {
        continue;
      }
      if (!isCanonicalRepoRelativePosixPath(file)) {
        ctx.addIssue({
          code: 'custom',
          path: ['supportedFiles', i],
          message: 'Invalid repo-relative POSIX source path.',
        });
        continue;
      }
      if (!isSupportedSourcePath(file)) {
        ctx.addIssue({
          code: 'custom',
          path: ['supportedFiles', i],
          message: 'Path is not a supported source file.',
        });
      }
      if (seenSupported.has(file)) {
        ctx.addIssue({
          code: 'custom',
          path: ['supportedFiles', i],
          message: 'Duplicate supportedFiles entry.',
        });
      } else {
        seenSupported.add(file);
      }
    }

    const seenConfig = new Set<string>();
    for (let i = 0; i < input.configFiles.length; i += 1) {
      const file = input.configFiles[i];
      if (file === undefined) {
        continue;
      }
      if (!isCanonicalRepoRelativePosixPath(file)) {
        ctx.addIssue({
          code: 'custom',
          path: ['configFiles', i],
          message: 'Invalid repo-relative POSIX config path.',
        });
        continue;
      }
      if (!isRepoConfigPath(file) || isSupportedSourcePath(file)) {
        ctx.addIssue({
          code: 'custom',
          path: ['configFiles', i],
          message: 'Path is not an eligible config file.',
        });
      }
      if (seenSupported.has(file)) {
        ctx.addIssue({
          code: 'custom',
          path: ['configFiles', i],
          message: 'Path cannot appear in both supportedFiles and configFiles.',
        });
      }
      if (seenConfig.has(file)) {
        ctx.addIssue({
          code: 'custom',
          path: ['configFiles', i],
          message: 'Duplicate configFiles entry.',
        });
      } else {
        seenConfig.add(file);
      }
    }
  });

export const parserIpcRequestV1Schema = z
  .object({
    protocolVersion: z.literal(PARSER_IPC_PROTOCOL_VERSION),
    type: z.literal('ANALYZE_REQUEST'),
    requestId: parserIpcUuidSchema,
    input: parserIpcAnalysisInputSchema,
    maxResponseBytes: safeIntRangeSchema(
      MIN_IPC_RESPONSE_BYTES,
      DEFAULT_MAX_IPC_RESPONSE_BYTES,
    ).optional(),
  })
  .strict();

/**
 * Child-side analysis timing and memory observations captured right before IPC send.
 * Note: observations taken before sending do NOT capture subsequent JSON serialization
 * or IPC kernel/parent deserialization peaks.
 */
export const parserChildMetricsSchema = z
  .object({
    durationMs: nonNegativeFiniteNumberSchema,
    baselineHeapUsedBytes: nonNegativeSafeIntSchema,
    postHeapUsedBytes: nonNegativeSafeIntSchema,
    baselineRssBytes: nonNegativeSafeIntSchema,
    postRssBytes: nonNegativeSafeIntSchema,
    maxRssKiB: nonNegativeSafeIntSchema,
  })
  .strict();

export const parserIpcErrorPayloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('CORE_ANALYSIS_ERROR'),
      code: coreAnalysisErrorCodeSchema,
      message: z.string().min(1).max(MAX_IPC_ERROR_MESSAGE_CHARS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('INVALID_REQUEST'),
      code: z.literal('INVALID_IPC_REQUEST'),
      message: z.string().min(1).max(MAX_IPC_ERROR_MESSAGE_CHARS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('INTERNAL_ERROR'),
      code: z.literal('PARSER_INTERNAL_ERROR'),
      message: z.string().min(1).max(MAX_IPC_ERROR_MESSAGE_CHARS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('RESPONSE_TOO_LARGE'),
      code: z.literal('IPC_RESPONSE_TOO_LARGE'),
      message: z.string().min(1).max(MAX_IPC_ERROR_MESSAGE_CHARS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('PROTOCOL_ERROR'),
      code: z.literal('IPC_PROTOCOL_ERROR'),
      message: z.string().min(1).max(MAX_IPC_ERROR_MESSAGE_CHARS),
    })
    .strict(),
]);

export const parserIpcSuccessResponseV1Schema = z
  .object({
    protocolVersion: z.literal(PARSER_IPC_PROTOCOL_VERSION),
    type: z.literal('ANALYZE_SUCCESS'),
    requestId: parserIpcUuidSchema,
    output: analysisOutputSchema,
    metrics: parserChildMetricsSchema,
  })
  .strict();

export const parserIpcErrorResponseV1Schema = z
  .object({
    protocolVersion: z.literal(PARSER_IPC_PROTOCOL_VERSION),
    type: z.literal('ANALYZE_ERROR'),
    requestId: parserIpcUuidSchema.nullable(),
    error: parserIpcErrorPayloadSchema,
  })
  .strict();

export const parserIpcResponseV1Schema = z.discriminatedUnion('type', [
  parserIpcSuccessResponseV1Schema,
  parserIpcErrorResponseV1Schema,
]);

export interface ParserIpcAnalysisInput {
  readonly rootDir: string;
  readonly supportedFiles: readonly string[];
  readonly configFiles: readonly string[];
  readonly maxSupportedFiles: number;
  readonly maxConfigFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFileSnippetChars: number;
  readonly maxSymbolSnippetChars: number;
  readonly maxCallSiteSnippetChars: number;
  readonly maxWarnings: number;
  readonly maxExtendsDepth: number;
  readonly skipLoadingLibFiles: boolean;
}

export interface ParserIpcRequestV1 {
  readonly protocolVersion: typeof PARSER_IPC_PROTOCOL_VERSION;
  readonly type: 'ANALYZE_REQUEST';
  readonly requestId: string;
  readonly input: ParserIpcAnalysisInput;
  readonly maxResponseBytes?: number;
}

export interface ParserChildMetrics {
  readonly durationMs: number;
  readonly baselineHeapUsedBytes: number;
  readonly postHeapUsedBytes: number;
  readonly baselineRssBytes: number;
  readonly postRssBytes: number;
  readonly maxRssKiB: number;
}

export type ParserIpcErrorPayload = z.infer<typeof parserIpcErrorPayloadSchema>;

export interface ParserIpcSuccessResponseV1 {
  readonly protocolVersion: typeof PARSER_IPC_PROTOCOL_VERSION;
  readonly type: 'ANALYZE_SUCCESS';
  readonly requestId: string;
  readonly output: AnalysisOutput;
  readonly metrics: ParserChildMetrics;
}

export interface ParserIpcErrorResponseV1 {
  readonly protocolVersion: typeof PARSER_IPC_PROTOCOL_VERSION;
  readonly type: 'ANALYZE_ERROR';
  readonly requestId: string | null;
  readonly error: ParserIpcErrorPayload;
}

export type ParserIpcResponseV1 = ParserIpcSuccessResponseV1 | ParserIpcErrorResponseV1;

// Compile-time schema-to-interface drift guards
type AssertAssignable<To, From extends To> = [To, From];
type _CheckIpcInput = AssertAssignable<
  ParserIpcAnalysisInput,
  z.infer<typeof parserIpcAnalysisInputSchema>
>;
type _CheckIpcRequest = AssertAssignable<
  ParserIpcRequestV1,
  z.infer<typeof parserIpcRequestV1Schema>
>;
type _CheckIpcResponse = AssertAssignable<
  ParserIpcResponseV1,
  z.infer<typeof parserIpcResponseV1Schema>
>;
export type _ParserIpcDriftChecks = readonly [_CheckIpcInput, _CheckIpcRequest, _CheckIpcResponse];

export type ParseIpcResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly message: string };

/**
 * Produces a public-safe validation message referencing ONLY allowlisted schema field names
 * and numeric array indices — never echoing untrusted input values or unrecognized keys.
 */
function formatSafeZodFailure(baseMessage: string, error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) {
    return baseMessage;
  }
  const safePath: string[] = [];
  for (const segment of first.path) {
    const str = String(segment);
    if (SAFE_SCHEMA_PATH_SEGMENTS.has(str) || ARRAY_INDEX_SEGMENT_RE.test(str)) {
      safePath.push(str);
    } else {
      break;
    }
  }
  if (safePath.length === 0) {
    return baseMessage;
  }
  const trimmedBase = baseMessage.endsWith('.') ? baseMessage.slice(0, -1) : baseMessage;
  return sanitizeIpcErrorMessage(`${trimmedBase} (${safePath.join('.')}).`);
}

export function parseParserIpcRequest(raw: unknown): ParseIpcResult<ParserIpcRequestV1> {
  const parsed = parserIpcRequestV1Schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: formatSafeZodFailure(SAFE_IPC_ERROR_MESSAGES.INVALID_IPC_REQUEST, parsed.error),
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Validates an untrusted IPC response shape and, for `ANALYZE_SUCCESS`,
 * also enforces semantic graph-integrity invariants via `validateAnalysisGraph`.
 */
export function parseParserIpcResponse(
  raw: unknown,
  limits?: GraphValidationLimits,
): ParseIpcResult<ParserIpcResponseV1> {
  const parsed = parserIpcResponseV1Schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: formatSafeZodFailure(SAFE_IPC_ERROR_MESSAGES.INVALID_IPC_RESPONSE, parsed.error),
    };
  }
  if (parsed.data.type === 'ANALYZE_SUCCESS') {
    const graphCheck = validateAnalysisGraph(parsed.data.output, limits);
    if (!graphCheck.valid) {
      return {
        ok: false,
        message: SAFE_IPC_ERROR_MESSAGES.INVALID_GRAPH_OUTPUT,
      };
    }
  }
  return { ok: true, data: parsed.data };
}

export type ResponseByteBudgetResult =
  | {
      readonly ok: true;
      readonly response: ParserIpcResponseV1;
      readonly byteLength: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'INVALID_BUDGET' | 'REPLACEMENT_EXCEEDS_BUDGET';
      readonly replacementByteLength: number;
      readonly maxResponseBytes: number;
    };

function measureReplacementError(
  replacement: ParserIpcErrorResponseV1,
  maxResponseBytes: number,
): ResponseByteBudgetResult {
  const replacementSerialized = JSON.stringify(replacement);
  const replacementByteLength = Buffer.byteLength(replacementSerialized, 'utf8');
  if (replacementByteLength > maxResponseBytes) {
    return {
      ok: false,
      reason: 'REPLACEMENT_EXCEEDS_BUDGET',
      replacementByteLength,
      maxResponseBytes,
    };
  }
  return {
    ok: true,
    response: replacement,
    byteLength: replacementByteLength,
  };
}

/**
 * Measures an outbound IPC response's exact UTF-8 serialized byte length against
 * `maxResponseBytes` in a single `JSON.stringify` pass. When a response fails serialization
 * or exceeds the cap, constructs the fixed safe replacement error AND verifies that the
 * replacement envelope itself also fits within `maxResponseBytes`.
 *
 * Note: this enforces the serialized IPC payload budget only — it is NOT a hard process
 * memory limit (parent deserialization occurs after Node IPC receipt).
 */
export function enforceIpcResponseByteBudget(
  response: ParserIpcResponseV1,
  maxResponseBytes: number,
): ResponseByteBudgetResult {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0) {
    return {
      ok: false,
      reason: 'INVALID_BUDGET',
      replacementByteLength: 0,
      maxResponseBytes,
    };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(response);
  } catch {
    const replacement: ParserIpcErrorResponseV1 = {
      protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
      type: 'ANALYZE_ERROR',
      requestId: response.requestId,
      error: {
        kind: 'INTERNAL_ERROR',
        code: 'PARSER_INTERNAL_ERROR',
        message: SAFE_IPC_ERROR_MESSAGES.SERIALIZATION_FAILED,
      },
    };
    return measureReplacementError(replacement, maxResponseBytes);
  }

  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength <= maxResponseBytes) {
    return { ok: true, response, byteLength };
  }

  const oversizedReplacement: ParserIpcErrorResponseV1 = {
    protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
    type: 'ANALYZE_ERROR',
    requestId: response.requestId,
    error: {
      kind: 'RESPONSE_TOO_LARGE',
      code: 'IPC_RESPONSE_TOO_LARGE',
      message: SAFE_IPC_ERROR_MESSAGES.IPC_RESPONSE_TOO_LARGE,
    },
  };
  return measureReplacementError(oversizedReplacement, maxResponseBytes);
}
