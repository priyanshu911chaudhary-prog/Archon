export type CoreAnalysisErrorCode =
  'INVALID_WORKSPACE' | 'PATH_TRAVERSAL_REJECTED' | 'FILE_LIMIT_EXCEEDED' | 'SIZE_LIMIT_EXCEEDED';

export interface CoreAnalysisErrorOptions {
  readonly code: CoreAnalysisErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class CoreAnalysisError extends Error {
  readonly code: CoreAnalysisErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(options: CoreAnalysisErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CoreAnalysisError';
    this.code = options.code;
    this.details = options.details;
  }
}
