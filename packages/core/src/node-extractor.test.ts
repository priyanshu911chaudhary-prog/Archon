import { ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import type { LoadedWorkspaceFile } from './discovery.js';
import {
  extractNodesFromFiles,
  extractNodesWithIndex,
  findEnclosingScopeQualifiedName,
  type DeclarationNodeIndex,
} from './node-extractor.js';
import { createAnalysisProject } from './project.js';

function makeFile(relativePath: string, content: string): LoadedWorkspaceFile {
  return {
    relativePath,
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
  };
}

function findCallsByCalleeText(
  sf: ts.SourceFile,
  calleeText: string,
): readonly ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === calleeText) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return matches;
}

function findNewExpressionsByText(
  sf: ts.SourceFile,
  exprText: string,
): readonly ts.NewExpression[] {
  const matches: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(sf) === exprText) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return matches;
}

function findFirstIdentifierByText(sf: ts.SourceFile, name: string): ts.Identifier {
  const state = { match: undefined as ts.Identifier | undefined };
  const visit = (node: ts.Node): void => {
    if (state.match !== undefined) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === name) {
      state.match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  if (state.match === undefined) {
    throw new Error(`Expected identifier "${name}" in ${sf.fileName}`);
  }
  return state.match;
}

function resolveSymbolTargetQualifiedNames(
  checker: ts.TypeChecker,
  node: ts.Node,
  index: DeclarationNodeIndex,
): readonly string[] {
  const sym = checker.getSymbolAtLocation(node);
  if (sym === undefined) {
    return [];
  }
  const resolved = (sym.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(sym) : sym;
  const qns = new Set<string>();
  for (const decl of resolved.getDeclarations() ?? []) {
    const qn = index.declarationToQualifiedName.get(decl);
    if (qn !== undefined) {
      qns.add(qn);
    }
  }
  return [...qns];
}

function requireCompilerSourceFile(
  parsedFiles: readonly {
    readonly relativePath: string;
    readonly sourceFile: { readonly compilerNode: ts.SourceFile };
  }[],
  relativePath: string,
): ts.SourceFile {
  const entry = parsedFiles.find((item) => item.relativePath === relativePath);
  if (entry === undefined) {
    throw new Error(`Expected parsed file "${relativePath}"`);
  }
  return entry.sourceFile.compilerNode;
}

describe('extractNodesWithIndex and DeclarationNodeIndex', () => {
  it('produces identical ExtractedNode DTOs to extractNodesFromFiles and keeps nodeTypeByQualifiedName 1:1', () => {
    const sourceFiles: readonly LoadedWorkspaceFile[] = [
      makeFile(
        'src/lib/billing.ts',
        [
          'export function parse(v: string): number;',
          'export function parse(v: number): string;',
          'export function parse(v: string | number): string | number { return v; }',
          'export const arrowFn = (x: number) => x + 1;',
          'export const LIMIT = 100;',
          'export interface BillingConfig { currency: string; }',
          'export class Ledger {',
          '  constructor(id: string) { void id; }',
          '  record(n: number): number { return n; }',
          '  static create(): Ledger { return new Ledger("a"); }',
          '}',
        ].join('\n'),
      ),
      makeFile('src/anon.ts', 'export default () => 42;\n'),
    ];

    const ctx = createAnalysisProject({ sourceFiles, skipLoadingLibFiles: true });
    expect(ctx.syntaxWarnings).toEqual([]);
    expect(ctx.parsedFiles).toHaveLength(sourceFiles.length);
    const legacyNodes = extractNodesFromFiles({ parsedFiles: ctx.parsedFiles });
    const indexed = extractNodesWithIndex({ parsedFiles: ctx.parsedFiles });

    expect(indexed.nodes).toEqual(legacyNodes);
    expect(indexed.declarationIndex.nodeTypeByQualifiedName.size).toBe(indexed.nodes.length);
    for (const node of indexed.nodes) {
      expect(indexed.declarationIndex.nodeTypeByQualifiedName.get(node.qualifiedName)).toBe(
        node.nodeType,
      );
    }
  });

  it('resolves actual TypeChecker symbol and signature declarations against allocated index identities (overloads, arrows, classes, static/instance, constructors, defaults, CJS, JSX HOCs)', () => {
    const sourceFiles: readonly LoadedWorkspaceFile[] = [
      makeFile(
        'src/overloads.ts',
        [
          'export function format(v: string): string;',
          'export function format(v: number): string;',
          'export function format(v: string | number): string { return String(v); }',
          'export declare function ambientOnly(v: string): void;',
          'export declare function ambientOnly(v: number): void;',
        ].join('\n'),
      ),
      makeFile(
        'src/callables.ts',
        [
          'export const arrowAdd = (a: number, b: number) => a + b;',
          'export const exprSub = function (a: number, b: number) { return a - b; };',
          'export class AuthService {',
          '  constructor(secret: string);',
          '  constructor(secret: string, ttl?: number) { void secret; void ttl; }',
          '  verify(token: string): boolean;',
          '  verify(token: string, strict?: boolean): boolean { return Boolean(token && strict); }',
          '  static verify(raw: string): boolean { return raw.length > 0; }',
          '  runArrow = (x: number) => x * 2;',
          '  get label(): string { return "auth"; }',
          '  set label(_v: string) {}',
          '  static get label(): string { return "static-auth"; }',
          '}',
          'export class ImplicitCtorClass {',
          '  ping(): number { return 1; }',
          '}',
          'export const ExprClass = class {',
          '  constructor(id: string) { void id; }',
          '};',
        ].join('\n'),
      ),
      makeFile('src/anon-fn.ts', 'export default () => 1;\n'),
      makeFile('src/named-default.ts', 'export default function NamedDefault() { return 2; }\n'),
      makeFile(
        'src/anon-class.ts',
        'export default class { constructor(v: number) { void v; } }\n',
      ),
      makeFile(
        'src/cjs-lib.cjs',
        ['exports.inlineFn = (x) => x + 1;', 'exports.VERSION = "1.0.0";'].join('\n'),
      ),
      makeFile(
        'src/cjs-obj.cjs',
        [
          'module.exports = {',
          '  methodFn(x) { return x; },',
          '  propFn: (x) => x * 2,',
          '};',
        ].join('\n'),
      ),
      makeFile(
        'src/components.tsx',
        [
          "import React from 'react';",
          'export const FancyButton = React.forwardRef((props: { label: string }, _ref: unknown) => props.label);',
          'export const MemoCard = React.memo(React.forwardRef((props: { title: string }, _ref: unknown) => props.title));',
          'export const PLAIN_CONFIG = { theme: "dark" };',
          'export const MAX_ITEMS = 50;',
          'export interface ButtonProps { label: string; }',
          'export type CardTitle = string;',
          'export enum Status { Active = "active" }',
        ].join('\n'),
      ),
      makeFile(
        'src/consumer.ts',
        [
          "import { format, ambientOnly } from './overloads';",
          "import { arrowAdd, exprSub, AuthService, ImplicitCtorClass, ExprClass } from './callables';",
          "import anonFn from './anon-fn';",
          "import NamedDefault from './named-default';",
          "import AnonClass from './anon-class';",
          "import { FancyButton, MemoCard, PLAIN_CONFIG, MAX_ITEMS, Status } from './components';",
          "import type { ButtonProps, CardTitle } from './components';",
          'export function exercise(svc: AuthService, p?: ButtonProps, t?: CardTitle): void {',
          '  void p; void t; void PLAIN_CONFIG; void MAX_ITEMS; void Status;',
          '  void FancyButton; void MemoCard;',
          '  format("a");',
          '  format(1);',
          '  ambientOnly("x");',
          '  ambientOnly(2);',
          '  arrowAdd(1, 2);',
          '  exprSub(3, 1);',
          '  const a = new AuthService("s");',
          '  const b = new ImplicitCtorClass();',
          '  const c = new ExprClass("id");',
          '  const d = new AnonClass(1);',
          '  svc.verify("t");',
          '  svc.verify("t", true);',
          '  AuthService.verify("raw");',
          '  svc.runArrow(4);',
          '  anonFn();',
          '  NamedDefault();',
          '  void a; void b; void c; void d;',
          '}',
        ].join('\n'),
      ),
    ];

    const ctx = createAnalysisProject({ sourceFiles, skipLoadingLibFiles: true });
    expect(ctx.syntaxWarnings).toEqual([]);

    const { declarationIndex: idx } = extractNodesWithIndex({ parsedFiles: ctx.parsedFiles });
    const checker = ctx.project.getTypeChecker().compilerObject;
    const consumerSf = requireCompilerSourceFile(ctx.parsedFiles, 'src/consumer.ts');

    // 1. Function overloads: both call signatures map to the single implementation QN (not signature-only)
    const formatCalls = findCallsByCalleeText(consumerSf, 'format');
    expect(formatCalls).toHaveLength(2);
    for (const call of formatCalls) {
      const sigDecl = checker.getResolvedSignature(call)?.declaration;
      expect(sigDecl).toBeDefined();
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/overloads.ts::fn:format',
      );
    }
    expect(idx.signatureOnlyQualifiedNames.has('src/overloads.ts::fn:format')).toBe(false);

    // 2. Signature-only ambient overload group: both overloads map to QN AND marked signature-only
    const ambientCalls = findCallsByCalleeText(consumerSf, 'ambientOnly');
    expect(ambientCalls).toHaveLength(2);
    for (const call of ambientCalls) {
      const sigDecl = checker.getResolvedSignature(call)?.declaration;
      expect(sigDecl).toBeDefined();
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/overloads.ts::fn:ambientOnly',
      );
    }
    expect(idx.signatureOnlyQualifiedNames.has('src/overloads.ts::fn:ambientOnly')).toBe(true);

    // 3. Arrow function & function expression: both resolved signature AND symbol declaration map to allocated QN
    const arrowCall = findCallsByCalleeText(consumerSf, 'arrowAdd')[0];
    expect(arrowCall).toBeDefined();
    if (arrowCall !== undefined) {
      const sigDecl = checker.getResolvedSignature(arrowCall)?.declaration;
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/callables.ts::fn:arrowAdd',
      );
      expect(resolveSymbolTargetQualifiedNames(checker, arrowCall.expression, idx)).toEqual([
        'src/callables.ts::fn:arrowAdd',
      ]);
    }
    const exprCall = findCallsByCalleeText(consumerSf, 'exprSub')[0];
    expect(exprCall).toBeDefined();
    if (exprCall !== undefined) {
      const sigDecl = checker.getResolvedSignature(exprCall)?.declaration;
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/callables.ts::fn:exprSub',
      );
      expect(resolveSymbolTargetQualifiedNames(checker, exprCall.expression, idx)).toEqual([
        'src/callables.ts::fn:exprSub',
      ]);
    }

    // 4. Static vs instance methods (including overloads) and arrow class property
    const instanceVerifyCalls = findCallsByCalleeText(consumerSf, 'svc.verify');
    expect(instanceVerifyCalls).toHaveLength(2);
    for (const call of instanceVerifyCalls) {
      const sigDecl = checker.getResolvedSignature(call)?.declaration;
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/callables.ts::class:AuthService::method:verify',
      );
    }
    const staticVerifyCall = findCallsByCalleeText(consumerSf, 'AuthService.verify')[0];
    expect(staticVerifyCall).toBeDefined();
    if (staticVerifyCall !== undefined) {
      const sigDecl = checker.getResolvedSignature(staticVerifyCall)?.declaration;
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/callables.ts::class:AuthService::static:verify',
      );
    }
    const arrowPropCall = findCallsByCalleeText(consumerSf, 'svc.runArrow')[0];
    expect(arrowPropCall).toBeDefined();
    if (arrowPropCall !== undefined) {
      const sigDecl = checker.getResolvedSignature(arrowPropCall)?.declaration;
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/callables.ts::class:AuthService::method:runArrow',
      );
    }

    // 5. Explicit constructor mapping vs implicit constructor class (no fabricated ctor)
    const authNew = findNewExpressionsByText(consumerSf, 'AuthService')[0];
    expect(authNew).toBeDefined();
    if (authNew !== undefined) {
      const sigDecl = checker.getResolvedSignature(authNew)?.declaration;
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/callables.ts::class:AuthService::ctor',
      );
    }
    const implicitNew = findNewExpressionsByText(consumerSf, 'ImplicitCtorClass')[0];
    expect(implicitNew).toBeDefined();
    if (implicitNew !== undefined) {
      const clsSym = checker.getSymbolAtLocation(implicitNew.expression);
      const aliasedCls =
        clsSym !== undefined && (clsSym.flags & ts.SymbolFlags.Alias) !== 0
          ? checker.getAliasedSymbol(clsSym)
          : clsSym;
      const clsDecl = aliasedCls?.getDeclarations()?.[0];
      expect(clsDecl).toBeDefined();
      expect(clsDecl !== undefined ? idx.declarationToQualifiedName.get(clsDecl) : undefined).toBe(
        'src/callables.ts::class:ImplicitCtorClass',
      );
      expect(
        clsDecl !== undefined ? idx.classToConstructorQualifiedName.get(clsDecl) : undefined,
      ).toBeUndefined();
    }
    const exprClassNew = findNewExpressionsByText(consumerSf, 'ExprClass')[0];
    expect(exprClassNew).toBeDefined();
    if (exprClassNew !== undefined) {
      const sigDecl = checker.getResolvedSignature(exprClassNew)?.declaration;
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/callables.ts::class:ExprClass::ctor',
      );
    }
    const anonClassNew = findNewExpressionsByText(consumerSf, 'AnonClass')[0];
    expect(anonClassNew).toBeDefined();
    if (anonClassNew !== undefined) {
      const sigDecl = checker.getResolvedSignature(anonClassNew)?.declaration;
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/anon-class.ts::default::ctor',
      );
    }

    // 6. Anonymous & named default function exports
    const anonCall = findCallsByCalleeText(consumerSf, 'anonFn')[0];
    expect(anonCall).toBeDefined();
    if (anonCall !== undefined) {
      const sigDecl = checker.getResolvedSignature(anonCall)?.declaration;
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/anon-fn.ts::default',
      );
    }
    const namedDefaultCall = findCallsByCalleeText(consumerSf, 'NamedDefault')[0];
    expect(namedDefaultCall).toBeDefined();
    if (namedDefaultCall !== undefined) {
      const sigDecl = checker.getResolvedSignature(namedDefaultCall)?.declaration;
      expect(sigDecl !== undefined ? idx.declarationToQualifiedName.get(sigDecl) : undefined).toBe(
        'src/named-default.ts::fn:NamedDefault',
      );
    }

    // 7. Supported CommonJS inline function exports registered (and non-component CJS constant excluded)
    const cjsLibSf = requireCompilerSourceFile(ctx.parsedFiles, 'src/cjs-lib.cjs');
    const cjsInlineStmt = cjsLibSf.statements[0];
    const cjsConstStmt = cjsLibSf.statements[1];
    expect(
      cjsInlineStmt !== undefined ? idx.declarationToQualifiedName.get(cjsInlineStmt) : undefined,
    ).toBe('src/cjs-lib.cjs::fn:inlineFn');
    expect(
      cjsConstStmt !== undefined ? idx.declarationToQualifiedName.get(cjsConstStmt) : undefined,
    ).toBeUndefined();

    const cjsObjSf = requireCompilerSourceFile(ctx.parsedFiles, 'src/cjs-obj.cjs');
    const cjsObjValues = [...idx.declarationToQualifiedName.entries()]
      .filter(([node]) => node.getSourceFile() === cjsObjSf)
      .map(([, qn]) => qn);
    expect(new Set(cjsObjValues)).toEqual(
      new Set(['src/cjs-obj.cjs::fn:methodFn', 'src/cjs-obj.cjs::fn:propFn']),
    );

    // 8. JSX HOC-wrapped symbols eligible; arbitrary constants, interfaces, types & enums NOT in CALLS declaration index
    expect(
      resolveSymbolTargetQualifiedNames(
        checker,
        findFirstIdentifierByText(consumerSf, 'FancyButton'),
        idx,
      ),
    ).toEqual(['src/components.tsx::sym:FancyButton']);
    expect(
      resolveSymbolTargetQualifiedNames(
        checker,
        findFirstIdentifierByText(consumerSf, 'MemoCard'),
        idx,
      ),
    ).toEqual(['src/components.tsx::sym:MemoCard']);
    expect(idx.jsxEligibleSymbolQualifiedNames.has('src/components.tsx::sym:FancyButton')).toBe(
      true,
    );
    expect(idx.jsxEligibleSymbolQualifiedNames.has('src/components.tsx::sym:MemoCard')).toBe(true);

    for (const nonComponent of [
      'PLAIN_CONFIG',
      'MAX_ITEMS',
      'Status',
      'ButtonProps',
      'CardTitle',
    ]) {
      expect(
        resolveSymbolTargetQualifiedNames(
          checker,
          findFirstIdentifierByText(consumerSf, nonComponent),
          idx,
        ),
        `Expected ${nonComponent} to be excluded from declarationToQualifiedName`,
      ).toEqual([]);
    }
    expect(idx.jsxEligibleSymbolQualifiedNames.has('src/components.tsx::sym:PLAIN_CONFIG')).toBe(
      false,
    );
    expect(idx.jsxEligibleSymbolQualifiedNames.has('src/components.tsx::sym:MAX_ITEMS')).toBe(
      false,
    );
  });

  it('preserves collision-safe allocated identities for same-line duplicate declarations', () => {
    const sourceFiles: readonly LoadedWorkspaceFile[] = [
      makeFile(
        'src/same-line.ts',
        'export function dup() { return 1; } export function dup() { return 2; }\n',
      ),
    ];

    const ctx = createAnalysisProject({ sourceFiles, skipLoadingLibFiles: true });
    const { declarationIndex: idx } = extractNodesWithIndex({ parsedFiles: ctx.parsedFiles });
    const sf = requireCompilerSourceFile(ctx.parsedFiles, 'src/same-line.ts');

    const firstFn = sf.statements[0];
    const secondFn = sf.statements[1];
    expect(firstFn !== undefined ? idx.declarationToQualifiedName.get(firstFn) : undefined).toBe(
      'src/same-line.ts::fn:dup',
    );
    expect(secondFn !== undefined ? idx.declarationToQualifiedName.get(secondFn) : undefined).toBe(
      'src/same-line.ts::fn:dup@L1:C37',
    );
  });

  it('attributes nested callbacks, multi-declarator variable statements, class fields, computed keys, heritage clauses, and HOCs to the exact enclosing scope', () => {
    const sourceFiles: readonly LoadedWorkspaceFile[] = [
      makeFile(
        'src/scopes.ts',
        [
          "import * as React from 'react';",
          'function helper(): number { return 1; }',
          'function getBase(): new () => object { return class {}; }',
          'function makeKey(): string { return "dyn"; }',
          'const topResult = helper();',
          'const fnA = () => helper(), fnB = () => helper(), nonFnC = helper();',
          'export function outer(x = helper()): number {',
          '  return [1, 2].map(() => helper()).length + x;',
          '}',
          'export class Widget extends getBase() {',
          '  readonly fieldVal = helper();',
          '  arrowProp = () => helper();',
          '  [makeKey()](): number {',
          '    return [1].map(() => helper()).length;',
          '  }',
          '}',
          'export const Wrapped = React.forwardRef(() => helper());',
          'void topResult; void fnA; void fnB; void nonFnC;',
        ].join('\n'),
      ),
    ];

    const ctx = createAnalysisProject({ sourceFiles, skipLoadingLibFiles: true });
    const { declarationIndex: idx } = extractNodesWithIndex({ parsedFiles: ctx.parsedFiles });
    const sf = requireCompilerSourceFile(ctx.parsedFiles, 'src/scopes.ts');

    const helperCalls = findCallsByCalleeText(sf, 'helper');
    const scopes = helperCalls.map((call) => findEnclosingScopeQualifiedName(call, idx));

    expect(scopes).toEqual([
      'file:src/scopes.ts', // topResult = helper()
      'src/scopes.ts::fn:fnA', // fnA = () => helper()
      'src/scopes.ts::fn:fnB', // fnB = () => helper()
      'file:src/scopes.ts', // nonFnC = helper() in same VariableStatement
      'src/scopes.ts::fn:outer', // default parameter x = helper()
      'src/scopes.ts::fn:outer', // nested callback inside outer
      'src/scopes.ts::class:Widget', // non-arrow class field initializer
      'src/scopes.ts::class:Widget::method:arrowProp', // arrow class property body
      'src/scopes.ts::class:Widget::method:[makeKey()]', // nested callback inside computed-name method body
      'src/scopes.ts::sym:Wrapped', // inside recognized HOC forwardRef(...)
    ]);

    // Computed property name `[makeKey()]` belongs to class definition scope, NOT the method body
    const makeKeyCall = findCallsByCalleeText(sf, 'makeKey')[0];
    expect(makeKeyCall).toBeDefined();
    expect(
      makeKeyCall !== undefined ? findEnclosingScopeQualifiedName(makeKeyCall, idx) : null,
    ).toBe('src/scopes.ts::class:Widget');

    // Heritage clause `extends getBase()` belongs to file scope, NOT the class body
    const getBaseCall = findCallsByCalleeText(sf, 'getBase')[0];
    expect(getBaseCall).toBeDefined();
    expect(
      getBaseCall !== undefined ? findEnclosingScopeQualifiedName(getBaseCall, idx) : null,
    ).toBe('file:src/scopes.ts');
  });

  it('enforces React import-binding HOC eligibility and rejects unrelated, shadowed, type-only, and non-component wrappers while preserving symbol DTOs', () => {
    const sourceFiles: readonly LoadedWorkspaceFile[] = [
      makeFile(
        'src/valid-hocs.tsx',
        [
          "import React, { forwardRef as wrapRef, memo } from 'react';",
          "import * as ReactNs from 'react';",
          'function LocalComp() { return null; }',
          'const BaseRef = wrapRef(() => null);',
          'export const NamedMemo = memo(() => null);',
          'export const AliasedRef = wrapRef(() => null);',
          'export const DefaultReactMemo = React.memo(LocalComp);',
          'export const NamespaceNested = ReactNs.memo(ReactNs.forwardRef(() => null));',
          'export const ChainedMemo = memo(BaseRef);',
        ].join('\n'),
      ),
      makeFile(
        'src/invalid-hocs.tsx',
        [
          "import { memo as otherMemo } from 'other-lib';",
          "import type { forwardRef as typeOnlyRef } from 'react';",
          "import { type memo as inlineTypeMemo, memo as realMemo } from 'react';",
          'function localMemo<T>(x: T): T { return x; }',
          'const obj = { memo: <T,>(x: T): T => x, forwardRef: <T,>(x: T): T => x };',
          'const PLAIN_OBJ = { a: 1 };',
          'export const FromOtherLib = otherMemo(() => null);',
          'export const FromLocalFn = localMemo(() => null);',
          'export const FromArbitraryObj = obj.memo(() => null);',
          'export const FromObjForwardRef = obj.forwardRef(() => null);',
          'export const NonComponentArg = realMemo(PLAIN_OBJ);',
          'export const LiteralArg = realMemo(42);',
          'export type UnusedTypeRef = typeof typeOnlyRef | typeof inlineTypeMemo;',
        ].join('\n'),
      ),
      makeFile(
        'src/shadowed-react.tsx',
        [
          "import React, { memo } from 'react';",
          'const React = { memo: <T,>(x: T): T => x };',
          'function memo<T>(x: T): T { return x; }',
          'export const ShadowedDefault = React.memo(() => null);',
          'export const ShadowedNamed = memo(() => null);',
        ].join('\n'),
      ),
    ];

    const ctx = createAnalysisProject({ sourceFiles, skipLoadingLibFiles: true });
    const { nodes, declarationIndex: idx } = extractNodesWithIndex({
      parsedFiles: ctx.parsedFiles,
    });

    const nodeQns = new Set(nodes.map((n) => n.qualifiedName));

    // All valid React-import HOC forms are eligible
    const expectedValid = [
      'src/valid-hocs.tsx::sym:NamedMemo',
      'src/valid-hocs.tsx::sym:AliasedRef',
      'src/valid-hocs.tsx::sym:DefaultReactMemo',
      'src/valid-hocs.tsx::sym:NamespaceNested',
      'src/valid-hocs.tsx::sym:ChainedMemo',
    ];
    for (const qn of expectedValid) {
      expect(nodeQns.has(qn), `Expected symbol DTO ${qn}`).toBe(true);
      expect(idx.jsxEligibleSymbolQualifiedNames.has(qn), `Expected JSX-eligible ${qn}`).toBe(true);
    }

    // All invalid/shadowed wrappers STILL emit symbol DTOs, but are NOT JSX-eligible
    const expectedInvalid = [
      'src/invalid-hocs.tsx::sym:FromOtherLib',
      'src/invalid-hocs.tsx::sym:FromLocalFn',
      'src/invalid-hocs.tsx::sym:FromArbitraryObj',
      'src/invalid-hocs.tsx::sym:FromObjForwardRef',
      'src/invalid-hocs.tsx::sym:NonComponentArg',
      'src/invalid-hocs.tsx::sym:LiteralArg',
      'src/shadowed-react.tsx::sym:ShadowedDefault',
      'src/shadowed-react.tsx::sym:ShadowedNamed',
    ];
    for (const qn of expectedInvalid) {
      expect(nodeQns.has(qn), `Expected preserved symbol DTO ${qn}`).toBe(true);
      expect(idx.jsxEligibleSymbolQualifiedNames.has(qn), `Expected excluded ${qn}`).toBe(false);
    }
  });
});
