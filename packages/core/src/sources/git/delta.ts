import type { Codecs } from '../../platform/codec.js';
import type { BaseObjectType, PackBudget, PackObject, ParsedPack } from './pack.js';

export const MAX_DELTA_CHAIN_DEPTH = 50;

const MAX_SIZE_VARINT_BYTES = 8;
const COPY_ZERO_SIZE = 0x10000;

export type DeltaErrorCode =
  | 'truncated_delta'
  | 'bad_size'
  | 'base_size_mismatch'
  | 'result_size_mismatch'
  | 'copy_out_of_range'
  | 'bad_opcode'
  | 'chain_too_deep'
  | 'missing_base';

export class DeltaError extends Error {
  override readonly name = 'DeltaError';

  readonly code: DeltaErrorCode;

  constructor(code: DeltaErrorCode) {
    super(`invalid delta: ${code}`);
    this.code = code;
  }
}

export interface ResolvedObject {
  readonly oid: string;
  readonly type: BaseObjectType;
  readonly data: Uint8Array;
}

export interface ResolvedPack {
  readonly objects: ResolvedObject[];
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function objectId(codecs: Codecs, type: BaseObjectType, data: Uint8Array): Promise<string> {
  const tap = codecs.digestTap(['sha1'] as const);
  const reader = tap.transform.readable.getReader();
  const drained = (async () => {
    let done = false;
    while (!done) ({ done } = await reader.read());
  })();
  const writer = tap.transform.writable.getWriter();
  const written = (async () => {
    await writer.write(new TextEncoder().encode(`${type} ${data.length}\0`));
    await writer.write(data);
    await writer.close();
  })();
  await Promise.all([written, drained]);
  return hex((await tap.digests).sha1);
}

function applyDelta(base: Uint8Array, delta: Uint8Array, budget: PackBudget): Uint8Array {
  let p = 0;
  const varint = (): number => {
    let value = 0;
    let multiplier = 1;
    for (let n = 0; n < MAX_SIZE_VARINT_BYTES; n++) {
      if (p >= delta.length) throw new DeltaError('truncated_delta');
      const c = delta[p++] as number;
      value += (c & 0x7f) * multiplier;
      if (!(c & 0x80)) return value;
      multiplier *= 128;
    }
    throw new DeltaError('bad_size');
  };
  const byte = (): number => {
    if (p >= delta.length) throw new DeltaError('truncated_delta');
    return delta[p++] as number;
  };

  if (varint() !== base.length) throw new DeltaError('base_size_mismatch');
  const resultSize = varint();
  budget.chargeObject(resultSize);
  const out = new Uint8Array(resultSize);
  let o = 0;

  while (p < delta.length) {
    const op = byte();
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset += byte();
      if (op & 0x02) offset += byte() * 2 ** 8;
      if (op & 0x04) offset += byte() * 2 ** 16;
      if (op & 0x08) offset += byte() * 2 ** 24;
      if (op & 0x10) size += byte();
      if (op & 0x20) size += byte() * 2 ** 8;
      if (op & 0x40) size += byte() * 2 ** 16;
      if (size === 0) size = COPY_ZERO_SIZE;
      if (offset > base.length || size > base.length - offset) {
        throw new DeltaError('copy_out_of_range');
      }
      if (size > resultSize - o) throw new DeltaError('result_size_mismatch');
      out.set(base.subarray(offset, offset + size), o);
      o += size;
    } else if (op) {
      if (op > delta.length - p) throw new DeltaError('truncated_delta');
      if (op > resultSize - o) throw new DeltaError('result_size_mismatch');
      out.set(delta.subarray(p, p + op), o);
      p += op;
      o += op;
    } else {
      throw new DeltaError('bad_opcode');
    }
  }
  if (o !== resultSize) throw new DeltaError('result_size_mismatch');
  return out;
}

export async function resolvePackObjects(
  raw: ParsedPack,
  codecs: Codecs,
  budget: PackBudget,
): Promise<ResolvedPack> {
  const resolved = new Map<number, ResolvedObject>();
  const depth = new Map<number, number>();
  const byOid = new Map<string, number>();
  const waitingOnOffset = new Map<number, PackObject[]>();
  const waitingOnOid = new Map<string, PackObject[]>();
  const queue: PackObject[] = [];

  const wait = <K>(map: Map<K, PackObject[]>, key: K, obj: PackObject): void => {
    const list = map.get(key);
    if (list) list.push(obj);
    else map.set(key, [obj]);
  };

  const finish = async (
    obj: PackObject,
    type: BaseObjectType,
    data: Uint8Array,
    d: number,
  ): Promise<void> => {
    const oid = await objectId(codecs, type, data);
    resolved.set(obj.offset, { oid, type, data });
    depth.set(obj.offset, d);
    if (!byOid.has(oid)) byOid.set(oid, obj.offset);
    for (const w of waitingOnOffset.get(obj.offset) ?? []) queue.push(w);
    for (const w of waitingOnOid.get(oid) ?? []) queue.push(w);
    waitingOnOffset.delete(obj.offset);
    waitingOnOid.delete(oid);
  };

  for (const obj of raw.objects) {
    if (obj.kind === 'base') await finish(obj, obj.type, obj.data, 0);
    else if (obj.kind === 'ofs-delta') {
      if (resolved.has(obj.baseOffset)) queue.push(obj);
      else wait(waitingOnOffset, obj.baseOffset, obj);
    } else {
      if (byOid.has(obj.baseOid)) queue.push(obj);
      else wait(waitingOnOid, obj.baseOid, obj);
    }
    while (queue.length) {
      const delta = queue.pop() as Exclude<PackObject, { kind: 'base' }>;
      const baseAt = delta.kind === 'ofs-delta' ? delta.baseOffset : byOid.get(delta.baseOid);
      const base = baseAt === undefined ? undefined : resolved.get(baseAt);
      if (baseAt === undefined || !base) throw new DeltaError('missing_base');
      const d = (depth.get(baseAt) as number) + 1;
      if (d > MAX_DELTA_CHAIN_DEPTH) throw new DeltaError('chain_too_deep');
      await finish(delta, base.type, applyDelta(base.data, delta.delta, budget), d);
    }
  }

  if (waitingOnOffset.size || waitingOnOid.size) throw new DeltaError('missing_base');
  return { objects: raw.objects.map((o) => resolved.get(o.offset) as ResolvedObject) };
}
