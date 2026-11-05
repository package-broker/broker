import { describe, expect, it } from 'vitest';
import { MAX_DEPRECATION_VERSIONS, deprecationChanges } from './deprecate.js';

const body = {
  name: 'widget',
  _id: 'widget',
  'dist-tags': { latest: '1.0.0' },
  versions: {
    '1.0.0': { name: 'widget', version: '1.0.0', dependencies: { a: '^1' } },
    '2.0.0': { name: 'widget', version: '2.0.0' },
  },
  time: { created: 'then', modified: 'now' },
};
describe('npm deprecate manifest validation', () => {
  it('accepts only deprecated changes, preserving public text and empty strings', () => {
    for (const deprecated of ['use v2', '', 'Contact maintainer@example.test']) {
      const next = structuredClone(body);
      Object.assign(next.versions['1.0.0'], { deprecated });
      expect(deprecationChanges(body, next)).toEqual([
        { version: '1.0.0', old: null, message: deprecated },
      ]);
    }
  });
  it.each([
    (b: typeof body) => {
      b.name = 'other';
    },
    (b: typeof body) => {
      b['dist-tags'].latest = '2.0.0';
    },
    (b: typeof body) => {
      b.versions['1.0.0'].dependencies.a = '^2';
    },
    (b: typeof body) => {
      delete (b.versions as Record<string, unknown>)['2.0.0'];
    },
    (b: typeof body) => {
      Object.assign(b.versions, { '3.0.0': {} });
    },
    (b: typeof body) => {
      Object.assign(b.versions['1.0.0'], { deprecated: null });
    },
    (b: typeof body) => {
      Object.assign(b, { secret: 'request-secret' });
    },
  ])('refuses immutable changes with a fixed message', (mutate) => {
    const next = structuredClone(body);
    mutate(next);
    expect(() => deprecationChanges(body, next)).toThrow('invalid_deprecation');
  });
  it('compares nested objects independently of key order', () => {
    expect(deprecationChanges(body, JSON.parse(JSON.stringify(body)))).toEqual([]);
  });
});

describe('deprecation request cap', () => {
  const doc = (count: number, deprecated?: string) => ({
    name: 'widget',
    versions: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `1.0.${i}`,
        {
          name: 'widget',
          version: `1.0.${i}`,
          ...(deprecated === undefined ? {} : { deprecated }),
        },
      ]),
    ),
  });

  it('accepts 64 changed versions and refuses 65 with a fixed code', () => {
    expect(deprecationChanges(doc(64), doc(64, 'old'))).toHaveLength(MAX_DEPRECATION_VERSIONS);
    expect(() => deprecationChanges(doc(65), doc(65, 'old'))).toThrow(
      expect.objectContaining({ code: 'deprecation_too_many' }),
    );
    expect(deprecationChanges(doc(65, 'old'), doc(65, 'old'))).toEqual([]);
  });
});
