import { describe, expect, it } from 'vitest';
import { InvalidGitHubUrlError, parseGitHubRepoUrl, safeParseGitHubRepoUrl } from './github-url.js';

describe('parseGitHubRepoUrl — valid URLs (cases 1-6)', () => {
  it('1. accepts a standard valid GitHub URL', () => {
    expect(parseGitHubRepoUrl('https://github.com/pmndrs/zustand')).toEqual({
      owner: 'pmndrs',
      name: 'zustand',
      canonicalUrl: 'https://github.com/pmndrs/zustand',
    });
  });

  it('2. strips optional trailing .git suffix', () => {
    expect(parseGitHubRepoUrl('https://github.com/pmndrs/zustand.git')).toEqual({
      owner: 'pmndrs',
      name: 'zustand',
      canonicalUrl: 'https://github.com/pmndrs/zustand',
    });
  });

  it('3. strips optional single trailing slash', () => {
    expect(parseGitHubRepoUrl('https://github.com/pmndrs/zustand/')).toEqual({
      owner: 'pmndrs',
      name: 'zustand',
      canonicalUrl: 'https://github.com/pmndrs/zustand',
    });
  });

  it('4. normalizes mixed-case scheme, host, owner, and repo to lowercase', () => {
    expect(parseGitHubRepoUrl('HTTPS://GitHub.COM/Shadcn-UI/Taxonomy')).toEqual({
      owner: 'shadcn-ui',
      name: 'taxonomy',
      canonicalUrl: 'https://github.com/shadcn-ui/taxonomy',
    });
  });

  it('5. trims surrounding whitespace and allows dots inside repo names', () => {
    expect(parseGitHubRepoUrl('  https://github.com/vercel/next.js  ')).toEqual({
      owner: 'vercel',
      name: 'next.js',
      canonicalUrl: 'https://github.com/vercel/next.js',
    });
  });

  it('6. accepts single-character owner and underscore/hyphen/dot repo names', () => {
    expect(parseGitHubRepoUrl('https://github.com/a/b_c-d.1')).toEqual({
      owner: 'a',
      name: 'b_c-d.1',
      canonicalUrl: 'https://github.com/a/b_c-d.1',
    });
  });
});

describe('parseGitHubRepoUrl — rejected URLs (cases 7-18)', () => {
  function expectRejected(inputs: readonly string[]): void {
    for (const input of inputs) {
      const result = safeParseGitHubRepoUrl(input);
      expect(result.ok, `Expected rejection for: ${JSON.stringify(input)}`).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidGitHubUrlError);
        expect(result.error.code).toBe('INVALID_URL');
        expect(result.error.statusCode).toBe(400);
      }
    }
  }

  it('7. rejects non-HTTPS schemes', () => {
    expectRejected([
      'http://github.com/pmndrs/zustand',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]);
  });

  it('8. rejects SSH and SCP-style git URLs', () => {
    expectRejected([
      'git@github.com:pmndrs/zustand.git',
      'ssh://git@github.com/pmndrs/zustand',
      'git://github.com/pmndrs/zustand.git',
    ]);
  });

  it('9. rejects non-github.com hosts and github subdomains', () => {
    expectRejected([
      'https://gitlab.com/pmndrs/zustand',
      'https://www.github.com/pmndrs/zustand',
      'https://api.github.com/pmndrs/zustand',
      'https://github.com.evil.com/pmndrs/zustand',
      'https://evilgithub.com/pmndrs/zustand',
    ]);
  });

  it('10. rejects embedded credentials', () => {
    expectRejected(['https://user:pass@github.com/a/b', 'https://token@github.com/a/b']);
  });

  it('11. rejects explicit ports including default :443', () => {
    expectRejected([
      'https://github.com:8443/a/b',
      'https://github.com:443/a/b',
      'https://github.com:/a/b',
    ]);
  });

  it('12. rejects query strings and fragments (including bare ? and #)', () => {
    expectRejected([
      'https://github.com/a/b?tab=readme',
      'https://github.com/a/b#readme',
      'https://github.com/a/b?',
      'https://github.com/a/b#',
    ]);
  });

  it('13. rejects wrong path depth and extra trailing slashes', () => {
    expectRejected([
      'https://github.com/',
      'https://github.com/pmndrs',
      'https://github.com/pmndrs/zustand/tree/main',
      'https://github.com/pmndrs/zustand//',
    ]);
  });

  it('14. rejects traversal, backslashes, and percent-encoding', () => {
    expectRejected([
      'https://github.com/a/..',
      'https://github.com/a/b/../c',
      'https://github.com/../etc/passwd',
      'https://github.com/a/b%2f..',
      'https://github.com/a/b\\c',
    ]);
  });

  it('15. rejects invalid GitHub owner and repository identifier rules', () => {
    expectRejected([
      'https://github.com/-bad/repo',
      'https://github.com/bad-/repo',
      'https://github.com/a--b/repo',
      'https://github.com/owner/.git',
      'https://github.com/owner/foo..bar',
      `https://github.com/${'a'.repeat(40)}/repo`,
      `https://github.com/owner/${'b'.repeat(101)}`,
    ]);
  });

  it('16. rejects shell/command-injection payloads', () => {
    expectRejected([
      'https://github.com/a/b;rm -rf /',
      'https://github.com/a/$(whoami)',
      'https://github.com/a/`id`',
      'https://github.com/a/b|cat',
    ]);
  });

  it('17. rejects Unicode homographs, invisible characters, and full-width slashes', () => {
    expectRejected([
      'https://g\u0456thub.com/a/b',
      'https://github.com/a/b\u200b',
      'https://github.com/a\uff0fb',
    ]);
  });

  it('18. rejects empty strings, whitespace-only, plain text, and >256-char inputs', () => {
    expectRejected(['', '   ', 'not-a-url', `https://github.com/owner/${'a'.repeat(240)}`]);
  });

  it('throws InvalidGitHubUrlError from parseGitHubRepoUrl on invalid input', () => {
    expect(() => parseGitHubRepoUrl('http://github.com/a/b')).toThrow(InvalidGitHubUrlError);
  });
});
