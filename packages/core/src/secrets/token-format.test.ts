import { describe, expect, it } from 'vitest';
import { formatToken, parseToken } from './token-format.js';
import type { TokenKind } from './token-format.js';

const SELECTOR = 'abcdefghij23';
const SECRET_BYTES = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff);
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function lenientDecode(text: string): Uint8Array {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '=';
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

const SECRET = encode(SECRET_BYTES);
const UNDERSCORE_SECRET = '_'.repeat(42) + 'A';
const KINDS: readonly TokenKind[] = ['pat', 'svc', 'cst'];

function expectRefused(text: unknown): void {
  const result = parseToken(text);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(JSON.stringify(result)).toBe('{"ok":false,"reason":"malformed"}');
  }
}

describe('token format', () => {
  it('uses a secret that is canonical 32-byte base64url', () => {
    expect(SECRET).toHaveLength(43);
    expect(formatToken('pat', SELECTOR, SECRET_BYTES)).toBe(`pb_pat_${SELECTOR}_${SECRET}`);
  });

  it.each(KINDS)('round-trips a canonical %s token', (kind) => {
    const text = formatToken(kind, SELECTOR, SECRET);
    expect(text).toBe(`pb_${kind}_${SELECTOR}_${SECRET}`);
    const parsed = parseToken(text);
    expect(parsed).toEqual({
      ok: true,
      kind,
      selector: SELECTOR,
      secret: SECRET,
      canonical: text,
      reserved: kind === 'cst',
    });
  });

  it('marks only cst as reserved', () => {
    for (const kind of KINDS) {
      const parsed = parseToken(formatToken(kind, SELECTOR, SECRET));
      expect(parsed.ok && parsed.reserved).toBe(kind === 'cst');
    }
  });

  it('parses a secret made of underscores at the fixed offset', () => {
    const text = `pb_svc_${SELECTOR}_${UNDERSCORE_SECRET}`;
    const parsed = parseToken(text);
    expect(parsed).toMatchObject({
      ok: true,
      kind: 'svc',
      selector: SELECTOR,
      secret: UNDERSCORE_SECRET,
    });
  });

  it('refuses an unknown prefix or kind', () => {
    for (const text of [
      `pb_xyz_${SELECTOR}_${SECRET}`,
      `px_pat_${SELECTOR}_${SECRET}`,
      `PB_pat_${SELECTOR}_${SECRET}`,
      `pb_PAT_${SELECTOR}_${SECRET}`,
      `${SELECTOR}_${SECRET}`,
      '',
    ]) {
      expectRefused(text);
    }
  });

  it('refuses selectors of 11 or 13 characters', () => {
    expectRefused(`pb_pat_${SELECTOR.slice(1)}_${SECRET}`);
    expectRefused(`pb_pat_${SELECTOR}a_${SECRET}`);
  });

  it('refuses selector characters outside a-z2-7', () => {
    for (const bad of [
      'ABCDEFGHIJ23',
      'abcdefghij01',
      'abcdefghij18',
      'abcdefghij2-',
      'abcdefghij2_',
    ]) {
      expectRefused(`pb_pat_${bad}_${SECRET}`);
    }
  });

  it('refuses secrets of 42 or 44 characters and padded secrets', () => {
    expectRefused(`pb_pat_${SELECTOR}_${SECRET.slice(1)}`);
    expectRefused(`pb_pat_${SELECTOR}_${SECRET}A`);
    expectRefused(`pb_pat_${SELECTOR}_${SECRET}=`);
    expectRefused(`pb_pat_${SELECTOR}_${SECRET.slice(1)}=`);
  });

  it('refuses a non-canonical tail', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alternate = alphabet.charAt(alphabet.indexOf(SECRET.charAt(42)) ^ 1);
    expect(lenientDecode(SECRET.slice(0, 42) + alternate).subarray(0, 32)).toEqual(SECRET_BYTES);
    expectRefused(`pb_pat_${SELECTOR}_${SECRET.slice(0, 42)}${alternate}`);
  });

  it('refuses extra underscores in the prefix region and extra segments', () => {
    expectRefused(`pb__pat_${SELECTOR}_${SECRET}`);
    expectRefused(`pb_pat__${SELECTOR}_${SECRET}`);
    expectRefused(`pb_pat_x_${SELECTOR}_${SECRET}`);
    expectRefused(`pb_pat_${SELECTOR}_${SECRET}_`);
    expectRefused(`pb_pat_${SELECTOR}_${SECRET}_${SECRET}`);
  });

  it('refuses surrounding whitespace, controls, non-ASCII and non-strings', () => {
    const good = `pb_pat_${SELECTOR}_${SECRET}`;
    for (const text of [
      ` ${good}`,
      `${good} `,
      `${good}\n`,
      `${good}\0`,
      good.replace('pat', 'pät'),
    ]) {
      expectRefused(text);
    }
    for (const value of [undefined, null, 5, {}, ['x']]) {
      expect(parseToken(value)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses very long input without echoing it', () => {
    const input = 'pb_pat_'.repeat(5000);
    const result = parseToken(input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('pb_pat');
  });

  it('refuses a wrong separator at offset 6 and offset 19 in same-length input', () => {
    const good = `pb_pat_${SELECTOR}_${SECRET}`;
    expect(good).toHaveLength(63);
    for (const offset of [6, 19]) {
      expect(good.charAt(offset)).toBe('_');
      for (const bad of ['X', '-', '7', ' ']) {
        const text = good.slice(0, offset) + bad + good.slice(offset + 1);
        expect(text).toHaveLength(63);
        expectRefused(text);
      }
    }
  });

  it('refuses spaces and control characters inside selector and secret', () => {
    const good = `pb_pat_${SELECTOR}_${SECRET}`;
    for (const offset of [10, 40]) {
      for (const bad of [' ', '\t', '\n', '\0']) {
        const text = good.slice(0, offset) + bad + good.slice(offset + 1);
        expect(text).toHaveLength(63);
        expectRefused(text);
      }
    }
  });

  it('returns a typed refusal that carries no token text', () => {
    const text = `pb_pat_${SELECTOR}_${SECRET.slice(1)}`;
    const result = parseToken(text);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
    expect(JSON.stringify(result)).not.toContain(SELECTOR);
    expect(JSON.stringify(result)).not.toContain(SECRET.slice(1, 12));
  });

  it('accepts a 32-byte secret and refuses 31 or 33 bytes', () => {
    expect(formatToken('svc', SELECTOR, new Uint8Array(32))).toBe(
      `pb_svc_${SELECTOR}_${'A'.repeat(43)}`,
    );
    expect(() => formatToken('svc', SELECTOR, new Uint8Array(31))).toThrow(TypeError);
    expect(() => formatToken('svc', SELECTOR, new Uint8Array(33))).toThrow(TypeError);
  });

  it('formats without throwing token text for invalid input', () => {
    const attempts: Array<() => string> = [
      () => formatToken('pat', SELECTOR.slice(1), SECRET),
      () => formatToken('pat', SELECTOR, SECRET.slice(1)),
      () => formatToken('pat', SELECTOR, `${SECRET}=`),
      () => formatToken('pat', SELECTOR, new Uint8Array(31)),
      () => formatToken('xyz' as TokenKind, SELECTOR, SECRET),
      () => formatToken('pat', 'ABCDEFGHIJ23', SECRET),
      () => formatToken('pat', `${SELECTOR}_`, SECRET.slice(1)),
      () => formatToken('pat', SELECTOR.slice(1), `${SECRET.slice(0, 1)}_${SECRET.slice(1)}`),
    ];
    for (const attempt of attempts) {
      let message = '';
      try {
        attempt();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(SELECTOR.slice(1));
      expect(message).not.toContain(SECRET.slice(1, 12));
    }
  });
});
