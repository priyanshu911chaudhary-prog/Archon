import { Node, ts, type SourceFile, type TypeChecker } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import type { LoadedWorkspaceFile } from './discovery.js';
import { extractImportEdges } from './imports-extractor.js';
import { createWorkspaceModuleResolver } from './module-resolver.js';
import { createAnalysisProject } from './project.js';
import { loadWorkspaceTsConfigs, type ResolvedTsConfig } from './tsconfig-loader.js';

interface ResolvedInternalDeclaration {
  readonly virtualFilePath: string;
  readonly declarationName: string | undefined;
}

function makeFile(relativePath: string, content: string): LoadedWorkspaceFile {
  return {
    relativePath,
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
  };
}

function getDeclarationName(raw: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(raw) || ts.isClassDeclaration(raw)) {
    return raw.name?.text;
  }

  if (ts.isVariableDeclaration(raw) && ts.isIdentifier(raw.name)) {
    return raw.name.text;
  }

  if (ts.isExportAssignment(raw)) {
    return 'default';
  }

  return undefined;
}

/**
 * Resolves a symbol via `ts-morph` `TypeChecker` (`getSymbolAtLocation` + `getAliasedSymbol`)
 * and returns ONLY defining declarations contained inside the authoritative syntax-clean
 * `/repo/...` file set (filtering out unresolved import bindings, syntax-invalid files,
 * external references, and TypeScript standard-library declarations).
 */
function resolveAuthoritativeInternalTargets(
  checker: TypeChecker,
  node: { readonly compilerNode: ts.Node },
  authoritativePaths: ReadonlySet<string>,
): readonly ResolvedInternalDeclaration[] {
  const compilerChecker = checker.compilerObject;
  const initialSymbol = compilerChecker.getSymbolAtLocation(node.compilerNode);

  if (initialSymbol === undefined) {
    return [];
  }

  const targetSymbol =
    (initialSymbol.flags & ts.SymbolFlags.Alias) !== 0
      ? compilerChecker.getAliasedSymbol(initialSymbol)
      : initialSymbol;

  const matches: ResolvedInternalDeclaration[] = [];

  for (const decl of targetSymbol.getDeclarations() ?? []) {
    const filePath = decl.getSourceFile().fileName;

    if (!authoritativePaths.has(filePath)) {
      continue;
    }

    if (
      ts.isImportSpecifier(decl) ||
      ts.isImportClause(decl) ||
      ts.isNamespaceImport(decl) ||
      ts.isImportEqualsDeclaration(decl) ||
      ts.isExportSpecifier(decl)
    ) {
      continue;
    }

    matches.push({
      virtualFilePath: filePath,
      declarationName: getDeclarationName(decl),
    });
  }

  return matches;
}

function requireSourceFile(
  parsedFiles: readonly { readonly relativePath: string; readonly sourceFile: SourceFile }[],
  relativePath: string,
): SourceFile {
  const entry = parsedFiles.find((item) => item.relativePath === relativePath);
  if (entry === undefined) {
    throw new Error(`Expected parsed source file "${relativePath}"`);
  }
  return entry.sourceFile;
}

function findNamedImportIdentifier(sf: SourceFile, localName: string) {
  for (const importDecl of sf.getImportDeclarations()) {
    for (const named of importDecl.getNamedImports()) {
      const ident = named.getAliasNode() ?? named.getNameNode();

      if (ident.getText() === localName) {
        return ident;
      }
    }
  }

  throw new Error(`Expected named import "${localName}" in ${sf.getFilePath()}`);
}

function findDefaultImportIdentifier(sf: SourceFile, localName: string) {
  for (const importDecl of sf.getImportDeclarations()) {
    const defaultImport = importDecl.getDefaultImport();

    if (defaultImport?.getText() === localName) {
      return defaultImport;
    }
  }

  throw new Error(`Expected default import "${localName}" in ${sf.getFilePath()}`);
}

function findCallSiteIdentifier(sf: SourceFile, calleeName: string) {
  for (const call of sf.getDescendantsOfKind(ts.SyntaxKind.CallExpression)) {
    const expr = call.getExpression();

    if (Node.isIdentifier(expr) && expr.getText() === calleeName) {
      return expr;
    }
  }

  throw new Error(`Expected call-site identifier "${calleeName}" in ${sf.getFilePath()}`);
}

function findFirstIdentifier(sf: SourceFile, name: string) {
  for (const ident of sf.getDescendantsOfKind(ts.SyntaxKind.Identifier)) {
    if (ident.getText() === name) {
      return ident;
    }
  }

  throw new Error(`Expected identifier "${name}" in ${sf.getFilePath()}`);
}

function isMutableStringSet(value: ReadonlySet<string>): value is Set<string> {
  return value instanceof Set;
}

describe('createAnalysisProject and WorkspaceModuleResolver (Item B shared AST resolution)', () => {
  describe('Group 1 — Internal declaration resolution', () => {
    it('resolves relative named imports, path-alias imports, default imports, barrel re-exports, and .js->.ts specifiers at both import and call sites', () => {
      const configs = loadWorkspaceTsConfigs([
        makeFile(
          'tsconfig.json',
          JSON.stringify({
            compilerOptions: {
              paths: {
                '@/*': ['./src/*'],
              },
            },
          }),
        ),
      ]);
      expect(configs.warnings).toEqual([]);

      const sourceFiles: readonly LoadedWorkspaceFile[] = [
        makeFile('src/rel.ts', 'export function relativeHelper(): number { return 1; }\n'),
        makeFile('src/aliased.ts', 'export function aliasedHelper(): number { return 2; }\n'),
        makeFile(
          'src/default-named.ts',
          'export default function createClient(): number { return 3; }\n',
        ),
        makeFile('src/default-anon.ts', 'export default (): number => 4;\n'),
        makeFile('src/barrel/impl.ts', 'export function deepCompute(): number { return 5; }\n'),
        makeFile('src/barrel/index.ts', "export { deepCompute } from './impl';\n"),
        makeFile(
          'src/esm-math.ts',
          'export function addNumbers(a: number, b: number): number { return a + b; }\n',
        ),
        makeFile(
          'src/entry.ts',
          [
            "import { relativeHelper } from './rel';",
            "import { aliasedHelper } from '@/aliased';",
            "import createClient from './default-named';",
            "import runAnon from './default-anon';",
            "import { deepCompute } from './barrel';",
            "import { addNumbers } from './esm-math.js';",
            "import { addNumbers as addAliased } from '@/esm-math.js';",
            'export function main(): number {',
            '  return relativeHelper() + aliasedHelper() + createClient() + runAnon() + deepCompute() + addNumbers(1, 2) + addAliased(3, 4);',
            '}',
          ].join('\n'),
        ),
      ];

      const ctx = createAnalysisProject({
        sourceFiles,
        configsByDir: configs.configsByDir,
        skipLoadingLibFiles: true,
      });

      expect(ctx.syntaxWarnings).toEqual([]);
      const checker = ctx.project.getTypeChecker();
      const entrySf = requireSourceFile(ctx.parsedFiles, 'src/entry.ts');

      // 1. Relative named import (import site + call site)
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findNamedImportIdentifier(entrySf, 'relativeHelper'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/rel.ts', declarationName: 'relativeHelper' }]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(entrySf, 'relativeHelper'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/rel.ts', declarationName: 'relativeHelper' }]);

      // 2. Named path-alias import (import site + call site)
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findNamedImportIdentifier(entrySf, 'aliasedHelper'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/aliased.ts', declarationName: 'aliasedHelper' }]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(entrySf, 'aliasedHelper'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/aliased.ts', declarationName: 'aliasedHelper' }]);

      // 3. Default imports — named default and anonymous default (import site + call site)
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findDefaultImportIdentifier(entrySf, 'createClient'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([
        { virtualFilePath: '/repo/src/default-named.ts', declarationName: 'createClient' },
      ]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(entrySf, 'createClient'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([
        { virtualFilePath: '/repo/src/default-named.ts', declarationName: 'createClient' },
      ]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findDefaultImportIdentifier(entrySf, 'runAnon'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/default-anon.ts', declarationName: 'default' }]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(entrySf, 'runAnon'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/default-anon.ts', declarationName: 'default' }]);

      // 4. Barrel re-export: TypeChecker resolves through barrel to defining declaration in impl.ts
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findNamedImportIdentifier(entrySf, 'deepCompute'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/barrel/impl.ts', declarationName: 'deepCompute' }]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(entrySf, 'deepCompute'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/barrel/impl.ts', declarationName: 'deepCompute' }]);

      // 7. .js import specifiers (both relative and aliased) resolve to .ts declarations
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findNamedImportIdentifier(entrySf, 'addNumbers'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/esm-math.ts', declarationName: 'addNumbers' }]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(entrySf, 'addNumbers'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/esm-math.ts', declarationName: 'addNumbers' }]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findNamedImportIdentifier(entrySf, 'addAliased'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/esm-math.ts', declarationName: 'addNumbers' }]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(entrySf, 'addAliased'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/esm-math.ts', declarationName: 'addNumbers' }]);

      // Agreement with IMPORTS: barrel edge targets barrel/index.ts directly (NOT impl.ts)
      const importEdges = extractImportEdges({
        parsedFiles: ctx.parsedFiles,
        resolver: ctx.resolver,
      });
      const entryImportTargets = importEdges
        .filter((e) => e.sourceQualifiedName === 'file:src/entry.ts')
        .map((e) => e.targetQualifiedName);

      expect(entryImportTargets).toEqual([
        'file:src/aliased.ts',
        'file:src/barrel/index.ts',
        'file:src/default-anon.ts',
        'file:src/default-named.ts',
        'file:src/esm-math.ts',
        'file:src/rel.ts',
      ]);
      expect(
        importEdges.some(
          (e) =>
            e.sourceQualifiedName === 'file:src/barrel/index.ts' &&
            e.targetQualifiedName === 'file:src/barrel/impl.ts',
        ),
      ).toBe(true);
      expect(ctx.resolver.resolveModulePath('./barrel', '/repo/src/entry.ts')).toBe(
        '/repo/src/barrel/index.ts',
      );
    });

    it('resolves identical aliases differently across nested tsconfigs and respects child overrides of inherited aliases', () => {
      const configs = loadWorkspaceTsConfigs([
        makeFile(
          'tsconfig.base.json',
          JSON.stringify({
            compilerOptions: {
              paths: {
                '@shared/*': ['./shared-parent/*'],
              },
            },
          }),
        ),
        makeFile(
          'apps/web/tsconfig.json',
          JSON.stringify({
            extends: '../../tsconfig.base.json',
            compilerOptions: {
              paths: {
                '@/*': ['./src/*'],
              },
            },
          }),
        ),
        makeFile(
          'apps/admin/tsconfig.json',
          JSON.stringify({
            extends: '../../tsconfig.base.json',
            compilerOptions: {
              paths: {
                '@/*': ['./src/*'],
                '@shared/*': ['./shared-override/*'],
              },
            },
          }),
        ),
        makeFile(
          'apps/inherit/tsconfig.json',
          JSON.stringify({
            extends: '../../tsconfig.base.json',
          }),
        ),
      ]);
      expect(configs.warnings).toEqual([]);

      const sourceFiles: readonly LoadedWorkspaceFile[] = [
        makeFile(
          'shared-parent/util.ts',
          'export function sharedFn(): string { return "parent"; }\n',
        ),
        makeFile(
          'apps/web/src/feature.ts',
          'export function runFeature(): string { return "web"; }\n',
        ),
        makeFile(
          'apps/web/src/entry.ts',
          ["import { runFeature } from '@/feature';", 'export const result = runFeature();'].join(
            '\n',
          ),
        ),
        makeFile(
          'apps/admin/src/feature.ts',
          'export function runFeature(): string { return "admin"; }\n',
        ),
        makeFile(
          'apps/admin/shared-override/util.ts',
          'export function sharedFn(): string { return "admin-override"; }\n',
        ),
        makeFile(
          'apps/admin/src/entry.ts',
          [
            "import { runFeature } from '@/feature';",
            "import { sharedFn } from '@shared/util';",
            'export const result = runFeature() + sharedFn();',
          ].join('\n'),
        ),
        makeFile(
          'apps/inherit/src/entry.ts',
          ["import { sharedFn } from '@shared/util';", 'export const result = sharedFn();'].join(
            '\n',
          ),
        ),
      ];

      const ctx = createAnalysisProject({
        sourceFiles,
        configsByDir: configs.configsByDir,
        skipLoadingLibFiles: true,
      });

      const checker = ctx.project.getTypeChecker();
      const webSf = requireSourceFile(ctx.parsedFiles, 'apps/web/src/entry.ts');
      const adminSf = requireSourceFile(ctx.parsedFiles, 'apps/admin/src/entry.ts');
      const inheritSf = requireSourceFile(ctx.parsedFiles, 'apps/inherit/src/entry.ts');

      // 5. Same alias `@/feature` resolves to two distinct internal files
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(webSf, 'runFeature'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([
        { virtualFilePath: '/repo/apps/web/src/feature.ts', declarationName: 'runFeature' },
      ]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(adminSf, 'runFeature'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([
        { virtualFilePath: '/repo/apps/admin/src/feature.ts', declarationName: 'runFeature' },
      ]);

      // 6. Child config overrides inherited `@shared/util` while competing parent file exists and is used by apps/inherit
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(adminSf, 'sharedFn'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([
        {
          virtualFilePath: '/repo/apps/admin/shared-override/util.ts',
          declarationName: 'sharedFn',
        },
      ]);
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(inheritSf, 'sharedFn'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/shared-parent/util.ts', declarationName: 'sharedFn' }]);

      // Verify IMPORTS edges agree completely
      const edges = extractImportEdges({ parsedFiles: ctx.parsedFiles, resolver: ctx.resolver });
      expect(edges.map((e) => `${e.sourceQualifiedName} -> ${e.targetQualifiedName}`)).toEqual([
        'file:apps/admin/src/entry.ts -> file:apps/admin/shared-override/util.ts',
        'file:apps/admin/src/entry.ts -> file:apps/admin/src/feature.ts',
        'file:apps/inherit/src/entry.ts -> file:shared-parent/util.ts',
        'file:apps/web/src/entry.ts -> file:apps/web/src/feature.ts',
      ]);
    });
  });

  describe('Group 2 — Negative resolution and security', () => {
    it('keeps missing aliases, external packages, syntax-invalid files, escaping specifiers, and triple-slash references unresolved', () => {
      const configs = loadWorkspaceTsConfigs([
        makeFile(
          'tsconfig.json',
          JSON.stringify({
            compilerOptions: {
              paths: {
                '@missing-exact': ['./src/does-not-exist.ts'],
                '@*': ['./src/wild/*.ts'],
                '@escape/*': ['../../outside/*'],
                '@lib/*': ['./src/lib/*'],
              },
            },
          }),
        ),
      ]);

      const sourceFiles: readonly LoadedWorkspaceFile[] = [
        // Competing targets that exist and are valid, proving negative cases do not pass accidentally
        makeFile(
          'src/wild/missing-exact.ts',
          'export function missingExact(): number { return 1; }\n',
        ),
        makeFile('src/react.ts', 'export function useState(): number { return 2; }\n'),
        makeFile('src/lib/safe.ts', 'export function safeFn(): number { return 3; }\n'),
        // Intentionally syntax-invalid file (excluded during pre-filter)
        makeFile('src/broken.ts', 'export function brokenFn( { return ;;;\n'),
        makeFile(
          'src/entry.ts',
          [
            '/// <reference path="./broken.ts" />',
            '/// <reference path="../../../outside-secret.ts" />',
            '/// <reference types="node" />',
            '/// <reference types="nonexistent-external-types" />',
            "import { missingExact } from '@missing-exact';",
            "import { useState } from 'react';",
            "import { brokenFn } from './broken';",
            "import { escapedAlias } from '@escape/secret';",
            "import { escapedWild } from '@lib/../../../outside/secret';",
            "import { absHost } from '/etc/passwd';",
            "import { winAbs } from 'C:\\\\windows\\\\win.ts';",
            "import { safeFn } from '@lib/safe';",
            'export function run(): unknown {',
            '  return [missingExact(), useState(), brokenFn(), escapedAlias(), escapedWild(), absHost(), winAbs(), safeFn(), process.cwd()];',
            '}',
          ].join('\n'),
        ),
      ];

      const ctx = createAnalysisProject({
        sourceFiles,
        configsByDir: configs.configsByDir,
        skipLoadingLibFiles: true,
      });

      // 3. Syntax-invalid file excluded from Project, resolver, and parsedFiles with warning
      expect(ctx.skippedSyntaxErrorFilesCount).toBe(1);
      expect(
        ctx.syntaxWarnings.some((w) => w.code === 'SYNTAX_ERROR' && w.filePath === 'src/broken.ts'),
      ).toBe(true);
      expect(ctx.parsedVirtualPaths.has('/repo/src/broken.ts')).toBe(false);
      expect(ctx.project.getSourceFile('/repo/src/broken.ts')).toBeUndefined();

      // 5 & 6. Triple-slash path & type directives did not load broken, outside, or @types/node files
      const programFilePaths = ctx.project
        .getProgram()
        .compilerObject.getSourceFiles()
        .map((sf) => sf.fileName);
      expect(programFilePaths.some((p) => p.includes('broken.ts'))).toBe(false);
      expect(programFilePaths.some((p) => p.includes('outside-secret.ts'))).toBe(false);
      expect(programFilePaths.some((p) => p.includes('@types/node'))).toBe(false);
      expect(programFilePaths.some((p) => p.includes('nonexistent-external-types'))).toBe(false);

      const checker = ctx.project.getTypeChecker();
      const entrySf = requireSourceFile(ctx.parsedFiles, 'src/entry.ts');

      // Positive control confirms resolution works in this exact fixture
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findCallSiteIdentifier(entrySf, 'safeFn'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/lib/safe.ts', declarationName: 'safeFn' }]);

      // 1, 2, 3, 4, 5, 6. Every negative target resolves to zero accepted internal declarations
      const unresolvedIdentifiers = [
        'missingExact',
        'useState',
        'brokenFn',
        'escapedAlias',
        'escapedWild',
        'absHost',
        'winAbs',
      ];
      for (const name of unresolvedIdentifiers) {
        expect(
          resolveAuthoritativeInternalTargets(
            checker,
            findNamedImportIdentifier(entrySf, name),
            ctx.parsedVirtualPaths,
          ),
          `Expected unresolved import "${name}"`,
        ).toEqual([]);
        expect(
          resolveAuthoritativeInternalTargets(
            checker,
            findCallSiteIdentifier(entrySf, name),
            ctx.parsedVirtualPaths,
          ),
          `Expected unresolved call "${name}"`,
        ).toEqual([]);
      }

      // External triple-slash `/// <reference types="node" />` did not resolve `process`
      expect(
        resolveAuthoritativeInternalTargets(
          checker,
          findFirstIdentifier(entrySf, 'process'),
          ctx.parsedVirtualPaths,
        ),
      ).toEqual([]);

      // IMPORTS edges contain ONLY the valid `@lib/safe` edge
      const edges = extractImportEdges({ parsedFiles: ctx.parsedFiles, resolver: ctx.resolver });
      expect(edges.map((e) => `${e.sourceQualifiedName} -> ${e.targetQualifiedName}`)).toEqual([
        'file:src/entry.ts -> file:src/lib/safe.ts',
      ]);
    });

    it('loads bundled standard-library declarations when skipLoadingLibFiles is false but never accepts them as repository targets', () => {
      const sourceFiles: readonly LoadedWorkspaceFile[] = [
        makeFile('src/helper.ts', 'export function internalHelper(): number { return 1; }\n'),
        makeFile(
          'src/entry.ts',
          [
            "import { internalHelper } from './helper';",
            'export function run(): Promise<number> {',
            '  return Promise.resolve(internalHelper());',
            '}',
          ].join('\n'),
        ),
      ];

      // With skipLoadingLibFiles: false, standard libs load in TypeChecker
      const withLibs = createAnalysisProject({
        sourceFiles,
        skipLoadingLibFiles: false,
      });
      const checkerWithLibs = withLibs.project.getTypeChecker();
      const entryWithLibs = requireSourceFile(withLibs.parsedFiles, 'src/entry.ts');
      const promiseId = findFirstIdentifier(entryWithLibs, 'Promise');
      const promiseSymbol = checkerWithLibs.compilerObject.getSymbolAtLocation(
        promiseId.compilerNode,
      );

      // Confirm bundled standard library actually loaded (declarations exist outside /repo/)
      const rawPromiseDeclFiles =
        promiseSymbol?.getDeclarations()?.map((d) => d.getSourceFile().fileName) ?? [];
      for (const libPath of rawPromiseDeclFiles) {
        expect(withLibs.parsedVirtualPaths.has(libPath)).toBe(false);
      }

      // Standard-library declarations are NEVER accepted as repository graph targets
      expect(
        resolveAuthoritativeInternalTargets(
          checkerWithLibs,
          promiseId,
          withLibs.parsedVirtualPaths,
        ),
      ).toEqual([]);
      // Internal helper still resolves cleanly
      expect(
        resolveAuthoritativeInternalTargets(
          checkerWithLibs,
          findCallSiteIdentifier(entryWithLibs, 'internalHelper'),
          withLibs.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/helper.ts', declarationName: 'internalHelper' }]);

      // IMPORTS edges contain only the internal file edge (no lib .d.ts targets)
      const edges = extractImportEdges({
        parsedFiles: withLibs.parsedFiles,
        resolver: withLibs.resolver,
      });
      expect(edges.map((e) => `${e.sourceQualifiedName} -> ${e.targetQualifiedName}`)).toEqual([
        'file:src/entry.ts -> file:src/helper.ts',
      ]);

      // With skipLoadingLibFiles: true, standard libs are omitted while internal resolution still works
      const withoutLibs = createAnalysisProject({
        sourceFiles,
        skipLoadingLibFiles: true,
      });
      const checkerNoLibs = withoutLibs.project.getTypeChecker();
      const entryNoLibs = requireSourceFile(withoutLibs.parsedFiles, 'src/entry.ts');
      const noLibPromiseDecls =
        checkerNoLibs.compilerObject
          .getSymbolAtLocation(findFirstIdentifier(entryNoLibs, 'Promise').compilerNode)
          ?.getDeclarations() ?? [];
      expect(noLibPromiseDecls).toEqual([]);
      expect(
        resolveAuthoritativeInternalTargets(
          checkerNoLibs,
          findCallSiteIdentifier(entryNoLibs, 'internalHelper'),
          withoutLibs.parsedVirtualPaths,
        ),
      ).toEqual([{ virtualFilePath: '/repo/src/helper.ts', declarationName: 'internalHelper' }]);
    });
  });

  describe('Group 3 — Shared resolver consistency, cache isolation, and runtime immutability', () => {
    it('maintains stable repeated results, isolates nested-config caches, avoids unresolved cross-contamination, and enforces authoritative containing files', () => {
      const configs = loadWorkspaceTsConfigs([
        makeFile(
          'tsconfig.base.json',
          JSON.stringify({
            compilerOptions: {
              paths: {
                '@shared/*': ['./shared/*'],
              },
            },
          }),
        ),
        makeFile(
          'apps/empty/tsconfig.json',
          JSON.stringify({
            extends: '../../tsconfig.base.json',
            compilerOptions: { paths: {} },
          }),
        ),
        makeFile(
          'apps/inherit/tsconfig.json',
          JSON.stringify({
            extends: '../../tsconfig.base.json',
          }),
        ),
        makeFile(
          'apps/web/tsconfig.json',
          JSON.stringify({
            compilerOptions: { paths: { '@/*': ['./src/*'] } },
          }),
        ),
        makeFile(
          'apps/admin/tsconfig.json',
          JSON.stringify({
            compilerOptions: { paths: { '@/*': ['./src/*'] } },
          }),
        ),
      ]);

      const sourceFiles: readonly LoadedWorkspaceFile[] = [
        makeFile('shared/helper.ts', 'export const h = 1;\n'),
        makeFile('apps/empty/src/entry.ts', "import { h } from '@shared/helper'; void h;\n"),
        makeFile('apps/inherit/src/entry.ts', "import { h } from '@shared/helper'; void h;\n"),
        makeFile('apps/web/src/mod.ts', 'export const m = "web";\n'),
        makeFile('apps/web/src/entry.ts', "import { m } from '@/mod'; void m;\n"),
        makeFile('apps/admin/src/mod.ts', 'export const m = "admin";\n'),
        makeFile('apps/admin/src/entry.ts', "import { m } from '@/mod'; void m;\n"),
      ];

      const ctx = createAnalysisProject({
        sourceFiles,
        configsByDir: configs.configsByDir,
        skipLoadingLibFiles: true,
      });

      // 4. Unresolved first in apps/empty must NOT contaminate apps/inherit
      expect(
        ctx.resolver.resolveModulePath('@shared/helper', '/repo/apps/empty/src/entry.ts'),
      ).toBeNull();
      expect(
        ctx.resolver.resolveModulePath('@shared/helper', '/repo/apps/inherit/src/entry.ts'),
      ).toBe('/repo/shared/helper.ts');
      // Reverse order check (resolved cached in apps/inherit must NOT leak into apps/empty)
      expect(
        ctx.resolver.resolveModulePath('@shared/helper', '/repo/apps/inherit/src/entry.ts'),
      ).toBe('/repo/shared/helper.ts');
      expect(
        ctx.resolver.resolveModulePath('@shared/helper', '/repo/apps/empty/src/entry.ts'),
      ).toBeNull();

      // 2 & 3. Interleaved repeated resolutions across nested configs remain isolated and stable
      for (let i = 0; i < 3; i += 1) {
        expect(ctx.resolver.resolveModulePath('@/mod', '/repo/apps/web/src/entry.ts')).toBe(
          '/repo/apps/web/src/mod.ts',
        );
        expect(ctx.resolver.resolveModulePath('@/mod', '/repo/apps/admin/src/entry.ts')).toBe(
          '/repo/apps/admin/src/mod.ts',
        );
      }

      // Authoritative containing-file enforcement: unknown/non-authoritative callers cannot resolve
      expect(
        ctx.resolver.resolveModulePath('@/mod', '/repo/apps/web/src/not-in-set.ts'),
      ).toBeNull();

      // 1. Agreement between shared resolver and emitted direct IMPORTS edges
      const edges = extractImportEdges({ parsedFiles: ctx.parsedFiles, resolver: ctx.resolver });
      expect(edges.map((e) => `${e.sourceQualifiedName} -> ${e.targetQualifiedName}`)).toEqual([
        'file:apps/admin/src/entry.ts -> file:apps/admin/src/mod.ts',
        'file:apps/inherit/src/entry.ts -> file:shared/helper.ts',
        'file:apps/web/src/entry.ts -> file:apps/web/src/mod.ts',
      ]);
    });

    it('protects internal authoritative paths, config snapshots, defensive copies, and cached ResolvedModuleFull objects against external mutation', () => {
      // Construct genuinely mutable fixture inputs (zero unsafe casts)
      const mutableInputPaths = new Set<string>([
        '/repo/src/entry.ts',
        '/repo/src/v1/mod.ts',
        '/repo/src/v2/mod.ts',
      ]);
      const mutableTargetArray: string[] = ['/repo/src/v1/*'];
      const mutablePathsRecord: Record<string, string[]> = {
        '@alias/*': mutableTargetArray,
      };
      const mutableConfig: {
        configPath: string;
        configDir: string;
        pathsDeclarationDir: string;
        rawPaths: Record<string, string[]>;
        paths: Record<string, string[]>;
      } = {
        configPath: 'tsconfig.json',
        configDir: '',
        pathsDeclarationDir: '',
        rawPaths: { '@alias/*': ['./src/v1/*'] },
        paths: mutablePathsRecord,
      };
      const mutableConfigsByDir = new Map<string, ResolvedTsConfig>([['', mutableConfig]]);

      const resolver = createWorkspaceModuleResolver({
        parsedVirtualPaths: mutableInputPaths,
        configsByDir: mutableConfigsByDir,
      });

      // 5. Mutate original input path Set BEFORE any resolution
      mutableInputPaths.delete('/repo/src/v1/mod.ts');
      mutableInputPaths.add('/repo/src/injected.ts');

      // 6. Mutate original config Map, alias object, and alias target array BEFORE any resolution
      mutableTargetArray[0] = '/repo/src/v2/*';
      mutablePathsRecord['@injected/*'] = ['/repo/src/v2/*'];
      mutableConfigsByDir.clear();

      expect(resolver.resolveModulePath('@alias/mod', '/repo/src/entry.ts')).toBe(
        '/repo/src/v1/mod.ts',
      );
      expect(resolver.resolveModulePath('@injected/mod', '/repo/src/entry.ts')).toBeNull();
      expect(resolver.resolveModulePath('./injected', '/repo/src/entry.ts')).toBeNull();

      // 7. Mutate returned defensive parsedVirtualPaths copy -> internal state remains unchanged
      const defensiveCopyA = resolver.parsedVirtualPaths;
      const defensiveCopyB = resolver.parsedVirtualPaths;
      expect(defensiveCopyA).not.toBe(defensiveCopyB);
      expect(isMutableStringSet(defensiveCopyA)).toBe(true);
      if (isMutableStringSet(defensiveCopyA)) {
        defensiveCopyA.delete('/repo/src/v1/mod.ts');
        defensiveCopyA.add('/repo/src/evil.ts');
      }
      expect(resolver.parsedVirtualPaths.has('/repo/src/v1/mod.ts')).toBe(true);
      expect(resolver.parsedVirtualPaths.has('/repo/src/evil.ts')).toBe(false);
      expect(resolver.resolveModulePath('./v1/mod', '/repo/src/entry.ts')).toBe(
        '/repo/src/v1/mod.ts',
      );

      // 8. Mutate returned ResolvedModuleFull -> cached result remains uncorrupted
      const firstFull = resolver.resolveModuleFull('@alias/mod', '/repo/src/entry.ts');
      expect(firstFull).toBeDefined();
      if (firstFull !== undefined) {
        firstFull.resolvedFileName = '/repo/src/v2/mod.ts';
        firstFull.isExternalLibraryImport = true;
      }

      const secondFull = resolver.resolveModuleFull('@alias/mod', '/repo/src/entry.ts');
      expect(secondFull?.resolvedFileName).toBe('/repo/src/v1/mod.ts');
      expect(secondFull?.isExternalLibraryImport).toBe(false);
    });
  });
});
