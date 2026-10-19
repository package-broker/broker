import {
  CodecCorruptError,
  CodecLimitError,
  CodecTruncatedError,
  type Codecs,
} from '../../platform/codec.js';

const HEADER_BYTES = 12;
const TRAILER_BYTES = 20;
const MAX_SIZE_VARINT_BYTES = 8;
const MAX_OFFSET_VARINT_BYTES = 10;

export interface PackLimits {
  readonly maxObjects: number;
  readonly maxRetainedBytes: number;
  readonly maxObjectBytes: number;
}

export type PackBudgetErrorCode = 'objects' | 'retained_bytes' | 'object_bytes';

export class PackBudgetError extends Error {
  override readonly name = 'PackBudgetError';

  readonly code: PackBudgetErrorCode;

  constructor(code: PackBudgetErrorCode) {
    super(`pack budget exceeded: ${code}`);
    this.code = code;
  }
}

export type PackFormatErrorCode =
  | 'bad_header'
  | 'bad_object_header'
  | 'trailer_mismatch'
  | 'truncated'
  | 'size_mismatch'
  | 'corrupt'
  | 'trailing_data';

export class PackFormatError extends Error {
  override readonly name = 'PackFormatError';

  readonly code: PackFormatErrorCode;

  constructor(code: PackFormatErrorCode) {
    super(`invalid packfile: ${code}`);
    this.code = code;
  }
}

export class PackBudget {
  private retained = 0;

  readonly limits: PackLimits;

  constructor(limits: PackLimits) {
    this.limits = limits;
  }

  get retainedBytes(): number {
    return this.retained;
  }

  charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('charge must be a size');
    if (bytes > this.limits.maxRetainedBytes - this.retained) {
      throw new PackBudgetError('retained_bytes');
    }
    this.retained += bytes;
  }

  chargeObject(declaredSize: number): void {
    if (declaredSize > this.limits.maxObjectBytes) throw new PackBudgetError('object_bytes');
    this.charge(declaredSize);
  }

  assertObjectCount(count: number): void {
    if (count > this.limits.maxObjects) throw new PackBudgetError('objects');
  }
}

export type BaseObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export type PackObject =
  | { kind: 'base'; offset: number; type: BaseObjectType; data: Uint8Array }
  | { kind: 'ofs-delta'; offset: number; baseOffset: number; delta: Uint8Array }
  | { kind: 'ref-delta'; offset: number; baseOid: string; delta: Uint8Array };

export interface ParsedPack {
  readonly version: number;
  readonly objects: PackObject[];
}

const BASE_TYPES: Record<number, BaseObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function sha1(codecs: Codecs, bytes: Uint8Array): Promise<Uint8Array> {
  const tap = codecs.digestTap(['sha1'] as const);
  const reader = tap.transform.readable.getReader();
  const drained = (async () => {
    let done = false;
    while (!done) ({ done } = await reader.read());
  })();
  const writer = tap.transform.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  await drained;
  return (await tap.digests).sha1;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function parsePackObjects(
  bytes: Uint8Array,
  codecs: Codecs,
  budget: PackBudget,
): Promise<ParsedPack> {
  budget.charge(Math.max(bytes.length, bytes.buffer.byteLength));
  if (bytes.length < HEADER_BYTES + TRAILER_BYTES) throw new PackFormatError('truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x5041434b) throw new PackFormatError('bad_header');
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new PackFormatError('bad_header');
  const count = view.getUint32(8);
  budget.assertObjectCount(count);

  const end = bytes.length - TRAILER_BYTES;
  const digest = await sha1(codecs, bytes.subarray(0, end));
  if (!equal(digest, bytes.subarray(end))) throw new PackFormatError('trailer_mismatch');

  const objects: PackObject[] = [];
  const starts = new Set<number>();
  let pos = HEADER_BYTES;
  const next = (): number => {
    if (pos >= end) throw new PackFormatError('truncated');
    return bytes[pos++] as number;
  };

  for (let n = 0; n < count; n++) {
    const start = pos;
    let c = next();
    const type = (c >> 4) & 7;
    let size = c & 15;
    let multiplier = 16;
    let headerBytes = 1;
    while (c & 0x80) {
      if (++headerBytes > MAX_SIZE_VARINT_BYTES) throw new PackFormatError('bad_object_header');
      c = next();
      size += (c & 0x7f) * multiplier;
      multiplier *= 128;
    }
    if (!Number.isSafeInteger(size)) throw new PackFormatError('bad_object_header');

    let baseOffset = 0;
    let baseOid = '';
    if (type === 6) {
      c = next();
      let distance = c & 0x7f;
      let used = 1;
      while (c & 0x80) {
        if (++used > MAX_OFFSET_VARINT_BYTES) throw new PackFormatError('bad_object_header');
        c = next();
        distance = (distance + 1) * 128 + (c & 0x7f);
        if (!Number.isSafeInteger(distance)) throw new PackFormatError('bad_object_header');
      }
      baseOffset = start - distance;
      if (!starts.has(baseOffset)) throw new PackFormatError('bad_object_header');
    } else if (type === 7) {
      if (pos + 20 > end) throw new PackFormatError('truncated');
      baseOid = hex(bytes.subarray(pos, pos + 20));
      pos += 20;
    } else if (!BASE_TYPES[type]) {
      throw new PackFormatError('bad_object_header');
    }

    budget.chargeObject(size);
    let data: Uint8Array;
    try {
      const inflated = codecs.inflateConsumed(bytes.subarray(pos, end), size);
      data = inflated.data;
      pos += inflated.consumed;
    } catch (e) {
      if (e instanceof CodecLimitError) throw new PackFormatError('size_mismatch');
      if (e instanceof CodecTruncatedError) throw new PackFormatError('truncated');
      if (e instanceof CodecCorruptError) throw new PackFormatError('corrupt');
      throw e;
    }
    if (data.length !== size) throw new PackFormatError('size_mismatch');
    if (data.byteOffset !== 0 || data.buffer.byteLength !== data.length) data = data.slice();
    starts.add(start);

    if (type === 6) objects.push({ kind: 'ofs-delta', offset: start, baseOffset, delta: data });
    else if (type === 7) objects.push({ kind: 'ref-delta', offset: start, baseOid, delta: data });
    else
      objects.push({ kind: 'base', offset: start, type: BASE_TYPES[type] as BaseObjectType, data });
  }
  if (pos !== end) throw new PackFormatError('trailing_data');
  return { version, objects };
}
