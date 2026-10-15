import { describe, expect, it } from 'vitest';
import { formatToken } from '../secrets/token-format.js';
import { credentialFromHeaders, parseAuthorization } from './credential-parser.js';

const SECRET_BYTES = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff);
const OTHER_BYTES = new Uint8Array(32).map((_, index) => (index * 11 + 5) & 0xff);
const PAT = formatToken('pat', 'abcdefghij23', SECRET_BYTES);
const OTHER_PAT = formatToken('pat', 'klmnopqrst45', OTHER_BYTES);
const SVC = formatToken('svc', 'abcdefghij23', SECRET_BYTES);
const CST = formatToken('cst', 'abcdefghij23', SECRET_BYTES);

function basic(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

function rawBasic(bytes: number[]): string {
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

function expectToken(header: string, canonical = PAT): void {
  const result = parseAuthorization(header);
  expect(result.outcome).toBe('token');
  if (result.outcome === 'token') expect(result.token.canonical).toBe(canonical);
}

function expectInvalid(header: string, reason: string): void {
  expect(parseAuthorization(header)).toEqual({ outcome: 'invalid', reason });
}

describe('absent header', () => {
  it('reports none for null and undefined', () => {
    expect(parseAuthorization(null)).toEqual({ outcome: 'none' });
    expect(parseAuthorization(undefined)).toEqual({ outcome: 'none' });
  });

  it('treats a present empty header as invalid', () => {
    expect(parseAuthorization('').outcome).toBe('invalid');
  });
});

describe('Bearer', () => {
  it.each(['Bearer', 'bearer', 'BEARER', 'bEaReR'])('accepts scheme spelling %s', (scheme) => {
    expectToken(`${scheme} ${PAT}`);
  });

  it('parses svc and returns cst as reserved', () => {
    expectToken(`Bearer ${SVC}`, SVC);
    const result = parseAuthorization(`Bearer ${CST}`);
    expect(result.outcome).toBe('token');
    if (result.outcome === 'token') {
      expect(result.token.kind).toBe('cst');
      expect(result.token.reserved).toBe(true);
    }
  });

  it.each([
    ['extra word', `Bearer ${PAT} extra`, 'malformed'],
    ['two tokens', `Bearer ${PAT} ${OTHER_PAT}`, 'malformed'],
    ['double space', `Bearer  ${PAT}`, 'malformed'],
    ['leading space', ` Bearer ${PAT}`, 'unsupported_scheme'],
    ['trailing space', `Bearer ${PAT} `, 'malformed'],
    ['tab separator', `Bearer\t${PAT}`, 'invalid_encoding'],
    ['no token', 'Bearer ', 'malformed'],
    ['scheme only', 'Bearer', 'malformed'],
    ['joined duplicate', `Bearer ${PAT}, Bearer ${OTHER_PAT}`, 'malformed'],
    ['joined without space', `Bearer ${PAT},Bearer ${OTHER_PAT}`, 'malformed'],
    ['joined with comma only', `Bearer ${PAT},`, 'malformed'],
    ['quoted', `Bearer "${PAT}"`, 'malformed'],
    ['malformed token', `Bearer ${PAT.slice(0, -1)}`, 'malformed'],
    ['altered prefix', `Bearer xb${PAT.slice(2)}`, 'malformed'],
    ['uppercase kind', `Bearer pb_PAT${PAT.slice(6)}`, 'malformed'],
    ['non-token text', 'Bearer not-a-token', 'malformed'],
    ['control character', `Bearer ${PAT}\u0001`, 'invalid_encoding'],
    ['newline', `Bearer ${PAT}\n`, 'invalid_encoding'],
    ['carriage return', `Bearer ${PAT}\r`, 'invalid_encoding'],
    ['DEL', `Bearer ${PAT}\u007f`, 'invalid_encoding'],
    ['non-ASCII', `Bearer ${PAT}é`, 'invalid_encoding'],
    ['lone surrogate', `Bearer ${PAT}\ud800`, 'invalid_encoding'],
  ])('refuses %s', (_name, header, reason) => {
    expectInvalid(header, reason);
  });
});

describe('Basic', () => {
  it.each([
    ['token as username and password', basic(PAT, PAT)],
    ['token username, empty password', basic(PAT, '')],
    ['token username, x password', basic(PAT, 'x')],
    ['literal token username', basic('token', PAT)],
    ['empty username', basic('', PAT)],
    ['x username', basic('x', PAT)],
    ['token password literal token', basic(PAT, 'token')],
    ['lowercase scheme', basic(PAT, '').replace('Basic', 'basic')],
    ['uppercase scheme', basic(PAT, '').replace('Basic', 'BASIC')],
  ])('parses %s to one canonical token', (_name, header) => {
    expectToken(header);
  });

  it('refuses two different tokens as ambiguous', () => {
    expectInvalid(basic(PAT, OTHER_PAT), 'ambiguous');
    expectInvalid(basic(PAT, SVC), 'ambiguous');
  });

  it.each([
    ['no token', basic('user', 'secret'), 'no_token'],
    ['both empty', basic('', ''), 'no_token'],
    ['non-token companion username', basic('alice', PAT), 'malformed'],
    ['non-token companion password', basic(PAT, 'secret'), 'malformed'],
    ['alice companion password', basic(PAT, 'alice'), 'malformed'],
    ['uppercase TOKEN companion', basic(PAT, 'TOKEN'), 'malformed'],
    ['uppercase X companion', basic(PAT, 'X'), 'malformed'],
    ['uppercase X username', basic('X', PAT), 'malformed'],
    ['companion token-like malformed', basic(PAT.slice(0, -1), PAT), 'malformed'],
    ['no colon', `Basic ${btoa(PAT)}`, 'malformed'],
    ['two colons', basic(PAT, `${PAT}:more`), 'malformed'],
    ['colon in username', basic(`a:${PAT}`, ''), 'malformed'],
    ['control in decoded', basic(PAT, 'x\u0001'), 'invalid_encoding'],
    ['newline in decoded', basic(PAT, '\n'), 'invalid_encoding'],
    ['invalid utf-8', rawBasic([0xff, 0x3a, 0xfe]), 'invalid_encoding'],
    ['non-ASCII decoded', basic('é', PAT), 'invalid_encoding'],
  ])('refuses %s', (_name, header, reason) => {
    expectInvalid(header, reason);
  });

  it.each([
    ['unpadded', `Basic ${btoa(`${PAT}:`).replaceAll('=', '')}`, 'invalid_encoding'],
    [
      'urlsafe alphabet',
      `Basic ${btoa(`${PAT}:~~~`).replaceAll('+', '-').replaceAll('/', '_')}`,
      'invalid_encoding',
    ],
    [
      'embedded whitespace',
      `Basic ${btoa(`${PAT}:`).slice(0, 8)} ${btoa(`${PAT}:`).slice(8)}`,
      'malformed',
    ],
    ['invalid characters', 'Basic !!!!', 'invalid_encoding'],
    ['empty payload', 'Basic ', 'malformed'],
    ['scheme only', 'Basic', 'malformed'],
    ['extra word', `${basic(PAT, '')} extra`, 'malformed'],
    ['joined duplicate', `${basic(PAT, '')}, ${basic(PAT, '')}`, 'malformed'],
    ['joined without space', `${basic(PAT, '')},${basic(PAT, '').slice(6)}`, 'malformed'],
    ['payload with extra padding', `${basic(PAT, '')}=`, 'invalid_encoding'],
  ])('refuses encoding defect: %s', (_name, header, reason) => {
    expectInvalid(header, reason);
  });

  it('refuses a non-canonical payload that decodes to the same bytes', () => {
    const canonical = basic(PAT, '');
    expect(canonical.endsWith('Og==')).toBe(true);
    const altered = `${canonical.slice(0, -4)}Oh==`;
    expect(atob(altered.slice(6))).toBe(atob(canonical.slice(6)));
    expectInvalid(altered, 'invalid_encoding');
  });
});

describe('bounds and schemes', () => {
  it('does not apply the length bound to a header of exactly 4096 characters', () => {
    const header = `Bearer ${'a'.repeat(4096 - 7)}`;
    expect(header).toHaveLength(4096);
    expectInvalid(header, 'malformed');
  });

  it('refuses a header of 4097 characters with too_long', () => {
    const header = `Bearer ${'a'.repeat(4097 - 7)}`;
    expect(header).toHaveLength(4097);
    expectInvalid(header, 'too_long');
    expectInvalid('x'.repeat(4097), 'too_long');
  });

  it('refuses an over-length Basic header even when decodable', () => {
    expectInvalid(basic(PAT, 'x'.repeat(4096)), 'too_long');
  });

  it.each(['Digest abc', 'Negotiate abc', 'Token abc', 'Bearer-x abc', `${PAT}`, 'NTLM'])(
    'refuses unsupported scheme %s',
    (header) => {
      expectInvalid(header, 'unsupported_scheme');
    },
  );
});

describe('no token text in refusals', () => {
  it('never echoes credentials in the result', () => {
    const headers = [
      `Bearer ${PAT} extra`,
      basic(PAT, OTHER_PAT),
      basic('alice', PAT),
      `Bearer ${PAT}, Bearer ${OTHER_PAT}`,
      `${basic(PAT, '')} extra`,
    ];
    for (const header of headers) {
      const serialized = JSON.stringify(parseAuthorization(header));
      for (const token of [PAT, OTHER_PAT, btoa(`${PAT}:`)]) {
        expect(serialized).not.toContain(token);
      }
      expect(parseAuthorization(header).outcome).toBe('invalid');
    }
  });

  it.each([
    ['Bearer', 'malformed'],
    ['Digest x', 'unsupported_scheme'],
    [basic(PAT, OTHER_PAT), 'ambiguous'],
    ['Basic !!!!', 'invalid_encoding'],
    ['x'.repeat(5000), 'too_long'],
  ])('maps %# to the exact reason %s', (header, reason) => {
    expectInvalid(header, reason);
  });

  it('keeps token material out of JSON and enumeration of a success result', () => {
    const result = parseAuthorization(`Bearer ${PAT}`);
    expect(result.outcome).toBe('token');
    if (result.outcome !== 'token') return;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PAT);
    expect(serialized).not.toContain(PAT.slice(-43));
    expect(Object.keys(result.token)).not.toContain('secret');
    expect(Object.keys(result.token)).not.toContain('canonical');
    expect(result.token.canonical).toBe(PAT);
    expect(result.token.secret).toBe(PAT.slice(-43));
    expect(result.token.selector).toBe('abcdefghij23');
  });
});

describe('credentialFromHeaders', () => {
  it('reads only the Authorization header', () => {
    const headers = new Headers({ Authorization: `Bearer ${PAT}` });
    expect(credentialFromHeaders(headers).outcome).toBe('token');
  });

  it('never takes a token from a cookie', () => {
    const headers = new Headers({ Cookie: `session=${PAT}; token=${PAT}` });
    expect(credentialFromHeaders(headers)).toEqual({ outcome: 'none' });
  });

  it('a present bad header stays invalid even with a session cookie', () => {
    const headers = new Headers({
      Authorization: 'Digest abc',
      Cookie: '__Host-session=valid-looking-session',
    });
    expect(credentialFromHeaders(headers)).toMatchObject({ outcome: 'invalid' });
  });

  it('refuses a joined duplicate Authorization produced by Headers.append', () => {
    const headers = new Headers();
    headers.append('Authorization', `Bearer ${PAT}`);
    headers.append('Authorization', `Bearer ${OTHER_PAT}`);
    expect(credentialFromHeaders(headers)).toMatchObject({ outcome: 'invalid' });
  });

  it('refuses a joined duplicate even when both values are identical', () => {
    const headers = new Headers();
    headers.append('Authorization', `Bearer ${PAT}`);
    headers.append('Authorization', `Bearer ${PAT}`);
    expect(credentialFromHeaders(headers)).toMatchObject({ outcome: 'invalid' });
  });

  it('trims optional whitespace around the value through Headers normalisation', () => {
    const headers = new Headers({ Authorization: ` \tBearer ${PAT}\t ` });
    expect(credentialFromHeaders(headers).outcome).toBe('token');
  });
});
