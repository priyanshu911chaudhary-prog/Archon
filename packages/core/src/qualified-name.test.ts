import { describe, expect, it } from 'vitest';
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
  escapeQualifiedSegment,
} from './qualified-name.js';

describe('qualified-name builders and registry', () => {
  it('builds readable, Windows-to-POSIX normalized qualified names for all node kinds', () => {
    expect(buildFolderQualifiedName('src\\lib\\')).toBe('folder:src/lib');
    expect(buildFileQualifiedName('src\\lib\\billing.ts')).toBe('file:src/lib/billing.ts');
    expect(buildFunctionQualifiedName('src/lib/billing.ts', 'calculateBilling')).toBe(
      'src/lib/billing.ts::fn:calculateBilling',
    );
    const classQn = buildClassQualifiedName('src/auth/service.ts', 'AuthService');
    expect(classQn).toBe('src/auth/service.ts::class:AuthService');
    expect(buildConstructorQualifiedName(classQn)).toBe(
      'src/auth/service.ts::class:AuthService::ctor',
    );
    expect(buildMethodQualifiedName(classQn, 'verify', false)).toBe(
      'src/auth/service.ts::class:AuthService::method:verify',
    );
    expect(buildMethodQualifiedName(classQn, 'fromEnv', true)).toBe(
      'src/auth/service.ts::class:AuthService::static:fromEnv',
    );
    expect(buildAccessorQualifiedName(classQn, 'token', 'get', false)).toBe(
      'src/auth/service.ts::class:AuthService::get:token',
    );
    expect(buildAccessorQualifiedName(classQn, 'token', 'set', false)).toBe(
      'src/auth/service.ts::class:AuthService::set:token',
    );
    expect(buildAccessorQualifiedName(classQn, 'token', 'get', true)).toBe(
      'src/auth/service.ts::class:AuthService::static:get:token',
    );
    expect(buildAccessorQualifiedName(classQn, 'token', 'set', true)).toBe(
      'src/auth/service.ts::class:AuthService::static:set:token',
    );
    expect(buildSymbolQualifiedName('src/config.ts', 'LIMITS')).toBe('src/config.ts::sym:LIMITS');
    expect(buildDefaultExportQualifiedName('src/page.tsx')).toBe('src/page.tsx::default');
  });

  it('prevents delimiter injection collisions from ::, @, #, and % in paths or member names', () => {
    const fileWithDelims = buildFileQualifiedName('src/a::fn:b.ts');
    const fnInNormalFile = buildFunctionQualifiedName('src/a.ts', 'b');
    expect(fileWithDelims).not.toBe(fnInNormalFile);
    expect(fileWithDelims).toBe('file:src/a%3A%3Afn%3Ab.ts');

    const classQn = buildClassQualifiedName('src/a.ts', 'Svc');
    const methodWithAt = buildMethodQualifiedName(classQn, 'run@L1:C1', false);
    const methodWithHash = buildMethodQualifiedName(classQn, 'run#2', false);
    const methodWithPercent = buildMethodQualifiedName(classQn, 'run%3A', false);
    const methodWithColon = buildMethodQualifiedName(classQn, 'run:', false);

    expect(new Set([methodWithAt, methodWithHash, methodWithPercent, methodWithColon]).size).toBe(
      4,
    );
    expect(escapeQualifiedSegment('a%3Ab')).toBe('a%253Ab');
    expect(escapeQualifiedSegment('a:b')).toBe('a%3Ab');
  });

  it('disambiguates same-line collisions via line:col and identical-location collisions via ordinal', () => {
    const registry = new QualifiedNameRegistry();
    const base = buildFunctionQualifiedName('src/a.ts', 'dup');

    const first = registry.allocate(base, { line: 5, column: 1 });
    const sameLineSecond = registry.allocate(base, { line: 5, column: 26 });
    const identicalLocThird = registry.allocate(base, { line: 5, column: 26 });
    const identicalLocFourth = registry.allocate(base, { line: 5, column: 26 });

    expect(first).toBe('src/a.ts::fn:dup');
    expect(sameLineSecond).toBe('src/a.ts::fn:dup@L5:C26');
    expect(identicalLocThird).toBe('src/a.ts::fn:dup@L5:C26#2');
    expect(identicalLocFourth).toBe('src/a.ts::fn:dup@L5:C26#3');
    expect(new Set([first, sameLineSecond, identicalLocThird, identicalLocFourth]).size).toBe(4);
  });
});
