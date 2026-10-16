import { describe, expect, it, vi } from 'vitest';
import {
  MAX_METADATA_BYTES,
  MetadataError,
  MetadataTooLargeError,
  canonicalJson,
  normalizeVersionMetadata,
} from './metadata.js';

const byteLength = (text: string) => new TextEncoder().encode(text).length;
const SHA1 = 'a'.repeat(40);
const SHA512 = `sha512-${'A'.repeat(86)}==`;
const SHA1_SRI = `sha1-${'B'.repeat(27)}=`;

function npm(extra: Record<string, unknown> = {}, dist: Record<string, unknown> = {}) {
  return {
    name: 'left-pad',
    version: '1.0.0',
    dist: { tarball: 'https://registry.example/left-pad-1.0.0.tgz', ...dist },
    ...extra,
  };
}

function composer(extra: Record<string, unknown> = {}, dist: Record<string, unknown> = {}) {
  return {
    name: 'a/b',
    version: '1.0.0',
    dist: { type: 'zip', url: 'https://dist.example/a/b.zip', shasum: '', ...dist },
    ...extra,
  };
}

describe('canonical JSON', () => {
  it('normalizes key order and whitespace identically', () => {
    const a = normalizeVersionMetadata('npm', npm({ x: { b: 1, a: [1, 2] }, y: 'z' }));
    const b = normalizeVersionMetadata(
      'npm',
      JSON.parse(
        ' { "y":"z", "x": { "a":[1,2], "b":1 }, "version":"1.0.0", "name":"left-pad", "dist":{"tarball":"https://registry.example/left-pad-1.0.0.tgz"} } ',
      ),
    );
    expect(a.json).toBe(b.json);
    expect(a.json).not.toMatch(/\s/);
    expect(a.json.indexOf('"dist"')).toBeLessThan(a.json.indexOf('"name"'));
  });

  it('refuses non-finite numbers', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(MetadataError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(MetadataError);
  });

  it('accepts depth 32 and refuses depth 33', () => {
    const nest = (n: number): unknown => (n === 1 ? {} : { a: nest(n - 1) });
    expect(() => canonicalJson(nest(32))).not.toThrow();
    expect(() => canonicalJson(nest(33))).toThrow(MetadataError);
  });

  it('refuses non-plain values', () => {
    expect(() => canonicalJson({ a: new Date() })).toThrow(MetadataError);
    expect(() => canonicalJson({ a: new Map() })).toThrow(MetadataError);
    expect(() => canonicalJson(new (class X {})())).toThrow(MetadataError);
    expect(() => canonicalJson({ a: undefined })).toThrow(MetadataError);
    expect(() => canonicalJson({ a: 1n })).toThrow(MetadataError);
  });

  it('refuses cycles', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(MetadataError);
  });
});

describe('npm fields', () => {
  it('drops readme and moves deprecated', () => {
    const r = normalizeVersionMetadata(
      'npm',
      npm({ readme: 'long', readmeFilename: 'README.md', deprecated: 'use other' }),
    );
    expect(r.json).not.toContain('readme');
    expect(r.json).not.toContain('deprecated');
    expect(r.deprecatedMessage).toBe('use other');
  });

  it('leaves deprecatedMessage null when absent', () => {
    expect(normalizeVersionMetadata('npm', npm()).deprecatedMessage).toBeNull();
  });
});

describe('licence', () => {
  it('extracts a string raw', () => {
    expect(normalizeVersionMetadata('composer', composer({ license: 'MIT' })).license).toBe('MIT');
  });

  it('serializes an array as canonical JSON text', () => {
    expect(
      normalizeVersionMetadata('composer', composer({ license: ['MIT', 'GPL-2.0'] })).license,
    ).toBe('["MIT","GPL-2.0"]');
  });

  it('is null when absent', () => {
    expect(normalizeVersionMetadata('composer', composer()).license).toBeNull();
  });
});

describe('dist URLs', () => {
  it.each([
    'https://user:pass@h.example/x.zip',
    'https://tok@h.example/x.zip',
    'git+ssh://git@h.example/x.git',
    'ftp://h.example/x.zip',
    'file:///etc/passwd',
    'not a url',
    'https://h.example/x.zip?token=1',
    'https://h.example/x.zip?Access_Token=1',
    'https://h.example/x.zip?a=1&X-AMZ-SIGNATURE=1',
    'https://h.example/x.zip?x-amz-credential=1',
    'https://h.example/x.zip?X-Goog-Signature=1',
    'https://h.example/x.zip?private_token=1',
    'https://h.example/x.zip?auth=1',
    'https://h.example/x.zip?KEY=1',
    'https://h.example/x.zip?sig=1',
    'https://h.example/x.zip?signature=1',
  ])('refuses composer dist %s without echoing it', (url) => {
    try {
      normalizeVersionMetadata('composer', composer({}, { url }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MetadataError);
      expect((error as Error).message).not.toContain('h.example');
      expect((error as Error).message).not.toContain('pass');
    }
  });

  it('refuses npm tarball and composer mirrors', () => {
    expect(() =>
      normalizeVersionMetadata('npm', npm({}, { tarball: 'https://u:p@h.example/t.tgz' })),
    ).toThrow(MetadataError);
    expect(() =>
      normalizeVersionMetadata(
        'composer',
        composer({}, { mirrors: [{ url: 'https://h.example/m.zip?token=x', preferred: true }] }),
      ),
    ).toThrow(MetadataError);
  });

  it('accepts a clean url with an unrelated query', () => {
    expect(() =>
      normalizeVersionMetadata('composer', composer({}, { url: 'http://h.example/x.zip?v=2' })),
    ).not.toThrow();
  });
});

describe('composer source block', () => {
  const source = (url: string) => composer({ source: { type: 'git', url, reference: 'abc' } });

  it.each([
    'https://github.com/a/b.git',
    'http://github.com/a/b.git',
    'git://github.com/a/b.git',
    'ssh://git@github.com/a/b.git',
    'git@github.com:a/b.git',
  ])('keeps %s', (url) => {
    expect(normalizeVersionMetadata('composer', source(url)).json).toContain('"source"');
  });

  it.each([
    'https://user:pass@github.com/a/b.git',
    'ssh://deploy:pw@github.com/a/b.git',
    'ssh://deploy@github.com/a/b.git',
    'deploy@github.com:a/b.git',
    'ftp://github.com/a/b.git',
    'git+ssh://git@github.com/a/b.git',
    'garbage',
  ])('drops %s and accepts the version', (url) => {
    const r = normalizeVersionMetadata('composer', source(url));
    expect(r.json).not.toContain('"source"');
    expect(r.json).toContain('"dist"');
  });
});

describe('digests', () => {
  it('accepts empty and 40 hex composer shasum', () => {
    expect(normalizeVersionMetadata('composer', composer()).composerShasum).toBeNull();
    expect(
      normalizeVersionMetadata('composer', composer({}, { shasum: SHA1 })).composerShasum,
    ).toBe(SHA1);
  });

  it.each(['abc', 'g'.repeat(40), 'a'.repeat(41), 5])('refuses composer shasum %s', (shasum) => {
    expect(() => normalizeVersionMetadata('composer', composer({}, { shasum }))).toThrow(
      MetadataError,
    );
  });

  it('accepts multi-hash SRI', () => {
    const integrity = `${SHA1_SRI} ${SHA512}`;
    const r = normalizeVersionMetadata('npm', npm({}, { integrity, shasum: SHA1 }));
    expect(r.npmIntegrity).toBe(integrity);
  });

  it('accepts sha512 plus other algorithms', () => {
    expect(
      normalizeVersionMetadata('npm', npm({}, { integrity: `sha256-${'A'.repeat(43)}= ${SHA512}` }))
        .npmIntegrity,
    ).not.toBeNull();
  });

  it.each([
    '',
    'sha512-short',
    'md5-AAAA',
    `sha256-${'A'.repeat(43)}=`,
    `${SHA512} garbage`,
    `sha512-${'A'.repeat(86)}`,
    42,
  ])('refuses npm integrity %s', (integrity) => {
    expect(() => normalizeVersionMetadata('npm', npm({}, { integrity }))).toThrow(MetadataError);
  });

  it.each(['abc', 'z'.repeat(40), 7])('refuses npm shasum %s', (shasum) => {
    expect(() => normalizeVersionMetadata('npm', npm({}, { shasum }))).toThrow(MetadataError);
  });
});

describe('size cap', () => {
  function padded(target: number) {
    const base = normalizeVersionMetadata('npm', npm({ pad: '' })).json;
    const filler = 'x'.repeat(target - byteLength(base));
    return npm({ pad: filler });
  }

  it('passes at the cap and throws one byte over', () => {
    expect(MAX_METADATA_BYTES).toBe(262144);
    expect(byteLength(normalizeVersionMetadata('npm', padded(262144)).json)).toBe(262144);
    expect(() => normalizeVersionMetadata('npm', padded(262145))).toThrow(MetadataTooLargeError);
  });

  it('counts UTF-8 bytes, not characters', () => {
    const base = byteLength(normalizeVersionMetadata('npm', npm({ pad: '' })).json);
    const chars = Math.floor((262144 - base) / 3) + 1;
    expect(() => normalizeVersionMetadata('npm', npm({ pad: '€'.repeat(chars) }))).toThrow(
      MetadataTooLargeError,
    );
  });

  it('counts after normalization', () => {
    expect(() =>
      normalizeVersionMetadata('npm', npm({ readme: 'x'.repeat(300000) })),
    ).not.toThrow();
  });
});

describe('canonical JSON hardening', () => {
  it('runs without the Buffer global', () => {
    vi.stubGlobal('Buffer', undefined);
    try {
      expect(() => normalizeVersionMetadata('npm', npm())).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops own __proto__ keys at every level but keeps constructor', () => {
    const input = JSON.parse(
      '{"name":"a","__proto__":{"x":1},"n":{"__proto__":{"y":1},"constructor":"c"}}',
    ) as unknown;
    const json = normalizeVersionMetadata('npm', input).json;
    expect(json).not.toContain('__proto__');
    expect(json).toContain('"constructor":"c"');
  });

  it('refuses sparse arrays', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson({ a: [1, , 3] })).toThrow(MetadataError);
  });

  it('wraps hostile objects in MetadataError', () => {
    const getter = {
      get boom(): string {
        throw new Error('secret');
      },
    };
    expect(() => normalizeVersionMetadata('npm', getter)).toThrow(MetadataError);
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('secret');
        },
      },
    );
    expect(() => canonicalJson({ a: proxy })).toThrow(MetadataError);
  });
});

describe('dist URL edge cases', () => {
  it.each([
    'https://h.example/x.zip?a=1;token=S',
    'https://h.example/x.zip?token[]=S',
    'https://h.example/x.zip?%74oken=S',
    'https://h.example/x.zip?access_token[0]=S',
    'https://h.example/x.zip?%20token=S',
    'https://h.example/x.zip?token+=S',
    'https://h.example/x.zip?access.token=S',
    'https://h.example/x.zip?token%=S',
    'https://h.example/x.zip#frag',
    `https://h.example/${'a'.repeat(4100)}`,
  ])('refuses dist %s', (url) => {
    expect(() => normalizeVersionMetadata('composer', composer({}, { url }))).toThrow(
      MetadataError,
    );
  });

  it('treats dist null as absent', () => {
    expect(() => normalizeVersionMetadata('composer', composer({ dist: null }))).not.toThrow();
  });
});

describe('composer source edge cases', () => {
  it.each([
    'https://github.com/a/b.git#token=S',
    'https://github.com/a/b.git?a=1;token=S',
    'git@github.com:a/b.git?x=1',
    'git@github.com:a/b.git#token=S',
    'https://github.com/a/b.git?token%=S',
    'https://github.com/a/b.git?access.token=S',
    `https://github.com/${'a'.repeat(4100)}`,
  ])('drops source %s', (url) => {
    const r = normalizeVersionMetadata('composer', composer({ source: { type: 'git', url } }));
    expect(r.json).not.toContain('"source"');
  });
});

describe('digest shapes', () => {
  it.each([
    `sha512-${'A'.repeat(87)}=`,
    `sha512-${'A'.repeat(86)}=A`,
    `sha384-${'A'.repeat(64)}=`,
    `sha256-${'A'.repeat(42)}==`,
    `sha1-${'A'.repeat(28)}`,
  ])('refuses inexact SRI shape %s', (integrity) => {
    expect(() => normalizeVersionMetadata('npm', npm({}, { integrity }))).toThrow(MetadataError);
  });

  it('accepts exact SRI shapes and normalizes whitespace', () => {
    const r = normalizeVersionMetadata(
      'npm',
      npm({}, { integrity: `  ${SHA1_SRI}\n\t ${SHA512}  ` }),
    );
    expect(r.npmIntegrity).toBe(`${SHA1_SRI} ${SHA512}`);
  });

  it('lowercases composerShasum', () => {
    expect(
      normalizeVersionMetadata('composer', composer({}, { shasum: 'A'.repeat(40) })).composerShasum,
    ).toBe('a'.repeat(40));
  });
});

describe('licence edge cases', () => {
  it('licence edge cases', () => {
    expect(normalizeVersionMetadata('npm', npm({ license: '' })).license).toBeNull();
    expect(
      normalizeVersionMetadata('npm', npm({ license: { type: 'MIT', url: 'u' } })).license,
    ).toBe('MIT');
    expect(
      normalizeVersionMetadata('npm', npm({ licenses: [{ type: 'MIT' }, { type: 'ISC' }] }))
        .license,
    ).toBe('["MIT","ISC"]');
    expect(
      normalizeVersionMetadata('npm', npm({ licenses: ['MIT', { type: 'ISC' }, ''] })).license,
    ).toBe('["MIT","ISC"]');
  });
});

describe('npm deprecation', () => {
  it('removes a non-string deprecated without a message', () => {
    const r = normalizeVersionMetadata('npm', npm({ deprecated: true }));
    expect(r.json).not.toContain('deprecated');
    expect(r.deprecatedMessage).toBeNull();
  });
});
