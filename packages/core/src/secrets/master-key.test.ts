import { describe, expect, it } from 'vitest';
import {
  MASTER_KEY_PATTERN,
  SecretsConfigError,
  formatMasterKey,
  generateMasterKey,
  parseMasterKey,
  readMasterKeys,
} from './master-key.js';
import type { MasterKey, SecretsConfigProblem } from './master-key.js';

const VECTOR = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const VECTOR_BODY = VECTOR.slice('pbmk_v1_'.length);

function keyText(version: number, fill: number): string {
  const bytes = new Uint8Array(32).map((_, index) => (index * 7 + fill) & 0xff);
  return formatMasterKey({ version, bytes });
}

function bodyOf(text: string): string {
  return text.replace(/^pbmk_v[0-9]+_/, '');
}

function expectNoKeyText(error: Error, supplied: readonly string[]): void {
  const bodies = supplied.flatMap((text) => text.split(',')).map(bodyOf);
  for (const body of bodies.filter((candidate) => candidate !== '')) {
    expect(error.message).not.toContain(body);
    for (let start = 0; start + 8 <= body.length; start += 1) {
      expect(error.message).not.toContain(body.slice(start, start + 8));
    }
  }
}

function failure(run: () => unknown, ...supplied: readonly string[]): SecretsConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretsConfigError);
    expectNoKeyText(error as SecretsConfigError, [...supplied, VECTOR]);
    return error as SecretsConfigError;
  }
  throw new Error('expected a SecretsConfigError');
}

const SEPARATOR_BYTES = Uint8Array.from({ length: 32 }, (_, index) =>
  index < 30 ? [0xfb, 0xff, 0xbf][index % 3]! : index,
);

describe('bodyOf', () => {
  it('strips only the pbmk_v<n>_ prefix, so bodies containing _ and - are kept whole', () => {
    const text = formatMasterKey({ version: 12, bytes: SEPARATOR_BYTES });
    const body = bodyOf(text);

    expect(body).toHaveLength(43);
    expect(body).toContain('_');
    expect(body).toContain('-');
    expect(text).toBe(`pbmk_v12_${body}`);
  });
});

describe('MASTER_KEY_PATTERN', () => {
  it('accepts the vector and rejects version 0 and leading zeros', () => {
    expect(MASTER_KEY_PATTERN.test(VECTOR)).toBe(true);
    expect(MASTER_KEY_PATTERN.test(`pbmk_v0_${VECTOR_BODY}`)).toBe(false);
    expect(MASTER_KEY_PATTERN.test(`pbmk_v01_${VECTOR_BODY}`)).toBe(false);
    expect(MASTER_KEY_PATTERN.test(`pbmk_v1000000_${VECTOR_BODY}`)).toBe(false);
    expect(MASTER_KEY_PATTERN.test(`pbmk_v999999_${VECTOR_BODY}`)).toBe(true);
  });
});

describe('parseMasterKey', () => {
  it('parses the vector to version 1 and bytes 0x00..0x1f', () => {
    const key = parseMasterKey(VECTOR, 'PB_MASTER_KEY');

    expect(key.version).toBe(1);
    expect(key.bytes).toHaveLength(32);
    expect(Array.from(key.bytes)).toEqual(Array.from({ length: 32 }, (_, index) => index));
  });

  it('round-trips the vector through formatMasterKey', () => {
    expect(formatMasterKey(parseMasterKey(VECTOR, 'PB_MASTER_KEY'))).toBe(VECTOR);
  });

  it('parses a multi-digit version', () => {
    expect(parseMasterKey(`pbmk_v123456_${VECTOR_BODY}`, 'PB_MASTER_KEY').version).toBe(123456);
  });

  it.each([
    ['a wrong prefix', `pbmx_v1_${VECTOR_BODY}`],
    ['no prefix', VECTOR_BODY],
    ['42 characters', `pbmk_v1_${VECTOR_BODY.slice(0, 42)}`],
    ['44 characters', `pbmk_v1_${VECTOR_BODY}A`],
    ['a non-canonical last character', `pbmk_v1_${VECTOR_BODY.slice(0, 42)}9`],
    ['a character outside base64url', `pbmk_v1_${VECTOR_BODY.slice(0, 42)}+`],
    ['a padding character', `pbmk_v1_${VECTOR_BODY.slice(0, 42)}=`],
    ['surrounding whitespace', ` ${VECTOR}`],
    ['a trailing newline', `${VECTOR}\n`],
    ['version zero', `pbmk_v0_${VECTOR_BODY}`],
  ])('rejects %s as malformed without echoing the value', (_label, text) => {
    const error = failure(() => parseMasterKey(text, 'PB_MASTER_KEY'), text);

    expect(error.problem).toBe('malformed');
    expect(error.variable).toBe('PB_MASTER_KEY');
  });

  it('rejects a key of 32 equal bytes as weak', () => {
    const text = formatMasterKey({ version: 1, bytes: new Uint8Array(32).fill(0x41) });
    const error = failure(() => parseMasterKey(text, 'PB_MASTER_KEY'), text);

    expect(error.problem).toBe('weak');
  });

  it('rejects the all-zero key as weak', () => {
    const text = formatMasterKey({ version: 2, bytes: new Uint8Array(32) });

    expect(failure(() => parseMasterKey(text, 'PB_MASTER_KEY'), text).problem).toBe('weak');
  });

  it('names the variable it was given', () => {
    const error = failure(() => parseMasterKey('nope', 'PB_MASTER_KEY_PREVIOUS'), 'nope');

    expect(error.variable).toBe('PB_MASTER_KEY_PREVIOUS');
    expect(error.message).toContain('PB_MASTER_KEY_PREVIOUS');
    expect(error.message).toContain('malformed');
    expect(error.name).toBe('SecretsConfigError');
  });
});

describe('readMasterKeys', () => {
  const v4 = keyText(4, 1);
  const v3 = keyText(3, 2);
  const v2 = keyText(2, 3);
  const v1 = keyText(1, 4);

  it('returns only the current key when previous is absent', () => {
    const keys = readMasterKeys({ current: VECTOR });

    expect(keys.map((key) => key.version)).toEqual([1]);
  });

  it('treats an empty previous as absent', () => {
    expect(readMasterKeys({ current: v4, previous: '' })).toHaveLength(1);
    expect(readMasterKeys({ current: v4, previous: undefined })).toHaveLength(1);
  });

  it('returns current first, then previous in the given order', () => {
    const keys = readMasterKeys({ current: v4, previous: `${v3},${v2},${v1}` });

    expect(keys.map((key) => key.version)).toEqual([4, 3, 2, 1]);
    expect(keys.map(formatMasterKey)).toEqual([v4, v3, v2, v1]);
  });

  it('accepts a gap in versions', () => {
    expect(readMasterKeys({ current: keyText(9, 20), previous: `${v3},${v1}` })).toHaveLength(3);
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
  ])('reports missing for %s current', (_label, current) => {
    const error = failure(() => readMasterKeys({ current }), current ?? '');

    expect(error.problem).toBe('missing');
    expect(error.variable).toBe('PB_MASTER_KEY');
  });

  it('reports a malformed current under PB_MASTER_KEY', () => {
    const error = failure(() => readMasterKeys({ current: 'garbage' }), 'garbage');

    expect(error.problem).toBe('malformed');
    expect(error.variable).toBe('PB_MASTER_KEY');
  });

  it('reports a malformed previous entry under PB_MASTER_KEY_PREVIOUS', () => {
    const error = failure(
      () => readMasterKeys({ current: v4, previous: `${v3},garbage` }),
      v4,
      v3,
      'garbage',
    );

    expect(error.problem).toBe('malformed');
    expect(error.variable).toBe('PB_MASTER_KEY_PREVIOUS');
  });

  it.each([
    ['a space after the comma', `${v3}, ${v2}`],
    ['a space before the comma', `${v3} ,${v2}`],
    ['a trailing comma', `${v3},`],
    ['a leading comma', `,${v3}`],
    ['an empty entry', `${v3},,${v2}`],
  ])('rejects %s as malformed', (_label, previous) => {
    const error = failure(() => readMasterKeys({ current: v4, previous }), v4, previous);

    expect(error.problem).toBe('malformed');
    expect(error.variable).toBe('PB_MASTER_KEY_PREVIOUS');
  });

  it('reports a weak previous key', () => {
    const weak = formatMasterKey({ version: 1, bytes: new Uint8Array(32).fill(7) });
    const error = failure(() => readMasterKeys({ current: v4, previous: weak }), v4, weak);

    expect(error.problem).toBe('weak');
    expect(error.variable).toBe('PB_MASTER_KEY_PREVIOUS');
  });

  it.each([
    ['the same version as current', keyText(4, 9)],
    ['a higher version than current', keyText(5, 9)],
    [
      'a higher version than current and a body containing _ and -',
      formatMasterKey({ version: 5, bytes: SEPARATOR_BYTES }),
    ],
  ])('reports version_order for a previous key with %s', (_label, previous) => {
    const error = failure(() => readMasterKeys({ current: v4, previous }), v4, previous);

    expect(error.problem).toBe('version_order');
    expect(error.variable).toBe('PB_MASTER_KEY_PREVIOUS');
  });

  it('reports version_order for two previous keys in ascending order', () => {
    const error = failure(
      () => readMasterKeys({ current: v4, previous: `${v2},${v3}` }),
      v4,
      v2,
      v3,
    );

    expect(error.problem).toBe('version_order');
  });

  it('reports version_order for two previous keys with the same version', () => {
    const duplicate = keyText(3, 50);
    const error = failure(
      () => readMasterKeys({ current: v4, previous: `${v3},${duplicate}` }),
      v4,
      v3,
      duplicate,
    );

    expect(error.problem).toBe('version_order');
  });

  it('reports version_order for a previous key with the same bytes as current', () => {
    const current = parseMasterKey(v4, 'PB_MASTER_KEY');
    const previous = formatMasterKey({ version: 3, bytes: current.bytes });
    const error = failure(() => readMasterKeys({ current: v4, previous }), v4, previous);

    expect(error.problem).toBe('version_order');
  });

  it('reports version_order for two previous keys with the same bytes', () => {
    const shared = parseMasterKey(v2, 'PB_MASTER_KEY').bytes;
    const previous = `${formatMasterKey({ version: 3, bytes: shared })},${formatMasterKey({
      version: 2,
      bytes: shared,
    })}`;

    expect(failure(() => readMasterKeys({ current: v4, previous }), v4, previous).problem).toBe(
      'version_order',
    );
  });

  it('reports too_many for four previous keys', () => {
    const current = keyText(9, 20);
    const previous = [v4, v3, v2, v1].join(',');
    const error = failure(() => readMasterKeys({ current, previous }), current, previous);

    expect(error.problem).toBe('too_many');
    expect(error.variable).toBe('PB_MASTER_KEY_PREVIOUS');
  });

  it('accepts exactly three previous keys', () => {
    expect(
      readMasterKeys({ current: keyText(9, 20), previous: [v4, v3, v2].join(',') }),
    ).toHaveLength(4);
  });
});

describe('generateMasterKey', () => {
  it('formats to a pattern-matching string with the requested version', () => {
    const text = formatMasterKey(generateMasterKey(3));

    expect(MASTER_KEY_PATTERN.test(text)).toBe(true);
    expect(text.startsWith('pbmk_v3_')).toBe(true);
  });

  it('produces 32 bytes that parse back to the same key', () => {
    const key = generateMasterKey(7);
    const parsed = parseMasterKey(formatMasterKey(key), 'PB_MASTER_KEY');

    expect(key.bytes).toHaveLength(32);
    expect(parsed.version).toBe(7);
    expect(Array.from(parsed.bytes)).toEqual(Array.from(key.bytes));
  });

  it('produces 100 distinct keys', () => {
    const texts = new Set(Array.from({ length: 100 }, () => formatMasterKey(generateMasterKey(1))));

    expect(texts.size).toBe(100);
  });

  it.each([0, -1, 1.5, 1_000_000, Number.NaN])('rejects version %s', (version) => {
    expect(() => generateMasterKey(version)).toThrow(RangeError);
  });
});

describe('formatMasterKey', () => {
  it('rejects a key whose bytes are not 32 long', () => {
    const key: MasterKey = { version: 1, bytes: new Uint8Array(31) };

    expect(() => formatMasterKey(key)).toThrow(RangeError);
  });

  it('rejects a key with an invalid version', () => {
    expect(() => formatMasterKey({ version: 0, bytes: new Uint8Array(32) })).toThrow(RangeError);
  });
});

describe('problem kinds', () => {
  it('produces every kind', () => {
    const seen = new Set<SecretsConfigProblem>();
    const v2 = keyText(2, 1);
    const weak = formatMasterKey({ version: 1, bytes: new Uint8Array(32).fill(1) });
    const four = [1, 2, 3, 4].map((v) => keyText(v, v)).join(',');
    const attempts: Array<readonly [() => unknown, ...string[]]> = [
      [() => readMasterKeys({ current: undefined })],
      [() => readMasterKeys({ current: 'x' }), 'x'],
      [() => readMasterKeys({ current: weak }), weak],
      [() => readMasterKeys({ current: v2, previous: v2 }), v2],
      [() => readMasterKeys({ current: keyText(9, 20), previous: four }), keyText(9, 20), four],
    ];
    for (const [run, ...supplied] of attempts) seen.add(failure(run, ...supplied).problem);

    expect([...seen].sort()).toEqual(['malformed', 'missing', 'too_many', 'version_order', 'weak']);
  });
});
