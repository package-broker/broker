import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { credentialEchoProbe, parseCredentialMaterial } from './credentials.js';
import { stripCredentialEcho } from './credential-echo.js';

const SECRET = 'sup3r-s3cret-value';
const probe = credentialEchoProbe(
  parseCredentialMaterial('query', JSON.stringify({ param: 'api_key', value: SECRET })),
);
const headerProbe = credentialEchoProbe(
  parseCredentialMaterial('bearer', JSON.stringify({ token: SECRET })),
);

const clean = () => ({
  name: 'acme/widget',
  version: '1.2.3',
  description: 'A widget',
  dist: { type: 'zip', url: 'https://repo.example.com/dist/widget-1.2.3.zip', shasum: 'abc' },
  source: { type: 'git', url: 'https://github.com/acme/widget.git' },
  mirrors: [{ url: 'https://mirror.example.com/widget.zip', preferred: true }],
  support: { issues: 'https://github.com/acme/widget/issues' },
  homepage: 'https://acme.example.com',
  require: { php: '>=8.1' },
});

describe('stripCredentialEcho', () => {
  it('drops a dist url that carries the bound query parameter', () => {
    const input = clean();
    input.dist.url = `https://repo.example.com/dist/w.zip?api_key=${SECRET}`;
    const result = stripCredentialEcho(input, probe);
    if (result.refused) throw new Error('refused');
    expect(result.stripped).toEqual(['$.dist.url']);
    expect(result.object).toEqual({ ...clean(), dist: { type: 'zip', shasum: 'abc' } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('drops a url with the bound parameter name even when the value differs', () => {
    const input = clean();
    input.source.url = 'https://git.example.com/w.git?api_key=other-value';
    const result = stripCredentialEcho(input, probe);
    if (result.refused) throw new Error('refused');
    expect(result.stripped).toEqual(['$.source.url']);
  });

  it('drops mirrors, support and homepage urls and keeps the rest', () => {
    const input = clean();
    input.mirrors[0]!.url = `https://m.example.com/w.zip?x=1&api_key=${SECRET}`;
    input.support.issues = `https://h.example.com/i?t=${encodeURIComponent(SECRET)}`;
    input.homepage = `https://${SECRET}.example.com`;
    const result = stripCredentialEcho(input, probe);
    if (result.refused) throw new Error('refused');
    expect([...result.stripped].sort()).toEqual(
      ['$.homepage', '$.mirrors[0].url', '$.support.issues'].sort(),
    );
    expect((result.object as ReturnType<typeof clean>).dist.url).toBe(clean().dist.url);
  });

  it('drops a url that carries the secret in its path under a header credential', () => {
    const input = clean();
    input.dist.url = `https://repo.example.com/${SECRET}/w.zip`;
    const result = stripCredentialEcho(input, headerProbe);
    if (result.refused) throw new Error('refused');
    expect(result.stripped).toEqual(['$.dist.url']);
  });

  it('refuses a version whose description carries the secret', () => {
    const input = { ...clean(), description: `token ${SECRET} inside` };
    const result = stripCredentialEcho(input, probe);
    expect(result.refused).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('refuses a secret inside a nested array element or an object key', () => {
    const nested = { ...clean(), keywords: ['a', [`x${SECRET}`]] };
    expect(stripCredentialEcho(nested, probe).refused).toBe(true);
    const keyed = { ...clean(), extra: { [SECRET]: 1 } };
    const result = stripCredentialEcho(keyed, probe);
    expect(result.refused).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('never stores a refused version in the catalogue fixture', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE version (id INTEGER PRIMARY KEY, metadata TEXT NOT NULL)');
    const store = (candidate: unknown): void => {
      const result = stripCredentialEcho(candidate, probe);
      if (result.refused) return;
      db.prepare('INSERT INTO version (metadata) VALUES (?)').run(JSON.stringify(result.object));
    };
    store({ ...clean(), description: `leak ${SECRET}` });
    const echoed = clean();
    echoed.dist.url = `https://repo.example.com/w.zip?api_key=${SECRET}`;
    store(echoed);
    store(clean());
    const rows = db.prepare('SELECT metadata FROM version').all() as { metadata: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.metadata).not.toContain(SECRET);
    db.close();
  });

  it('returns objects without probed values unchanged and does not mutate the input', () => {
    const input = clean();
    const snapshot = structuredClone(input);
    const result = stripCredentialEcho(input, probe);
    expect(result).toEqual({ refused: false, object: snapshot, stripped: [] });
    expect(input).toEqual(snapshot);
  });

  it('passes everything through for an empty probe', () => {
    const input = clean();
    input.dist.url = 'https://repo.example.com/w.zip?api_key=anything';
    const result = stripCredentialEcho(input, { secrets: [], queryParams: [] });
    expect(result).toEqual({ refused: false, object: input, stripped: [] });
  });

  it('keeps an own __proto__ key as data', () => {
    const input = JSON.parse('{"name":"a/b","__proto__":{"polluted":true}}') as object;
    const result = stripCredentialEcho(input, probe);
    if (result.refused) throw new Error('refused');
    expect(Object.getPrototypeOf(result.object)).toBe(Object.prototype);
    expect(Object.hasOwn(result.object, '__proto__')).toBe(true);
  });

  it('refuses objects nested deeper than 32 levels', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    expect(stripCredentialEcho(deep, probe)).toEqual({ refused: true, reason: 'malformed' });
    let ok: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 30; i += 1) ok = { child: ok };
    expect(stripCredentialEcho(ok, probe).refused).toBe(false);
  });

  it('refuses a non-object input', () => {
    const expected = { refused: true, reason: 'malformed' };
    expect(stripCredentialEcho(null, probe)).toEqual(expected);
    expect(stripCredentialEcho('text', probe)).toEqual(expected);
  });

  it('reports a refusal without an object', () => {
    const result = stripCredentialEcho({ ...clean(), description: SECRET }, probe);
    expect(result).toEqual({ refused: true, reason: 'credential_echo' });
  });

  it('catches a percent-encoded password in url userinfo', () => {
    const password = 'p@ss:w/rd+1=x';
    const basic = credentialEchoProbe(
      parseCredentialMaterial('http_basic', JSON.stringify({ username: 'u', password })),
    );
    const input = clean();
    input.dist.url = `https://u:${encodeURIComponent(password)}@repo.example.com/w.zip`;
    input.source.url = `https://u:${encodeURIComponent(password).toLowerCase()}@git.example.com/w.git`;
    const result = stripCredentialEcho(input, basic);
    if (result.refused) throw new Error('refused');
    expect([...result.stripped].sort()).toEqual(['$.dist.url', '$.source.url']);
  });

  it('catches a bearer token with + / = echoed percent-encoded under another parameter', () => {
    const token = 'ab+cd/ef=gh1234';
    const bearer = credentialEchoProbe(
      parseCredentialMaterial('bearer', JSON.stringify({ token })),
    );
    const input = clean();
    input.dist.url = `https://repo.example.com/w.zip?t=${encodeURIComponent(token)}`;
    const result = stripCredentialEcho(input, bearer);
    if (result.refused) throw new Error('refused');
    expect(result.stripped).toEqual(['$.dist.url']);
    expect(stripCredentialEcho({ ...clean(), description: `x%2b${'cd'}` }, bearer).refused).toBe(
      false,
    );
    const basic = credentialEchoProbe(
      parseCredentialMaterial(
        'http_basic',
        JSON.stringify({ username: 'u', password: 'pa ss word1' }),
      ),
    );
    const form = stripCredentialEcho({ ...clean(), description: 'pa+ss+word1' }, basic);
    expect(form.refused).toBe(true);
  });

  it('catches a query secret encoded with lowercase hex and double encoding', () => {
    const value = 'ab+cd/ef=gh1234';
    const query = credentialEchoProbe(
      parseCredentialMaterial('query', JSON.stringify({ param: 'api_key', value })),
    );
    const lower = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    expect(stripCredentialEcho({ ...clean(), description: lower }, query).refused).toBe(true);
    const twice = encodeURIComponent(encodeURIComponent(value));
    expect(stripCredentialEcho({ ...clean(), description: twice }, query).refused).toBe(true);
  });

  it('compares case-folded and matches parameter names case-insensitively', () => {
    expect(
      stripCredentialEcho({ ...clean(), description: SECRET.toUpperCase() }, probe).refused,
    ).toBe(true);
    const input = clean();
    input.dist.url = 'https://repo.example.com/w.zip?API_KEY=zzz';
    const result = stripCredentialEcho(input, probe);
    if (result.refused) throw new Error('refused');
    expect(result.stripped).toEqual(['$.dist.url']);
  });

  it('never puts the secret into stripped paths', () => {
    const input = clean();
    input.dist.url = `https://repo.example.com/${SECRET}/w.zip`;
    expect(stripCredentialEcho({ ...input, [`k${SECRET}`]: 1 }, probe).refused).toBe(true);
    const result = stripCredentialEcho(input, probe);
    if (result.refused) throw new Error('refused');
    expect(JSON.stringify(result.stripped).toLowerCase()).not.toContain(SECRET);
  });

  it('refuses a secret inside a support array instead of stripping', () => {
    const input = { ...clean(), support: [`https://h.example.com/?t=${SECRET}`] };
    expect(stripCredentialEcho(input, probe).refused).toBe(true);
  });

  it('checks numbers and booleans by their string form', () => {
    const digits = credentialEchoProbe(
      parseCredentialMaterial('bearer', JSON.stringify({ token: '12345678' })),
    );
    expect(stripCredentialEcho({ ...clean(), build: 12345678 }, digits).refused).toBe(true);
    expect(stripCredentialEcho({ ...clean(), build: 1234 }, digits).refused).toBe(false);
  });

  it('still decodes valid escapes next to a malformed one', () => {
    const token = 'ab+cd/ef=gh1234';
    const bearer = credentialEchoProbe(
      parseCredentialMaterial('bearer', JSON.stringify({ token })),
    );
    const encoded = encodeURIComponent(token);
    const input = clean();
    input.dist.url = `https://repo.example.com/${encoded}/w.zip?d=100%`;
    const result = stripCredentialEcho(input, bearer);
    if (result.refused) throw new Error('refused');
    expect(result.stripped).toEqual(['$.dist.url']);
    for (const description of [`100% sure: ${encoded}`, `%C3 ${encoded}`, `%zz ${encoded}`]) {
      expect(stripCredentialEcho({ ...clean(), description }, bearer)).toEqual({
        refused: true,
        reason: 'credential_echo',
      });
    }
  });

  it('ignores probe secrets shorter than 8 characters', () => {
    const short = { secrets: ['api'], queryParams: [] };
    const input = { ...clean(), description: 'a public api for widgets' };
    expect(stripCredentialEcho(input, short)).toEqual({
      refused: false,
      object: input,
      stripped: [],
    });
  });

  it('catches a password with a literal plus and a space echoed form-encoded', () => {
    const password = 'a+b c-1234';
    const basic = credentialEchoProbe(
      parseCredentialMaterial('http_basic', JSON.stringify({ username: 'u', password })),
    );
    const input = { ...clean(), description: 'a%2Bb+c-1234' };
    expect(stripCredentialEcho(input, basic)).toEqual({
      refused: true,
      reason: 'credential_echo',
    });
  });

  it('refuses a non-url support value that carries the secret', () => {
    const input = { ...clean(), support: { email: `ops-${SECRET}@example.com` } };
    expect(stripCredentialEcho(input, probe)).toEqual({
      refused: true,
      reason: 'credential_echo',
    });
    const url = { ...clean(), support: { issues: `https://h.example.com/${SECRET}` } };
    const result = stripCredentialEcho(url, probe);
    if (result.refused) throw new Error('refused');
    expect(result.stripped).toEqual(['$.support.issues']);
  });

  it('allows depth 32 and refuses depth 33 for object, array and scalar leaves', () => {
    const nest = (levels: number, leaf: unknown): Record<string, unknown> => {
      let node: unknown = leaf;
      for (let i = 0; i < levels; i += 1) node = { child: node };
      return node as Record<string, unknown>;
    };
    for (const leaf of [{}, [], 1, 'x']) {
      expect(stripCredentialEcho(nest(32, leaf), probe).refused).toBe(false);
      expect(stripCredentialEcho(nest(33, leaf), probe)).toEqual({
        refused: true,
        reason: 'malformed',
      });
    }
  });

  it('treats text after a fragment start as part of the fragment, not the query', () => {
    const input = clean();
    input.homepage = 'https://example.invalid/#help?api_key=public';
    expect(stripCredentialEcho(input, probe)).toEqual({
      refused: false,
      object: input,
      stripped: [],
    });
  });

  it('decodes valid escapes around an invalid byte', () => {
    const tokenProbe = (token: string) =>
      credentialEchoProbe(parseCredentialMaterial('bearer', JSON.stringify({ token })));
    const input = clean();
    input.dist.url = 'https://repo.example.com/w.zip?t=abcdefgh12%3D%3D%FF';
    const url = stripCredentialEcho(input, tokenProbe('abcdefgh12=='));
    if (url.refused) throw new Error('refused');
    expect(url.stripped).toEqual(['$.dist.url']);
    const plus = tokenProbe('+abcdefgh1');
    for (const description of ['%C3%2Babcdefgh1', '%25C3%252Babcdefgh1']) {
      expect(stripCredentialEcho({ ...clean(), description }, plus)).toEqual({
        refused: true,
        reason: 'credential_echo',
      });
    }
  });

  it('strips a url whose parameter name matches only after WHATWG parsing', () => {
    for (const control of ['\t', '\n']) {
      const input = clean();
      input.dist.url = `https://repo.example.com/w.zip?api_${control}key=x`;
      const result = stripCredentialEcho(input, probe);
      if (result.refused) throw new Error('refused');
      expect(result.stripped).toEqual(['$.dist.url']);
    }
  });

  it('treats any absolute support url as a url', () => {
    for (const base of ['ftp://h.example.com/s', 'git+https://h.example.com/s']) {
      const byName = { ...clean(), support: { source: `${base}?api_key=zzz` } };
      const named = stripCredentialEcho(byName, probe);
      if (named.refused) throw new Error('refused');
      expect(named.stripped).toEqual(['$.support.source']);
      const bySecret = { ...clean(), support: { source: `${base}/${SECRET}` } };
      const secret = stripCredentialEcho(bySecret, probe);
      if (secret.refused) throw new Error('refused');
      expect(secret.stripped).toEqual(['$.support.source']);
    }
    const text = { ...clean(), support: { chat: `ask ${SECRET}` } };
    expect(stripCredentialEcho(text, probe).refused).toBe(true);
  });
});
