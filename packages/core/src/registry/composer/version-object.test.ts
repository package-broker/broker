import { describe, expect, it } from 'vitest';
import { validateVersion } from '../../catalogue/versions.js';
import {
  composerVersionInput,
  InvalidComposerOriginError,
  MAX_RELEASE_SKEW_MS,
  MIN_COMPOSER_RELEASE_TIME,
  type ComposerVersionOrigin,
} from './version-object.js';

const ORIGIN: ComposerVersionOrigin = {
  probe: { secrets: ['s3cr3t-token-value'], queryParams: ['access_token'] },
  importedAt: '2026-10-16T08:00:00.000Z',
};
const KEY = 'acme/widget';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'acme/widget',
    version: '1.2.0',
    version_normalized: '1.2.0.0',
    time: '2024-05-06T07:08:09+00:00',
    dist: {
      type: 'zip',
      url: 'https://example.test/widget-1.2.0.zip',
      reference: 'abc123',
      shasum: '',
    },
    source: { type: 'git', url: 'https://example.test/widget.git', reference: 'abc123' },
    license: ['MIT'],
    ...overrides,
  };
}

function ok(object: Record<string, unknown>, origin = ORIGIN) {
  const result = composerVersionInput(KEY, object, origin);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.input;
}

function metadata(object: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(ok(object).metadata.json) as Record<string, unknown>;
}

describe('composerVersionInput', () => {
  it('drops root-only and bookkeeping keys', () => {
    const stored = metadata(
      raw({
        uid: 12345,
        'notification-url': 'https://packagist.org/downloads/',
        'installation-source': 'dist',
        config: { x: 1 },
        scripts: { post: 'x' },
        repositories: [],
        'minimum-stability': 'dev',
        'prefer-stable': true,
      }),
    );
    for (const key of [
      'uid',
      'notification-url',
      'installation-source',
      'config',
      'scripts',
      'repositories',
      'minimum-stability',
      'prefer-stable',
    ]) {
      expect(stored).not.toHaveProperty(key);
    }
  });

  it('drops source when a dist exists and keeps it otherwise', () => {
    expect(metadata(raw())).not.toHaveProperty('source');
    const withoutDist = raw();
    delete withoutDist.dist;
    const input = ok(withoutDist);
    expect(JSON.parse(input.metadata.json)).toHaveProperty('source');
    expect(input.distType).toBeNull();
    expect(input.sourceRef).toBe('abc123');
  });

  it('keeps extra untouched', () => {
    const extra = { 'branch-alias': { 'dev-main': '1.x-dev' }, custom: [1, 2] };
    expect(metadata(raw({ extra })).extra).toEqual(extra);
  });

  it('skips foreign-named objects', () => {
    expect(composerVersionInput(KEY, raw({ name: 'evil/widget' }), ORIGIN)).toEqual({
      ok: false,
      reason: 'foreign_name',
    });
    const nameless = raw();
    delete nameless.name;
    expect(composerVersionInput(KEY, nameless, ORIGIN)).toEqual({
      ok: false,
      reason: 'foreign_name',
    });
  });

  it('matches names case-insensitively as the key', () => {
    expect(composerVersionInput(KEY, raw({ name: 'Acme/Widget' }), ORIGIN).ok).toBe(true);
  });

  it('derives dev stability for dev-main and RC for 1.2.0-RC1', () => {
    const dev = ok(raw({ version: 'dev-main', version_normalized: 'dev-main' }));
    expect(dev.versionNormalized).toBe('dev-main');
    expect(
      validateVersion({
        ecosystem: 'composer',
        version: dev.version,
        versionNormalized: dev.versionNormalized,
      }).stability,
    ).toBe('dev');
    const rc = ok(raw({ version: '1.2.0-RC1', version_normalized: '1.2.0.0-RC1' }));
    expect(
      validateVersion({
        ecosystem: 'composer',
        version: rc.version,
        versionNormalized: rc.versionNormalized,
      }).stability,
    ).toBe('RC');
  });

  it('skips on normalized_mismatch', () => {
    expect(composerVersionInput(KEY, raw({ version_normalized: '1.3.0.0' }), ORIGIN)).toEqual({
      ok: false,
      reason: 'normalized_mismatch',
    });
  });

  it('computes version_normalized when upstream omits it', () => {
    const object = raw();
    delete object.version_normalized;
    expect(ok(object).versionNormalized).toBe('1.2.0.0');
  });

  it('skips an unparseable version', () => {
    const result = composerVersionInput(KEY, raw({ version: 'not a version' }), ORIGIN);
    expect(result).toEqual({ ok: false, reason: 'invalid_version' });
  });

  it('maps time to the release date and history candidate', () => {
    const input = ok(raw());
    expect(input.upstreamReleasedAt).toBe('2024-05-06T07:08:09.000Z');
    expect(input.history).toEqual({ basis: 'release_date', at: '2024-05-06T07:08:09.000Z' });
  });

  it('falls back to import_time without a usable time', () => {
    const missing = raw();
    delete missing.time;
    for (const object of [missing, raw({ time: 'garbage' })]) {
      const input = ok(object);
      expect(input.upstreamReleasedAt).toBeNull();
      expect(input.history).toEqual({
        basis: 'import_time',
        at: ORIGIN.importedAt,
        noOtherDate: true,
      });
    }
  });

  it('extracts dist type, licence and sha1', () => {
    const sha = 'a'.repeat(40);
    const input = ok(
      raw({
        dist: { type: 'tar', url: 'https://example.test/w.tar', reference: 'r', shasum: sha },
      }),
    );
    expect(input.distType).toBe('tar');
    expect(input.metadata.composerShasum).toBe(sha);
    expect(input.license).toBe('["MIT"]');
  });

  it('treats an unsupported dist type as no dist', () => {
    const input = ok(raw({ dist: { type: 'path', url: 'https://example.test/x' } }));
    expect(input.distType).toBeNull();
    expect(input.metadata.json).not.toContain('"dist"');
  });

  it('refuses a malformed shasum', () => {
    const result = composerVersionInput(
      KEY,
      raw({ dist: { type: 'zip', url: 'https://example.test/w.zip', shasum: 'xyz' } }),
      ORIGIN,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_metadata' });
  });

  it('refuses tokenized dist URLs', () => {
    const result = composerVersionInput(
      KEY,
      raw({ dist: { type: 'zip', url: 'https://example.test/w.zip?token=abc' } }),
      ORIGIN,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_metadata' });
  });

  it('strips an echoed credential from dist url and then drops the dist', () => {
    const input = ok(
      raw({
        dist: {
          type: 'zip',
          url: 'https://example.test/w.zip?k=s3cr3t-token-value',
          reference: 'r',
        },
      }),
    );
    expect(input.distType).toBeNull();
    expect(input.metadata.json).not.toContain('s3cr3t');
    expect(input.metadata.json).toContain('"source"');
  });

  it('refuses a credential echoed in a non-URL field', () => {
    const result = composerVersionInput(KEY, raw({ description: 'x s3cr3t-token-value' }), ORIGIN);
    expect(result).toEqual({ ok: false, reason: 'credential_echo' });
  });

  it('does not mutate its input', () => {
    const object = raw({ uid: 1 });
    const before = JSON.stringify(object);
    ok(object);
    expect(JSON.stringify(object)).toBe(before);
  });

  it('refuses non-object input', () => {
    expect(composerVersionInput(KEY, [] as unknown, ORIGIN)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('treats a non-string or 9999999-dev version_normalized as absent', () => {
    expect(ok(raw({ version_normalized: 5 })).versionNormalized).toBe('1.2.0.0');
    expect(ok(raw({ version_normalized: '9999999-dev' })).versionNormalized).toBe('1.2.0.0');
    expect(metadata(raw({ version_normalized: 5 }))).not.toHaveProperty('version_normalized');
  });

  it('parses time strictly', () => {
    const at = (time: string) => ok(raw({ time })).upstreamReleasedAt;
    expect(at('2024-05-06 07:08:09')).toBe('2024-05-06T07:08:09.000Z');
    expect(at('2024-05-06T07:08:09.5Z')).toBe('2024-05-06T07:08:09.500Z');
    expect(at('2024-05-06T07:08:09+02:00')).toBe('2024-05-06T05:08:09.000Z');
    expect(at('2024-05-06T07:08:09-01:30')).toBe('2024-05-06T08:38:09.000Z');
    expect(at('1715000000')).toBe('2024-05-06T12:53:20.000Z');
    for (const bad of [
      'May 6 2024',
      '2024-05-06',
      '2024-02-30T00:00:00Z',
      '2024-13-01T00:00:00Z',
      '2024-05-06T24:00:00Z',
      '2024-05-06T07:08:09+25:00',
    ]) {
      expect(at(bad)).toBeNull();
    }
  });

  it('does not depend on the process time zone for offset-less times', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      expect(ok(raw({ time: '2024-05-06 07:08:09' })).upstreamReleasedAt).toBe(
        '2024-05-06T07:08:09.000Z',
      );
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('keeps only package-schema keys', () => {
    const stored = metadata(raw({ 'x-secret-ish': 1, _comment: 'a', abandoned: true }));
    expect(stored).not.toHaveProperty('x-secret-ish');
    expect(stored).not.toHaveProperty('_comment');
    expect(stored.abandoned).toBe(true);
  });

  it('rebuilds dist from four fields', () => {
    const stored = metadata(
      raw({
        dist: {
          type: 'zip',
          url: 'https://example.test/w.zip',
          reference: 'r',
          shasum: '',
          mirrors: [{ url: 'https://m.test/{name}' }],
          extra: 1,
        },
      }),
    );
    expect(Object.keys(stored.dist as object).sort()).toEqual([
      'reference',
      'shasum',
      'type',
      'url',
    ]);
  });

  it('skips a version without dist or source', () => {
    const object = raw();
    delete object.source;
    delete object.dist;
    expect(composerVersionInput(KEY, object, ORIGIN)).toEqual({
      ok: false,
      reason: 'no_installable_reference',
    });
  });

  it('reads sourceRef from the normalized metadata', () => {
    expect(ok(raw()).sourceRef).toBe('abc123');
  });

  it('reports stripped URL fields and the source-only fallback', () => {
    const result = composerVersionInput(
      KEY,
      raw({
        dist: { type: 'zip', url: 'https://example.test/w.zip?access_token=zzz', reference: 'r' },
      }),
      ORIGIN,
    );
    expect(result.ok && result.stripped).toBe(1);
    expect(result.ok && result.input.distType).toBeNull();
    const clean = composerVersionInput(KEY, raw(), ORIGIN);
    expect(clean.ok && clean.stripped).toBe(0);
  });

  it('strips an echoed source url and keeps the dist', () => {
    const result = composerVersionInput(
      KEY,
      raw({ source: { type: 'git', url: 'https://example.test/w.git?k=s3cr3t-token-value' } }),
      ORIGIN,
    );
    expect(result.ok && result.stripped).toBe(1);
    expect(result.ok && result.input.distType).toBe('zip');
  });

  it('runs the echo check before name matching', () => {
    expect(composerVersionInput(KEY, raw({ name: 'evil/s3cr3t-token-value' }), ORIGIN)).toEqual({
      ok: false,
      reason: 'credential_echo',
    });
  });

  describe('release date bounds', () => {
    const importedMs = Date.parse(ORIGIN.importedAt);
    const fellBack = (time: string) => {
      const input = ok(raw({ time }));
      expect(input.upstreamReleasedAt).toBeNull();
      expect(input.history).toEqual({
        basis: 'import_time',
        at: ORIGIN.importedAt,
        noOtherDate: true,
      });
    };

    it('exports the bounds', () => {
      expect(MAX_RELEASE_SKEW_MS).toBe(24 * 60 * 60 * 1000);
      expect(MIN_COMPOSER_RELEASE_TIME).toBe('2011-01-01T00:00:00.000Z');
    });

    it('keeps importedAt plus 24 h and falls back one millisecond later', () => {
      const edge = new Date(importedMs + MAX_RELEASE_SKEW_MS).toISOString();
      expect(ok(raw({ time: edge })).upstreamReleasedAt).toBe(edge);
      fellBack(new Date(importedMs + MAX_RELEASE_SKEW_MS + 1).toISOString());
    });

    it('applies the upper bound to Unix-seconds times', () => {
      const edgeSeconds = (importedMs + MAX_RELEASE_SKEW_MS) / 1000;
      expect(ok(raw({ time: String(edgeSeconds) })).upstreamReleasedAt).toBe(
        new Date(edgeSeconds * 1000).toISOString(),
      );
      fellBack(String(edgeSeconds + 1));
    });

    it('keeps the lower bound and falls back before it', () => {
      expect(ok(raw({ time: '2011-01-01T00:00:00Z' })).upstreamReleasedAt).toBe(
        MIN_COMPOSER_RELEASE_TIME,
      );
      fellBack('2010-12-31T23:59:59Z');
      fellBack('1970-01-01T00:00:00Z');
      fellBack('0');
    });

    it('falls back for a far-future year', () => {
      fellBack('9999-12-31T23:59:59Z');
    });
  });

  it('ignores a credential echo in a field outside the allowlist', () => {
    const result = composerVersionInput(
      KEY,
      raw({
        'notification-url': 'https://example.test/n?access_token=zzz',
        'installation-source': 's3cr3t-token-value',
      }),
      ORIGIN,
    );
    expect(result.ok && result.stripped).toBe(0);
  });

  it('counts an echo stripped from an allowlisted field', () => {
    const result = composerVersionInput(
      KEY,
      raw({ support: { source: 'https://example.test/s?access_token=zzz' } }),
      ORIGIN,
    );
    expect(result.ok && result.stripped).toBe(1);
    expect(result.ok && result.input.metadata.json).not.toContain('zzz');
  });

  it('rejects a non-canonical importedAt', () => {
    expect(() => composerVersionInput(KEY, raw(), { ...ORIGIN, importedAt: '2026-10-16' })).toThrow(
      InvalidComposerOriginError,
    );
  });

  it('skips oversized and over-deep objects', () => {
    expect(composerVersionInput(KEY, raw({ description: 'x'.repeat(300000) }), ORIGIN)).toEqual({
      ok: false,
      reason: 'too_large',
    });
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) deep = { a: deep };
    expect(composerVersionInput(KEY, raw({ extra: deep }), ORIGIN)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('is deterministic under key reordering', () => {
    const forward = raw();
    const reversed = Object.fromEntries(Object.entries(forward).reverse());
    expect(ok(reversed).metadata.json).toBe(ok(forward).metadata.json);
  });
});
