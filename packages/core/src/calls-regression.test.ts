import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.js';
import { extractCallEdges } from './calls-extractor.js';
import type { LoadedWorkspaceFile } from './discovery.js';
import { CoreAnalysisError } from './errors.js';
import { extractImportEdges } from './imports-extractor.js';
import { extractNodesWithIndex } from './node-extractor.js';
import { createAnalysisProject } from './project.js';
import { loadWorkspaceTsConfigs } from './tsconfig-loader.js';
import { DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS, type ExtractedEdge } from './types.js';

function makeFile(relativePath: string, content: string): LoadedWorkspaceFile {
  return {
    relativePath,
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
  };
}

function summarizeCalls(edges: readonly ExtractedEdge[]): readonly string[] {
  return edges
    .filter((e) => e.edgeType === 'CALLS')
    .map((e) => `${e.sourceQualifiedName} -> ${e.targetQualifiedName} @L${e.callSiteLine}`);
}

function summarizeImports(edges: readonly ExtractedEdge[]): readonly string[] {
  return edges
    .filter((e) => e.edgeType === 'IMPORTS')
    .map((e) => `${e.sourceQualifiedName} -> ${e.targetQualifiedName}`);
}

function assertGraphInvariants(
  nodeQns: ReadonlySet<string>,
  edges: readonly ExtractedEdge[],
  maxCallSiteSnippetChars: number,
): void {
  const seenKeys = new Set<string>();
  for (const edge of edges) {
    expect(
      nodeQns.has(edge.sourceQualifiedName),
      `Missing source ${edge.sourceQualifiedName}`,
    ).toBe(true);
    expect(
      nodeQns.has(edge.targetQualifiedName),
      `Missing target ${edge.targetQualifiedName}`,
    ).toBe(true);

    if (edge.edgeType === 'IMPORTS') {
      expect(edge.callSiteLine).toBeNull();
      expect(edge.callSiteSnippet).toBeNull();
      const key = `${edge.sourceQualifiedName}\0${edge.targetQualifiedName}\0IMPORTS`;
      expect(seenKeys.has(key), `Duplicate IMPORTS key ${key}`).toBe(false);
      seenKeys.add(key);
    } else {
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
      expect(seenKeys.has(key), `Duplicate CALLS key ${key}`).toBe(false);
      seenKeys.add(key);
    }
  }
}

function runInMemory(
  sourceFiles: readonly LoadedWorkspaceFile[],
  options: {
    readonly configFiles?: readonly LoadedWorkspaceFile[];
    readonly skipLoadingLibFiles?: boolean;
    readonly maxCallSiteSnippetChars?: number;
    readonly allowSyntaxErrors?: boolean;
  } = {},
) {
  const tsConfigs = loadWorkspaceTsConfigs(options.configFiles ?? []);
  expect(tsConfigs.warnings).toEqual([]);

  const projectContext = createAnalysisProject({
    sourceFiles,
    configsByDir: tsConfigs.configsByDir,
    skipLoadingLibFiles: options.skipLoadingLibFiles ?? true,
  });

  if (options.allowSyntaxErrors !== true) {
    expect(projectContext.syntaxWarnings).toEqual([]);
    expect(projectContext.parsedFiles).toHaveLength(sourceFiles.length);
  }

  const { nodes, declarationIndex } = extractNodesWithIndex({
    parsedFiles: projectContext.parsedFiles,
  });
  const importEdges = extractImportEdges({
    parsedFiles: projectContext.parsedFiles,
    resolver: projectContext.resolver,
  });
  const callEdges = extractCallEdges({
    projectContext,
    declarationIndex,
    maxCallSiteSnippetChars: options.maxCallSiteSnippetChars,
  });

  const nodeQns = new Set(nodes.map((n) => n.qualifiedName));
  expect(nodeQns.size).toBe(nodes.length);
  for (const node of nodes) {
    if (node.parentQualifiedName !== null) {
      expect(
        nodeQns.has(node.parentQualifiedName),
        `Missing parent for ${node.qualifiedName}`,
      ).toBe(true);
    }
  }

  const snippetCap = options.maxCallSiteSnippetChars ?? DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS;
  assertGraphInvariants(nodeQns, [...importEdges, ...callEdges], snippetCap);

  return { nodes, importEdges, callEdges, projectContext };
}

describe('CALLS extended regression matrix (Batch 4.2b.3 Part B)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function createTempWorkspace(files: Readonly<Record<string, string>>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-calls-reg-'));
    tempDirs.push(dir);
    for (const [relPosixPath, content] of Object.entries(files)) {
      const absPath = path.join(dir, ...relPosixPath.split('/'));
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    }
    return dir;
  }

  describe('Part 3 — Methods, constructors, and ambiguity', () => {
    it('resolves inherited/overridden/chained/optional/generic/intersection/shared-union methods and rejects ambiguous/HOF/any-unknown-chain calls', () => {
      const sourceFiles = [
        makeFile(
          'src/methods.ts',
          [
            'export function helper(): number { return 1; }',
            'export interface IRunner { run(): number; }',
            'export class BaseService {',
            '  ping(): number { return 10; }',
            '  overrideMe(): number { return 20; }',
            '  shared(): number { return 30; }',
            '}',
            'export class ChildService extends BaseService {',
            '  override overrideMe(): number { return this.ping() + super.overrideMe(); }',
            '  run(): number { return 40; }',
            '}',
            'export class AltService extends BaseService {',
            '  run(): number { return 50; }',
            '}',
            'export function getChild(): ChildService { return new ChildService(); }',
            'export function invokeGeneric<T extends BaseService>(item: T): number {',
            '  return item.ping();',
            '}',
            'export function exercise(',
            '  child: ChildService,',
            '  maybeChild: ChildService | null,',
            '  maybeFn: (() => number) | undefined,',
            '  childOrAlt: ChildService | AltService,',
            '  childOrIface: ChildService | IRunner,',
            '  childWithExtra: ChildService & { extra: string },',
            '  conflictingIntersection: ChildService & AltService,',
            '  hofCb: () => number,',
            '): void {',
            '  child.ping();',
            '  child.overrideMe();',
            '  new ChildService().run();',
            '  getChild().run();',
            '  maybeChild?.run();',
            '  maybeChild!.run();',
            '  helper?.();',
            '  childOrAlt.shared();',
            '  childWithExtra.run();',
            '  invokeGeneric(child);',
            '  maybeFn?.();',
            '  childOrAlt.run();',
            '  childOrIface.run();',
            '  conflictingIntersection.run();',
            '  hofCb();',
            '  (helper as any)();',
            '  ((helper as unknown) as () => number)();',
            '  ((child as unknown) as ChildService).run();',
            '  (child as any).run();',
            '  new (ChildService as any)();',
            '}',
          ].join('\n'),
        ),
      ];

      const { callEdges } = runInMemory(sourceFiles);

      expect(summarizeCalls(callEdges)).toEqual([
        'src/methods.ts::class:ChildService::method:overrideMe -> src/methods.ts::class:BaseService::method:overrideMe @L9',
        'src/methods.ts::class:ChildService::method:overrideMe -> src/methods.ts::class:BaseService::method:ping @L9',
        'src/methods.ts::fn:exercise -> src/methods.ts::class:BaseService::method:ping @L29',
        'src/methods.ts::fn:exercise -> src/methods.ts::class:BaseService::method:shared @L36',
        'src/methods.ts::fn:exercise -> src/methods.ts::class:ChildService @L31',
        'src/methods.ts::fn:exercise -> src/methods.ts::class:ChildService::method:overrideMe @L30',
        'src/methods.ts::fn:exercise -> src/methods.ts::class:ChildService::method:run @L31',
        'src/methods.ts::fn:exercise -> src/methods.ts::class:ChildService::method:run @L32',
        'src/methods.ts::fn:exercise -> src/methods.ts::class:ChildService::method:run @L33',
        'src/methods.ts::fn:exercise -> src/methods.ts::class:ChildService::method:run @L34',
        'src/methods.ts::fn:exercise -> src/methods.ts::class:ChildService::method:run @L37',
        'src/methods.ts::fn:exercise -> src/methods.ts::fn:getChild @L32',
        'src/methods.ts::fn:exercise -> src/methods.ts::fn:helper @L35',
        'src/methods.ts::fn:exercise -> src/methods.ts::fn:invokeGeneric @L38',
        'src/methods.ts::fn:getChild -> src/methods.ts::class:ChildService @L15',
        'src/methods.ts::fn:invokeGeneric -> src/methods.ts::class:BaseService::method:ping @L17',
      ]);
    });

    it('rejects .d.ts ambient declarations without declare keyword, type-only imports in value positions, incompatible constructor assertions, and invalid super() contexts', () => {
      const sourceFiles = [
        makeFile(
          'src/real.ts',
          [
            'export function realFn(): number { return 1; }',
            'export class RealWithCtor { constructor(public readonly v: number) {} }',
            'export class OtherClass { constructor(public readonly s: string) {} }',
            'export function getDynamicBase(): new () => object { return class {}; }',
          ].join('\n'),
        ),
        makeFile(
          'src/ambient.d.ts',
          [
            'export class AmbientDtsClass {',
            '  ping(): number;',
            '}',
            'export function ambientDtsFn(): number;',
          ].join('\n'),
        ),
        makeFile(
          'src/ctor-edge-cases.ts',
          [
            "import type { RealWithCtor as TypeOnlyClass, realFn as typeOnlyFn } from './real';",
            "import { type OtherClass as InlineTypeClass, RealWithCtor, getDynamicBase, realFn } from './real';",
            "import { AmbientDtsClass, ambientDtsFn } from './ambient';",
            'export class NoBase {',
            '  constructor() {',
            '    super();',
            '  }',
            '}',
            'export class DynamicDerived extends getDynamicBase() {',
            '  constructor() {',
            '    super();',
            '  }',
            '}',
            'export class InvalidSuperContexts extends RealWithCtor {',
            '  constructor() {',
            '    super(1);',
            '    const nestedFn = function () { super(2); };',
            '    void nestedFn;',
            '  }',
            '  static staticBad(): void {',
            '    super(3);',
            '  }',
            '  get accessorBad(): number {',
            '    super(4);',
            '    return 0;',
            '  }',
            '}',
            'export function runEdgeCases(amb: AmbientDtsClass): void {',
            '  new RealWithCtor(1);',
            '  realFn();',
            '  new AmbientDtsClass();',
            '  amb.ping();',
            '  ambientDtsFn();',
            '  typeOnlyFn();',
            '  new TypeOnlyClass(1);',
            "  new InlineTypeClass('x');",
            '  new (realFn as unknown as new () => object)();',
            '  new (RealWithCtor as unknown as typeof RealWithCtor)(1);',
            '}',
          ].join('\n'),
        ),
      ];

      const { callEdges } = runInMemory(sourceFiles);

      expect(summarizeCalls(callEdges)).toEqual([
        'file:src/ctor-edge-cases.ts -> src/real.ts::fn:getDynamicBase @L9',
        'src/ctor-edge-cases.ts::class:InvalidSuperContexts::ctor -> src/real.ts::class:RealWithCtor::ctor @L16',
        'src/ctor-edge-cases.ts::fn:runEdgeCases -> src/real.ts::class:RealWithCtor::ctor @L29',
        'src/ctor-edge-cases.ts::fn:runEdgeCases -> src/real.ts::fn:realFn @L30',
      ]);
    });

    it('rejects type-only default/namespace/JSX/re-export/export-type-star bindings while preserving legitimate value imports of the exact same declarations', () => {
      const sourceFiles = [
        makeFile(
          'src/real-targets.tsx',
          [
            'export function realFn(): number { return 1; }',
            'export default function defaultRealFn(): number { return 2; }',
            'export class RealClass { constructor(public readonly id: number) {} }',
            'export function RealComp() { return <div />; }',
          ].join('\n'),
        ),
        makeFile(
          'src/type-named-barrel.ts',
          [
            "export type { realFn } from './real-targets';",
            "export { type RealClass } from './real-targets';",
          ].join('\n'),
        ),
        makeFile(
          'src/type-chain-barrel.ts',
          "export { realFn, RealClass } from './type-named-barrel';\n",
        ),
        makeFile('src/type-star-barrel.ts', "export type * from './real-targets';\n"),
        makeFile(
          'src/type-ns-barrel.ts',
          [
            "export type * as TypeReExportNs from './real-targets';",
            "export * as ValReExportNs from './real-targets';",
          ].join('\n'),
        ),
        makeFile('src/value-star-barrel.ts', "export * from './real-targets';\n"),
        makeFile(
          'src/type-only-consumer.tsx',
          [
            "import type defaultTypeFn from './real-targets';",
            "import defaultValFn from './real-targets';",
            "import type * as TypeNs from './real-targets';",
            "import * as ValNs from './real-targets';",
            "import type { RealComp as TypeComp, realFn as typeFn } from './real-targets';",
            "import { RealComp as ValComp, realFn as valFn } from './real-targets';",
            "import { RealClass as ChainTypeClass, realFn as chainTypeFn } from './type-chain-barrel';",
            "import { RealClass as StarTypeClass, realFn as starTypeFn } from './type-star-barrel';",
            "import * as StarTypeNs from './type-star-barrel';",
            "import { TypeReExportNs, ValReExportNs } from './type-ns-barrel';",
            "import { realFn as valStarFn } from './value-star-barrel';",
            'export class DerivedFromTypeNs extends TypeNs.RealClass {',
            '  constructor() {',
            '    super(1);',
            '  }',
            '}',
            'export function runProvenance() {',
            '  // Negative cases: all type-only bindings and type-only re-exports',
            '  defaultTypeFn();',
            '  typeFn();',
            '  TypeNs.realFn();',
            '  new TypeNs.RealClass(1);',
            '  chainTypeFn();',
            '  new ChainTypeClass(2);',
            '  starTypeFn();',
            '  new StarTypeClass(3);',
            '  StarTypeNs.realFn();',
            '  TypeReExportNs.realFn();',
            '  new TypeReExportNs.RealClass(4);',
            '  // Positive controls: value imports of the same declarations & value barrels/namespaces',
            '  defaultValFn();',
            '  valFn();',
            '  ValNs.realFn();',
            '  new ValNs.RealClass(5);',
            '  ValReExportNs.realFn();',
            '  new ValReExportNs.RealClass(6);',
            '  valStarFn();',
            '  return (',
            '    <div>',
            '      <TypeComp />',
            '      <TypeNs.RealComp />',
            '      <TypeReExportNs.RealComp />',
            '      <ValComp />',
            '      <ValNs.RealComp />',
            '      <ValReExportNs.RealComp />',
            '    </div>',
            '  );',
            '}',
          ].join('\n'),
        ),
      ];

      const { callEdges } = runInMemory(sourceFiles);

      expect(summarizeCalls(callEdges)).toEqual([
        'src/type-only-consumer.tsx::fn:runProvenance -> src/real-targets.tsx::class:RealClass::ctor @L34',
        'src/type-only-consumer.tsx::fn:runProvenance -> src/real-targets.tsx::class:RealClass::ctor @L36',
        'src/type-only-consumer.tsx::fn:runProvenance -> src/real-targets.tsx::fn:RealComp @L43',
        'src/type-only-consumer.tsx::fn:runProvenance -> src/real-targets.tsx::fn:RealComp @L44',
        'src/type-only-consumer.tsx::fn:runProvenance -> src/real-targets.tsx::fn:RealComp @L45',
        'src/type-only-consumer.tsx::fn:runProvenance -> src/real-targets.tsx::fn:defaultRealFn @L31',
        'src/type-only-consumer.tsx::fn:runProvenance -> src/real-targets.tsx::fn:realFn @L32',
        'src/type-only-consumer.tsx::fn:runProvenance -> src/real-targets.tsx::fn:realFn @L33',
        'src/type-only-consumer.tsx::fn:runProvenance -> src/real-targets.tsx::fn:realFn @L35',
        'src/type-only-consumer.tsx::fn:runProvenance -> src/real-targets.tsx::fn:realFn @L37',
      ]);
    });
  });

  describe('Part 4 — CommonJS and JavaScript', () => {
    it('extracts JS internal/ESM CALLS, CJS declaration nodes, and explicit .cjs IMPORTS edges cleanly', () => {
      const sourceFiles = [
        makeFile(
          'src/js-utils.js',
          [
            'function localAdd(a, b) { return a + b; }',
            'export function computeJs(x) { return localAdd(x, 1); }',
          ].join('\n'),
        ),
        makeFile(
          'src/js-caller.js',
          [
            "import { computeJs } from './js-utils.js';",
            'export function runJs(n) { return computeJs(n); }',
          ].join('\n'),
        ),
        makeFile(
          'src/cjs-exports.cjs',
          [
            'exports.fnExpr = function (x) { return x + 1; };',
            'exports.arrowFn = (x) => x * 2;',
          ].join('\n'),
        ),
        makeFile('src/cjs-default.cjs', 'module.exports = function (x) { return x - 1; };\n'),
        makeFile(
          'src/cjs-object.cjs',
          [
            'module.exports = {',
            '  methodFn(x) { return x + 10; },',
            '  propArrow: (x) => x + 20,',
            '};',
          ].join('\n'),
        ),
        makeFile(
          'src/cjs-consumer.cjs',
          [
            "const named = require('./cjs-exports.cjs');",
            "const defFn = require('./cjs-default.cjs');",
            "const objMod = require('./cjs-object.cjs');",
            'function runCjs(n) {',
            '  return named.fnExpr(n) + named.arrowFn(n) + defFn(n) + objMod.methodFn(n) + objMod.propArrow(n);',
            '}',
            'module.exports = { runCjs };',
          ].join('\n'),
        ),
      ];

      const { nodes, importEdges, callEdges } = runInMemory(sourceFiles);

      // 1. Node extraction capability: all 5 static CJS export forms emit exported function nodes
      const exportedFnQns = new Set(
        nodes.filter((n) => n.nodeType === 'function' && n.isExported).map((n) => n.qualifiedName),
      );
      expect(exportedFnQns.has('src/cjs-exports.cjs::fn:fnExpr')).toBe(true);
      expect(exportedFnQns.has('src/cjs-exports.cjs::fn:arrowFn')).toBe(true);
      expect(exportedFnQns.has('src/cjs-default.cjs::default')).toBe(true);
      expect(exportedFnQns.has('src/cjs-object.cjs::fn:methodFn')).toBe(true);
      expect(exportedFnQns.has('src/cjs-object.cjs::fn:propArrow')).toBe(true);
      expect(exportedFnQns.has('src/cjs-consumer.cjs::fn:runCjs')).toBe(true);

      // 2. IMPORTS capability: explicit .cjs require() and ESM .js imports all resolve
      expect(summarizeImports(importEdges)).toEqual([
        'file:src/cjs-consumer.cjs -> file:src/cjs-default.cjs',
        'file:src/cjs-consumer.cjs -> file:src/cjs-exports.cjs',
        'file:src/cjs-consumer.cjs -> file:src/cjs-object.cjs',
        'file:src/js-caller.js -> file:src/js-utils.js',
      ]);

      // 3a. JS internal & ESM-imported CALLS resolve deterministically
      const jsCalls = summarizeCalls(callEdges).filter((c) => c.startsWith('src/js-'));
      expect(jsCalls).toEqual([
        'src/js-caller.js::fn:runJs -> src/js-utils.js::fn:computeJs @L2',
        'src/js-utils.js::fn:computeJs -> src/js-utils.js::fn:localAdd @L2',
      ]);
    });

    it('probes compiler resolution of static CommonJS require() invocations across all 5 export forms', () => {
      const sourceFiles = [
        makeFile(
          'src/cjs-exports.cjs',
          [
            'exports.fnExpr = function (x) { return x + 1; };',
            'exports.arrowFn = (x) => x * 2;',
          ].join('\n'),
        ),
        makeFile('src/cjs-default.cjs', 'module.exports = function (x) { return x - 1; };\n'),
        makeFile(
          'src/cjs-object.cjs',
          [
            'module.exports = {',
            '  methodFn(x) { return x + 10; },',
            '  propArrow: (x) => x + 20,',
            '};',
          ].join('\n'),
        ),
        makeFile(
          'src/cjs-consumer.cjs',
          [
            "const named = require('./cjs-exports.cjs');",
            "const defFn = require('./cjs-default.cjs');",
            "const objMod = require('./cjs-object.cjs');",
            'function runCjs(n) {',
            '  return named.fnExpr(n) + named.arrowFn(n) + defFn(n) + objMod.methodFn(n) + objMod.propArrow(n);',
            '}',
            'module.exports = { runCjs };',
          ].join('\n'),
        ),
      ];

      const { callEdges } = runInMemory(sourceFiles);

      expect(summarizeCalls(callEdges)).toEqual([
        'src/cjs-consumer.cjs::fn:runCjs -> src/cjs-default.cjs::default @L5',
        'src/cjs-consumer.cjs::fn:runCjs -> src/cjs-exports.cjs::fn:arrowFn @L5',
        'src/cjs-consumer.cjs::fn:runCjs -> src/cjs-exports.cjs::fn:fnExpr @L5',
        'src/cjs-consumer.cjs::fn:runCjs -> src/cjs-object.cjs::fn:methodFn @L5',
        'src/cjs-consumer.cjs::fn:runCjs -> src/cjs-object.cjs::fn:propArrow @L5',
      ]);
    });
  });

  describe('Part 5 — JSX and React HOC edge cases', () => {
    it('supports namespace JSX, paired tags, same-line dedupe, and valid React HOCs while rejecting type-only, ambient, shadowed, and non-component wrappers', () => {
      const sourceFiles = [
        makeFile(
          'src/hoc-defs.tsx',
          [
            "import React, { forwardRef as wrapRef, memo as wrapMemo } from 'react';",
            "import * as ReactNs from 'react';",
            "import type { memo as typeOnlyMemo } from 'react';",
            "import type ReactTypeOnly from 'react';",
            'export function BaseButton() { return <button />; }',
            'export declare function AmbientComp(): null;',
            'export declare class AmbientClassComp {}',
            'export const AliasedMemo = wrapMemo(BaseButton);',
            'export const AliasedForwardRef = wrapRef(() => <span />);',
            'export const NestedHoc = ReactNs.memo(React.forwardRef(() => <div />));',
            'export const ChainedHoc = wrapMemo(AliasedForwardRef);',
            'export const TypeOnlyNamedHoc = typeOnlyMemo(() => <div />);',
            'export const TypeOnlyDefaultHoc = ReactTypeOnly.memo(() => <div />);',
            'export const AmbientFnHoc = wrapMemo(AmbientComp);',
            'export const AmbientClassHoc = wrapMemo(AmbientClassComp);',
            "const NOT_A_COMP = { label: 'x' };",
            'export const NonCompHoc = wrapMemo(NOT_A_COMP);',
            "export const ARBITRARY_OBJ = { title: 'plain' };",
            'export const ARBITRARY_NUM = 123;',
          ].join('\n'),
        ),
        makeFile(
          'src/hoc-shadow.tsx',
          [
            "import React, { memo } from 'react';",
            'const React = { memo: <T,>(x: T): T => x };',
            'function memo<T,>(x: T): T { return x; }',
            'export const ShadowedNs = React.memo(() => <div />);',
            'export const ShadowedNamed = memo(() => <div />);',
          ].join('\n'),
        ),
        makeFile(
          'src/hoc-page.tsx',
          [
            "import * as UI from './hoc-defs';",
            "import { ShadowedNamed, ShadowedNs } from './hoc-shadow';",
            'export function Screen() {',
            '  return (',
            '    <main>',
            '      <svg:path />',
            '      <UI.BaseButton><UI.AliasedMemo /></UI.BaseButton>',
            '      <UI.AliasedForwardRef /><UI.AliasedForwardRef />',
            '      <UI.NestedHoc />',
            '      <UI.ChainedHoc />',
            '      <UI.TypeOnlyNamedHoc />',
            '      <UI.TypeOnlyDefaultHoc />',
            '      <UI.AmbientFnHoc />',
            '      <UI.AmbientClassHoc />',
            '      <UI.NonCompHoc />',
            '      <UI.ARBITRARY_OBJ />',
            '      <UI.ARBITRARY_NUM />',
            '      <ShadowedNs />',
            '      <ShadowedNamed />',
            '    </main>',
            '  );',
            '}',
          ].join('\n'),
        ),
      ];

      const { callEdges } = runInMemory(sourceFiles);

      expect(summarizeCalls(callEdges)).toEqual([
        'src/hoc-page.tsx::fn:Screen -> src/hoc-defs.tsx::fn:BaseButton @L7',
        'src/hoc-page.tsx::fn:Screen -> src/hoc-defs.tsx::sym:AliasedForwardRef @L8',
        'src/hoc-page.tsx::fn:Screen -> src/hoc-defs.tsx::sym:AliasedMemo @L7',
        'src/hoc-page.tsx::fn:Screen -> src/hoc-defs.tsx::sym:ChainedHoc @L10',
        'src/hoc-page.tsx::fn:Screen -> src/hoc-defs.tsx::sym:NestedHoc @L9',
      ]);
    });
    it('resolves JSX usages of concrete functions and const arrows with top-level property augmentations while rejecting sub-components, non-const, type-only, ambient, shadowed, dynamic, and CallExpression negatives', () => {
      const sourceFiles = [
        makeFile(
          'src/components.tsx',
          [
            "import React, { forwardRef, memo } from 'react';",
            "import { createExternalFactory } from 'uninstalled-factory';",
            'export function PlainBadge() {',
            '  return <span />;',
            '}',
            'export function CardBox() {',
            '  return <section />;',
            '}',
            "CardBox.displayName = 'CardBox';",
            'export function Panel() {',
            '  return <div />;',
            '}',
            'Panel.Skeleton = () => <span />;',
            'Panel.Title = () => <h1 />;',
            'const Header = () => <header />;',
            "Header.displayName = 'Header';",
            'export { Header };',
            'export const Footer = function FooterImpl() {',
            '  return <footer />;',
            '};',
            "Footer.displayName = 'Footer';",
            'export const MemoTag = memo(() => <em />);',
            'export const RefButton = forwardRef<HTMLButtonElement>(() => <button />);',
            'export const Icons = {',
            '  gitHub: () => <svg />,',
            '};',
            'export declare function AmbientBanner(): null;',
            'let ReboundComp: typeof CardBox | typeof Panel = CardBox;',
            'ReboundComp = Panel;',
            'export { ReboundComp };',
            'let MutableAugmented = () => <div />;',
            "MutableAugmented.displayName = 'Mutable';",
            'export { MutableAugmented };',
            'export const FactoryAugmented = createExternalFactory();',
            "FactoryAugmented.displayName = 'Factory';",
          ].join('\n'),
        ),
        makeFile('src/type-barrel.ts', "export type { Panel } from './components';\n"),
        makeFile('src/value-barrel.ts', "export { CardBox } from './components';\n"),
        makeFile(
          'src/page.tsx',
          [
            "import { ExternalWidget } from 'uninstalled-ui';",
            'import {',
            '  AmbientBanner,',
            '  FactoryAugmented,',
            '  Footer,',
            '  Header as Heading,',
            '  Icons,',
            '  MemoTag,',
            '  MutableAugmented,',
            '  Panel,',
            '  PlainBadge,',
            '  ReboundComp,',
            '  RefButton,',
            "} from './components';",
            "import type { Panel as TypeOnlyPanel } from './components';",
            "import { Panel as ReExportedTypePanel } from './type-barrel';",
            "import { CardBox } from './value-barrel';",
            'export function Page(',
            '  DynamicComp: () => null,',
            '  dynamicFn: () => void,',
            '  dynObj: Record<string, () => void>,',
            '  key: string,',
            ') {',
            '  dynamicFn();',
            '  dynObj[key]();',
            '  (PlainBadge as any)();',
            '  Panel();',
            '  return (',
            '    <div>',
            '      <svg:path />',
            '      <CardBox />',
            '      <Panel>',
            '        <Panel.Skeleton />',
            '        <Panel.Title />',
            '        <Heading />',
            '        <Footer />',
            '      </Panel>',
            '      <PlainBadge />',
            '      <MemoTag />',
            '      <RefButton />',
            '      <DynamicComp />',
            '      <Icons.gitHub />',
            '      <ExternalWidget />',
            '      <TypeOnlyPanel />',
            '      <ReExportedTypePanel />',
            '      <AmbientBanner />',
            '      <ReboundComp />',
            '      <MutableAugmented />',
            '      <FactoryAugmented />',
            '      {/* @ts-expect-error unresolved JSX identifier tested intentionally */}',
            '      <TotallyMissingComp />',
            '    </div>',
            '  );',
            '}',
            'export function ShadowedPage(getDynamic: () => () => null) {',
            '  const Panel = getDynamic();',
            '  return <Panel />;',
            '}',
          ].join('\n'),
        ),
      ];

      const expectedCalls = [
        'src/page.tsx::fn:Page -> src/components.tsx::fn:CardBox @L31',
        'src/page.tsx::fn:Page -> src/components.tsx::fn:Footer @L36',
        'src/page.tsx::fn:Page -> src/components.tsx::fn:Header @L35',
        'src/page.tsx::fn:Page -> src/components.tsx::fn:Panel @L32',
        'src/page.tsx::fn:Page -> src/components.tsx::fn:PlainBadge @L38',
        'src/page.tsx::fn:Page -> src/components.tsx::sym:MemoTag @L39',
        'src/page.tsx::fn:Page -> src/components.tsx::sym:RefButton @L40',
      ];

      // Official evaluation mode (skipLoadingLibFiles: false) + repeat-run determinism
      const withLibs1 = runInMemory(sourceFiles, { skipLoadingLibFiles: false });
      const withLibs2 = runInMemory(sourceFiles, { skipLoadingLibFiles: false });
      expect(summarizeCalls(withLibs1.callEdges)).toEqual(expectedCalls);
      expect(withLibs1.callEdges).toEqual(withLibs2.callEdges);

      // No-lib mode agrees on all concrete & React-HOC JSX component usages
      const withoutLibs = runInMemory(sourceFiles, { skipLoadingLibFiles: true });
      expect(summarizeCalls(withoutLibs.callEdges)).toEqual(expectedCalls);

      // Panel.Skeleton and Panel.Title must NOT become newly extracted callable nodes
      const nodeQns = new Set(withLibs1.nodes.map((n) => n.qualifiedName));
      expect(nodeQns.has('src/components.tsx::fn:Panel')).toBe(true);
      expect([...nodeQns].some((qn) => qn.includes('Skeleton') || qn.includes('Title'))).toBe(
        false,
      );
    });

    it('handles declaration-order-independent augmentations, preserves existing concrete JSX targets, and rejects augmentation-only objects', () => {
      const sourceFiles = [
        makeFile(
          'src/order-and-boundaries.tsx',
          [
            // Augmentation precedes hoisted FunctionDeclaration in source order -> order-independent positive control
            "PreAug.displayName = 'PreAug';",
            'export function PreAug() {',
            '  return <div />;',
            '}',
            // Existing concrete function target remains resolvable
            // despite a conditional property assignment.
            'export function NestedBlockAug() {',
            '  return <div />;',
            '}',
            'if (typeof globalThis !== "undefined") {',
            "  NestedBlockAug.displayName = 'Nested';",
            '}',
            // Augmentation-only / unmapped const object without concrete callable implementation -> rejected
            'export const OnlyObj: Record<string, unknown> = {};',
            "OnlyObj.displayName = 'OnlyObj';",
            // Existing JSX behavior for a concrete arrow initializer
            // with an explicit any assertion is preserved.
            'export const CastAnyAug = (() => <div />) as any;',
            "CastAnyAug.displayName = 'CastAny';",
          ].join('\n'),
        ),
        makeFile(
          'src/order-consumer.tsx',
          [
            "import { CastAnyAug, NestedBlockAug, OnlyObj, PreAug } from './order-and-boundaries';",
            'export function Consumer() {',
            '  return (',
            '    <section>',
            '      <PreAug />',
            '      <NestedBlockAug />',
            '      <OnlyObj />',
            '      <CastAnyAug />',
            '    </section>',
            '  );',
            '}',
          ].join('\n'),
        ),
      ];

      const withLibs = runInMemory(sourceFiles, { skipLoadingLibFiles: false });
      expect(summarizeCalls(withLibs.callEdges)).toEqual([
        'src/order-consumer.tsx::fn:Consumer -> src/order-and-boundaries.tsx::fn:CastAnyAug @L8',
        'src/order-consumer.tsx::fn:Consumer -> src/order-and-boundaries.tsx::fn:NestedBlockAug @L6',
        'src/order-consumer.tsx::fn:Consumer -> src/order-and-boundaries.tsx::fn:PreAug @L5',
      ]);
    });
  });

  describe('Part 6 — Source attribution matrix', () => {
    it('attributes all 14 lexical/definition-time constructs to their exact allocated enclosing scope', () => {
      const sourceFiles = [
        makeFile(
          'src/attribution.ts',
          [
            "import { memo } from 'react';",
            'export function ping(): number { return 1; }',
            'export function makeBase(): new () => object { return class {}; }',
            "export function makeKey(): string { return 'computed'; }",
            'export function classDec(_v: number) { return <T,>(target: T): T => target; }',
            'export function memberDec(_v: number) { return <T,>(target: T): T => target; }',
            'const topLevelVal = ping();',
            'const arrowA = () => ping(), arrowB = () => ping(), plainC = ping();',
            'export function outerWithDefault(x = ping()): number {',
            '  function nestedHelper(): number {',
            '    return ping();',
            '  }',
            '  const cb = [1].map(() => ping());',
            '  return x + nestedHelper() + cb.length;',
            '}',
            '@classDec(ping())',
            'export class Attributed extends makeBase() {',
            '  readonly fieldInit = ping();',
            '  static {',
            '    ping();',
            '  }',
            '  constructor() {',
            '    super();',
            '    ping();',
            '  }',
            '  @memberDec(ping())',
            '  instanceMethod(): number {',
            '    return ping();',
            '  }',
            '  static staticMethod(): number {',
            '    return ping();',
            '  }',
            '  [makeKey()](): number {',
            '    return ping();',
            '  }',
            '}',
            'export const HocComp = memo(() => {',
            '  ping();',
            '  return null;',
            '});',
            'void topLevelVal; void arrowA; void arrowB; void plainC;',
          ].join('\n'),
        ),
      ];

      const { callEdges } = runInMemory(sourceFiles);

      expect(summarizeCalls(callEdges)).toEqual([
        'file:src/attribution.ts -> src/attribution.ts::fn:classDec @L16',
        'file:src/attribution.ts -> src/attribution.ts::fn:makeBase @L17',
        'file:src/attribution.ts -> src/attribution.ts::fn:ping @L7',
        'file:src/attribution.ts -> src/attribution.ts::fn:ping @L8',
        'file:src/attribution.ts -> src/attribution.ts::fn:ping @L16',
        'src/attribution.ts::class:Attributed -> src/attribution.ts::fn:makeKey @L33',
        'src/attribution.ts::class:Attributed -> src/attribution.ts::fn:memberDec @L26',
        'src/attribution.ts::class:Attributed -> src/attribution.ts::fn:ping @L18',
        'src/attribution.ts::class:Attributed -> src/attribution.ts::fn:ping @L20',
        'src/attribution.ts::class:Attributed -> src/attribution.ts::fn:ping @L26',
        'src/attribution.ts::class:Attributed::ctor -> src/attribution.ts::fn:ping @L24',
        'src/attribution.ts::class:Attributed::method:[makeKey()] -> src/attribution.ts::fn:ping @L34',
        'src/attribution.ts::class:Attributed::method:instanceMethod -> src/attribution.ts::fn:ping @L28',
        'src/attribution.ts::class:Attributed::static:staticMethod -> src/attribution.ts::fn:ping @L31',
        'src/attribution.ts::fn:arrowA -> src/attribution.ts::fn:ping @L8',
        'src/attribution.ts::fn:arrowB -> src/attribution.ts::fn:ping @L8',
        'src/attribution.ts::fn:outerWithDefault -> src/attribution.ts::fn:ping @L9',
        'src/attribution.ts::fn:outerWithDefault -> src/attribution.ts::fn:ping @L11',
        'src/attribution.ts::fn:outerWithDefault -> src/attribution.ts::fn:ping @L13',
        'src/attribution.ts::sym:HocComp -> src/attribution.ts::fn:ping @L38',
      ]);
    });
  });

  describe('Part 7 — Edge metadata, truncation, invalid snippet caps, and determinism', () => {
    it('maintains LF/CRLF parity, multiline line numbers, context retention under truncation, default/small/zero caps, mixed edge ordering, and serializability', async () => {
      const longPad = 'z'.repeat(600);
      const lines = [
        "import { leaf } from './leaf';",
        'export function recurse(n: number): number {',
        `  const longBefore = '${longPad}';`,
        '  const sameLine = leaf(1) + leaf(2);',
        '  const multi = leaf(',
        '    n + 1,',
        '  );',
        `  const longCall = '${'a'.repeat(300)}' + leaf(99) + '${'b'.repeat(300)}';`,
        `  const longAfter = '${longPad}';`,
        '  const next = n > 0 ? recurse(n - 1) : 0;',
        '  return sameLine + multi + next + longBefore.length + longCall.length + longAfter.length;',
        '}',
      ];

      const lfDir = await createTempWorkspace({
        'src/leaf.ts': 'export function leaf(x: number): number { return x; }\n',
        'src/caller.ts': `${lines.join('\n')}\n`,
      });
      const crlfDir = await createTempWorkspace({
        'src/leaf.ts': 'export function leaf(x: number): number { return x; }\r\n',
        'src/caller.ts': `${lines.join('\r\n')}\r\n`,
      });

      const lfOut = await analyzeRepository({ rootDir: lfDir, skipLoadingLibFiles: true });
      const crlfOut = await analyzeRepository({ rootDir: crlfDir, skipLoadingLibFiles: true });

      // LF and CRLF produce identical nodes, edges, line numbers, hashes, snippets, and stats
      expect(crlfOut.nodes).toEqual(lfOut.nodes);
      expect(crlfOut.edges).toEqual(lfOut.edges);
      expect(JSON.parse(JSON.stringify(lfOut))).toEqual(lfOut);
      expect(lfOut.stats.importsEdgeCount).toBe(1);
      expect(lfOut.stats.callsEdgeCount).toBe(4);

      expect(
        lfOut.edges.map(
          (e) =>
            `${e.edgeType}:${e.sourceQualifiedName}->${e.targetQualifiedName}@${e.callSiteLine}`,
        ),
      ).toEqual([
        'IMPORTS:file:src/caller.ts->file:src/leaf.ts@null',
        'CALLS:src/caller.ts::fn:recurse->src/caller.ts::fn:recurse@10',
        'CALLS:src/caller.ts::fn:recurse->src/leaf.ts::fn:leaf@4',
        'CALLS:src/caller.ts::fn:recurse->src/leaf.ts::fn:leaf@5',
        'CALLS:src/caller.ts::fn:recurse->src/leaf.ts::fn:leaf@8',
      ]);

      // Default 512-char cap: long surrounding lines must NEVER push out the call-site line
      const line4Edge = lfOut.edges.find((e) => e.callSiteLine === 4);
      const line5Edge = lfOut.edges.find((e) => e.callSiteLine === 5);
      const line8Edge = lfOut.edges.find((e) => e.callSiteLine === 8);
      expect(line4Edge?.callSiteSnippet?.length).toBeLessThanOrEqual(
        DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
      );
      expect(line4Edge?.callSiteSnippet).toContain('const sameLine = leaf(1) + leaf(2);');
      expect(line5Edge?.callSiteSnippet).toContain('const multi = leaf(');
      expect(line8Edge?.callSiteSnippet?.length).toBeLessThanOrEqual(
        DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS,
      );
      expect(line8Edge?.callSiteSnippet).toContain('leaf(99)');

      // Small custom cap (40 chars) still retains call expression on the 600+ char line
      const smallCapOut = await analyzeRepository({
        rootDir: lfDir,
        skipLoadingLibFiles: true,
        maxCallSiteSnippetChars: 40,
      });
      const smallLine8 = smallCapOut.edges.find((e) => e.callSiteLine === 8);
      expect(smallLine8?.callSiteSnippet?.length).toBeLessThanOrEqual(40);
      expect(smallLine8?.callSiteSnippet).toContain('leaf(99)');

      // Zero-length cap is supported and produces empty snippets for all CALLS edges
      const zeroCapOut = await analyzeRepository({
        rootDir: lfDir,
        skipLoadingLibFiles: true,
        maxCallSiteSnippetChars: 0,
      });
      const zeroCalls = zeroCapOut.edges.filter((e) => e.edgeType === 'CALLS');
      expect(zeroCalls).toHaveLength(4);
      for (const edge of zeroCalls) {
        expect(edge.callSiteSnippet).toBe('');
      }
    });

    it('rejects negative, fractional, NaN, Infinity, and unsafe-integer maxCallSiteSnippetChars in both analyzeRepository and direct extractCallEdges', async () => {
      const sourceText =
        'export function a(): number { return 1; }\nexport function b(): number { return a(); }\n';
      const rootDir = await createTempWorkspace({
        'src/a.ts': sourceText,
      });

      const projectContext = createAnalysisProject({
        sourceFiles: [makeFile('src/a.ts', sourceText)],
        skipLoadingLibFiles: true,
      });
      const { declarationIndex } = extractNodesWithIndex({
        parsedFiles: projectContext.parsedFiles,
      });

      const invalidCaps = [
        -1,
        12.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ];

      for (const cap of invalidCaps) {
        await expect(
          analyzeRepository({
            rootDir,
            skipLoadingLibFiles: true,
            maxCallSiteSnippetChars: cap,
          }),
          `Expected analyzeRepository rejection for maxCallSiteSnippetChars=${String(cap)}`,
        ).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof CoreAnalysisError &&
            err.code === 'INVALID_WORKSPACE' &&
            err.message.includes('maxCallSiteSnippetChars'),
        );

        expect(
          () =>
            extractCallEdges({
              projectContext,
              declarationIndex,
              maxCallSiteSnippetChars: cap,
            }),
          `Expected extractCallEdges rejection for maxCallSiteSnippetChars=${String(cap)}`,
        ).toThrow(CoreAnalysisError);
      }
    });
  });

  describe('Part 8 — Negative cases and bundled stdlib mode comparison', () => {
    it('emits zero fabricated CALLS edges for external deps, Node built-ins, stdlib, malformed files, unresolved/nested/interface/dynamic/eval/duplicate calls', () => {
      const sourceFiles = [
        makeFile('src/broken.ts', 'export function badSyntax( { return ;;;\n'),
        makeFile(
          'src/dup.ts',
          'export function ambig(): number { return 1; } export function ambig(): number { return 2; }\n',
        ),
        makeFile(
          'src/negatives.ts',
          [
            "import { extFn } from 'uninstalled-pkg';",
            "import fs from 'node:fs';",
            "import { badSyntax } from './broken';",
            "import { ambig } from './dup';",
            'export interface OnlyIface { run(): number; }',
            'export class Svc { run(): number { return 1; } }',
            'export function testNegatives(iface: OnlyIface, svc: Svc, key: "run"): void {',
            '  function unmappedNested(): number { return 1; }',
            '  extFn();',
            "  fs.readFileSync('x');",
            '  Promise.resolve(1);',
            '  Math.max(1, 2);',
            '  new Map();',
            '  badSyntax();',
            '  ambig();',
            '  unmappedNested();',
            '  iface.run();',
            '  svc[key]();',
            "  svc['run']();",
            "  eval('1 + 1');",
            "  new Function('return 1')();",
            '  // @ts-expect-error unresolved identifier tested intentionally',
            '  totallyUnknownGlobal();',
            '}',
          ].join('\n'),
        ),
      ];

      const { importEdges, callEdges, projectContext } = runInMemory(sourceFiles, {
        skipLoadingLibFiles: false,
        allowSyntaxErrors: true,
      });

      expect(projectContext.skippedSyntaxErrorFilesCount).toBe(1);
      expect(
        projectContext.syntaxWarnings.some(
          (w) => w.code === 'SYNTAX_ERROR' && w.filePath === 'src/broken.ts',
        ),
      ).toBe(true);
      expect(projectContext.parsedVirtualPaths.has('/repo/src/broken.ts')).toBe(false);
      expect(importEdges.some((e) => e.targetQualifiedName === 'file:src/broken.ts')).toBe(false);
      expect(callEdges).toEqual([]);
    });

    it('compares skipLoadingLibFiles: false vs true honestly on Promise<T> and Array<T> method chains while never emitting stdlib edges', () => {
      const sourceFiles = [
        makeFile(
          'src/service.ts',
          [
            'export class RepoService {',
            '  fetch(): number { return 1; }',
            '}',
            'export function getSync(): RepoService {',
            '  return new RepoService();',
            '}',
            'export async function getAsync(): Promise<RepoService> {',
            '  return new RepoService();',
            '}',
          ].join('\n'),
        ),
        makeFile(
          'src/entry.ts',
          [
            "import { RepoService, getAsync, getSync } from './service';",
            'export async function run(list: Array<RepoService>): Promise<number> {',
            '  const direct = getSync().fetch();',
            '  const awaited = (await getAsync()).fetch();',
            '  const mapped = list.map((item) => item.fetch());',
            '  const stdVal = await Promise.resolve(Math.max(direct, awaited, mapped.length));',
            '  return stdVal;',
            '}',
          ].join('\n'),
        ),
      ];

      const withLibs = runInMemory(sourceFiles, { skipLoadingLibFiles: false });
      const withoutLibs = runInMemory(sourceFiles, { skipLoadingLibFiles: true });

      // With bundled TypeScript libs enabled: Promise<RepoService> and Array<RepoService>.map resolve `.fetch()` cleanly
      expect(summarizeCalls(withLibs.callEdges)).toEqual([
        'src/entry.ts::fn:run -> src/service.ts::class:RepoService::method:fetch @L3',
        'src/entry.ts::fn:run -> src/service.ts::class:RepoService::method:fetch @L4',
        'src/entry.ts::fn:run -> src/service.ts::class:RepoService::method:fetch @L5',
        'src/entry.ts::fn:run -> src/service.ts::fn:getAsync @L4',
        'src/entry.ts::fn:run -> src/service.ts::fn:getSync @L3',
        'src/service.ts::fn:getAsync -> src/service.ts::class:RepoService @L8',
        'src/service.ts::fn:getSync -> src/service.ts::class:RepoService @L5',
      ]);

      // With skipLoadingLibFiles: true: direct calls still resolve, while Promise/Array generic chains cannot resolve receiver type
      expect(summarizeCalls(withoutLibs.callEdges)).toEqual([
        'src/entry.ts::fn:run -> src/service.ts::class:RepoService::method:fetch @L3',
        'src/entry.ts::fn:run -> src/service.ts::fn:getAsync @L4',
        'src/entry.ts::fn:run -> src/service.ts::fn:getSync @L3',
        'src/service.ts::fn:getAsync -> src/service.ts::class:RepoService @L8',
        'src/service.ts::fn:getSync -> src/service.ts::class:RepoService @L5',
      ]);
    });
  });
});
