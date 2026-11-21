import { Parser, type ReadEntry } from 'tar';
import { describe, expect, it } from 'vitest';
import { buildGzippedUstar, buildUstarBuffer } from './tar-test-utils.js';

function parseWithRealTarParser(
  archive: Buffer,
  gzip: boolean,
): Promise<{ path: string; type: string; content: string; linkpath?: string }[]> {
  return new Promise((resolve, reject) => {
    const results: { path: string; type: string; content: string; linkpath?: string }[] = [];
    const parser = new Parser({
      strict: true,
      noResume: true,
      gzip,
      onReadEntry: (entry: ReadEntry) => {
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        entry.on('end', () => {
          results.push({
            path: entry.path,
            type: entry.type,
            content: Buffer.concat(chunks).toString('utf8'),
            linkpath: entry.linkpath,
          });
        });
        entry.resume();
      },
    });

    parser.once('error', reject);
    parser.once('end', () => {
      resolve(results);
    });
    parser.end(archive);
  });
}

describe('tar-test-utils ustar builder sanity check', () => {
  it('produces valid ustar and gzipped ustar archives readable by real tar Parser', async () => {
    const entries = [
      { path: 'repo-sha/', typeFlag: '5' as const },
      { path: 'repo-sha/src/index.ts', content: 'export const x = 42;\n' },
      { path: 'repo-sha/link.ts', typeFlag: '2' as const, linkName: 'src/index.ts' },
    ];

    const plainParsed = await parseWithRealTarParser(buildUstarBuffer(entries), false);
    expect(plainParsed).toEqual([
      { path: 'repo-sha/', type: 'Directory', content: '', linkpath: undefined },
      {
        path: 'repo-sha/src/index.ts',
        type: 'File',
        content: 'export const x = 42;\n',
        linkpath: undefined,
      },
      {
        path: 'repo-sha/link.ts',
        type: 'SymbolicLink',
        content: '',
        linkpath: 'src/index.ts',
      },
    ]);

    const gzipParsed = await parseWithRealTarParser(buildGzippedUstar(entries), true);
    expect(gzipParsed).toHaveLength(3);
    expect(gzipParsed[1]?.content).toBe('export const x = 42;\n');
  });
});
