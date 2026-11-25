import { posix as posixPath } from 'node:path';
import { ts } from 'ts-morph';
import { compareCodePoint } from './discovery.js';
import { CoreAnalysisError } from './errors.js';
import { findEnclosingScopeQualifiedName, type DeclarationNodeIndex } from './node-extractor.js';
import type { AnalysisProjectContext } from './project.js';
import { DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS, type ExtractedEdge } from './types.js';

const CONTEXT_LINES_EACH_SIDE = 5;
const MAX_TYPE_WALK_DEPTH = 16;
const MAX_ALIAS_HOPS = 32;
const MAX_EXPORT_WALK_DEPTH = 32;
const UNRESOLVED_TYPE_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;
const NULLISH_TYPE_FLAGS = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

export interface ExtractCallsOptions {
  readonly projectContext: AnalysisProjectContext;
  readonly declarationIndex: DeclarationNodeIndex;
  readonly maxCallSiteSnippetChars?: number;
}

/**
 * Shared bounded validator for `maxCallSiteSnippetChars`:
 * - `undefined` -> `DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS` (512)
 * - `0` and non-negative safe integers -> accepted
 * - Negative, fractional, `NaN`, `±Infinity`, or unsafe integers -> `CoreAnalysisError('INVALID_WORKSPACE')`
 */
export function validateMaxCallSiteSnippetChars(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_CALL_SITE_SNIPPET_CHARS;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CoreAnalysisError({
      code: 'INVALID_WORKSPACE',
      message: `maxCallSiteSnippetChars must be a non-negative safe integer (received ${String(value)}).`,
      details: { maxCallSiteSnippetChars: value },
    });
  }
  return value;
}

class SourceTextIndex {
  private readonly lineStarts: readonly number[];
  private readonly normalizedLines: readonly string[];

  constructor(private readonly text: string) {
    const starts: number[] = [0];
    const lines: string[] = [];
    let lineStart = 0;

    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 10) {
        const lineEnd = i > lineStart && text.charCodeAt(i - 1) === 13 ? i - 1 : i;
        lines.push(text.slice(lineStart, lineEnd));
        lineStart = i + 1;
        starts.push(lineStart);
      } else if (code === 13 && text.charCodeAt(i + 1) !== 10) {
        lines.push(text.slice(lineStart, i));
        lineStart = i + 1;
        starts.push(lineStart);
      }
    }
    lines.push(text.slice(lineStart));

    this.lineStarts = starts;
    this.normalizedLines = lines;
  }

  getLineAndColumnAtOffset(offset: number): {
    readonly line: number;
    readonly columnZeroBased: number;
  } {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const start = this.lineStarts[mid] ?? 0;
      if (start <= clamped) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const lineIdx = Math.max(0, high);
    const start = this.lineStarts[lineIdx] ?? 0;
    return {
      line: lineIdx + 1,
      columnZeroBased: clamped - start,
    };
  }

  /**
   * Builds an LF-normalized context window (up to ±5 lines around `callSiteLine`) bounded to
   * `maxChars`. Prioritizes keeping the call-site line intact, expanding symmetrically outward;
   * if the call-site line itself exceeds `maxChars`, centers the slice on the call expression.
   */
  extractCallSiteSnippet(
    callSiteLine: number,
    callStartCol: number,
    callEndCol: number,
    maxChars: number,
  ): string {
    if (maxChars <= 0) {
      return '';
    }

    const centerIdx = Math.max(0, Math.min(callSiteLine - 1, this.normalizedLines.length - 1));
    const callLine = this.normalizedLines[centerIdx] ?? '';

    if (callLine.length > maxChars) {
      const clampedStart = Math.max(0, Math.min(callStartCol, callLine.length));
      const clampedEnd = Math.max(clampedStart, Math.min(callEndCol, callLine.length));
      const exprMid = Math.floor((clampedStart + clampedEnd) / 2);
      let sliceStart = Math.max(0, exprMid - Math.floor(maxChars / 2));
      if (clampedStart < sliceStart) {
        sliceStart = clampedStart;
      }
      if (sliceStart + maxChars > callLine.length) {
        sliceStart = Math.max(0, callLine.length - maxChars);
      }
      return callLine.slice(sliceStart, sliceStart + maxChars);
    }

    const minIdx = Math.max(0, centerIdx - CONTEXT_LINES_EACH_SIDE);
    const maxIdx = Math.min(this.normalizedLines.length - 1, centerIdx + CONTEXT_LINES_EACH_SIDE);

    let top = centerIdx;
    let bottom = centerIdx;
    let usedChars = callLine.length;
    let canExpandUp = top > minIdx;
    let canExpandDown = bottom < maxIdx;

    while (canExpandUp || canExpandDown) {
      let expanded = false;

      if (canExpandUp) {
        const candidateIdx = top - 1;
        const candidateLine = this.normalizedLines[candidateIdx] ?? '';
        const cost = 1 + candidateLine.length;
        if (usedChars + cost <= maxChars) {
          top = candidateIdx;
          usedChars += cost;
          expanded = true;
          canExpandUp = top > minIdx;
        } else {
          canExpandUp = false;
        }
      }

      if (canExpandDown) {
        const candidateIdx = bottom + 1;
        const candidateLine = this.normalizedLines[candidateIdx] ?? '';
        const cost = 1 + candidateLine.length;
        if (usedChars + cost <= maxChars) {
          bottom = candidateIdx;
          usedChars += cost;
          expanded = true;
          canExpandDown = bottom < maxIdx;
        } else {
          canExpandDown = false;
        }
      }

      if (!expanded) {
        break;
      }
    }

    return this.normalizedLines.slice(top, bottom + 1).join('\n');
  }
}

export function compareExtractedEdges(a: ExtractedEdge, b: ExtractedEdge): number {
  const srcCmp = compareCodePoint(a.sourceQualifiedName, b.sourceQualifiedName);
  if (srcCmp !== 0) {
    return srcCmp;
  }
  const tgtCmp = compareCodePoint(a.targetQualifiedName, b.targetQualifiedName);
  if (tgtCmp !== 0) {
    return tgtCmp;
  }
  const typeCmp = compareCodePoint(a.edgeType, b.edgeType);
  if (typeCmp !== 0) {
    return typeCmp;
  }
  return (a.callSiteLine ?? -1) - (b.callSiteLine ?? -1);
}

function normalizeVirtualPath(filePath: string): string {
  return posixPath.normalize(filePath.replace(/\\/g, '/'));
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === kind) ?? false;
}

/**
 * Checks the outermost expression AND every intermediate wrapper layer before unwrapping,
 * ensuring explicit `any`/`unknown`/`never` assertions such as `(helper as any)()`,
 * `(obj.run as any)()`, or `new (Service as any)()` cannot bypass the unresolved-type guard.
 */
function hasUnresolvedExpressionOrAssertion(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  let current: ts.Expression = expr;
  for (;;) {
    const currentType = checker.getTypeAtLocation(current);
    if ((currentType.flags & UNRESOLVED_TYPE_FLAGS) !== 0) {
      return true;
    }
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression;
    } else {
      return false;
    }
  }
}

interface ResolutionContext {
  readonly checker: ts.TypeChecker;
  readonly projectContext: AnalysisProjectContext;
  readonly declarationIndex: DeclarationNodeIndex;
  readonly authoritativePaths: ReadonlySet<string>;
  readonly parsedFilesByVirtualPath: ReadonlyMap<string, ts.SourceFile>;
  readonly valueExportCache: Map<string, boolean>;
}

/**
 * Runtime eligibility guard: rejects declarations inside `.d.ts` declaration files,
 * explicit `declare` modifiers, and declarations nested inside enclosing ambient contexts
 * (e.g. `declare namespace` / `declare module`).
 */
function isAmbientDeclaration(node: ts.Node): boolean {
  if (node.getSourceFile().isDeclarationFile) {
    return true;
  }
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
    return true;
  }
  let prev = node;
  while (!ts.isSourceFile(prev)) {
    const current = prev.parent;
    if (hasModifier(current, ts.SyntaxKind.DeclareKeyword)) {
      return true;
    }
    prev = current;
  }
  return false;
}

function isTypeOnlyBindingDeclaration(decl: ts.Declaration): boolean {
  if (
    ts.isTypeOnlyImportOrExportDeclaration(decl) ||
    ts.isPartOfTypeOnlyImportOrExportDeclaration(decl)
  ) {
    return true;
  }
  if (ts.isImportSpecifier(decl) && decl.isTypeOnly) {
    return true;
  }
  if (ts.isExportSpecifier(decl) && decl.isTypeOnly) {
    return true;
  }
  if (ts.isImportClause(decl) && decl.phaseModifier === ts.SyntaxKind.TypeKeyword) {
    return true;
  }
  if (ts.isExportDeclaration(decl) && decl.isTypeOnly) {
    return true;
  }
  return false;
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

function isModuleExportsExpression(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'module' &&
    expr.name.text === 'exports'
  );
}

function getStaticObjectPropertyName(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function hasLocalValueExport(sf: ts.SourceFile, exportName: string): boolean {
  if (sf.isDeclarationFile) {
    return false;
  }

  for (const stmt of sf.statements) {
    if (hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) {
      continue;
    }

    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.body === undefined || !hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
        continue;
      }
      if (exportName === 'default') {
        if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
          return true;
        }
      } else if (stmt.name?.text === exportName) {
        return true;
      }
      continue;
    }

    if (ts.isClassDeclaration(stmt)) {
      if (!hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
        continue;
      }
      if (exportName === 'default') {
        if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
          return true;
        }
      } else if (stmt.name?.text === exportName) {
        return true;
      }
      continue;
    }

    if (ts.isVariableStatement(stmt)) {
      if (exportName !== 'default' && hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
        const names = new Set<string>();
        for (const decl of stmt.declarationList.declarations) {
          collectBindingNames(decl.name, names);
        }
        if (names.has(exportName)) {
          return true;
        }
      }
      continue;
    }

    if (ts.isEnumDeclaration(stmt)) {
      if (
        exportName !== 'default' &&
        stmt.name.text === exportName &&
        hasModifier(stmt, ts.SyntaxKind.ExportKeyword)
      ) {
        return true;
      }
      continue;
    }

    if (ts.isModuleDeclaration(stmt)) {
      if (
        exportName !== 'default' &&
        ts.isIdentifier(stmt.name) &&
        stmt.name.text === exportName &&
        hasModifier(stmt, ts.SyntaxKind.ExportKeyword)
      ) {
        return true;
      }
      continue;
    }

    if (ts.isExportAssignment(stmt)) {
      if (exportName === 'default') {
        return true;
      }
      continue;
    }

    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      stmt.moduleSpecifier === undefined &&
      stmt.exportClause !== undefined &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const spec of stmt.exportClause.elements) {
        if (!spec.isTypeOnly && spec.name.text === exportName) {
          return true;
        }
      }
      continue;
    }

    // Static CommonJS exports (`exports.x = ...`, `module.exports.x = ...`, `module.exports = ...`)
    if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const { left, right } = stmt.expression;
      if (isModuleExportsExpression(left)) {
        if (exportName === 'default') {
          return true;
        }
        const rhs = unwrapExpression(right);
        if (ts.isObjectLiteralExpression(rhs)) {
          for (const prop of rhs.properties) {
            if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === exportName) {
              return true;
            }
            if (
              (ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
              getStaticObjectPropertyName(prop.name) === exportName
            ) {
              return true;
            }
          }
        }
      } else if (
        ts.isPropertyAccessExpression(left) &&
        ((ts.isIdentifier(left.expression) && left.expression.text === 'exports') ||
          isModuleExportsExpression(left.expression)) &&
        left.name.text === exportName
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Verifies via public AST inspection and the shared `WorkspaceModuleResolver` whether
 * `moduleVirtualPath` exposes a non-type-only value export for `exportName` (catching
 * `export type *`, `export type * as ns`, and multi-hop type-only re-export chains).
 */
function checkModuleValueExport(
  ctx: ResolutionContext,
  moduleVirtualPath: string,
  exportName: string,
  depth: number,
  visiting: Set<string>,
): { readonly found: boolean; readonly hitCycle: boolean } {
  const normalizedModule = normalizeVirtualPath(moduleVirtualPath);
  const cacheKey = `${normalizedModule}\0${exportName}`;

  if (visiting.size === 0) {
    const cached = ctx.valueExportCache.get(cacheKey);
    if (cached !== undefined) {
      return { found: cached, hitCycle: false };
    }
  }

  if (depth > MAX_EXPORT_WALK_DEPTH || visiting.has(cacheKey)) {
    return { found: false, hitCycle: true };
  }

  const sf = ctx.parsedFilesByVirtualPath.get(normalizedModule);
  if (sf === undefined || sf.isDeclarationFile) {
    if (visiting.size === 0) {
      ctx.valueExportCache.set(cacheKey, false);
    }
    return { found: false, hitCycle: false };
  }

  if (hasLocalValueExport(sf, exportName)) {
    if (visiting.size === 0) {
      ctx.valueExportCache.set(cacheKey, true);
    }
    return { found: true, hitCycle: false };
  }

  visiting.add(cacheKey);
  let hitCycle = false;

  try {
    for (const stmt of sf.statements) {
      if (
        !ts.isExportDeclaration(stmt) ||
        stmt.isTypeOnly ||
        stmt.moduleSpecifier === undefined ||
        !ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        continue;
      }

      const targetVirtual = ctx.projectContext.resolver.resolveModulePath(
        stmt.moduleSpecifier.text,
        normalizedModule,
      );
      if (targetVirtual === null) {
        continue;
      }

      if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          if (spec.isTypeOnly || spec.name.text !== exportName) {
            continue;
          }
          const upstreamName = (spec.propertyName ?? spec.name).text;
          const res = checkModuleValueExport(ctx, targetVirtual, upstreamName, depth + 1, visiting);
          if (res.hitCycle) {
            hitCycle = true;
          }
          if (res.found) {
            return { found: true, hitCycle };
          }
        }
      } else if (stmt.exportClause !== undefined && ts.isNamespaceExport(stmt.exportClause)) {
        if (stmt.exportClause.name.text === exportName) {
          const targetSf = ctx.parsedFilesByVirtualPath.get(normalizeVirtualPath(targetVirtual));
          if (targetSf !== undefined && !targetSf.isDeclarationFile) {
            return { found: true, hitCycle };
          }
        }
      } else if (exportName !== 'default') {
        const res = checkModuleValueExport(ctx, targetVirtual, exportName, depth + 1, visiting);
        if (res.hitCycle) {
          hitCycle = true;
        }
        if (res.found) {
          return { found: true, hitCycle };
        }
      }
    }
  } finally {
    visiting.delete(cacheKey);
  }

  if (!hitCycle && visiting.size === 0) {
    ctx.valueExportCache.set(cacheKey, false);
  }

  return { found: false, hitCycle };
}

function isValueExportedByModule(
  ctx: ResolutionContext,
  moduleVirtualPath: string,
  exportName: string,
): boolean {
  return checkModuleValueExport(ctx, moduleVirtualPath, exportName, 0, new Set<string>()).found;
}

interface BindingHopModuleRef {
  readonly targetVirtualPath: string;
  readonly exportedName: string | null;
  readonly isNamespace: boolean;
}

function extractBindingHopModuleRef(
  ctx: ResolutionContext,
  decl: ts.Declaration,
): BindingHopModuleRef | null {
  const containingVirtual = normalizeVirtualPath(decl.getSourceFile().fileName);

  if (ts.isImportSpecifier(decl)) {
    const namedImports = decl.parent;
    const importClause = namedImports.parent;
    const importDecl = importClause.parent;
    if (!ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return null;
    }
    const targetVirtual = ctx.projectContext.resolver.resolveModulePath(
      importDecl.moduleSpecifier.text,
      containingVirtual,
    );
    if (targetVirtual === null) {
      return null;
    }
    return {
      targetVirtualPath: targetVirtual,
      exportedName: (decl.propertyName ?? decl.name).text,
      isNamespace: false,
    };
  }

  if (ts.isImportClause(decl)) {
    const importDecl = decl.parent;
    if (!ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return null;
    }
    const targetVirtual = ctx.projectContext.resolver.resolveModulePath(
      importDecl.moduleSpecifier.text,
      containingVirtual,
    );
    if (targetVirtual === null) {
      return null;
    }
    return {
      targetVirtualPath: targetVirtual,
      exportedName: 'default',
      isNamespace: false,
    };
  }

  if (ts.isNamespaceImport(decl)) {
    const importDecl = decl.parent.parent;
    if (!ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return null;
    }
    const targetVirtual = ctx.projectContext.resolver.resolveModulePath(
      importDecl.moduleSpecifier.text,
      containingVirtual,
    );
    if (targetVirtual === null) {
      return null;
    }
    return {
      targetVirtualPath: targetVirtual,
      exportedName: null,
      isNamespace: true,
    };
  }

  if (ts.isExportSpecifier(decl)) {
    const exportDecl = decl.parent.parent;
    if (
      exportDecl.moduleSpecifier === undefined ||
      !ts.isStringLiteral(exportDecl.moduleSpecifier)
    ) {
      return null;
    }
    const targetVirtual = ctx.projectContext.resolver.resolveModulePath(
      exportDecl.moduleSpecifier.text,
      containingVirtual,
    );
    if (targetVirtual === null) {
      return null;
    }
    return {
      targetVirtualPath: targetVirtual,
      exportedName: (decl.propertyName ?? decl.name).text,
      isNamespace: false,
    };
  }

  if (ts.isNamespaceExport(decl)) {
    const exportDecl = decl.parent;
    if (
      exportDecl.moduleSpecifier === undefined ||
      !ts.isStringLiteral(exportDecl.moduleSpecifier)
    ) {
      return null;
    }
    const targetVirtual = ctx.projectContext.resolver.resolveModulePath(
      exportDecl.moduleSpecifier.text,
      containingVirtual,
    );
    if (targetVirtual === null) {
      return null;
    }
    return {
      targetVirtualPath: targetVirtual,
      exportedName: null,
      isNamespace: true,
    };
  }

  return null;
}

function isImportOrExportBindingDeclaration(decl: ts.Declaration): boolean {
  return (
    ts.isImportSpecifier(decl) ||
    ts.isImportClause(decl) ||
    ts.isNamespaceImport(decl) ||
    ts.isImportEqualsDeclaration(decl) ||
    ts.isExportSpecifier(decl) ||
    ts.isNamespaceExport(decl)
  );
}

interface ResolvedValueSymbolResult {
  readonly symbol: ts.Symbol;
  readonly namespaceVirtualPath: string | null;
}

/**
 * Walks alias chains hop-by-hop via public `checker.getImmediateAliasedSymbol`, verifying
 * both direct type-only AST syntax and module value-export provenance at every hop.
 * Returns `null` if any binding in the chain is type-only, unresolved, or exceeds bounds.
 */
function resolveValueSymbol(
  ctx: ResolutionContext,
  symbol: ts.Symbol,
): ResolvedValueSymbolResult | null {
  let current = symbol;
  let lastNamespaceVirtualPath: string | null = null;
  const visited = new Set<ts.Symbol>();

  for (let hop = 0; hop <= MAX_ALIAS_HOPS; hop += 1) {
    if (visited.has(current)) {
      return null;
    }
    visited.add(current);

    const decls = current.getDeclarations() ?? [];
    let hasImportOrExportDecl = false;

    for (const decl of decls) {
      if (isTypeOnlyBindingDeclaration(decl)) {
        return null;
      }
      if (isImportOrExportBindingDeclaration(decl)) {
        hasImportOrExportDecl = true;
        const hopRef = extractBindingHopModuleRef(ctx, decl);
        if (hopRef !== null) {
          if (hopRef.isNamespace) {
            const targetSf = ctx.parsedFilesByVirtualPath.get(
              normalizeVirtualPath(hopRef.targetVirtualPath),
            );
            if (targetSf === undefined || targetSf.isDeclarationFile) {
              return null;
            }
            lastNamespaceVirtualPath = hopRef.targetVirtualPath;
          } else if (hopRef.exportedName !== null) {
            if (!isValueExportedByModule(ctx, hopRef.targetVirtualPath, hopRef.exportedName)) {
              return null;
            }
          }
        }
      }
    }

    if ((current.flags & ts.SymbolFlags.Alias) === 0) {
      return { symbol: current, namespaceVirtualPath: lastNamespaceVirtualPath };
    }

    const immediate = ctx.checker.getImmediateAliasedSymbol(current);
    if (immediate !== undefined) {
      current = immediate;
      continue;
    }

    if (hasImportOrExportDecl) {
      // Unresolved import/export alias fails closed
      return null;
    }

    const aliased = ctx.checker.getAliasedSymbol(current);
    if (aliased === current) {
      return { symbol: current, namespaceVirtualPath: lastNamespaceVirtualPath };
    }
    current = aliased;
  }

  return null;
}

/**
 * Inspects a property-access receiver chain (`ns.fn`, `outer.inner.fn`) to block type-only
 * namespace bindings (`import type * as ns`, `export type * as ns`) and identify any module
 * namespace virtual path so member access verifies non-type-only export provenance.
 */
function inspectReceiverProvenance(
  ctx: ResolutionContext,
  receiverExpr: ts.Expression,
  depth = 0,
): { readonly blocked: boolean; readonly namespaceVirtualPath: string | null } {
  if (depth > MAX_ALIAS_HOPS) {
    return { blocked: true, namespaceVirtualPath: null };
  }

  const unwrapped = unwrapExpression(receiverExpr);

  if (ts.isIdentifier(unwrapped)) {
    const sym = ctx.checker.getSymbolAtLocation(unwrapped);
    if (sym === undefined) {
      return { blocked: false, namespaceVirtualPath: null };
    }
    const resolved = resolveValueSymbol(ctx, sym);
    if (resolved === null) {
      return { blocked: true, namespaceVirtualPath: null };
    }
    return { blocked: false, namespaceVirtualPath: resolved.namespaceVirtualPath };
  }

  if (ts.isPropertyAccessExpression(unwrapped)) {
    const parentProv = inspectReceiverProvenance(ctx, unwrapped.expression, depth + 1);
    if (parentProv.blocked) {
      return { blocked: true, namespaceVirtualPath: null };
    }
    if (
      parentProv.namespaceVirtualPath !== null &&
      !isValueExportedByModule(ctx, parentProv.namespaceVirtualPath, unwrapped.name.text)
    ) {
      return { blocked: true, namespaceVirtualPath: null };
    }

    const parentType = ctx.checker.getTypeAtLocation(unwrapped.expression);
    const propSym = ctx.checker.getPropertyOfType(parentType, unwrapped.name.text);
    if (propSym !== undefined) {
      const resolvedProp = resolveValueSymbol(ctx, propSym);
      if (resolvedProp === null) {
        return { blocked: true, namespaceVirtualPath: null };
      }
      return { blocked: false, namespaceVirtualPath: resolvedProp.namespaceVirtualPath };
    }
  }

  return { blocked: false, namespaceVirtualPath: null };
}

function isPureTypeOrNamespaceMergeDeclaration(decl: ts.Declaration): boolean {
  return (
    ts.isInterfaceDeclaration(decl) ||
    ts.isTypeAliasDeclaration(decl) ||
    ts.isModuleDeclaration(decl)
  );
}

function isTypeLevelSignatureDeclaration(decl: ts.Node): boolean {
  return (
    ts.isFunctionTypeNode(decl) ||
    ts.isConstructorTypeNode(decl) ||
    ts.isCallSignatureDeclaration(decl) ||
    ts.isConstructSignatureDeclaration(decl) ||
    ts.isMethodSignature(decl)
  );
}

function isAuthoritativeDeclaration(
  decl: ts.Node,
  authoritativePaths: ReadonlySet<string>,
): boolean {
  const filePath = normalizeVirtualPath(decl.getSourceFile().fileName);
  return authoritativePaths.has(filePath);
}

type TargetCategory = 'callable' | 'jsx';

/**
 * Resolves a compiler symbol to a single unambiguous authoritative runtime target.
 * Conservative invariant: if ANY non-merge declaration is type-only, ambient (`.d.ts` or
 * `declare`), external, stdlib, signature-only, unmapped, or maps to a different target,
 * returns `null` rather than filtering down.
 */
/**
 * Checks whether a mapped declaration is a concrete non-ambient runtime function implementation
 * (`FunctionDeclaration` with body, or `const` `VariableDeclaration` initialized with an arrow
 * or function expression) eligible to own top-level function-object property augmentations.
 */
function isConcreteAugmentableImplDeclaration(
  ctx: ResolutionContext,
  decl: ts.Declaration,
): boolean {
  if (isAmbientDeclaration(decl)) {
    return false;
  }
  if (ts.isFunctionDeclaration(decl)) {
    return decl.body !== undefined;
  }
  if (ts.isVariableDeclaration(decl)) {
    if (
      !ts.isVariableDeclarationList(decl.parent) ||
      (decl.parent.flags & ts.NodeFlags.Const) === 0 ||
      decl.initializer === undefined
    ) {
      return false;
    }
    if (hasUnresolvedExpressionOrAssertion(ctx.checker, decl.initializer)) {
      return false;
    }
    const init = unwrapExpression(decl.initializer);
    return ts.isArrowFunction(init) || ts.isFunctionExpression(init);
  }
  return false;
}

/**
 * Recognizes a compiler-synthesized `ts.Identifier` declaration created by a top-level
 * function-object property augmentation of the exact form `Component.property = value`:
 * 1. `decl` is a `ts.Identifier`.
 * 2. `decl` is the direct receiver (`expression`) of a `ts.PropertyAccessExpression`.
 * 3. That `PropertyAccessExpression` is the exact `left` operand of a `ts.BinaryExpression`
 *    with `ts.SyntaxKind.EqualsToken`.
 * 4. That `BinaryExpression` is a top-level `ts.ExpressionStatement` directly in a `ts.SourceFile`.
 * 5. The receiver resolves via the TypeChecker to the exact underlying `targetSymbol` being resolved.
 */
function isFunctionObjectAugmentationReceiver(
  ctx: ResolutionContext,
  decl: ts.Identifier,
  targetSymbol: ts.Symbol,
): boolean {
  const propAccess = decl.parent;
  if (!ts.isPropertyAccessExpression(propAccess) || propAccess.expression !== decl) {
    return false;
  }

  const binary = propAccess.parent;
  if (
    !ts.isBinaryExpression(binary) ||
    binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    binary.left !== propAccess
  ) {
    return false;
  }

  const exprStmt = binary.parent;
  if (!ts.isExpressionStatement(exprStmt) || !ts.isSourceFile(exprStmt.parent)) {
    return false;
  }

  const receiverSym = ctx.checker.getSymbolAtLocation(decl);
  if (receiverSym === undefined) {
    return false;
  }
  const resolvedReceiver =
    (receiverSym.flags & ts.SymbolFlags.Alias) !== 0
      ? resolveValueSymbol(ctx, receiverSym)?.symbol
      : receiverSym;
  return resolvedReceiver === targetSymbol;
}

/**
 * Resolves a compiler symbol to a single unambiguous authoritative runtime target.
 * Conservative invariant: if ANY non-merge declaration is type-only, ambient (`.d.ts` or
 * `declare`), external, stdlib, signature-only, unmapped, or maps to a different target,
 * returns `null` rather than filtering down.
 *
 * Narrow JSX-only exception (`category === 'jsx'`): top-level function-object property
 * augmentation receivers (`Component.property = value`) are skipped independently of
 * declaration order ONLY when the underlying symbol also has a concrete mapped
 * `FunctionDeclaration` (with body) or `const` arrow/function-expression `VariableDeclaration`
 * in the exact same authoritative source file. An augmentation receiver never establishes a
 * target on its own, and `category === 'callable'` remains strictly unchanged.
 */
function resolveSymbolToTarget(
  ctx: ResolutionContext,
  symbol: ts.Symbol,
  category: TargetCategory,
  visitedSymbols: Set<ts.Symbol> = new Set<ts.Symbol>(),
): string | null {
  const valueResolved = resolveValueSymbol(ctx, symbol);
  if (valueResolved === null) {
    return null;
  }

  const resolved = valueResolved.symbol;
  if (visitedSymbols.has(resolved)) {
    return null;
  }
  visitedSymbols.add(resolved);

  const rawDecls = resolved.getDeclarations() ?? [];
  if (rawDecls.length === 0) {
    return null;
  }

  const matchedTargets = new Set<string>();
  const concreteAugmentableImplFiles = new Set<string>();
  const augmentationReceivers: ts.Identifier[] = [];
  let sawValueDeclaration = false;

  for (const decl of rawDecls) {
    if (!isAuthoritativeDeclaration(decl, ctx.authoritativePaths)) {
      return null;
    }
    if (isImportOrExportBindingDeclaration(decl) || isPureTypeOrNamespaceMergeDeclaration(decl)) {
      continue;
    }
    if (isAmbientDeclaration(decl)) {
      return null;
    }

    // Accessors are never direct CallExpression or JSX component targets
    if (ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) {
      return null;
    }

    const mappedQn = ctx.declarationIndex.declarationToQualifiedName.get(decl);
    if (mappedQn !== undefined) {
      sawValueDeclaration = true;
      if (ctx.declarationIndex.signatureOnlyQualifiedNames.has(mappedQn)) {
        return null;
      }
      const nodeType = ctx.declarationIndex.nodeTypeByQualifiedName.get(mappedQn);
      if (category === 'callable') {
        if (nodeType !== 'function') {
          return null;
        }
      } else if (nodeType === 'symbol') {
        if (!ctx.declarationIndex.jsxEligibleSymbolQualifiedNames.has(mappedQn)) {
          return null;
        }
      } else if (nodeType !== 'function' && nodeType !== 'class') {
        return null;
      }

      matchedTargets.add(mappedQn);
      if (category === 'jsx' && isConcreteAugmentableImplDeclaration(ctx, decl)) {
        concreteAugmentableImplFiles.add(normalizeVirtualPath(decl.getSourceFile().fileName));
      }
      continue;
    }

    // Statically bound object property pointing directly to an internal identifier (e.g. `const ui = { Button: MyButton }`)
    if (ts.isPropertyAssignment(decl)) {
      sawValueDeclaration = true;
      const init = unwrapExpression(decl.initializer);
      if (ts.isIdentifier(init)) {
        const initSym = ctx.checker.getSymbolAtLocation(init);
        if (initSym === undefined) {
          return null;
        }
        const chainedTarget = resolveSymbolToTarget(ctx, initSym, category, visitedSymbols);
        if (chainedTarget === null) {
          return null;
        }
        matchedTargets.add(chainedTarget);
        continue;
      }
    }

    // Narrow JSX-only exception: defer top-level property augmentation receiver validation until
    // all declarations are seen so skipping is order-independent and requires a concrete mapped
    // implementation in the exact same authoritative source file.
    if (
      category === 'jsx' &&
      ts.isIdentifier(decl) &&
      isFunctionObjectAugmentationReceiver(ctx, decl, resolved)
    ) {
      augmentationReceivers.push(decl);
      continue;
    }

    // Any unmapped value declaration (parameter, local nested fn, non-HOC const, interface signature) fails closed
    return null;
  }

  if (!sawValueDeclaration || matchedTargets.size !== 1) {
    return null;
  }

  if (augmentationReceivers.length > 0) {
    if (concreteAugmentableImplFiles.size !== 1) {
      return null;
    }
    for (const receiver of augmentationReceivers) {
      const receiverFile = normalizeVirtualPath(receiver.getSourceFile().fileName);
      if (!concreteAugmentableImplFiles.has(receiverFile)) {
        return null;
      }
    }
  }

  const [singleTarget] = matchedTargets;
  return singleTarget ?? null;
}

/**
 * Resolves a property access target on a receiver type, accounting for all constituents of
 * union and intersection types and rejecting unresolved (`any`/`unknown`/`never`) receivers.
 */
function resolvePropertyTargetOnReceiverType(
  ctx: ResolutionContext,
  receiverType: ts.Type,
  propertyName: string,
  allowOptionalNullish: boolean,
  category: TargetCategory,
  depth = 0,
): string | null {
  if (depth > MAX_TYPE_WALK_DEPTH) {
    return null;
  }

  if ((receiverType.flags & UNRESOLVED_TYPE_FLAGS) !== 0) {
    return null;
  }

  if ((receiverType.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = ctx.checker.getBaseConstraintOfType(receiverType);
    if (constraint === undefined) {
      return null;
    }
    return resolvePropertyTargetOnReceiverType(
      ctx,
      constraint,
      propertyName,
      allowOptionalNullish,
      category,
      depth + 1,
    );
  }

  if (receiverType.isUnion()) {
    const activeConstituents: ts.Type[] = [];
    for (const member of receiverType.types) {
      if (allowOptionalNullish && (member.flags & NULLISH_TYPE_FLAGS) !== 0) {
        continue;
      }
      activeConstituents.push(member);
    }
    if (activeConstituents.length === 0) {
      return null;
    }

    let agreedTarget: string | null = null;
    for (const member of activeConstituents) {
      const memberTarget = resolvePropertyTargetOnReceiverType(
        ctx,
        member,
        propertyName,
        allowOptionalNullish,
        category,
        depth + 1,
      );
      if (memberTarget === null) {
        return null;
      }
      if (agreedTarget === null) {
        agreedTarget = memberTarget;
      } else if (agreedTarget !== memberTarget) {
        return null;
      }
    }
    return agreedTarget;
  }

  if (receiverType.isIntersection()) {
    const targets = new Set<string>();
    for (const member of receiverType.types) {
      if ((member.flags & UNRESOLVED_TYPE_FLAGS) !== 0) {
        return null;
      }
      const hasProp = ctx.checker.getPropertyOfType(member, propertyName) !== undefined;
      if (!hasProp) {
        continue;
      }
      const memberTarget = resolvePropertyTargetOnReceiverType(
        ctx,
        member,
        propertyName,
        false,
        category,
        depth + 1,
      );
      if (memberTarget === null) {
        return null;
      }
      targets.add(memberTarget);
    }
    if (targets.size !== 1) {
      return null;
    }
    const [singleTarget] = targets;
    return singleTarget ?? null;
  }

  const propSym = ctx.checker.getPropertyOfType(receiverType, propertyName);
  if (propSym === undefined) {
    return null;
  }

  return resolveSymbolToTarget(ctx, propSym, category);
}

/**
 * Resolves a class instantiation expression (`ClassName` or `ns.ClassName`) to its approved target:
 * - Explicit emitted `::ctor` node when declared on THAT exact class (and not signature-only).
 * - Otherwise the instantiated `::class:Name` node directly (never redirecting `new Child()` to `Parent::ctor`).
 * - Rejects `any`/`unknown` assertions, type-only bindings, ambient/declaration-only classes
 *   (`.d.ts`, `declare`, enclosing ambient context), non-constructable targets, and direct
 *   instantiation of `abstract` classes (while allowing `super()` to target an abstract base class).
 */
function resolveClassInstantiationTarget(
  ctx: ResolutionContext,
  classExpr: ts.Expression,
  allowAbstract = false,
): string | null {
  if (hasUnresolvedExpressionOrAssertion(ctx.checker, classExpr)) {
    return null;
  }

  const exprType = ctx.checker.getTypeAtLocation(classExpr);
  if (!allowAbstract) {
    const constructSigs = ctx.checker.getSignaturesOfType(exprType, ts.SignatureKind.Construct);
    if (constructSigs.length === 0) {
      return null;
    }
  }

  const unwrapped = unwrapExpression(classExpr);

  let classSymbol: ts.Symbol | undefined;
  if (ts.isIdentifier(unwrapped)) {
    classSymbol = ctx.checker.getSymbolAtLocation(unwrapped);
  } else if (ts.isPropertyAccessExpression(unwrapped)) {
    if (hasUnresolvedExpressionOrAssertion(ctx.checker, unwrapped.expression)) {
      return null;
    }
    const receiverProv = inspectReceiverProvenance(ctx, unwrapped.expression);
    if (receiverProv.blocked) {
      return null;
    }
    if (
      receiverProv.namespaceVirtualPath !== null &&
      !isValueExportedByModule(ctx, receiverProv.namespaceVirtualPath, unwrapped.name.text)
    ) {
      return null;
    }

    const receiverType = ctx.checker.getTypeAtLocation(unwrapped.expression);
    if (
      (receiverType.flags & UNRESOLVED_TYPE_FLAGS) !== 0 ||
      receiverType.isUnion() ||
      receiverType.isIntersection()
    ) {
      return null;
    }
    classSymbol = ctx.checker.getPropertyOfType(receiverType, unwrapped.name.text);
  } else {
    return null;
  }

  if (classSymbol === undefined) {
    return null;
  }

  const valueResolved = resolveValueSymbol(ctx, classSymbol);
  if (valueResolved === null) {
    return null;
  }

  const rawDecls = valueResolved.symbol.getDeclarations() ?? [];
  if (rawDecls.length === 0) {
    return null;
  }

  const classTargets = new Set<string>();
  const explicitCtors = new Set<string>();
  let sawValueDeclaration = false;

  for (const decl of rawDecls) {
    if (!isAuthoritativeDeclaration(decl, ctx.authoritativePaths)) {
      return null;
    }
    if (isImportOrExportBindingDeclaration(decl) || isPureTypeOrNamespaceMergeDeclaration(decl)) {
      continue;
    }
    if (isAmbientDeclaration(decl)) {
      return null;
    }
    if (!allowAbstract && hasModifier(decl, ts.SyntaxKind.AbstractKeyword)) {
      return null;
    }

    sawValueDeclaration = true;
    const mappedQn = ctx.declarationIndex.declarationToQualifiedName.get(decl);
    if (mappedQn === undefined) {
      return null;
    }
    if (ctx.declarationIndex.nodeTypeByQualifiedName.get(mappedQn) !== 'class') {
      return null;
    }

    classTargets.add(mappedQn);
    const ownCtor = ctx.declarationIndex.classToConstructorQualifiedName.get(decl);
    if (ownCtor !== undefined) {
      explicitCtors.add(ownCtor);
    }
  }

  if (!sawValueDeclaration || classTargets.size !== 1) {
    return null;
  }

  if (explicitCtors.size > 1) {
    return null;
  }

  const [ownCtorQn] = explicitCtors;
  if (ownCtorQn !== undefined) {
    if (ctx.declarationIndex.signatureOnlyQualifiedNames.has(ownCtorQn)) {
      return null;
    }
    return ownCtorQn;
  }

  const [classQn] = classTargets;
  return classQn ?? null;
}

/**
 * Finds the enclosing class ONLY when `node` appears directly inside a `ConstructorDeclaration`
 * body (rejecting semantically invalid `super()` inside ordinary methods, accessors, static
 * blocks, or nested functions).
 */
function findEnclosingConstructorClass(node: ts.Node): ts.ClassLikeDeclaration | null {
  let prev = node;
  while (!ts.isSourceFile(prev)) {
    const current = prev.parent;
    if (ts.isConstructorDeclaration(current)) {
      if (current.body === undefined || prev !== current.body) {
        return null;
      }
      const owner = current.parent;
      if (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) {
        return owner;
      }
      return null;
    }
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isClassStaticBlockDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isClassExpression(current)
    ) {
      return null;
    }
    prev = current;
  }
  return null;
}

/**
 * Resolves explicit `super(...)` inside a derived class constructor body against its direct
 * static `extends Base` expression using the same constructor policy as `new Base()`.
 */
function resolveSuperCallTarget(
  ctx: ResolutionContext,
  callExpr: ts.CallExpression,
): string | null {
  const enclosingClass = findEnclosingConstructorClass(callExpr);
  if (enclosingClass?.heritageClauses === undefined) {
    return null;
  }

  const extendsClauses = enclosingClass.heritageClauses.filter(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  );
  if (extendsClauses.length !== 1) {
    return null;
  }

  const extendsClause = extendsClauses[0];
  if (extendsClause?.types.length !== 1) {
    return null;
  }

  const baseTypeNode = extendsClause.types[0];
  if (baseTypeNode === undefined) {
    return null;
  }

  return resolveClassInstantiationTarget(ctx, baseTypeNode.expression, true);
}

function isSingleSignatureCompatible(
  ctx: ResolutionContext,
  sig: ts.Signature,
  symbolTargetQn: string,
): boolean {
  const sigDecl = sig.declaration;
  if (sigDecl === undefined) {
    return false;
  }

  if (!isAuthoritativeDeclaration(sigDecl, ctx.authoritativePaths)) {
    return isTypeLevelSignatureDeclaration(sigDecl);
  }

  // Allow type-level function signatures (including those in `.d.ts` files) annotating concrete internal functions
  if (isTypeLevelSignatureDeclaration(sigDecl)) {
    return true;
  }

  if (isAmbientDeclaration(sigDecl)) {
    return false;
  }

  const sigMappedQn = ctx.declarationIndex.declarationToQualifiedName.get(sigDecl);
  if (sigMappedQn === undefined) {
    return false;
  }
  if (ctx.declarationIndex.signatureOnlyQualifiedNames.has(sigMappedQn)) {
    return false;
  }
  return sigMappedQn === symbolTargetQn;
}

/**
 * Complementary callable & resolved-signature verification for `CallExpression`:
 * - Requires the effective callee type to expose at least one call signature.
 * - Verifies `getResolvedSignature(callExpr)` exists and agrees with `symbolTargetQn`
 *   (allowing type-level function annotations on verified concrete internal functions).
 * - Never blindly accepts missing/synthetic signatures whose declarations are absent.
 */
function isSignatureCompatibleWithTarget(
  ctx: ResolutionContext,
  callExpr: ts.CallExpression,
  callee: ts.Expression,
  symbolTargetQn: string,
): boolean {
  const rawCalleeType = ctx.checker.getTypeAtLocation(callExpr.expression);
  const effectiveCalleeType =
    ts.isCallChain(callExpr) || ts.isPropertyAccessChain(callee)
      ? ctx.checker.getNonNullableType(rawCalleeType)
      : rawCalleeType;

  const callSignatures = ctx.checker.getSignaturesOfType(
    effectiveCalleeType,
    ts.SignatureKind.Call,
  );
  if (callSignatures.length === 0) {
    return false;
  }

  const resolvedSig = ctx.checker.getResolvedSignature(callExpr);
  if (resolvedSig === undefined) {
    return false;
  }

  if (resolvedSig.declaration !== undefined) {
    return isSingleSignatureCompatible(ctx, resolvedSig, symbolTargetQn);
  }

  return callSignatures.every((sig) => isSingleSignatureCompatible(ctx, sig, symbolTargetQn));
}

function resolveCallExpressionTarget(
  ctx: ResolutionContext,
  callExpr: ts.CallExpression,
): string | null {
  const callee = unwrapExpression(callExpr.expression);

  if (callee.kind === ts.SyntaxKind.SuperKeyword) {
    return resolveSuperCallTarget(ctx, callExpr);
  }

  // Reject explicit `any`/`unknown`/`never` outer expressions or intermediate type assertions
  if (hasUnresolvedExpressionOrAssertion(ctx.checker, callExpr.expression)) {
    return null;
  }

  // Reject dynamic element-access calls (`obj[key]()`)
  if (ts.isElementAccessExpression(callee)) {
    return null;
  }

  let symbolTargetQn: string | null;

  if (ts.isIdentifier(callee)) {
    const sym = ctx.checker.getSymbolAtLocation(callee);
    if (sym === undefined) {
      return null;
    }
    symbolTargetQn = resolveSymbolToTarget(ctx, sym, 'callable');
  } else if (ts.isPropertyAccessExpression(callee)) {
    if (
      callee.expression.kind !== ts.SyntaxKind.SuperKeyword &&
      hasUnresolvedExpressionOrAssertion(ctx.checker, callee.expression)
    ) {
      return null;
    }
    if (callee.expression.kind !== ts.SyntaxKind.SuperKeyword) {
      const receiverProv = inspectReceiverProvenance(ctx, callee.expression);
      if (receiverProv.blocked) {
        return null;
      }
      if (
        receiverProv.namespaceVirtualPath !== null &&
        !isValueExportedByModule(ctx, receiverProv.namespaceVirtualPath, callee.name.text)
      ) {
        return null;
      }
    }
    const receiverType = ctx.checker.getTypeAtLocation(callee.expression);
    const allowOptionalNullish = ts.isPropertyAccessChain(callee);
    symbolTargetQn = resolvePropertyTargetOnReceiverType(
      ctx,
      receiverType,
      callee.name.text,
      allowOptionalNullish,
      'callable',
    );
  } else {
    return null;
  }

  if (symbolTargetQn === null) {
    return null;
  }

  if (!isSignatureCompatibleWithTarget(ctx, callExpr, callee, symbolTargetQn)) {
    return null;
  }

  return symbolTargetQn;
}

function resolveJsxComponentTarget(
  ctx: ResolutionContext,
  tagName: ts.JsxTagNameExpression,
): string | null {
  // Exclude namespaced intrinsic tags (`<svg:path />`) and `<this />`
  if (ts.isJsxNamespacedName(tagName) || tagName.kind === ts.SyntaxKind.ThisKeyword) {
    return null;
  }

  if (ts.isIdentifier(tagName)) {
    // Exclude intrinsic HTML/SVG lowercase elements (`<div>`, `<span>`, `<custom-el>`)
    if (/^[a-z]/.test(tagName.text)) {
      return null;
    }
    const sym = ctx.checker.getSymbolAtLocation(tagName);
    if (sym === undefined) {
      return null;
    }
    return resolveSymbolToTarget(ctx, sym, 'jsx');
  }

  if (ts.isPropertyAccessExpression(tagName)) {
    const receiverProv = inspectReceiverProvenance(ctx, tagName.expression);
    if (receiverProv.blocked) {
      return null;
    }
    if (
      receiverProv.namespaceVirtualPath !== null &&
      !isValueExportedByModule(ctx, receiverProv.namespaceVirtualPath, tagName.name.text)
    ) {
      return null;
    }
    const receiverType = ctx.checker.getTypeAtLocation(tagName.expression);
    return resolvePropertyTargetOnReceiverType(ctx, receiverType, tagName.name.text, false, 'jsx');
  }

  return null;
}

/**
 * Extracts deterministic, line-deduplicated `CALLS` edges from the syntax-clean ASTs of an
 * `AnalysisProjectContext`, using the shared `TypeChecker` (`compilerObject`) and authoritative
 * `DeclarationNodeIndex` populated during node extraction.
 */
export function extractCallEdges(options: ExtractCallsOptions): readonly ExtractedEdge[] {
  const maxSnippetChars = validateMaxCallSiteSnippetChars(options.maxCallSiteSnippetChars);
  const { projectContext, declarationIndex } = options;

  const parsedFilesByVirtualPath = new Map<string, ts.SourceFile>();
  for (const entry of projectContext.parsedFiles) {
    parsedFilesByVirtualPath.set(
      normalizeVirtualPath(entry.virtualPath),
      entry.sourceFile.compilerNode,
    );
  }

  const ctx: ResolutionContext = {
    checker: projectContext.project.getTypeChecker().compilerObject,
    projectContext,
    declarationIndex,
    authoritativePaths: projectContext.parsedVirtualPaths,
    parsedFilesByVirtualPath,
    valueExportCache: new Map<string, boolean>(),
  };

  const dedupedEdges = new Map<string, ExtractedEdge>();

  const recordEdge = (
    siteNode: ts.Node,
    targetQn: string,
    sf: ts.SourceFile,
    textIndex: SourceTextIndex,
  ): void => {
    if (!declarationIndex.nodeTypeByQualifiedName.has(targetQn)) {
      return;
    }
    const sourceQn = findEnclosingScopeQualifiedName(siteNode, declarationIndex);
    if (sourceQn === null || !declarationIndex.nodeTypeByQualifiedName.has(sourceQn)) {
      return;
    }

    const startOffset = siteNode.getStart(sf, false);
    const endOffset = siteNode.getEnd();
    const startLoc = textIndex.getLineAndColumnAtOffset(startOffset);
    const endLoc = textIndex.getLineAndColumnAtOffset(Math.max(startOffset, endOffset - 1));

    const dedupeKey = `${sourceQn}\0${targetQn}\0CALLS\0${startLoc.line}`;
    if (dedupedEdges.has(dedupeKey)) {
      return;
    }

    const callEndCol =
      endLoc.line === startLoc.line ? endLoc.columnZeroBased + 1 : startLoc.columnZeroBased + 1;

    dedupedEdges.set(dedupeKey, {
      sourceQualifiedName: sourceQn,
      targetQualifiedName: targetQn,
      edgeType: 'CALLS',
      callSiteLine: startLoc.line,
      callSiteSnippet: textIndex.extractCallSiteSnippet(
        startLoc.line,
        startLoc.columnZeroBased,
        callEndCol,
        maxSnippetChars,
      ),
    });
  };

  for (const entry of projectContext.parsedFiles) {
    const sf = entry.sourceFile.compilerNode;
    if (sf.isDeclarationFile) {
      continue;
    }
    const textIndex = new SourceTextIndex(entry.sourceText);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const targetQn = resolveCallExpressionTarget(ctx, node);
        if (targetQn !== null) {
          recordEdge(node, targetQn, sf, textIndex);
        }
      } else if (ts.isNewExpression(node)) {
        const targetQn = resolveClassInstantiationTarget(ctx, node.expression);
        if (targetQn !== null) {
          recordEdge(node, targetQn, sf, textIndex);
        }
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const targetQn = resolveJsxComponentTarget(ctx, node.tagName);
        if (targetQn !== null) {
          recordEdge(node, targetQn, sf, textIndex);
        }
      }

      ts.forEachChild(node, (child) => {
        visit(child);
      });
    };

    ts.forEachChild(sf, (child) => {
      visit(child);
    });
  }

  return [...dedupedEdges.values()].sort(compareExtractedEdges);
}
