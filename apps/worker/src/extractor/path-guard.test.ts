import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { TarballExtractionError } from './errors.js';
import {
  assertSafeWritePath,
  buildSafeDestinationPath,
  parseAndValidateTarEntryPath,
} from './path-guard.js';

describe('path-guard', () => {
  it('strips the single top-level folder and returns POSIX segments', () => {
    const parsed = parseAndValidateTarEntryPath('repo-sha/src/index.ts', null);
    expect(parsed.topLevelPrefix).toBe('repo-sha');
    expect(parsed.relativePosixPath).toBe('src/index.ts');
    expect(parsed.relativeSegments).toEqual(['src', 'index.ts']);
  });

  it('rejects traversal, absolute, drive, backslash, empty-segment and control-character paths', () => {
    const bad = [
      '',
      '/etc/passwd',
      'C:/x/y.ts',
      'repo-sha/../evil.ts',
      'repo-sha/src/../a.ts',
      'repo-sha/src\\evil.ts',
      'repo-sha//a.ts',
      'repo-sha/a\u0000b.ts',
    ];
    for (const entryPath of bad) {
      expect(() => parseAndValidateTarEntryPath(entryPath, 'repo-sha')).toThrow(
        TarballExtractionError,
      );
    }
  });

  it('rejects entries outside the expected top-level folder', () => {
    expect(() => parseAndValidateTarEntryPath('other/src/a.ts', 'repo-sha')).toThrow(
      TarballExtractionError,
    );
  });

  it('rejects Windows-reserved and trailing-dot write segments only when asked to write', () => {
    expect(() => {
      assertSafeWritePath(['src', 'CON.ts'], 'src/CON.ts');
    }).toThrow(TarballExtractionError);
    expect(() => {
      assertSafeWritePath(['src', 'foo.', 'a.ts'], 'src/foo./a.ts');
    }).toThrow(TarballExtractionError);
    expect(() => {
      assertSafeWritePath(['src', 'index.ts'], 'src/index.ts');
    }).not.toThrow();
  });

  it('refuses destinations that escape the root', () => {
    const root = os.tmpdir();
    expect(buildSafeDestinationPath(root, ['src', 'a.ts']).startsWith(root)).toBe(true);
    expect(() => buildSafeDestinationPath(root, ['..', 'x.ts'])).toThrow(TarballExtractionError);
  });
});
