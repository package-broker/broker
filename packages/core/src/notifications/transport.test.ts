import { describe, expect, it, vi } from 'vitest';
import { notificationHeaders } from './signature.js';
import {
  MAX_NOTIFICATION_BODY_BYTES,
  NotificationDestinationRefused,
  NotificationRequestError,
  createNotificationTransport,
  type NotificationRequest,
  type NotificationSend,
} from './transport.js';

const URL_TEXT = 'https://hooks.example.com/in/SECRET-PATH?token=SECRET-QUERY';
const BODY = new TextEncoder().encode('{"schemaVersion":1}');

async function request(over: Partial<NotificationRequest> = {}): Promise<NotificationRequest> {
  const signed = await notificationHeaders({
    key: new Uint8Array(32).fill(7),
    timestamp: 1_767_225_600,
    deliveryId: '01JDELIVERY00000000000000A',
    eventId: '01JEVENT0000000000000000AB',
    method: 'POST',
    body: BODY,
  });
  return {
    url: URL_TEXT,
    method: 'POST',
    headers: [['Authorization', 'Bearer SECRET-HEADER']],
    signed,
    body: BODY,
    signal: new AbortController().signal,
    ...over,
  };
}

function transport(send: NotificationSend, destination = () => true, timeoutMs?: number) {
  return createNotificationTransport({
    send,
    destination,
    selfOrigins: ['https://broker.example.org'],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const ok = (
  init?: ResponseInit,
  body: string | ReadableStream<Uint8Array> | null = 'receiver SECRET-BODY',
) => vi.fn<NotificationSend>(async () => new Response(body, init));

describe('notification transport contract', () => {
  it('sends one POST with exact bytes, fixed JSON type, manual redirects and both header sets', async () => {
    const send = ok({ status: 202 });
    const result = await transport(send).send(await request());
    expect(result).toMatchObject({ kind: 'response', status: 202, retryAfter: null });
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe(URL_TEXT);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect([...init.body]).toEqual([...BODY]);
    expect(init.headers.get('content-type')).toBe('application/json');
    expect(init.headers.get('authorization')).toBe('Bearer SECRET-HEADER');
    expect(init.headers.get('idempotency-key')).toBe('01JDELIVERY00000000000000A');
    expect(init.headers.get('x-package-broker-signature')).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(init.headers.has('cookie')).toBe(false);
  });

  it('accepts PUT and refuses any other method before a call', async () => {
    const send = ok();
    expect((await transport(send).send(await request({ method: 'PUT' }))).kind).toBe('response');
    for (const method of ['GET', 'DELETE', 'post', 'PATCH'])
      await expect(
        transport(send).send(await request({ method: method as 'POST' })),
      ).rejects.toBeInstanceOf(NotificationRequestError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized body and a non-binary body before a call', async () => {
    const send = ok();
    await expect(
      transport(send).send(
        await request({ body: new Uint8Array(MAX_NOTIFICATION_BODY_BYTES + 1) }),
      ),
    ).rejects.toBeInstanceOf(NotificationRequestError);
    await expect(
      transport(send).send(await request({ body: 'text' as unknown as Uint8Array })),
    ).rejects.toBeInstanceOf(NotificationRequestError);
    expect(
      (
        await transport(send).send(
          await request({ body: new Uint8Array(MAX_NOTIFICATION_BODY_BYTES) }),
        )
      ).kind,
    ).toBe('response');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses reserved or forged headers before a call', async () => {
    const send = ok();
    const base = await request();
    const forged: NotificationRequest[] = [
      { ...base, headers: [['Host', 'internal']] },
      { ...base, headers: [['Cookie', 'a=b']] },
      { ...base, headers: [['X-Package-Broker-Signature', 'v1=00']] },
      { ...base, headers: [['Content-Type', 'text/plain']] },
      { ...base, headers: [['X-Ok', 'a\r\nInjected: 1']] },
      { ...base, signed: base.signed.slice(1) },
      { ...base, signed: [['Content-Type', 'text/plain'], ...base.signed.slice(1)] },
      { ...base, signed: [...base.signed.slice(0, 5), ['X-Other', 'x']] },
    ];
    for (const candidate of forged)
      await expect(transport(send).send(candidate)).rejects.toBeInstanceOf(
        NotificationRequestError,
      );
    expect(send).not.toHaveBeenCalled();
  });

  it('classifies the destination before every attempt and makes no call when refused', async () => {
    const send = ok();
    const destination = vi.fn(() => false);
    expect(await transport(send, destination).send(await request())).toEqual({
      kind: 'refused',
      durationMs: 0,
    });
    expect(destination).toHaveBeenCalledWith(URL_TEXT);
    for (const url of [
      'http://hooks.example.com/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://hooks.example.com:8443/',
      'https://user:pw@hooks.example.com/',
      'https://hooks.example.com/#frag',
      'https://broker.example.org/hook',
      'https://localhost/',
      'https://metadata.internal/',
    ])
      expect((await transport(send).send(await request({ url }))).kind).toBe('refused');
    expect(send).not.toHaveBeenCalled();
    const allowed = vi.fn(() => true);
    await transport(send, allowed).send(await request());
    await transport(send, allowed).send(await request());
    expect(allowed).toHaveBeenCalledTimes(2);
  });

  it('maps a connector refusal to refused and other failures to network', async () => {
    const refusing = vi.fn<NotificationSend>(async () => {
      throw new NotificationDestinationRefused();
    });
    expect((await transport(refusing).send(await request())).kind).toBe('refused');
    const failing = vi.fn<NotificationSend>(async () => {
      throw new TypeError('connect ECONNREFUSED SECRET-PATH');
    });
    const result = await transport(failing).send(await request());
    expect(result.kind).toBe('network');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('summarises a response without body, URL or headers beyond a bounded Retry-After', async () => {
    const send = ok({
      status: 503,
      headers: { 'retry-after': '120', 'set-cookie': 'SECRET-COOKIE', location: URL_TEXT },
    });
    const result = await transport(send).send(await request());
    expect(Object.keys(result).sort()).toEqual(['durationMs', 'kind', 'retryAfter', 'status']);
    expect(result).toMatchObject({ kind: 'response', status: 503, retryAfter: '120' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    const long = ok({ status: 429, headers: { 'retry-after': '9'.repeat(65) } });
    expect(await transport(long).send(await request())).toMatchObject({ retryAfter: null });
  });

  it('returns a redirect as a status without following it', async () => {
    const send = ok({ status: 302, headers: { location: 'https://elsewhere.example.com/' } });
    expect(await transport(send).send(await request())).toMatchObject({
      kind: 'response',
      status: 302,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('cancels the receiver body right after the status, even when it never ends', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancelled = true;
      },
    });
    let signal: AbortSignal | undefined;
    const send = vi.fn<NotificationSend>(async (_, init) => {
      signal = init.signal;
      return new Response(body, { status: 200 });
    });
    expect((await transport(send).send(await request())).kind).toBe('response');
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('times out a receiver that never answers and aborts the connection', async () => {
    let signal: AbortSignal | undefined;
    const send = vi.fn<NotificationSend>(
      (_, init) =>
        new Promise((_, reject) => {
          signal = init.signal;
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    expect((await transport(send, () => true, 20).send(await request())).kind).toBe('timeout');
    expect(signal?.aborted).toBe(true);
  });

  it('propagates the job abort to the connection and reports it as aborted', async () => {
    const controller = new AbortController();
    let linked: boolean | undefined;
    const send = vi.fn<NotificationSend>(
      (_, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          controller.abort();
          linked = init.signal.aborted;
        }),
    );
    expect((await transport(send).send(await request({ signal: controller.signal }))).kind).toBe(
      'aborted',
    );
    expect(linked).toBe(true);
    const before = ok();
    expect(
      (await transport(before).send(await request({ signal: AbortSignal.abort() }))).kind,
    ).toBe('aborted');
    expect(before).not.toHaveBeenCalled();
  });
});
