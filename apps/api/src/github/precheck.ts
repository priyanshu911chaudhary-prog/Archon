import { isSupportedSourcePath, type ParsedGitHubRepoUrl } from '@archon/shared';
import { z } from 'zod';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const LOW_RATE_LIMIT_WARN_THRESHOLD = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_SEC = 60;

export type GitHubPrecheckErrorCode =
  | 'REPO_NOT_FOUND_OR_PRIVATE'
  | 'REPO_EMPTY'
  | 'REPO_BLOCKED'
  | 'REPO_TOO_LARGE'
  | 'FILE_LIMIT_EXCEEDED'
  | 'GITHUB_RATE_LIMITED'
  | 'GITHUB_UPSTREAM_ERROR';

export interface GitHubPrecheckErrorOptions {
  readonly code: GitHubPrecheckErrorCode;
  readonly statusCode: number;
  readonly message: string;
  readonly retryAfterSec?: number;
  readonly details?: Record<string, unknown>;
}

export class GitHubPrecheckError extends Error {
  readonly code: GitHubPrecheckErrorCode;
  readonly statusCode: number;
  readonly retryAfterSec?: number;
  readonly details?: Record<string, unknown>;

  constructor(options: GitHubPrecheckErrorOptions) {
    super(options.message);
    this.name = 'GitHubPrecheckError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryAfterSec = options.retryAfterSec;
    this.details = options.details;
  }
}

export interface PrecheckLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface GitHubPrecheckClientOptions {
  readonly token?: string;
  readonly maxSupportedFiles: number;
  readonly maxRepoSizeMb: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly logger?: PrecheckLogger;
  readonly now?: () => number;
}

export interface RepoHeadInfo {
  readonly owner: string;
  readonly name: string;
  readonly canonicalUrl: string;
  readonly defaultBranch: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly sizeKb: number;
}

export interface RepoTreeInspection {
  readonly supportedFileCount: number;
  readonly emptyJsTs: boolean;
}

export type PrecheckRepositoryResult =
  | {
      readonly head: RepoHeadInfo;
      readonly treeChecked: false;
    }
  | {
      readonly head: RepoHeadInfo;
      readonly treeChecked: true;
      readonly supportedFileCount: number;
      readonly emptyJsTs: boolean;
    };

export interface PrecheckRepositoryOptions {
  readonly pinnedSha?: string;
  /**
   * Optional early-exit check (e.g. Postgres lookup for owner/name/commitSha).
   * When it returns true, the client skips the recursive git-tree API call.
   */
  readonly shouldSkipTreeCheck?: (head: RepoHeadInfo) => Promise<boolean>;
}

const githubRepoMetaSchema = z.object({
  name: z.string().min(1),
  private: z.boolean(),
  default_branch: z.string().min(1),
  size: z.number().int().nonnegative(),
  owner: z.object({
    login: z.string().min(1),
  }),
});

const githubCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/i),
  commit: z.object({
    tree: z.object({
      sha: z.string().regex(/^[0-9a-f]{40}$/i),
    }),
  }),
});

const githubTreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
    }),
  ),
});

function parseNonNegativeIntHeader(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function computeRetryAfterSec(
  retryAfterRaw: string | null,
  resetEpochSec: number | null,
  nowMs: number,
): number {
  const retryInt = parseNonNegativeIntHeader(retryAfterRaw);
  if (retryInt !== null) {
    return Math.max(1, retryInt);
  }
  if (retryAfterRaw !== null) {
    const parsedDateMs = Date.parse(retryAfterRaw);
    if (!Number.isNaN(parsedDateMs)) {
      return Math.max(1, Math.ceil((parsedDateMs - nowMs) / 1000));
    }
  }
  if (resetEpochSec !== null) {
    return Math.max(1, resetEpochSec - Math.floor(nowMs / 1000));
  }
  return DEFAULT_RETRY_AFTER_SEC;
}

export class GitHubPrecheckClient {
  private readonly token?: string;
  private readonly maxSupportedFiles: number;
  private readonly maxRepoSizeMb: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly logger?: PrecheckLogger;
  private readonly now: () => number;

  constructor(options: GitHubPrecheckClientOptions) {
    this.token = options.token;
    this.maxSupportedFiles = options.maxSupportedFiles;
    this.maxRepoSizeMb = options.maxRepoSizeMb;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  async resolveRepositoryHead(
    repo: ParsedGitHubRepoUrl,
    pinnedSha?: string,
  ): Promise<RepoHeadInfo> {
    const meta = await this.fetchJson(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
      githubRepoMetaSchema,
    );

    if (meta.private) {
      throw new GitHubPrecheckError({
        code: 'REPO_NOT_FOUND_OR_PRIVATE',
        statusCode: 404,
        message:
          'Repository not found or is private. Archon v1 supports public GitHub repositories only.',
      });
    }

    const maxSizeKb = this.maxRepoSizeMb * 1024;
    if (meta.size > maxSizeKb) {
      throw new GitHubPrecheckError({
        code: 'REPO_TOO_LARGE',
        statusCode: 422,
        message: `Repository size exceeds the v1.0 limit of ${this.maxRepoSizeMb} MB. Try one of the pre-indexed sample repositories instead.`,
        details: {
          sizeKb: meta.size,
          maxRepoSizeMb: this.maxRepoSizeMb,
        },
      });
    }

    const canonicalOwner = meta.owner.login.toLowerCase();
    const canonicalName = meta.name.toLowerCase();
    const targetRef = pinnedSha ?? meta.default_branch;

    const commit = await this.fetchJson(
      `/repos/${encodeURIComponent(canonicalOwner)}/${encodeURIComponent(canonicalName)}/commits/${encodeURIComponent(targetRef)}`,
      githubCommitSchema,
    );

    return {
      owner: canonicalOwner,
      name: canonicalName,
      canonicalUrl: `https://github.com/${canonicalOwner}/${canonicalName}`,
      defaultBranch: meta.default_branch,
      commitSha: commit.sha,
      treeSha: commit.commit.tree.sha,
      sizeKb: meta.size,
    };
  }

  async inspectRepositoryTree(
    owner: string,
    name: string,
    treeSha: string,
  ): Promise<RepoTreeInspection> {
    const tree = await this.fetchJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
      githubTreeSchema,
    );

    if (tree.truncated) {
      throw new GitHubPrecheckError({
        code: 'FILE_LIMIT_EXCEEDED',
        statusCode: 422,
        message: `Repository file tree is too large for Archon v1.0 (limit: ${this.maxSupportedFiles} supported TS/JS files). Try one of the pre-indexed sample repositories instead.`,
        details: {
          truncated: true,
          maxSupportedFiles: this.maxSupportedFiles,
        },
      });
    }

    let supportedFileCount = 0;
    for (const entry of tree.tree) {
      if (entry.type === 'blob' && isSupportedSourcePath(entry.path)) {
        supportedFileCount += 1;
      }
    }

    if (supportedFileCount > this.maxSupportedFiles) {
      throw new GitHubPrecheckError({
        code: 'FILE_LIMIT_EXCEEDED',
        statusCode: 422,
        message: `Repository has ${supportedFileCount} supported TS/JS files, exceeding the v1.0 limit of ${this.maxSupportedFiles}. Try one of the pre-indexed sample repositories instead.`,
        details: {
          supportedFileCount,
          maxSupportedFiles: this.maxSupportedFiles,
        },
      });
    }

    return {
      supportedFileCount,
      emptyJsTs: supportedFileCount === 0,
    };
  }

  async precheckRepository(
    repo: ParsedGitHubRepoUrl,
    options: PrecheckRepositoryOptions = {},
  ): Promise<PrecheckRepositoryResult> {
    const head = await this.resolveRepositoryHead(repo, options.pinnedSha);

    if (options.shouldSkipTreeCheck && (await options.shouldSkipTreeCheck(head))) {
      return {
        head,
        treeChecked: false,
      };
    }

    const inspection = await this.inspectRepositoryTree(head.owner, head.name, head.treeSha);

    return {
      head,
      treeChecked: true,
      supportedFileCount: inspection.supportedFileCount,
      emptyJsTs: inspection.emptyJsTs,
    };
  }

  private async fetchJson<T>(endpointPath: string, schema: z.ZodType<T>): Promise<T> {
    const url = `${GITHUB_API_BASE}${endpointPath}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'archon-app',
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GitHubPrecheckError({
        code: 'GITHUB_UPSTREAM_ERROR',
        statusCode: 502,
        message: 'Unable to reach GitHub API. Please try again shortly.',
      });
    }

    const remaining = parseNonNegativeIntHeader(response.headers.get('x-ratelimit-remaining'));
    const resetEpochSec = parseNonNegativeIntHeader(response.headers.get('x-ratelimit-reset'));
    const retryAfterRaw = response.headers.get('retry-after');

    if (remaining !== null && remaining < LOW_RATE_LIMIT_WARN_THRESHOLD) {
      this.logger?.warn(
        {
          endpoint: endpointPath,
          rateLimitRemaining: remaining,
          rateLimitResetEpochSec: resetEpochSec,
        },
        'GitHub API rate limit remaining is low',
      );
    }

    if (!response.ok) {
      throw this.mapErrorStatus(response.status, remaining, resetEpochSec, retryAfterRaw);
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch {
      throw new GitHubPrecheckError({
        code: 'GITHUB_UPSTREAM_ERROR',
        statusCode: 502,
        message: 'GitHub API returned an unreadable response.',
      });
    }

    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) {
      throw new GitHubPrecheckError({
        code: 'GITHUB_UPSTREAM_ERROR',
        statusCode: 502,
        message: 'GitHub API returned an unexpected payload shape.',
      });
    }

    return parsed.data;
  }

  private mapErrorStatus(
    status: number,
    remaining: number | null,
    resetEpochSec: number | null,
    retryAfterRaw: string | null,
  ): GitHubPrecheckError {
    if (status === 429 || (status === 403 && (remaining === 0 || retryAfterRaw !== null))) {
      const retryAfterSec = computeRetryAfterSec(retryAfterRaw, resetEpochSec, this.now());
      return new GitHubPrecheckError({
        code: 'GITHUB_RATE_LIMITED',
        statusCode: 503,
        retryAfterSec,
        message: 'GitHub API rate limit reached. Please retry after the cooldown period.',
      });
    }

    if (status === 404) {
      return new GitHubPrecheckError({
        code: 'REPO_NOT_FOUND_OR_PRIVATE',
        statusCode: 404,
        message:
          'Repository not found or is private. Archon v1 supports public GitHub repositories only.',
      });
    }

    if (status === 409) {
      return new GitHubPrecheckError({
        code: 'REPO_EMPTY',
        statusCode: 422,
        message: 'Repository is empty and has no commits to analyze.',
      });
    }

    if (status === 451) {
      return new GitHubPrecheckError({
        code: 'REPO_BLOCKED',
        statusCode: 451,
        message: 'Repository is unavailable for legal reasons (DMCA/takedown).',
      });
    }

    if (status === 401) {
      return new GitHubPrecheckError({
        code: 'GITHUB_UPSTREAM_ERROR',
        statusCode: 502,
        message: 'GitHub API authentication failed on the server.',
      });
    }

    return new GitHubPrecheckError({
      code: 'GITHUB_UPSTREAM_ERROR',
      statusCode: 502,
      message: `GitHub API request failed with status ${status}.`,
    });
  }
}
