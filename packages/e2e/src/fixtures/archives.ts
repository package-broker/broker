import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export interface ArchiveEntry {
  name: string;
  body: Buffer;
  link?: string;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const ordered = (entries: readonly ArchiveEntry[]) =>
  [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export function zip(entries: readonly ArchiveEntry[], compress = false): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of ordered(entries)) {
    const name = Buffer.from(entry.name);
    const body = compress ? deflateRawSync(entry.body, { level: 9 }) : entry.body;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt16LE(0x21, 12); // DOS date: 1980-01-01; time is midnight.
    local.writeUInt32LE(crc32(entry.body), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    locals.push(local, name, body);
    offset += local.length + name.length + body.length;
  }
  const index = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, index, end]);
}

export function tarGzip(entries: readonly ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of ordered(entries)) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    const octal = (value: number, at: number, width: number) =>
      header.write(value.toString(8).padStart(width - 1, '0') + '\0', at, width, 'ascii');
    octal(entry.link ? 0o777 : 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(entry.link ? 0 : entry.body.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write(entry.link ? '2' : '0', 156);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header);
    if (!entry.link) chunks.push(entry.body, Buffer.alloc((512 - (entry.body.length % 512)) % 512));
  }
  const compressed = gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { level: 9 });
  compressed.fill(0, 4, 8);
  compressed[9] = 3;
  return compressed;
}
