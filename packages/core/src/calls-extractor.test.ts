import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.js';
import { extractCallEdges } from './calls-extractor.js';
import type { LoadedWorkspaceFile } from './discovery.js';
import { extractNodesWithIndex } from './node-extractor.js';
import { createAnalysisProject } from './project.js';
import { loadWorkspaceTsConfigs } from './tsconfig-loader.js';
import type { ExtractedEdge } from './types.js';

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

function runInMemoryCalls(
  sourceFiles: readonly LoadedWorkspaceFile[],
  configFiles: readonly LoadedWorkspaceFile[] = [],
  options: {
    readonly maxCallSiteSnippetChars?: number;
    readonly skipLoadingLibFiles?: boolean;
  } = {},
) {
  const tsConfigs = loadWorkspaceTsConfigs(configFiles);
  const projectContext = createAnalysisProject({
    sourceFiles,
    configsByDir: tsConfigs.configsByDir,
    skipLoadingLibFiles: options.skipLoadingLibFiles ?? true,
  });
  expect(projectContext.syntaxWarnings).toEqual([]);
  expect(projectContext.parsedFiles).toHaveLength(sourceFiles.length);
  const { nodes, declarationIndex } = extractNodesWithIndex({
    parsedFiles: projectContext.parsedFiles,
  });
  const callEdges = extractCallEdges({
    projectContext,
    declarationIndex,
    maxCallSiteSnippetChars: options.maxCallSiteSnippetChars,
  });

  const nodeSet = new Set(nodes.map((n) => n.qualifiedName));
  for (const edge of callEdges) {
    expect(
      nodeSet.has(edge.sourceQualifiedName),
      `Missing source ${edge.sourceQualifiedName}`,
    ).toBe(true);
    expect(
      nodeSet.has(edge.targetQualifiedName),
      `Missing target ${edge.targetQualifiedName}`,
    ).toBe(true);
  }

  return { nodes, callEdges, projectContext };
}

describe('extractCallEdges (Batch 4.2b.2 focused functional smoke tests)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('extracts local calls, recursive self-edges, imported aliases, barrel targets, typed methods, static methods, and this.method()', () => {
    const configFiles = [
      makeFile(
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            paths: { '@/*': ['./src/*'] },
          },
        }),
      ),
    ];

    const sourceFiles = [
      makeFile(
        'src/math/impl.ts',
        ['export function double(n: number): number {', '  return n * 2;', '}'].join('\n'),
      ),
      makeFile('src/math/index.ts', "export { double } from './impl';\n"),
      makeFile(
        'src/service.ts',
        [
          'export class CalcService {',
          '  private step(n: number): number {',
          '    return n + 1;',
          '  }',
          '  compute(n: number): number {',
          '    return this.step(n);',
          '  }',
          '  static tag(): string {',
          '    return "calc";',
          '  }',
          '}',
        ].join('\n'),
      ),
      makeFile(
        'src/app.ts',
        [
          "import { double as twice } from '@/math';",
          "import { CalcService } from './service';",
          'function factorial(n: number): number {',
          '  if (n <= 1) return 1;',
          '  return n * factorial(n - 1);',
          '}',
          'export function run(svc: CalcService): number {',
          '  const a = factorial(3);',
          '  const b = twice(a);',
          '  const c = svc.compute(b);',
          '  void CalcService.tag();',
          '  return c;',
          '}',
        ].join('\n'),
      ),
    ];

    const { callEdges } = runInMemoryCalls(sourceFiles, configFiles);

    expect(summarizeCalls(callEdges)).toEqual([
      'src/app.ts::fn:factorial -> src/app.ts::fn:factorial @L5',
      'src/app.ts::fn:run -> src/app.ts::fn:factorial @L8',
      'src/app.ts::fn:run -> src/math/impl.ts::fn:double @L9',
      'src/app.ts::fn:run -> src/service.ts::class:CalcService::method:compute @L10',
      'src/app.ts::fn:run -> src/service.ts::class:CalcService::static:tag @L11',
      'src/service.ts::class:CalcService::method:compute -> src/service.ts::class:CalcService::method:step @L6',
    ]);
  });

  it('enforces explicit, implicit, inherited constructor policy, valid vs invalid super(), and rejects ambient/abstract direct instantiation', () => {
    const sourceFiles = [
      makeFile(
        'src/classes.ts',
        [
          'export class BaseWithCtor {',
          '  constructor(public id: string) {}',
          '  greet(): string { return this.id; }',
          '}',
          'export class DerivedImplicit extends BaseWithCtor {}',
          'export class DerivedExplicit extends BaseWithCtor {',
          '  constructor(id: string) {',
          '    super(id);',
          '  }',
          '  badMethod(): void {',
          '    super("invalid-outside-ctor");',
          '  }',
          '  validSuperMethod(): string {',
          '    return super.greet();',
          '  }',
          '}',
          'export class PlainImplicit {}',
          'export abstract class AbstractBase {',
          '  constructor() {}',
          '}',
          'export class ConcreteFromAbstract extends AbstractBase {',
          '  constructor() {',
          '    super();',
          '  }',
          '}',
          'export declare class AmbientExternal {',
          '  constructor();',
          '}',
          'export function instantiate(): void {',
          '  new BaseWithCtor("a");',
          '  new DerivedImplicit("b");',
          '  new DerivedExplicit("c");',
          '  new PlainImplicit();',
          '  new AbstractBase();',
          '  new AmbientExternal();',
          '}',
        ].join('\n'),
      ),
    ];

    const { callEdges } = runInMemoryCalls(sourceFiles);

    expect(summarizeCalls(callEdges)).toEqual([
      'src/classes.ts::class:ConcreteFromAbstract::ctor -> src/classes.ts::class:AbstractBase::ctor @L23',
      'src/classes.ts::class:DerivedExplicit::ctor -> src/classes.ts::class:BaseWithCtor::ctor @L8',
      'src/classes.ts::class:DerivedExplicit::method:validSuperMethod -> src/classes.ts::class:BaseWithCtor::method:greet @L14',
      'src/classes.ts::fn:instantiate -> src/classes.ts::class:BaseWithCtor::ctor @L30',
      // DerivedImplicit has NO own constructor -> targets DerivedImplicit class node, NEVER BaseWithCtor::ctor
      'src/classes.ts::fn:instantiate -> src/classes.ts::class:DerivedExplicit::ctor @L32',
      'src/classes.ts::fn:instantiate -> src/classes.ts::class:DerivedImplicit @L31',
      'src/classes.ts::fn:instantiate -> src/classes.ts::class:PlainImplicit @L33',
    ]);
  });

  it('emits JSX static component usage edges for function/class components and approved React HOCs while rejecting intrinsic and non-React wrappers', () => {
    const sourceFiles = [
      makeFile(
        'src/ui.tsx',
        [
          "import React, { forwardRef as wrapRef, memo } from 'react';",
          "import { memo as fakeMemo } from 'other-lib';",
          'export function FnButton() { return <div />; }',
          'export class ClassPanel { render() { return <span />; } }',
          'export const RefInput = wrapRef(() => <input />);',
          'export const MemoCard = React.memo(React.forwardRef(() => <div />));',
          'export const LocalWrapped = memo(FnButton);',
          'const localObj = { memo: <T,>(x: T): T => x };',
          'const PLAIN = { label: "x" };',
          'export const FakeLibComp = fakeMemo(() => <div />);',
          'export const FakeObjComp = localObj.memo(() => <div />);',
          'export const NonCompArg = memo(PLAIN);',
        ].join('\n'),
      ),
      makeFile(
        'src/page.tsx',
        [
          "import { FnButton, ClassPanel, RefInput, MemoCard, LocalWrapped, FakeLibComp, FakeObjComp, NonCompArg } from './ui';",
          'export function Page() {',
          '  return (',
          '    <div>',
          '      <svg:path />',
          '      <FnButton />',
          '      <ClassPanel />',
          '      <RefInput />',
          '      <MemoCard />',
          '      <LocalWrapped />',
          '      <FakeLibComp />',
          '      <FakeObjComp />',
          '      <NonCompArg />',
          '    </div>',
          '  );',
          '}',
        ].join('\n'),
      ),
    ];

    const { callEdges } = runInMemoryCalls(sourceFiles);

    expect(summarizeCalls(callEdges)).toEqual([
      'src/page.tsx::fn:Page -> src/ui.tsx::class:ClassPanel @L7',
      'src/page.tsx::fn:Page -> src/ui.tsx::fn:FnButton @L6',
      'src/page.tsx::fn:Page -> src/ui.tsx::sym:LocalWrapped @L10',
      'src/page.tsx::fn:Page -> src/ui.tsx::sym:MemoCard @L9',
      'src/page.tsx::fn:Page -> src/ui.tsx::sym:RefInput @L8',
    ]);
  });

  it('rejects unresolved, external, signature-only, ambiguous union/interface targets, and explicit any/unknown assertion bypasses while preserving valid annotated & shared-base calls', () => {
    const sourceFiles = [
      makeFile(
        'src/targets.ts',
        [
          "import { extCall } from 'uninstalled-pkg';",
          'export function helper(): number { return 1; }',
          'export type Handler = (x: number) => number;',
          'export const typedArrow: Handler = (x) => x + 1;',
          'export declare function ambientFn(): number;',
          'export interface IRunner { run(): number; }',
          'export class SharedBase {',
          '  shared(): number { return 1; }',
          '}',
          'export class SubA extends SharedBase {',
          '  run(): number { return 2; }',
          '}',
          'export class SubB extends SharedBase {',
          '  run(): number { return 3; }',
          '}',
          'export function testAll(',
          '  aOrB: SubA | SubB,',
          '  subOrIface: SubA | IRunner,',
          '  maybeSub: SubA | null,',
          '  anyVal: any,',
          '  cb: () => number,',
          '): void {',
          '  // Valid calls: annotated arrow, parenthesized, non-null, shared inherited union method',
          '  typedArrow(1);',
          '  (helper)();',
          '  (maybeSub!).run();',
          '  aOrB.shared();',
          '  // Rejected calls: any/unknown assertion bypasses, ambiguous unions, external, ambient, HOF param',
          '  (helper as any)();',
          '  (helper as unknown)();',
          '  (maybeSub as any).run();',
          '  (maybeSub!.run as any)();',
          '  new (SubA as any)();',
          '  aOrB.run();',
          '  subOrIface.run();',
          '  anyVal.run();',
          '  extCall();',
          '  ambientFn();',
          '  cb();',
          '}',
        ].join('\n'),
      ),
    ];

    const { callEdges } = runInMemoryCalls(sourceFiles);

    expect(summarizeCalls(callEdges)).toEqual([
      'src/targets.ts::fn:testAll -> src/targets.ts::class:SharedBase::method:shared @L27',
      'src/targets.ts::fn:testAll -> src/targets.ts::class:SubA::method:run @L26',
      'src/targets.ts::fn:testAll -> src/targets.ts::fn:helper @L25',
      'src/targets.ts::fn:testAll -> src/targets.ts::fn:typedArrow @L24',
    ]);
  });

  it('deduplicates same-line calls, preserves different-line calls, normalizes CRLF snippets, and retains the call site under small snippet caps', () => {
    const padding = 'x'.repeat(80);
    const sourceText = [
      'export function ping(n: number): number { return n; }',
      'export function caller(): number {',
      '  const a = ping(1) + ping(2);',
      '  const b = ping(3);',
      `  const c = "${padding}" + ping(4) + "${padding}";`,
      '  return a + b + c.length;',
      '}',
    ].join('\r\n');

    const { callEdges } = runInMemoryCalls([makeFile('src/lines.ts', sourceText)], [], {
      maxCallSiteSnippetChars: 60,
    });

    expect(summarizeCalls(callEdges)).toEqual([
      'src/lines.ts::fn:caller -> src/lines.ts::fn:ping @L3',
      'src/lines.ts::fn:caller -> src/lines.ts::fn:ping @L4',
      'src/lines.ts::fn:caller -> src/lines.ts::fn:ping @L5',
    ]);

    for (const edge of callEdges) {
      expect(edge.callSiteSnippet).not.toBeNull();
      expect(edge.callSiteSnippet?.length).toBeLessThanOrEqual(60);
      expect(edge.callSiteSnippet).not.toContain('\r');
    }

    const line3Edge = callEdges.find((e) => e.callSiteLine === 3);
    const line5Edge = callEdges.find((e) => e.callSiteLine === 5);
    expect(line3Edge?.callSiteSnippet).toContain('ping(1) + ping(2)');
    expect(line5Edge?.callSiteSnippet).toContain('ping(4)');
  });

  it('integrates IMPORTS and CALLS cleanly through analyzeRepository with accurate per-edge-type stats and determinism', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-calls-analyzer-'));
    tempDirs.push(dir);
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'src', 'helper.ts'),
      'export function leaf(n: number): number { return n + 1; }\n',
      'utf8',
    );
    await writeFile(
      path.join(dir, 'src', 'main.ts'),
      [
        "import { leaf } from './helper';",
        'export function entry(): number {',
        '  return leaf(10);',
        '}',
      ].join('\n'),
      'utf8',
    );

    const run1 = await analyzeRepository({ rootDir: dir, skipLoadingLibFiles: true });
    const run2 = await analyzeRepository({ rootDir: dir, skipLoadingLibFiles: true });

    expect(run1).toEqual(run2);
    expect(run1.stats.importsEdgeCount).toBe(1);
    expect(run1.stats.callsEdgeCount).toBe(1);
    expect(run1.edges).toHaveLength(2);

    const nodeSet = new Set(run1.nodes.map((n) => n.qualifiedName));
    for (const edge of run1.edges) {
      expect(nodeSet.has(edge.sourceQualifiedName)).toBe(true);
      expect(nodeSet.has(edge.targetQualifiedName)).toBe(true);
    }

    const importEdge = run1.edges.find((e) => e.edgeType === 'IMPORTS');
    const callEdge = run1.edges.find((e) => e.edgeType === 'CALLS');

    expect(importEdge).toEqual({
      sourceQualifiedName: 'file:src/main.ts',
      targetQualifiedName: 'file:src/helper.ts',
      edgeType: 'IMPORTS',
      callSiteLine: null,
      callSiteSnippet: null,
    });
    expect(callEdge?.sourceQualifiedName).toBe('src/main.ts::fn:entry');
    expect(callEdge?.targetQualifiedName).toBe('src/helper.ts::fn:leaf');
    expect(callEdge?.callSiteLine).toBe(3);
    expect(callEdge?.callSiteSnippet).toContain('return leaf(10);');
  });
});
