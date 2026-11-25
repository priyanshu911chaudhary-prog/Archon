import { describe, expect, it } from 'vitest';
import type { LoadedWorkspaceFile } from './discovery.js';
import { findNearestTsConfig, loadWorkspaceTsConfigs } from './tsconfig-loader.js';

function makeConfig(relativePath: string, content: string): LoadedWorkspaceFile {
  return {
    relativePath,
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
  };
}

describe('loadWorkspaceTsConfigs (verified TS 6.0.2 inheritance semantics)', () => {
  it('A1/A2/A3: replaces inherited paths when child declares paths (including empty {}) and inherits when omitted', () => {
    const configs = [
      makeConfig(
        'tsconfig.base.json',
        `{
          // JSONC comments and trailing commas
          "compilerOptions": {
            "paths": {
              "@a/*": ["./a/*"],
              "@b/*": ["./b/*"],
            },
          },
        }`,
      ),
      // A1: child declares different paths -> replaces @a/* and @b/* completely
      makeConfig(
        'apps/replace/tsconfig.json',
        JSON.stringify({
          extends: '../../tsconfig.base.json',
          compilerOptions: {
            paths: { '@c/*': ['./c/*'] },
          },
        }),
      ),
      // A2: child explicitly declares paths: {} -> clears inherited aliases
      makeConfig(
        'apps/empty/tsconfig.json',
        JSON.stringify({
          extends: '../../tsconfig.base.json',
          compilerOptions: {
            paths: {},
          },
        }),
      ),
      // A3: child omits paths -> inherits parent aliases anchored to parent directory
      makeConfig(
        'apps/omit/tsconfig.json',
        JSON.stringify({
          extends: '../../tsconfig.base.json',
          compilerOptions: { strict: true },
        }),
      ),
    ];

    const result = loadWorkspaceTsConfigs(configs);
    expect(result.warnings).toEqual([]);

    const replaceCfg = findNearestTsConfig('apps/replace/src/index.ts', result.configsByDir);
    expect(replaceCfg?.pathsDeclarationDir).toBe('apps/replace');
    expect(replaceCfg?.paths).toEqual({ '@c/*': ['/repo/apps/replace/c/*'] });

    const emptyCfg = findNearestTsConfig('apps/empty/src/index.ts', result.configsByDir);
    expect(emptyCfg?.pathsDeclarationDir).toBe('apps/empty');
    expect(emptyCfg?.paths).toEqual({});

    const omitCfg = findNearestTsConfig('apps/omit/src/index.ts', result.configsByDir);
    expect(omitCfg?.pathsDeclarationDir).toBe('');
    expect(omitCfg?.paths).toEqual({
      '@a/*': ['/repo/a/*'],
      '@b/*': ['/repo/b/*'],
    });
  });

  it('A4: replaces earlier parent paths with later parent paths in extends arrays', () => {
    const configs = [
      makeConfig(
        'tsconfig.p1.json',
        JSON.stringify({
          compilerOptions: {
            paths: { '@p1/*': ['./p1/*'], '@shared/*': ['./from-p1/*'] },
          },
        }),
      ),
      makeConfig(
        'tsconfig.p2.json',
        JSON.stringify({
          compilerOptions: {
            paths: { '@p2/*': ['./p2/*'], '@shared/*': ['./from-p2/*'] },
          },
        }),
      ),
      makeConfig(
        'tsconfig.p3-no-paths.json',
        JSON.stringify({
          compilerOptions: { strict: true },
        }),
      ),
      makeConfig(
        'tsconfig.json',
        JSON.stringify({
          extends: ['./tsconfig.p1.json', './tsconfig.p2.json', './tsconfig.p3-no-paths.json'],
        }),
      ),
    ];

    const result = loadWorkspaceTsConfigs(configs);
    expect(result.warnings).toEqual([]);

    const root = result.configsByPath.get('tsconfig.json');
    expect(root?.paths).toEqual({
      '@p2/*': ['/repo/p2/*'],
      '@shared/*': ['/repo/from-p2/*'],
    });
  });

  it('A5/A6/A7/A8: anchors paths to effective baseUrl when present, otherwise to declaring config directory', () => {
    const configs = [
      // A5: parent baseUrl + paths, child overrides baseUrl -> inherited paths re-anchors to child baseUrl
      makeConfig(
        'a5/tsconfig.base.json',
        JSON.stringify({
          compilerOptions: {
            baseUrl: './src',
            paths: { '@p/*': ['p/*'] },
          },
        }),
      ),
      makeConfig(
        'a5/apps/web/tsconfig.json',
        JSON.stringify({
          extends: '../../tsconfig.base.json',
          compilerOptions: { baseUrl: './alt' },
        }),
      ),
      // A6: parent paths without baseUrl -> anchors to parent directory
      makeConfig(
        'a6/tsconfig.base.json',
        JSON.stringify({
          compilerOptions: {
            paths: { '@shared/*': ['./packages/shared/*'] },
          },
        }),
      ),
      makeConfig(
        'a6/apps/web/tsconfig.json',
        JSON.stringify({
          extends: '../../tsconfig.base.json',
        }),
      ),
      // A7: child defines paths while inheriting parent baseUrl -> BOTH bare and ./ targets anchor to parent baseUrl
      makeConfig(
        'a7/tsconfig.base.json',
        JSON.stringify({
          compilerOptions: { baseUrl: './src' },
        }),
      ),
      makeConfig(
        'a7/apps/web/tsconfig.json',
        JSON.stringify({
          extends: '../../tsconfig.base.json',
          compilerOptions: {
            paths: {
              '@bare/*': ['bare/*'],
              '@rel/*': ['./rel/*'],
            },
          },
        }),
      ),
      // A8: relative paths declared in a sibling configs/ directory without baseUrl
      makeConfig(
        'a8/configs/tsconfig.base.json',
        JSON.stringify({
          compilerOptions: {
            paths: { '@lib/*': ['../lib/*'] },
          },
        }),
      ),
      makeConfig(
        'a8/apps/web/tsconfig.json',
        JSON.stringify({
          extends: '../../configs/tsconfig.base.json',
        }),
      ),
    ];

    const result = loadWorkspaceTsConfigs(configs);
    expect(result.warnings).toEqual([]);

    const a5 = result.configsByDir.get('a5/apps/web');
    expect(a5?.baseUrl).toBe('/repo/a5/apps/web/alt');
    expect(a5?.pathsDeclarationDir).toBe('a5');
    expect(a5?.paths).toEqual({ '@p/*': ['/repo/a5/apps/web/alt/p/*'] });

    const a6 = result.configsByDir.get('a6/apps/web');
    expect(a6?.baseUrl).toBeUndefined();
    expect(a6?.pathsDeclarationDir).toBe('a6');
    expect(a6?.paths).toEqual({ '@shared/*': ['/repo/a6/packages/shared/*'] });

    const a7 = result.configsByDir.get('a7/apps/web');
    expect(a7?.baseUrl).toBe('/repo/a7/src');
    expect(a7?.pathsDeclarationDir).toBe('a7/apps/web');
    expect(a7?.paths).toEqual({
      '@bare/*': ['/repo/a7/src/bare/*'],
      '@rel/*': ['/repo/a7/src/rel/*'],
    });

    const a8 = result.configsByDir.get('a8/apps/web');
    expect(a8?.baseUrl).toBeUndefined();
    expect(a8?.pathsDeclarationDir).toBe('a8/configs');
    expect(a8?.paths).toEqual({ '@lib/*': ['/repo/a8/lib/*'] });
  });

  it('A9 & order preservation: supports diamond inheritance, preserves alias declaration order, and enforces maxExtendsDepth without cache bypass', () => {
    const configs = [
      makeConfig(
        'tsconfig.root.json',
        JSON.stringify({
          compilerOptions: {
            paths: {
              '@z/*': ['./z/*'],
              '@a/*': ['./a/*', './a-fallback/*'],
            },
          },
        }),
      ),
      makeConfig(
        'tsconfig.left.json',
        JSON.stringify({
          extends: './tsconfig.root.json',
          compilerOptions: { strict: true },
        }),
      ),
      makeConfig(
        'tsconfig.right.json',
        JSON.stringify({
          extends: './tsconfig.root.json',
          compilerOptions: { noEmit: true },
        }),
      ),
      makeConfig(
        'tsconfig.json',
        JSON.stringify({
          extends: ['./tsconfig.left.json', './tsconfig.right.json'],
        }),
      ),
    ];

    const result = loadWorkspaceTsConfigs(configs);
    expect(result.warnings).toEqual([]);

    const root = result.configsByPath.get('tsconfig.json');
    // Key declaration order preserved (@z/* BEFORE @a/*, NOT sorted alphabetically)
    expect(Object.keys(root?.paths ?? {})).toEqual(['@z/*', '@a/*']);
    expect(root?.paths).toEqual({
      '@z/*': ['/repo/z/*'],
      '@a/*': ['/repo/a/*', '/repo/a-fallback/*'],
    });

    // Enforce maxExtendsDepth=1: left (depth 0->1) succeeds, while tsconfig (depth 0->1->2) exceeds maxExtendsDepth
    const depthLimited = loadWorkspaceTsConfigs(configs, { maxExtendsDepth: 1 });
    expect(depthLimited.warnings.some((w) => w.code === 'TSCONFIG_EXTENDS_DEPTH_EXCEEDED')).toBe(
      true,
    );
    expect(depthLimited.configsByPath.get('tsconfig.left.json')?.paths).toEqual({
      '@z/*': ['/repo/z/*'],
      '@a/*': ['/repo/a/*', '/repo/a-fallback/*'],
    });
    expect(depthLimited.configsByPath.get('tsconfig.json')?.paths).toBeUndefined();
  });

  it('detects circular extends, rejects prototype-pollution keys and workspace escapes, ignores external extends, and survives malformed configs', () => {
    const configs = [
      makeConfig('tsconfig.cycle-a.json', JSON.stringify({ extends: './tsconfig.cycle-b.json' })),
      makeConfig('tsconfig.cycle-b.json', JSON.stringify({ extends: './tsconfig.cycle-a.json' })),
      makeConfig(
        'apps/escape/tsconfig.json',
        `{
          "extends": ["@tsconfig/next/tsconfig.json", "../../../../outside.json"],
          "compilerOptions": {
            "baseUrl": "../../../../etc",
            "paths": {
              "__proto__": ["./evil/*"],
              "@bad/*": ["../../../../secret/*", "/etc/passwd"],
              "@good/*": ["./src/*"]
            }
          }
        }`,
      ),
      makeConfig(
        'apps/malformed/tsconfig.json',
        JSON.stringify({
          extends: 123,
          compilerOptions: {
            baseUrl: 456,
            paths: {
              '@broken/*': 'not-an-array',
            },
          },
        }),
      ),
      makeConfig('apps/broken-json/tsconfig.json', '{ invalid jsonc'),
    ];

    const result = loadWorkspaceTsConfigs(configs);
    const codes = result.warnings.map((w) => w.code);

    expect(codes).toContain('TSCONFIG_CIRCULAR_EXTENDS');
    expect(codes).toContain('TSCONFIG_TRAVERSAL_IGNORED');
    expect(codes).toContain('INVALID_TSCONFIG');

    const escapeCfg = result.configsByDir.get('apps/escape');
    expect(escapeCfg?.baseUrl).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(escapeCfg?.paths ?? {}, '__proto__')).toBe(false);
    expect(escapeCfg?.paths).toEqual({
      '@bad/*': [],
      '@good/*': ['/repo/apps/escape/src/*'],
    });
  });
});
