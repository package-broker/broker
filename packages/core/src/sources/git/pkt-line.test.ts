import { describe, expect, it } from 'vitest';
import {
  DELIM,
  FLUSH,
  GitRemoteError,
  PktLineError,
  PktLineReader,
  RESPONSE_END,
  decodeSideband,
  encodePkt,
} from './pkt-line.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function raw(s: string): Uint8Array {
  return enc.encode(s);
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function drain(bytes: Uint8Array, size = bytes.length || 1, maxTotalBytes = 1 << 20) {
  const reader = new PktLineReader(chunked(bytes, size), { maxTotalBytes });
  const out: Array<{ kind: string; text?: string }> = [];
  for (;;) {
    const p = await reader.next();
    if (p === null) return out;
    out.push(p.kind === 'data' ? { kind: p.kind, text: dec.decode(p.data) } : { kind: p.kind });
  }
}

function referenceParse(buf: Uint8Array): Array<{ kind: string; text?: string }> {
  const out: Array<{ kind: string; text?: string }> = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = Number.parseInt(dec.decode(buf.subarray(i, i + 4)), 16);
    if (len < 4) {
      out.push({ kind: len === 0 ? 'flush' : len === 1 ? 'delim' : 'end' });
      i += 4;
      continue;
    }
    out.push({ kind: 'data', text: dec.decode(buf.subarray(i + 4, i + len)) });
    i += len;
  }
  return out;
}

const OID = 'a'.repeat(40);
const v2Advertisement = concat([
  encodePkt('# service=git-upload-pack\n'),
  FLUSH,
  encodePkt('version 2\n'),
  encodePkt('agent=git/2.54.0\n'),
  encodePkt('ls-refs=unborn\n'),
  encodePkt('fetch=shallow wait-for-done filter\n'),
  encodePkt('object-format=sha1\n'),
  FLUSH,
]);
const v1Advertisement = concat([
  encodePkt('# service=git-upload-pack\n'),
  FLUSH,
  encodePkt(`${OID} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/main agent=git/2.54.0\n`),
  encodePkt(`${OID} refs/heads/main\n`),
  encodePkt(`${OID} refs/tags/v1.0.0\n`),
  FLUSH,
]);
const sidebandFetch = concat([
  encodePkt('packfile\n'),
  encodePkt(concat([Uint8Array.of(2), raw('Counting objects\n')])),
  encodePkt(concat([Uint8Array.of(1), Uint8Array.of(0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2)])),
  DELIM,
  FLUSH,
  RESPONSE_END,
]);

describe('recorded response shapes', () => {
  for (const [name, bytes] of [
    ['v2 advertisement', v2Advertisement],
    ['v1 advertisement', v1Advertisement],
    ['sideband fetch', sidebandFetch],
  ] as const) {
    it(`parses the ${name} like the spike parser, whole and byte by byte`, async () => {
      const expected = referenceParse(bytes);
      expect(await drain(bytes)).toEqual(expected);
      expect(await drain(bytes, 1)).toEqual(expected);
      expect(await drain(bytes, 7)).toEqual(expected);
    });
  }

  it('reports flush, delimiter and response-end kinds', async () => {
    expect((await drain(concat([FLUSH, DELIM, RESPONSE_END]))).map((p) => p.kind)).toEqual([
      'flush',
      'delim',
      'end',
    ]);
  });

  it('returns null at a clean end of stream and on an empty stream', async () => {
    expect(await drain(new Uint8Array(0))).toEqual([]);
  });
});

describe('fail closed', () => {
  it.each(['zzzz', '00g1', '+0ab', ' 0ab', '0003', '-001'])(
    'rejects malformed length %j',
    async (header) => {
      await expect(drain(raw(`${header}abcdef`))).rejects.toMatchObject({ code: 'bad_length' });
    },
  );

  it('rejects a length above 65520', async () => {
    await expect(drain(raw('fff1'))).rejects.toMatchObject({ code: 'oversized_line' });
  });

  it('accepts a line of exactly 65520', async () => {
    const body = new Uint8Array(65516).fill(0x61);
    const packets = await drain(concat([raw('fff0'), body]));
    expect(packets).toHaveLength(1);
  });

  it('rejects truncation inside a header', async () => {
    await expect(drain(raw('00'))).rejects.toMatchObject({ code: 'truncated' });
  });

  it('rejects truncation inside a body', async () => {
    await expect(drain(raw('000aabc'))).rejects.toMatchObject({ code: 'truncated' });
  });

  it('enforces the total cap and never buffers beyond it', async () => {
    const bytes = concat([encodePkt('aaaa'), encodePkt('bbbb')]);
    await expect(drain(bytes, 3, 12)).rejects.toMatchObject({ code: 'total_cap' });
    expect(await drain(bytes, 3, 16)).toHaveLength(2);
  });

  it('surfaces errors as PktLineError instances', async () => {
    await expect(drain(raw('zzzz'))).rejects.toBeInstanceOf(PktLineError);
  });

  it('closes the source when it fails', async () => {
    let closed = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        yield raw('zzzz');
      } finally {
        closed = true;
      }
    }
    await expect(new PktLineReader(source(), { maxTotalBytes: 100 }).next()).rejects.toBeInstanceOf(
      PktLineError,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(true);
  });
});

describe('remote errors', () => {
  it('turns an ERR line into a GitRemoteError carrying only a code', async () => {
    const error = (await drain(encodePkt('ERR secret-token-123 leaked')).catch(
      (e: unknown) => e,
    )) as GitRemoteError;
    expect(error).toBeInstanceOf(GitRemoteError);
    expect(error.code).toBe('remote_error');
    expect(error.message).toBe('remote_error');
    expect(JSON.stringify(error)).not.toContain('secret-token');
    expect(String(error.stack)).not.toContain('secret-token');
  });

  it('turns band 3 into a GitRemoteError without the remote text', () => {
    const packet = concat([Uint8Array.of(3), raw('fatal: secret-token-123\n')]);
    try {
      decodeSideband(packet);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GitRemoteError);
      expect((error as GitRemoteError).code).toBe('remote_band3');
      expect((error as GitRemoteError).message).not.toContain('secret');
    }
  });

  it('returns band 1 data and only the length of band 2', () => {
    expect(decodeSideband(concat([Uint8Array.of(1), raw('pack')]))).toEqual({
      band: 1,
      data: raw('pack'),
    });
    expect(decodeSideband(concat([Uint8Array.of(2), raw('progress')]))).toEqual({
      band: 2,
      length: 8,
    });
  });

  it('rejects unknown bands and empty sideband packets', () => {
    expect(() => decodeSideband(Uint8Array.of(4, 1))).toThrow(PktLineError);
    expect(() => decodeSideband(new Uint8Array(0))).toThrow(PktLineError);
  });
});

describe('cap accounting', () => {
  it.each([
    [FLUSH, 'total_cap'],
    [DELIM, 'total_cap'],
    [RESPONSE_END, 'trailing_data'],
  ] as const)('counts special packets as 4 bytes', async (special, code) => {
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) yield special;
    }
    const reader = new PktLineReader(endless(), { maxTotalBytes: 40 });
    let count = 0;
    await expect(
      (async () => {
        for (;;) {
          const p = await reader.next();
          if (p === null) throw new Error(`stopped ${count}`);
          count += 1;
        }
      })(),
    ).rejects.toMatchObject({ code });
    expect(count).toBeLessThanOrEqual(10);
  });

  it('rejects an oversized source chunk before retaining it', async () => {
    const big = new Uint8Array(1000).fill(0x30);
    await expect(drain(big, 1000, 100)).rejects.toMatchObject({ code: 'total_cap' });
  });

  it('bounds endless empty chunks', async () => {
    async function* empties(): AsyncGenerator<Uint8Array> {
      for (;;) yield new Uint8Array(0);
    }
    await expect(new PktLineReader(empties(), { maxTotalBytes: 100 }).next()).rejects.toMatchObject(
      { code: 'stalled' },
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])(
    'rejects maxTotalBytes %j',
    (maxTotalBytes) => {
      expect(() => new PktLineReader(chunked(new Uint8Array(0), 1), { maxTotalBytes })).toThrow(
        RangeError,
      );
    },
  );
});

describe('terminal failures', () => {
  it('rejects every later read with the same error', async () => {
    const reader = new PktLineReader(
      chunked(concat([encodePkt('ok'), raw('zzzz'), encodePkt('late')]), 5),
      { maxTotalBytes: 1000 },
    );
    expect((await reader.next())?.kind).toBe('data');
    const first = await reader.next().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(PktLineError);
    expect(await reader.next().catch((e: unknown) => e)).toBe(first);
    expect(await reader.nextSideband().catch((e: unknown) => e)).toBe(first);
  });

  it('keeps a GitRemoteError terminal too', async () => {
    const reader = new PktLineReader(
      chunked(concat([encodePkt('ERR x'), encodePkt('late')]), 100),
      { maxTotalBytes: 1000 },
    );
    const first = await reader.next().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(GitRemoteError);
    expect(await reader.next().catch((e: unknown) => e)).toBe(first);
  });

  it('closes the source without awaiting it when a return() hangs or throws', async () => {
    const hanging: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: raw('zzzz') }),
        return: () => new Promise(() => undefined),
      }),
    };
    await expect(new PktLineReader(hanging, { maxTotalBytes: 100 }).next()).rejects.toBeInstanceOf(
      PktLineError,
    );
    const throwing: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: raw('zzzz') }),
        return: () => {
          throw new Error('boom');
        },
      }),
    };
    await expect(new PktLineReader(throwing, { maxTotalBytes: 100 }).next()).rejects.toBeInstanceOf(
      PktLineError,
    );
  });
});

describe('protocol and sideband modes', () => {
  it('rejects delimiter and response-end packets under protocol 1', async () => {
    for (const special of [DELIM, RESPONSE_END]) {
      const reader = new PktLineReader(chunked(special, 4), { maxTotalBytes: 100, protocol: 1 });
      await expect(reader.next()).rejects.toMatchObject({ code: 'unsupported_packet' });
    }
    const flush = new PktLineReader(chunked(FLUSH, 4), { maxTotalBytes: 100, protocol: 1 });
    expect(await flush.next()).toEqual({ kind: 'flush' });
  });

  it('finishes at response-end and rejects trailing bytes', async () => {
    const clean = new PktLineReader(chunked(concat([encodePkt('a'), RESPONSE_END]), 3), {
      maxTotalBytes: 100,
    });
    expect((await clean.next())?.kind).toBe('data');
    expect((await clean.next())?.kind).toBe('end');
    expect(await clean.next()).toBeNull();
    const dirty = new PktLineReader(chunked(concat([RESPONSE_END, encodePkt('b')]), 3), {
      maxTotalBytes: 100,
    });
    expect((await dirty.next())?.kind).toBe('end');
    await expect(dirty.next()).rejects.toMatchObject({ code: 'trailing_data' });
    await expect(dirty.next()).rejects.toMatchObject({ code: 'trailing_data' });
  });

  it('demultiplexes band 1, skips band 2 and raises band 3', async () => {
    const band = (n: number, text: string): Uint8Array =>
      encodePkt(concat([Uint8Array.of(n), raw(text)]));
    const ok = new PktLineReader(
      chunked(
        concat([band(2, 'progress'), band(1, 'PACK'), band(2, 'more'), band(1, 'data'), FLUSH]),
        4,
      ),
      {
        maxTotalBytes: 1000,
      },
    );
    const seen: string[] = [];
    for (;;) {
      const p = await ok.nextSideband();
      if (p === null) break;
      seen.push(p.kind === 'data' ? dec.decode(p.data) : p.kind);
    }
    expect(seen).toEqual(['PACK', 'data', 'flush']);

    const bad = new PktLineReader(chunked(concat([band(1, 'PACK'), band(3, 'fatal: hidden')]), 4), {
      maxTotalBytes: 1000,
    });
    expect((await bad.nextSideband())?.kind).toBe('data');
    const error = (await bad.nextSideband().catch((e: unknown) => e)) as GitRemoteError;
    expect(error).toBeInstanceOf(GitRemoteError);
    expect(error.code).toBe('remote_band3');
    expect(error.message).not.toContain('hidden');
  });

  it('rejects unknown bands and empty packets in sideband mode', async () => {
    await expect(
      new PktLineReader(chunked(encodePkt(Uint8Array.of(9, 1)), 8), {
        maxTotalBytes: 100,
      }).nextSideband(),
    ).rejects.toMatchObject({
      code: 'bad_band',
    });
    await expect(
      new PktLineReader(chunked(raw('0004'), 4), { maxTotalBytes: 100 }).nextSideband(),
    ).rejects.toMatchObject({ code: 'bad_band' });
  });
});

describe('round 3', () => {
  it('counts only consecutive empty chunks as stalled', async () => {
    const packets = [encodePkt('one'), encodePkt('two'), FLUSH];
    const bytes = concat(packets);
    async function* interleaved(): AsyncGenerator<Uint8Array> {
      for (const byte of bytes) {
        for (let i = 0; i < 600; i += 1) yield new Uint8Array(0);
        yield Uint8Array.of(byte);
      }
    }
    const reader = new PktLineReader(interleaved(), { maxTotalBytes: 1000 });
    const kinds: string[] = [];
    for (;;) {
      const p = await reader.next();
      if (p === null) break;
      kinds.push(p.kind);
    }
    expect(kinds).toEqual(['data', 'data', 'flush']);
  });

  it('throws on overlapping reads without poisoning the first', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slow(): AsyncGenerator<Uint8Array> {
      await gate;
      yield encodePkt('x');
    }
    const reader = new PktLineReader(slow(), { maxTotalBytes: 100 });
    const first = reader.next();
    await expect(reader.next()).rejects.toMatchObject({ code: 'busy' });
    release();
    expect((await first)?.kind).toBe('data');
  });

  it.each([0, 3, '2', null])('rejects protocol %j', (protocol) => {
    expect(
      () =>
        new PktLineReader(chunked(new Uint8Array(0), 1), {
          maxTotalBytes: 10,
          protocol: protocol as 1,
        }),
    ).toThrow(RangeError);
  });

  it('wraps non-Error source failures as source_error', async () => {
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield* [];
      throw 'secret-token-123';
    }
    const error = await new PktLineReader(failing(), { maxTotalBytes: 10 })
      .next()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PktLineError);
    expect((error as PktLineError).code).toBe('source_error');
    expect(String((error as PktLineError).message)).not.toContain('secret');
  });
});

describe('edge packets', () => {
  it('pins 0004 as an empty data packet', async () => {
    const reader = new PktLineReader(chunked(raw('0004'), 4), { maxTotalBytes: 100 });
    expect(await reader.next()).toEqual({ kind: 'data', data: new Uint8Array(0) });
  });

  it('accepts uppercase hex lengths', async () => {
    expect(await drain(raw('000AABCDEF'))).toEqual([{ kind: 'data', text: 'ABCDEF' }]);
  });
});

describe('fuzz', () => {
  function prng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('only throws typed errors, never exceeds the cap, whatever the split', async () => {
    const rand = prng(20261016);
    for (let round = 0; round < 3000; round += 1) {
      const parts: Uint8Array[] = [];
      for (let n = Math.floor(rand() * 8); n > 0; n -= 1) {
        const kind = rand();
        if (kind < 0.4)
          parts.push(
            encodePkt(
              Uint8Array.from({ length: 1 + Math.floor(rand() * 40) }, () =>
                Math.floor(rand() * 256),
              ),
            ),
          );
        else if (kind < 0.6)
          parts.push([FLUSH, DELIM, RESPONSE_END][Math.floor(rand() * 3)] as Uint8Array);
        else if (kind < 0.7) parts.push(raw('ERR nope'));
        else
          parts.push(
            Uint8Array.from({ length: Math.floor(rand() * 12) }, () => Math.floor(rand() * 256)),
          );
      }
      const bytes = concat(parts);
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length;) {
        const size = 1 + Math.floor(rand() * 6);
        chunks.push(bytes.subarray(i, i + size));
        i += size;
      }
      async function* source(): AsyncGenerator<Uint8Array> {
        yield* chunks;
      }
      const cap = 1 + Math.floor(rand() * 200);
      const reader = new PktLineReader(source(), {
        maxTotalBytes: cap,
        protocol: rand() < 0.5 ? 1 : 2,
      });
      const sideband = rand() < 0.5;
      let used = 0;
      try {
        for (;;) {
          const p = sideband ? await reader.nextSideband() : await reader.next();
          if (p === null) break;
          used += p.kind === 'data' ? p.data.length + 4 : 4;
          expect(used).toBeLessThanOrEqual(cap);
        }
      } catch (error) {
        expect(error instanceof PktLineError || error instanceof GitRemoteError).toBe(true);
      }
      expect(reader.consumedBytes).toBeLessThanOrEqual(cap);
    }
  });
});

describe('writer', () => {
  it('encodes a data line with a 4-hex length including the header', () => {
    expect(dec.decode(encodePkt('command=ls-refs\n'))).toBe('0014command=ls-refs\n');
  });

  it('encodes UTF-8 by byte length', () => {
    expect(dec.decode(encodePkt('é'))).toBe('0006é');
  });

  it('exposes the special packets', () => {
    expect([dec.decode(FLUSH), dec.decode(DELIM), dec.decode(RESPONSE_END)]).toEqual([
      '0000',
      '0001',
      '0002',
    ]);
  });

  it('accepts a payload of 65516 bytes and refuses 65517', () => {
    expect(encodePkt(new Uint8Array(65516)).length).toBe(65520);
    expect(() => encodePkt(new Uint8Array(65517))).toThrow(PktLineError);
  });

  it('rejects an empty payload', () => {
    expect(() => encodePkt('')).toThrow(PktLineError);
  });

  it('round-trips through the reader', async () => {
    const packets = await drain(concat([encodePkt('one\n'), DELIM, encodePkt('two\n'), FLUSH]));
    expect(packets).toEqual([
      { kind: 'data', text: 'one\n' },
      { kind: 'delim' },
      { kind: 'data', text: 'two\n' },
      { kind: 'flush' },
    ]);
  });
});
