import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { JsonStreamError } from './json-tokenizer.js';
import {
  extractMembers,
  JsonExtractError,
  type ExtractLimits,
  type ExtractedMember,
  type MemberSelector,
} from './json-stream.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const encoder = new TextEncoder();

function streamOf(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + chunkSize));
      at += chunkSize;
    },
  });
}

async function collect(
  source: ReadableStream<Uint8Array>,
  selectors: readonly MemberSelector[],
  limits?: ExtractLimits,
): Promise<ExtractedMember[]> {
  const out: ExtractedMember[] = [];
  for await (const member of extractMembers(source, selectors, limits)) {
    out.push(member);
  }
  return out;
}

function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function matches(selector: MemberSelector, path: readonly string[], full: boolean): boolean {
  if (full ? selector.length !== path.length : selector.length <= path.length) {
    return false;
  }
  return path.every((name, index) => selector[index] === '*' || selector[index] === name);
}

function reference(
  doc: Json,
  selectors: readonly MemberSelector[],
): { path: string[]; value: Json }[] {
  const out: { path: string[]; value: Json }[] = [];
  const walk = (node: Json, path: string[]): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const next = [...path, key];
      if (selectors.some((selector) => matches(selector, next, true))) {
        out.push({ path: next, value });
      } else if (selectors.some((selector) => matches(selector, next, false))) {
        walk(value, next);
      }
    }
  };
  walk(doc, []);
  return out;
}

function version(index: number, pad: number): Json {
  const name = `pkg-${index % 37}`;
  return {
    name,
    version: `1.${index % 17}.${index}`,
    description: `Ünïcödé \u{1f600} "quoted" back\\slash tab\t line\n ${'x'.repeat(pad)}`,
    dependencies: { left: `^${index}.0.0`, 'right-é': '~2.1.0' },
    deprecated: index % 7 === 0 ? 'old' : false,
    size: [index, -index, index / 8, 1.5e-7, 2e21, 0, -0.25],
    dist: { shasum: 'a'.repeat(40), tarball: `https://registry.example.test/${name}-${index}.tgz` },
    lone: index % 11 === 0 ? '\ud800 and \udc00 lone' : null,
  };
}

function npmPackument(count: number, pad: number): Json {
  const versions: Record<string, Json> = {};
  const time: Record<string, Json> = { created: '2020-01-01T00:00:00.000Z' };
  for (let index = 0; index < count; index += 1) {
    versions[`1.${index % 17}.${index}`] = version(index, pad);
    time[`1.${index % 17}.${index}`] = '2020-01-02T00:00:00.000Z';
  }
  return {
    name: 'example',
    'dist-tags': { latest: '1.0.0' },
    time,
    versions,
    readme: 'r'.repeat(50),
  };
}

function composerV1(count: number, pad: number): Json {
  const packages: Record<string, Json> = {};
  for (let name = 0; name < 20; name += 1) {
    const versions: Record<string, Json> = {};
    for (let index = 0; index < count / 20; index += 1) {
      versions[`v${index}`] = version(index, pad);
    }
    packages[`vendor/name-${name}`] = versions;
  }
  return { packages, 'notify-batch': '/downloads/' };
}

function providers(count: number): Json {
  const entries: Record<string, Json> = {};
  for (let index = 0; index < count; index += 1) {
    entries[`vendor/pkg-${index}`] = { sha256: `${index}`.padStart(64, '0') };
  }
  return {
    'provider-includes': { 'p/%hash%.json': { sha256: 'b'.repeat(64) } },
    providers: entries,
  };
}

const NPM: MemberSelector[] = [['versions', '*'], ['time'], ['dist-tags']];
const COMPOSER: MemberSelector[] = [['packages', '*', '*']];
const PROVIDERS: MemberSelector[] = [['providers', '*']];

const fixtures: {
  name: string;
  text: (small: boolean) => string;
  selectors: MemberSelector[];
}[] = [
  {
    name: 'minified npm packument',
    text: (small) => JSON.stringify(npmPackument(small ? 60 : 3000, 3000)),
    selectors: NPM,
  },
  {
    name: 'pretty npm packument',
    text: (small) => JSON.stringify(npmPackument(small ? 40 : 1600, 5500), null, 2),
    selectors: NPM,
  },
  {
    name: 'composer v1 packages',
    text: (small) => JSON.stringify(composerV1(small ? 60 : 2800, 3000)),
    selectors: COMPOSER,
  },
  {
    name: 'composer providers',
    text: (small) => JSON.stringify(providers(small ? 500 : 60000), null, 1),
    selectors: PROVIDERS,
  },
];

describe('extractMembers', () => {
  describe.each(fixtures)('$name', ({ text, selectors }) => {
    it('equals JSON.parse extraction on a large document', async () => {
      const source = text(false);
      expect(source.length).toBeGreaterThan(2 * 1024 * 1024);
      const expected = reference(JSON.parse(source) as Json, selectors);
      expect(expected.length).toBeGreaterThan(0);
      const actual = await collect(streamOf(encoder.encode(source), 65_536), selectors);
      expect(actual.map((member) => member.path)).toEqual(expected.map((entry) => entry.path));
      expect(actual.map((member) => JSON.parse(member.raw) as Json)).toEqual(
        expected.map((entry) => entry.value),
      );
    }, 60_000);

    it('gives the same members for 1-byte and 4093-byte chunks', async () => {
      const bytes = encoder.encode(text(true));
      const whole = await collect(streamOf(bytes, bytes.length), selectors);
      expect(whole.length).toBeGreaterThan(0);
      expect(await collect(streamOf(bytes, 4093), selectors)).toEqual(whole);
      expect(await collect(streamOf(bytes, 1), selectors)).toEqual(whole);
    }, 60_000);

    it('throws when truncated at every 997th byte', async () => {
      const bytes = encoder.encode(text(true));
      let cuts = 0;
      for (let cut = 997; cut < bytes.length; cut += 997) {
        cuts += 1;
        const error = await failure(collect(streamOf(bytes.subarray(0, cut), 4093), selectors));
        expect(error, `cut at ${cut}`).toBeInstanceOf(JsonStreamError);
      }
      expect(cuts).toBeGreaterThan(10);
    }, 120_000);
  });

  describe('memory', () => {
    const MiB = 1024 * 1024;
    v8.setFlagsFromString('--expose-gc');
    const collectGarbage = vm.runInNewContext('gc') as () => void;
    let calls = 0;
    async function warmUp(): Promise<void> {
      const doc = encoder.encode(JSON.stringify(npmPackument(30, 200)));
      for (let round = 0; round < 3; round += 1) {
        await collect(streamOf(doc, 4096), NPM);
      }
      collectGarbage();
    }

    const used = (): number => {
      calls += 1;
      if (calls % 16 === 0) {
        collectGarbage();
      }
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    };

    async function measure(
      parts: Iterator<Uint8Array>,
      selectors: readonly MemberSelector[],
      limits?: ExtractLimits,
      gcEvery = 1,
    ): Promise<{
      peak: number;
      pulled: number;
      biggest: number;
      members: number;
      error: unknown;
    }> {
      await warmUp();
      const baseline = used();
      let peak = 0;
      let pulled = 0;
      let samples = 0;
      const sample = (): void => {
        samples += 1;
        if (samples % gcEvery === 0) {
          collectGarbage();
          peak = Math.max(peak, used() - baseline);
        }
      };
      async function* counting(): AsyncGenerator<Uint8Array> {
        for (;;) {
          sample();
          const next = parts.next();
          if (next.done) {
            return;
          }
          pulled += next.value.length;
          yield next.value;
        }
      }
      let biggest = 0;
      let members = 0;
      const error = await failure(
        (async () => {
          for await (const member of extractMembers(counting(), selectors, limits)) {
            sample();
            members += 1;
            biggest = Math.max(biggest, member.raw.length);
          }
        })(),
      );
      sample();
      return { peak, pulled, biggest, members, error };
    }

    function* split(bytes: Uint8Array, size: number): Generator<Uint8Array> {
      for (let at = 0; at < bytes.length; at += size) {
        yield bytes.subarray(at, at + size);
      }
    }

    it('stays within 2 MiB of the largest member while counting a 10+ MiB stream', async () => {
      const largest = 600 * 1024;
      const big = encoder.encode(`"big":{"description":"${'d'.repeat(largest)}"},`);
      function* parts(): Generator<Uint8Array> {
        yield encoder.encode('{"name":"big","versions":{');
        for (let index = 0; index < 2800; index += 1) {
          yield encoder.encode(`"k${index}":${JSON.stringify(version(index, 3500))},`);
          if (index === 1400) {
            yield* split(big, 65_536);
          }
        }
        yield encoder.encode('"last":{}},"readme":"');
        const filler = encoder.encode('r'.repeat(65_536));
        for (let index = 0; index < 48; index += 1) {
          yield filler;
        }
        yield encoder.encode('"}');
      }
      const result = await measure(parts(), [['versions', '*']], undefined, 4);
      expect(result.members).toBe(2802);
      expect(result.pulled).toBeGreaterThan(10 * MiB);
      expect(result.biggest).toBeGreaterThan(largest);
      expect(result.peak).toBeLessThan(result.biggest + 2 * MiB);
    }, 120_000);

    it('stays near the member size for a 1 MiB member in 4-byte and 64-byte chunks', async () => {
      const member = encoder.encode(`{"time":"${'m'.repeat(1024 * 1024 - 20)}"}`);
      for (const size of [4, 64]) {
        const result = await measure(split(member, size), [['time']], undefined, 4096);
        expect(result.members).toBe(1);
        expect(result.peak).toBeLessThan(result.biggest + 2 * MiB);
      }
    }, 120_000);

    it('keeps a 1 MiB lone-surrogate member within member + 2 MiB', async () => {
      const lone = '\\ud800'.repeat(Math.floor((1024 * 1024 - 20) / 6));
      const member = encoder.encode(`{"time":"${lone}"}`);
      const result = await measure(split(member, 65_536), [['time']]);
      expect(result.members).toBe(1);
      expect(result.peak).toBeLessThan(result.biggest + 2 * MiB);
    }, 120_000);

    it('refuses millions of tiny members with the per-level cap and bounded memory', async () => {
      let produced = 0;
      function* parts(): Generator<Uint8Array> {
        yield encoder.encode('{"versions":{');
        for (let index = 0; index < 3_000_000; index += 1) {
          produced += 1;
          yield encoder.encode(`"${index}":1,`);
        }
      }
      const result = await measure(parts(), [['versions', '*']], undefined, 1000);
      expect(result.error).toBeInstanceOf(JsonExtractError);
      expect((result.error as JsonExtractError).code).toBe('too_many_members');
      expect(produced).toBeLessThan(450_000);
      expect(result.peak).toBeLessThan(2 * MiB + 48 * 400_000);
    }, 120_000);

    it('holds a captured member with 100k keys within member + 2 MiB + 48 B per key', async () => {
      function* parts(): Generator<Uint8Array> {
        yield encoder.encode('{"time":{');
        for (let base = 0; base < 100_000; base += 2000) {
          let text = '';
          for (let index = base; index < base + 2000; index += 1) {
            text += `"k${index}":1,`;
          }
          yield encoder.encode(text);
        }
        yield encoder.encode('"last":1}}');
      }
      const result = await measure(parts(), [['time']], { maxMemberBytes: 4 * MiB }, 20);
      expect(result.error).toBeNull();
      expect(result.members).toBe(1);
      expect(result.peak).toBeLessThan(result.biggest + 2 * MiB + 48 * 100_001);
    }, 120_000);

    it('holds a 100k-entry provider-include document within 2 MiB + 48 B per entry', async () => {
      const hash = 'f'.repeat(64);
      function* parts(): Generator<Uint8Array> {
        yield encoder.encode('{"providers":{');
        for (let base = 0; base < 100_000; base += 100) {
          let text = '';
          for (let index = base; index < base + 100; index += 1) {
            text += `"vendor/pkg-${index}":{"sha256":"${hash}"},`;
          }
          yield encoder.encode(text);
        }
        yield encoder.encode('"vendor/last":{}}}');
      }
      const result = await measure(parts(), [['providers', '*']], undefined, 2000);
      expect(result.error).toBeNull();
      expect(result.members).toBe(100_001);
      expect(result.peak).toBeLessThan(result.biggest + 2 * MiB + 48 * 100_001);
    }, 120_000);
  });

  describe('shape and matching', () => {
    const run = (json: string, selectors: MemberSelector[], limits?: ExtractLimits) =>
      collect(streamOf(encoder.encode(json), 3), selectors, limits);

    it('yields scalars, containers and nested paths in document order, trimmed', async () => {
      const members = await run(
        ' { "name" : "n" , "skip": [1,{"a":2}], "a": { "b" : { "c" : [1, 2] } , "d":null}, "t" : true } ',
        [['name'], ['a', 'b'], ['t']],
      );
      expect(members).toEqual([
        { path: ['name'], raw: '"n"' },
        { path: ['a', 'b'], raw: '{ "c" : [1, 2] }' },
        { path: ['t'], raw: 'true' },
      ]);
    });

    it('matches keys written with escapes', async () => {
      const members = await run('{"dist\\u002dtags":{"latest":"1"},"\\u0076ersions":{"1":{}}}', [
        ['dist-tags'],
        ['versions', '*'],
      ]);
      expect(members.map((member) => member.path)).toEqual([['dist-tags'], ['versions', '1']]);
    });

    it('does not descend into arrays or scalars on a selector prefix', async () => {
      expect(await run('{"versions":[{"1":{}},[1]],"time":{}}', NPM)).toEqual([
        { path: ['time'], raw: '{}' },
      ]);
      expect(await run('{"versions":null,"time":3}', NPM)).toEqual([{ path: ['time'], raw: '3' }]);
    });

    it('returns the raw text of a member with lone surrogate escapes unchanged', async () => {
      const lone = '\\ud800'.repeat(100_000);
      const members = await run(`{"time":"${lone}"}`, [['time']], { maxMemberBytes: 700_000 });
      expect(members).toEqual([{ path: ['time'], raw: `"${lone}"` }]);
    });

    it('handles a selected __proto__ key as plain data', async () => {
      const members = await run('{"__proto__":{"polluted":true},"time":{}}', [
        ['__proto__'],
        ['time'],
      ]);
      expect(members.map((member) => member.path)).toEqual([['__proto__'], ['time']]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('keeps document order for integer-like keys', async () => {
      const members = await run('{"b":{},"2":{},"1":{},"a":{}}', [['*']]);
      expect(members.map((member) => member.path[0])).toEqual(['b', '2', '1', 'a']);
    });

    it('stops reading the source when the consumer stops', async () => {
      let cancelled = false;
      let pulls = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(encoder.encode(pulls === 1 ? '{"a":1,' : `"k${pulls}":2,`));
        },
        cancel() {
          cancelled = true;
        },
      });
      for await (const member of extractMembers(source, [['a']])) {
        expect(member.path).toEqual(['a']);
        break;
      }
      expect(cancelled).toBe(true);
    });
  });

  describe('negative cases', () => {
    const run = (json: string, selectors: MemberSelector[], limits?: ExtractLimits) =>
      failure(collect(streamOf(encoder.encode(json), 5), selectors, limits));
    const codeOf = async (error: Promise<unknown>): Promise<string | null> => {
      const caught = await error;
      return caught instanceof JsonExtractError || caught instanceof JsonStreamError
        ? caught.code
        : null;
    };

    it('throws on a duplicated selected key at any selected level', async () => {
      expect(await codeOf(run('{"time":{},"time":{}}', [['time']]))).toBe('duplicate_key');
      expect(await codeOf(run('{"versions":{"1":{}},"versions":{}}', NPM))).toBe('duplicate_key');
      expect(await codeOf(run('{"versions":{"1":{},"1":{}}}', NPM))).toBe('duplicate_key');
      expect(await codeOf(run('{"dist\\u002dtags":{},"dist-tags":{}}', NPM))).toBe('duplicate_key');
      expect(await run('{"x":1,"x":2,"time":{"a":1}}', NPM)).toBeNull();
    });

    it('enforces the member limit at its boundary', async () => {
      const json = `{"time":"${'a'.repeat(50)}"}`;
      const exact = ` :"${'a'.repeat(50)}"`.length - 1;
      expect(await run(json, [['time']], { maxMemberBytes: exact + 1 })).toBeNull();
      expect(await codeOf(run(json, [['time']], { maxMemberBytes: 10 }))).toBe('member_too_large');
      expect(
        await codeOf(
          run(`{"time":{"a":"${'a'.repeat(2000)}"}}`, [['time']], {
            maxMemberBytes: 1024,
          }),
        ),
      ).toBe('member_too_large');
    });

    it('enforces the document limit even when no member is selected', async () => {
      const json = `{"skip":"${'a'.repeat(5000)}"}`;
      expect(await codeOf(run(json, [['time']], { maxDocumentBytes: 1024 }))).toBe(
        'document_too_large',
      );
      expect(await run(json, [['time']], { maxDocumentBytes: json.length })).toBeNull();
    });

    it('defaults to 1 MiB members and 32 MiB documents', async () => {
      const big = `{"time":"${'a'.repeat(1024 * 1024)}"}`;
      expect(await codeOf(run(big, [['time']]))).toBe('member_too_large');
    });

    it('rejects malformed input and non-object roots', async () => {
      expect(await codeOf(run('{"time":{"a":}}', [['time']]))).toBe('invalid_syntax');
      expect(await codeOf(run('{"time":{}} x', [['time']]))).toBe('trailing_garbage');
      expect(await codeOf(run('{"time":{}', [['time']]))).toBe('unterminated');
      expect(await codeOf(run('', [['time']]))).toBe('unterminated');
      expect(await codeOf(run('[{"time":1}]', [['time']]))).toBe('not_object');
      expect(await codeOf(run('"time"', [['time']]))).toBe('not_object');
      expect(await codeOf(run('{"time":"\\ud800\\u12"}', [['time']]))).toBe('invalid_syntax');
    });

    it('rejects invalid UTF-8 inside a skipped member', async () => {
      const bytes = new Uint8Array([...encoder.encode('{"skip":"'), 0xff, ...encoder.encode('"}')]);
      const error = await failure(collect(streamOf(bytes, 4), [['time']]));
      expect(error).toBeInstanceOf(JsonStreamError);
    });

    it('does not echo document content in error messages', async () => {
      const error = await run('{"time":"secret-token-value","time":1}', [['time']]);
      expect(String((error as Error).message)).not.toContain('secret-token-value');
    });

    it('refuses duplicate keys inside a captured member, at any depth', async () => {
      expect(await codeOf(run('{"time":{"a":1,"a":2}}', [['time']]))).toBe('duplicate_key');
      expect(await codeOf(run('{"time":[{"x":{"b":1,"\\u0062":2}}]}', [['time']]))).toBe(
        'duplicate_key',
      );
      expect(
        await run('{"time":{"a":{"b":1},"c":{"b":2},"d":[{"b":1},{"b":2}]}}', [['time']]),
      ).toBeNull();
    });

    it('caps the members tracked per level', async () => {
      const many = (n: number): string =>
        `{"versions":{${Array.from({ length: n }, (_, index) => `"${index}":1`).join(',')}}}`;
      expect(await run(many(5), NPM, { maxMembersPerLevel: 5 })).toBeNull();
      expect(await codeOf(run(many(6), NPM, { maxMembersPerLevel: 5 }))).toBe('too_many_members');
      const inner = `{"time":{${Array.from({ length: 6 }, (_, index) => `"${index}":1`).join(',')}}}`;
      expect(await codeOf(run(inner, [['time']], { maxMembersPerLevel: 5 }))).toBe(
        'too_many_members',
      );
    });

    it('validates limits and selectors when extractMembers is called', () => {
      const source = streamOf(encoder.encode('{}'), 2);
      expect(() => extractMembers(source, [])).toThrow(TypeError);
      expect(() => extractMembers(source, NPM, { maxMemberBytes: 0 })).toThrow(RangeError);
    });

    it('keeps the tokenizer code for an oversize number inside a captured member', async () => {
      const error = await run(`{"time":[${'1'.repeat(2000)}]}`, [['time']]);
      expect(error).toBeInstanceOf(JsonStreamError);
      expect((error as JsonStreamError).code).toBe('token_too_large');
    });

    it('rejects invalid limits and overlapping or empty selectors up front', async () => {
      for (const limits of [
        { maxMemberBytes: 0 },
        { maxMemberBytes: 1.5 },
        { maxDocumentBytes: Number.POSITIVE_INFINITY },
        { maxMembersPerLevel: -1 },
        { maxMembersPerLevel: Number.NaN },
      ]) {
        expect(await run('{}', NPM, limits)).toBeInstanceOf(RangeError);
      }
      for (const selectors of [
        [['a'], ['a']],
        [['a'], ['a', 'b']],
        [
          ['a', '*'],
          ['a', 'b'],
        ],
        [['*'], ['a', 'b']],
        [[]],
        [],
      ]) {
        expect(await run('{}', selectors)).toBeInstanceOf(TypeError);
      }
    });

    it('applies the 64 KiB key limit to keys but not to captured string values', async () => {
      const longKey = 'k'.repeat(70_000);
      expect(await codeOf(run(`{"${longKey}":1}`, [['time']]))).toBe('token_too_large');
      expect(await codeOf(run(`{"time":{"${longKey}":1}}`, [['time']]))).toBe('member_too_large');
      const members = await collect(
        streamOf(encoder.encode(`{"time":"${'v'.repeat(70_000)}"}`), 4096),
        [['time']],
      );
      expect(members).toHaveLength(1);
    });

    it('reports the offset of the first byte past the document limit', async () => {
      const error = await run(`{"a":"${'a'.repeat(100)}"}`, [['time']], { maxDocumentBytes: 50 });
      expect((error as JsonExtractError).offset).toBe(50);
    });

    it('rejects nesting deeper than 64 inside a captured member', async () => {
      const deep = `{"time":${'['.repeat(65)}${']'.repeat(65)}}`;
      expect(await codeOf(run(deep, [['time']]))).toBe('depth_exceeded');
    });
  });
});
