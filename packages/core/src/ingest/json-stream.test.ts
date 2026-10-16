import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { JsonStreamError } from './json-tokenizer.js';
import {
  ARRAY_ELEMENTS,
  extractMembers,
  JsonExtractError,
  type ExtractLimits,
  type ExtractOptions,
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

describe('extractMembers array elements', () => {
  const PACKAGES: MemberSelector[] = [['packages', '*', ARRAY_ELEMENTS], ['minified']];

  interface Expected {
    path: string[];
    value: Json;
    index?: number;
    end?: true;
    count?: number;
  }

  function elementReference(doc: Json, selectors: readonly MemberSelector[]): Expected[] {
    const plain = selectors.filter((selector) => selector.at(-1) !== ARRAY_ELEMENTS);
    const arrays = selectors
      .filter((selector) => selector.at(-1) === ARRAY_ELEMENTS)
      .map((selector) => selector.slice(0, -1));
    const out: Expected[] = [];
    const walk = (node: Json, path: string[]): void => {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        const next = [...path, key];
        if (plain.some((selector) => matches(selector, next, true))) {
          out.push({ path: next, value });
        } else if (arrays.some((selector) => matches(selector, next, true))) {
          if (!Array.isArray(value)) {
            throw new Error('fixture must hold arrays at element paths');
          }
          value.forEach((element, index) => {
            out.push({ path: [...next, String(index)], value: element, index });
          });
          out.push({ path: next, value: [], end: true, count: value.length });
        } else if ([...plain, ...arrays].some((selector) => matches(selector, next, false))) {
          walk(value, next);
        }
      }
    };
    walk(doc, []);
    return out;
  }

  const shape = (members: ExtractedMember[]): Expected[] =>
    members.map((member) => ({
      path: [...member.path],
      value: JSON.parse(member.raw) as Json,
      ...(member.index === undefined ? {} : { index: member.index }),
      ...(member.end === true ? { end: true as const, count: member.count } : {}),
    }));

  function p2Document(count: number, pad: number): Json {
    return {
      packages: {
        'acme/a': Array.from({ length: count }, (_, index) => version(index, pad)),
        'ünï"cödé\\key': [1, 's', null, true, -0.5, [1, [2, []]], { a: [], '[]': {} }, []],
        empty: [],
        'acme/b': [[], [[]], {}, 'tail'],
      },
      other: { packages: { x: [1] } },
      minified: 'composer/2.0',
    };
  }

  const documents = [
    { name: 'minified', text: JSON.stringify(p2Document(40, 100)) },
    { name: 'pretty', text: JSON.stringify(p2Document(40, 100), null, 2) },
    {
      name: 'escaped keys',
      text: '{"pack\\u0061ges":{"\\u0061cme/\\"q\\"":[ {"k\\u00e9":"v"} , "\\ud83d\\ude00" ,1e3 ],"z":[]}}',
    },
  ];

  it.each(documents)(
    'equals a JSON.parse reference for $name in 1, 7 and 4093-byte chunks',
    async ({ text }) => {
      const bytes = encoder.encode(text);
      const expected = elementReference(JSON.parse(text) as Json, PACKAGES);
      expect(expected.filter((entry) => entry.end === true).length).toBeGreaterThan(0);
      for (const size of [1, 7, 4093]) {
        const actual = await collect(streamOf(bytes, size), PACKAGES);
        expect(shape(actual), `chunk ${size}`).toEqual(expected);
        for (const member of actual) {
          expect(member.raw).toBe(member.raw.trim());
          expect(member.raw.startsWith(',')).toBe(false);
        }
      }
    },
    60_000,
  );

  it('yields the element path, index and an end record carrying the count', async () => {
    const members = await collect(
      streamOf(encoder.encode('{"packages":{"acme/a":[ {"v":1} , 2 ],"acme/e":[]}}'), 3),
      [['packages', '*', ARRAY_ELEMENTS]],
    );
    expect(members).toEqual([
      { path: ['packages', 'acme/a', '0'], raw: '{"v":1}', index: 0 },
      { path: ['packages', 'acme/a', '1'], raw: '2', index: 1 },
      { path: ['packages', 'acme/a'], raw: '[]', end: true, count: 2 },
      { path: ['packages', 'acme/e'], raw: '[]', end: true, count: 0 },
    ]);
  });

  it('does not match an object key spelled [] with ARRAY_ELEMENTS', async () => {
    const json = '{"a":{"[]":[1,2],"b":[3]}}';
    const literal = await failure(
      collect(streamOf(encoder.encode('{"a":{"[]":1}}'), 2), [['a', ARRAY_ELEMENTS]]),
    );
    expect((literal as JsonExtractError).code).toBe('not_array');
    const members = await collect(streamOf(encoder.encode(json), 2), [['a', '*', ARRAY_ELEMENTS]]);
    expect(members.map((member) => member.path)).toEqual([
      ['a', '[]', '0'],
      ['a', '[]', '1'],
      ['a', '[]'],
      ['a', 'b', '0'],
      ['a', 'b'],
    ]);
  });

  it('never lets * match array elements', async () => {
    expect(
      await collect(streamOf(encoder.encode('{"packages":{"a":[{"x":1}]}}'), 4), [
        ['packages', '*', '*'],
      ]),
    ).toEqual([]);
  });

  it('retains one version, not the array, across a 2,000-version document', async () => {
    const doc = p2Document(2000, 200) as { packages: Record<string, Json[]> };
    const largest = Math.max(
      ...Object.values(doc.packages).flatMap((list) =>
        list.map((element) => encoder.encode(JSON.stringify(element)).length),
      ),
    );
    const bytes = encoder.encode(JSON.stringify(doc));
    expect(bytes.length).toBeGreaterThan(400 * largest);
    const limits = { maxMemberBytes: largest + 1 };
    const members = await collect(streamOf(bytes, 65_536), PACKAGES, limits);
    expect(
      members.filter((member) => member.path[1] === 'acme/a' && member.end !== true),
    ).toHaveLength(2000);
    const error = await failure(
      collect(streamOf(bytes, 65_536), [['packages', '*'], ['minified']], limits),
    );
    expect((error as JsonExtractError).code).toBe('member_too_large');
  }, 60_000);

  describe('negative cases', () => {
    const run = (json: string, selectors: MemberSelector[], limits?: ExtractLimits) =>
      failure(collect(streamOf(encoder.encode(json), 5), selectors, limits));
    const codeOf = async (error: Promise<unknown>): Promise<string | null> => {
      const caught = await error;
      return caught instanceof JsonExtractError || caught instanceof JsonStreamError
        ? caught.code
        : null;
    };

    it('throws member_too_large for an element over maxMemberBytes', async () => {
      const json = `{"packages":{"a":[1,"${'x'.repeat(200)}",2]}}`;
      expect(await run(json, PACKAGES, { maxMemberBytes: 210 })).toBeNull();
      expect(await codeOf(run(json, PACKAGES, { maxMemberBytes: 100 }))).toBe('member_too_large');
      const nested = `{"packages":{"a":[{"k":"${'x'.repeat(200)}"}]}}`;
      expect(await codeOf(run(nested, PACKAGES, { maxMemberBytes: 100 }))).toBe('member_too_large');
    });

    it('throws too_many_members for more elements than maxMembersPerLevel', async () => {
      const many = (n: number): string =>
        `{"packages":{"a":[${Array.from({ length: n }, (_, index) => `${index}`).join(',')}]}}`;
      expect(await run(many(5), PACKAGES, { maxMembersPerLevel: 5 })).toBeNull();
      expect(await codeOf(run(many(6), PACKAGES, { maxMembersPerLevel: 5 }))).toBe(
        'too_many_members',
      );
    });

    it('throws not_array for a non-array at the element path', async () => {
      for (const value of ['{}', '{"0":1}', '"s"', '1', 'null', 'true']) {
        expect(await codeOf(run(`{"packages":{"a":${value}}}`, PACKAGES)), value).toBe('not_array');
      }
    });

    it('throws duplicate_key for a duplicate key inside one element', async () => {
      expect(await codeOf(run('{"packages":{"a":[{"v":1,"\\u0076":2}]}}', PACKAGES))).toBe(
        'duplicate_key',
      );
      expect(await run('{"packages":{"a":[{"v":1},{"v":2}]}}', PACKAGES)).toBeNull();
    });

    it('throws duplicate_key for a duplicated array key', async () => {
      expect(await codeOf(run('{"packages":{"a":[],"a":[]}}', PACKAGES))).toBe('duplicate_key');
    });

    it('throws TypeError when ARRAY_ELEMENTS is not last or appears twice', () => {
      const source = streamOf(encoder.encode('{}'), 2);
      expect(() => extractMembers(source, [['packages', ARRAY_ELEMENTS, 'x']])).toThrow(TypeError);
      expect(() => extractMembers(source, [['a', ARRAY_ELEMENTS, ARRAY_ELEMENTS]])).toThrow(
        TypeError,
      );
      expect(() => extractMembers(source, [[ARRAY_ELEMENTS]])).toThrow(TypeError);
    });

    it('throws TypeError for overlap with the whole-member selector', () => {
      const source = streamOf(encoder.encode('{}'), 2);
      expect(() =>
        extractMembers(source, [
          ['packages', '*'],
          ['packages', '*', ARRAY_ELEMENTS],
        ]),
      ).toThrow(TypeError);
      expect(() =>
        extractMembers(source, [
          ['packages', 'a', 'b'],
          ['packages', 'a', ARRAY_ELEMENTS],
        ]),
      ).toThrow(TypeError);
    });
  });
});

describe('extractMembers array element boundaries and non-arrays', () => {
  const PACKAGES: MemberSelector[] = [['packages', '*', ARRAY_ELEMENTS]];
  const all = (json: string, size: number, limits?: ExtractOptions) =>
    collect(streamOf(encoder.encode(json), size), PACKAGES, limits);

  it('does not count separators or whitespace towards maxMemberBytes', async () => {
    for (const size of [1, 3, 4093]) {
      const members = await all('{"packages":{"a":[12345,12345]}}', size, { maxMemberBytes: 5 });
      expect(members.map((member) => member.raw)).toEqual(['12345', '12345', '[]']);
      const error = await failure(
        all('{"packages":{"a":[12345,12345]}}', size, { maxMemberBytes: 4 }),
      );
      expect((error as JsonExtractError).code).toBe('member_too_large');
    }
  });

  it('ignores padding before an element and before the closing bracket', async () => {
    const pad = ' \n\t'.repeat(400);
    const json = `{"packages":{"a":[${pad}1${pad},${pad}"x"${pad}]}}`;
    for (const size of [1, 7, 4093]) {
      const members = await all(json, size, { maxMemberBytes: 3 });
      expect(members).toEqual([
        { path: ['packages', 'a', '0'], raw: '1', index: 0 },
        { path: ['packages', 'a', '1'], raw: '"x"', index: 1 },
        { path: ['packages', 'a'], raw: '[]', end: true, count: 2 },
      ]);
    }
  });

  it('names the offending path on not_array', async () => {
    const error = await failure(all('{"packages":{"a":[],"b":{}}}', 3));
    expect((error as JsonExtractError).code).toBe('not_array');
    expect((error as JsonExtractError).path).toEqual(['packages', 'b']);
    expect((error as JsonExtractError).message).not.toContain('packages');
  });

  it('reports a non-array without retaining it when nonArray is report', async () => {
    const long = 'x'.repeat(2 * 1024 * 1024);
    const json = `{"packages":{"a":{"x":["y",{"z":1}]},"b":[1],"c":"${long}","d":[],"e":null}}`;
    for (const size of [1, 7, 4093]) {
      const text = size === 4093 ? json : json.replace(long, 'x'.repeat(5000));
      expect(await all(text, size, { nonArray: 'report', maxMemberBytes: 3 })).toEqual([
        { path: ['packages', 'a'], raw: '', notArray: true },
        { path: ['packages', 'b', '0'], raw: '1', index: 0 },
        { path: ['packages', 'b'], raw: '[]', end: true, count: 1 },
        { path: ['packages', 'c'], raw: '', notArray: true },
        { path: ['packages', 'd'], raw: '[]', end: true, count: 0 },
        { path: ['packages', 'e'], raw: '', notArray: true },
      ]);
    }
  }, 60_000);

  it('does not count whitespace between the key and [ towards maxMemberBytes', async () => {
    const json = `{"packages":{"a":${' '.repeat(30)}[1]}}`;
    for (const nonArray of ['throw', 'report'] as const) {
      expect(await all(json, 1, { nonArray, maxMemberBytes: 3 })).toEqual([
        { path: ['packages', 'a', '0'], raw: '1', index: 0 },
        { path: ['packages', 'a'], raw: '[]', end: true, count: 1 },
      ]);
    }
  });

  it('rejects an unknown nonArray mode at call time', () => {
    const source = streamOf(encoder.encode('{}'), 2);
    expect(() =>
      extractMembers(source, PACKAGES, { nonArray: 'skip' as unknown as 'throw' }),
    ).toThrow(TypeError);
  });
});
