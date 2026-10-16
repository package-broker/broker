import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  CredentialError,
  bindCredential,
  credentialEchoProbe,
  parseCredentialMaterial,
  type CredentialKind,
} from './credentials.js';
import { stripCredentialEcho } from './credential-echo.js';
import { createPolicyFetch } from './policy-fetch.js';
import { createOutboundPolicy } from './url-policy.js';

const SECRET = 'sup3r-s3cret-value';
const PEM_BODY = 'c3VwM3JzM2NyZXR2YWx1ZQ==';
const ORIGIN = 'https://repo.example.com';
const OTHER = 'https://cdn.example.net';

const samples: Readonly<Record<CredentialKind, Record<string, string>>> = {
  http_basic: { username: 'deploy', password: SECRET },
  bearer: { token: SECRET },
  header: { name: 'X-Api-Key', value: SECRET },
  query: { param: 'access_token', value: SECRET },
  github_app: {
    appId: '12345',
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`,
    webhookSecret: SECRET + '-hook',
  },
  npm_token: { token: SECRET },
  ssh_key: {
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`,
    knownHosts: 'host ssh-ed25519 AAAA',
  },
};

const parse = (kind: CredentialKind, value: unknown = samples[kind]) =>
  parseCredentialMaterial(kind, JSON.stringify(value));

const refusal = (fn: () => unknown): CredentialError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialError);
    expect(String((error as Error).message)).not.toContain(SECRET);
    return error as CredentialError;
  }
  throw new Error('expected refusal');
};

describe('parseCredentialMaterial', () => {
  it.each(Object.keys(samples) as CredentialKind[])('parses %s', (kind) => {
    expect(parse(kind).kind).toBe(kind);
  });

  it('accepts bytes as well as text', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(samples.bearer));
    expect(parseCredentialMaterial('bearer', bytes).kind).toBe('bearer');
  });

  it('refuses unknown keys, missing keys, non-strings and non-objects', () => {
    refusal(() => parse('bearer', { token: SECRET, extra: 'x' }));
    refusal(() => parse('bearer', {}));
    refusal(() => parse('bearer', { token: 5 }));
    refusal(() => parse('bearer', [SECRET]));
    refusal(() => parse('bearer', SECRET));
    refusal(() => parseCredentialMaterial('bearer', `{"token":"${SECRET}"`));
    refusal(() => parseCredentialMaterial('bearer', '{"__proto__":{},"token":"abcdefgh"}'));
  });

  it('refuses an unknown kind and oversized plaintext', () => {
    refusal(() => parseCredentialMaterial('cookie' as CredentialKind, '{}'));
    refusal(() => parse('bearer', { token: 'a'.repeat(16 * 1024) }));
  });

  it('refuses header names outside the allowlist, including authorization', () => {
    refusal(() => parse('header', { name: 'authorization', value: SECRET }));
    refusal(() => parse('header', { name: 'cookie', value: SECRET }));
    expect(parse('header', { name: 'Private-Token', value: SECRET }).kind).toBe('header');
  });

  it('validates field shapes', () => {
    refusal(() => parse('github_app', { ...samples.github_app, appId: '0' }));
    refusal(() => parse('github_app', { ...samples.github_app, appId: '12a' }));
    refusal(() => parse('http_basic', { username: 'a:b', password: SECRET }));
    refusal(() => parse('bearer', { token: `${SECRET}\r\nx: y` }));
    refusal(() => parse('query', { param: 'a b&c', value: SECRET }));
    refusal(() => parse('bearer', { token: '' }));
  });
});

describe('round 2 hardening', () => {
  it('freezes origins and queryParams and ignores tampering', () => {
    const bound = bindCredential(parse('query'), [ORIGIN]);
    expect(() => (bound.origins as string[]).push(OTHER)).toThrow(TypeError);
    expect(() => (bound.queryParams as string[]).pop()).toThrow(TypeError);
    expect(bound.queryParams).toEqual(['access_token']);
    const miss = bound.apply(new Headers(), new URL(`${OTHER}/p`));
    expect(miss.url.search).toBe('');
  });

  it('refuses wildcard and malformed hosts in origins', () => {
    const material = parse('bearer');
    for (const origin of [
      'https://*',
      'https://*.example.com',
      'https://exa_mple.com',
      'https://-a.com',
      'https://a..com',
      'https://[zz]',
    ]) {
      refusal(() => bindCredential(material, [origin]));
    }
    expect(bindCredential(material, ['https://[::1]:8443']).origins).toEqual([
      'https://[::1]:8443',
    ]);
    expect(bindCredential(material, ['https://10.0.0.1']).origins).toEqual(['https://10.0.0.1']);
  });

  it('exposes typed accessors without casts', () => {
    const material = parse('http_basic');
    if (material.kind !== 'http_basic') throw new Error('kind');
    expect(material.password).toBe(SECRET);
    expect(material.username).toBe('deploy');
  });

  it('refuses short secrets', () => {
    refusal(() => parse('bearer', { token: 'short' }));
    refusal(() => parse('npm_token', { token: 'short' }));
    refusal(() => parse('http_basic', { username: 'deploy', password: 'short' }));
    refusal(() => parse('query', { param: 'access_token', value: 'short' }));
    refusal(() => parse('header', { name: 'x-api-key', value: 'short' }));
    refusal(() => parse('github_app', { ...samples.github_app, webhookSecret: 'short' }));
  });

  it('trims header values consistently for binding and probing', () => {
    const material = parse('header', { name: ' X-Api-Key ', value: `  ${SECRET}  ` });
    const bound = bindCredential(material, [ORIGIN]);
    expect(bound.apply(new Headers(), new URL(`${ORIGIN}/`)).headers.get('x-api-key')).toBe(SECRET);
    expect(credentialEchoProbe(material).secrets).toContain(SECRET);
    expect(credentialEchoProbe(material).secrets).not.toContain(`  ${SECRET}  `);
    refusal(() => parse('header', { name: 'x-api-key', value: `${SECRET}\tx` }));
  });

  it('refuses lone surrogates in any field', () => {
    refusal(() => parseCredentialMaterial('bearer', '{"token":"abcdefgh\\ud800"}'));
    refusal(() =>
      parseCredentialMaterial('http_basic', '{"username":"\\udc00ab","password":"abcdefgh"}'),
    );
    expect(
      parseCredentialMaterial('http_basic', '{"username":"u","password":"abcdefgh\\ud83d\\ude00"}')
        .kind,
    ).toBe('http_basic');
  });

  it('checks PEM headers, known_hosts lines, long strings and app ids', () => {
    refusal(() =>
      parse('ssh_key', {
        ...samples.ssh_key,
        privateKeyPem: `-----BEGIN KEY-----\nabc\n-----END KEY-----`,
      }),
    );
    refusal(() =>
      parse('ssh_key', {
        ...samples.ssh_key,
        privateKeyPem: `-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----`,
      }),
    );
    refusal(() => parse('ssh_key', { ...samples.ssh_key, knownHosts: 'garbage' }));
    expect(
      parse('ssh_key', {
        ...samples.ssh_key,
        privateKeyPem: `-----BEGIN OPENSSH PRIVATE KEY-----\nabc=\n-----END OPENSSH PRIVATE KEY-----`,
      }).kind,
    ).toBe('ssh_key');
    expect(parse('github_app', { ...samples.github_app, appId: '1'.repeat(20) }).kind).toBe(
      'github_app',
    );
    refusal(() => parse('github_app', { ...samples.github_app, appId: '1'.repeat(21) }));
    refusal(() => parseCredentialMaterial('bearer', 'x'.repeat(16 * 1024 + 1)));
  });
});

describe('redaction', () => {
  it.each(Object.keys(samples) as CredentialKind[])('%s never reveals secrets', (kind) => {
    const material = parse(kind);
    const shown = [
      JSON.stringify(material),
      JSON.stringify({ wrapped: material }),
      String(material),
      `${material as unknown as string}`,
      inspect(material, { showHidden: true, depth: 5 }),
      inspect({ material }, { showHidden: true, depth: 5 }),
      JSON.stringify(Object.entries(material)),
      JSON.stringify(Object.getOwnPropertyNames(material)),
    ].join('\n');
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain(PEM_BODY);
    expect(JSON.stringify(material)).toBe('"[redacted]"');
    expect(inspect(material)).toBe('[redacted]');
    expect(Object.isFrozen(material)).toBe(true);
    expect(Object.keys(material)).toEqual(['kind']);
  });

  it('keeps secrets out of bound credentials output', () => {
    const bound = bindCredential(parse('bearer'), [ORIGIN]);
    expect(JSON.stringify(bound)).not.toContain(SECRET);
    expect(inspect(bound, { showHidden: true })).not.toContain(SECRET);
  });
});

describe('bindCredential', () => {
  it('requires a non-empty https origin list', () => {
    const material = parse('bearer');
    refusal(() => bindCredential(material, []));
    refusal(() => bindCredential(material, ['http://repo.example.com']));
    refusal(() => bindCredential(material, ['https://repo.example.com/path']));
    refusal(() => bindCredential(material, ['https://user:pw@repo.example.com']));
    refusal(() => bindCredential(material, ['not a url']));
  });

  it('canonicalises and de-duplicates origins', () => {
    const bound = bindCredential(parse('bearer'), ['HTTPS://Repo.Example.com:443', ORIGIN, OTHER]);
    expect(bound.origins).toEqual([ORIGIN, OTHER]);
  });

  it('refuses github_app and ssh_key with a typed error', () => {
    for (const kind of ['github_app', 'ssh_key'] as const) {
      const error = refusal(() => bindCredential(parse(kind), [ORIGIN]));
      expect(error.code).toBe('unbindable');
    }
  });

  it('refuses objects that are not parsed material', () => {
    refusal(() => bindCredential({ kind: 'bearer' } as never, [ORIGIN]));
  });

  it.each([
    ['http_basic', 'authorization', `Basic ${btoa(`deploy:${SECRET}`)}`],
    ['bearer', 'authorization', `Bearer ${SECRET}`],
    ['npm_token', 'authorization', `Bearer ${SECRET}`],
    ['header', 'x-api-key', SECRET],
  ] as const)('%s sets its header only for a bound origin', (kind, name, expected) => {
    const bound = bindCredential(parse(kind), [ORIGIN]);
    expect(bound.queryParams).toEqual([]);
    const hit = bound.apply(new Headers(), new URL(`${ORIGIN}/p?a=1`));
    expect(hit.headers.get(name)).toBe(expected);
    expect(hit.url.href).toBe(`${ORIGIN}/p?a=1`);
    for (const url of [`${OTHER}/p`, 'http://repo.example.com/p', `${ORIGIN}:8443/p`]) {
      const miss = bound.apply(new Headers(), new URL(url));
      expect(miss.headers.get(name)).toBeNull();
      expect(miss.url.href).toBe(url);
    }
  });

  it('encodes non-ascii basic credentials as utf-8', () => {
    const bound = bindCredential(parse('http_basic', { username: 'zoë', password: SECRET }), [
      ORIGIN,
    ]);
    const header = bound.apply(new Headers(), new URL(`${ORIGIN}/`)).headers.get('authorization');
    const raw = atob((header ?? '').slice('Basic '.length));
    expect(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)))).toBe(
      `zoë:${SECRET}`,
    );
  });

  it('query credential sets and declares its parameter on bound origins only', () => {
    const bound = bindCredential(parse('query'), [ORIGIN]);
    expect(bound.queryParams).toEqual(['access_token']);
    const hit = bound.apply(new Headers(), new URL(`${ORIGIN}/p?access_token=old&x=1`));
    expect(hit.url.searchParams.getAll('access_token')).toEqual([SECRET]);
    expect(hit.url.searchParams.get('x')).toBe('1');
    const miss = bound.apply(new Headers(), new URL(`${OTHER}/p`));
    expect(miss.url.search).toBe('');
  });

  it('works through policy fetch and drops the credential on a foreign redirect', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return url.startsWith(ORIGIN)
        ? new Response(null, { status: 302, headers: { location: `${OTHER}/f.zip` } })
        : new Response('ok');
    };
    const policy = createOutboundPolicy({
      allowPrivateHosts: [],
      runtime: 'node',
      selfOrigins: [],
    });
    const fetch = createPolicyFetch({ fetchImpl, policy, userAgent: 'test' });
    const credential = bindCredential(parse('bearer'), [ORIGIN]);
    await fetch({
      url: `${ORIGIN}/a`,
      method: 'GET',
      credential,
      purpose: 'archive',
      maxBytes: 100,
      timeoutMs: 1000,
    });
    expect(seen[0]?.auth).toBe(`Bearer ${SECRET}`);
    expect(seen[1]?.auth).toBeNull();
  });
});

describe('credentialEchoProbe', () => {
  it('returns secrets of at least eight characters and query names', () => {
    const probe = credentialEchoProbe(parse('query'));
    expect(probe.secrets).toContain(SECRET);
    expect(probe.queryParams).toEqual(['access_token']);
  });

  it('covers every kind, including the basic username when long enough', () => {
    expect(
      credentialEchoProbe(parse('http_basic', { username: 'long-username', password: SECRET }))
        .secrets,
    ).toContain('long-username');
    expect(credentialEchoProbe(parse('http_basic')).secrets).not.toContain('deploy');
    expect(credentialEchoProbe(parse('http_basic')).secrets).toContain(SECRET);
    expect(credentialEchoProbe(parse('http_basic')).secrets).toContain(btoa(`deploy:${SECRET}`));
    expect(credentialEchoProbe(parse('github_app')).secrets).toContain(`${SECRET}-hook`);
    expect(credentialEchoProbe(parse('ssh_key')).queryParams).toEqual([]);
    for (const kind of Object.keys(samples) as CredentialKind[]) {
      expect(credentialEchoProbe(parse(kind)).secrets.every((s) => s.length >= 8)).toBe(true);
    }
  });

  it('probe result is not a leak vector through the material', () => {
    const material = parse('bearer');
    credentialEchoProbe(material);
    expect(JSON.stringify(material)).not.toContain(SECRET);
  });
});

describe('harmless formatting of key material', () => {
  const pem = samples.ssh_key.privateKeyPem ?? '';

  it.each([`\n${pem}`, `\n\n  ${pem}\n\n`, `\t${pem}\r\n`])(
    'accepts and normalises a PEM with surrounding whitespace',
    (padded) => {
      const ssh = parse('ssh_key', { ...samples.ssh_key, privateKeyPem: padded });
      if (ssh.kind !== 'ssh_key') throw new Error('kind');
      expect(ssh.privateKeyPem).toBe(`${pem}\n`);
      const app = parse('github_app', { ...samples.github_app, privateKeyPem: padded });
      if (app.kind !== 'github_app') throw new Error('kind');
      expect(app.privateKeyPem).toBe(`${pem}\n`);
    },
  );

  it('still refuses a truncated PEM', () => {
    refusal(() =>
      parse('ssh_key', {
        ...samples.ssh_key,
        privateKeyPem: `\n-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n`,
      }),
    );
    refusal(() =>
      parse('ssh_key', {
        ...samples.ssh_key,
        privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}`,
      }),
    );
    refusal(() => parse('ssh_key', { ...samples.ssh_key, privateKeyPem: `x\n${pem}` }));
  });

  it.each(['\f', '\v'])('refuses a PEM padded or broken with %j', (ws) => {
    refusal(() => parse('ssh_key', { ...samples.ssh_key, privateKeyPem: `${ws}${pem}` }));
    refusal(() => parse('ssh_key', { ...samples.ssh_key, privateKeyPem: `${pem}${ws}` }));
    refusal(() =>
      parse('ssh_key', {
        ...samples.ssh_key,
        privateKeyPem: `-----BEGIN PRIVATE KEY-----${ws}${PEM_BODY}\n-----END PRIVATE KEY-----`,
      }),
    );
  });

  it('trims the end of every known_hosts line', () => {
    const material = parse('ssh_key', {
      ...samples.ssh_key,
      knownHosts: 'host ssh-ed25519 AAAA \t\r\nother ssh-rsa BBBB\t',
    });
    if (material.kind !== 'ssh_key') throw new Error('kind');
    expect(material.knownHosts).toBe('host ssh-ed25519 AAAA\nother ssh-rsa BBBB');
  });

  it('accepts and normalises known_hosts fields separated by tabs', () => {
    const material = parse('ssh_key', {
      ...samples.ssh_key,
      knownHosts: 'host\tssh-ed25519\tAAAA\nother  \t ecdsa-sha2-nistp256 BBBB\tcomment',
    });
    if (material.kind !== 'ssh_key') throw new Error('kind');
    expect(material.knownHosts).toBe(
      'host ssh-ed25519 AAAA\nother ecdsa-sha2-nistp256 BBBB comment',
    );
  });

  it('still refuses other known_hosts formats', () => {
    refusal(() => parse('ssh_key', { ...samples.ssh_key, knownHosts: 'host\tAAAA' }));
    refusal(() => parse('ssh_key', { ...samples.ssh_key, knownHosts: 'host\trsa\tAAAA' }));
    refusal(() => parse('ssh_key', { ...samples.ssh_key, knownHosts: 'host\tssh-ed25519\tAA*A' }));
  });
});

describe('credentialEchoProbe encoded variants', () => {
  const SPECIAL = 'tok/en+v@lue?=ab~';
  const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
  const encoded = (text: string): string[] => [
    text,
    encodeURIComponent(text),
    b64(text),
    b64url(text),
  ];

  it.each([
    ['bearer', { token: SPECIAL }],
    ['npm_token', { token: SPECIAL }],
    ['header', { name: 'x-api-key', value: SPECIAL }],
    ['query', { param: 'access_token', value: SPECIAL }],
  ] as const)('%s emits raw, percent-encoded, base64 and base64url forms', (kind, value) => {
    const secrets = credentialEchoProbe(parse(kind, value)).secrets;
    for (const variant of encoded(SPECIAL)) expect(secrets).toContain(variant);
  });

  it('http_basic emits every form of the password and of user:pass', () => {
    const secrets = credentialEchoProbe(
      parse('http_basic', { username: 'deploy', password: SPECIAL }),
    ).secrets;
    for (const variant of [...encoded(SPECIAL), ...encoded(`deploy:${SPECIAL}`)]) {
      expect(secrets).toContain(variant);
    }
    expect(secrets).not.toContain('deploy');
  });

  it('http_basic emits every form of a username of at least eight characters', () => {
    const secrets = credentialEchoProbe(
      parse('http_basic', { username: 'deploy@corp', password: SPECIAL }),
    ).secrets;
    for (const variant of encoded('deploy@corp')) expect(secrets).toContain(variant);
  });

  it('github_app and ssh_key emit every form of the key material', () => {
    const pem = samples.ssh_key.privateKeyPem ?? '';
    for (const variant of encoded(pem)) {
      expect(credentialEchoProbe(parse('ssh_key')).secrets).toContain(variant);
      expect(credentialEchoProbe(parse('github_app')).secrets).toContain(variant);
    }
    for (const variant of encoded(`${SECRET}-hook`)) {
      expect(credentialEchoProbe(parse('github_app')).secrets).toContain(variant);
    }
  });

  it.each([
    ['bearer', { token: SPECIAL }],
    ['header', { name: 'x-api-key', value: SPECIAL }],
    ['query', { param: 'access_token', value: SPECIAL }],
  ] as const)('the echo guard refuses a base64url-encoded %s secret', (kind, value) => {
    const probe = credentialEchoProbe(parse(kind, value));
    expect(stripCredentialEcho({ description: `x ${b64url(SPECIAL)} y` }, probe)).toEqual({
      refused: true,
      reason: 'credential_echo',
    });
    expect(stripCredentialEcho({ description: b64(SPECIAL) }, probe)).toEqual({
      refused: true,
      reason: 'credential_echo',
    });
  });

  it('the echo guard refuses a base64url-encoded basic pair', () => {
    const probe = credentialEchoProbe(
      parse('http_basic', { username: 'deploy', password: SPECIAL }),
    );
    expect(stripCredentialEcho({ readme: b64url(`deploy:${SPECIAL}`) }, probe)).toEqual({
      refused: true,
      reason: 'credential_echo',
    });
  });
});
