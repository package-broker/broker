import { describe, expect, it, vi } from 'vitest';
import {
  notificationHeaders,
  type NotificationRequest,
} from '@package-broker/core/runtime/notification-jobs';
import { createWorkersNotificationTransport } from './transport.js';

const URL_TEXT = 'https://hooks.example.com/in?token=SECRET-QUERY';
const BODY = new TextEncoder().encode('{"schemaVersion":1}');

async function request(over: Partial<NotificationRequest> = {}): Promise<NotificationRequest> {
  const method = over.method ?? 'POST';
  return {
    url: URL_TEXT,
    method,
    headers: [['Authorization', 'Bearer SECRET-HEADER']],
    signed: await notificationHeaders({
      key: new Uint8Array(32).fill(3),
      timestamp: 1_767_225_600,
      deliveryId: '01JDELIVERY00000000000000A',
      eventId: '01JEVENT0000000000000000AB',
      method,
      body: BODY,
    }),
    body: BODY,
    signal: new AbortController().signal,
    ...over,
  };
}

type Fetch = typeof fetch;
const native = (response: () => Response = () => new Response('SECRET-BODY', { status: 200 })) =>
  vi.fn<Fetch>(async () => response());

describe('Workers notification transport', () => {
  it('calls native fetch as a plain function with manual redirects and the exact bytes', async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response(null, { status: 202 }));
    const transport = createWorkersNotificationTransport({ selfOrigins: [], fetch: fetchImpl });
    expect(await transport.send(await request({ method: 'PUT' }))).toMatchObject({
      kind: 'response',
      status: 202,
    });
    expect(fetchImpl.mock.contexts[0]).toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL_TEXT);
    expect(init?.method).toBe('PUT');
    expect(init?.redirect).toBe('manual');
    expect([...(init?.body as Uint8Array)]).toEqual([...BODY]);
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('uses the global fetch when none is injected', async () => {
    const global = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const transport = createWorkersNotificationTransport({ selfOrigins: [] });
      expect((await transport.send(await request())).kind).toBe('response');
      expect(global).toHaveBeenCalledTimes(1);
      expect(global.mock.calls[0]![1]?.redirect).toBe('manual');
    } finally {
      global.mockRestore();
    }
  });

  it('classifies at configuration time without any network call', () => {
    const fetchImpl = native();
    const transport = createWorkersNotificationTransport({
      selfOrigins: ['https://broker.example.org'],
      fetch: fetchImpl,
    });
    expect(transport.allows(URL_TEXT)).toBe(true);
    for (const url of [
      'https://10.0.0.1/hook',
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://93.184.216.34/hook',
      'https://broker.example.org/hook',
      'https://hooks..example.com/hook',
      'https://localhost/hook',
      'https://hooks.example.com:8443/hook',
      'http://hooks.example.com/hook',
    ])
      expect(transport.allows(url)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reclassifies immediately before every attempt, so a changed target is refused without a call', async () => {
    const fetchImpl = native();
    const transport = createWorkersNotificationTransport({ selfOrigins: [], fetch: fetchImpl });
    expect((await transport.send(await request())).kind).toBe('response');
    for (const url of [
      'https://169.254.169.254/latest',
      'https://[fd00::1]/hook',
      'https://hooks..example.com/hook',
      'https://intranet/hook',
    ])
      expect((await transport.send(await request({ url }))).kind).toBe('refused');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a platform refusal or connection failure as a safe network outcome', async () => {
    const fetchImpl = vi.fn<Fetch>(async () => {
      throw new TypeError('Network connection lost to SECRET-QUERY');
    });
    const result = await createWorkersNotificationTransport({
      selfOrigins: [],
      fetch: fetchImpl,
    }).send(await request());
    expect(result.kind).toBe('network');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('returns a redirect status without following it and drops its body', async () => {
    const fetchImpl = native(
      () =>
        new Response('SECRET-BODY', {
          status: 301,
          headers: { location: 'https://10.0.0.1/', 'retry-after': '5' },
        }),
    );
    const result = await createWorkersNotificationTransport({
      selfOrigins: [],
      fetch: fetchImpl,
    }).send(await request());
    expect(result).toMatchObject({ kind: 'response', status: 301, retryAfter: '5' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out a receiver that never answers', async () => {
    const fetchImpl = vi.fn<Fetch>(
      (_, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const transport = createWorkersNotificationTransport({
      selfOrigins: [],
      fetch: fetchImpl,
      timeoutMs: 20,
    });
    const started = Date.now();
    expect((await transport.send(await request())).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
