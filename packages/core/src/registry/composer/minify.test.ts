import { describe, expect, it } from 'vitest';
import {
  ExpansionLimitError,
  MalformedVersionError,
  expandVersions,
  minifyVersions,
} from './minify.js';

type Version = Record<string, unknown>;

const semverRecorded: Version[] = JSON.parse(
  String.raw`[{"name":"composer/semver","version":"3.5.1","version_normalized":"3.5.1.0","description":"Version comparison library that offers utilities, version constraint parsing and validation.","type":"library","license":"MIT","keywords":["semver","semantic","versioning","validation"],"authors":[{"name":"Nils Adermann","email":"naderman@naderman.de","homepage":"http://www.naderman.de"},{"name":"Jordi Boggiano","email":"j.boggiano@seld.be","homepage":"http://seld.be"},{"name":"Rob Bast","email":"rob.bast@gmail.com","homepage":"http://robbast.nl"}],"support":{"irc":"ircs://irc.libera.chat:6697/composer","issues":"https://github.com/composer/semver/issues","source":"https://github.com/composer/semver/tree/3.5.1"},"require":{"php":"^5.3.2 || ^7.0 || ^8.0"},"require-dev":{"symfony/phpunit-bridge":"^3 || ^7","phpstan/phpstan":"^1.11"},"autoload":{"psr-4":{"Composer\\Semver\\":"src"}},"autoload-dev":{"psr-4":{"Composer\\Semver\\":"tests"}},"extra":{"branch-alias":{"dev-main":"3.x-dev"}},"source":{"type":"git","url":"https://github.com/composer/semver.git","reference":"528948210cc46f967a4b98e83b19e76f2b504993"},"dist":{"type":"zip","url":"__BASE__/composer/dists/composer/semver/3.5.1.0-528948210cc4.zip","reference":"528948210cc46f967a4b98e83b19e76f2b504993","shasum":"4083ac02dfaa481b2d9c8b74d9090903f6937a82"},"time":"2026-10-05T13:12:12+00:00"},{"version":"3.5.0","version_normalized":"3.5.0.0","support":{"irc":"ircs://irc.libera.chat:6697/composer","issues":"https://github.com/composer/semver/issues","source":"https://github.com/composer/semver/tree/3.5.0"},"source":{"type":"git","url":"https://github.com/composer/semver.git","reference":"f7a296f4c4cf8cb8bb83e35d6951a406bb11afa5"},"dist":{"type":"zip","url":"__BASE__/composer/dists/composer/semver/3.5.0.0-f7a296f4c4cf.zip","reference":"f7a296f4c4cf8cb8bb83e35d6951a406bb11afa5","shasum":"be730a472cba754eea2b8c1721ed235ce8dc2a43"},"time":"2026-09-24T14:38:51+00:00"},{"version":"3.4.4","version_normalized":"3.4.4.0","description":"Semver library that offers utilities, version constraint parsing and validation.","support":{"irc":"ircs://irc.libera.chat:6697/composer","issues":"https://github.com/composer/semver/issues","source":"https://github.com/composer/semver/tree/3.4.4"},"source":{"type":"git","url":"https://github.com/composer/semver.git","reference":"198166618906cb2de69b95d7d47e5fa8aa1b2b95"},"dist":{"type":"zip","url":"__BASE__/composer/dists/composer/semver/3.4.4.0-198166618906.zip","reference":"198166618906cb2de69b95d7d47e5fa8aa1b2b95","shasum":"9fa2e289eee78aaa91e4fc17f69af92fccf75205"},"time":"2025-08-20T19:15:30+00:00"},{"version":"3.4.3","version_normalized":"3.4.3.0","support":{"irc":"ircs://irc.libera.chat:6697/composer","issues":"https://github.com/composer/semver/issues","source":"https://github.com/composer/semver/tree/3.4.3"},"source":{"type":"git","url":"https://github.com/composer/semver.git","reference":"4313d26ada5e0c4edfbd1dc481a92ff7bff91f12"},"dist":{"type":"zip","url":"__BASE__/composer/dists/composer/semver/3.4.3.0-4313d26ada5e.zip","reference":"4313d26ada5e0c4edfbd1dc481a92ff7bff91f12","shasum":"6f0f10d8742a68c5a902bf3c7706b8903e90ac20"},"time":"2024-09-19T14:15:21+00:00"},{"version":"3.4.2","version_normalized":"3.4.2.0","support":{"irc":"ircs://irc.libera.chat:6697/composer","issues":"https://github.com/composer/semver/issues","source":"https://github.com/composer/semver/tree/3.4.2"},"require-dev":{"symfony/phpunit-bridge":"^4.2 || ^5","phpstan/phpstan":"^1.4"},"source":{"type":"git","url":"https://github.com/composer/semver.git","reference":"c51258e759afdb17f1fd1fe83bc12baaef6309d6"},"dist":{"type":"zip","url":"__BASE__/composer/dists/composer/semver/3.4.2.0-c51258e759af.zip","reference":"c51258e759afdb17f1fd1fe83bc12baaef6309d6","shasum":"116a9e29a05adaf1f8fddddda1bfb06259ae3ece"},"time":"2024-07-12T11:35:52+00:00"}]`,
);
const ctypeRecorded: Version[] = JSON.parse(
  String.raw`[{"name":"symfony/polyfill-ctype","version":"v1.37.0","version_normalized":"1.37.0.0","type":"library","description":"Symfony polyfill for ctype functions","keywords":["polyfill","compatibility","portable","ctype"],"homepage":"https://symfony.com","license":"MIT","authors":[{"name":"Gert de Pagter","email":"BackEndTea@gmail.com"},{"name":"Symfony Community","homepage":"https://symfony.com/contributors"}],"require":{"php":">=7.2"},"provide":{"ext-ctype":"*"},"autoload":{"psr-4":{"Symfony\\Polyfill\\Ctype\\":""},"files":["bootstrap.php"]},"suggest":{"ext-ctype":"For best performance"},"extra":{"thanks":{"name":"symfony/polyfill","url":"https://github.com/symfony/polyfill"}},"support":{"source":"https://github.com/symfony/polyfill-ctype/tree/v1.37.0"},"source":{"type":"git","url":"https://github.com/symfony/polyfill-ctype.git","reference":"141046a8f9477948ff284fa65be2095baafb94f2"},"dist":{"type":"zip","url":"__BASE__/composer/dists/symfony/polyfill-ctype/1.37.0.0-141046a8f947.zip","reference":"141046a8f9477948ff284fa65be2095baafb94f2","shasum":"5c736165530cf3c985436487b42d62fda1299c55"},"time":"2026-04-10T16:19:22+00:00"},{"version":"v1.36.0","version_normalized":"1.36.0.0","support":{"source":"https://github.com/symfony/polyfill-ctype/tree/v1.36.0"},"dist":{"type":"zip","url":"__BASE__/composer/dists/symfony/polyfill-ctype/1.36.0.0-141046a8f947.zip","reference":"141046a8f9477948ff284fa65be2095baafb94f2","shasum":"5c736165530cf3c985436487b42d62fda1299c55"}},{"version":"v1.35.0","version_normalized":"1.35.0.0","support":{"source":"https://github.com/symfony/polyfill-ctype/tree/v1.35.0"},"dist":{"type":"zip","url":"__BASE__/composer/dists/symfony/polyfill-ctype/1.35.0.0-141046a8f947.zip","reference":"141046a8f9477948ff284fa65be2095baafb94f2","shasum":"5c736165530cf3c985436487b42d62fda1299c55"}},{"version":"v1.34.0","version_normalized":"1.34.0.0","support":{"source":"https://github.com/symfony/polyfill-ctype/tree/v1.34.0"},"dist":{"type":"zip","url":"__BASE__/composer/dists/symfony/polyfill-ctype/1.34.0.0-141046a8f947.zip","reference":"141046a8f9477948ff284fa65be2095baafb94f2","shasum":"5c736165530cf3c985436487b42d62fda1299c55"}},{"version":"v1.33.0","version_normalized":"1.33.0.0","support":{"source":"https://github.com/symfony/polyfill-ctype/tree/v1.33.0"},"source":{"type":"git","url":"https://github.com/symfony/polyfill-ctype.git","reference":"a3cc8b044a6ea513310cbd48ef7333b384945638"},"dist":{"type":"zip","url":"__BASE__/composer/dists/symfony/polyfill-ctype/1.33.0.0-a3cc8b044a6e.zip","reference":"a3cc8b044a6ea513310cbd48ef7333b384945638","shasum":"1cffffb8c0465faf4542a02a0956a88dbb525b5d"},"time":"2024-09-09T11:45:10+00:00"}]`,
);

const recordedFull: Version[] = JSON.parse(
  '[{"name":"a/b","version":"3.0.0","require":{"php":">=7.2","x/y":"^1"},"license":["MIT"],"description":"d","extra":{"branch-alias":{"dev-main":"3.0-dev"}}},' +
    '{"name":"a/b","version":"2.1.0","require":{"php":">=7.2","x/y":"^1"},"license":["MIT"],"description":"d2","extra":{"branch-alias":{"dev-main":"3.0-dev"}}},' +
    '{"name":"a/b","version":"2.0.0","require":{"php":">=7.1"},"license":["MIT"],"description":"d2"},' +
    '{"name":"a/b","version":"1.0.0","require":{"php":">=7.1"},"license":["MIT"],"description":"d2","extra":{"branch-alias":{"dev-main":"1.0-dev"}},"abandoned":true}]',
);

const recordedMinified =
  '[{"name":"a/b","version":"3.0.0","require":{"php":">=7.2","x/y":"^1"},"license":["MIT"],"description":"d","extra":{"branch-alias":{"dev-main":"3.0-dev"}}},' +
  '{"version":"2.1.0","description":"d2"},' +
  '{"version":"2.0.0","require":{"php":">=7.1"},"extra":"__unset"},' +
  '{"version":"1.0.0","extra":{"branch-alias":{"dev-main":"1.0-dev"}},"abandoned":true}]';

const parse = (json: string): Version[] => JSON.parse(json) as Version[];
const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomFixture(count: number): Version[] {
  const next = rng(42);
  const keys = [
    'description',
    'require',
    'license',
    'extra',
    'support',
    'authors',
    'abandoned',
    'time',
  ];
  const out: Version[] = [];
  for (let i = 0; i < count; i++) {
    const v: Version = { name: 'a/b', version: `1.${i}.0` };
    for (const k of keys) {
      const r = next();
      if (r < 0.35) continue;
      v[k] =
        r < 0.7 ? `${k}-stable` : { n: Math.floor(next() * 4), list: [Math.floor(next() * 3)] };
    }
    out.push(v);
  }
  return out;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('minifyVersions against the vendored PHP MetadataMinifier', () => {
  it('matches the recorded output byte for byte', () => {
    expect(JSON.stringify(minifyVersions(recordedFull))).toBe(recordedMinified);
  });

  it.each([
    ['semver', semverRecorded],
    ['polyfill-ctype', ctypeRecorded],
  ])('reproduces the recorded spike body for %s byte for byte', (_name, recorded) => {
    const expanded = expandVersions(recorded, { maxVersions: 100 });
    expect(expanded).toHaveLength(recorded.length);
    expect(JSON.stringify(minifyVersions(expanded))).toBe(JSON.stringify(recorded));
  });

  it('emits __unset for a null equal to the previous null (PHP isset)', () => {
    const out = minifyVersions(parse('[{"a":1,"b":null},{"a":1,"b":null},{"a":1,"c":2}]'));
    expect(JSON.stringify(out)).toBe('[{"a":1,"b":null},{"b":"__unset"},{"c":2}]');
  });

  it('treats the next version as a fresh first one when the running version is empty', () => {
    expect(JSON.stringify(minifyVersions(parse('[{"a":1},{},{"b":2},{"b":3}]')))).toBe(
      '[{"a":1},{"a":"__unset"},{"b":2},{"b":3}]',
    );
    expect(JSON.stringify(minifyVersions(parse('[{},{"a":1},{"a":2}]')))).toBe(
      '[{},{"a":1},{"a":2}]',
    );
  });

  it('marks keys that disappear with __unset', () => {
    expect(minifyVersions([{ a: 1, b: 2 }, { a: 1 }])[1]).toEqual({ b: '__unset' });
  });

  it('does not mutate or alias its input', () => {
    const copy = structuredClone(recordedFull);
    const out = minifyVersions(recordedFull);
    expect(recordedFull).toEqual(copy);
    expect(out[0]).not.toBe(recordedFull[0]);
  });

  it('returns an empty list for an empty list', () => {
    expect(minifyVersions([])).toEqual([]);
  });

  it('treats __proto__ and constructor keys as data', () => {
    const out = minifyVersions(
      parse('[{"a":1,"__proto__":{"x":1}},{"a":1,"__proto__":{"x":2},"constructor":"c"},{"a":1}]'),
    );
    expect(Object.keys(out[1]!)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(out[1])).toBe(Object.prototype);
    expect(Object.keys(out[2]!)).toEqual(['__proto__', 'constructor']);
    expect(Object.values(out[2]!)).toEqual(['__unset', '__unset']);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('refuses non-object entries', () => {
    for (const bad of [null, 'x', ['a']]) {
      expect(() => minifyVersions([{ a: 1 }, bad as unknown as Version])).toThrow(
        MalformedVersionError,
      );
    }
  });
});

describe('expandVersions', () => {
  const limits = { maxVersions: 1000 };

  it('expands the recorded output to the recorded input', () => {
    expect(expandVersions(parse(recordedMinified), { maxVersions: 10 })).toEqual(recordedFull);
  });

  it('keeps nulls as PHP does and drops nothing else', () => {
    expect(JSON.stringify(expandVersions(parse('[{"a":1,"b":null},{"c":null}]'), limits))).toBe(
      '[{"a":1,"b":null},{"a":1,"b":null,"c":null}]',
    );
  });

  it('treats the next entry as a fresh first version when the running version is empty', () => {
    const out = expandVersions(
      parse('[{"a":1},{"a":"__unset"},{"__unset":"x","b":"__unset"},{"b":2}]'),
      limits,
    );
    expect(JSON.stringify(out)).toBe(
      '[{"a":1},{},{"__unset":"x","b":"__unset"},{"__unset":"x","b":2}]',
    );
    expect(JSON.stringify(expandVersions(parse('[{},{"a":"__unset"},{"b":1}]'), limits))).toBe(
      '[{},{"a":"__unset"},{"a":"__unset","b":1}]',
    );
  });

  it('round-trips a 500-version randomized fixture with removed and re-added keys', () => {
    const full = randomFixture(500);
    expect(expandVersions(minifyVersions(full), { maxVersions: 500 })).toEqual(full);
  });

  it('returns independent version objects', () => {
    const out = expandVersions([{ a: 1 }, { b: 2 }], { maxVersions: 2 });
    out[0]!.a = 99;
    expect(out[1]).toEqual({ a: 1, b: 2 });
  });

  it('treats a __proto__ key as data, never as a prototype', () => {
    const out = expandVersions(parse('[{"a":1},{"__proto__":{"polluted":true}}]'), {
      maxVersions: 2,
    });
    expect(Object.getPrototypeOf(out[1])).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(out[1]!)).toContain('__proto__');
  });

  it('counts a removed key out of the expanded size', () => {
    const big = 'x'.repeat(200 * 1024);
    const minified: Version[] = [{ a: big }, { a: '__unset', b: big }, { b: '__unset', a: big }];
    expect(expandVersions(minified, { maxVersions: 3 })).toHaveLength(3);
  });

  describe('count limit', () => {
    it('allows exactly maxVersions', () => {
      const minified = Array.from({ length: 10 }, (_, i) => ({ a: i }));
      expect(expandVersions(minified, { maxVersions: 10 })).toHaveLength(10);
    });

    it('refuses one more and reports the count', () => {
      const minified = Array.from({ length: 11 }, (_, i) => ({ a: i }));
      const error = catchError(() => expandVersions(minified, { maxVersions: 10 }));
      expect(error).toBeInstanceOf(ExpansionLimitError);
      expect((error as ExpansionLimitError).reason).toBe('versions');
      expect((error as ExpansionLimitError).count).toBe(11);
      expect((error as ExpansionLimitError).atIndex).toBeNull();
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects maxVersions %s',
      (maxVersions) => {
        expect(() => expandVersions([{ a: 1 }], { maxVersions })).toThrow(RangeError);
      },
    );

    it.each([0, 2.5, Number.NaN])('rejects the other limits when set to %s', (value) => {
      expect(() => expandVersions([{ a: 1 }], { maxVersions: 1, maxVersionBytes: value })).toThrow(
        RangeError,
      );
      expect(() => expandVersions([{ a: 1 }], { maxVersions: 1, maxTotalBytes: value })).toThrow(
        RangeError,
      );
      expect(() =>
        expandVersions([{ a: 1 }], { maxVersions: 1, maxKeysPerVersion: value }),
      ).toThrow(RangeError);
    });
  });

  describe('per-version byte limit (real JSON size)', () => {
    const version = { 'k"ey': 'é"\\\n☃', n: [1, null, { z: true }] };

    it('allows a version of exactly maxVersionBytes', () => {
      const size = jsonBytes(version);
      expect(expandVersions([version], { maxVersions: 1, maxVersionBytes: size })).toEqual([
        version,
      ]);
    });

    it('refuses a version one byte over', () => {
      const error = catchError(() =>
        expandVersions([version], { maxVersions: 1, maxVersionBytes: jsonBytes(version) - 1 }),
      );
      expect((error as ExpansionLimitError).reason).toBe('version_bytes');
      expect((error as ExpansionLimitError).atIndex).toBe(0);
    });

    it('measures an expanded version, not the diff', () => {
      const minified: Version[] = [{ a: 'x'.repeat(100) }, { b: 'y'.repeat(100) }];
      const second = jsonBytes({ a: 'x'.repeat(100), b: 'y'.repeat(100) });
      expect(expandVersions(minified, { maxVersions: 2, maxVersionBytes: second })).toHaveLength(2);
      const error = catchError(() =>
        expandVersions(minified, { maxVersions: 2, maxVersionBytes: second - 1 }),
      );
      expect((error as ExpansionLimitError).atIndex).toBe(1);
    });

    it('defaults to 262144 bytes', () => {
      const overhead = jsonBytes({ a: '' });
      expect(
        expandVersions([{ a: 'x'.repeat(262_144 - overhead) }], { maxVersions: 1 }),
      ).toHaveLength(1);
      expect(() =>
        expandVersions([{ a: 'x'.repeat(262_144 - overhead + 1) }], { maxVersions: 1 }),
      ).toThrow(ExpansionLimitError);
    });
  });

  describe('total byte limit', () => {
    const minified: Version[] = [{ a: 'x'.repeat(50), v: 0 }, { v: 1 }, { v: 2 }];
    const sizes = minified.map((_, i) => jsonBytes({ a: 'x'.repeat(50), v: i }));
    const sum = sizes.reduce((a, b) => a + b, 0);

    it('allows exactly maxTotalBytes', () => {
      expect(expandVersions(minified, { maxVersions: 3, maxTotalBytes: sum })).toHaveLength(3);
    });

    it('refuses one byte over at the version that crosses it', () => {
      const error = catchError(() =>
        expandVersions(minified, { maxVersions: 3, maxTotalBytes: sum - 1 }),
      );
      expect((error as ExpansionLimitError).reason).toBe('total');
      expect((error as ExpansionLimitError).atIndex).toBe(2);
    });

    it('refuses a 200 KiB field inherited across 1,000 versions at the default budget', () => {
      const big = 'x'.repeat(200 * 1024);
      const bomb: Version[] = [{ v: 0, big }];
      for (let i = 1; i < 1000; i++) bomb.push({ v: i });
      const error = catchError(() => expandVersions(bomb, limits));
      expect((error as ExpansionLimitError).reason).toBe('total');
      expect((error as ExpansionLimitError).atIndex).toBeLessThan(200);
    });

    it('refuses a second 200 KiB field at the per-version cap', () => {
      const big = 'x'.repeat(200 * 1024);
      const error = catchError(() => expandVersions([{ big }, { other: big }], { maxVersions: 2 }));
      expect((error as ExpansionLimitError).reason).toBe('version_bytes');
      expect((error as ExpansionLimitError).atIndex).toBe(1);
    });
  });

  describe('key count limit', () => {
    const keyed = (n: number): Version =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1]));

    it('allows exactly 512 keys by default and refuses 513', () => {
      expect(expandVersions([keyed(512)], { maxVersions: 1 })).toHaveLength(1);
      const error = catchError(() => expandVersions([keyed(513)], { maxVersions: 1 }));
      expect((error as ExpansionLimitError).reason).toBe('keys');
      expect((error as ExpansionLimitError).atIndex).toBe(0);
    });

    it('refuses 30,000 keys followed by 999 small diffs quickly', () => {
      const bomb: Version[] = [keyed(30_000)];
      for (let i = 1; i < 1000; i++) bomb.push({ v: i });
      const error = catchError(() => expandVersions(bomb, limits));
      expect((error as ExpansionLimitError).reason).toBe('keys');
    });

    it('refuses keys added by diffs past the cap', () => {
      const error = catchError(() =>
        expandVersions([keyed(3), { x: 1 }, { y: 1 }], { maxVersions: 3, maxKeysPerVersion: 4 }),
      );
      expect((error as ExpansionLimitError).reason).toBe('keys');
      expect((error as ExpansionLimitError).atIndex).toBe(2);
    });

    it('does not count removed keys', () => {
      const out = expandVersions([keyed(4), { k0: '__unset', x: 1 }, { k1: '__unset', y: 1 }], {
        maxVersions: 3,
        maxKeysPerVersion: 4,
      });
      expect(out).toHaveLength(3);
    });
  });

  describe('entry types', () => {
    it.each([
      ['null', null],
      ['a string', 'x'],
      ['an array', ['a']],
      ['a number', 1],
    ])('refuses %s at index 0 and later', (_name, bad) => {
      const first = catchError(() => expandVersions([bad as unknown as Version], limits));
      expect(first).toBeInstanceOf(MalformedVersionError);
      expect((first as MalformedVersionError).atIndex).toBe(0);
      const later = catchError(() => expandVersions([{ a: 1 }, bad as unknown as Version], limits));
      expect(later).toBeInstanceOf(MalformedVersionError);
      expect((later as MalformedVersionError).atIndex).toBe(1);
    });
  });
});
