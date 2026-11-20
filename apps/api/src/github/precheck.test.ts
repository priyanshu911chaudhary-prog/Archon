import { parseGitHubRepoUrl } from '@archon/shared';
import { describe, expect, it } from 'vitest';
import { GitHubPrecheckClient, GitHubPrecheckError, type PrecheckLogger } from './precheck.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

const SAMPLE_COMMIT_SHA = '9fed2eb2f3af672da9f7bf694b996df3831fc207';
const SAMPLE_TREE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_REPO = parseGitHubRepoUrl('https://github.com/pmndrs/zustand');

function extractUrl(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function getHeader(headers: RequestInit['headers'], name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return match?.[1];
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': '1800000000',
      ...(init.headers ?? {}),
    },
  });
}

function createHappyRoutes(
  overrides: {
    meta?: Record<string, unknown>;
    commit?: Record<string, unknown>;
    tree?: Record<string, unknown>;
  } = {},
): Record<string, Response> {
  return {
    'https://api.github.com/repos/pmndrs/zustand': jsonResponse({
      name: 'Zustand',
      private: false,
      default_branch: 'main',
      size: 8200,
      owner: { login: 'PMNDRS' },
      ...(overrides.meta ?? {}),
    }),
    'https://api.github.com/repos/pmndrs/zustand/commits/main': jsonResponse({
      sha: SAMPLE_COMMIT_SHA,
      commit: { tree: { sha: SAMPLE_TREE_SHA } },
      ...(overrides.commit ?? {}),
    }),
    [`https://api.github.com/repos/pmndrs/zustand/git/trees/${SAMPLE_TREE_SHA}?recursive=1`]:
      jsonResponse({
        truncated: false,
        tree: [
          { path: 'src/index.ts', type: 'blob' },
          { path: 'src/react.tsx', type: 'blob' },
          { path: 'src/types.d.ts', type: 'blob' },
          { path: 'dist/index.js', type: 'blob' },
          { path: 'node_modules/pkg/index.js', type: 'blob' },
          { path: 'README.md', type: 'blob' },
          { path: 'src', type: 'tree' },
        ],
        ...(overrides.tree ?? {}),
      }),
  };
}

function createMockFetch(
  routes: Record<string, Response>,
  calls: { url: string; auth?: string }[] = [],
): typeof globalThis.fetch {
  return (input, init) => {
    const url = extractUrl(input);
    calls.push({ url, auth: getHeader(init?.headers, 'authorization') });
    const matched = routes[url];
    if (!matched) {
      return Promise.resolve(jsonResponse({ message: 'Not Found' }, { status: 404 }));
    }
    return Promise.resolve(matched);
  };
}

async function expectPrecheckError(
  promise: Promise<unknown>,
  expectedCode: GitHubPrecheckError['code'],
  expectedStatus: number,
): Promise<GitHubPrecheckError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(GitHubPrecheckError);
    if (err instanceof GitHubPrecheckError) {
      expect(err.code).toBe(expectedCode);
      expect(err.statusCode).toBe(expectedStatus);
      return err;
    }
  }
  throw new Error(`Expected GitHubPrecheckError(${expectedCode}) to be thrown`);
}

describe('GitHubPrecheckClient', () => {
  it('succeeds on a valid public repo, filters non-source/ignored files, and sends Bearer PAT', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const client = new GitHubPrecheckClient({
      token: 'github_pat_unit_test_value',
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch(createHappyRoutes(), calls),
    });

    const result = await client.precheckRepository(TEST_REPO);

    expect(result).toEqual({
      head: {
        owner: 'pmndrs',
        name: 'zustand',
        canonicalUrl: 'https://github.com/pmndrs/zustand',
        defaultBranch: 'main',
        commitSha: SAMPLE_COMMIT_SHA,
        treeSha: SAMPLE_TREE_SHA,
        sizeKb: 8200,
      },
      treeChecked: true,
      supportedFileCount: 2,
      emptyJsTs: false,
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.auth === 'Bearer github_pat_unit_test_value')).toBe(true);
  });

  it('supports pinned sample SHAs and skips the tree API call when early dedupe matches', async () => {
    const pinnedSha = 'bdd0813206e47e6b218d42f15a7976c8a0d3c3eb';
    const calls: { url: string; auth?: string }[] = [];
    const routes: Record<string, Response> = {
      'https://api.github.com/repos/pmndrs/zustand': jsonResponse({
        name: 'zustand',
        private: false,
        default_branch: 'main',
        size: 1200,
        owner: { login: 'pmndrs' },
      }),
      [`https://api.github.com/repos/pmndrs/zustand/commits/${pinnedSha}`]: jsonResponse({
        sha: pinnedSha,
        commit: { tree: { sha: SAMPLE_TREE_SHA } },
      }),
    };

    const client = new GitHubPrecheckClient({
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch(routes, calls),
    });

    const result = await client.precheckRepository(TEST_REPO, {
      pinnedSha,
      shouldSkipTreeCheck: () => Promise.resolve(true),
    });

    expect(result.treeChecked).toBe(false);
    expect(result.head.commitSha).toBe(pinnedSha);
    expect(calls).toHaveLength(2);
  });

  it('returns emptyJsTs=true when repository has 0 supported TS/JS files (e.g. Python repo)', async () => {
    const routes = createHappyRoutes({
      tree: {
        truncated: false,
        tree: [
          { path: 'main.py', type: 'blob' },
          { path: 'README.md', type: 'blob' },
          { path: 'types/env.d.ts', type: 'blob' },
        ],
      },
    });
    const client = new GitHubPrecheckClient({
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch(routes),
    });

    const result = await client.precheckRepository(TEST_REPO);
    expect(result.treeChecked).toBe(true);
    if (result.treeChecked) {
      expect(result.supportedFileCount).toBe(0);
      expect(result.emptyJsTs).toBe(true);
    }
  });

  it('rejects 404 or private repositories with REPO_NOT_FOUND_OR_PRIVATE', async () => {
    const notFoundClient = new GitHubPrecheckClient({
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch({}),
    });
    await expectPrecheckError(
      notFoundClient.precheckRepository(TEST_REPO),
      'REPO_NOT_FOUND_OR_PRIVATE',
      404,
    );

    const privateClient = new GitHubPrecheckClient({
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch(createHappyRoutes({ meta: { private: true } })),
    });
    await expectPrecheckError(
      privateClient.precheckRepository(TEST_REPO),
      'REPO_NOT_FOUND_OR_PRIVATE',
      404,
    );
  });

  it('handles GitHub 409 (empty repository) and 451 (blocked/DMCA) explicitly', async () => {
    const emptyRepoRoutes: Record<string, Response> = {
      'https://api.github.com/repos/pmndrs/zustand': jsonResponse({
        name: 'zustand',
        private: false,
        default_branch: 'main',
        size: 0,
        owner: { login: 'pmndrs' },
      }),
      'https://api.github.com/repos/pmndrs/zustand/commits/main': jsonResponse(
        { message: 'Git Repository is empty.' },
        { status: 409 },
      ),
    };
    const emptyClient = new GitHubPrecheckClient({
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch(emptyRepoRoutes),
    });
    await expectPrecheckError(emptyClient.precheckRepository(TEST_REPO), 'REPO_EMPTY', 422);

    const blockedClient = new GitHubPrecheckClient({
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch({
        'https://api.github.com/repos/pmndrs/zustand': jsonResponse(
          { message: 'Repository access blocked' },
          { status: 451 },
        ),
      }),
    });
    await expectPrecheckError(blockedClient.precheckRepository(TEST_REPO), 'REPO_BLOCKED', 451);
  });

  it('rejects repos exceeding MAX_REPO_SIZE_MB before requesting commits or tree', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const client = new GitHubPrecheckClient({
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch(createHappyRoutes({ meta: { size: 50 * 1024 + 1 } }), calls),
    });

    await expectPrecheckError(client.precheckRepository(TEST_REPO), 'REPO_TOO_LARGE', 422);
    expect(calls).toHaveLength(1);
  });

  it('fails closed on truncated git trees and rejects > MAX_SUPPORTED_FILES', async () => {
    const truncatedClient = new GitHubPrecheckClient({
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch(
        createHappyRoutes({
          tree: {
            truncated: true,
            tree: [{ path: 'src/index.ts', type: 'blob' }],
          },
        }),
      ),
    });
    await expectPrecheckError(
      truncatedClient.precheckRepository(TEST_REPO),
      'FILE_LIMIT_EXCEEDED',
      422,
    );

    const tooManyFilesClient = new GitHubPrecheckClient({
      maxSupportedFiles: 2,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch(
        createHappyRoutes({
          tree: {
            truncated: false,
            tree: [
              { path: 'src/a.ts', type: 'blob' },
              { path: 'src/b.ts', type: 'blob' },
              { path: 'src/c.js', type: 'blob' },
            ],
          },
        }),
      ),
    });
    await expectPrecheckError(
      tooManyFilesClient.precheckRepository(TEST_REPO),
      'FILE_LIMIT_EXCEEDED',
      422,
    );
  });

  it('distinguishes 403/429 rate limits from 404, computes retryAfterSec, and logs low-quota warnings', async () => {
    const warnings: { obj: Record<string, unknown>; msg: string }[] = [];
    const logger: PrecheckLogger = {
      warn(obj, msg) {
        warnings.push({ obj, msg });
      },
    };

    const nowMs = 1_700_000_000_000;
    const resetEpochSec = 1_700_000_120; // 120 seconds in the future

    const rateLimitedClient = new GitHubPrecheckClient({
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      logger,
      now: () => nowMs,
      fetchImpl: createMockFetch({
        'https://api.github.com/repos/pmndrs/zustand': jsonResponse(
          { message: 'API rate limit exceeded' },
          {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(resetEpochSec),
            },
          },
        ),
      }),
    });

    const err = await expectPrecheckError(
      rateLimitedClient.precheckRepository(TEST_REPO),
      'GITHUB_RATE_LIMITED',
      503,
    );
    expect(err.retryAfterSec).toBe(120);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toHaveProperty('rateLimitRemaining', 0);

    const retryAfterHeaderClient = new GitHubPrecheckClient({
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch({
        'https://api.github.com/repos/pmndrs/zustand': jsonResponse(
          { message: 'Secondary rate limit' },
          {
            status: 429,
            headers: {
              'x-ratelimit-remaining': '4000',
              'retry-after': '45',
            },
          },
        ),
      }),
    });
    const err429 = await expectPrecheckError(
      retryAfterHeaderClient.precheckRepository(TEST_REPO),
      'GITHUB_RATE_LIMITED',
      503,
    );
    expect(err429.retryAfterSec).toBe(45);
  });

  it('handles network errors and invalid payloads safely without leaking the PAT', async () => {
    const secretToken = 'github_pat_never_leak_this_secret_value';

    const networkErrorClient = new GitHubPrecheckClient({
      token: secretToken,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: () => Promise.reject(new Error('socket hang up')),
    });
    const netErr = await expectPrecheckError(
      networkErrorClient.precheckRepository(TEST_REPO),
      'GITHUB_UPSTREAM_ERROR',
      502,
    );
    expect(netErr.message).not.toContain(secretToken);

    const badPayloadClient = new GitHubPrecheckClient({
      token: secretToken,
      maxSupportedFiles: 500,
      maxRepoSizeMb: 50,
      fetchImpl: createMockFetch({
        'https://api.github.com/repos/pmndrs/zustand': jsonResponse({ unexpected: true }),
      }),
    });
    const payloadErr = await expectPrecheckError(
      badPayloadClient.precheckRepository(TEST_REPO),
      'GITHUB_UPSTREAM_ERROR',
      502,
    );
    expect(payloadErr.message).not.toContain(secretToken);
  });
});
