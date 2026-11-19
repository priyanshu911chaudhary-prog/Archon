import { CORE_ENGINE_ID } from '@archon/core';
import { ARCHON_VERSION } from '@archon/shared';

export const API_SERVICE_INFO = {
  service: 'api',
  version: ARCHON_VERSION,
  engine: CORE_ENGINE_ID,
} as const;