import { createHash } from 'node:crypto';
import { posix as posixPath } from 'node:path';
import { ts } from 'ts-morph';
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
  parentClassQualifiedName: string,
  filePath: string,
  sf: ts.SourceFile,
  lineIndex: LineIndex,
  registry: QualifiedNameRegistry,
  maxSymbolSnippetChars: number,
  outNodes: ExtractedNode[],
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
    const chosen = impls.length > 0 ? impls : constructors.slice(0, 1);
    for (const ctor of chosen) {
      const range = getNodeRange(ctor, sf, lineIndex);
      const qn = registry.allocate(
        buildConstructorQualifiedName(parentClassQualifiedName),
        range.startLoc,
      );
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
    const chosen = impls.length > 0 ? impls : group.slice(0, 1);
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
    }
  }
}

export function extractNodesFromFiles(options: ExtractNodesOptions): readonly ExtractedNode[] {
  const maxFileSnippetChars = options.maxFileSnippetChars ?? DEFAULT_MAX_FILE_SNIPPET_CHARS;
  const maxSymbolSnippetChars = options.maxSymbolSnippetChars ?? DEFAULT_MAX_SYMBOL_SNIPPET_CHARS;

  const registry = new QualifiedNameRegistry();
  const folderNodes = new Map<string, ExtractedNode>();
  const allNodes: ExtractedNode[] = [];

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

    const exportMeta = collectFileExportMetadata(sf);

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
      return qn;
    };

    for (const stmt of sf.statements) {
      // 1. Top-level FunctionDeclaration (named + anonymous default)
      if (ts.isFunctionDeclaration(stmt)) {
        if (stmt.name === undefined) {
          const isExported =
            hasModifier(stmt, ts.SyntaxKind.ExportKeyword) ||
            hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
          emitInlineNode(
            'function',
            'default',
            buildDefaultExportQualifiedName(filePath),
            stmt,
            isExported,
          );
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
        const chosen = impls.length > 0 ? impls : group.slice(0, 1);

        for (const fn of chosen) {
          emitInlineNode(
            'function',
            fnName,
            buildFunctionQualifiedName(filePath, fnName),
            fn,
            groupExported,
          );
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
        extractClassMembers(
          stmt,
          allocatedClassQn,
          filePath,
          sf,
          lineIndex,
          registry,
          maxSymbolSnippetChars,
          allNodes,
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
            emitInlineNode(
              'function',
              varName,
              buildFunctionQualifiedName(filePath, varName),
              decl,
              isExported,
            );
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
            extractClassMembers(
              init,
              allocatedClassQn,
              filePath,
              sf,
              lineIndex,
              registry,
              maxSymbolSnippetChars,
              allNodes,
            );
            continue;
          }

          // Non-function top-level variable -> emit 'symbol' ONLY when exported
          if (isExported) {
            emitInlineNode(
              'symbol',
              varName,
              buildSymbolQualifiedName(filePath, varName),
              decl,
              true,
            );
          }
        }
        continue;
      }

      // 4. Exported interfaces, type aliases, and enums
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
          emitInlineNode(
            'function',
            'default',
            buildDefaultExportQualifiedName(filePath),
            stmt,
            true,
          );
        } else if (ts.isClassExpression(rhs)) {
          const allocatedClassQn = emitInlineNode(
            'class',
            'default',
            buildDefaultExportQualifiedName(filePath),
            stmt,
            true,
          );
          extractClassMembers(
            rhs,
            allocatedClassQn,
            filePath,
            sf,
            lineIndex,
            registry,
            maxSymbolSnippetChars,
            allNodes,
          );
        } else {
          emitInlineNode(
            'symbol',
            'default',
            buildDefaultExportQualifiedName(filePath),
            stmt,
            true,
          );
        }
        continue;
      }

      // 6. Static top-level CommonJS inline exports (`module.exports = ...` / `exports.foo = ...`)
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const { left, right } = stmt.expression;
        const rhs = unwrapExpression(right);

        if (isModuleExportsExpr(left)) {
          if (ts.isIdentifier(rhs) && exportMeta.declaredTopLevelNames.has(rhs.text)) {
            continue;
          }
          if (ts.isArrowFunction(rhs) || ts.isFunctionExpression(rhs)) {
            emitInlineNode(
              'function',
              'default',
              buildDefaultExportQualifiedName(filePath),
              stmt,
              true,
            );
          } else if (ts.isClassExpression(rhs)) {
            const allocatedClassQn = emitInlineNode(
              'class',
              'default',
              buildDefaultExportQualifiedName(filePath),
              stmt,
              true,
            );
            extractClassMembers(
              rhs,
              allocatedClassQn,
              filePath,
              sf,
              lineIndex,
              registry,
              maxSymbolSnippetChars,
              allNodes,
            );
          } else if (ts.isObjectLiteralExpression(rhs)) {
            for (const prop of rhs.properties) {
              if (ts.isMethodDeclaration(prop)) {
                const propName = getPropertyNameText(prop.name, sf);
                if (propName !== null) {
                  emitInlineNode(
                    'function',
                    propName,
                    buildFunctionQualifiedName(filePath, propName),
                    prop,
                    true,
                  );
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
                  emitInlineNode(
                    'function',
                    propName,
                    buildFunctionQualifiedName(filePath, propName),
                    prop,
                    true,
                  );
                } else if (ts.isClassExpression(propVal)) {
                  const classQn = emitInlineNode(
                    'class',
                    propName,
                    buildClassQualifiedName(filePath, propName),
                    prop,
                    true,
                  );
                  extractClassMembers(
                    propVal,
                    classQn,
                    filePath,
                    sf,
                    lineIndex,
                    registry,
                    maxSymbolSnippetChars,
                    allNodes,
                  );
                } else {
                  emitInlineNode(
                    'symbol',
                    propName,
                    buildSymbolQualifiedName(filePath, propName),
                    prop,
                    true,
                  );
                }
              }
            }
          } else {
            emitInlineNode(
              'symbol',
              'default',
              buildDefaultExportQualifiedName(filePath),
              stmt,
              true,
            );
          }
          continue;
        }

        const cjsExportName = getCjsNamedExport(left);
        if (cjsExportName !== null) {
          if (ts.isIdentifier(rhs) && exportMeta.declaredTopLevelNames.has(rhs.text)) {
            continue;
          }
          if (ts.isArrowFunction(rhs) || ts.isFunctionExpression(rhs)) {
            emitInlineNode(
              'function',
              cjsExportName,
              buildFunctionQualifiedName(filePath, cjsExportName),
              stmt,
              true,
            );
          } else if (ts.isClassExpression(rhs)) {
            const classQn = emitInlineNode(
              'class',
              cjsExportName,
              buildClassQualifiedName(filePath, cjsExportName),
              stmt,
              true,
            );
            extractClassMembers(
              rhs,
              classQn,
              filePath,
              sf,
              lineIndex,
              registry,
              maxSymbolSnippetChars,
              allNodes,
            );
          } else {
            emitInlineNode(
              'symbol',
              cjsExportName,
              buildSymbolQualifiedName(filePath, cjsExportName),
              stmt,
              true,
            );
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

  return [...sortedFolders, ...sortedFileAndChildNodes];
}
