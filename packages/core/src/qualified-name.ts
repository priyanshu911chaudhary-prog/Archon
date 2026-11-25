import { normalizePosixPath } from '@archon/shared';

export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

/**
 * Injective percent-escaping for delimiter characters (`%`, `:`, `@`, `#`) so arbitrary
 * characters in file paths or quoted member names can never spoof `::`, `@L...:C...`, or `#n`.
 * Standard POSIX paths and JS identifiers contain none of these characters and remain human-readable.
 */
export function escapeQualifiedSegment(segment: string): string {
  return segment
    .replace(/%/g, '%25')
    .replace(/:/g, '%3A')
    .replace(/@/g, '%40')
    .replace(/#/g, '%23');
}

function normalizedEscapedPath(posixPath: string): string {
  const normalized = normalizePosixPath(posixPath).replace(/\/+$/, '');
  return escapeQualifiedSegment(normalized);
}

export function buildFolderQualifiedName(posixDirPath: string): string {
  return `folder:${normalizedEscapedPath(posixDirPath)}`;
}

export function buildFileQualifiedName(posixFilePath: string): string {
  return `file:${normalizedEscapedPath(posixFilePath)}`;
}

export function buildFunctionQualifiedName(posixFilePath: string, functionName: string): string {
  return `${normalizedEscapedPath(posixFilePath)}::fn:${escapeQualifiedSegment(functionName)}`;
}

export function buildClassQualifiedName(posixFilePath: string, className: string): string {
  return `${normalizedEscapedPath(posixFilePath)}::class:${escapeQualifiedSegment(className)}`;
}

export function buildSymbolQualifiedName(posixFilePath: string, symbolName: string): string {
  return `${normalizedEscapedPath(posixFilePath)}::sym:${escapeQualifiedSegment(symbolName)}`;
}

export function buildDefaultExportQualifiedName(posixFilePath: string): string {
  return `${normalizedEscapedPath(posixFilePath)}::default`;
}

export function buildConstructorQualifiedName(parentClassQualifiedName: string): string {
  return `${parentClassQualifiedName}::ctor`;
}

export function buildMethodQualifiedName(
  parentClassQualifiedName: string,
  methodName: string,
  isStatic: boolean,
): string {
  const kind = isStatic ? 'static' : 'method';
  return `${parentClassQualifiedName}::${kind}:${escapeQualifiedSegment(methodName)}`;
}

export function buildAccessorQualifiedName(
  parentClassQualifiedName: string,
  accessorName: string,
  accessorKind: 'get' | 'set',
  isStatic: boolean,
): string {
  const prefix = isStatic ? `static:${accessorKind}` : accessorKind;
  return `${parentClassQualifiedName}::${prefix}:${escapeQualifiedSegment(accessorName)}`;
}

/**
 * Deterministic allocator guaranteeing unique qualified names across a repository.
 * - First claim on `baseName` receives `baseName`.
 * - Subsequent collisions receive `${baseName}@L${line}:C${column}`.
 * - Identical line+column collisions fall back deterministically to `#2`, `#3`, ...
 */
export class QualifiedNameRegistry {
  private readonly allocated = new Set<string>();

  allocate(baseName: string, location?: SourceLocation): string {
    if (!this.allocated.has(baseName)) {
      this.allocated.add(baseName);
      return baseName;
    }

    const withLocation =
      location !== undefined ? `${baseName}@L${location.line}:C${location.column}` : baseName;

    if (!this.allocated.has(withLocation)) {
      this.allocated.add(withLocation);
      return withLocation;
    }

    let ordinal = 2;
    while (this.allocated.has(`${withLocation}#${ordinal}`)) {
      ordinal += 1;
    }

    const disambiguated = `${withLocation}#${ordinal}`;
    this.allocated.add(disambiguated);
    return disambiguated;
  }

  has(qualifiedName: string): boolean {
    return this.allocated.has(qualifiedName);
  }
}
