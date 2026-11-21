import { CORE_ENGINE_ID } from '@archon/core';
import { ARCHON_VERSION } from '@archon/shared';

export const WORKER_SERVICE_INFO = {
  service: 'worker',
  version: ARCHON_VERSION,
  engine: CORE_ENGINE_ID,
} as const;

export {
  TarballExtractionError,
  type TarballExtractionErrorCode,
  type TarballExtractionErrorOptions,
} from './extractor/errors.js';
export {
  withExtractedRepo,
  type ExtractGitHubTarballOptions,
  type ExtractedRepoWorkspace,
  type ExtractionStats,
} from './extractor/github-tarball.js';
export {
  assertSafeWritePath,
  buildSafeDestinationPath,
  parseAndValidateTarEntryPath,
  type ParsedTarEntryPath,
} from './extractor/path-guard.js';
