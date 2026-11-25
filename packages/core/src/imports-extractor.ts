import { ts } from 'ts-morph';
import { compareCodePoint } from './discovery.js';
import type { WorkspaceModuleResolver } from './module-resolver.js';
import type { AnalysisSourceFileEntry } from './project.js';
import { buildFileQualifiedName } from './qualified-name.js';
import { fromVirtualRepoPath } from './tsconfig-loader.js';
import type { ExtractedEdge } from './types.js';

export interface ExtractImportsOptions {
  readonly parsedFiles: readonly AnalysisSourceFileEntry[];
  readonly resolver: WorkspaceModuleResolver;
}

function collectBindingNames(binding: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(binding)) {
    out.add(binding.text);
    return;
  }
  for (const element of binding.elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, out);
    }
  }
}

function blockDeclaresRequire(statements: ts.NodeArray<ts.Statement>): boolean {
  for (const stmt of statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'require') {
      return true;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === 'require') {
      return true;
    }
    if (ts.isVariableStatement(stmt)) {
      const names = new Set<string>();
      for (const decl of stmt.declarationList.declarations) {
        collectBindingNames(decl.name, names);
      }
      if (names.has('require')) {
        return true;
      }
    }
    if (ts.isImportDeclaration(stmt) && stmt.importClause !== undefined) {
      if (stmt.importClause.name?.text === 'require') {
        return true;
      }
      const bindings = stmt.importClause.namedBindings;
      if (bindings !== undefined) {
        if (ts.isNamespaceImport(bindings) && bindings.name.text === 'require') {
          return true;
        }
        if (
          ts.isNamedImports(bindings) &&
          bindings.elements.some((el) => el.name.text === 'require')
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function functionDeclaresRequire(fn: ts.FunctionLikeDeclaration): boolean {
  if (ts.isFunctionExpression(fn) && fn.name?.text === 'require') {
    return true;
  }
  const paramNames = new Set<string>();
  for (const param of fn.parameters) {
    collectBindingNames(param.name, paramNames);
  }
  if (paramNames.has('require')) {
    return true;
  }
  if (fn.body !== undefined && ts.isBlock(fn.body)) {
    return blockDeclaresRequire(fn.body.statements);
  }
  return false;
}

/**
 * Collects static literal CommonJS `require('...')` and ``require(`...`)`` specifiers,
 * skipping dynamic expressions and lexically shadowed `require` bindings.
 */
function collectStaticRequireSpecifiers(sf: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];

  if (blockDeclaresRequire(sf.statements)) {
    return specifiers;
  }

  const visit = (node: ts.Node, requireShadowed: boolean): void => {
    let nextShadowed = requireShadowed;

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      if (functionDeclaresRequire(node)) {
        nextShadowed = true;
      }
    } else if (ts.isBlock(node)) {
      if (blockDeclaresRequire(node.statements)) {
        nextShadowed = true;
      }
    } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      const catchNames = new Set<string>();
      collectBindingNames(node.variableDeclaration.name, catchNames);
      if (catchNames.has('require')) {
        nextShadowed = true;
      }
    } else if (
      !requireShadowed &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1
    ) {
      const firstArg = node.arguments[0];
      if (
        firstArg !== undefined &&
        (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))
      ) {
        specifiers.push(firstArg.text);
      }
    }

    ts.forEachChild(node, (child) => {
      visit(child, nextShadowed);
    });
  };

  ts.forEachChild(sf, (child) => {
    visit(child, false);
  });

  return specifiers;
}

/**
 * Extracts deduplicated, deterministically sorted `IMPORTS` edges (ES imports,
 * barrel re-exports, circular barrels, and unshadowed literal CommonJS `require`)
 * using the exact `WorkspaceModuleResolver` shared with the `ts-morph` Project.
 */
export function extractImportEdges(options: ExtractImportsOptions): readonly ExtractedEdge[] {
  const dedupedEdges = new Map<string, ExtractedEdge>();

  for (const entry of options.parsedFiles) {
    const sourceQn = buildFileQualifiedName(entry.relativePath);
    const specifiers: string[] = [];

    // 1. ES ImportDeclarations (named, default, namespace, side-effect, type-only)
    for (const importDecl of entry.sourceFile.getImportDeclarations()) {
      specifiers.push(importDecl.getModuleSpecifierValue());
    }

    // 2. ES ExportDeclarations with module specifier (barrel re-exports & circular barrels)
    for (const exportDecl of entry.sourceFile.getExportDeclarations()) {
      if (exportDecl.hasModuleSpecifier()) {
        const modSpec = exportDecl.getModuleSpecifierValue();
        if (modSpec !== undefined) {
          specifiers.push(modSpec);
        }
      }
    }

    // 3. Static literal CommonJS require('...') / require(`...`) when not shadowed
    for (const reqSpec of collectStaticRequireSpecifiers(entry.sourceFile.compilerNode)) {
      specifiers.push(reqSpec);
    }

    for (const specifier of specifiers) {
      const targetVirtual = options.resolver.resolveModulePath(specifier, entry.virtualPath);
      if (targetVirtual === null || targetVirtual === entry.virtualPath) {
        continue;
      }

      const targetRelPath = fromVirtualRepoPath(targetVirtual);
      if (targetRelPath === null || targetRelPath.length === 0) {
        continue;
      }

      const targetQn = buildFileQualifiedName(targetRelPath);
      const dedupeKey = `${sourceQn}\0${targetQn}\0IMPORTS`;
      if (!dedupedEdges.has(dedupeKey)) {
        dedupedEdges.set(dedupeKey, {
          sourceQualifiedName: sourceQn,
          targetQualifiedName: targetQn,
          edgeType: 'IMPORTS',
          callSiteLine: null,
          callSiteSnippet: null,
        });
      }
    }
  }

  return [...dedupedEdges.values()].sort((a, b) => {
    const srcCmp = compareCodePoint(a.sourceQualifiedName, b.sourceQualifiedName);
    if (srcCmp !== 0) {
      return srcCmp;
    }
    const tgtCmp = compareCodePoint(a.targetQualifiedName, b.targetQualifiedName);
    if (tgtCmp !== 0) {
      return tgtCmp;
    }
    return compareCodePoint(a.edgeType, b.edgeType);
  });
}
