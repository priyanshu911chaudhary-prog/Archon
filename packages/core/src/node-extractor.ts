import { createHash } from 'node:crypto';
import { posix as posixPath } from 'node:path';
import { type SourceFile, ts } from 'ts-morph';
import { compareCodePoint } from './discovery.js';
import type { AnalysisSourceFileEntry } from './project.js';
import {
  QualifiedNameRegistry,
  buildAccessorQualifiedName,
  buildClassQualifiedName,
  buildConstructorQualifiedName,
  buildDefaultExportQualifiedName,
  buildFileQualifiedName,
  buildFolderQualifiedName,
  buildFunctionQualifiedName,
  buildMethodQualifiedName,
  buildSymbolQualifiedName,
  type SourceLocation,
} from './qualified-name.js';
import {
  DEFAULT_MAX_FILE_SNIPPET_CHARS,
  DEFAULT_MAX_SYMBOL_SNIPPET_CHARS,
  type ExtractedNode,
  type NodeType,
} from './types.js';

export interface ExtractNodesOptions {
  readonly parsedFiles: readonly AnalysisSourceFileEntry[];
  readonly maxFileSnippetChars?: number;
  readonly maxSymbolSnippetChars?: number;
}

export interface DeclarationNodeIndex {
  /** Maps compiler AST declaration nodes (including overloads & initializers) to their allocated qualifiedName. */
  readonly declarationToQualifiedName: ReadonlyMap<ts.Node, string>;
  /** Maps emitted scope-owning AST nodes to their allocated qualifiedName for CALLS source attribution. */
  readonly enclosingScopeToQualifiedName: ReadonlyMap<ts.Node, string>;
  /** Maps class declarations/expressions (and bindings) with an explicit constructor to its allocated ::ctor qualifiedName. */
  readonly classToConstructorQualifiedName: ReadonlyMap<ts.Node, string>;
  /** 1:1 map of every emitted ExtractedNode qualifiedName to its NodeType. */
  readonly nodeTypeByQualifiedName: ReadonlyMap<string, NodeType>;
  /** Emitted function/method/constructor qualifiedNames whose overload group had no implementation body. */
  readonly signatureOnlyQualifiedNames: ReadonlySet<string>;
  /** Exported symbol qualifiedNames eligible for JSX component usage via statically recognized HOC wrappers (forwardRef/memo). */
  readonly jsxEligibleSymbolQualifiedNames: ReadonlySet<string>;
}

export interface ExtractNodesWithIndexResult {
  readonly nodes: readonly ExtractedNode[];
  readonly declarationIndex: DeclarationNodeIndex;
}

interface MutableDeclarationIndex {
  readonly declarationToQualifiedName: Map<ts.Node, string>;
  readonly enclosingScopeToQualifiedName: Map<ts.Node, string>;
  readonly classToConstructorQualifiedName: Map<ts.Node, string>;
  readonly nodeTypeByQualifiedName: Map<string, NodeType>;
  readonly signatureOnlyQualifiedNames: Set<string>;
  readonly jsxEligibleSymbolQualifiedNames: Set<string>;
}

const RECOGNIZED_JSX_HOC_NAMES = new Set(['forwardRef', 'memo']);

interface FileReactHocContext {
  readonly directHocBindings: ReadonlySet<string>;
  readonly reactNamespaceBindings: ReadonlySet<string>;
  readonly localComponentNames: ReadonlySet<string>;
}

function collectTopLevelBindingNames(binding: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(binding)) {
    out.add(binding.text);
    return;
  }
  for (const element of binding.elements) {
    if (ts.isBindingElement(element)) {
      collectTopLevelBindingNames(element.name, out);
    }
  }
}

function isRecognizableJsxHocCallee(callee: ts.Expression, context: FileReactHocContext): boolean {
  const unwrapped = unwrapExpression(callee);
  if (ts.isIdentifier(unwrapped)) {
    return context.directHocBindings.has(unwrapped.text);
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const obj = unwrapExpression(unwrapped.expression);
    return (
      ts.isIdentifier(obj) &&
      context.reactNamespaceBindings.has(obj.text) &&
      RECOGNIZED_JSX_HOC_NAMES.has(unwrapped.name.text)
    );
  }
  return false;
}

function isRecognizableJsxHocArgument(arg: ts.Expression, context: FileReactHocContext): boolean {
  const unwrapped = unwrapExpression(arg);
  if (
    ts.isArrowFunction(unwrapped) ||
    ts.isFunctionExpression(unwrapped) ||
    ts.isClassExpression(unwrapped)
  ) {
    return true;
  }
  if (ts.isIdentifier(unwrapped)) {
    return context.localComponentNames.has(unwrapped.text);
  }
  return isRecognizableJsxHocExpression(unwrapped, context);
}

/**
 * Recognizes statically identifiable React component HOC wrappers bound via non-type-only
 * `'react'` imports (`memo`, `forwardRef`, aliases, `React.memo`, `React.forwardRef`, and
 * nested compositions) without requiring React or external type declarations to be installed.
 * This is a conservative component-binding heuristic, not proof of React runtime behavior.
 */
function isRecognizableJsxHocExpression(
  expr: ts.Expression,
  context: FileReactHocContext,
): boolean {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isCallExpression(unwrapped)) {
    return false;
  }
  if (!isRecognizableJsxHocCallee(unwrapped.expression, context)) {
    return false;
  }
  const firstArg = unwrapped.arguments[0];
  return firstArg !== undefined && isRecognizableJsxHocArgument(firstArg, context);
}

function collectFileReactHocContext(
  sourceFile: SourceFile,
  sf: ts.SourceFile,
): FileReactHocContext {
  // Declaration files (.d.ts) contain no runtime React HOC component implementations
  if (sf.isDeclarationFile) {
    return {
      directHocBindings: new Set<string>(),
      reactNamespaceBindings: new Set<string>(),
      localComponentNames: new Set<string>(),
    };
  }

  // Separate names that occupy/shadow local bindings from eligible runtime component candidates
  const valueDeclaredTopLevelNames = new Set<string>();
  const localComponentNames = new Set<string>();
  const candidateVarDecls: { readonly name: string; readonly init: ts.Expression }[] = [];

  for (const stmt of sf.statements) {
    const isAmbientStmt = hasModifier(stmt, ts.SyntaxKind.DeclareKeyword);

    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
      valueDeclaredTopLevelNames.add(stmt.name.text);
      // Require an actual implementation body and non-ambient context (preserves implemented overload groups)
      if (!isAmbientStmt && stmt.body !== undefined) {
        localComponentNames.add(stmt.name.text);
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name !== undefined) {
      valueDeclaredTopLevelNames.add(stmt.name.text);
      // Reject ambient and abstract classes while keeping concrete classes with implicit constructors
      if (!isAmbientStmt && !hasModifier(stmt, ts.SyntaxKind.AbstractKeyword)) {
        localComponentNames.add(stmt.name.text);
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        collectTopLevelBindingNames(decl.name, valueDeclaredTopLevelNames);
        if (isAmbientStmt || !ts.isIdentifier(decl.name) || decl.initializer === undefined) {
          continue;
        }
        const init = unwrapExpression(decl.initializer);
        if (
          ts.isArrowFunction(init) ||
          ts.isFunctionExpression(init) ||
          ts.isClassExpression(init)
        ) {
          localComponentNames.add(decl.name.text);
        } else {
          candidateVarDecls.push({ name: decl.name.text, init });
        }
      }
    }
  }

  const directHocBindings = new Set<string>();
  const reactNamespaceBindings = new Set<string>();

  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.isTypeOnly() || importDecl.getModuleSpecifierValue() !== 'react') {
      continue;
    }
    const clause = importDecl.compilerNode.importClause;
    if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
      continue;
    }
    if (clause.name !== undefined && !valueDeclaredTopLevelNames.has(clause.name.text)) {
      reactNamespaceBindings.add(clause.name.text);
    }
    const namedBindings = clause.namedBindings;
    if (namedBindings !== undefined) {
      if (ts.isNamespaceImport(namedBindings)) {
        if (!valueDeclaredTopLevelNames.has(namedBindings.name.text)) {
          reactNamespaceBindings.add(namedBindings.name.text);
        }
      } else if (ts.isNamedImports(namedBindings)) {
        for (const spec of namedBindings.elements) {
          if (spec.isTypeOnly) {
            continue;
          }
          const importedName = (spec.propertyName ?? spec.name).text;
          if (
            RECOGNIZED_JSX_HOC_NAMES.has(importedName) &&
            !valueDeclaredTopLevelNames.has(spec.name.text)
          ) {
            directHocBindings.add(spec.name.text);
          }
        }
      }
    }
  }

  const context: FileReactHocContext = {
    directHocBindings,
    reactNamespaceBindings,
    localComponentNames,
  };

  // Fixed-point pass so `const Base = forwardRef(...); export const Outer = memo(Base);` resolves cleanly
  if (directHocBindings.size > 0 || reactNamespaceBindings.size > 0) {
    let added = true;
    while (added) {
      added = false;
      for (const candidate of candidateVarDecls) {
        if (
          !localComponentNames.has(candidate.name) &&
          isRecognizableJsxHocExpression(candidate.init, context)
        ) {
          localComponentNames.add(candidate.name);
          added = true;
        }
      }
    }
  }

  return context;
}

/**
 * Walks upward from an AST expression to its nearest emitted enclosing scope node,
 * respecting definition-time boundaries outside callable/class bodies:
 * - Expressions in a member's computed property name or decorator walk past the member to the enclosing class.
 * - Expressions in a class decorator or heritage clause (`extends expr`) walk past the class to the enclosing file/callable.
 */
export function findEnclosingScopeQualifiedName(
  node: ts.Node,
  index: DeclarationNodeIndex,
): string | null {
  let prev = node;

  while (!ts.isSourceFile(prev)) {
    const current = prev.parent;
    const scopeQn = index.enclosingScopeToQualifiedName.get(current);

    if (scopeQn !== undefined) {
      if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
        const isInsideMember = current.members.some((member) => member === prev);

        if (!isInsideMember) {
          prev = current;
          continue;
        }
      } else if (
        ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current) ||
        ts.isConstructorDeclaration(current)
      ) {
        const isDecorator = prev.kind === ts.SyntaxKind.Decorator;
        const isDeclaredName = !ts.isConstructorDeclaration(current) && current.name === prev;

        if (isDecorator || isDeclaredName) {
          prev = current;
          continue;
        }
      }

      return scopeQn;
    }

    prev = current;
  }

  return null;
}

function registerOverloadGroupDeclarations<
  T extends ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration,
>(
  group: readonly T[],
  allocatedByImpl: ReadonlyMap<T, string>,
  fallbackQn: string,
  index: MutableDeclarationIndex,
): void {
  for (let i = 0; i < group.length; i += 1) {
    const decl = group[i];
    if (decl === undefined) {
      continue;
    }
    const directQn = allocatedByImpl.get(decl);
    if (directQn !== undefined) {
      index.declarationToQualifiedName.set(decl, directQn);
      continue;
    }
    // Map overload signature to the next implementation in the group, falling back to primary
    let matchedQn = fallbackQn;
    for (let j = i + 1; j < group.length; j += 1) {
      const nextDecl = group[j];
      if (nextDecl !== undefined) {
        const nextQn = allocatedByImpl.get(nextDecl);
        if (nextQn !== undefined) {
          matchedQn = nextQn;
          break;
        }
      }
    }
    index.declarationToQualifiedName.set(decl, matchedQn);
  }
}

class LineIndex {
  private readonly lineStarts: readonly number[];

  constructor(private readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) {
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
  }

  getLocationAtOffset(offset: number): SourceLocation {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const lineStart = this.lineStarts[mid] ?? 0;
      if (lineStart <= clamped) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const lineIdx = Math.max(0, high);
    const lineStart = this.lineStarts[lineIdx] ?? 0;
    return {
      line: lineIdx + 1,
      column: clamped - lineStart + 1,
    };
  }

  getTotalLines(): number {
    if (this.text.length === 0) {
      return 1;
    }
    return this.lineStarts.length;
  }
}

function normalizeLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sha256Lf(text: string): string {
  return createHash('sha256').update(normalizeLf(text), 'utf8').digest('hex');
}

function boundSnippet(text: string, maxChars: number): string {
  const normalized = normalizeLf(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, maxChars);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === kind) ?? false;
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

function getPropertyNameText(name: ts.PropertyName, sf: ts.SourceFile): string | null {
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  if (
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isBigIntLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrapExpression(name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
      return inner.text;
    }
    return `[${inner.getText(sf)}]`;
  }
  return null;
}

function isModuleExportsExpr(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'module' &&
    expr.name.text === 'exports'
  );
}

function getCjsNamedExport(left: ts.Expression): string | null {
  // exports.foo = ...
  if (
    ts.isPropertyAccessExpression(left) &&
    ts.isIdentifier(left.expression) &&
    left.expression.text === 'exports'
  ) {
    return left.name.text;
  }
  // module.exports.foo = ...
  if (ts.isPropertyAccessExpression(left) && isModuleExportsExpr(left.expression)) {
    return left.name.text;
  }
  return null;
}

interface ExportMetadata {
  readonly locallyExportedNames: ReadonlySet<string>;
  readonly declaredTopLevelNames: ReadonlySet<string>;
}

/**
 * Collects top-level local export lists (`export { a, b as c }`), `export default id`,
 * `export = id`, and statically recognizable CJS exports (`module.exports = id`,
 * `module.exports = { a, b: id }`, `exports.x = id`) so declarations are marked `isExported: true`.
 */
function collectFileExportMetadata(sf: ts.SourceFile): ExportMetadata {
  const declaredTopLevelNames = new Set<string>();
  const locallyExportedNames = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
      declaredTopLevelNames.add(stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name !== undefined) {
      declaredTopLevelNames.add(stmt.name.text);
    } else if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      declaredTopLevelNames.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          declaredTopLevelNames.add(decl.name.text);
        }
      }
    }
  }

  for (const stmt of sf.statements) {
    // Local export list: `export { foo, bar as baz }` (no moduleSpecifier)
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier === undefined &&
      stmt.exportClause !== undefined &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const spec of stmt.exportClause.elements) {
        const localName = (spec.propertyName ?? spec.name).text;
        locallyExportedNames.add(localName);
      }
      continue;
    }

    // `export default localId` or `export = localId`
    if (ts.isExportAssignment(stmt)) {
      const inner = unwrapExpression(stmt.expression);
      if (ts.isIdentifier(inner)) {
        locallyExportedNames.add(inner.text);
      }
      continue;
    }

    // Top-level CommonJS assignments: `module.exports = ...` / `exports.x = ...`
    if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const { left, right } = stmt.expression;
      const rhs = unwrapExpression(right);

      if (isModuleExportsExpr(left)) {
        if (ts.isIdentifier(rhs)) {
          locallyExportedNames.add(rhs.text);
        } else if (ts.isObjectLiteralExpression(rhs)) {
          for (const prop of rhs.properties) {
            if (ts.isShorthandPropertyAssignment(prop)) {
              locallyExportedNames.add(prop.name.text);
            } else if (ts.isPropertyAssignment(prop)) {
              const propRhs = unwrapExpression(prop.initializer);
              if (ts.isIdentifier(propRhs)) {
                locallyExportedNames.add(propRhs.text);
              }
            }
          }
        }
      } else if (getCjsNamedExport(left) !== null && ts.isIdentifier(rhs)) {
        locallyExportedNames.add(rhs.text);
      }
    }
  }

  return { locallyExportedNames, declaredTopLevelNames };
}

function getNodeRange(
  node: ts.Node,
  sf: ts.SourceFile,
  lineIndex: LineIndex,
): { readonly startLoc: SourceLocation; readonly endLine: number; readonly rawText: string } {
  const startOffset = node.getStart(sf, false);
  const endOffset = Math.max(startOffset, node.getEnd() - 1);
  const startLoc = lineIndex.getLocationAtOffset(startOffset);
  const endLoc = lineIndex.getLocationAtOffset(endOffset);
  return {
    startLoc,
    endLine: Math.max(startLoc.line, endLoc.line),
    rawText: sf.text.slice(startOffset, node.getEnd()),
  };
}

function extractClassMembers(
  classLike: ts.ClassLikeDeclaration,
  classBindingNodes: readonly ts.Node[],
  parentClassQualifiedName: string,
  filePath: string,
  sf: ts.SourceFile,
  lineIndex: LineIndex,
  registry: QualifiedNameRegistry,
  maxSymbolSnippetChars: number,
  outNodes: ExtractedNode[],
  index: MutableDeclarationIndex,
): void {
  // 1. Constructors (collapse overload signatures onto single implementation)
  const constructors: ts.ConstructorDeclaration[] = [];
  for (const member of classLike.members) {
    if (ts.isConstructorDeclaration(member)) {
      constructors.push(member);
    }
  }
  if (constructors.length > 0) {
    const impls = constructors.filter((c) => c.body !== undefined);
    const signatureOnly = impls.length === 0;
    const chosen = impls.length > 0 ? impls : constructors.slice(0, 1);
    const allocatedByCtor = new Map<ts.ConstructorDeclaration, string>();
    let primaryCtorQn: string | undefined;

    for (const ctor of chosen) {
      const range = getNodeRange(ctor, sf, lineIndex);
      const qn = registry.allocate(
        buildConstructorQualifiedName(parentClassQualifiedName),
        range.startLoc,
      );
      primaryCtorQn ??= qn;
      allocatedByCtor.set(ctor, qn);
      outNodes.push({
        nodeType: 'function',
        name: 'constructor',
        qualifiedName: qn,
        filePath,
        parentQualifiedName: parentClassQualifiedName,
        isExported: false,
        startLine: range.startLoc.line,
        endLine: range.endLine,
        contentHash: sha256Lf(range.rawText),
        snippet: boundSnippet(range.rawText, maxSymbolSnippetChars),
      });
      index.nodeTypeByQualifiedName.set(qn, 'function');
      if (signatureOnly) {
        index.signatureOnlyQualifiedNames.add(qn);
      } else {
        index.enclosingScopeToQualifiedName.set(ctor, qn);
      }
    }

    if (primaryCtorQn !== undefined) {
      registerOverloadGroupDeclarations(constructors, allocatedByCtor, primaryCtorQn, index);
      index.classToConstructorQualifiedName.set(classLike, primaryCtorQn);
      for (const bindingNode of classBindingNodes) {
        index.classToConstructorQualifiedName.set(bindingNode, primaryCtorQn);
      }
    }
  }

  // 2. Methods (group by isStatic + name so overload signatures collapse cleanly)
  const methodGroups = new Map<string, ts.MethodDeclaration[]>();
  for (const member of classLike.members) {
    if (!ts.isMethodDeclaration(member)) {
      continue;
    }
    const name = getPropertyNameText(member.name, sf);
    if (name === null) {
      continue;
    }
    const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
    const key = `${isStatic ? 'static' : 'instance'}:${name}`;
    const existing = methodGroups.get(key);
    if (existing !== undefined) {
      existing.push(member);
    } else {
      methodGroups.set(key, [member]);
    }
  }

  for (const group of methodGroups.values()) {
    const impls = group.filter((m) => m.body !== undefined);
    const signatureOnly = impls.length === 0;
    const chosen = impls.length > 0 ? impls : group.slice(0, 1);
    const allocatedByMethod = new Map<ts.MethodDeclaration, string>();
    let primaryMethodQn: string | undefined;

    for (const method of chosen) {
      const name = getPropertyNameText(method.name, sf);
      if (name === null) {
        continue;
      }
      const isStatic = hasModifier(method, ts.SyntaxKind.StaticKeyword);
      const range = getNodeRange(method, sf, lineIndex);
      const qn = registry.allocate(
        buildMethodQualifiedName(parentClassQualifiedName, name, isStatic),
        range.startLoc,
      );
      primaryMethodQn ??= qn;
      allocatedByMethod.set(method, qn);
      outNodes.push({
        nodeType: 'function',
        name,
        qualifiedName: qn,
        filePath,
        parentQualifiedName: parentClassQualifiedName,
        isExported: false,
        startLine: range.startLoc.line,
        endLine: range.endLine,
        contentHash: sha256Lf(range.rawText),
        snippet: boundSnippet(range.rawText, maxSymbolSnippetChars),
      });
      index.nodeTypeByQualifiedName.set(qn, 'function');
      if (signatureOnly) {
        index.signatureOnlyQualifiedNames.add(qn);
      } else {
        index.enclosingScopeToQualifiedName.set(method, qn);
      }
    }

    if (primaryMethodQn !== undefined) {
      registerOverloadGroupDeclarations(group, allocatedByMethod, primaryMethodQn, index);
    }
  }

  // 3. Getters, setters, and arrow/function property methods
  for (const member of classLike.members) {
    if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      const name = getPropertyNameText(member.name, sf);
      if (name === null) {
        continue;
      }
      const accessorKind = ts.isGetAccessorDeclaration(member) ? 'get' : 'set';
      const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
      const range = getNodeRange(member, sf, lineIndex);
      const qn = registry.allocate(
        buildAccessorQualifiedName(parentClassQualifiedName, name, accessorKind, isStatic),
        range.startLoc,
      );
      outNodes.push({
        nodeType: 'function',
        name,
        qualifiedName: qn,
        filePath,
        parentQualifiedName: parentClassQualifiedName,
        isExported: false,
        startLine: range.startLoc.line,
        endLine: range.endLine,
        contentHash: sha256Lf(range.rawText),
        snippet: boundSnippet(range.rawText, maxSymbolSnippetChars),
      });
      index.nodeTypeByQualifiedName.set(qn, 'function');
      index.declarationToQualifiedName.set(member, qn);
      if (member.body === undefined) {
        index.signatureOnlyQualifiedNames.add(qn);
      } else {
        index.enclosingScopeToQualifiedName.set(member, qn);
      }
      continue;
    }

    if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
      const init = unwrapExpression(member.initializer);
      if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) {
        continue;
      }
      const name = getPropertyNameText(member.name, sf);
      if (name === null) {
        continue;
      }
      const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
      const range = getNodeRange(member, sf, lineIndex);
      const qn = registry.allocate(
        buildMethodQualifiedName(parentClassQualifiedName, name, isStatic),
        range.startLoc,
      );
      outNodes.push({
        nodeType: 'function',
        name,
        qualifiedName: qn,
        filePath,
        parentQualifiedName: parentClassQualifiedName,
        isExported: false,
        startLine: range.startLoc.line,
        endLine: range.endLine,
        contentHash: sha256Lf(range.rawText),
        snippet: boundSnippet(range.rawText, maxSymbolSnippetChars),
      });
      index.nodeTypeByQualifiedName.set(qn, 'function');
      index.declarationToQualifiedName.set(member, qn);
      index.declarationToQualifiedName.set(init, qn);
      index.enclosingScopeToQualifiedName.set(init, qn);
    }
  }
}

/**
 * Extracts all graph nodes along with an internal `DeclarationNodeIndex` populated directly
 * from the allocated `qualifiedName` values during node emission (never reconstructed later).
 */
export function extractNodesWithIndex(options: ExtractNodesOptions): ExtractNodesWithIndexResult {
  const maxFileSnippetChars = options.maxFileSnippetChars ?? DEFAULT_MAX_FILE_SNIPPET_CHARS;
  const maxSymbolSnippetChars = options.maxSymbolSnippetChars ?? DEFAULT_MAX_SYMBOL_SNIPPET_CHARS;

  const registry = new QualifiedNameRegistry();
  const folderNodes = new Map<string, ExtractedNode>();
  const allNodes: ExtractedNode[] = [];
  const index: MutableDeclarationIndex = {
    declarationToQualifiedName: new Map<ts.Node, string>(),
    enclosingScopeToQualifiedName: new Map<ts.Node, string>(),
    classToConstructorQualifiedName: new Map<ts.Node, string>(),
    nodeTypeByQualifiedName: new Map<string, NodeType>(),
    signatureOnlyQualifiedNames: new Set<string>(),
    jsxEligibleSymbolQualifiedNames: new Set<string>(),
  };

  const ensureFolderChain = (relFilePath: string): string | null => {
    const dir = posixPath.dirname(relFilePath);
    if (dir === '.' || dir.length === 0) {
      return null;
    }

    const parts = dir.split('/');
    let parentQn: string | null = null;
    let currentDir = '';

    for (const part of parts) {
      currentDir = currentDir.length === 0 ? part : `${currentDir}/${part}`;
      const existing = folderNodes.get(currentDir);
      if (existing !== undefined) {
        parentQn = existing.qualifiedName;
        continue;
      }

      const folderQn = registry.allocate(buildFolderQualifiedName(currentDir));
      const folderNode: ExtractedNode = {
        nodeType: 'folder',
        name: part,
        qualifiedName: folderQn,
        filePath: currentDir,
        parentQualifiedName: parentQn,
        isExported: false,
        startLine: null,
        endLine: null,
        contentHash: null,
        snippet: null,
      };
      folderNodes.set(currentDir, folderNode);
      index.nodeTypeByQualifiedName.set(folderQn, 'folder');
      parentQn = folderQn;
    }

    return parentQn;
  };

  for (const entry of options.parsedFiles) {
    const filePath = entry.relativePath;
    const sf = entry.sourceFile.compilerNode;
    const lineIndex = new LineIndex(entry.sourceText);
    const parentFolderQn = ensureFolderChain(filePath);

    const fileQn = registry.allocate(buildFileQualifiedName(filePath));
    allNodes.push({
      nodeType: 'file',
      name: posixPath.basename(filePath),
      qualifiedName: fileQn,
      filePath,
      parentQualifiedName: parentFolderQn,
      isExported: false,
      startLine: 1,
      endLine: lineIndex.getTotalLines(),
      contentHash: sha256Lf(entry.sourceText),
      snippet: boundSnippet(entry.sourceText, maxFileSnippetChars),
    });
    index.nodeTypeByQualifiedName.set(fileQn, 'file');
    index.enclosingScopeToQualifiedName.set(sf, fileQn);

    const exportMeta = collectFileExportMetadata(sf);
    const reactHocContext = collectFileReactHocContext(entry.sourceFile, sf);

    // Pre-group top-level named FunctionDeclarations so overload signatures collapse cleanly
    const namedFnGroups = new Map<string, ts.FunctionDeclaration[]>();
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
        const list = namedFnGroups.get(stmt.name.text);
        if (list !== undefined) {
          list.push(stmt);
        } else {
          namedFnGroups.set(stmt.name.text, [stmt]);
        }
      }
    }
    const emittedFnGroups = new Set<string>();

    const emitInlineNode = (
      nodeType: NodeType,
      name: string,
      baseQn: string,
      astNode: ts.Node,
      isExported: boolean,
    ): string => {
      const range = getNodeRange(astNode, sf, lineIndex);
      const qn = registry.allocate(baseQn, range.startLoc);
      allNodes.push({
        nodeType,
        name,
        qualifiedName: qn,
        filePath,
        parentQualifiedName: fileQn,
        isExported,
        startLine: range.startLoc.line,
        endLine: range.endLine,
        contentHash: sha256Lf(range.rawText),
        snippet: boundSnippet(range.rawText, maxSymbolSnippetChars),
      });
      index.nodeTypeByQualifiedName.set(qn, nodeType);
      return qn;
    };

    for (const stmt of sf.statements) {
      // 1. Top-level FunctionDeclaration (named + anonymous default)
      if (ts.isFunctionDeclaration(stmt)) {
        if (stmt.name === undefined) {
          const isExported =
            hasModifier(stmt, ts.SyntaxKind.ExportKeyword) ||
            hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
          const qn = emitInlineNode(
            'function',
            'default',
            buildDefaultExportQualifiedName(filePath),
            stmt,
            isExported,
          );
          index.declarationToQualifiedName.set(stmt, qn);
          if (stmt.body === undefined) {
            index.signatureOnlyQualifiedNames.add(qn);
          } else {
            index.enclosingScopeToQualifiedName.set(stmt, qn);
          }
          continue;
        }

        const fnName = stmt.name.text;
        if (emittedFnGroups.has(fnName)) {
          continue;
        }
        emittedFnGroups.add(fnName);

        const group = namedFnGroups.get(fnName) ?? [stmt];
        const groupExported =
          exportMeta.locallyExportedNames.has(fnName) ||
          group.some((fn) => hasModifier(fn, ts.SyntaxKind.ExportKeyword));

        const impls = group.filter((fn) => fn.body !== undefined);
        const signatureOnly = impls.length === 0;
        const chosen = impls.length > 0 ? impls : group.slice(0, 1);
        const allocatedByFn = new Map<ts.FunctionDeclaration, string>();
        let primaryFnQn: string | undefined;

        for (const fn of chosen) {
          const qn = emitInlineNode(
            'function',
            fnName,
            buildFunctionQualifiedName(filePath, fnName),
            fn,
            groupExported,
          );
          primaryFnQn ??= qn;
          allocatedByFn.set(fn, qn);
          if (signatureOnly) {
            index.signatureOnlyQualifiedNames.add(qn);
          } else {
            index.enclosingScopeToQualifiedName.set(fn, qn);
          }
        }

        if (primaryFnQn !== undefined) {
          registerOverloadGroupDeclarations(group, allocatedByFn, primaryFnQn, index);
        }
        continue;
      }

      // 2. Top-level ClassDeclaration (named + anonymous default)
      if (ts.isClassDeclaration(stmt)) {
        const className = stmt.name?.text;
        const isExported =
          hasModifier(stmt, ts.SyntaxKind.ExportKeyword) ||
          (className !== undefined && exportMeta.locallyExportedNames.has(className));

        const baseQn =
          className !== undefined
            ? buildClassQualifiedName(filePath, className)
            : buildDefaultExportQualifiedName(filePath);
        const allocatedClassQn = emitInlineNode(
          'class',
          className ?? 'default',
          baseQn,
          stmt,
          isExported,
        );
        index.declarationToQualifiedName.set(stmt, allocatedClassQn);
        index.enclosingScopeToQualifiedName.set(stmt, allocatedClassQn);
        extractClassMembers(
          stmt,
          [],
          allocatedClassQn,
          filePath,
          sf,
          lineIndex,
          registry,
          maxSymbolSnippetChars,
          allNodes,
          index,
        );
        continue;
      }

      // 3. Top-level VariableStatement (arrow/fn exprs, class exprs, exported value symbols)
      if (ts.isVariableStatement(stmt)) {
        const stmtExported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) {
            continue;
          }
          const varName = decl.name.text;
          const isExported = stmtExported || exportMeta.locallyExportedNames.has(varName);
          const init =
            decl.initializer !== undefined ? unwrapExpression(decl.initializer) : undefined;

          if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            // Arrow/function expression -> emit ONLY a 'function' node (never duplicate 'symbol')
            const qn = emitInlineNode(
              'function',
              varName,
              buildFunctionQualifiedName(filePath, varName),
              decl,
              isExported,
            );
            index.declarationToQualifiedName.set(decl, qn);
            index.declarationToQualifiedName.set(init, qn);
            index.enclosingScopeToQualifiedName.set(init, qn);
            continue;
          }

          if (init !== undefined && ts.isClassExpression(init)) {
            const allocatedClassQn = emitInlineNode(
              'class',
              varName,
              buildClassQualifiedName(filePath, varName),
              decl,
              isExported,
            );
            index.declarationToQualifiedName.set(decl, allocatedClassQn);
            index.declarationToQualifiedName.set(init, allocatedClassQn);
            index.enclosingScopeToQualifiedName.set(init, allocatedClassQn);
            extractClassMembers(
              init,
              [decl],
              allocatedClassQn,
              filePath,
              sf,
              lineIndex,
              registry,
              maxSymbolSnippetChars,
              allNodes,
              index,
            );
            continue;
          }

          // Non-function top-level variable -> emit 'symbol' ONLY when exported
          if (isExported) {
            const qn = emitInlineNode(
              'symbol',
              varName,
              buildSymbolQualifiedName(filePath, varName),
              decl,
              true,
            );
            // Register in CALLS declaration index ONLY when statically recognizable as a JSX HOC wrapper
            if (init !== undefined && isRecognizableJsxHocExpression(init, reactHocContext)) {
              index.declarationToQualifiedName.set(decl, qn);
              index.jsxEligibleSymbolQualifiedNames.add(qn);
              index.enclosingScopeToQualifiedName.set(init, qn);
            }
          }
        }
        continue;
      }

      // 4. Exported interfaces, type aliases, and enums (emitted in nodes; erased/non-callable -> NOT in CALLS declaration index)
      if (
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt)
      ) {
        const name = stmt.name.text;
        const isExported =
          hasModifier(stmt, ts.SyntaxKind.ExportKeyword) ||
          exportMeta.locallyExportedNames.has(name);
        if (isExported) {
          emitInlineNode('symbol', name, buildSymbolQualifiedName(filePath, name), stmt, true);
        }
        continue;
      }

      // 5. ExportAssignment (`export default <expr>` or `export = <expr>`)
      if (ts.isExportAssignment(stmt)) {
        const rhs = unwrapExpression(stmt.expression);
        // If pointing to an already-declared top-level identifier, its node is already marked exported
        if (ts.isIdentifier(rhs) && exportMeta.declaredTopLevelNames.has(rhs.text)) {
          continue;
        }
        if (ts.isArrowFunction(rhs) || ts.isFunctionExpression(rhs)) {
          const qn = emitInlineNode(
            'function',
            'default',
            buildDefaultExportQualifiedName(filePath),
            stmt,
            true,
          );
          index.declarationToQualifiedName.set(stmt, qn);
          index.declarationToQualifiedName.set(rhs, qn);
          index.enclosingScopeToQualifiedName.set(rhs, qn);
        } else if (ts.isClassExpression(rhs)) {
          const allocatedClassQn = emitInlineNode(
            'class',
            'default',
            buildDefaultExportQualifiedName(filePath),
            stmt,
            true,
          );
          index.declarationToQualifiedName.set(stmt, allocatedClassQn);
          index.declarationToQualifiedName.set(rhs, allocatedClassQn);
          index.enclosingScopeToQualifiedName.set(rhs, allocatedClassQn);
          extractClassMembers(
            rhs,
            [stmt],
            allocatedClassQn,
            filePath,
            sf,
            lineIndex,
            registry,
            maxSymbolSnippetChars,
            allNodes,
            index,
          );
        } else {
          const qn = emitInlineNode(
            'symbol',
            'default',
            buildDefaultExportQualifiedName(filePath),
            stmt,
            true,
          );
          if (isRecognizableJsxHocExpression(rhs, reactHocContext)) {
            index.declarationToQualifiedName.set(stmt, qn);
            index.jsxEligibleSymbolQualifiedNames.add(qn);
            index.enclosingScopeToQualifiedName.set(rhs, qn);
          }
        }
        continue;
      }

      // 6. Static top-level CommonJS inline exports (`module.exports = ...` / `exports.foo = ...`)
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const assignExpr = stmt.expression;
        const { left, right } = assignExpr;
        const rhs = unwrapExpression(right);

        if (isModuleExportsExpr(left)) {
          if (ts.isIdentifier(rhs) && exportMeta.declaredTopLevelNames.has(rhs.text)) {
            continue;
          }
          if (ts.isArrowFunction(rhs) || ts.isFunctionExpression(rhs)) {
            const qn = emitInlineNode(
              'function',
              'default',
              buildDefaultExportQualifiedName(filePath),
              stmt,
              true,
            );
            index.declarationToQualifiedName.set(stmt, qn);
            index.declarationToQualifiedName.set(assignExpr, qn);
            index.declarationToQualifiedName.set(left, qn);
            index.declarationToQualifiedName.set(rhs, qn);
            index.enclosingScopeToQualifiedName.set(rhs, qn);
          } else if (ts.isClassExpression(rhs)) {
            const allocatedClassQn = emitInlineNode(
              'class',
              'default',
              buildDefaultExportQualifiedName(filePath),
              stmt,
              true,
            );
            index.declarationToQualifiedName.set(stmt, allocatedClassQn);
            index.declarationToQualifiedName.set(assignExpr, allocatedClassQn);
            index.declarationToQualifiedName.set(left, allocatedClassQn);
            index.declarationToQualifiedName.set(rhs, allocatedClassQn);
            index.enclosingScopeToQualifiedName.set(rhs, allocatedClassQn);
            extractClassMembers(
              rhs,
              [stmt, assignExpr, left],
              allocatedClassQn,
              filePath,
              sf,
              lineIndex,
              registry,
              maxSymbolSnippetChars,
              allNodes,
              index,
            );
          } else if (ts.isObjectLiteralExpression(rhs)) {
            for (const prop of rhs.properties) {
              if (ts.isMethodDeclaration(prop)) {
                const propName = getPropertyNameText(prop.name, sf);
                if (propName !== null) {
                  const qn = emitInlineNode(
                    'function',
                    propName,
                    buildFunctionQualifiedName(filePath, propName),
                    prop,
                    true,
                  );
                  index.declarationToQualifiedName.set(prop, qn);
                  if (prop.body === undefined) {
                    index.signatureOnlyQualifiedNames.add(qn);
                  } else {
                    index.enclosingScopeToQualifiedName.set(prop, qn);
                  }
                }
              } else if (ts.isPropertyAssignment(prop)) {
                const propName = getPropertyNameText(prop.name, sf);
                const propVal = unwrapExpression(prop.initializer);
                if (propName === null) {
                  continue;
                }
                if (
                  ts.isIdentifier(propVal) &&
                  exportMeta.declaredTopLevelNames.has(propVal.text)
                ) {
                  continue;
                }
                if (ts.isArrowFunction(propVal) || ts.isFunctionExpression(propVal)) {
                  const qn = emitInlineNode(
                    'function',
                    propName,
                    buildFunctionQualifiedName(filePath, propName),
                    prop,
                    true,
                  );
                  index.declarationToQualifiedName.set(prop, qn);
                  index.declarationToQualifiedName.set(propVal, qn);
                  index.enclosingScopeToQualifiedName.set(propVal, qn);
                } else if (ts.isClassExpression(propVal)) {
                  const classQn = emitInlineNode(
                    'class',
                    propName,
                    buildClassQualifiedName(filePath, propName),
                    prop,
                    true,
                  );
                  index.declarationToQualifiedName.set(prop, classQn);
                  index.declarationToQualifiedName.set(propVal, classQn);
                  index.enclosingScopeToQualifiedName.set(propVal, classQn);
                  extractClassMembers(
                    propVal,
                    [prop],
                    classQn,
                    filePath,
                    sf,
                    lineIndex,
                    registry,
                    maxSymbolSnippetChars,
                    allNodes,
                    index,
                  );
                } else {
                  const qn = emitInlineNode(
                    'symbol',
                    propName,
                    buildSymbolQualifiedName(filePath, propName),
                    prop,
                    true,
                  );
                  if (isRecognizableJsxHocExpression(propVal, reactHocContext)) {
                    index.declarationToQualifiedName.set(prop, qn);
                    index.jsxEligibleSymbolQualifiedNames.add(qn);
                    index.enclosingScopeToQualifiedName.set(propVal, qn);
                  }
                }
              }
            }
          } else {
            const qn = emitInlineNode(
              'symbol',
              'default',
              buildDefaultExportQualifiedName(filePath),
              stmt,
              true,
            );
            if (isRecognizableJsxHocExpression(rhs, reactHocContext)) {
              index.declarationToQualifiedName.set(stmt, qn);
              index.declarationToQualifiedName.set(assignExpr, qn);
              index.declarationToQualifiedName.set(left, qn);
              index.jsxEligibleSymbolQualifiedNames.add(qn);
              index.enclosingScopeToQualifiedName.set(rhs, qn);
            }
          }
          continue;
        }

        const cjsExportName = getCjsNamedExport(left);
        if (cjsExportName !== null) {
          if (ts.isIdentifier(rhs) && exportMeta.declaredTopLevelNames.has(rhs.text)) {
            continue;
          }
          if (ts.isArrowFunction(rhs) || ts.isFunctionExpression(rhs)) {
            const qn = emitInlineNode(
              'function',
              cjsExportName,
              buildFunctionQualifiedName(filePath, cjsExportName),
              stmt,
              true,
            );
            index.declarationToQualifiedName.set(stmt, qn);
            index.declarationToQualifiedName.set(assignExpr, qn);
            index.declarationToQualifiedName.set(left, qn);
            index.declarationToQualifiedName.set(rhs, qn);
            index.enclosingScopeToQualifiedName.set(rhs, qn);
          } else if (ts.isClassExpression(rhs)) {
            const classQn = emitInlineNode(
              'class',
              cjsExportName,
              buildClassQualifiedName(filePath, cjsExportName),
              stmt,
              true,
            );
            index.declarationToQualifiedName.set(stmt, classQn);
            index.declarationToQualifiedName.set(assignExpr, classQn);
            index.declarationToQualifiedName.set(left, classQn);
            index.declarationToQualifiedName.set(rhs, classQn);
            index.enclosingScopeToQualifiedName.set(rhs, classQn);
            extractClassMembers(
              rhs,
              [stmt, assignExpr, left],
              classQn,
              filePath,
              sf,
              lineIndex,
              registry,
              maxSymbolSnippetChars,
              allNodes,
              index,
            );
          } else {
            const qn = emitInlineNode(
              'symbol',
              cjsExportName,
              buildSymbolQualifiedName(filePath, cjsExportName),
              stmt,
              true,
            );
            if (isRecognizableJsxHocExpression(rhs, reactHocContext)) {
              index.declarationToQualifiedName.set(stmt, qn);
              index.declarationToQualifiedName.set(assignExpr, qn);
              index.declarationToQualifiedName.set(left, qn);
              index.jsxEligibleSymbolQualifiedNames.add(qn);
              index.enclosingScopeToQualifiedName.set(rhs, qn);
            }
          }
        }
      }
    }
  }

  const sortedFolders = [...folderNodes.values()].sort((a, b) =>
    compareCodePoint(a.qualifiedName, b.qualifiedName),
  );
  const sortedFileAndChildNodes = [...allNodes].sort((a, b) =>
    compareCodePoint(a.qualifiedName, b.qualifiedName),
  );

  return {
    nodes: [...sortedFolders, ...sortedFileAndChildNodes],
    declarationIndex: index,
  };
}

export function extractNodesFromFiles(options: ExtractNodesOptions): readonly ExtractedNode[] {
  return extractNodesWithIndex(options).nodes;
}
