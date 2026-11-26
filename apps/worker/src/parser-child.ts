import { realpathSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { CoreAnalysisError, analyzeRepository } from '@archon/core';
import {
  DEFAULT_MAX_IPC_RESPONSE_BYTES,
  PARSER_IPC_PROTOCOL_VERSION,
  SAFE_IPC_ERROR_MESSAGES,
  enforceIpcResponseByteBudget,
  extractValidIpcRequestId,
  getSafeCoreAnalysisErrorMessage,
  parseParserIpcRequest,
  validateAnalysisGraph,
  type CoreAnalysisErrorCode,
  type ParserIpcErrorResponseV1,
  type ParserIpcRequestV1,
  type ParserIpcResponseV1,
} from '@archon/shared';

export interface ParserChildIpcChannel {
  readonly isConnected: () => boolean;
  /**
   * Sends one JSON IPC payload. Returning `false` signals kernel buffer backpressure,
   * NOT failure; transmission completion is determined exclusively by `callback`.
   */
  readonly send: (message: ParserIpcResponseV1, callback: (error: Error | null) => void) => boolean;
}

export interface ParserChildControllerOptions {
  readonly ipc: ParserChildIpcChannel;
  readonly analyze: (request: ParserIpcRequestV1) => Promise<ParserIpcResponseV1>;
  readonly exit: (code: number) => void;
}

export interface ParserChildController {
  readonly handleMessage: (rawMessage: unknown) => void;
  readonly handleDisconnect: () => void;
}

type ChildLifecyclePhase = 'IDLE' | 'RUNNING' | 'COMMITTING' | 'DONE';

function buildSafeErrorResponse(
  requestId: string | null,
  error: ParserIpcErrorResponseV1['error'],
): ParserIpcErrorResponseV1 {
  return {
    protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
    type: 'ANALYZE_ERROR',
    requestId,
    error,
  };
}

/**
 * Executes a single validated IPC analysis request inside the dedicated parser child process.
 * - All outbound errors use fixed public-safe messages (never raw paths, stack traces, or exception text).
 * - Memory observations are captured before JSON serialization and IPC transmission, so they
 *   do NOT include subsequent serialization or parent deserialization peaks.
 * - Subprocess isolation provides fault/resource isolation, not a complete OS security sandbox.
 */
export async function executeValidatedRequest(
  request: ParserIpcRequestV1,
): Promise<ParserIpcResponseV1> {
  const baselineMem = process.memoryUsage();
  const startTime = performance.now();

  try {
    const output = await analyzeRepository({
      rootDir: request.input.rootDir,
      supportedFiles: request.input.supportedFiles,
      configFiles: request.input.configFiles,
      maxSupportedFiles: request.input.maxSupportedFiles,
      maxConfigFiles: request.input.maxConfigFiles,
      maxFileBytes: request.input.maxFileBytes,
      maxTotalBytes: request.input.maxTotalBytes,
      maxFileSnippetChars: request.input.maxFileSnippetChars,
      maxSymbolSnippetChars: request.input.maxSymbolSnippetChars,
      maxCallSiteSnippetChars: request.input.maxCallSiteSnippetChars,
      maxWarnings: request.input.maxWarnings,
      maxExtendsDepth: request.input.maxExtendsDepth,
      skipLoadingLibFiles: request.input.skipLoadingLibFiles,
    });

    const durationMs = Number(Math.max(0, performance.now() - startTime).toFixed(2));
    const postMem = process.memoryUsage();
    const maxRssKiB = process.resourceUsage().maxRSS;

    const graphCheck = validateAnalysisGraph(output, {
      maxFileSnippetChars: request.input.maxFileSnippetChars,
      maxSymbolSnippetChars: request.input.maxSymbolSnippetChars,
      maxCallSiteSnippetChars: request.input.maxCallSiteSnippetChars,
      maxWarnings: request.input.maxWarnings,
    });

    if (!graphCheck.valid) {
      return buildSafeErrorResponse(request.requestId, {
        kind: 'PROTOCOL_ERROR',
        code: 'IPC_PROTOCOL_ERROR',
        message: SAFE_IPC_ERROR_MESSAGES.INVALID_GRAPH_OUTPUT,
      });
    }

    return {
      protocolVersion: PARSER_IPC_PROTOCOL_VERSION,
      type: 'ANALYZE_SUCCESS',
      requestId: request.requestId,
      output,
      metrics: {
        durationMs,
        baselineHeapUsedBytes: baselineMem.heapUsed,
        postHeapUsedBytes: postMem.heapUsed,
        baselineRssBytes: baselineMem.rss,
        postRssBytes: postMem.rss,
        maxRssKiB,
      },
    };
  } catch (err: unknown) {
    if (err instanceof CoreAnalysisError) {
      const coreCode: CoreAnalysisErrorCode = err.code;
      return buildSafeErrorResponse(request.requestId, {
        kind: 'CORE_ANALYSIS_ERROR',
        code: coreCode,
        message: getSafeCoreAnalysisErrorMessage(coreCode),
      });
    }

    return buildSafeErrorResponse(request.requestId, {
      kind: 'INTERNAL_ERROR',
      code: 'PARSER_INTERNAL_ERROR',
      message: SAFE_IPC_ERROR_MESSAGES.PARSER_INTERNAL_ERROR,
    });
  }
}

/**
 * Strict single-request, single-response lifecycle controller for the parser child:
 * - Executes at most one analysis and emits at most one terminal IPC response.
 * - A duplicate message received BEFORE response transmission starts invalidates the lifecycle,
 *   emits one `PROTOCOL_ERROR` correlated with the primary requestId, suppresses any later
 *   success or further duplicates, and exits abnormally (code 1) after flush.
 * - A duplicate message received AFTER response transmission starts never emits a second
 *   response and forces abnormal exit (code 1) so the parent runner rejects the outcome.
 * - Note: the child can reject only duplicate messages actually delivered to it before exit.
 */
export function createParserChildController(
  options: ParserChildControllerOptions,
): ParserChildController {
  let phase: ChildLifecyclePhase = 'IDLE';
  let primaryRequestId: string | null = null;
  let activeMaxResponseBytes = DEFAULT_MAX_IPC_RESPONSE_BYTES;
  let abnormalExitRequired = false;
  let exited = false;

  const terminate = (code: number): void => {
    if (exited) {
      return;
    }
    exited = true;
    phase = 'DONE';
    options.exit(code);
  };

  const commitTerminalResponse = (
    response: ParserIpcResponseV1,
    cleanFlushExitCode: number,
  ): void => {
    phase = 'COMMITTING';
    if (cleanFlushExitCode !== 0) {
      abnormalExitRequired = true;
    }

    const budgeted = enforceIpcResponseByteBudget(response, activeMaxResponseBytes);
    if (!budgeted.ok) {
      terminate(1);
      return;
    }

    if (!options.ipc.isConnected()) {
      terminate(1);
      return;
    }

    let sendSettled = false;
    const onSendComplete = (err: Error | null): void => {
      if (sendSettled) {
        return;
      }
      sendSettled = true;
      if (err !== null || abnormalExitRequired) {
        terminate(1);
        return;
      }
      terminate(0);
    };

    try {
      // A `false` return indicates IPC backpressure, not failure; wait for flush callback.
      options.ipc.send(budgeted.response, onSendComplete);
    } catch {
      onSendComplete(new Error('Synchronous IPC send failure.'));
    }
  };

  const handleMessage = (rawMessage: unknown): void => {
    if (exited) {
      return;
    }

    if (phase === 'RUNNING') {
      // Duplicate received before terminal response commitment -> invalidate lifecycle
      commitTerminalResponse(
        buildSafeErrorResponse(primaryRequestId, {
          kind: 'PROTOCOL_ERROR',
          code: 'IPC_PROTOCOL_ERROR',
          message: SAFE_IPC_ERROR_MESSAGES.DUPLICATE_REQUEST,
        }),
        1,
      );
      return;
    }

    if (phase === 'COMMITTING' || phase === 'DONE') {
      // Duplicate received after transmission already started -> send NO second message; force abnormal exit
      abnormalExitRequired = true;
      return;
    }

    const parsed = parseParserIpcRequest(rawMessage);
    if (!parsed.ok) {
      primaryRequestId = extractValidIpcRequestId(rawMessage);
      commitTerminalResponse(
        buildSafeErrorResponse(primaryRequestId, {
          kind: 'INVALID_REQUEST',
          code: 'INVALID_IPC_REQUEST',
          message: SAFE_IPC_ERROR_MESSAGES.INVALID_IPC_REQUEST,
        }),
        0,
      );
      return;
    }

    const request = parsed.data;
    primaryRequestId = request.requestId;
    activeMaxResponseBytes = request.maxResponseBytes ?? DEFAULT_MAX_IPC_RESPONSE_BYTES;
    phase = 'RUNNING';

    void options.analyze(request).then(
      (response) => {
        if (exited || phase !== 'RUNNING') {
          return;
        }
        commitTerminalResponse(response, 0);
      },
      () => {
        if (exited || phase !== 'RUNNING') {
          return;
        }
        commitTerminalResponse(
          buildSafeErrorResponse(request.requestId, {
            kind: 'INTERNAL_ERROR',
            code: 'PARSER_INTERNAL_ERROR',
            message: SAFE_IPC_ERROR_MESSAGES.PARSER_INTERNAL_ERROR,
          }),
          0,
        );
      },
    );
  };

  const handleDisconnect = (): void => {
    if (exited) {
      return;
    }
    terminate(1);
  };

  return {
    handleMessage,
    handleDisconnect,
  };
}

function startParserChildProcess(): void {
  if (typeof process.send !== 'function') {
    process.stderr.write(
      'parser-child requires an active Node IPC channel and cannot run standalone.\n',
    );
    process.exit(1);
  }

  const boundSend = process.send.bind(process);
  const controller = createParserChildController({
    ipc: {
      isConnected: () => process.connected,
      send: (message, callback) => boundSend(message, undefined, undefined, callback),
    },
    analyze: executeValidatedRequest,
    exit: (code) => {
      process.exit(code);
    },
  });

  process.on('disconnect', () => {
    controller.handleDisconnect();
  });

  process.on('message', (rawMessage: unknown) => {
    controller.handleMessage(rawMessage);
  });
}

function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1.trim().length === 0) {
    return false;
  }
  const metaPath = fileURLToPath(metaUrl);
  try {
    const canonicalMeta = realpathSync(metaPath);
    const canonicalArgv = realpathSync(path.resolve(argv1));
    return process.platform === 'win32'
      ? canonicalMeta.toLowerCase() === canonicalArgv.toLowerCase()
      : canonicalMeta === canonicalArgv;
  } catch {
    const resolvedMeta = path.resolve(metaPath);
    const resolvedArgv = path.resolve(argv1);
    return process.platform === 'win32'
      ? resolvedMeta.toLowerCase() === resolvedArgv.toLowerCase()
      : resolvedMeta === resolvedArgv;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  startParserChildProcess();
}
