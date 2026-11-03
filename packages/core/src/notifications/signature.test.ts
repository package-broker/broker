import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  NotificationSignatureError,
  notificationHeaders,
  signNotification,
  verifyNotificationSignature,
  type NotificationSignatureInput,
} from './signature.js';

const encoder = new TextEncoder();
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const BASE: NotificationSignatureInput = {
  key: KEY,
  timestamp: 1_767_225_600,
  deliveryId: '01JDELIVERY00000000000000A',
  eventId: '01JEVENT0000000000000000AB',
  method: 'POST',
  body: encoder.encode('{"event":"package.published","package":"left-pad"}'),
};

function reference(input: NotificationSignatureInput): string {
  const prefix = `v1\n${input.timestamp}\n${input.deliveryId}\n${input.eventId}\n${input.method}\n`;
  return `v1=${createHmac('sha256', Buffer.from(input.key))
    .update(prefix, 'utf8')
    .update(input.body)
    .digest('hex')}`;
}

describe('notification signature', () => {
  it('matches an independent HMAC-SHA256 over the signed prefix and raw body', async () => {
    const signature = await signNotification(BASE);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(signature).toBe(reference(BASE));
  });

  it('matches literal known-answer vectors', async () => {
    expect(await signNotification(BASE)).toBe(
      'v1=c9e02ad328edff4ec93d6b3b364f0e7c6509041f806f2c4648b92d7b4500dde1',
    );
    expect(
      await signNotification({
        key: new Uint8Array(32).fill(0xab),
        timestamp: 1,
        deliveryId: 'd',
        eventId: 'e',
        method: 'PUT',
        body: new Uint8Array([0, 255, 10, 13]),
      }),
    ).toBe('v1=63f050cb3314526babba87c2efbe68d742bb3570024e8a078e43c19719157dab');
  });

  it('verifies its own signature inside the window', async () => {
    const signature = await signNotification(BASE);
    for (const now of [BASE.timestamp, BASE.timestamp - 300, BASE.timestamp + 300]) {
      expect(await verifyNotificationSignature({ ...BASE, signature, now })).toBe(true);
    }
  });

  it('refuses stale and future timestamps beyond 300 seconds', async () => {
    const signature = await signNotification(BASE);
    expect(
      await verifyNotificationSignature({ ...BASE, signature, now: BASE.timestamp + 301 }),
    ).toBe(false);
    expect(
      await verifyNotificationSignature({ ...BASE, signature, now: BASE.timestamp - 301 }),
    ).toBe(false);
  });

  const tampered = (body: Uint8Array): Uint8Array => {
    const copy = body.slice();
    copy[3] = (copy[3] ?? 0) ^ 1;
    return copy;
  };

  it.each<[string, Partial<NotificationSignatureInput>]>([
    ['timestamp', { timestamp: BASE.timestamp + 1 }],
    ['delivery id', { deliveryId: '01JDELIVERY00000000000000B' }],
    ['event id', { eventId: '01JEVENT0000000000000000AC' }],
    ['method', { method: 'PUT' }],
    ['one body byte', { body: tampered(BASE.body) }],
    ['body length', { body: BASE.body.slice(0, -1) }],
    ['key', { key: Uint8Array.from({ length: 32 }, (_, index) => index + 1) }],
  ])('changing the %s changes the signature and fails verification', async (_label, change) => {
    const original = await signNotification(BASE);
    const changed = { ...BASE, ...change };
    const signature = await signNotification(changed);
    expect(signature).not.toBe(original);
    expect(signature).toBe(reference(changed));
    expect(
      await verifyNotificationSignature({ ...changed, signature: original, now: BASE.timestamp }),
    ).toBe(false);
  });

  it('keeps ids and body bytes on a retry while the timestamp and signature change', async () => {
    const first = await notificationHeaders(BASE);
    const retry = await notificationHeaders({ ...BASE, timestamp: BASE.timestamp + 300 });
    const pick = (headers: readonly (readonly [string, string])[], name: string) =>
      headers.find(([header]) => header === name)?.[1];
    for (const name of ['X-Package-Broker-Delivery', 'Idempotency-Key', 'X-Package-Broker-Event']) {
      expect(pick(retry, name)).toBe(pick(first, name));
    }
    expect(pick(retry, 'X-Package-Broker-Timestamp')).not.toBe(
      pick(first, 'X-Package-Broker-Timestamp'),
    );
    expect(pick(retry, 'X-Package-Broker-Signature')).not.toBe(
      pick(first, 'X-Package-Broker-Signature'),
    );
    expect(BASE.body).toEqual(encoder.encode('{"event":"package.published","package":"left-pad"}'));
  });

  it('accepts 256-character ids', async () => {
    const input = { ...BASE, deliveryId: 'd'.repeat(256), eventId: 'e'.repeat(256) };
    expect(await signNotification(input)).toBe(reference(input));
  });

  it('returns exactly the broker headers', async () => {
    expect(await notificationHeaders(BASE)).toEqual([
      ['Content-Type', 'application/json'],
      ['X-Package-Broker-Timestamp', '1767225600'],
      ['X-Package-Broker-Signature', reference(BASE)],
      ['X-Package-Broker-Delivery', BASE.deliveryId],
      ['Idempotency-Key', BASE.deliveryId],
      ['X-Package-Broker-Event', BASE.eventId],
    ]);
  });

  it('never exposes the key in a header', async () => {
    const key = encoder.encode('SENTINEL-KEY-SENTINEL-KEY-SENTIN');
    const headers = await notificationHeaders({ ...BASE, key });
    const text = JSON.stringify(headers);
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain(Buffer.from(key).toString('hex'));
    expect(text).not.toContain(Buffer.from(key).toString('base64'));
    expect(text).not.toContain(Buffer.from(key).toString('base64url'));
  });

  it.each<[string, Partial<NotificationSignatureInput>]>([
    ['short key', { key: new Uint8Array(31) }],
    ['long key', { key: new Uint8Array(33) }],
    ['zero timestamp', { timestamp: 0 }],
    ['negative timestamp', { timestamp: -1 }],
    ['fractional timestamp', { timestamp: 1.5 }],
    ['unsafe timestamp', { timestamp: 2 ** 53 }],
    ['empty delivery id', { deliveryId: '' }],
    ['delivery id with newline', { deliveryId: 'a\nb' }],
    ['257-character delivery id', { deliveryId: 'a'.repeat(257) }],
    ['delivery id with space', { deliveryId: 'a b' }],
    ['non-ASCII event id', { eventId: 'café' }],
    ['event id with CR', { eventId: 'a\r' }],
    ['lowercase method', { method: 'post' as 'POST' }],
    ['GET method', { method: 'GET' as 'POST' }],
    ['non-byte body', { body: 'text' as unknown as Uint8Array }],
  ])('refuses a %s with a fixed error', async (_label, change) => {
    const error = await signNotification({ ...BASE, ...change }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotificationSignatureError);
    expect((error as Error).name).toBe('NotificationSignatureError');
    expect((error as Error).message).toBe('Invalid notification signature input');
    await expect(notificationHeaders({ ...BASE, ...change })).rejects.toBeInstanceOf(
      NotificationSignatureError,
    );
    expect(
      await verifyNotificationSignature({
        ...BASE,
        ...change,
        signature: reference(BASE),
        now: BASE.timestamp,
      }),
    ).toBe(false);
  });

  it.each([
    ['uppercase hex', (signature: string) => signature.toUpperCase()],
    ['missing version', (signature: string) => signature.slice(3)],
    ['other version', (signature: string) => `v2=${signature.slice(3)}`],
    ['truncated', (signature: string) => signature.slice(0, -2)],
    ['extended', (signature: string) => `${signature}00`],
    ['trailing space', (signature: string) => `${signature} `],
  ])('rejects a %s signature', async (_label, mangle) => {
    const signature = mangle(await signNotification(BASE));
    expect(await verifyNotificationSignature({ ...BASE, signature, now: BASE.timestamp })).toBe(
      false,
    );
  });

  it('rejects a non-integer verification clock', async () => {
    const signature = await signNotification(BASE);
    expect(await verifyNotificationSignature({ ...BASE, signature, now: Number.NaN })).toBe(false);
  });
});
