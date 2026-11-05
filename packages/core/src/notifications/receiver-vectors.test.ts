import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notificationHeaders, type NotificationMethod } from './signature.js';

const DOC = new URL('../../../../docs/integrations/notification-receiver.md', import.meta.url);
const BLOCK = /```js title="receiver\.mjs"\n([\s\S]*?)\n```/;
const KEY_TEXT = 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80';
const KEY = new Uint8Array(Buffer.from(KEY_TEXT, 'base64url'));
const DELIVERY = '0b8f3c2a-1d4e-4f6a-9b7c-2e5d8a1f3c4b';
const EVENT = '01JC5Z8N3K6W2Q9R4T7V0XA1BD';
const NOW = 1_793_534_400;

type Outcome = 'accepted' | 'duplicate' | 'rejected';
type Receive = (request: {
  method: string;
  headers: Headers;
  body: Uint8Array;
}) => Promise<Outcome>;
interface ReceiverModule {
  createReceiver(options: {
    signingKey: string;
    handle: (event: unknown) => unknown;
    seen?: Map<string, number>;
    now?: () => number;
  }): Receive;
}

let directory: string;
let receiverModule: ReceiverModule;

beforeAll(async () => {
  const source = BLOCK.exec(readFileSync(DOC, 'utf8'))?.[1];
  if (source === undefined) throw new Error('receiver.mjs block missing from the receiver doc');
  directory = mkdtempSync(join(tmpdir(), 'pb-receiver-'));
  const file = join(directory, 'receiver.mjs');
  writeFileSync(file, source);
  receiverModule = (await import(pathToFileURL(file).href)) as ReceiverModule;
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const body = new TextEncoder().encode(
  JSON.stringify({ schemaVersion: 1, id: EVENT, type: 'npm.package.published' }),
);

async function signed(
  method: NotificationMethod = 'POST',
  timestamp = NOW,
  payload: Uint8Array = body,
): Promise<{ method: string; headers: Headers; body: Uint8Array }> {
  const headers = new Headers(
    (await notificationHeaders({
      key: KEY,
      timestamp,
      deliveryId: DELIVERY,
      eventId: EVENT,
      method,
      body: payload,
    })) as [string, string][],
  );
  return { method, headers, body: payload };
}

function receiver(now = NOW) {
  const effects: unknown[] = [];
  const receive = receiverModule.createReceiver({
    signingKey: KEY_TEXT,
    handle: (event) => effects.push(event),
    now: () => now,
  });
  return { receive, effects };
}

function withHeader(request: Awaited<ReturnType<typeof signed>>, name: string, value: string) {
  const headers = new Headers(request.headers);
  headers.set(name, value);
  return { ...request, headers };
}

describe('documented receiver against broker signatures', () => {
  it.each(['POST', 'PUT'] as const)('accepts a %s signed by the broker', async (method) => {
    const r = receiver();
    expect(await r.receive(await signed(method))).toBe('accepted');
    expect(r.effects).toEqual([JSON.parse(new TextDecoder().decode(body))]);
  });

  it('rejects a tampered body', async () => {
    const r = receiver();
    const request = await signed();
    const tampered = Uint8Array.from(request.body);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
    expect(await r.receive({ ...request, body: tampered })).toBe('rejected');
    expect(r.effects).toEqual([]);
  });

  it('rejects a request replayed with another method', async () => {
    const r = receiver();
    expect(await r.receive({ ...(await signed('POST')), method: 'PUT' })).toBe('rejected');
  });

  it.each([
    ['x-package-broker-delivery', '1b8f3c2a-1d4e-4f6a-9b7c-2e5d8a1f3c4b'],
    ['x-package-broker-event', '01JC5Z8N3K6W2Q9R4T7V0XA1BE'],
    ['x-package-broker-timestamp', String(NOW + 1)],
  ])('rejects a changed %s', async (name, value) => {
    const r = receiver();
    expect(await r.receive(withHeader(await signed(), name, value))).toBe('rejected');
    expect(r.effects).toEqual([]);
  });

  it('rejects a signature made with another key or truncated', async () => {
    const r = receiver();
    const request = await signed();
    const signature = request.headers.get('x-package-broker-signature')!;
    const flipped = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
    expect(await r.receive(withHeader(request, 'x-package-broker-signature', flipped))).toBe(
      'rejected',
    );
    expect(
      await r.receive(withHeader(request, 'x-package-broker-signature', signature.slice(0, 40))),
    ).toBe('rejected');
  });

  it.each([
    [NOW - 301, 'rejected'],
    [NOW + 301, 'rejected'],
    [NOW - 300, 'accepted'],
    [NOW + 300, 'accepted'],
  ] as const)('applies the 300-second window to a request signed at %i', async (at, outcome) => {
    const r = receiver();
    expect(await r.receive(await signed('POST', at))).toBe(outcome);
  });

  it('processes a repeated delivery once', async () => {
    const r = receiver();
    const request = await signed();
    expect(await r.receive(request)).toBe('accepted');
    const retry = await signed('POST', NOW + 60);
    expect(await r.receive(retry)).toBe('duplicate');
    expect(r.effects).toHaveLength(1);
  });

  it('serializes two concurrent replays even with a synchronous handler', async () => {
    const r = receiver();
    const request = await signed();
    expect(await Promise.all([r.receive(request), r.receive(request)])).toEqual([
      'accepted',
      'duplicate',
    ]);
    expect(r.effects).toHaveLength(1);
  });

  it('allows a waiting replay to retry after an in-flight handler fails', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Map<string, number>();
    const receive = receiverModule.createReceiver({
      signingKey: KEY_TEXT,
      seen,
      now: () => NOW,
      async handle() {
        calls++;
        if (calls === 1) {
          await gate;
          throw new Error('try again');
        }
      },
    });
    const request = await signed();
    const first = expect(receive(request)).rejects.toThrow('try again');
    const retry = receive(request);
    const callsWhileInFlight = calls;
    release();
    await first;
    expect(await retry).toBe('accepted');
    expect(callsWhileInFlight).toBe(1);
    expect(await receive(request)).toBe('duplicate');
    expect(calls).toBe(2);
    expect(seen.size).toBe(1);
  });

  it('keeps a delivery ID for seven days', async () => {
    const seen = new Map<string, number>();
    const effects: unknown[] = [];
    const at = (now: number) =>
      receiverModule.createReceiver({
        signingKey: KEY_TEXT,
        handle: (event) => effects.push(event),
        seen,
        now: () => now,
      });
    const week = 7 * 24 * 60 * 60;
    expect(await at(NOW)(await signed())).toBe('accepted');
    expect(await at(NOW + week - 1)(await signed('POST', NOW + week - 1))).toBe('duplicate');
    expect(effects).toHaveLength(1);
  });

  it('records nothing when the work fails, so the retry runs it again', async () => {
    let fail = true;
    const effects: unknown[] = [];
    const receive = receiverModule.createReceiver({
      signingKey: KEY_TEXT,
      handle: (event) => {
        if (fail) throw new Error('downstream unavailable');
        effects.push(event);
      },
      now: () => NOW,
    });
    await expect(receive(await signed())).rejects.toThrow('downstream unavailable');
    fail = false;
    expect(await receive(await signed('POST', NOW + 60))).toBe('accepted');
    expect(effects).toHaveLength(1);
  });
});
