export const ARCHON_APP_NAME = 'Archon' as const;
export const ARCHON_VERSION = '0.1.0' as const;

export {
  EnvValidationError,
  envSchema,
  findRepoRoot,
  loadEnv,
  parseEnv,
  type AppEnv,
  type EnvValidationIssue,
  type LoadEnvOptions,
  type LogLevel,
} from './env.js';

export {
  LOG_REDACT_PATHS,
  REDACTED_CENSOR,
  createLogger,
  type CreateLoggerOptions,
  type DestinationStream,
  type Logger,
} from './logger.js';
