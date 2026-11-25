import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.js';
import { extractCallEdges } from './calls-extractor.js';
import type { LoadedWorkspaceFile } from './discovery.js';
import { extractImportEdges } from './imports-extractor.js';
import { extractNodesWithIndex } from './node-extractor.js';
import { createAnalysisProject } from './project.js';
import { loadWorkspaceTsConfigs } from './tsconfig-loader.js';
import type { AnalysisOutput, ExtractedEdge, NodeType } from './types.js';

interface ExpectedNodeIdentity {
  readonly qualifiedName: string;
  readonly nodeType: NodeType;
  readonly parentQualifiedName: string | null;
  readonly isExported: boolean;
}

interface ExpectedEdgeSummary {
  readonly sourceQualifiedName: string;
  readonly targetQualifiedName: string;
  readonly edgeType: 'IMPORTS' | 'CALLS';
  readonly callSiteLine: number | null;
}

function makeFile(relativePath: string, content: string): LoadedWorkspaceFile {
  return {
    relativePath,
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
  };
}

function summarizeEdge(edge: ExtractedEdge): ExpectedEdgeSummary {
  return {
    sourceQualifiedName: edge.sourceQualifiedName,
    targetQualifiedName: edge.targetQualifiedName,
    edgeType: edge.edgeType,
    callSiteLine: edge.callSiteLine,
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

function assertEndpointsExist(nodeQns: ReadonlySet<string>, edges: readonly ExtractedEdge[]): void {
  for (const edge of edges) {
    expect(
      nodeQns.has(edge.sourceQualifiedName),
      `Missing source ${edge.sourceQualifiedName}`,
    ).toBe(true);
    expect(
      nodeQns.has(edge.targetQualifiedName),
      `Missing target ${edge.targetQualifiedName}`,
    ).toBe(true);
  }
}

function runInMemoryPipeline(
  sourceFiles: readonly LoadedWorkspaceFile[],
  configFiles: readonly LoadedWorkspaceFile[] = [],
  options: { readonly skipLoadingLibFiles?: boolean } = {},
) {
  const tsConfigs = loadWorkspaceTsConfigs(configFiles);
  expect(tsConfigs.warnings).toEqual([]);

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
  const importEdges = extractImportEdges({
    parsedFiles: projectContext.parsedFiles,
    resolver: projectContext.resolver,
  });
  const callEdges = extractCallEdges({
    projectContext,
    declarationIndex,
  });

  const nodeQns = new Set(nodes.map((n) => n.qualifiedName));
  assertEndpointsExist(nodeQns, importEdges);
  assertEndpointsExist(nodeQns, callEdges);

  return { nodes, importEdges, callEdges, declarationIndex };
}

describe('CALLS golden fixtures and declaration-resolution matrix (Batch 4.2b.3 Part A)', () => {
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
    const dir = await mkdtemp(path.join(os.tmpdir(), 'archon-golden-'));
    tempDirs.push(dir);
    for (const [relPosixPath, content] of Object.entries(files)) {
      const absPath = path.join(dir, ...relPosixPath.split('/'));
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    }
    return dir;
  }

  describe('Part 1 — Independent multi-file golden graph', () => {
    it('matches independently specified nodes, parents, IMPORTS, CALLS, line numbers, stats, serializability, and determinism', async () => {
      const rootDir = await createTempWorkspace({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            paths: {
              '@/*': ['./src/*'],
            },
          },
        }),
        'src/utils/format.ts': [
          'export function formatAmount(cents: number): string {',
          '  return "$" + (cents / 100).toFixed(2);',
          '}',
          'export const clamp = (value: number, max: number): number => (value > max ? max : value);',
        ].join('\n'),
        'src/utils/index.ts': "export { formatAmount, clamp } from './format';\n",
        'src/models/audit.ts': [
          'export class AuditContext {',
          '  label(): string {',
          "    return 'audit';",
          '  }',
          '}',
          'export class BillingEngine {',
          '  constructor(private readonly taxRate: number) {}',
          '  private applyTax(cents: number): number {',
          '    return Math.round(cents * (1 + this.taxRate));',
          '  }',
          '  calculateTotal(cents: number): number {',
          '    return this.applyTax(cents);',
          '  }',
          '  static defaultRate(): number {',
          '    return 0.18;',
          '  }',
          '}',
        ].join('\n'),
        'src/services/invoice.ts': [
          "import { trackEvent } from 'uninstalled-analytics';",
          "import { clamp, formatAmount } from '@/utils';",
          "import { AuditContext, BillingEngine } from '@/models/audit';",
          'export function buildInvoiceSummary(rawCents: number): string {',
          '  const ctx = new AuditContext();',
          '  const engine = new BillingEngine(BillingEngine.defaultRate());',
          '  const bounded = clamp(rawCents, 10000);',
          '  const total = engine.calculateTotal(bounded);',
          "  const tag = [1].map(() => ctx.label())[0] ?? '';",
          "  trackEvent('invoice.built', total);",
          "  return tag + ':' + formatAmount(total);",
          '}',
        ].join('\n'),
        'src/components/Badge.tsx': [
          "import React from 'react';",
          'export function PriceTag(props: { text: string }) {',
          '  return <span>{props.text}</span>;',
          '}',
          'export const HighlightBadge = React.memo((props: { text: string }) => <PriceTag text={props.text} />);',
        ].join('\n'),
        'src/components/InvoiceCard.tsx': [
          "import { buildInvoiceSummary } from '@/services/invoice';",
          "import { HighlightBadge, PriceTag } from './Badge';",
          'export function InvoiceCard(props: { cents: number }) {',
          '  const summary = buildInvoiceSummary(props.cents);',
          '  return (',
          '    <section>',
          '      <PriceTag text={summary} />',
          '      <HighlightBadge text={summary} />',
          '    </section>',
          '  );',
          '}',
        ].join('\n'),
        'src/index.tsx': [
          "import { InvoiceCard } from '@/components/InvoiceCard';",
          "import { formatAmount } from '@/utils';",
          'export function renderApp(cents: number) {',
          '  return <InvoiceCard cents={cents} />;',
          '}',
          'export const INITIAL_LABEL = formatAmount(500);',
        ].join('\n'),
      });

      const run1: AnalysisOutput = await analyzeRepository({ rootDir });
      const run2: AnalysisOutput = await analyzeRepository({ rootDir });

      // Determinism & pure JSON serializability (no AST objects leaked into AnalysisOutput)
      expect(run1).toEqual(run2);
      expect(JSON.parse(JSON.stringify(run1))).toEqual(run1);

      // Fixture validity checks before inspecting graph contents
      expect(run1.warnings).toEqual([]);
      expect(run1.stats.discoveredFilesCount).toBe(7);
      expect(run1.stats.parsedFilesCount).toBe(7);
      expect(run1.stats.skippedSyntaxErrorFilesCount).toBe(0);
      expect(run1.stats.configFilesCount).toBe(1);

      // Independently authored node identities & parent hierarchy (exact sorted order)
      const expectedNodes: readonly ExpectedNodeIdentity[] = [
        // Folder nodes (sorted by qualifiedName)
        {
          qualifiedName: 'folder:src',
          nodeType: 'folder',
          parentQualifiedName: null,
          isExported: false,
        },
        {
          qualifiedName: 'folder:src/components',
          nodeType: 'folder',
          parentQualifiedName: 'folder:src',
          isExported: false,
        },
        {
          qualifiedName: 'folder:src/models',
          nodeType: 'folder',
          parentQualifiedName: 'folder:src',
          isExported: false,
        },
        {
          qualifiedName: 'folder:src/services',
          nodeType: 'folder',
          parentQualifiedName: 'folder:src',
          isExported: false,
        },
        {
          qualifiedName: 'folder:src/utils',
          nodeType: 'folder',
          parentQualifiedName: 'folder:src',
          isExported: false,
        },
        // File nodes (sorted by qualifiedName)
        {
          qualifiedName: 'file:src/components/Badge.tsx',
          nodeType: 'file',
          parentQualifiedName: 'folder:src/components',
          isExported: false,
        },
        {
          qualifiedName: 'file:src/components/InvoiceCard.tsx',
          nodeType: 'file',
          parentQualifiedName: 'folder:src/components',
          isExported: false,
        },
        {
          qualifiedName: 'file:src/index.tsx',
          nodeType: 'file',
          parentQualifiedName: 'folder:src',
          isExported: false,
        },
        {
          qualifiedName: 'file:src/models/audit.ts',
          nodeType: 'file',
          parentQualifiedName: 'folder:src/models',
          isExported: false,
        },
        {
          qualifiedName: 'file:src/services/invoice.ts',
          nodeType: 'file',
          parentQualifiedName: 'folder:src/services',
          isExported: false,
        },
        {
          qualifiedName: 'file:src/utils/format.ts',
          nodeType: 'file',
          parentQualifiedName: 'folder:src/utils',
          isExported: false,
        },
        {
          qualifiedName: 'file:src/utils/index.ts',
          nodeType: 'file',
          parentQualifiedName: 'folder:src/utils',
          isExported: false,
        },
        // Declaration nodes (sorted by qualifiedName)
        {
          qualifiedName: 'src/components/Badge.tsx::fn:PriceTag',
          nodeType: 'function',
          parentQualifiedName: 'file:src/components/Badge.tsx',
          isExported: true,
        },
        {
          qualifiedName: 'src/components/Badge.tsx::sym:HighlightBadge',
          nodeType: 'symbol',
          parentQualifiedName: 'file:src/components/Badge.tsx',
          isExported: true,
        },
        {
          qualifiedName: 'src/components/InvoiceCard.tsx::fn:InvoiceCard',
          nodeType: 'function',
          parentQualifiedName: 'file:src/components/InvoiceCard.tsx',
          isExported: true,
        },
        {
          qualifiedName: 'src/index.tsx::fn:renderApp',
          nodeType: 'function',
          parentQualifiedName: 'file:src/index.tsx',
          isExported: true,
        },
        {
          qualifiedName: 'src/index.tsx::sym:INITIAL_LABEL',
          nodeType: 'symbol',
          parentQualifiedName: 'file:src/index.tsx',
          isExported: true,
        },
        {
          qualifiedName: 'src/models/audit.ts::class:AuditContext',
          nodeType: 'class',
          parentQualifiedName: 'file:src/models/audit.ts',
          isExported: true,
        },
        {
          qualifiedName: 'src/models/audit.ts::class:AuditContext::method:label',
          nodeType: 'function',
          parentQualifiedName: 'src/models/audit.ts::class:AuditContext',
          isExported: false,
        },
        {
          qualifiedName: 'src/models/audit.ts::class:BillingEngine',
          nodeType: 'class',
          parentQualifiedName: 'file:src/models/audit.ts',
          isExported: true,
        },
        {
          qualifiedName: 'src/models/audit.ts::class:BillingEngine::ctor',
          nodeType: 'function',
          parentQualifiedName: 'src/models/audit.ts::class:BillingEngine',
          isExported: false,
        },
        {
          qualifiedName: 'src/models/audit.ts::class:BillingEngine::method:applyTax',
          nodeType: 'function',
          parentQualifiedName: 'src/models/audit.ts::class:BillingEngine',
          isExported: false,
        },
        {
          qualifiedName: 'src/models/audit.ts::class:BillingEngine::method:calculateTotal',
          nodeType: 'function',
          parentQualifiedName: 'src/models/audit.ts::class:BillingEngine',
          isExported: false,
        },
        {
          qualifiedName: 'src/models/audit.ts::class:BillingEngine::static:defaultRate',
          nodeType: 'function',
          parentQualifiedName: 'src/models/audit.ts::class:BillingEngine',
          isExported: false,
        },
        {
          qualifiedName: 'src/services/invoice.ts::fn:buildInvoiceSummary',
          nodeType: 'function',
          parentQualifiedName: 'file:src/services/invoice.ts',
          isExported: true,
        },
        {
          qualifiedName: 'src/utils/format.ts::fn:clamp',
          nodeType: 'function',
          parentQualifiedName: 'file:src/utils/format.ts',
          isExported: true,
        },
        {
          qualifiedName: 'src/utils/format.ts::fn:formatAmount',
          nodeType: 'function',
          parentQualifiedName: 'file:src/utils/format.ts',
          isExported: true,
        },
      ];

      expect(
        run1.nodes.map((n) => ({
          qualifiedName: n.qualifiedName,
          nodeType: n.nodeType,
          parentQualifiedName: n.parentQualifiedName,
          isExported: n.isExported,
        })),
      ).toEqual(expectedNodes);

      // Independently authored exact combined edge set (sorted by source, target, edgeType, callSiteLine)
      const expectedEdges: readonly ExpectedEdgeSummary[] = [
        // IMPORTS from InvoiceCard.tsx
        {
          sourceQualifiedName: 'file:src/components/InvoiceCard.tsx',
          targetQualifiedName: 'file:src/components/Badge.tsx',
          edgeType: 'IMPORTS',
          callSiteLine: null,
        },
        {
          sourceQualifiedName: 'file:src/components/InvoiceCard.tsx',
          targetQualifiedName: 'file:src/services/invoice.ts',
          edgeType: 'IMPORTS',
          callSiteLine: null,
        },
        // IMPORTS + top-level CALLS from index.tsx
        {
          sourceQualifiedName: 'file:src/index.tsx',
          targetQualifiedName: 'file:src/components/InvoiceCard.tsx',
          edgeType: 'IMPORTS',
          callSiteLine: null,
        },
        {
          sourceQualifiedName: 'file:src/index.tsx',
          targetQualifiedName: 'file:src/utils/index.ts',
          edgeType: 'IMPORTS',
          callSiteLine: null,
        },
        {
          sourceQualifiedName: 'file:src/index.tsx',
          targetQualifiedName: 'src/utils/format.ts::fn:formatAmount',
          edgeType: 'CALLS',
          callSiteLine: 6,
        },
        // IMPORTS from invoice.ts (barrel hop preserved; external 'uninstalled-analytics' omitted)
        {
          sourceQualifiedName: 'file:src/services/invoice.ts',
          targetQualifiedName: 'file:src/models/audit.ts',
          edgeType: 'IMPORTS',
          callSiteLine: null,
        },
        {
          sourceQualifiedName: 'file:src/services/invoice.ts',
          targetQualifiedName: 'file:src/utils/index.ts',
          edgeType: 'IMPORTS',
          callSiteLine: null,
        },
        // IMPORTS from barrel index.ts -> format.ts
        {
          sourceQualifiedName: 'file:src/utils/index.ts',
          targetQualifiedName: 'file:src/utils/format.ts',
          edgeType: 'IMPORTS',
          callSiteLine: null,
        },
        // CALLS from HOC HighlightBadge -> PriceTag
        {
          sourceQualifiedName: 'src/components/Badge.tsx::sym:HighlightBadge',
          targetQualifiedName: 'src/components/Badge.tsx::fn:PriceTag',
          edgeType: 'CALLS',
          callSiteLine: 5,
        },
        // CALLS from InvoiceCard -> PriceTag, HighlightBadge, buildInvoiceSummary
        {
          sourceQualifiedName: 'src/components/InvoiceCard.tsx::fn:InvoiceCard',
          targetQualifiedName: 'src/components/Badge.tsx::fn:PriceTag',
          edgeType: 'CALLS',
          callSiteLine: 7,
        },
        {
          sourceQualifiedName: 'src/components/InvoiceCard.tsx::fn:InvoiceCard',
          targetQualifiedName: 'src/components/Badge.tsx::sym:HighlightBadge',
          edgeType: 'CALLS',
          callSiteLine: 8,
        },
        {
          sourceQualifiedName: 'src/components/InvoiceCard.tsx::fn:InvoiceCard',
          targetQualifiedName: 'src/services/invoice.ts::fn:buildInvoiceSummary',
          edgeType: 'CALLS',
          callSiteLine: 4,
        },
        // CALLS from renderApp -> InvoiceCard
        {
          sourceQualifiedName: 'src/index.tsx::fn:renderApp',
          targetQualifiedName: 'src/components/InvoiceCard.tsx::fn:InvoiceCard',
          edgeType: 'CALLS',
          callSiteLine: 4,
        },
        // CALLS inside BillingEngine.calculateTotal -> this.applyTax
        {
          sourceQualifiedName: 'src/models/audit.ts::class:BillingEngine::method:calculateTotal',
          targetQualifiedName: 'src/models/audit.ts::class:BillingEngine::method:applyTax',
          edgeType: 'CALLS',
          callSiteLine: 12,
        },
        // CALLS inside buildInvoiceSummary (implicit ctor, nested callback method, explicit ctor, instance method, static method, barrel-resolved utilities)
        {
          sourceQualifiedName: 'src/services/invoice.ts::fn:buildInvoiceSummary',
          targetQualifiedName: 'src/models/audit.ts::class:AuditContext',
          edgeType: 'CALLS',
          callSiteLine: 5,
        },
        {
          sourceQualifiedName: 'src/services/invoice.ts::fn:buildInvoiceSummary',
          targetQualifiedName: 'src/models/audit.ts::class:AuditContext::method:label',
          edgeType: 'CALLS',
          callSiteLine: 9,
        },
        {
          sourceQualifiedName: 'src/services/invoice.ts::fn:buildInvoiceSummary',
          targetQualifiedName: 'src/models/audit.ts::class:BillingEngine::ctor',
          edgeType: 'CALLS',
          callSiteLine: 6,
        },
        {
          sourceQualifiedName: 'src/services/invoice.ts::fn:buildInvoiceSummary',
          targetQualifiedName: 'src/models/audit.ts::class:BillingEngine::method:calculateTotal',
          edgeType: 'CALLS',
          callSiteLine: 8,
        },
        {
          sourceQualifiedName: 'src/services/invoice.ts::fn:buildInvoiceSummary',
          targetQualifiedName: 'src/models/audit.ts::class:BillingEngine::static:defaultRate',
          edgeType: 'CALLS',
          callSiteLine: 6,
        },
        {
          sourceQualifiedName: 'src/services/invoice.ts::fn:buildInvoiceSummary',
          targetQualifiedName: 'src/utils/format.ts::fn:clamp',
          edgeType: 'CALLS',
          callSiteLine: 7,
        },
        {
          sourceQualifiedName: 'src/services/invoice.ts::fn:buildInvoiceSummary',
          targetQualifiedName: 'src/utils/format.ts::fn:formatAmount',
          edgeType: 'CALLS',
          callSiteLine: 11,
        },
      ];

      expect(run1.edges.map(summarizeEdge)).toEqual(expectedEdges);

      // Verify all emitted endpoints exist and exact per-kind statistics match
      const nodeQns = new Set(run1.nodes.map((n) => n.qualifiedName));
      assertEndpointsExist(nodeQns, run1.edges);
      expect(run1.stats.folderNodeCount).toBe(5);
      expect(run1.stats.fileNodeCount).toBe(7);
      expect(run1.stats.functionNodeCount).toBe(11);
      expect(run1.stats.classNodeCount).toBe(2);
      expect(run1.stats.symbolNodeCount).toBe(2);
      expect(run1.stats.importsEdgeCount).toBe(7);
      expect(run1.stats.callsEdgeCount).toBe(14);
    });
  });

  describe('Part 2 — Declaration resolution matrix', () => {
    it('resolves namespace imports, multi-level barrel chains, and aliased re-exports while preserving barrel IMPORTS hops', () => {
      const sourceFiles = [
        makeFile(
          'src/deep/leaf.ts',
          'export function coreCalc(n: number): number { return n * 3; }\n',
        ),
        makeFile('src/deep/barrel-inner.ts', "export { coreCalc as renamedCalc } from './leaf';\n"),
        makeFile(
          'src/deep/index.ts',
          "export { renamedCalc as finalCalc } from './barrel-inner';\n",
        ),
        makeFile(
          'src/ns-mod.ts',
          [
            'export function nsHelper(): number { return 10; }',
            'export class NsWorker {',
            '  constructor(public readonly id: string) {}',
            '  work(): number { return 1; }',
            '}',
          ].join('\n'),
        ),
        makeFile(
          'src/entry.ts',
          [
            "import { finalCalc } from './deep';",
            "import * as ns from './ns-mod';",
            'export function runAll(): number {',
            '  const a = finalCalc(2);',
            '  const b = ns.nsHelper();',
            "  const w = new ns.NsWorker('w1');",
            '  return a + b + w.work();',
            '}',
          ].join('\n'),
        ),
      ];

      const { importEdges, callEdges } = runInMemoryPipeline(sourceFiles);

      expect(summarizeImports(importEdges)).toEqual([
        'file:src/deep/barrel-inner.ts -> file:src/deep/leaf.ts',
        'file:src/deep/index.ts -> file:src/deep/barrel-inner.ts',
        'file:src/entry.ts -> file:src/deep/index.ts',
        'file:src/entry.ts -> file:src/ns-mod.ts',
      ]);

      expect(summarizeCalls(callEdges)).toEqual([
        'src/entry.ts::fn:runAll -> src/deep/leaf.ts::fn:coreCalc @L4',
        'src/entry.ts::fn:runAll -> src/ns-mod.ts::class:NsWorker::ctor @L6',
        'src/entry.ts::fn:runAll -> src/ns-mod.ts::class:NsWorker::method:work @L7',
        'src/entry.ts::fn:runAll -> src/ns-mod.ts::fn:nsHelper @L5',
      ]);
    });

    it('resolves named/anonymous defaults, function/class expressions, and function/method overloads while excluding signature-only declarations', () => {
      const sourceFiles = [
        makeFile(
          'src/named-default.ts',
          'export default function namedDefault(): number { return 1; }\n',
        ),
        makeFile('src/anon-fn-decl.ts', 'export default function (): number { return 2; }\n'),
        makeFile('src/anon-arrow.ts', 'export default (): number => 3;\n'),
        makeFile(
          'src/fn-expr.ts',
          [
            'export const countDown = function step(n: number): number {',
            '  return n <= 0 ? 0 : step(n - 1);',
            '};',
          ].join('\n'),
        ),
        makeFile(
          'src/class-expr.ts',
          [
            'export const NamedClassExpr = class InnerBox {',
            '  constructor(public readonly n: number) {}',
            '};',
          ].join('\n'),
        ),
        makeFile(
          'src/anon-default-class.ts',
          ['export default class {', '  ping(): number { return 4; }', '}'].join('\n'),
        ),
        makeFile(
          'src/anon-class-expr.ts',
          ['export default (class {', '  constructor(public readonly tag: string) {}', '});'].join(
            '\n',
          ),
        ),
        makeFile(
          'src/overloads.ts',
          [
            'export function parseVal(v: string): number;',
            'export function parseVal(v: number): string;',
            'export function parseVal(v: string | number): string | number { return v; }',
            'export declare function ambientOnly(v: string): void;',
            'export declare function ambientOnly(v: number): void;',
            'export class Formatter {',
            '  fmt(v: string): string;',
            '  fmt(v: number): string;',
            '  fmt(v: string | number): string { return String(v); }',
            '}',
            'export declare class AmbientFormatter {',
            '  fmt(v: string): string;',
            '}',
          ].join('\n'),
        ),
        makeFile(
          'src/consumer.ts',
          [
            "import namedDefault from './named-default';",
            "import anonFnDecl from './anon-fn-decl';",
            "import anonArrow from './anon-arrow';",
            "import { countDown } from './fn-expr';",
            "import { NamedClassExpr } from './class-expr';",
            "import AnonDefaultClass from './anon-default-class';",
            "import AnonClassExpr from './anon-class-expr';",
            "import { AmbientFormatter, Formatter, ambientOnly, parseVal } from './overloads';",
            'export function run(fmt: Formatter, amb: AmbientFormatter): void {',
            '  namedDefault();',
            '  anonFnDecl();',
            '  anonArrow();',
            '  countDown(2);',
            '  new NamedClassExpr(1);',
            '  const a = new AnonDefaultClass();',
            '  a.ping();',
            "  new AnonClassExpr('ok');",
            "  parseVal('x');",
            '  parseVal(1);',
            "  fmt.fmt('a');",
            '  fmt.fmt(2);',
            "  ambientOnly('skip');",
            "  amb.fmt('skip');",
            '}',
          ].join('\n'),
        ),
      ];

      const { callEdges } = runInMemoryPipeline(sourceFiles);

      expect(summarizeCalls(callEdges)).toEqual([
        'src/consumer.ts::fn:run -> src/anon-arrow.ts::default @L12',
        'src/consumer.ts::fn:run -> src/anon-class-expr.ts::default::ctor @L17',
        'src/consumer.ts::fn:run -> src/anon-default-class.ts::default @L15',
        'src/consumer.ts::fn:run -> src/anon-default-class.ts::default::method:ping @L16',
        'src/consumer.ts::fn:run -> src/anon-fn-decl.ts::default @L11',
        'src/consumer.ts::fn:run -> src/class-expr.ts::class:NamedClassExpr::ctor @L14',
        'src/consumer.ts::fn:run -> src/fn-expr.ts::fn:countDown @L13',
        'src/consumer.ts::fn:run -> src/named-default.ts::fn:namedDefault @L10',
        'src/consumer.ts::fn:run -> src/overloads.ts::class:Formatter::method:fmt @L20',
        'src/consumer.ts::fn:run -> src/overloads.ts::class:Formatter::method:fmt @L21',
        'src/consumer.ts::fn:run -> src/overloads.ts::fn:parseVal @L18',
        'src/consumer.ts::fn:run -> src/overloads.ts::fn:parseVal @L19',
        'src/fn-expr.ts::fn:countDown -> src/fn-expr.ts::fn:countDown @L2',
      ]);
    });

    it('uses allocated escaped/collision identities, rejects ambiguous duplicate declarations, distinguishes static/instance members & arrow properties, and isolates nested config aliases', () => {
      const configFiles = [
        makeFile(
          'apps/alpha/tsconfig.json',
          JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
        ),
        makeFile(
          'apps/beta/tsconfig.json',
          JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
        ),
      ];

      const sourceFiles = [
        makeFile('apps/alpha/src/shared.ts', "export function run(): string { return 'alpha'; }\n"),
        makeFile(
          'apps/alpha/src/entry.ts',
          [
            "import { run } from '@/shared';",
            'export function boot(): string { return run(); }',
          ].join('\n'),
        ),
        makeFile('apps/beta/src/shared.ts', "export function run(): string { return 'beta'; }\n"),
        makeFile(
          'apps/beta/src/entry.ts',
          [
            "import { run } from '@/shared';",
            'export function boot(): string { return run(); }',
          ].join('\n'),
        ),
        // Path with '@' verifies CALLS consumes the percent-escaped allocated identity from DeclarationNodeIndex
        makeFile('src/v@1/helper.ts', 'export function compute(): number { return 7; }\n'),
        makeFile(
          'src/members.ts',
          [
            'export class Widget {',
            '  sync(): number { return 1; }',
            '  static sync(): number { return 2; }',
            '  onClick = (): number => 3;',
            '  static build = (): number => 4;',
            '}',
          ].join('\n'),
        ),
        // Same-line duplicate declarations produce two disambiguated nodes; calling dup() is conservatively omitted
        makeFile(
          'src/dup.ts',
          'export function dup(): number { return 1; } export function dup(): number { return 2; }\n',
        ),
        makeFile(
          'src/main.ts',
          [
            "import { compute } from './v@1/helper';",
            "import { Widget } from './members';",
            "import { dup } from './dup';",
            'export function execute(w: Widget): number {',
            '  const a = compute();',
            '  const b = w.sync() + Widget.sync();',
            '  const c = w.onClick() + Widget.build();',
            '  const d = dup();',
            '  return a + b + c + d;',
            '}',
          ].join('\n'),
        ),
      ];

      const { nodes, importEdges, callEdges } = runInMemoryPipeline(sourceFiles, configFiles);

      // Verify both collision-disambiguated nodes were emitted with distinct allocated identities
      const dupNodes = nodes
        .filter((n) => n.filePath === 'src/dup.ts' && n.nodeType === 'function')
        .map((n) => n.qualifiedName);
      expect(dupNodes).toEqual(['src/dup.ts::fn:dup', 'src/dup.ts::fn:dup@L1:C45']);

      expect(summarizeImports(importEdges)).toEqual([
        'file:apps/alpha/src/entry.ts -> file:apps/alpha/src/shared.ts',
        'file:apps/beta/src/entry.ts -> file:apps/beta/src/shared.ts',
        'file:src/main.ts -> file:src/dup.ts',
        'file:src/main.ts -> file:src/members.ts',
        'file:src/main.ts -> file:src/v%401/helper.ts',
      ]);

      expect(summarizeCalls(callEdges)).toEqual([
        'apps/alpha/src/entry.ts::fn:boot -> apps/alpha/src/shared.ts::fn:run @L2',
        'apps/beta/src/entry.ts::fn:boot -> apps/beta/src/shared.ts::fn:run @L2',
        'src/main.ts::fn:execute -> src/members.ts::class:Widget::method:onClick @L7',
        'src/main.ts::fn:execute -> src/members.ts::class:Widget::method:sync @L6',
        'src/main.ts::fn:execute -> src/members.ts::class:Widget::static:build @L7',
        'src/main.ts::fn:execute -> src/members.ts::class:Widget::static:sync @L6',
        'src/main.ts::fn:execute -> src/v%401/helper.ts::fn:compute @L5',
      ]);
    });
  });
});
