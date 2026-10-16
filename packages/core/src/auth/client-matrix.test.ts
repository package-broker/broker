import { describe, expect, it } from 'vitest';
import { formatToken } from '../secrets/token-format.js';
import {
  credentialFromHeaders,
  parseAuthorization,
} from '@package-broker/core/auth/credential-parser';

const PAT = formatToken(
  'pat',
  'abcdefghij23',
  new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff),
);
const SVC = formatToken(
  'svc',
  'mnopqrstuv67',
  new Uint8Array(32).map((_, i) => (i * 5 + 9) & 0xff),
);
const OTHER_PAT = formatToken(
  'pat',
  'klmnopqrst45',
  new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff),
);

interface HttpBasicEntry {
  readonly username: string;
  readonly password: string;
}

function composerAuth(entries: Record<string, HttpBasicEntry>): string {
  return JSON.stringify({ 'http-basic': entries });
}

function composerHeader(auth: string, hostKey: string): string | null {
  const entry = (JSON.parse(auth) as { 'http-basic': Record<string, HttpBasicEntry> })[
    'http-basic'
  ][hostKey];
  return entry === undefined ? null : `Basic ${btoa(`${entry.username}:${entry.password}`)}`;
}

function npmrcHeader(npmrc: string, registryKey: string): string | null {
  const prefix = `//${registryKey}/:_authToken=`;
  const line = npmrc.split('\n').find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? null : `Bearer ${line.slice(prefix.length)}`;
}

function yarnrcHeader(
  yarnrc: Record<string, unknown>,
  registryKey: string,
  operationRequiresAuth: boolean,
): string | null {
  const registries = yarnrc['npmRegistries'] as Record<
    string,
    { npmAuthToken?: string; npmAlwaysAuth?: boolean }
  >;
  const entry = registries[`//${registryKey}`];
  if (entry?.npmAuthToken === undefined) return null;
  if (entry.npmAlwaysAuth !== true && !operationRequiresAuth) return null;
  return `Bearer ${entry.npmAuthToken}`;
}

function expectCanonical(header: string | null, canonical: string, scheme: 'basic' | 'bearer') {
  expect(header).not.toBeNull();
  const result = parseAuthorization(header);
  expect(result.outcome).toBe('token');
  if (result.outcome !== 'token') return;
  expect(result.scheme).toBe(scheme);
  expect(result.token.canonical).toBe(canonical);
}

describe('Composer http-basic', () => {
  it.each([
    ['username token, password token', PAT, PAT],
    ['username token, empty password', PAT, ''],
    ['username token, x password', PAT, 'x'],
    ['literal token username, token password', 'token', PAT],
    ['literal token username, service token', 'token', SVC],
  ])('parses %s to one canonical token', (_name, username, password) => {
    const auth = composerAuth({ 'packages.example.com': { username, password } });
    const expected = username === 'token' ? password : username;
    expectCanonical(composerHeader(auth, 'packages.example.com'), expected, 'basic');
  });

  it('keys a host with a nondefault port and parses its entry', () => {
    const auth = composerAuth({
      'packages.example.com': { username: PAT, password: '' },
      'packages.example.com:8443': { username: 'token', password: SVC },
    });
    expectCanonical(composerHeader(auth, 'packages.example.com:8443'), SVC, 'basic');
    expectCanonical(composerHeader(auth, 'packages.example.com'), PAT, 'basic');
    expect(composerHeader(auth, 'packages.example.com:9443')).toBeNull();
  });

  it('parses a COMPOSER_AUTH service token', () => {
    const auth = composerAuth({ 'packages.example.com': { username: 'token', password: SVC } });
    const result = parseAuthorization(composerHeader(auth, 'packages.example.com'));
    expect(result.outcome === 'token' && result.token.kind).toBe('svc');
  });

  it('accepts identical tokens in both fields as one token', () => {
    const auth = composerAuth({ h: { username: PAT, password: PAT } });
    expectCanonical(composerHeader(auth, 'h'), PAT, 'basic');
  });

  it('refuses two different tokens', () => {
    for (const other of [OTHER_PAT, SVC]) {
      const auth = composerAuth({ h: { username: PAT, password: other } });
      expect(parseAuthorization(composerHeader(auth, 'h'))).toEqual({
        outcome: 'invalid',
        reason: 'ambiguous',
      });
    }
  });

  it.each([
    ['unrelated username', 'alice', PAT],
    ['unrelated password', PAT, 'secret'],
    ['no token at all', 'alice', 'secret'],
  ])('refuses %s', (_name, username, password) => {
    const auth = composerAuth({ h: { username, password } });
    expect(parseAuthorization(composerHeader(auth, 'h')).outcome).toBe('invalid');
  });
});

describe('npm and pnpm _authToken', () => {
  const npmrc = [
    `//registry.example.com/:_authToken=${PAT}`,
    `//registry.example.com:8443/npm/:_authToken=${SVC}`,
  ].join('\n');

  it('parses the Bearer header to one canonical token', () => {
    expectCanonical(npmrcHeader(npmrc, 'registry.example.com'), PAT, 'bearer');
  });

  it('parses a port-qualified registry key', () => {
    expectCanonical(npmrcHeader(npmrc, 'registry.example.com:8443/npm'), SVC, 'bearer');
  });

  it.each(['Bearer', 'bearer', 'BEARER'])('accepts scheme spelling %s', (scheme) => {
    expectCanonical(`${scheme} ${PAT}`, PAT, 'bearer');
  });

  it('refuses a Bearer value carrying two tokens', () => {
    for (const header of [`Bearer ${PAT} ${OTHER_PAT}`, `Bearer ${PAT},${OTHER_PAT}`]) {
      expect(parseAuthorization(header).outcome).toBe('invalid');
    }
  });
});

describe('yarn npmAuthToken', () => {
  const yarnrc = {
    npmRegistries: {
      '//registry.example.com': { npmAuthToken: PAT, npmAlwaysAuth: true },
      '//other.example.com': { npmAuthToken: SVC, npmAlwaysAuth: false },
    },
  };

  it('sends npmAuthToken as Bearer on every request when npmAlwaysAuth is set', () => {
    expectCanonical(yarnrcHeader(yarnrc, 'registry.example.com', false), PAT, 'bearer');
    expectCanonical(yarnrcHeader(yarnrc, 'registry.example.com', true), PAT, 'bearer');
  });

  it('sends npmAuthToken as Bearer for authenticated operations without npmAlwaysAuth', () => {
    expectCanonical(yarnrcHeader(yarnrc, 'other.example.com', true), SVC, 'bearer');
  });

  it('sends no Authorization header for an anonymous read without npmAlwaysAuth', () => {
    expect(yarnrcHeader(yarnrc, 'other.example.com', false)).toBeNull();
  });
});

describe('absent Authorization header', () => {
  it('reports none for empty Headers', () => {
    expect(credentialFromHeaders(new Headers())).toEqual({ outcome: 'none' });
  });
});

describe('credentialFromHeaders across clients', () => {
  it.each([
    ['composer', `Basic ${btoa(`${PAT}:`)}`, 'basic'],
    ['npm', `Bearer ${PAT}`, 'bearer'],
  ] as const)('reads the %s header to the same canonical token', (_client, header, scheme) => {
    const result = credentialFromHeaders(new Headers({ Authorization: header }));
    expect(result.outcome === 'token' && result.scheme).toBe(scheme);
    expect(result.outcome === 'token' && result.token.canonical).toBe(PAT);
  });

  it('does not echo credentials in a refusal', () => {
    const serialized = JSON.stringify(parseAuthorization(`Basic ${btoa(`${PAT}:${OTHER_PAT}`)}`));
    expect(serialized).not.toContain(PAT);
    expect(serialized).not.toContain(OTHER_PAT);
  });
});
