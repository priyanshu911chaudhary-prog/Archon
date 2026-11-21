import { gzipSync } from 'node:zlib';

const TAR_BLOCK_SIZE = 512;

export type UstarTypeFlag = '0' | '1' | '2' | '3' | '4' | '5' | '6';

export interface UstarFixtureEntry {
  readonly path: string;
  readonly typeFlag?: UstarTypeFlag;
  readonly content?: string | Buffer;
  readonly linkName?: string;
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const digits = value.toString(8).padStart(length - 1, '0');
  buffer.write(`${digits}\0`, offset, length, 'ascii');
}

function buildHeaderBlock(entry: UstarFixtureEntry, contentByteLength: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  const typeFlag: UstarTypeFlag = entry.typeFlag ?? '0';

  if (Buffer.byteLength(entry.path, 'utf8') > 100) {
    throw new Error(`Test fixture path exceeds 100-byte ustar name field: ${entry.path}`);
  }

  // Name (0..99)
  header.write(entry.path, 0, 100, 'utf8');
  // Mode (100..107)
  writeOctal(header, 100, 8, typeFlag === '5' ? 0o755 : 0o644);
  // UID (108..115) & GID (116..123)
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  // Size (124..135)
  writeOctal(header, 124, 12, typeFlag === '0' ? contentByteLength : 0);
  // Mtime (136..147)
  writeOctal(header, 136, 12, 1_700_000_000);
  // Checksum placeholder: 8 ASCII spaces (148..155)
  header.fill(0x20, 148, 156);
  // Type flag (156)
  header.write(typeFlag, 156, 1, 'ascii');
  // Linkname (157..256)
  if (entry.linkName) {
    header.write(entry.linkName, 157, 100, 'utf8');
  }
  // USTAR magic (257..262) and version (263..264)
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');

  // Compute unsigned byte checksum across all 512 header bytes
  let checksum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
    checksum += header[i] ?? 0;
  }
  const checksumStr = `${checksum.toString(8).padStart(6, '0')}\0 `;
  header.write(checksumStr, 148, 8, 'ascii');

  return header;
}

/**
 * Builds an uncompressed POSIX ustar archive buffer in memory.
 * Deliberately does NOT sanitize paths or types so security tests can craft malicious entries
 * (zip-slip `..`, backslashes, symlinks, hardlinks, devices, Windows-reserved names).
 */
export function buildUstarBuffer(entries: readonly UstarFixtureEntry[]): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    const typeFlag: UstarTypeFlag = entry.typeFlag ?? '0';
    const contentBuf =
      typeFlag === '0'
        ? Buffer.isBuffer(entry.content)
          ? entry.content
          : Buffer.from(entry.content ?? '', 'utf8')
        : Buffer.alloc(0);

    chunks.push(buildHeaderBlock(entry, contentBuf.length));

    if (contentBuf.length > 0) {
      chunks.push(contentBuf);
      const remainder = contentBuf.length % TAR_BLOCK_SIZE;
      if (remainder !== 0) {
        chunks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder, 0));
      }
    }
  }

  // Two zeroed 512-byte EOF trailer blocks
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2, 0));
  return Buffer.concat(chunks);
}

/**
 * Builds a gzipped POSIX ustar archive buffer in memory.
 */
export function buildGzippedUstar(entries: readonly UstarFixtureEntry[]): Buffer {
  return gzipSync(buildUstarBuffer(entries));
}
