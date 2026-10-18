import { describe, expect, it } from 'vitest';
import { parseUiManifest } from './ui-manifest.js';

const valid = {
  version: 1,
  entry: 'index.html',
  files: {
    'index.html': { contentType: 'text/html', bytes: 120 },
    'app.0123456789ab.js': { contentType: 'text/javascript', bytes: 4000 },
    'app.0123456789ab.css': { contentType: 'text/css', bytes: 900 },
  },
};

function withFile(name: string, contentType = 'text/css'): string {
  return JSON.stringify({ ...valid, files: { ...valid.files, [name]: { contentType, bytes: 1 } } });
}

describe('parseUiManifest', () => {
  it('accepts a well-formed manifest', () => {
    const manifest = parseUiManifest(JSON.stringify(valid));
    expect(manifest.entry).toBe('index.html');
    expect(manifest.files['app.0123456789ab.js']).toEqual({
      contentType: 'text/javascript',
      bytes: 4000,
    });
  });

  it('refuses a parent-directory file name', () => {
    expect(() => parseUiManifest(withFile('../x.js', 'text/javascript'))).toThrow(/file name/);
  });

  it('refuses a file name with a slash', () => {
    expect(() => parseUiManifest(withFile('a/b.js', 'text/javascript'))).toThrow(/file name/);
  });

  it('refuses a file name with a backslash', () => {
    expect(() => parseUiManifest(withFile('a\\b.js', 'text/javascript'))).toThrow(/file name/);
  });

  it('refuses a file name containing two dots', () => {
    expect(() => parseUiManifest(withFile('a..js', 'text/javascript'))).toThrow(/file name/);
  });

  it('refuses a leading-dot file name', () => {
    expect(() => parseUiManifest(withFile('.hidden'))).toThrow(/file name/);
  });

  it.each(['__proto__', 'a\0.js', 'a:b.js', 'a b.js', '%2e%2e%2f'])(
    'refuses unsafe file name %s',
    (name) => {
      expect(() => parseUiManifest(withFile(name))).toThrow(/file name/);
    },
  );

  it('returns a file dictionary with no prototype', () => {
    expect(Object.getPrototypeOf(parseUiManifest(JSON.stringify(valid)).files)).toBeNull();
  });

  it.each([
    ['x.js', 'text/html'],
    ['x.css', 'text/javascript'],
    ['x.html', 'text/css'],
  ])('refuses mismatched content type for %s', (name, contentType) => {
    expect(() => parseUiManifest(withFile(name, contentType))).toThrow(/content type/);
  });

  it('refuses a content type outside the allowlist', () => {
    expect(() => parseUiManifest(withFile('x.bin', 'application/octet-stream'))).toThrow(
      /content type/,
    );
  });

  it('refuses a non-object body', () => {
    expect(() => parseUiManifest('[]')).toThrow(/object/);
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseUiManifest('nope')).toThrow(/JSON/);
  });

  it('refuses an unknown version', () => {
    expect(() => parseUiManifest(JSON.stringify({ ...valid, version: 2 }))).toThrow(/version/);
  });

  it('refuses an entry that is not a listed file', () => {
    expect(() => parseUiManifest(JSON.stringify({ ...valid, entry: 'missing.html' }))).toThrow(
      /entry/,
    );
  });

  it('refuses a negative byte count', () => {
    const body = JSON.stringify({
      ...valid,
      files: { 'index.html': { contentType: 'text/html', bytes: -1 } },
    });
    expect(() => parseUiManifest(body)).toThrow(/bytes/);
  });
});

describe('manifest shape guards', () => {
  it('refuses a non-string entry', () => {
    expect(() => parseUiManifest(JSON.stringify({ ...valid, entry: 1 }))).toThrow(
      /entry must be a string/,
    );
  });
  it('refuses non-object files', () => {
    expect(() => parseUiManifest(JSON.stringify({ ...valid, files: [] }))).toThrow(/files/);
  });
  it('refuses a non-object descriptor', () => {
    expect(() =>
      parseUiManifest(JSON.stringify({ ...valid, files: { 'index.html': [] } })),
    ).toThrow(/file.*object/);
  });
  it.each(['3', 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid bytes %s', (bytes) => {
    expect(() =>
      parseUiManifest(
        JSON.stringify({ ...valid, files: { 'index.html': { contentType: 'text/html', bytes } } }),
      ),
    ).toThrow(/bytes/);
  });
});
