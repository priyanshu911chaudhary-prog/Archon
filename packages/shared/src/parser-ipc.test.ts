import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORE_ANALYSIS_ERROR_CODES,
  DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
  DEFAULT_MAX_CONFIG_FILES,
  DEFAULT_MAX_EXTENDS_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILE_SNIPPET_CHARS,
  DEFAULT_MAX_IPC_RESPONSE_BYTES,
  DEFAULT_MAX_SUPPORTED_FILES,
  DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_WARNINGS,
  MAX_IPC_ERROR_MESSAGE_CHARS,
  MIN_IPC_RESPONSE_BYTES,
  PARSER_IPC_PROTOCOL_VERSION,
  SAFE_IPC_ERROR_MESSAGES,
  enforceIpcResponseByteBudget,
  extractValidIpcRequestId,
  getSafeCoreAnalysisErrorMessage,
  isCanonicalRepoRelativePosixPath,
  isValidAbsoluteRootDir,
  parseParserIpcRequest,
  parseParserIpcResponse,
  sanitizeIpcErrorMessage,
  type ParserIpcRequestV1,
  type ParserIpcResponseV1,
  type ParserIpcSuccessResponseV1,
} from './index.js';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const ABS_ROOT = path.resolve('tmp-archon-workspace');
const VALID_SHA256 = 'a'.repeat(64);

function makeValidRequest(
  overrides: Partial<ParserIpcRequestV1['input']> = {},
): ParserIpcRequestV1 {
  return {
    protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
    type: 'ANALYZE_REQUEST',
    requestId: VALID_UUID,
    input: {
      rootDir: ABS_ROOT,
      supportedFiles: ['src/index.ts'],
      configFiles: ['tsconfig.json'],
      maxSupportedFiles: DEFAULT_MAX_SUPPORTED_FILES,
      maxConfigFiles: DEFAULT_MAX_CONFIG_FILES,
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
      maxFileSnippetChars: DEFAULT_MAX_FILE_SNIPPET_CHARS,
      maxSymbolSnippetChars: DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
      maxCallSiteSnippetChars: DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
      maxWarnings: DEFAULT_MAX_WARNINGS,
      maxExtendsDepth: DEFAULT_MAX_EXTENDS_DEPTH,
      skipLoadingLibFiles: false,
      ...overrides,
    },
  };
}

function makeSuccessResponse(snippet = ''): ParserIpcSuccessResponseV1 {
  return {
    protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
    type: 'ANALYZE_SUCCESS',
    requestId: VALID_UUID,
    output: {
      nodes: [
        {
          nodeType: 'file',
          name: 'a.ts',
          qualifiedName: 'file:a.ts',
          filePath: 'a.ts',
          parentQualifiedName: null,
          isExported: false,
          startLine: 1,
          endLine: 1,
          contentHash: VALID_SHA256,
          snippet,
        },
      ],
      edges: [],
      warnings: [],
      stats: {
        discoveredFilesCount: 1,
        parsedFilesCount: 1,
        skippedSyntaxErrorFilesCount: 0,
        skippedOversizedFilesCount: 0,
        configFilesCount: 0,
        folderNodeCount: 0,
        fileNodeCount: 1,
        functionNodeCount: 0,
        classNodeCount: 0,
        symbolNodeCount: 0,
        importsEdgeCount: 0,
        callsEdgeCount: 0,
        totalBytesRead: 10,
        truncatedWarningsCount: 0,
      },
    },
    metrics: {
      durationMs: 12.5,
      baselineHeapUsedBytes: 1000,
      postHeapUsedBytes: 2000,
      baselineRssBytes: 3000,
      postRssBytes: 4000,
      maxRssKiB: 5000,
    },
  };
}

describe('parser-ipc (versioned IPC protocol schemas & guards)', () => {
  it('accepts valid requests including explicitly empty inventories and zero snippet caps', () => {
    const req = makeValidRequest({
      supportedFiles: [],
      configFiles: [],
      maxFileSnippetChars: 0,
      maxSymbolSnippetChars: 0,
      maxCallSiteSnippetChars: 0,
      maxWarnings: 0,
      maxExtendsDepth: 0,
    });
    const parsed = parseParserIpcRequest(req);
    expect(parsed.ok).toBe(true);
  });

  it('rejects missing inventories, relative rootDir, unsafe/duplicate inventory paths, and mismatched source/config kinds', () => {
    const valid = makeValidRequest();

    const { supportedFiles: _s, ...withoutSupported } = valid.input;
    expect(parseParserIpcRequest({ ...valid, input: withoutSupported }).ok).toBe(false);
    const { configFiles: _c, ...withoutConfig } = valid.input;
    expect(parseParserIpcRequest({ ...valid, input: withoutConfig }).ok).toBe(false);

    expect(parseParserIpcRequest(makeValidRequest({ rootDir: 'relative/path' })).ok).toBe(false);

    const unsafePaths = [
      '../escape.ts',
      'src/../escape.ts',
      '/abs/file.ts',
      'C:/abs/file.ts',
      'src\\win.ts',
      './src/a.ts',
      'src/a\0.ts',
      'src/a\n.ts',
    ];
    for (const badPath of unsafePaths) {
      expect(
        parseParserIpcRequest(makeValidRequest({ supportedFiles: [badPath] })).ok,
        `Expected rejection for "${badPath}"`,
      ).toBe(false);
    }

    expect(
      parseParserIpcRequest(makeValidRequest({ supportedFiles: ['src/a.ts', 'src/a.ts'] })).ok,
    ).toBe(false);
    expect(
      parseParserIpcRequest(makeValidRequest({ configFiles: ['tsconfig.json', 'tsconfig.json'] }))
        .ok,
    ).toBe(false);

    expect(parseParserIpcRequest(makeValidRequest({ supportedFiles: ['tsconfig.json'] })).ok).toBe(
      false,
    );
    expect(parseParserIpcRequest(makeValidRequest({ configFiles: ['src/index.ts'] })).ok).toBe(
      false,
    );
  });

  it('rejects negative, fractional, NaN, Infinity, unsafe-integer, excessive, and inventory-exceeding limits', () => {
    const badNumbers = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const num of badNumbers) {
      expect(parseParserIpcRequest(makeValidRequest({ maxCallSiteSnippetChars: num })).ok).toBe(
        false,
      );
      expect(parseParserIpcRequest(makeValidRequest({ maxFileBytes: num })).ok).toBe(false);
    }

    expect(
      parseParserIpcRequest(
        makeValidRequest({ maxSupportedFiles: DEFAULT_MAX_SUPPORTED_FILES + 1 }),
      ).ok,
    ).toBe(false);
    expect(
      parseParserIpcRequest(makeValidRequest({ maxConfigFiles: DEFAULT_MAX_CONFIG_FILES + 1 })).ok,
    ).toBe(false);
    expect(
      parseParserIpcRequest(makeValidRequest({ maxFileBytes: DEFAULT_MAX_FILE_BYTES + 1 })).ok,
    ).toBe(false);
    expect(
      parseParserIpcRequest(makeValidRequest({ maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES + 1 })).ok,
    ).toBe(false);
    expect(
      parseParserIpcRequest({
        ...makeValidRequest(),
        maxResponseBytes: DEFAULT_MAX_IPC_RESPONSE_BYTES + 1,
      }).ok,
    ).toBe(false);

    expect(
      parseParserIpcRequest(
        makeValidRequest({
          supportedFiles: ['src/a.ts', 'src/b.ts'],
          maxSupportedFiles: 1,
        }),
      ).ok,
    ).toBe(false);
  });

  it('rejects wrong protocolVersion, invalid requestId, and extra properties', () => {
    const valid = makeValidRequest();
    expect(parseParserIpcRequest({ ...valid, protocolVersion: 2 }).ok).toBe(false);
    expect(parseParserIpcRequest({ ...valid, requestId: 'not-a-uuid' }).ok).toBe(false);
    expect(parseParserIpcRequest({ ...valid, unexpectedFlag: true }).ok).toBe(false);
  });

  it('validates success and error responses strictly, allowing null requestId only on ANALYZE_ERROR', () => {
    const validSuccess = makeSuccessResponse();
    expect(parseParserIpcResponse(validSuccess).ok).toBe(true);
    expect(parseParserIpcResponse({ ...validSuccess, requestId: null }).ok).toBe(false);

    const validNullIdError = {
      protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
      type: 'ANALYZE_ERROR',
      requestId: null,
      error: {
        kind: 'INVALID_REQUEST',
        code: 'INVALID_IPC_REQUEST',
        message: SAFE_IPC_ERROR_MESSAGES.INVALID_IPC_REQUEST,
      },
    };
    expect(parseParserIpcResponse(validNullIdError).ok).toBe(true);

    expect(
      parseParserIpcResponse({
        ...validNullIdError,
        error: {
          kind: 'CORE_ANALYSIS_ERROR',
          code: 'TSCONFIG_ERROR',
          message: 'invented code',
        },
      }).ok,
    ).toBe(false);
  });

  it('sanitizes multiline strings and extracts only valid UUID requestIds', () => {
    const raw = `Boom\x00 failed\n    at secretFn (C:\\secret\\file.ts:1:1)\n    at more`;
    const sanitized = sanitizeIpcErrorMessage(raw);
    expect(sanitized).toBe('Boom failed');
    expect(sanitized).not.toContain('secretFn');

    const longSanitized = sanitizeIpcErrorMessage('a'.repeat(MAX_IPC_ERROR_MESSAGE_CHARS + 200));
    expect(longSanitized.length).toBe(MAX_IPC_ERROR_MESSAGE_CHARS);

    expect(extractValidIpcRequestId({ requestId: VALID_UUID })).toBe(VALID_UUID);
    expect(extractValidIpcRequestId({ requestId: 'bad-id' })).toBeNull();
    expect(extractValidIpcRequestId(null)).toBeNull();
  });

  it('enforces response byte budgets for exact cap, above cap, multibyte UTF-8, replacement error size, and serialization failure', () => {
    const asciiResponse = makeSuccessResponse('hello');
    const exactBytes = Buffer.byteLength(JSON.stringify(asciiResponse), 'utf8');

    // 1. Exact-cap acceptance
    const exactFit = enforceIpcResponseByteBudget(asciiResponse, exactBytes);
    expect(exactFit.ok).toBe(true);
    if (exactFit.ok) {
      expect(exactFit.response.type).toBe('ANALYZE_SUCCESS');
      expect(exactFit.byteLength).toBe(exactBytes);
    }

    // 2. Above-cap rejection (1 byte under serialized size -> replaced with RESPONSE_TOO_LARGE within budget)
    const oneByteShort = enforceIpcResponseByteBudget(asciiResponse, exactBytes - 1);
    expect(oneByteShort.ok).toBe(true);
    if (oneByteShort.ok) {
      expect(oneByteShort.response.type).toBe('ANALYZE_ERROR');
      if (oneByteShort.response.type === 'ANALYZE_ERROR') {
        expect(oneByteShort.response.error.kind).toBe('RESPONSE_TOO_LARGE');
        expect(oneByteShort.response.error.code).toBe('IPC_RESPONSE_TOO_LARGE');
      }
      expect(oneByteShort.byteLength).toBeLessThanOrEqual(MIN_IPC_RESPONSE_BYTES);
    }

    // 3. Multibyte UTF-8 accounting: emoji '🚀' is 2 UTF-16 chars but 4 UTF-8 bytes
    const emojiResponse = makeSuccessResponse('🚀'.repeat(20));
    const emojiSerialized = JSON.stringify(emojiResponse);
    const emojiUtf16Len = emojiSerialized.length;
    const emojiUtf8Bytes = Buffer.byteLength(emojiSerialized, 'utf8');
    expect(emojiUtf8Bytes).toBeGreaterThan(emojiUtf16Len);

    // Budget equal to UTF-16 `.length` MUST reject because UTF-8 byte length is larger
    const multibyteRejected = enforceIpcResponseByteBudget(emojiResponse, emojiUtf16Len);
    expect(multibyteRejected.ok).toBe(true);
    if (multibyteRejected.ok) {
      expect(multibyteRejected.response.type).toBe('ANALYZE_ERROR');
      if (multibyteRejected.response.type === 'ANALYZE_ERROR') {
        expect(multibyteRejected.response.error.kind).toBe('RESPONSE_TOO_LARGE');
      }
    }

    // 4. Every fixed error envelope fits within MIN_IPC_RESPONSE_BYTES (256), and tiny budget rejects replacement
    const fixedErrorResponses: readonly ParserIpcResponseV1[] = [
      ...CORE_ANALYSIS_ERROR_CODES.map((code): ParserIpcResponseV1 => ({
        protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
        type: 'ANALYZE_ERROR',
        requestId: VALID_UUID,
        error: {
          kind: 'CORE_ANALYSIS_ERROR',
          code,
          message: getSafeCoreAnalysisErrorMessage(code),
        },
      })),
      {
        protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
        type: 'ANALYZE_ERROR',
        requestId: VALID_UUID,
        error: {
          kind: 'INVALID_REQUEST',
          code: 'INVALID_IPC_REQUEST',
          message: SAFE_IPC_ERROR_MESSAGES.INVALID_IPC_REQUEST,
        },
      },
      {
        protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
        type: 'ANALYZE_ERROR',
        requestId: VALID_UUID,
        error: {
          kind: 'INTERNAL_ERROR',
          code: 'PARSER_INTERNAL_ERROR',
          message: SAFE_IPC_ERROR_MESSAGES.SERIALIZATION_FAILED,
        },
      },
      {
        protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
        type: 'ANALYZE_ERROR',
        requestId: VALID_UUID,
        error: {
          kind: 'RESPONSE_TOO_LARGE',
          code: 'IPC_RESPONSE_TOO_LARGE',
          message: SAFE_IPC_ERROR_MESSAGES.IPC_RESPONSE_TOO_LARGE,
        },
      },
      {
        protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
        type: 'ANALYZE_ERROR',
        requestId: VALID_UUID,
        error: {
          kind: 'PROTOCOL_ERROR',
          code: 'IPC_PROTOCOL_ERROR',
          message: SAFE_IPC_ERROR_MESSAGES.DUPLICATE_REQUEST,
        },
      },
    ];
    for (const errResp of fixedErrorResponses) {
      const len = Buffer.byteLength(JSON.stringify(errResp), 'utf8');
      expect(len).toBeLessThanOrEqual(MIN_IPC_RESPONSE_BYTES);
    }

    const tooSmallForReplacement = enforceIpcResponseByteBudget(asciiResponse, 64);
    expect(tooSmallForReplacement.ok).toBe(false);
    if (!tooSmallForReplacement.ok) {
      expect(tooSmallForReplacement.reason).toBe('REPLACEMENT_EXCEEDS_BUDGET');
    }

    // 5. Serialization failure (circular reference) produces bounded INTERNAL_ERROR replacement
    const circularResp = makeSuccessResponse() as unknown as Record<string, unknown>;
    circularResp.self = circularResp;
    const serialFailed = enforceIpcResponseByteBudget(
      circularResp as unknown as ParserIpcResponseV1,
      MIN_IPC_RESPONSE_BYTES,
    );
    expect(serialFailed.ok).toBe(true);
    if (serialFailed.ok) {
      expect(serialFailed.response.type).toBe('ANALYZE_ERROR');
      if (serialFailed.response.type === 'ANALYZE_ERROR') {
        expect(serialFailed.response.error.kind).toBe('INTERNAL_ERROR');
        expect(serialFailed.response.error.code).toBe('PARSER_INTERNAL_ERROR');
        expect(serialFailed.response.error.message).toBe(
          SAFE_IPC_ERROR_MESSAGES.SERIALIZATION_FAILED,
        );
      }
      expect(serialFailed.byteLength).toBeLessThanOrEqual(MIN_IPC_RESPONSE_BYTES);
    }
  });

  it('prevents sensitive sentinel strings and unrecognized key names from escaping through validation errors', () => {
    const valueSentinel = 'SENTINEL_SECRET_VALUE_999';
    const keySentinel = 'unknown test field';

    const badPathParse = parseParserIpcRequest(
      makeValidRequest({ supportedFiles: [`../${valueSentinel}.ts`] }),
    );
    expect(badPathParse.ok).toBe(false);
    if (!badPathParse.ok) {
      expect(badPathParse.message).not.toContain(valueSentinel);
    }

    const badRootParse = parseParserIpcRequest(makeValidRequest({ rootDir: valueSentinel }));
    expect(badRootParse.ok).toBe(false);
    if (!badRootParse.ok) {
      expect(badRootParse.message).not.toContain(valueSentinel);
    }

    const badKeyParse = parseParserIpcRequest({
      ...makeValidRequest(),
      [keySentinel]: valueSentinel,
    });
    expect(badKeyParse.ok).toBe(false);
    if (!badKeyParse.ok) {
      expect(badKeyParse.message).not.toContain(keySentinel);
      expect(badKeyParse.message).not.toContain(valueSentinel);
    }
  });

  it('enforces Windows vs POSIX absolute rootDir semantics and rejects drive-relative paths and control chars', () => {
    // Windows semantics
    expect(isValidAbsoluteRootDir('C:\\dev\\archon', 'win32')).toBe(true);
    expect(isValidAbsoluteRootDir('C:/dev/archon', 'win32')).toBe(true);
    expect(isValidAbsoluteRootDir('\\\\server\\share\\repo', 'win32')).toBe(true);
    expect(isValidAbsoluteRootDir('/drive-relative', 'win32')).toBe(false);
    expect(isValidAbsoluteRootDir('\\drive-relative', 'win32')).toBe(false);
    expect(isValidAbsoluteRootDir('C:drive-relative', 'win32')).toBe(false);
    expect(isValidAbsoluteRootDir('C:\\dev\\archon ', 'win32')).toBe(false);
    expect(isValidAbsoluteRootDir('C:\\dev\\archon\n', 'win32')).toBe(false);

    // POSIX semantics
    expect(isValidAbsoluteRootDir('/tmp/archon-repo', 'linux')).toBe(true);
    expect(isValidAbsoluteRootDir('C:/dev/archon', 'linux')).toBe(false);
    expect(isValidAbsoluteRootDir('relative/repo', 'linux')).toBe(false);
    expect(isValidAbsoluteRootDir(' /tmp/archon', 'linux')).toBe(false);

    // Canonical POSIX repo-relative check
    expect(isCanonicalRepoRelativePosixPath('src/index.ts')).toBe(true);
    expect(isCanonicalRepoRelativePosixPath('app/(dashboard)/[id]/page.tsx')).toBe(true);
    expect(isCanonicalRepoRelativePosixPath('src/bad\x1f.ts')).toBe(false);
  });
});
