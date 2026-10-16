import { parseSha256, type Sha256 } from '../../platform/blob.js';
import type { Codecs } from '../../platform/codec.js';
import { AttributesLimitError, ExportIgnore } from './export-ignore.js';
import type { GitTree, GitTreeEntry } from './fetch.js';

export const MAX_ARCHIVE_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_PATH_BYTES = 1024;
export const MAX_ATTRIBUTES_FILE_BYTES = 1024 * 1024;

const MAX_PREFIX_BYTES = 255;
const MAX_ZIP_ENTRIES = 0xfffe;
const VERSION = 20;
const VERSION_MADE_BY = (3 << 8) | VERSION;
const FLAGS = 0x0808;
const DOS_TIME = (8 << 11) | (15 << 5);
const DOS_DATE = ((1985 - 1980) << 9) | (10 << 5) | 26;
const LOCAL_HEADER = 30;
const DESCRIPTOR = 16;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const FILE_MODES: ReadonlyMap<string, number> = new Map([
  ['100644', 0o100644],
  ['100755', 0o100755],
]);
const EXPECTED_TYPE: ReadonlyMap<string, GitTreeEntry['type']> = new Map([
  ['100644', 'blob'],
  ['100755', 'blob'],
  ['120000', 'blob'],
  ['40000', 'tree'],
  ['160000', 'commit'],
]);
const RESERVED =
  /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)$/;
const IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

export type ArchiveErrorCode =
  'bad_path' | 'bad_object' | 'bad_attributes' | 'incomplete_tree' | 'too_large' | 'io_error';

/** `io_error` wraps any failure of the blob source, the staging port or a codec; see `cause`. */
export class ArchiveError extends Error {
  override readonly name = 'ArchiveError';

  constructor(
    readonly code: ArchiveErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export interface BlobBody {
  readonly size: number;
  readonly body: ReadableStream<Uint8Array>;
}

export interface ArchiveBlobSource {
  /** `maxBytes` is the remaining archive budget; a source may refuse a larger blob early. */
  read(oid: string, maxBytes: number): Promise<BlobBody>;
}

export interface StagedFile {
  readonly path: string;
  readonly writable: WritableStream<Uint8Array>;
  discard(): Promise<void>;
}

/** Creates a fresh temporary file under the blob staging directory. */
export interface ArchiveStaging {
  create(): Promise<StagedFile>;
}

export interface ArchiveIo {
  readonly blobs: ArchiveBlobSource;
  readonly staging: ArchiveStaging;
}

export interface ArchiveOptions {
  /** One or more directory components ending in `/`; defaults to the first 12 commit hex digits. */
  readonly prefix?: string;
}

export interface BuiltArchive {
  readonly path: string;
  readonly size: number;
  readonly sha1: string;
  readonly sha256: Sha256;
}

interface CentralRecord {
  readonly name: Uint8Array;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly mode: number;
  readonly offset: number;
}

interface PlannedFile {
  readonly entry: GitTreeEntry;
  readonly pathBytes: Uint8Array;
}

type Codec = Pick<Codecs, 'deflateRaw' | 'digestTap'>;

const encoder = new TextEncoder();
const attrsDecoder = new TextDecoder();
const noop = (): void => undefined;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crcUpdate(state: number, data: Uint8Array): number {
  let c = state;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return c;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
}

function validComponent(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  for (const char of name) {
    const c = char.codePointAt(0) as number;
    if (c < 0x20 || c === 0x7f || char === '\\' || char === ':') return false;
  }
  const folded = name.replace(IGNORABLE, '').toLowerCase();
  const stem = (folded.split('.', 1)[0] as string).replace(/ +$/, '');
  if (RESERVED.test(stem)) return false;
  const trimmed = folded.replace(/[. ]+$/, '');
  return trimmed !== '.git' && !/^(?:git|gi7eba)~\d+$/.test(trimmed);
}

function foldKey(path: string): string {
  return path
    .split('/')
    .map((c) =>
      c
        .normalize('NFC')
        .toLowerCase()
        .replace(/[. ]+$/, ''),
    )
    .join('/');
}

function checkPrefix(prefix: string): Uint8Array {
  const bytes = encoder.encode(prefix);
  if (!prefix.endsWith('/') || bytes.length > MAX_PREFIX_BYTES) throw new ArchiveError('bad_path');
  if (!prefix.slice(0, -1).split('/').every(validComponent)) throw new ArchiveError('bad_path');
  return bytes;
}

function checkTree(tree: GitTree): PlannedFile[] {
  if (tree.skipped > 0) throw new ArchiveError('incomplete_tree');
  const folded = new Map<string, string>();
  const files: PlannedFile[] = [];
  for (const entry of tree.entries) {
    const pathBytes = encoder.encode(entry.path);
    if (pathBytes.length > MAX_ARCHIVE_PATH_BYTES) throw new ArchiveError('bad_path');
    const parts = entry.path.split('/');
    if (!parts.every(validComponent)) throw new ArchiveError('bad_path');
    if (EXPECTED_TYPE.get(entry.mode) !== entry.type) throw new ArchiveError('bad_object');
    for (let i = 1; i <= parts.length; i++) {
      const original = parts.slice(0, i).join('/');
      const key = foldKey(original);
      const seen = folded.get(key);
      if (seen === undefined) folded.set(key, original);
      else if (seen !== original) throw new ArchiveError('bad_path');
    }
    if (FILE_MODES.has(entry.mode)) files.push({ entry, pathBytes });
  }
  return files.sort((a, b) => compareBytes(a.pathBytes, b.pathBytes));
}

/**
 * Streams one blob into `sink`, verifying its declared size against `maxBytes` and the bytes
 * against the git blob id. The body is cancelled on any failure.
 */
async function pumpBlob(
  codecs: Codec,
  io: ArchiveIo,
  entry: GitTreeEntry,
  maxBytes: number,
  sink: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  const { size, body } = await io.blobs.read(entry.oid, maxBytes);
  const reader = body.getReader();
  const tap = codecs.digestTap(['sha1'] as const);
  tap.digests.catch(noop);
  const draining = tap.transform.readable.pipeTo(new WritableStream());
  draining.catch(noop);
  const hasher = tap.transform.writable.getWriter();
  try {
    if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveError('bad_object');
    if (size > maxBytes) throw new ArchiveError('too_large');
    await hasher.write(encoder.encode(`blob ${size}\0`));
    let seen = 0;
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      seen += r.value.length;
      if (seen > size) throw new ArchiveError('bad_object');
      await hasher.write(r.value);
      await sink(r.value);
    }
    if (seen !== size) throw new ArchiveError('bad_object');
    await hasher.close();
    await draining;
    if (hex((await tap.digests).sha1) !== entry.oid) throw new ArchiveError('bad_object');
    return size;
  } catch (error) {
    await reader.cancel(error).catch(noop);
    await hasher.abort(error).catch(noop);
    throw error;
  }
}

async function loadAttributes(
  codecs: Codec,
  io: ArchiveIo,
  files: readonly PlannedFile[],
  budget: { used: number },
): Promise<ExportIgnore> {
  const matcher = new ExportIgnore();
  const sources = files
    .filter((f) => f.entry.path === '.gitattributes' || f.entry.path.endsWith('/.gitattributes'))
    .map((f) => ({ entry: f.entry, dir: f.entry.path.slice(0, -'/.gitattributes'.length) }))
    .map((s) => ({ ...s, depth: s.dir === '' ? 0 : s.dir.split('/').length }))
    .sort((a, b) => a.depth - b.depth);
  for (const { entry, dir } of sources) {
    if (dir !== '' && matcher.dirIgnored(dir)) continue;
    const max = Math.min(MAX_ATTRIBUTES_FILE_BYTES, MAX_ARCHIVE_INPUT_BYTES - budget.used);
    const chunks: Uint8Array[] = [];
    const size = await pumpBlob(codecs, io, entry, max, (chunk) => {
      chunks.push(chunk);
      return Promise.resolve();
    });
    budget.used += size;
    const text = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
      text.set(c, o);
      o += c.length;
    }
    matcher.add(dir, attrsDecoder.decode(text));
  }
  return matcher;
}

function localHeader(name: Uint8Array): Uint8Array {
  const out = new Uint8Array(LOCAL_HEADER + name.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, FLAGS, true);
  v.setUint16(8, 8, true);
  v.setUint16(10, DOS_TIME, true);
  v.setUint16(12, DOS_DATE, true);
  v.setUint16(26, name.length, true);
  out.set(name, LOCAL_HEADER);
  return out;
}

function dataDescriptor(r: CentralRecord): Uint8Array {
  const out = new Uint8Array(DESCRIPTOR);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x08074b50, true);
  v.setUint32(4, r.crc, true);
  v.setUint32(8, r.compressedSize, true);
  v.setUint32(12, r.size, true);
  return out;
}

function centralDirectory(records: readonly CentralRecord[], offset: number): Uint8Array {
  const cdSize = records.reduce((n, r) => n + CENTRAL_HEADER + r.name.length, 0);
  const out = new Uint8Array(cdSize + END_RECORD);
  const v = new DataView(out.buffer);
  let p = 0;
  for (const r of records) {
    v.setUint32(p, 0x02014b50, true);
    v.setUint16(p + 4, VERSION_MADE_BY, true);
    v.setUint16(p + 6, VERSION, true);
    v.setUint16(p + 8, FLAGS, true);
    v.setUint16(p + 10, 8, true);
    v.setUint16(p + 12, DOS_TIME, true);
    v.setUint16(p + 14, DOS_DATE, true);
    v.setUint32(p + 16, r.crc, true);
    v.setUint32(p + 20, r.compressedSize, true);
    v.setUint32(p + 24, r.size, true);
    v.setUint16(p + 28, r.name.length, true);
    v.setUint32(p + 38, (r.mode << 16) >>> 0, true);
    v.setUint32(p + 42, r.offset, true);
    out.set(r.name, p + CENTRAL_HEADER);
    p += CENTRAL_HEADER + r.name.length;
  }
  v.setUint32(p, 0x06054b50, true);
  v.setUint16(p + 8, records.length, true);
  v.setUint16(p + 10, records.length, true);
  v.setUint32(p + 12, cdSize, true);
  v.setUint32(p + 16, offset, true);
  return out;
}

class ZipWriter {
  offset = 0;
  private readonly records: CentralRecord[] = [];

  constructor(
    private readonly codecs: Codec,
    private readonly out: WritableStreamDefaultWriter<Uint8Array>,
  ) {}

  private async write(chunk: Uint8Array): Promise<void> {
    await this.out.write(chunk);
    this.offset += chunk.length;
  }

  async entry(
    name: Uint8Array,
    mode: number,
    pump: (sink: (chunk: Uint8Array) => Promise<void>) => Promise<number>,
  ): Promise<void> {
    const offset = this.offset;
    await this.write(localHeader(name));
    const deflater = this.codecs.deflateRaw();
    const input = deflater.writable.getWriter();
    const output = deflater.readable.getReader();
    let compressedSize = 0;
    const drain = (async () => {
      try {
        for (let r = await output.read(); !r.done; r = await output.read()) {
          compressedSize += r.value.length;
          await this.write(r.value);
        }
      } catch (error) {
        await input.abort(error).catch(noop);
        await output.cancel(error).catch(noop);
        throw error;
      }
    })();
    drain.catch(noop);
    let crc = 0xffffffff;
    let size: number;
    try {
      size = await pump(async (chunk) => {
        crc = crcUpdate(crc, chunk);
        await input.write(chunk);
      });
      await input.close();
    } catch (error) {
      await input.abort(error).catch(noop);
      await output.cancel(error).catch(noop);
      await drain.catch(noop);
      throw error;
    }
    await drain;
    const record = { name, crc: (crc ^ 0xffffffff) >>> 0, compressedSize, size, mode, offset };
    await this.write(dataDescriptor(record));
    this.records.push(record);
  }

  async finish(): Promise<void> {
    await this.write(centralDirectory(this.records, this.offset));
  }
}

async function build(
  tree: GitTree,
  codecs: Codec,
  io: ArchiveIo,
  options: ArchiveOptions,
): Promise<BuiltArchive> {
  const prefix = checkPrefix(options.prefix ?? `${tree.commit.slice(0, 12)}/`);
  const files = checkTree(tree);
  const budget = { used: END_RECORD };
  let matcher: ExportIgnore;
  try {
    matcher = await loadAttributes(codecs, io, files, budget);
  } catch (error) {
    if (error instanceof AttributesLimitError) throw new ArchiveError('bad_attributes');
    throw error;
  }
  const included: PlannedFile[] = [];
  try {
    for (const f of files) if (!matcher.ignored(f.entry.path)) included.push(f);
  } catch (error) {
    if (error instanceof AttributesLimitError) throw new ArchiveError('bad_attributes');
    throw error;
  }
  if (included.length > MAX_ZIP_ENTRIES) throw new ArchiveError('too_large');

  let file: StagedFile | undefined;
  let out: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let piping: Promise<void> | undefined;
  try {
    file = await io.staging.create();
    const tap = codecs.digestTap(['sha1', 'sha256'] as const);
    tap.digests.catch(noop);
    piping = tap.transform.readable.pipeTo(file.writable);
    piping.catch(noop);
    out = tap.transform.writable.getWriter();
    const zip = new ZipWriter(codecs, out);
    for (const { entry, pathBytes } of included) {
      const name = new Uint8Array(prefix.length + pathBytes.length);
      name.set(prefix);
      name.set(pathBytes, prefix.length);
      budget.used += LOCAL_HEADER + DESCRIPTOR + CENTRAL_HEADER + 2 * name.length;
      const remaining = MAX_ARCHIVE_INPUT_BYTES - budget.used;
      if (remaining < 0) throw new ArchiveError('too_large');
      await zip.entry(name, FILE_MODES.get(entry.mode) as number, async (sink) => {
        const size = await pumpBlob(codecs, io, entry, remaining, sink);
        budget.used += size;
        return size;
      });
    }
    await zip.finish();
    await out.close();
    await piping;
    const digests = await tap.digests;
    return {
      path: file.path,
      size: zip.offset,
      sha1: hex(digests.sha1),
      sha256: parseSha256(hex(digests.sha256)),
    };
  } catch (error) {
    await out?.abort(error).catch(noop);
    await piping?.catch(noop);
    await file?.discard().catch(noop);
    throw error;
  }
}

/**
 * Builds a deterministic Composer dist zip from a full tree into a staged temporary file. Every
 * entry sits under one top-level directory, so Composer never flattens a lone surviving folder.
 * `.gitattributes` export-ignore is honoured at every level; symlinks, submodules and directories
 * get no entry. Each blob is streamed and checked against its id. On failure nothing is left
 * staged and the error is an ArchiveError.
 */
export async function buildZipFromTree(
  tree: GitTree,
  codecs: Codec,
  io: ArchiveIo,
  options: ArchiveOptions = {},
): Promise<BuiltArchive> {
  try {
    return await build(tree, codecs, io, options);
  } catch (error) {
    throw error instanceof ArchiveError ? error : new ArchiveError('io_error', { cause: error });
  }
}
