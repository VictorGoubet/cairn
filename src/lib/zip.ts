/**
 * A minimal zip writer, because a browser only lets one download through at a time.
 *
 * Handing over several files means handing over one archive. Entries are stored, not deflated: a
 * gpx compresses well, but pulling in a compressor to save a few hundred kilobytes on a file that
 * is opened once is not worth the dependency, and every unzip reads stored entries.
 *
 * The format is the original PKZIP one: for each file a local header then its bytes, then a
 * central directory repeating the headers, then the end-of-directory record pointing at it.
 * Timestamps are fixed at the epoch the format starts from, so the same input gives the same
 * archive byte for byte.
 */

/** 1980-01-01 00:00, the earliest date the dos fields can hold */
const DOS_DATE = 0x0021;
const DOS_TIME = 0;

export interface ZipEntry {
  name: string;
  text: string;
}

/**
 * Packs text files into a zip archive.
 *
 * Args:
 *   entries: file names and contents; a name may contain forward slashes to nest.
 */
export function zipFiles(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let directorySize = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body = encoder.encode(entry.text);
    const crc = crc32(body);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // utf-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, body.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);

    const entryHeader = new DataView(new ArrayBuffer(46));
    entryHeader.setUint32(0, 0x02014b50, true);
    entryHeader.setUint16(4, 20, true); // version made by
    entryHeader.setUint16(6, 20, true);
    entryHeader.setUint16(8, 0x0800, true);
    entryHeader.setUint16(10, 0, true);
    entryHeader.setUint16(12, DOS_TIME, true);
    entryHeader.setUint16(14, DOS_DATE, true);
    entryHeader.setUint32(16, crc, true);
    entryHeader.setUint32(20, body.length, true);
    entryHeader.setUint32(24, body.length, true);
    entryHeader.setUint16(28, name.length, true);
    entryHeader.setUint32(42, offset, true);
    central.push(new Uint8Array(entryHeader.buffer), name);
    directorySize += 46 + name.length;

    offset += 30 + name.length + body.length;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/** a file name that survives every filesystem, and cannot climb out of the archive */
export function safeFileName(name: string): string {
  return (
    name
      .replace(/[/\\?%*:|"<>]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'file'
  );
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
