import type { BearerMaterial } from '@package-broker/core/sources/credentials';
import { describe, expect, it, vi } from 'vitest';
import { githubWebhookVerifier } from './webhook.js';

const SECRET = "It's a Secret to Everybody";
const BODY = new TextEncoder().encode('Hello, World!');
const VECTOR = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

function bearer(token: string): BearerMaterial {
  return { kind: 'bearer', token } as BearerMaterial;
}

function headers(signature?: string): Headers {
  const result = new Headers({ 'x-github-event': 'push', 'x-github-delivery': 'abc' });
  if (signature !== undefined) result.set('x-hub-signature-256', signature);
  return result;
}

function flip(text: string, index: number): string {
  const char = text[index]!;
  return `${text.slice(0, index)}${char === '0' ? '1' : '0'}${text.slice(index + 1)}`;
}

async function sign(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  return `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('githubWebhookVerifier', () => {
  it('verifies the documented GitHub test vector', async () => {
    expect(await githubWebhookVerifier.verify(bearer(SECRET), headers(VECTOR), BODY)).toBe(true);
  });

  it('verifies a signature computed independently over a larger binary body', async () => {
    const body = Uint8Array.from({ length: 4096 }, (_value, index) => index % 256);
    const signature = await sign('another-secret', body);
    expect(
      await githubWebhookVerifier.verify(bearer('another-secret'), headers(signature), body),
    ).toBe(true);
  });

  it('rejects uppercase hex digits', async () => {
    const upper = `sha256=${VECTOR.slice(7).toUpperCase()}`;
    expect(await githubWebhookVerifier.verify(bearer(SECRET), headers(upper), BODY)).toBe(false);
  });

  it.each([0, 31, 63])('rejects a signature changed at hex digit %i', async (index) => {
    const tampered = `sha256=${flip(VECTOR.slice(7), index)}`;
    expect(await githubWebhookVerifier.verify(bearer(SECRET), headers(tampered), BODY)).toBe(false);
  });

  it.each([0, 5, 12])('rejects a body changed at byte %i', async (index) => {
    const body = BODY.slice();
    body[index] = body[index]! ^ 1;
    expect(await githubWebhookVerifier.verify(bearer(SECRET), headers(VECTOR), body)).toBe(false);
  });

  it('rejects an appended byte and a truncated body', async () => {
    const longer = new Uint8Array([...BODY, 0]);
    expect(await githubWebhookVerifier.verify(bearer(SECRET), headers(VECTOR), longer)).toBe(false);
    expect(
      await githubWebhookVerifier.verify(bearer(SECRET), headers(VECTOR), BODY.slice(0, -1)),
    ).toBe(false);
  });

  it('rejects a different secret', async () => {
    expect(await githubWebhookVerifier.verify(bearer(`${SECRET}x`), headers(VECTOR), BODY)).toBe(
      false,
    );
  });

  it('returns false for a missing header', async () => {
    expect(await githubWebhookVerifier.verify(bearer(SECRET), headers(), BODY)).toBe(false);
  });

  it('never accepts the legacy sha1 header', async () => {
    const legacy = new Headers({
      'x-hub-signature': 'sha1=85d155c55ed286a300bd1cf124de08d87e914f3a',
    });
    expect(await githubWebhookVerifier.verify(bearer(SECRET), legacy, BODY)).toBe(false);
    const both = new Headers({
      'x-hub-signature': 'sha1=85d155c55ed286a300bd1cf124de08d87e914f3a',
    });
    both.set('x-hub-signature-256', 'sha1=85d155c55ed286a300bd1cf124de08d87e914f3a');
    expect(await githubWebhookVerifier.verify(bearer(SECRET), both, BODY)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['prefix only', 'sha256='],
    ['no prefix', VECTOR.slice(7)],
    ['wrong algorithm', `sha512=${VECTOR.slice(7)}`],
    ['uppercase prefix', `SHA256=${VECTOR.slice(7)}`],
    ['short digest', VECTOR.slice(0, -2)],
    ['long digest', `${VECTOR}00`],
    ['non-hex digest', `sha256=${'g'.repeat(64)}`],
    ['two signatures', `${VECTOR}, ${VECTOR}`],
    ['embedded NUL', `${VECTOR.slice(0, 20)}\u0000${VECTOR.slice(21)}`],
    ['odd-length hex', `sha256=${VECTOR.slice(7, 70)}`],
  ])('returns false for a malformed header (%s) without throwing', async (_name, value) => {
    const bad = new Headers();
    try {
      bad.set('x-hub-signature-256', value);
    } catch {
      return;
    }
    await expect(githubWebhookVerifier.verify(bearer(SECRET), bad, BODY)).resolves.toBe(false);
  });

  it.each([
    ['empty secret', bearer('')],
    ['missing token', { kind: 'bearer' } as unknown as BearerMaterial],
    ['non-string token', { kind: 'bearer', token: 5 } as unknown as BearerMaterial],
  ])('returns false for an unusable secret (%s) without throwing', async (_name, secret) => {
    await expect(githubWebhookVerifier.verify(secret, headers(VECTOR), BODY)).resolves.toBe(false);
  });

  it('delegates the comparison to crypto.subtle.verify over the raw bytes', async () => {
    const spy = vi.spyOn(crypto.subtle, 'verify');
    try {
      await githubWebhookVerifier.verify(bearer(SECRET), headers(VECTOR), BODY);
      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0]!;
      expect(args[0]).toBe('HMAC');
      expect(new Uint8Array(args[3] as ArrayBuffer)).toEqual(BODY);
    } finally {
      spy.mockRestore();
    }
  });

  it('imports the key non-extractable with verify usage only', async () => {
    const spy = vi.spyOn(crypto.subtle, 'importKey');
    try {
      await githubWebhookVerifier.verify(bearer(SECRET), headers(VECTOR), BODY);
      const args = spy.mock.calls[0]!;
      expect(args[3]).toBe(false);
      expect(args[4]).toEqual(['verify']);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not call assertGenuine on the passed bearer object', async () => {
    const secret = new Proxy(bearer(SECRET), {
      get(target, property, receiver) {
        if (property === 'assertGenuine') throw new Error('assertGenuine read');
        return Reflect.get(target, property, receiver);
      },
    });
    expect(await githubWebhookVerifier.verify(secret, headers(VECTOR), BODY)).toBe(true);
  });

  it('does not write the secret or the signature to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    try {
      await githubWebhookVerifier.verify(bearer(SECRET), headers(VECTOR), BODY);
      await githubWebhookVerifier.verify(bearer(SECRET), headers('sha256=zz'), BODY);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
