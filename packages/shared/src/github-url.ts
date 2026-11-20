export const MAX_GITHUB_URL_LENGTH = 256;

const PRINTABLE_ASCII_NO_SPACE_RE = /^[\x21-\x7E]+$/;
const FORBIDDEN_RAW_CHARS_RE = /[?#\\@%]/;
const GITHUB_OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const GITHUB_REPO_RE = /^[a-zA-Z0-9._-]{1,100}$/;

export interface ParsedGitHubRepoUrl {
  readonly owner: string;
  readonly name: string;
  readonly canonicalUrl: string;
}

export class InvalidGitHubUrlError extends Error {
  readonly code = 'INVALID_URL' as const;
  readonly statusCode = 400 as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidGitHubUrlError';
  }
}

export type ParseGitHubRepoUrlResult =
  | { readonly ok: true; readonly value: ParsedGitHubRepoUrl }
  | { readonly ok: false; readonly error: InvalidGitHubUrlError };

function reject(reason: string): ParseGitHubRepoUrlResult {
  return { ok: false, error: new InvalidGitHubUrlError(reason) };
}

/**
 * Strictly validates and canonicalizes a public GitHub repository URL.
 * Allows only `https://github.com/<owner>/<repo>` (optional trailing `/` or `.git`),
 * rejecting credentials, ports, query/fragments, traversal, non-ASCII/homographs, and other hosts.
 */
export function safeParseGitHubRepoUrl(rawInput: string): ParseGitHubRepoUrlResult {
  const trimmed = rawInput.trim();

  if (trimmed.length === 0) {
    return reject('GitHub repository URL is required.');
  }
  if (trimmed.length > MAX_GITHUB_URL_LENGTH) {
    return reject(`GitHub repository URL must not exceed ${MAX_GITHUB_URL_LENGTH} characters.`);
  }
  if (!PRINTABLE_ASCII_NO_SPACE_RE.test(trimmed)) {
    return reject('GitHub repository URL must contain only printable ASCII characters.');
  }
  if (FORBIDDEN_RAW_CHARS_RE.test(trimmed)) {
    return reject(
      'GitHub repository URL must not contain query strings, fragments, credentials, backslashes, or percent-encoding.',
    );
  }
  if (!trimmed.toLowerCase().startsWith('https://')) {
    return reject('GitHub repository URL must use https://.');
  }

  // Inspect raw authority and raw path BEFORE `new URL` normalizes default ports (:443) or `..` segments
  const withoutScheme = trimmed.slice('https://'.length);
  const firstSlashIdx = withoutScheme.indexOf('/');
  if (firstSlashIdx === -1) {
    return reject('GitHub repository URL must include both owner and repository name.');
  }

  const rawAuthority = withoutScheme.slice(0, firstSlashIdx);
  if (rawAuthority.includes(':')) {
    return reject('GitHub repository URL must not include an explicit port.');
  }
  if (rawAuthority.toLowerCase() !== 'github.com') {
    return reject('Only github.com repository URLs are supported.');
  }

  const rawPath = withoutScheme.slice(firstSlashIdx);
  const rawSegmentsCheck = rawPath.split('/');
  if (rawSegmentsCheck.some((segment) => segment === '.' || segment === '..')) {
    return reject('GitHub repository URL must not contain path traversal segments.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return reject('Invalid URL format.');
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'github.com' ||
    parsedUrl.port !== '' ||
    parsedUrl.username !== '' ||
    parsedUrl.password !== ''
  ) {
    return reject('Only plain https://github.com/<owner>/<repo> URLs are allowed.');
  }

  const normalizedRawPath = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const pathBody = normalizedRawPath.startsWith('/')
    ? normalizedRawPath.slice(1)
    : normalizedRawPath;

  const segments = pathBody.split('/');
  const [rawOwner, rawRepoSegment] = segments;
  if (segments.length !== 2 || !rawOwner || !rawRepoSegment) {
    return reject('GitHub repository URL must match https://github.com/<owner>/<repo>.');
  }

  const rawRepo = rawRepoSegment.replace(/\.git$/i, '');

  if (!GITHUB_OWNER_RE.test(rawOwner)) {
    return reject('Invalid GitHub repository owner name.');
  }
  if (
    rawRepo.length === 0 ||
    rawRepo === '.' ||
    rawRepo === '..' ||
    rawRepo.includes('..') ||
    !GITHUB_REPO_RE.test(rawRepo)
  ) {
    return reject('Invalid GitHub repository name.');
  }

  const owner = rawOwner.toLowerCase();
  const name = rawRepo.toLowerCase();

  return {
    ok: true,
    value: {
      owner,
      name,
      canonicalUrl: `https://github.com/${owner}/${name}`,
    },
  };
}

export function parseGitHubRepoUrl(rawInput: string): ParsedGitHubRepoUrl {
  const result = safeParseGitHubRepoUrl(rawInput);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
