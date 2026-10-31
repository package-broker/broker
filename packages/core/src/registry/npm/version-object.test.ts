import { describe, expect, it } from 'vitest';

import { InvalidNpmOriginError, npmVersionInput, type NpmVersionOrigin } from './version-object.js';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const SHASUM = 'a'.repeat(40);
const IMPORTED_AT = '2026-10-16T10:00:00.000Z';
const SECRET = 'npm_S3cretTokenValue123';

const origin: NpmVersionOrigin = {
  probe: { secrets: [SECRET], queryParams: ['token'] },
  importedAt: IMPORTED_AT,
};

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'left-pad',
    version: '1.3.0',
    description: 'pad left',
    license: 'WTFPL',
    _id: 'left-pad@1.3.0',
    _rev: '3-abc',
    readme: '# left-pad',
    readmeFilename: 'README.md',
    gitHead: 'b'.repeat(40),
    maintainers: [{ name: 'alice', email: 'alice@example.com' }],
    _npmUser: { name: 'alice', email: 'alice@example.com' },
    dist: {
      tarball: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      integrity: INTEGRITY,
      shasum: SHASUM,
      fileCount: 3,
      'npm-signature': 'legacy',
    },
    ...overrides,
  };
}

const TIME = { '1.3.0': '2018-04-09T01:34:42.123Z', created: '2014-01-01T00:00:00.000Z' };

function stored(result: ReturnType<typeof npmVersionInput>): Record<string, unknown> {
  if (!result.ok) throw new Error(`skipped: ${result.reason}`);
  return JSON.parse(result.input.metadata.json) as Record<string, unknown>;
}

describe('npmVersionInput', () => {
  it('builds the version input from a valid manifest', () => {
    const result = npmVersionInput('left-pad', manifest(), TIME, origin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stripped).toBe(0);
    expect(result.input).toMatchObject({
      version: '1.3.0',
      versionNormalized: '1.3.0',
      license: 'WTFPL',
      distType: 'tgz',
      sourceRef: 'b'.repeat(40),
      upstreamReleasedAt: '2018-04-09T01:34:42.123Z',
      history: { basis: 'release_date', at: '2018-04-09T01:34:42.123Z' },
    });
    expect(result.input.metadata.npmIntegrity).toBe(INTEGRITY);
    const json = stored(result);
    expect(json.dist).toEqual({
      tarball: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      integrity: INTEGRITY,
      shasum: SHASUM,
      fileCount: 3,
    });
  });

  it('refuses a manifest whose name differs from the packument', () => {
    expect(npmVersionInput('left-pad', manifest({ name: 'right-pad' }), TIME, origin)).toEqual({
      ok: false,
      reason: 'foreign_name',
    });
    expect(npmVersionInput('left-pad', manifest({ name: 42 }), TIME, origin)).toEqual({
      ok: false,
      reason: 'foreign_name',
    });
    expect(npmVersionInput('left-pad', manifest({ name: 'Left-Pad' }), TIME, origin)).toEqual({
      ok: false,
      reason: 'foreign_name',
    });
  });

  it('accepts a legacy capitalised name that matches the key', () => {
    const result = npmVersionInput(
      '!j!s!o!n!stream',
      manifest({ name: 'JSONStream' }),
      TIME,
      origin,
    );
    expect(result.ok).toBe(true);
  });

  it('keeps no e-mail address from maintainers, _npmUser, author or contributors', () => {
    const result = npmVersionInput(
      'left-pad',
      manifest({
        author: { name: 'Bob', email: 'bob@example.com', url: 'https://bob.example' },
        contributors: ['Carol <carol@example.com> (https://carol.example)', { email: 'x@y.z' }],
      }),
      TIME,
      origin,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.input.metadata.json).not.toMatch(/@example\.com|x@y\.z/);
    const json = stored(result);
    expect(json.maintainers).toEqual([{ name: 'alice' }]);
    expect(json._npmUser).toEqual({ name: 'alice' });
    expect(json.author).toEqual({ name: 'Bob', url: 'https://bob.example' });
    expect(json.contributors).toEqual(['Carol']);
  });

  it('drops readme, readmeFilename, _id, _rev and unknown fields', () => {
    const json = stored(
      npmVersionInput('left-pad', manifest({ scripts: { x: 'y' } }), TIME, origin),
    );
    for (const name of ['readme', 'readmeFilename', '_id', '_rev']) {
      expect(json).not.toHaveProperty(name);
    }
    expect(json).toHaveProperty('scripts');
    expect(
      stored(npmVersionInput('left-pad', manifest({ _other: 1 }), TIME, origin)),
    ).not.toHaveProperty('_other');
  });

  it('keeps the shasum and yields a null integrity for a legacy shasum-only version', () => {
    const result = npmVersionInput(
      'left-pad',
      manifest({
        dist: {
          tarball: 'https://registry.npmjs.org/left-pad/-/left-pad-0.0.1.tgz',
          shasum: SHASUM,
        },
      }),
      TIME,
      origin,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.input.metadata.npmIntegrity).toBeNull();
    expect((stored(result).dist as Record<string, unknown>).shasum).toBe(SHASUM);
  });

  it('refuses invalid digests and a version without any digest', () => {
    const tarball = 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz';
    expect(
      npmVersionInput('left-pad', manifest({ dist: { tarball, shasum: 'xyz' } }), TIME, origin),
    ).toEqual({ ok: false, reason: 'invalid_metadata' });
    expect(
      npmVersionInput(
        'left-pad',
        manifest({ dist: { tarball, integrity: 'md5-abc' } }),
        TIME,
        origin,
      ),
    ).toEqual({ ok: false, reason: 'invalid_metadata' });
    expect(npmVersionInput('left-pad', manifest({ dist: { tarball } }), TIME, origin)).toEqual({
      ok: false,
      reason: 'no_digest',
    });
  });

  it('refuses a version without a usable tarball', () => {
    expect(npmVersionInput('left-pad', manifest({ dist: undefined }), TIME, origin)).toEqual({
      ok: false,
      reason: 'no_installable_reference',
    });
    expect(
      npmVersionInput(
        'left-pad',
        manifest({ dist: { tarball: 'ftp://x/y.tgz', shasum: SHASUM } }),
        TIME,
        origin,
      ),
    ).toEqual({ ok: false, reason: 'invalid_metadata' });
  });

  it('refuses an invalid semver', () => {
    for (const version of ['1.3', 'v1.3.0', '01.2.3', 7]) {
      expect(npmVersionInput('left-pad', manifest({ version }), TIME, origin)).toEqual({
        ok: false,
        reason: 'invalid_version',
      });
    }
  });

  it('strips a credential echo in the tarball before normalization', () => {
    const result = npmVersionInput(
      'left-pad',
      manifest({
        dist: {
          tarball: `https://registry.example/left-pad.tgz?token=${SECRET}`,
          integrity: INTEGRITY,
        },
      }),
      TIME,
      origin,
    );
    expect(result).toEqual({ ok: false, reason: 'no_installable_reference' });

    const kept = npmVersionInput(
      'left-pad',
      manifest({ homepage: `https://example.com/?token=${SECRET}` }),
      TIME,
      origin,
    );
    if (!kept.ok) throw new Error(kept.reason);
    expect(kept.stripped).toBe(1);
    expect(kept.input.metadata.json).not.toContain(SECRET);
  });

  it('refuses a credential echoed outside a URL field', () => {
    expect(
      npmVersionInput('left-pad', manifest({ description: `see ${SECRET}` }), TIME, origin),
    ).toEqual({ ok: false, reason: 'credential_echo' });
  });

  it('moves the deprecation message out of the stored metadata', () => {
    const result = npmVersionInput(
      'left-pad',
      manifest({ deprecated: 'use padStart' }),
      TIME,
      origin,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.input.metadata.deprecatedMessage).toBe('use padStart');
    expect(stored(result)).not.toHaveProperty('deprecated');
  });

  it('falls back to the import time when time[version] is missing or malformed', () => {
    for (const time of [
      {},
      { '1.3.0': '2018-02-30T00:00:00.000Z' },
      { '1.3.0': 'yesterday' },
      null,
    ]) {
      const result = npmVersionInput('left-pad', manifest(), time, origin);
      if (!result.ok) throw new Error(result.reason);
      expect(result.input.upstreamReleasedAt).toBeNull();
      expect(result.input.history).toEqual({
        basis: 'import_time',
        at: IMPORTED_AT,
        noOtherDate: true,
      });
    }
  });

  it('normalizes an offset timestamp to UTC', () => {
    const result = npmVersionInput(
      'left-pad',
      manifest(),
      { '1.3.0': '2018-04-09T03:34:42+02:00' },
      origin,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.input.upstreamReleasedAt).toBe('2018-04-09T01:34:42.000Z');
  });

  it('refuses malformed manifests and oversized metadata', () => {
    expect(npmVersionInput('left-pad', [], TIME, origin)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(npmVersionInput('left-pad', null, TIME, origin)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(
      npmVersionInput('left-pad', manifest({ description: 'x'.repeat(300000) }), TIME, origin),
    ).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects a non-canonical import time', () => {
    expect(() =>
      npmVersionInput('left-pad', manifest(), TIME, { ...origin, importedAt: '2026-10-16' }),
    ).toThrow(InvalidNpmOriginError);
  });

  describe('round 2', () => {
    const tarball = 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz';

    function ok(result: ReturnType<typeof npmVersionInput>) {
      if (!result.ok) throw new Error(`skipped: ${result.reason}`);
      return result;
    }

    it('scrubs e-mail addresses from every people-field shape', () => {
      const result = ok(
        npmVersionInput(
          'left-pad',
          manifest({
            maintainers: ['alice@example.com', { name: 'bob@example.com' }, { name: 'Bob' }],
            _npmUser: 'Alice <alice@example.com>',
            author: ['Dan <dan@example.com>', { name: 'Eve', url: 'mailto:eve@example.com' }],
            contributors: { name: 'Carol', email: 'carol@example.com', url: 'https://c.example' },
          }),
          TIME,
          origin,
        ),
      );
      expect(result.input.metadata.json).not.toContain('@example.com');
      const json = stored(result);
      expect(json.maintainers).toEqual([{ name: 'Bob' }]);
      expect(json._npmUser).toBe('Alice');
      expect(json.author).toEqual(['Dan', { name: 'Eve' }]);
      expect(json.contributors).toEqual({ name: 'Carol', url: 'https://c.example' });
    });

    it('drops a bare-address author string and a mailto bugs', () => {
      const json = stored(
        npmVersionInput(
          'left-pad',
          manifest({ author: 'dan@example.com', bugs: 'mailto:dan@example.com' }),
          TIME,
          origin,
        ),
      );
      expect(json).not.toHaveProperty('author');
      expect(json).not.toHaveProperty('bugs');
    });

    it('keeps bugs only as an http(s) URL', () => {
      const asString = stored(
        npmVersionInput('left-pad', manifest({ bugs: 'https://x.example/issues' }), TIME, origin),
      );
      expect(asString.bugs).toBe('https://x.example/issues');
      const asObject = stored(
        npmVersionInput(
          'left-pad',
          manifest({ bugs: { url: 'https://x.example/issues', email: 'b@example.com' } }),
          TIME,
          origin,
        ),
      );
      expect(asObject.bugs).toEqual({ url: 'https://x.example/issues' });
      const notUrl = stored(
        npmVersionInput('left-pad', manifest({ bugs: 'see README' }), TIME, origin),
      );
      expect(notUrl).not.toHaveProperty('bugs');
    });

    it('removes denied credential query parameters from URL fields', () => {
      const result = ok(
        npmVersionInput(
          'left-pad',
          manifest({
            homepage: 'https://h.example/?access_token=abc&page=1',
            repository: { type: 'git', url: 'git+https://g.example/r.git?private_token=abc' },
            bugs: { url: 'https://b.example/?sig=abc' },
            funding: [
              { type: 'x', url: 'https://f.example/?X-Amz-Signature=abc' },
              'https://f2.example/?key=abc',
            ],
            author: { name: 'Bob', url: 'https://a.example/?auth=abc' },
          }),
          TIME,
          origin,
        ),
      );
      const json = stored(result);
      expect(json.homepage).toBe('https://h.example/?page=1');
      expect(json.repository).toEqual({ type: 'git', url: 'git+https://g.example/r.git' });
      expect(json.bugs).toEqual({ url: 'https://b.example/' });
      expect(json.funding).toEqual([
        { type: 'x', url: 'https://f.example/' },
        'https://f2.example/',
      ]);
      expect(json.author).toEqual({ name: 'Bob', url: 'https://a.example/' });
      expect(result.input.metadata.json).not.toContain('abc');
    });

    it('counts only allowlisted fields as stripped', () => {
      const result = ok(
        npmVersionInput(
          'left-pad',
          manifest({ _resolved: `https://x.example/?token=${SECRET}`, _other: SECRET }),
          TIME,
          origin,
        ),
      );
      expect(result.stripped).toBe(0);
    });

    it('treats far-future, too-early and impossible release times as malformed', () => {
      for (const value of [
        '2026-10-17T10:00:01.000Z',
        '2099-01-01T00:00:00.000Z',
        '2008-12-31T23:59:59.999Z',
        '2018-04-09T25:00:00Z',
        '2018-04-09T01:00:00+24:00',
        '2019-02-29T00:00:00Z',
      ]) {
        const result = ok(npmVersionInput('left-pad', manifest(), { '1.3.0': value }, origin));
        expect(result.input.upstreamReleasedAt).toBeNull();
        expect(result.input.history.basis).toBe('import_time');
      }
    });

    it('accepts a leap day, a negative offset and the 24 h window', () => {
      const cases: [string, string][] = [
        ['2020-02-29T12:00:00Z', '2020-02-29T12:00:00.000Z'],
        ['2018-04-08T20:34:42-05:00', '2018-04-09T01:34:42.000Z'],
        ['2026-10-17T10:00:00.000Z', '2026-10-17T10:00:00.000Z'],
        ['2009-01-01T00:00:00.000Z', '2009-01-01T00:00:00.000Z'],
      ];
      for (const [value, expected] of cases) {
        const result = ok(npmVersionInput('left-pad', manifest(), { '1.3.0': value }, origin));
        expect(result.input.upstreamReleasedAt).toBe(expected);
      }
    });

    it('validates dist extras', () => {
      const json = stored(
        npmVersionInput(
          'left-pad',
          manifest({
            dist: {
              tarball,
              integrity: INTEGRITY,
              fileCount: -1,
              unpackedSize: 1.5,
              signatures: [{ keyid: 'k', sig: 's' }],
              attestations: { url: 'https://a.example/att', provenance: { predicateType: 'p' } },
            },
          }),
          TIME,
          origin,
        ),
      );
      expect(json.dist).toEqual({
        tarball,
        integrity: INTEGRITY,
        signatures: [{ keyid: 'k', sig: 's' }],
        attestations: { url: 'https://a.example/att', provenance: { predicateType: 'p' } },
      });
      const bad = stored(
        npmVersionInput(
          'left-pad',
          manifest({
            dist: {
              tarball,
              integrity: INTEGRITY,
              fileCount: 3,
              unpackedSize: 10,
              signatures: [{ keyid: 'k', sig: 1 }],
              attestations: { url: 'http://a.example/att', provenance: { predicateType: 'p' } },
            },
          }),
          TIME,
          origin,
        ),
      );
      expect(bad.dist).toEqual({ tarball, integrity: INTEGRITY, fileCount: 3, unpackedSize: 10 });
      const many = stored(
        npmVersionInput(
          'left-pad',
          manifest({
            dist: {
              tarball,
              integrity: INTEGRITY,
              signatures: Array.from({ length: 17 }, () => ({ keyid: 'k', sig: 's' })),
            },
          }),
          TIME,
          origin,
        ),
      );
      expect(many.dist).not.toHaveProperty('signatures');
    });

    it('stores a lowercase shasum and the joined integrity form', () => {
      const result = ok(
        npmVersionInput(
          'left-pad',
          manifest({ dist: { tarball, shasum: 'A'.repeat(40), integrity: `  ${INTEGRITY}\n` } }),
          TIME,
          origin,
        ),
      );
      const dist = stored(result).dist as Record<string, unknown>;
      expect(dist.shasum).toBe('a'.repeat(40));
      expect(dist.integrity).toBe(INTEGRITY);
      expect(result.input.metadata.npmIntegrity).toBe(INTEGRITY);
    });

    it('refuses null digests, an empty or non-string tarball and a token-only query', () => {
      expect(
        npmVersionInput(
          'left-pad',
          manifest({ dist: { tarball, integrity: null, shasum: null } }),
          TIME,
          origin,
        ),
      ).toEqual({ ok: false, reason: 'no_digest' });
      for (const bad of ['', 42, null]) {
        expect(
          npmVersionInput(
            'left-pad',
            manifest({ dist: { tarball: bad, shasum: SHASUM } }),
            TIME,
            origin,
          ),
        ).toEqual({ ok: false, reason: 'no_installable_reference' });
      }
      expect(
        npmVersionInput(
          'left-pad',
          manifest({ dist: { tarball: `${tarball}?token=abc`, shasum: SHASUM } }),
          TIME,
          origin,
        ),
      ).toEqual({ ok: false, reason: 'no_installable_reference' });
      expect(
        npmVersionInput(
          'left-pad',
          manifest({ dist: { tarball: `${tarball}?access_token=abc`, shasum: SHASUM } }),
          TIME,
          origin,
        ),
      ).toEqual({ ok: false, reason: 'invalid_metadata' });
    });

    it('derives hasInstallScript instead of trusting upstream', () => {
      const lying = stored(
        npmVersionInput(
          'left-pad',
          manifest({ hasInstallScript: true, scripts: { test: 'x' } }),
          TIME,
          origin,
        ),
      );
      expect(lying).not.toHaveProperty('hasInstallScript');
      for (const extra of [
        { scripts: { preinstall: 'x' } },
        { scripts: { install: 'x' } },
        { scripts: { postinstall: 'x' } },
        { gypfile: true },
      ]) {
        const json = stored(
          npmVersionInput(
            'left-pad',
            manifest({ hasInstallScript: false, ...extra }),
            TIME,
            origin,
          ),
        );
        expect(json.hasInstallScript).toBe(true);
      }
    });

    it('refuses nesting deeper than 32 levels', () => {
      let deep: unknown = 'leaf';
      for (let index = 0; index < 40; index += 1) deep = { a: deep };
      expect(npmVersionInput('left-pad', manifest({ exports: deep }), TIME, origin)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });

    it('handles scoped names', () => {
      ok(npmVersionInput('@scope/pkg', manifest({ name: '@scope/pkg' }), TIME, origin));
      expect(npmVersionInput('@scope/pkg', manifest({ name: '@other/pkg' }), TIME, origin)).toEqual(
        { ok: false, reason: 'foreign_name' },
      );
      expect(npmVersionInput('@scope/pkg', manifest({ name: 'pkg' }), TIME, origin)).toEqual({
        ok: false,
        reason: 'foreign_name',
      });
    });

    it('scrubs an _npmUser given as an array', () => {
      const result = ok(
        npmVersionInput(
          'left-pad',
          manifest({
            _npmUser: [{ name: 'alice', email: 'alice@example.com' }, 'bob@example.com'],
          }),
          TIME,
          origin,
        ),
      );
      expect(result.input.metadata.json).not.toContain('@example.com');
      expect(stored(result)._npmUser).toEqual([{ name: 'alice' }]);
    });

    it('rejects an import time that is not a real calendar date', () => {
      expect(() =>
        npmVersionInput('left-pad', manifest(), TIME, {
          ...origin,
          importedAt: '2026-02-30T00:00:00.000Z',
        }),
      ).toThrow(InvalidNpmOriginError);
    });
  });
});

it('retains publisher-reported npm and Node client information through normalization', () => {
  const metadata = stored(
    npmVersionInput(
      'left-pad',
      manifest({ _npmVersion: '11.17.0', _nodeVersion: '24.0.0' }),
      TIME,
      origin,
    ),
  );
  expect(metadata).toMatchObject({ _npmVersion: '11.17.0', _nodeVersion: '24.0.0' });
});
it.each(['_npmVersion', '_nodeVersion'])(
  'refuses credential echoes in %s client information',
  (field) => {
    expect(npmVersionInput('left-pad', manifest({ [field]: SECRET }), TIME, origin)).toEqual({
      ok: false,
      reason: 'credential_echo',
    });
  },
);
describe('npm VCS version input', () => {
  it('accepts a dist-less VCS manifest and retains its commit with no integrity', () => {
    const result = npmVersionInput(
      'left-pad',
      manifest({ dist: undefined }),
      {},
      { ...origin, kind: 'vcs' },
    );
    expect(result).toMatchObject({
      ok: true,
      input: { distType: 'tgz', sourceRef: 'b'.repeat(40), metadata: { npmIntegrity: null } },
    });
    expect(stored(result)).not.toHaveProperty('dist');
  });
  it('refuses dist-less registry manifests and VCS manifests without an immutable commit', () => {
    expect(npmVersionInput('left-pad', manifest({ dist: undefined }), {}, origin)).toMatchObject({
      ok: false,
      reason: 'no_installable_reference',
    });
    expect(
      npmVersionInput(
        'left-pad',
        manifest({ dist: undefined, gitHead: 'main' }),
        {},
        { ...origin, kind: 'vcs' },
      ),
    ).toMatchObject({ ok: false, reason: 'no_installable_reference' });
  });
});
