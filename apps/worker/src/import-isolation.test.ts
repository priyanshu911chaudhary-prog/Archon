import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const API_DIST_INDEX = path.join(REPO_ROOT, 'apps', 'api', 'dist', 'index.js');
const WORKER_DIST_INDEX = path.join(REPO_ROOT, 'apps', 'worker', 'dist', 'index.js');
const CORE_DIST_INDEX = path.join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');
const PARSER_RUNNER_DIST = path.join(REPO_ROOT, 'apps', 'worker', 'dist', 'parser-runner.js');

const PARSER_INTEGRATION_DIST = path.join(
  REPO_ROOT,
  'apps',
  'worker',
  'dist',
  'parser-integration.js',
);

const LIFECYCLE_DIST = path.join(REPO_ROOT, 'apps', 'worker', 'dist', 'lifecycle.js');
const WORKER_RUNTIME_DIST = path.join(REPO_ROOT, 'apps', 'worker', 'dist', 'worker.js');
const API_SERVER_DIST = path.join(REPO_ROOT, 'apps', 'api', 'dist', 'server.js');

interface ProbeOutput {
  readonly loadedUrls: readonly string[];
  readonly resolvedSpecifiers: readonly string[];
  readonly exportedKeys: readonly string[];
  readonly serviceInfoValues: readonly string[];
  readonly coreEngineId: string | null;
}

function runFreshImportProbe(entryFilePath: string): ProbeOutput {
  if (!existsSync(entryFilePath)) {
    throw new Error(
      `Missing compiled entrypoint "${entryFilePath}". Run "npm run build" before running import-isolation tests.`,
    );
  }

  const probeScript = [
    "import { registerHooks } from 'node:module';",
    'const loadedUrls = new Set();',
    'const resolvedSpecifiers = new Set();',
    'registerHooks({',
    '  resolve(specifier, context, nextResolve) {',
    '    resolvedSpecifiers.add(specifier);',
    '    const res = nextResolve(specifier, context);',
    '    if (res && typeof res.url === "string") loadedUrls.add(res.url);',
    '    return res;',
    '  },',
    '  load(url, context, nextLoad) {',
    '    loadedUrls.add(url);',
    '    return nextLoad(url, context);',
    '  },',
    '});',
    'const mod = await import(process.argv[1]);',
    'const serviceInfo = mod.API_SERVICE_INFO ?? mod.WORKER_SERVICE_INFO ?? null;',
    'const serviceInfoValues = serviceInfo && typeof serviceInfo === "object"',
    '  ? Object.values(serviceInfo).filter((v) => typeof v === "string")',
    '  : [];',
    'const coreEngineId = typeof mod.CORE_ENGINE_ID === "string" ? mod.CORE_ENGINE_ID : null;',
    'process.stdout.write(JSON.stringify({',
    '  loadedUrls: [...loadedUrls],',
    '  resolvedSpecifiers: [...resolvedSpecifiers],',
    '  exportedKeys: Object.keys(mod),',
    '  serviceInfoValues,',
    '  coreEngineId,',
    '}));',
  ].join('\n');

  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', probeScript, pathToFileURL(entryFilePath).href],
    {
      cwd: REPO_ROOT,
      env: {
        NODE_ENV: 'test',
        ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
        ...(process.env.Path !== undefined ? { Path: process.env.Path } : {}),
        ...(process.env.SYSTEMROOT !== undefined ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...(process.env.SystemRoot !== undefined ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );

  return JSON.parse(stdout) as ProbeOutput;
}

function matchesHeavyCompilerRuntime(
  urls: readonly string[],
  specifiers: readonly string[],
): boolean {
  const combined = [...urls, ...specifiers].map((s) => s.toLowerCase());
  return combined.some(
    (entry) =>
      entry.includes('/packages/core/dist/') ||
      entry.includes('@archon/core') ||
      entry.includes('ts-morph') ||
      entry.includes('/typescript/lib/typescript'),
  );
}

describe('compiled entrypoint import isolation (Batch 4.3B.1)', () => {
  it('imports compiled API and Worker entrypoints with preserved service info without loading @archon/core, ts-morph, or bundled TypeScript', () => {
    const apiProbe = runFreshImportProbe(API_DIST_INDEX);
    expect(apiProbe.exportedKeys).toContain('API_SERVICE_INFO');
    expect(apiProbe.serviceInfoValues).toContain('archon-core');
    expect(
      matchesHeavyCompilerRuntime(apiProbe.loadedUrls, apiProbe.resolvedSpecifiers),
      `API entrypoint unexpectedly loaded heavy compiler runtime: ${JSON.stringify(apiProbe.loadedUrls)}`,
    ).toBe(false);

    const workerProbe = runFreshImportProbe(WORKER_DIST_INDEX);
    expect(workerProbe.exportedKeys).toContain('WORKER_SERVICE_INFO');
    expect(workerProbe.serviceInfoValues).toContain('archon-core');
    expect(
      matchesHeavyCompilerRuntime(workerProbe.loadedUrls, workerProbe.resolvedSpecifiers),
      `Worker entrypoint unexpectedly loaded heavy compiler runtime: ${JSON.stringify(workerProbe.loadedUrls)}`,
    ).toBe(false);
  }, 30_000);

  it('positive control: detects heavy compiler runtime loading when importing compiled @archon/core', () => {
    const coreProbe = runFreshImportProbe(CORE_DIST_INDEX);
    expect(coreProbe.coreEngineId).toBe('archon-core');
    expect(matchesHeavyCompilerRuntime(coreProbe.loadedUrls, coreProbe.resolvedSpecifiers)).toBe(
      true,
    );
    expect(coreProbe.loadedUrls.some((url) => url.toLowerCase().includes('ts-morph'))).toBe(true);
  });
  it('imports compiled parser-runner directly without loading @archon/core, parser-child, ts-morph, or bundled TypeScript', () => {
    const runnerProbe = runFreshImportProbe(PARSER_RUNNER_DIST);
    expect(runnerProbe.exportedKeys).toContain('createParserRunner');
    expect(runnerProbe.exportedKeys).toContain('ParserRunnerError');
    expect(
      matchesHeavyCompilerRuntime(runnerProbe.loadedUrls, runnerProbe.resolvedSpecifiers),
      `parser-runner unexpectedly loaded heavy compiler runtime: ${JSON.stringify(runnerProbe.loadedUrls)}`,
    ).toBe(false);
    expect(
      runnerProbe.loadedUrls.some((url) => url.toLowerCase().includes('parser-child')),
      `parser-runner must not import parser-child at runtime: ${JSON.stringify(runnerProbe.loadedUrls)}`,
    ).toBe(false);
  }, 15_000);

  it('imports compiled parser-integration directly without loading @archon/core, parser-child, ts-morph, or bundled TypeScript', () => {
    const integrationProbe = runFreshImportProbe(PARSER_INTEGRATION_DIST);
    expect(integrationProbe.exportedKeys).toContain('createProductionParserAdapter');
    expect(integrationProbe.exportedKeys).toContain('classifyParserRunnerError');
    expect(integrationProbe.exportedKeys).toContain('preflightProductionParserEntrypoint');
    expect(
      matchesHeavyCompilerRuntime(integrationProbe.loadedUrls, integrationProbe.resolvedSpecifiers),
      `parser-integration unexpectedly loaded heavy compiler runtime: ${JSON.stringify(integrationProbe.loadedUrls)}`,
    ).toBe(false);
    expect(
      integrationProbe.loadedUrls.some((url) => url.toLowerCase().includes('parser-child')),
      `parser-integration must not import parser-child at runtime: ${JSON.stringify(integrationProbe.loadedUrls)}`,
    ).toBe(false);
  }, 15_000);
  it('imports compiled lifecycle, standalone worker, and API server modules without starting services or loading @archon/core, parser-child, ts-morph, or bundled TypeScript', () => {
    for (const targetPath of [LIFECYCLE_DIST, WORKER_RUNTIME_DIST, API_SERVER_DIST]) {
      const probe = runFreshImportProbe(targetPath);
      expect(
        matchesHeavyCompilerRuntime(probe.loadedUrls, probe.resolvedSpecifiers),
        `${targetPath} unexpectedly loaded heavy compiler runtime: ${JSON.stringify(probe.loadedUrls)}`,
      ).toBe(false);
      expect(
        probe.loadedUrls.some((url) => url.toLowerCase().includes('parser-child')),
        `${targetPath} must not import parser-child at runtime: ${JSON.stringify(probe.loadedUrls)}`,
      ).toBe(false);
    }
  }, 20_000);
});
