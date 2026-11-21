export const PG_UNIQUE_VIOLATION_CODE = '23505' as const;

export interface PgErrorInfo {
  readonly code?: string;
  readonly constraint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Safely extracts PostgreSQL SQLSTATE error code and constraint name from either a raw
 * `pg` DatabaseError or a Drizzle ORM `DrizzleQueryError` wrapping it in `.cause`.
 */
export function extractPgErrorInfo(err: unknown): PgErrorInfo {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && isRecord(current); depth += 1) {
    const code = typeof current.code === 'string' ? current.code : undefined;
    const constraint = typeof current.constraint === 'string' ? current.constraint : undefined;
    if (code !== undefined) {
      return { code, constraint };
    }
    current = current.cause;
  }
  return {};
}

export function isPgUniqueViolation(err: unknown, expectedConstraint?: string): boolean {
  const info = extractPgErrorInfo(err);
  if (info.code !== PG_UNIQUE_VIOLATION_CODE) {
    return false;
  }
  if (expectedConstraint !== undefined && info.constraint !== undefined) {
    return info.constraint === expectedConstraint;
  }
  return true;
}

export type DbErrorCode =
  | 'DB_CONNECTION_ERROR'
  | 'DB_MIGRATION_ERROR'
  | 'DB_VALIDATION_ERROR'
  | 'DB_CONFLICT_UNRESOLVED'
  | 'DB_QUERY_ERROR';

export class DbError extends Error {
  readonly code: DbErrorCode;
  readonly pgCode?: string;

  constructor(code: DbErrorCode, message: string, options?: { cause?: unknown; pgCode?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DbError';
    this.code = code;
    this.pgCode = options?.pgCode;
  }
}
