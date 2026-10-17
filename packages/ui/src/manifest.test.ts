import { describe, expect, it } from 'vitest';
import { checkBudget, findInlineCode, parseUiManifest } from './manifest.js';

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

describe('findInlineCode', () => {
  const page = (body: string): string =>
    `<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body>${body}</body></html>`;

  it('accepts a page that only links files', () => {
    expect(
      findInlineCode(page('<div id="root"></div><script type="module" src="app.js"></script>')),
    ).toEqual([]);
  });

  it('flags an inline script', () => {
    expect(findInlineCode(page('<script>alert(1)</script>'))).toEqual(['inline script']);
  });

  it('flags an inline script injected beside a linked one', () => {
    const html = page('<script src="app.js"></script><script type="module">boot()</script>');
    expect(findInlineCode(html)).toEqual(['inline script']);
  });

  it('flags an inline script with data-src', () => {
    expect(findInlineCode(page('<script data-src="app.js">boot()</script>'))).toEqual([
      'inline script',
    ]);
  });

  it('flags an event handler attribute', () => {
    expect(findInlineCode(page('<button onclick="boot()">Go</button>'))).toEqual([
      'event handler attribute',
    ]);
  });

  it('flags a javascript URL', () => {
    expect(findInlineCode(page('<a href="javascript:boot()">Go</a>'))).toEqual(['javascript URL']);
  });

  it('flags a style element', () => {
    expect(findInlineCode(page('<style>a{color:red}</style>'))).toEqual(['style element']);
  });

  it('flags a style attribute', () => {
    expect(findInlineCode(page('<p style="color:red">x</p>'))).toEqual(['style attribute']);
  });
});

describe('checkBudget', () => {
  it('passes at the budget', () => {
    expect(checkBudget(1000, 1000)).toEqual({ ok: true, limit: 1100 });
  });

  it('passes at exactly +10%', () => {
    expect(checkBudget(1100, 1000).ok).toBe(true);
  });

  it('fails above +10%', () => {
    expect(checkBudget(1101, 1000)).toEqual({ ok: false, limit: 1100 });
  });
});
