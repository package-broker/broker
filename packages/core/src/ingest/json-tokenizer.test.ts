import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { reportableErrorName } from '../kernel/error-name.js';
import {
  JsonStreamError,
  JsonTokenizer,
  type JsonStreamErrorCode,
  type JsonToken,
  type JsonTokenizerOptions,
} from './json-tokenizer.js';

const encoder = new TextEncoder();

type Hook = (token: JsonToken, tokenizer: JsonTokenizer) => void;

function feed(
  bytes: Uint8Array,
  sizeOf: () => number,
  options?: JsonTokenizerOptions,
  hook?: Hook,
): JsonToken[] {
  const tokenizer = new JsonTokenizer(options);
  const tokens: JsonToken[] = [];
  const sink = (token: JsonToken): void => {
    tokens.push(token);
    hook?.(token, tokenizer);
  };
  for (let at = 0; at < bytes.length;) {
    const size = sizeOf();
    tokenizer.write(bytes.subarray(at, at + size), sink);
    at += size;
  }
  tokenizer.end(sink);
  return tokens;
}

function tokenize(
  bytes: Uint8Array,
  chunkSize: number,
  options?: JsonTokenizerOptions,
  hook?: Hook,
): JsonToken[] {
  return feed(bytes, () => chunkSize, options, hook);
}

function codeOf(
  bytes: Uint8Array,
  chunkSize: number,
  options?: JsonTokenizerOptions,
): JsonStreamErrorCode | null {
  try {
    tokenize(bytes, chunkSize, options);
  } catch (error) {
    if (error instanceof JsonStreamError) {
      return error.code;
    }
    throw error;
  }
  return null;
}

interface Written {
  text: string;
  tokens: JsonToken[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type StringForm = 'plain' | 'escaped';

function writeReference(root: Json, pretty: boolean, form: StringForm): Written {
  let text = '';
  let bytes = 0;
  const tokens: JsonToken[] = [];
  const append = (piece: string): void => {
    text += piece;
    bytes += encoder.encode(piece).length;
  };
  const lexeme = (value: string): string => {
    const quoted = JSON.stringify(value);
    return form === 'plain'
      ? quoted
      : quoted.replace(
          /[\u0080-￿]/gu,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
  };
  const token = (piece: string, make: (start: number, end: number) => JsonToken): void => {
    const start = bytes;
    append(piece);
    tokens.push(make(start, bytes));
  };
  const indent = (depth: number): void => {
    if (pretty) {
      append(`\n${'  '.repeat(depth)}`);
    }
  };
  const emit = (value: Json, depth: number): void => {
    if (value === null) {
      token('null', (start, end) => ({ type: 'null', start, end }));
    } else if (typeof value === 'boolean') {
      token(String(value), (start, end) => ({ type: value ? 'true' : 'false', start, end }));
    } else if (typeof value === 'number') {
      const raw = String(value);
      token(raw, (start, end) => ({ type: 'number', raw, start, end }));
    } else if (typeof value === 'string') {
      token(lexeme(value), (start, end) => ({ type: 'string', value, start, end }));
    } else if (Array.isArray(value)) {
      token('[', (start, end) => ({ type: 'beginArray', start, end }));
      value.forEach((item, index) => {
        if (index > 0) {
          append(',');
        }
        indent(depth + 1);
        emit(item, depth + 1);
      });
      if (value.length > 0) {
        indent(depth);
      }
      token(']', (start, end) => ({ type: 'endArray', start, end }));
    } else {
      token('{', (start, end) => ({ type: 'beginObject', start, end }));
      Object.entries(value).forEach(([key, item], index) => {
        if (index > 0) {
          append(',');
        }
        indent(depth + 1);
        token(lexeme(key), (start, end) => ({ type: 'key', value: key, start, end }));
        append(pretty ? ': ' : ':');
        emit(item, depth + 1);
      });
      if (Object.keys(value).length > 0) {
        indent(depth);
      }
      token('}', (start, end) => ({ type: 'endObject', start, end }));
    }
  };
  emit(root, 0);
  return { text, tokens };
}

function packument(versions: number): Json {
  const entries: Record<string, Json> = {};
  for (let index = 0; index < versions; index += 1) {
    const version = `1.${index % 17}.${index}`;
    entries[version] = {
      name: 'example-pkg',
      version,
      description: `Ünïcödé \u{1f600} "quoted" back\\slash tab\t line\n ${'x'.repeat(index % 40)}`,
      dependencies: { left: `^${index}.0.0`, 'right-é': '~2.1.0' },
      engines: { node: '>=18' },
      deprecated: index % 7 === 0 ? 'old 😀' : false,
      size: [index, -index, index / 8, 1.5e-7, 2e21, 0, -0.25],
      dist: {
        shasum: 'a'.repeat(40),
        tarball: `https://registry.example.test/example-pkg/-/example-pkg-${version}.tgz`,
        fileCount: null,
      },
    };
  }
  return {
    name: 'example-pkg',
    'dist-tags': { latest: '1.0.0' },
    time: { created: '2020-01-01T00:00:00.000Z' },
    versions: entries,
    empty: [{}, []],
  };
}

describe('JsonTokenizer', () => {
  it('emits tokens with byte offsets for a small document', () => {
    const tokens = tokenize(encoder.encode('{"a":[1,true,null],"b":"é"}'), 1000);
    expect(tokens).toEqual([
      { type: 'beginObject', start: 0, end: 1 },
      { type: 'key', value: 'a', start: 1, end: 4 },
      { type: 'beginArray', start: 5, end: 6 },
      { type: 'number', raw: '1', start: 6, end: 7 },
      { type: 'true', start: 8, end: 12 },
      { type: 'null', start: 13, end: 17 },
      { type: 'endArray', start: 17, end: 18 },
      { type: 'key', value: 'b', start: 19, end: 22 },
      { type: 'string', value: 'é', start: 23, end: 27 },
      { type: 'endObject', start: 27, end: 28 },
    ]);
  });

  it('accepts top-level scalars and surrounding whitespace', () => {
    expect(tokenize(encoder.encode(' \n-12.5e+3\t'), 1)).toEqual([
      { type: 'number', raw: '-12.5e+3', start: 2, end: 10 },
    ]);
    expect(tokenize(encoder.encode('"x"'), 1)).toEqual([
      { type: 'string', value: 'x', start: 0, end: 3 },
    ]);
    expect(tokenize(encoder.encode('false'), 1)).toEqual([{ type: 'false', start: 0, end: 5 }]);
  });

  it('decodes escapes and surrogate pairs, raw or escaped', () => {
    const text = '["\\ud83d\\ude00","\u{1f600}","\\n\\t\\"\\\\\\/\\b\\f\\r\\u0041","\\ud800"]';
    const values = tokenize(encoder.encode(text), 1).flatMap((token) =>
      token.type === 'string' ? [token.value] : [],
    );
    expect(values).toEqual(['\u{1f600}', '\u{1f600}', '\n\t"\\/\b\f\rA', '\ud800']);
  });

  for (const [name, pretty, form] of [
    ['compact', false, 'plain'],
    ['pretty', true, 'plain'],
    ['escaped', false, 'escaped'],
  ] as const) {
    it(`matches the reference tokenization for a ${name} packument at 4093-byte and 1-byte chunks`, () => {
      const reference = writeReference(packument(120), pretty, form);
      const bytes = encoder.encode(reference.text);
      expect(reference.tokens.length).toBeGreaterThan(5000);
      expect(tokenize(bytes, 4093)).toEqual(reference.tokens);
      expect(tokenize(bytes, 1)).toEqual(reference.tokens);
    });
  }

  it('accepts depth 64 and rejects depth 65', () => {
    expect(codeOf(encoder.encode('['.repeat(64) + ']'.repeat(64)), 7)).toBeNull();
    expect(codeOf(encoder.encode('['.repeat(65) + ']'.repeat(65)), 7)).toBe('depth_exceeded');
    expect(codeOf(encoder.encode('{"a":'.repeat(65)), 1)).toBe('depth_exceeded');
  });

  const malformed: [string, Uint8Array, JsonStreamErrorCode][] = [
    ['lone continuation byte', Uint8Array.of(0x22, 0xff, 0x22), 'invalid_utf8'],
    ['overlong encoding', Uint8Array.of(0x22, 0xc0, 0x80, 0x22), 'invalid_utf8'],
    ['truncated multi-byte character', Uint8Array.of(0x22, 0xe2, 0x82, 0x22), 'invalid_utf8'],
    ['encoded surrogate', Uint8Array.of(0x22, 0xed, 0xa0, 0x80, 0x22), 'invalid_utf8'],
    ['unterminated string', encoder.encode('["abc'), 'unterminated'],
    ['unterminated escape', encoder.encode('"a\\'), 'unterminated'],
    ['unterminated object', encoder.encode('{"a":1'), 'unterminated'],
    ['unterminated array', encoder.encode('[1,2'), 'unterminated'],
    ['invalid byte outside a string', Uint8Array.of(0x5b, 0xff, 0x5d), 'invalid_utf8'],
    ['continuation byte outside a string', Uint8Array.of(0x80), 'invalid_utf8'],
    ['byte order mark', Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d), 'invalid_syntax'],
    ['truncated literal at end', encoder.encode('tru'), 'unterminated'],
    ['truncated literal in array', encoder.encode('[nul'), 'unterminated'],
    ['bare minus at end', encoder.encode('-'), 'unterminated'],
    ['dangling fraction at end', encoder.encode('1.'), 'unterminated'],
    ['dangling exponent at end', encoder.encode('1e+'), 'unterminated'],
    ['leading zero at end', encoder.encode('01'), 'invalid_syntax'],
    ['empty input', new Uint8Array(0), 'unterminated'],
    ['whitespace only', encoder.encode('  \n'), 'unterminated'],
    ['trailing token', encoder.encode('{} x'), 'trailing_garbage'],
    ['two documents', encoder.encode('{}{}'), 'trailing_garbage'],
    ['two scalars', encoder.encode('1 2'), 'trailing_garbage'],
    ['extra closer', encoder.encode('[]]'), 'trailing_garbage'],
    ['missing colon', encoder.encode('{"a" 1}'), 'invalid_syntax'],
    ['trailing comma in array', encoder.encode('[1,]'), 'invalid_syntax'],
    ['trailing comma in object', encoder.encode('{"a":1,}'), 'invalid_syntax'],
    ['leading comma', encoder.encode('{,}'), 'invalid_syntax'],
    ['non-string key', encoder.encode('{1:2}'), 'invalid_syntax'],
    ['missing comma', encoder.encode('[1 2]'), 'invalid_syntax'],
    ['mismatched closer', encoder.encode('[}'), 'invalid_syntax'],
    ['leading zero', encoder.encode('[01]'), 'invalid_syntax'],
    ['bare minus', encoder.encode('[-]'), 'invalid_syntax'],
    ['dangling fraction', encoder.encode('[1.]'), 'invalid_syntax'],
    ['dangling exponent', encoder.encode('[1e]'), 'invalid_syntax'],
    ['plus sign', encoder.encode('[+1]'), 'invalid_syntax'],
    ['unknown literal', encoder.encode('[nul]'), 'invalid_syntax'],
    ['literal with suffix', encoder.encode('[truex]'), 'invalid_syntax'],
    ['bad escape', encoder.encode('"\\x"'), 'invalid_syntax'],
    ['bad unicode escape', encoder.encode('"\\u12G4"'), 'invalid_syntax'],
    ['raw control character', encoder.encode('"a\nb"'), 'invalid_syntax'],
    ['single quotes', encoder.encode("{'a':1}"), 'invalid_syntax'],
    ['leading colon', encoder.encode(':'), 'invalid_syntax'],
  ];

  for (const [name, bytes, code] of malformed) {
    it(`throws ${code} for ${name}`, () => {
      expect(codeOf(bytes, 1000)).toBe(code);
      expect(codeOf(bytes, 1)).toBe(code);
    });
  }

  it('throws token_too_large for a number beyond the scalar cap', () => {
    expect(codeOf(encoder.encode(`[${'1'.repeat(5000)}]`), 4093)).toBe('token_too_large');
    expect(codeOf(encoder.encode(`[${'1'.repeat(40)}]`), 1, { maxScalarBytes: 40 })).toBeNull();
    expect(codeOf(encoder.encode(`[${'1'.repeat(41)}]`), 1, { maxScalarBytes: 40 })).toBe(
      'token_too_large',
    );
  });

  it('bounds string and key size by decoded bytes', () => {
    const options = { maxStringBytes: 65536 };
    const text = (length: number): Uint8Array =>
      encoder.encode(`{"${'k'.repeat(length)}":"${'v'.repeat(length)}"}`);
    expect(codeOf(text(65536), 4093, options)).toBeNull();
    expect(codeOf(text(65537), 4093, options)).toBe('token_too_large');
    expect(codeOf(text(65537), 1, options)).toBe('token_too_large');
    expect(codeOf(encoder.encode(`"${'\\u00e9'.repeat(40000)}"`), 4093, options)).toBe(
      'token_too_large',
    );
    expect(codeOf(encoder.encode(`"${'\\n'.repeat(65537)}"`), 4093, options)).toBe(
      'token_too_large',
    );
  });

  it('applies a 1 MiB string cap by default', () => {
    expect(codeOf(encoder.encode(`"${'a'.repeat(1024 * 1024)}"`), 65536)).toBeNull();
    expect(codeOf(encoder.encode(`"${'a'.repeat(1024 * 1024 + 1)}"`), 65536)).toBe(
      'token_too_large',
    );
  });

  describe('skipNext', () => {
    const skipKey =
      (name: string): Hook =>
      (token, tokenizer) => {
        if (token.type === 'key' && token.value === name) {
          tokenizer.skipNext();
        }
      };

    it('discards a string value without buffering or counting it', () => {
      const text = encoder.encode(`{"big":"${'x'.repeat(100000)}","keep":1}`);
      for (const size of [4093, 1]) {
        const tokens = tokenize(text, size, { maxStringBytes: 16 }, skipKey('big'));
        expect(tokens.map((token) => token.type)).toEqual([
          'beginObject',
          'key',
          'key',
          'number',
          'endObject',
        ]);
      }
    });

    it('discards a whole container and resumes after it', () => {
      const text = encoder.encode('{"skip":{"a":[1,"x",{"b":"y"}],"c":null},"k":2,"n":[3]}');
      for (const size of [4093, 1]) {
        const tokens = tokenize(text, size, undefined, skipKey('skip'));
        expect(tokens.map((token) => (token.type === 'key' ? token.value : token.type))).toEqual([
          'beginObject',
          'skip',
          'k',
          'number',
          'n',
          'beginArray',
          'number',
          'endArray',
          'endObject',
        ]);
      }
    });

    it('skips a single array element', () => {
      let skipped = false;
      const hook: Hook = (token, tokenizer) => {
        if (token.type === 'beginArray' && !skipped) {
          skipped = true;
          tokenizer.skipNext();
        }
      };
      const tokens = tokenize(encoder.encode('["a",[1,2],3]'), 1, undefined, hook);
      expect(tokens.map((token) => token.type)).toEqual([
        'beginArray',
        'beginArray',
        'number',
        'number',
        'endArray',
        'number',
        'endArray',
      ]);
    });

    it('rejects a raw lead byte, an escape and a continuation byte in a discarded string', () => {
      const bytes = Uint8Array.of(...encoder.encode('{"a":"'), 0xc3, 0x5c, 0x6e, 0xa9, 0x22, 0x7d);
      for (const size of [1, 100]) {
        expect(() => tokenize(bytes, size, undefined, skipKey('a'))).toThrow(
          expect.objectContaining({ code: 'invalid_utf8' }),
        );
      }
    });

    it('ignores skipNext while already discarding', () => {
      const hook: Hook = (token, tokenizer) => {
        if (token.type === 'key' && token.value === 'a') {
          tokenizer.skipNext();
        }
      };
      const text = encoder.encode('{"a":[1],"b":2}');
      expect(tokenize(text, 1, undefined, hook).map((token) => token.type)).toEqual([
        'beginObject',
        'key',
        'key',
        'number',
        'endObject',
      ]);
    });

    it('still validates what it discards', () => {
      const hook = skipKey('a');
      const run = (bytes: Uint8Array): JsonStreamErrorCode | null => {
        try {
          tokenize(bytes, 1, undefined, hook);
        } catch (error) {
          return (error as JsonStreamError).code;
        }
        return null;
      };
      expect(run(Uint8Array.of(...encoder.encode('{"a":"'), 0xff, 0x22, 0x7d))).toBe(
        'invalid_utf8',
      );
      expect(run(Uint8Array.of(...encoder.encode('{"a":"'), 0xe2, 0x82, 0x22, 0x7d))).toBe(
        'invalid_utf8',
      );
      expect(run(encoder.encode('{"a":"\\x"}'))).toBe('invalid_syntax');
      expect(run(encoder.encode('{"a":[1,]}'))).toBe('invalid_syntax');
      expect(run(encoder.encode('{"a":{"b":1}'))).toBe('unterminated');
      expect(run(encoder.encode('{"a":' + '['.repeat(70) + '}'))).toBe('depth_exceeded');
    });
  });

  it('counts every lone surrogate escape against the string cap with bounded memory', () => {
    for (const escape of ['\\udc00', '\\ud800']) {
      const bytes = encoder.encode(`"${escape.repeat(2_000_000)}"`);
      const before = process.memoryUsage();
      expect(codeOf(bytes, 65536)).toBe('token_too_large');
      const after = process.memoryUsage();
      expect(
        after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers,
      ).toBeLessThan(48 * 1024 * 1024);
    }
  });

  it('keeps lone surrogates and pairs apart', () => {
    const text = '["\\ud800x","\\udc00\\ud800","\\ud800\\ud800\\udc00"]';
    const values = tokenize(encoder.encode(text), 1).flatMap((token) =>
      token.type === 'string' ? [token.value] : [],
    );
    expect(values).toEqual(['\ud800x', '\udc00\ud800', '\ud800\u{10000}']);
  });

  it('reports the byte offset', () => {
    const tokenizer = new JsonTokenizer();
    expect(() => tokenizer.write(encoder.encode('[1,\u00e9 ]'), () => undefined)).toThrow(
      expect.objectContaining({ code: 'invalid_syntax', offset: 3 }),
    );
  });

  it('keeps every thrown error sticky', () => {
    const tokenizer = new JsonTokenizer();
    const failure = new Error('sink failed');
    expect(() =>
      tokenizer.write(encoder.encode('[1]'), () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(() => tokenizer.write(encoder.encode('1'), () => undefined)).toThrow(failure);
    expect(() => tokenizer.end(() => undefined)).toThrow(failure);

    const broken = new JsonTokenizer();
    let first: unknown;
    try {
      broken.write(encoder.encode('{]'), () => undefined);
    } catch (error) {
      first = error;
    }
    expect(first).toBeInstanceOf(JsonStreamError);
    expect(() => broken.write(encoder.encode('1'), () => undefined)).toThrow(
      first as JsonStreamError,
    );
    expect(() => broken.end(() => undefined)).toThrow(first as JsonStreamError);
  });

  it('is closed after end()', () => {
    const tokenizer = new JsonTokenizer();
    tokenizer.write(encoder.encode('{}'), () => undefined);
    tokenizer.end(() => undefined);
    expect(() => tokenizer.write(encoder.encode(' '), () => undefined)).toThrow(
      expect.objectContaining({ code: 'closed' }),
    );
    expect(() => tokenizer.end(() => undefined)).toThrow(
      expect.objectContaining({ code: 'closed' }),
    );
  });

  it('is reportable by name', () => {
    expect(reportableErrorName(new JsonStreamError('invalid_syntax', 0))).toBe('JsonStreamError');
  });

  describe('broadened fixtures', () => {
    const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

    it('keeps number lexemes verbatim', () => {
      const raws = [
        '1E+2',
        '-0',
        '0',
        '-0.0e-0',
        '1e0',
        '123456789012345678901234567890.123456789012345678901234567890E-12',
        '0.5',
      ];
      const tokens = tokenize(encoder.encode(`[${raws.join(' , ')}]`), 3);
      expect(tokens.flatMap((token) => (token.type === 'number' ? [token.raw] : []))).toEqual(raws);
    });

    it('decodes escapes in keys and keeps duplicate keys as separate tokens', () => {
      const text = '{"\\u0041b":1,"Ab":2,"\\ud83d\\ude00":3,"a\\/b":4}';
      const keys = tokenize(encoder.encode(text), 1).flatMap((token) =>
        token.type === 'key' ? [token.value] : [],
      );
      expect(keys).toEqual(['Ab', 'Ab', '\u{1f600}', 'a/b']);
    });

    it('handles nesting at the depth limit and strings at the size limit', () => {
      const deep = '{"a":['.repeat(32) + '0' + ']}'.repeat(32);
      expect(tokenize(encoder.encode(deep), 5)).toHaveLength(32 * 5 + 1);
      const options = { maxStringBytes: 70000 };
      const text = `["${'é'.repeat(35000)}","${'\\u00e9'.repeat(35000)}"]`;
      const values = tokenize(encoder.encode(text), 4093, options).flatMap((token) =>
        token.type === 'string' ? [token.value.length] : [],
      );
      expect(values).toEqual([35000, 35000]);
      expect(textOf(encoder.encode('é'))).toBe('é');
    });
  });

  describe('parity with JSON.parse', () => {
    type Canon = unknown;
    const canonParsed = (value: unknown, keysOnly = false): Canon => {
      if (Array.isArray(value)) {
        return value.map((item) => canonParsed(item, keysOnly));
      }
      if (typeof value === 'object' && value !== null) {
        return {
          o: Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, keysOnly ? null : canonParsed(v, keysOnly)]),
        };
      }
      return value;
    };
    const canonTokens = (tokens: JsonToken[], keysOnly = false): Canon => {
      type Frame = { arr: Canon[] } | { map: Map<string, Canon>; key: string };
      const stack: Frame[] = [];
      let result: Canon;
      const put = (value: Canon): void => {
        const top = stack[stack.length - 1];
        if (top === undefined) {
          result = value;
        } else if ('arr' in top) {
          top.arr.push(value);
        } else {
          top.map.set(top.key, value);
        }
      };
      for (const token of tokens) {
        switch (token.type) {
          case 'beginArray':
            stack.push({ arr: [] });
            break;
          case 'beginObject':
            stack.push({ map: new Map(), key: '' });
            break;
          case 'key': {
            const top = stack[stack.length - 1];
            if (top !== undefined && 'map' in top) {
              top.key = token.value;
              if (keysOnly) {
                top.map.set(token.value, null);
              }
            }
            break;
          }
          case 'endArray':
          case 'endObject': {
            const top = stack.pop();
            if (top !== undefined) {
              put(
                'arr' in top
                  ? top.arr
                  : {
                      o: [...top.map.entries()]
                        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                        .map(([k, v]) => [k, v]),
                    },
              );
            }
            break;
          }
          case 'string':
            put(token.value);
            break;
          case 'number':
            put(Number(token.raw));
            break;
          case 'true':
            put(true);
            break;
          case 'false':
            put(false);
            break;
          default:
            put(null);
        }
      }
      return result;
    };

    const reference = (bytes: Uint8Array, keysOnly: boolean): Canon | 'reject' => {
      try {
        return canonParsed(
          JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)),
          keysOnly,
        );
      } catch {
        return 'reject';
      }
    };

    const prng = (seed: number): (() => number) => {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };

    const bases = [
      JSON.stringify(packument(2)),
      '{"a":[1,-0.5e+3,"\\ud83d\\ude00x\\u0041\\n",true,false,null,{},[]],"é":"ü\u{1f600}","a":{"b":[0,-0,1E2]}}',
      '[[[{"k":"v"},"\\\\"],0.25],"tail"]',
      '"scalar \\" \\u00e9"',
      '-12.5e-3',
    ].map((text) => encoder.encode(text));
    const interesting = [
      0x22, 0x5c, 0x7b, 0x7d, 0x5b, 0x5d, 0x2c, 0x3a, 0x30, 0x2d, 0x2e, 0x65, 0x75, 0x74, 0x6e,
      0x20, 0x0a, 0x00, 0x1f, 0xff, 0xc3, 0xa9, 0xed, 0xa0, 0xef, 0x80,
    ];

    const mutate = (source: Uint8Array, random: () => number): Uint8Array => {
      let bytes = Array.from(source);
      const rounds = 1 + Math.floor(random() * 3);
      for (let round = 0; round < rounds && bytes.length > 0; round += 1) {
        const at = Math.floor(random() * bytes.length);
        const pick = interesting[Math.floor(random() * interesting.length)] ?? 0;
        const kind = Math.floor(random() * 5);
        if (kind === 0) {
          bytes[at] = pick;
        } else if (kind === 1) {
          bytes.splice(at, 1);
        } else if (kind === 2) {
          bytes.splice(at, 0, pick);
        } else if (kind === 3) {
          bytes = bytes.slice(0, at);
        } else {
          bytes.splice(at, 0, ...bytes.slice(at, at + 1 + Math.floor(random() * 8)));
        }
      }
      return Uint8Array.from(bytes);
    };

    const skipEveryKey: Hook = (token, tokenizer) => {
      if (token.type === 'key') {
        tokenizer.skipNext();
      }
    };

    it.each([
      ['full', false],
      ['skipping every key value', true],
    ])(
      'agrees on accept or reject and on values for seeded random mutations (%s)',
      (_name, keysOnly) => {
        const random = prng(keysOnly ? 77 : 20261016);
        let accepted = 0;
        let rejected = 0;
        for (let round = 0; round < 3000; round += 1) {
          const base = bases[round % bases.length] as Uint8Array;
          const bytes = round < bases.length ? base : mutate(base, random);
          const expected = reference(bytes, keysOnly);
          for (const sizeOf of [() => 1, () => 1 + Math.floor(random() * 64)]) {
            let actual: Canon | 'reject';
            try {
              actual = canonTokens(
                feed(bytes, sizeOf, undefined, keysOnly ? skipEveryKey : undefined),
                keysOnly,
              );
            } catch (error) {
              if (!(error instanceof JsonStreamError)) {
                throw error;
              }
              actual = 'reject';
            }
            expect(actual).toEqual(expected);
          }
          if (expected === 'reject') {
            rejected += 1;
          } else {
            accepted += 1;
          }
        }
        expect(accepted).toBeGreaterThan(100);
        expect(rejected).toBeGreaterThan(100);
      },
    );
  });
});

describe('JsonTokenizer structureOnlyNext', () => {
  const run = (text: string, chunk: number): JsonToken[] =>
    tokenize(encoder.encode(text), chunk, undefined, (token, tokenizer) => {
      if (token.type === 'key' && token.value === 'a') {
        tokenizer.structureOnlyNext();
      }
    });

  it.each([1, 3, 1000])('emits structure and empty strings with chunk size %i', (chunk) => {
    const tokens = run('{"a":{"k\\u0041":"x\\ud800y","n":[1,"z"]},"b":"w"}', chunk);
    expect(tokens.map((token) => [token.type, 'value' in token ? token.value : null])).toEqual([
      ['beginObject', null],
      ['key', 'a'],
      ['beginObject', null],
      ['key', 'kA'],
      ['string', ''],
      ['key', 'n'],
      ['beginArray', null],
      ['number', null],
      ['string', ''],
      ['endArray', null],
      ['endObject', null],
      ['key', 'b'],
      ['string', 'w'],
      ['endObject', null],
    ]);
  });

  it('still validates escapes and UTF-8 inside the value', () => {
    expect(() => run('{"a":"\\x"}', 2)).toThrow(JsonStreamError);
    expect(() => run('{"a":"\\ud800\\u12"}', 2)).toThrow(JsonStreamError);
    expect(() =>
      tokenize(
        new Uint8Array([...encoder.encode('{"a":"'), 0xff, 0x22, 0x7d]),
        2,
        undefined,
        (token, tokenizer) => {
          if (token.type === 'key') tokenizer.structureOnlyNext();
        },
      ),
    ).toThrow(JsonStreamError);
  });
});

describe('JsonTokenizer lone-surrogate decoding', () => {
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  function randomText(next: () => number): string {
    const parts: string[] = [];
    const count = Math.floor(next() * 24);
    for (let index = 0; index < count; index += 1) {
      const pick = Math.floor(next() * 7);
      const hex = (base: number, span: number): string =>
        (base + Math.floor(next() * span)).toString(16).padStart(4, '0');
      if (pick === 0) {
        parts.push(`\\u${hex(0xd800, 0x400)}\\u${hex(0xdc00, 0x400)}`);
      } else if (pick === 1) {
        parts.push(`\\u${hex(0xd800, 0x400)}`);
      } else if (pick === 2) {
        parts.push(`\\u${hex(0xdc00, 0x400)}`);
      } else if (pick === 3) {
        parts.push(String.fromCodePoint(0x80 + Math.floor(next() * 0x700)));
      } else if (pick === 4) {
        parts.push(String.fromCodePoint(0x800 + Math.floor(next() * 0x4000)));
      } else if (pick === 5) {
        parts.push(String.fromCodePoint(0x10000 + Math.floor(next() * 0x10000)));
      } else {
        parts.push(String.fromCharCode(0x61 + Math.floor(next() * 26)));
      }
    }
    return parts.join('');
  }

  it('matches JSON.parse over 10,000 seeded strings at mixed chunk sizes', () => {
    const next = seeded(582);
    for (let round = 0; round < 10_000; round += 1) {
      const text = `"${randomText(next)}"`;
      const expected = JSON.parse(text) as string;
      const chunk = 1 + Math.floor(next() * 9);
      const tokens = tokenize(encoder.encode(text), chunk);
      expect(tokens).toHaveLength(1);
      expect((tokens[0] as { value: string }).value).toBe(expected);
    }
  });

  it('keeps peak live growth within 4x output bytes + 2 MiB for 1 MiB of alternating lone surrogates', (context) => {
    let collectGarbage: () => void;
    try {
      v8.setFlagsFromString('--expose-gc');
      collectGarbage = vm.runInNewContext('gc') as () => void;
    } catch {
      context.skip();
      return;
    }
    const MiB = 1024 * 1024;
    const units = MiB;
    const bytes = encoder.encode(`"${'\\ud800a'.repeat(units / 2)}"`);
    for (let warm = 0; warm < 2; warm += 1) {
      tokenize(bytes, 65_536, { maxStringBytes: 8 * MiB });
    }
    const used = (): number => {
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    };
    const measure = (): number => {
      const fromCharCode = String.fromCharCode;
      const join = Array.prototype.join;
      collectGarbage();
      const baseline = used();
      let peak = 0;
      let constructedUnits = 0;
      let samples = 0;
      const sample = (): void => {
        collectGarbage();
        peak = Math.max(peak, used() - baseline);
        samples += 1;
      };
      try {
        String.fromCharCode = (...codes: number[]): string => {
          const result = fromCharCode(...codes);
          const previous = constructedUnits;
          constructedUnits += codes.length;
          if (Math.floor(previous / 131_072) < Math.floor(constructedUnits / 131_072)) sample();
          return result;
        };
        Array.prototype.join = function (this: unknown[], separator?: string): string {
          const decoding = constructedUnits > 0 && separator === '';
          if (decoding) sample();
          const result = join.call(this, separator);
          if (decoding) sample();
          return result;
        };
        const tokens = tokenize(bytes, 65_536, { maxStringBytes: 8 * MiB }, () => sample());
        const value = (tokens[0] as { value: string }).value;
        expect(value).toHaveLength(units);
        expect(value.charCodeAt(0)).toBe(0xd800);
        expect(value.charCodeAt(units - 1)).toBe(0x61);
      } finally {
        String.fromCharCode = fromCharCode;
        Array.prototype.join = join;
      }
      expect(samples).toBeGreaterThan(1);
      return peak;
    };
    const peaks = Array.from({ length: 3 }, () => measure());
    expect(Math.max(...peaks), `Peak live growth in bytes: ${peaks.join(', ')}`).toBeLessThan(
      units * 2 * 4 + 2 * MiB,
    );
  });
});
