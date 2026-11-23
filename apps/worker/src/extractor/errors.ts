export type TarballExtractionErrorCode =
  | 'TARBALL_REDIRECT_REJECTED'
  | 'TARBALL_RATE_LIMITED'
  | 'TARBALL_UPSTREAM_ERROR'
  | 'TARBALL_TIMEOUT'
  | 'TARBALL_SECURITY_VIOLATION'
  | 'TARBALL_SIZE_LIMIT_EXCEEDED'
  | 'TARBALL_FILE_LIMIT_EXCEEDED'
  | 'TARBALL_PARSE_ERROR';

export interface TarballExtractionErrorOptions {
  readonly code: TarballExtractionErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly retryAfterSec?: number;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class TarballExtractionError extends Error {
  readonly code: TarballExtractionErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSec?: number;
  readonly details?: Record<string, unknown>;

  constructor(options: TarballExtractionErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TarballExtractionError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.retryAfterSec = options.retryAfterSec;
    this.details = options.details;
  }
}
