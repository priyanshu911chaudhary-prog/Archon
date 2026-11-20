import { describe, expect, it } from 'vitest';
import { isRepoConfigPath, isSupportedSourcePath, normalizePosixPath } from './repo-filter.js';

describe('repo-filter', () => {
  it('normalizes Windows backslashes and leading slashes to POSIX paths', () => {
    expect(normalizePosixPath('src\\lib\\billing.ts')).toBe('src/lib/billing.ts');
    expect(normalizePosixPath('/src/index.ts')).toBe('src/index.ts');
    expect(normalizePosixPath('///a\\b/c.tsx')).toBe('a/b/c.tsx');
  });

  it('accepts supported TS/JS extensions and rejects ignored dirs and declaration files', () => {
    const accepted = [
      'src/index.ts',
      'app/page.tsx',
      'lib/helper.js',
      'components/Button.jsx',
      'scripts/build.mjs',
      'config/lint.cjs',
      'src\\nested\\util.TS',
    ];
    for (const p of accepted) {
      expect(isSupportedSourcePath(p)).toBe(true);
    }

    const rejected = [
      '',
      'README.md',
      'src/types.d.ts',
      'src/types.d.mts',
      'src/types.d.cts',
      'node_modules/pkg/index.js',
      'apps/web/node_modules/x/a.ts',
      'dist/index.js',
      'build/output.js',
      '.next/server/app.js',
      'out/bundle.js',
      'coverage/lcov.js',
      'src/__snapshots__/App.test.tsx',
      'main.py',
    ];
    for (const p of rejected) {
      expect(isSupportedSourcePath(p)).toBe(false);
    }
  });

  it('identifies tsconfig, jsconfig, and package.json outside ignored directories', () => {
    expect(isRepoConfigPath('tsconfig.json')).toBe(true);
    expect(isRepoConfigPath('apps/web/tsconfig.build.json')).toBe(true);
    expect(isRepoConfigPath('jsconfig.json')).toBe(true);
    expect(isRepoConfigPath('package.json')).toBe(true);
    expect(isRepoConfigPath('node_modules/zod/package.json')).toBe(false);
    expect(isRepoConfigPath('dist/package.json')).toBe(false);
    expect(isRepoConfigPath('src/data.json')).toBe(false);
  });
});
