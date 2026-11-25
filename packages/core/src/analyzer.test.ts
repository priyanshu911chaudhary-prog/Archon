import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS, type AnalysisOutput } from './types.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.js';

async function createTempWorkspace(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-core-fixture-'));
  for (const [relPosixPath, content] of Object.entries(files)) {
    const absPath = path.join(dir, ...relPosixPath.split('/'));
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, content, 'utf8');
  }
  return dir;
}

function assertGraphIntegrity(
  output: AnalysisOutput,
  rootDir: string,
  maxCallSiteSnippetChars = DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
): void {
  const nodeMap = new Map(output.nodes.map((n) => [n.qualifiedName, n]));
  // Unique qualified names
  expect(nodeMap.size).toBe(output.nodes.length);

  // Every parentQualifiedName exists
  for (const node of output.nodes) {
    if (node.parentQualifiedName !== null) {
      expect(
        nodeMap.has(node.parentQualifiedName),
        `Missing parent ${node.parentQualifiedName} for ${node.qualifiedName}`,
      ).toBe(true);
    }
    expect(node.filePath).not.toContain('\\');
    expect(node.filePath).not.toContain(rootDir);
    expect(node.qualifiedName).not.toContain(rootDir);
  }

  let importsCount = 0;
  let callsCount = 0;
  const seenEdgeKeys = new Set<string>();

  // Every emitted edge references two existing nodes with valid edge-type metadata
  for (const edge of output.edges) {
    expect(
      nodeMap.has(edge.sourceQualifiedName),
      `Missing source ${edge.sourceQualifiedName}`,
    ).toBe(true);
    expect(
      nodeMap.has(edge.targetQualifiedName),
      `Missing target ${edge.targetQualifiedName}`,
    ).toBe(true);

    if (edge.edgeType === 'IMPORTS') {
      importsCount += 1;
      expect(edge.sourceQualifiedName).not.toBe(edge.targetQualifiedName);
      expect(edge.callSiteLine).toBeNull();
      expect(edge.callSiteSnippet).toBeNull();
      const key = `${edge.sourceQualifiedName}\0${edge.targetQualifiedName}\0IMPORTS`;
      expect(seenEdgeKeys.has(key), `Duplicate IMPORTS edge ${key}`).toBe(false);
      seenEdgeKeys.add(key);
    } else {
      callsCount += 1;
      expect(edge.callSiteLine).not.toBeNull();
      if (edge.callSiteLine !== null) {
        expect(Number.isInteger(edge.callSiteLine)).toBe(true);
        expect(edge.callSiteLine).toBeGreaterThanOrEqual(1);
      }
      expect(edge.callSiteSnippet).not.toBeNull();
      if (edge.callSiteSnippet !== null) {
        expect(edge.callSiteSnippet.length).toBeLessThanOrEqual(maxCallSiteSnippetChars);
        expect(edge.callSiteSnippet).not.toContain('\r');
      }
      const key = `${edge.sourceQualifiedName}\0${edge.targetQualifiedName}\0CALLS\0${edge.callSiteLine}`;
      expect(seenEdgeKeys.has(key), `Duplicate CALLS edge ${key}`).toBe(false);
      seenEdgeKeys.add(key);
    }
  }

  expect(output.stats.importsEdgeCount).toBe(importsCount);
  expect(output.stats.callsEdgeCount).toBe(callsCount);

  // No host temp paths leaked in warnings
  for (const warning of output.warnings) {
    expect(warning.filePath).not.toContain(rootDir);
    expect(warning.message).not.toContain(rootDir);
  }
}

describe('analyzeRepository (Step 4.2a static analysis foundation)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function makeFixture(files: Readonly<Record<string, string>>): Promise<string> {
    const dir = await createTempWorkspace(files);
    tempDirs.push(dir);
    return dir;
  }

  it('extracts deterministic nodes, folder hierarchy, classes/accessors/overloads, local export lists, default & CJS exports, and avoids arrow duplicates', async () => {
    const rootDir = await makeFixture({
      'src/lib/billing.ts': [
        'export function parse(v: string): number;',
        'export function parse(v: number): string;',
        'export function parse(v: string | number): string | number {',
        '  return v;',
        '}',
        '',
        'export const calculate = (x: number) => {',
        '  const items = [1, 2].map((n) => n * x);',
        '  return items.reduce((a, b) => a + b, 0);',
        '};',
        '',
        'function internalExported() {',
        '  return 1;',
        '}',
        'export { internalExported };',
        '',
        'export const TAX_RATE = 0.18;',
        'const privateConst = 99;',
      ].join('\n'),
      'src/auth/service.ts': [
        'export class AuthService {',
        '  constructor(secret: string);',
        '  constructor(secret: string, ttl?: number) {',
        '    void secret;',
        '    void ttl;',
        '  }',
        '  verify(token: string): boolean;',
        '  verify(token: string, strict?: boolean): boolean {',
        '    return Boolean(token && strict);',
        '  }',
        '  static verify(raw: string): boolean {',
        '    return raw.length > 0;',
        '  }',
        '  get status(): string {',
        '    return "ok";',
        '  }',
        '  set status(_v: string) {}',
        '  static get status(): string {',
        '    return "static-ok";',
        '  }',
        '  static set status(_v: string) {}',
        '}',
      ].join('\n'),
      'src/page.tsx': 'export default () => <div>Hello</div>;\n',
      'src/named-default.ts': 'export default function NamedPage() { return true; }\n',
      'src/cjs-mod.cjs': [
        'function helper() { return 1; }',
        'exports.helper = helper;',
        'exports.inlineFn = () => 2;',
        'exports.VERSION = "1.0.0";',
      ].join('\n'),
      'src/same-line.ts':
        'export function dup() { return 1; } export function dup() { return 2; }\n',
    });

    const run1 = await analyzeRepository({ rootDir });
    const run2 = await analyzeRepository({ rootDir });

    expect(run1).toEqual(run2);
    assertGraphIntegrity(run1, rootDir);

    const byQn = new Map(run1.nodes.map((n) => [n.qualifiedName, n]));

    // Folder hierarchy & parent integrity
    expect(byQn.get('folder:src')?.parentQualifiedName).toBeNull();
    expect(byQn.get('folder:src/lib')?.parentQualifiedName).toBe('folder:src');
    expect(byQn.get('file:src/lib/billing.ts')?.parentQualifiedName).toBe('folder:src/lib');

    // Overload collapse -> single implementation node starting at line 3
    const parseNode = byQn.get('src/lib/billing.ts::fn:parse');
    expect(parseNode?.nodeType).toBe('function');
    expect(parseNode?.isExported).toBe(true);
    expect(parseNode?.startLine).toBe(3);
    expect(parseNode?.endLine).toBe(5);

    // Arrow function exported -> ONLY 'function' node, no duplicate 'symbol', no nested callback nodes
    expect(byQn.get('src/lib/billing.ts::fn:calculate')?.nodeType).toBe('function');
    expect(byQn.get('src/lib/billing.ts::fn:calculate')?.isExported).toBe(true);
    expect(byQn.has('src/lib/billing.ts::sym:calculate')).toBe(false);

    // Local export list marks declaration exported
    expect(byQn.get('src/lib/billing.ts::fn:internalExported')?.isExported).toBe(true);

    // Exported value symbol present; private non-function const omitted
    expect(byQn.get('src/lib/billing.ts::sym:TAX_RATE')?.nodeType).toBe('symbol');
    expect(byQn.has('src/lib/billing.ts::sym:privateConst')).toBe(false);

    // Class constructor, static vs instance methods & static vs instance getters/setters all distinct
    expect(byQn.get('src/auth/service.ts::class:AuthService::ctor')?.startLine).toBe(3);
    expect(byQn.get('src/auth/service.ts::class:AuthService::method:verify')?.startLine).toBe(8);
    expect(byQn.get('src/auth/service.ts::class:AuthService::static:verify')?.startLine).toBe(11);
    expect(byQn.has('src/auth/service.ts::class:AuthService::get:status')).toBe(true);
    expect(byQn.has('src/auth/service.ts::class:AuthService::set:status')).toBe(true);
    expect(byQn.has('src/auth/service.ts::class:AuthService::static:get:status')).toBe(true);
    expect(byQn.has('src/auth/service.ts::class:AuthService::static:set:status')).toBe(true);

    // Anonymous & named default exports
    expect(byQn.get('src/page.tsx::default')?.nodeType).toBe('function');
    expect(byQn.get('src/page.tsx::default')?.isExported).toBe(true);
    expect(byQn.get('src/named-default.ts::fn:NamedPage')?.isExported).toBe(true);

    // Static CommonJS exports
    expect(byQn.get('src/cjs-mod.cjs::fn:helper')?.isExported).toBe(true);
    expect(byQn.get('src/cjs-mod.cjs::fn:inlineFn')?.isExported).toBe(true);
    expect(byQn.get('src/cjs-mod.cjs::sym:VERSION')?.isExported).toBe(true);

    // Same-line collision disambiguated with line:col
    const sameLineFns = run1.nodes.filter(
      (n) => n.filePath === 'src/same-line.ts' && n.nodeType === 'function',
    );
    expect(sameLineFns).toHaveLength(2);
    expect(sameLineFns.map((n) => n.qualifiedName)).toEqual([
      'src/same-line.ts::fn:dup',
      'src/same-line.ts::fn:dup@L1:C37',
    ]);
  });

  it('resolves relative imports, .js->.ts substitution, extension precedence, index precedence, barrels, circular barrels, and deduplicates edges', async () => {
    const rootDir = await makeFixture({
      'src/entry.ts': [
        "import { a } from './dual';",
        "import { b } from './dual.js';",
        "import './side-effect';",
        "import type { Foo } from './types';",
        "import * as barrel from './barrel';",
        "import { c } from './barrel/index';",
        "import React from 'react';",
        "import fs from 'node:fs';",
        "import missing from './does-not-exist';",
        'void a; void b; void barrel; void c; void React; void fs; void missing;',
      ].join('\n'),
      // Both .ts and .js exist -> TypeScript precedence picks .ts (not ambiguous error)
      'src/dual.ts': 'export const a = 1; export const b = 2;\n',
      'src/dual.js': 'export const a = 999;\n',
      'src/side-effect.ts': 'export const side = true;\n',
      'src/types.ts': 'export type Foo = string;\n',
      // Barrel & circular barrel
      'src/barrel/index.ts': ["export { c } from './impl';", "export * from './cycle-a';"].join(
        '\n',
      ),
      'src/barrel/impl.ts': 'export const c = 3;\n',
      'src/barrel/cycle-a.ts': "export { y } from './cycle-b'; export const x = 1;\n",
      'src/barrel/cycle-b.ts': "export { x } from './cycle-a'; export const y = 2;\n",
    });

    const output = await analyzeRepository({ rootDir });
    assertGraphIntegrity(output, rootDir);
    expect(output.warnings).toEqual([]);

    const edgePairs = output.edges.map(
      (e) => `${e.sourceQualifiedName} -> ${e.targetQualifiedName}`,
    );
    expect(edgePairs).toEqual([
      'file:src/barrel/cycle-a.ts -> file:src/barrel/cycle-b.ts',
      'file:src/barrel/cycle-b.ts -> file:src/barrel/cycle-a.ts',
      'file:src/barrel/index.ts -> file:src/barrel/cycle-a.ts',
      'file:src/barrel/index.ts -> file:src/barrel/impl.ts',
      'file:src/entry.ts -> file:src/barrel/index.ts',
      'file:src/entry.ts -> file:src/dual.ts',
      'file:src/entry.ts -> file:src/side-effect.ts',
      'file:src/entry.ts -> file:src/types.ts',
    ]);
  });

  it('resolves overlapping tsconfig path aliases (exact > longest wildcard > fallback target order) and nested configs', async () => {
    const rootDir = await makeFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@/*': ['./src/primary/*', './src/fallback/*'],
            '@/special/*': ['./src/special-override/*'],
            '@exact': ['./src/exact-target.ts'],
          },
        },
      }),
      'src/app.ts': [
        "import { e } from '@exact';",
        "import { s } from '@/special/item';",
        "import { p } from '@/only-primary';",
        "import { f } from '@/only-fallback';",
        'void e; void s; void p; void f;',
      ].join('\n'),
      'src/exact-target.ts': 'export const e = 1;\n',
      'src/special-override/item.ts': 'export const s = 2;\n',
      'src/primary/special/item.ts': 'export const s = 999;\n',
      'src/primary/only-primary.ts': 'export const p = 3;\n',
      'src/fallback/only-fallback.ts': 'export const f = 4;\n',
    });

    const output = await analyzeRepository({ rootDir });
    assertGraphIntegrity(output, rootDir);

    const appTargets = output.edges
      .filter((e) => e.sourceQualifiedName === 'file:src/app.ts')
      .map((e) => e.targetQualifiedName);

    expect(appTargets).toEqual([
      'file:src/exact-target.ts',
      'file:src/fallback/only-fallback.ts',
      'file:src/primary/only-primary.ts',
      'file:src/special-override/item.ts',
    ]);
  });

  it('extracts literal CommonJS require() imports while ignoring dynamic, external, and shadowed require()', async () => {
    const rootDir = await makeFixture({
      'src/cjs-caller.cjs': [
        "const a = require('./target-a.cjs');",
        'const b = require(`./target-b`);',
        "const ext = require('lodash');",
        "const builtin = require('node:path');",
        "const dynName = './target-c.cjs';",
        'const dyn = require(dynName);',
        'function shadowedParam(require) {',
        "  return require('./target-c.cjs');",
        '}',
        'function shadowedLocal() {',
        '  const require = (x) => x;',
        "  return require('./target-c.cjs');",
        '}',
        'module.exports = { a, b, ext, builtin, dyn, shadowedParam, shadowedLocal };',
      ].join('\n'),
      'src/target-a.cjs': 'module.exports = 1;\n',
      'src/target-b.js': 'module.exports = 2;\n',
      'src/target-c.cjs': 'module.exports = 3;\n',
    });

    const output = await analyzeRepository({ rootDir });
    assertGraphIntegrity(output, rootDir);

    const targets = output.edges
      .filter((e) => e.sourceQualifiedName === 'file:src/cjs-caller.cjs')
      .map((e) => e.targetQualifiedName);

    expect(targets).toEqual(['file:src/target-a.cjs', 'file:src/target-b.js']);
  });

  it('does not resolve extensionless require() to .cjs files', async () => {
    const rootDir = await makeFixture({
      'src/caller.cjs': [
        "const missing = require('./target-a');",
        'module.exports = { missing };',
      ].join('\n'),
      'src/target-a.cjs': 'module.exports = 1;\n',
    });

    const output = await analyzeRepository({ rootDir });
    assertGraphIntegrity(output, rootDir);

    const targets = output.edges
      .filter((e) => e.sourceQualifiedName === 'file:src/caller.cjs')
      .map((e) => e.targetQualifiedName);

    expect(targets).toEqual([]);
  });

  it('skips files with syntax errors gracefully without failing valid files (even when node_modules is missing) and enforces snippet bounds', async () => {
    const longBody = `export function big() {\n${'  const x = 1;\n'.repeat(40)}  return 42;\n}\n`;
    const rootDir = await makeFixture({
      'src/valid.ts': [
        "import { something } from 'uninstalled-external-package';",
        "import { broken } from './broken';",
        'export const ok = something ?? broken;',
      ].join('\n'),
      'src/long.ts': longBody,
      // Intentionally malformed TypeScript written only inside temp dir
      'src/broken.ts': 'export function oops( { return ;;;\n',
    });

    const output = await analyzeRepository({
      rootDir,
      maxFileSnippetChars: 80,
      maxSymbolSnippetChars: 60,
    });
    assertGraphIntegrity(output, rootDir);

    expect(output.stats.discoveredFilesCount).toBe(3);
    expect(output.stats.parsedFilesCount).toBe(2);
    expect(output.stats.skippedSyntaxErrorFilesCount).toBe(1);
    expect(
      output.warnings.some((w) => w.code === 'SYNTAX_ERROR' && w.filePath === 'src/broken.ts'),
    ).toBe(true);

    // Broken file has no node and no incoming edge from valid.ts
    expect(output.nodes.some((n) => n.filePath === 'src/broken.ts')).toBe(false);
    expect(output.edges).toEqual([]);

    // Valid file with missing external dep was NOT discarded
    expect(output.nodes.some((n) => n.qualifiedName === 'file:src/valid.ts')).toBe(true);

    // Line numbers reflect full original source BEFORE snippet truncation
    const longFile = output.nodes.find((n) => n.qualifiedName === 'file:src/long.ts');
    const bigFn = output.nodes.find((n) => n.qualifiedName === 'src/long.ts::fn:big');
    expect(longFile?.snippet?.length).toBeLessThanOrEqual(80);
    expect(longFile?.endLine).toBeGreaterThan(40);
    expect(bigFn?.snippet?.length).toBeLessThanOrEqual(60);
    expect(bigFn?.startLine).toBe(1);
    expect(bigFn?.endLine).toBe(43);
  });
  it('applies verified TS 6.0.2 tsconfig inheritance end-to-end (replace, empty {}, omit, extends array, baseUrl re-anchoring, declaring dir, diamond)', async () => {
    const rootDir = await makeFixture({
      // Shared base with aliases
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@a/*': ['./shared-a/*'],
            '@b/*': ['./shared-b/*'],
          },
        },
      }),
      'shared-a/one.ts': 'export const one = 1;\n',
      'shared-b/two.ts': 'export const two = 2;\n',

      // A1: child replaces parent paths completely
      'apps/replace/tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { paths: { '@c/*': ['./c/*'] } },
      }),
      'apps/replace/c/three.ts': 'export const three = 3;\n',
      'apps/replace/src/entry.ts': [
        "import { one } from '@a/one';",
        "import { three } from '@c/three';",
        'void one; void three;',
      ].join('\n'),

      // A2: empty paths: {} clears inherited aliases
      'apps/empty/tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { paths: {} },
      }),
      'apps/empty/src/entry.ts': "import { one } from '@a/one'; void one;\n",

      // A3: omitted paths inherits parent aliases
      'apps/omit/tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { strict: true },
      }),
      'apps/omit/src/entry.ts': "import { one } from '@a/one'; void one;\n",

      // A4: extends array (later parent replaces earlier parent paths)
      'ext/tsconfig.p1.json': JSON.stringify({
        compilerOptions: { paths: { '@p1/*': ['./p1/*'], '@shared/*': ['./from-p1/*'] } },
      }),
      'ext/tsconfig.p2.json': JSON.stringify({
        compilerOptions: { paths: { '@p2/*': ['./p2/*'], '@shared/*': ['./from-p2/*'] } },
      }),
      'ext/p1/x.ts': 'export const x = 1;\n',
      'ext/p2/y.ts': 'export const y = 2;\n',
      'ext/from-p1/s.ts': 'export const s = 1;\n',
      'ext/from-p2/s.ts': 'export const s = 2;\n',
      'ext/app/tsconfig.json': JSON.stringify({
        extends: ['../tsconfig.p1.json', '../tsconfig.p2.json'],
      }),
      'ext/app/entry.ts': [
        "import { x } from '@p1/x';",
        "import { y } from '@p2/y';",
        "import { s } from '@shared/s';",
        'void x; void y; void s;',
      ].join('\n'),

      // A5: child overrides baseUrl -> re-anchors inherited parent paths
      'a5/tsconfig.base.json': JSON.stringify({
        compilerOptions: { baseUrl: './src', paths: { '@p/*': ['p/*'] } },
      }),
      'a5/src/p/mod.ts': 'export const mod = 1;\n',
      'a5/apps/web/tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { baseUrl: './alt' },
      }),
      'a5/apps/web/alt/p/mod.ts': 'export const mod = 2;\n',
      'a5/apps/web/entry.ts': "import { mod } from '@p/mod'; void mod;\n",

      // A7: child defines paths while inheriting parent baseUrl
      'a7/tsconfig.base.json': JSON.stringify({
        compilerOptions: { baseUrl: './src' },
      }),
      'a7/src/bare/x.ts': 'export const x = 1;\n',
      'a7/src/rel/y.ts': 'export const y = 2;\n',
      'a7/apps/web/bare/x.ts': 'export const x = 99;\n',
      'a7/apps/web/rel/y.ts': 'export const y = 99;\n',
      'a7/apps/web/tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { paths: { '@bare/*': ['bare/*'], '@rel/*': ['./rel/*'] } },
      }),
      'a7/apps/web/entry.ts': [
        "import { x } from '@bare/x';",
        "import { y } from '@rel/y';",
        'void x; void y;',
      ].join('\n'),

      // A8: sibling configs directory without baseUrl preserves declaring directory
      'a8/configs/tsconfig.base.json': JSON.stringify({
        compilerOptions: { paths: { '@lib/*': ['../lib/*'] } },
      }),
      'a8/lib/core.ts': 'export const core = 1;\n',
      'a8/apps/lib/core.ts': 'export const core = 99;\n',
      'a8/apps/web/tsconfig.json': JSON.stringify({
        extends: '../../configs/tsconfig.base.json',
      }),
      'a8/apps/web/entry.ts': "import { core } from '@lib/core'; void core;\n",

      // A9: diamond inheritance without cycle warning
      'a9/tsconfig.root.json': JSON.stringify({
        compilerOptions: { paths: { '@root/*': ['./root/*'] } },
      }),
      'a9/tsconfig.left.json': JSON.stringify({ extends: './tsconfig.root.json' }),
      'a9/tsconfig.right.json': JSON.stringify({ extends: './tsconfig.root.json' }),
      'a9/tsconfig.json': JSON.stringify({
        extends: ['./tsconfig.left.json', './tsconfig.right.json'],
      }),
      'a9/root/item.ts': 'export const item = 1;\n',
      'a9/entry.ts': "import { item } from '@root/item'; void item;\n",
    });

    const output = await analyzeRepository({ rootDir });
    assertGraphIntegrity(output, rootDir);
    expect(output.warnings).toEqual([]);

    // Confirm negative-test targets were genuinely discovered and parsed
    const nodeQns = new Set(output.nodes.map((n) => n.qualifiedName));
    expect(nodeQns.has('file:shared-a/one.ts')).toBe(true);
    expect(nodeQns.has('file:ext/p1/x.ts')).toBe(true);
    expect(nodeQns.has('file:ext/from-p1/s.ts')).toBe(true);
    expect(nodeQns.has('file:a5/src/p/mod.ts')).toBe(true);
    expect(nodeQns.has('file:a7/apps/web/rel/y.ts')).toBe(true);
    expect(nodeQns.has('file:a8/apps/lib/core.ts')).toBe(true);

    const targetsOf = (relFile: string): string[] =>
      output.edges
        .filter((e) => e.sourceQualifiedName === `file:${relFile}`)
        .map((e) => e.targetQualifiedName);

    expect(targetsOf('apps/replace/src/entry.ts')).toEqual(['file:apps/replace/c/three.ts']);
    expect(targetsOf('apps/empty/src/entry.ts')).toEqual([]);
    expect(targetsOf('apps/omit/src/entry.ts')).toEqual(['file:shared-a/one.ts']);
    expect(targetsOf('ext/app/entry.ts')).toEqual(['file:ext/from-p2/s.ts', 'file:ext/p2/y.ts']);
    expect(targetsOf('a5/apps/web/entry.ts')).toEqual(['file:a5/apps/web/alt/p/mod.ts']);
    expect(targetsOf('a7/apps/web/entry.ts')).toEqual([
      'file:a7/src/bare/x.ts',
      'file:a7/src/rel/y.ts',
    ]);
    expect(targetsOf('a8/apps/web/entry.ts')).toEqual(['file:a8/lib/core.ts']);
    expect(targetsOf('a9/entry.ts')).toEqual(['file:a9/root/item.ts']);
  });

  it('matches TS 6.0.2 alias precedence without cross-pattern fallback (D1-D6, D8: exact, wildcard, equal-prefix declaration order, multi-target, .js->.ts)', async () => {
    const rootDirOrderA = await makeFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: {
            // D2: exact alias target missing while @* wildcard target exists -> must NOT fall back
            '@missing-exact': ['./src/does-not-exist.ts'],
            '@*': ['./src/wild/*.ts'],
            // D4: most-specific wildcard missing while @/* target exists -> must NOT fall back
            '@/special/*': ['./src/missing-special/*'],
            // D5 order A: shorter suffix declared BEFORE longer suffix
            '@/*': ['./src/no-suffix/*', './src/fallback/*'],
            '@/*.svc': ['./src/with-suffix/*'],
          },
        },
      }),
      'src/wild/missing-exact.ts': 'export const w = 1;\n',
      'src/wild/ok.ts': 'export const ok = 2;\n',
      'src/no-suffix/special/item.ts': 'export const s = 3;\n',
      'src/no-suffix/auth.svc.ts': 'export const a = 4;\n',
      'src/with-suffix/auth.ts': 'export const a = 5;\n',
      'src/fallback/second.ts': 'export const sec = 6;\n',
      'src/no-suffix/util.ts': 'export const u = 7;\n',
      'src/app.ts': [
        "import { w } from '@missing-exact';",
        "import { ok } from '@ok';",
        "import { s } from '@/special/item';",
        "import { a } from '@/auth.svc';",
        "import { sec } from '@/second';",
        "import { u } from '@/util.js';",
        'void w; void ok; void s; void a; void sec; void u;',
      ].join('\n'),
    });

    const outA = await analyzeRepository({ rootDir: rootDirOrderA });
    assertGraphIntegrity(outA, rootDirOrderA);

    const nodesA = new Set(outA.nodes.map((n) => n.qualifiedName));
    expect(nodesA.has('file:src/wild/missing-exact.ts')).toBe(true);
    expect(nodesA.has('file:src/no-suffix/special/item.ts')).toBe(true);
    expect(nodesA.has('file:src/with-suffix/auth.ts')).toBe(true);

    expect(
      outA.edges
        .filter((e) => e.sourceQualifiedName === 'file:src/app.ts')
        .map((e) => e.targetQualifiedName),
    ).toEqual([
      'file:src/fallback/second.ts',
      'file:src/no-suffix/auth.svc.ts',
      'file:src/no-suffix/util.ts',
      'file:src/wild/ok.ts',
    ]);

    // D5 order B: flip ONLY the equal-prefix declaration order (@/*.svc BEFORE @/*)
    const rootDirOrderB = await makeFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@/*.svc': ['./src/with-suffix/*'],
            '@/*': ['./src/no-suffix/*'],
          },
        },
      }),
      'src/no-suffix/auth.svc.ts': 'export const a = 4;\n',
      'src/with-suffix/auth.ts': 'export const a = 5;\n',
      'src/app.ts': "import { a } from '@/auth.svc'; void a;\n",
    });

    const outB = await analyzeRepository({ rootDir: rootDirOrderB });
    assertGraphIntegrity(outB, rootDirOrderB);
    expect(outB.nodes.some((n) => n.qualifiedName === 'file:src/no-suffix/auth.svc.ts')).toBe(true);
    expect(
      outB.edges
        .filter((e) => e.sourceQualifiedName === 'file:src/app.ts')
        .map((e) => e.targetQualifiedName),
    ).toEqual(['file:src/with-suffix/auth.ts']);
  });

  it('matches TS 6.0.2 baseUrl semantics (baseUrl-only, unmatched alias + baseUrl, and no fallback on matched-but-failed alias)', async () => {
    const rootDir = await makeFixture({
      'only-baseurl/tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: './src' },
      }),
      'only-baseurl/src/lib/foo.ts': 'export const foo = 1;\n',
      'only-baseurl/src/app.ts': "import { foo } from 'lib/foo'; void foo;\n",

      'with-paths/tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: './src',
          paths: {
            '@a/*': ['./a/*'],
            'lib/*': ['./missing/*'],
          },
        },
      }),
      'with-paths/src/a/hit.ts': 'export const hit = 1;\n',
      'with-paths/src/lib/foo.ts': 'export const foo = 2;\n',
      'with-paths/src/other/bar.ts': 'export const bar = 3;\n',
      'with-paths/src/app.ts': [
        "import { hit } from '@a/hit';",
        "import { bar } from 'other/bar';",
        "import { foo } from 'lib/foo';",
        'void hit; void bar; void foo;',
      ].join('\n'),
    });

    const output = await analyzeRepository({ rootDir });
    assertGraphIntegrity(output, rootDir);
    expect(output.warnings).toEqual([]);

    // Confirm matched-but-failed target exists and was parsed
    expect(output.nodes.some((n) => n.qualifiedName === 'file:with-paths/src/lib/foo.ts')).toBe(
      true,
    );

    const targetsOf = (relFile: string): string[] =>
      output.edges
        .filter((e) => e.sourceQualifiedName === `file:${relFile}`)
        .map((e) => e.targetQualifiedName);

    expect(targetsOf('only-baseurl/src/app.ts')).toEqual(['file:only-baseurl/src/lib/foo.ts']);
    expect(targetsOf('with-paths/src/app.ts')).toEqual([
      'file:with-paths/src/a/hit.ts',
      'file:with-paths/src/other/bar.ts',
    ]);
  });

  it('rejects escaping alias targets, traversal-after-wildcard targets, wildcard specifier escapes, and unsafe raw specifiers', async () => {
    const rootDir = await makeFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@escape/*': ['../../outside/*'],
            '@ambig/*': ['./src/*/../other/*'],
            '@lib/*': ['./src/lib/*'],
          },
        },
      }),
      'src/lib/core.ts': 'export const core = 1;\n',
      'src/other/item.ts': 'export const item = 2;\n',
      'src/app.ts': [
        "import { s1 } from '@escape/secret';",
        "import { s2 } from '@ambig/item';",
        "import { s3 } from '@lib/../../../outside/secret';",
        "import { s4 } from '/etc/passwd';",
        "import { s5 } from 'C:\\\\windows\\\\win.ts';",
        "import { core } from '@lib/core';",
        'void s1; void s2; void s3; void s4; void s5; void core;',
      ].join('\n'),
    });

    const output = await analyzeRepository({ rootDir });
    assertGraphIntegrity(output, rootDir);

    const warningCodes = output.warnings.map((w) => w.code);
    expect(warningCodes).toContain('TSCONFIG_TRAVERSAL_IGNORED');
    expect(warningCodes).toContain('INVALID_TSCONFIG');
    expect(output.nodes.some((n) => n.qualifiedName === 'file:src/other/item.ts')).toBe(true);

    expect(
      output.edges
        .filter((e) => e.sourceQualifiedName === 'file:src/app.ts')
        .map((e) => e.targetQualifiedName),
    ).toEqual(['file:src/lib/core.ts']);
  });
  it('parses UTF-16LE BOM, UTF-16BE BOM, and UTF-8 BOM modules end-to-end with incoming IMPORTS, CALLS, accurate line numbers, and raw-byte stats', async () => {
    const rootDir = await makeFixture({});
    const utf16LeSource = [
      'export type RecordRow = {',
      '  id: string;',
      '};',
      'export function formatRow(row: RecordRow): string {',
      '  return row.id;',
      '}',
    ].join('\r\n');
    const utf16LeBytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`${utf16LeSource}\r\n`, 'utf16le'),
    ]);

    const utf16BeSource = [
      'export function tagLabel(value: string): string {',
      '  return `[${value}]`;',
      '}',
    ].join('\n');
    const utf16BePayload = Buffer.from(`${utf16BeSource}\n`, 'utf16le');
    utf16BePayload.swap16();
    const utf16BeBytes = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BePayload]);

    const utf8BomSource = [
      "import { formatRow, type RecordRow } from '@/types_db';",
      "import { tagLabel } from './be-helper';",
      'export function renderRow(row: RecordRow): string {',
      '  const formatted = formatRow(row);',
      '  return tagLabel(formatted);',
      '}',
    ].join('\n');
    const utf8BomBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`${utf8BomSource}\n`, 'utf8'),
    ]);

    const tsconfigBytes = Buffer.from(
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./*'] },
        },
      }),
      'utf8',
    );

    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    await writeFile(path.join(rootDir, 'tsconfig.json'), tsconfigBytes);
    await writeFile(path.join(rootDir, 'types_db.ts'), utf16LeBytes);
    await writeFile(path.join(rootDir, 'src', 'be-helper.ts'), utf16BeBytes);
    await writeFile(path.join(rootDir, 'src', 'consumer.ts'), utf8BomBytes);

    const output = await analyzeRepository({ rootDir, skipLoadingLibFiles: true });
    assertGraphIntegrity(output, rootDir);

    expect(output.warnings).toEqual([]);
    expect(output.stats.discoveredFilesCount).toBe(3);
    expect(output.stats.parsedFilesCount).toBe(3);
    expect(output.stats.skippedSyntaxErrorFilesCount).toBe(0);
    expect(output.stats.totalBytesRead).toBe(
      tsconfigBytes.byteLength +
        utf16LeBytes.byteLength +
        utf16BeBytes.byteLength +
        utf8BomBytes.byteLength,
    );

    // Incoming IMPORTS edges to both UTF-16LE BOM and UTF-16BE BOM modules
    const importEdges = output.edges
      .filter((e) => e.edgeType === 'IMPORTS')
      .map((e) => `${e.sourceQualifiedName} -> ${e.targetQualifiedName}`);
    expect(importEdges).toEqual([
      'file:src/consumer.ts -> file:src/be-helper.ts',
      'file:src/consumer.ts -> file:types_db.ts',
    ]);

    // CALLS edges with exact 1-indexed decoded line numbers and BOM/CR-free snippets
    const callEdges = output.edges.filter((e) => e.edgeType === 'CALLS');
    expect(
      callEdges.map(
        (e) => `${e.sourceQualifiedName} -> ${e.targetQualifiedName} @L${String(e.callSiteLine)}`,
      ),
    ).toEqual([
      'src/consumer.ts::fn:renderRow -> src/be-helper.ts::fn:tagLabel @L5',
      'src/consumer.ts::fn:renderRow -> types_db.ts::fn:formatRow @L4',
    ]);
    for (const edge of callEdges) {
      expect(edge.callSiteSnippet).not.toContain('\r');
      expect(edge.callSiteSnippet).not.toContain('\uFEFF');
    }

    // Decoded line numbers and clean snippets on the UTF-16LE BOM file's extracted nodes
    const formatRowNode = output.nodes.find((n) => n.qualifiedName === 'types_db.ts::fn:formatRow');
    expect(formatRowNode?.startLine).toBe(4);
    expect(formatRowNode?.endLine).toBe(6);
    expect(formatRowNode?.snippet).toContain('export function formatRow');
    expect(formatRowNode?.snippet).not.toContain('\r');
    expect(formatRowNode?.snippet).not.toContain('\uFEFF');
  });
});
