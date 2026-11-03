import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationHeaders } from '@package-broker/core/runtime/notification-jobs';
import { createNodeNotificationTransport } from './transport.js';

const connection = vi.hoisted(() => ({ stalled: true, requests: 0 }));
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return {
    ...actual,
    request: (options: {
      lookup: (host: string, options: object, callback: (error: Error | null) => void) => void;
    }) => {
      connection.requests += 1;
      const req = new EventEmitter() as EventEmitter & {
        end(): void;
        destroy(error?: Error): void;
      };
      let closed = false;
      req.destroy = (error) => {
        if (closed) return;
        closed = true;
        queueMicrotask(() => {
          if (error) req.emit('error', error);
          req.emit('close');
        });
      };
      req.end = () => {
        options.lookup('hooks.example.com', {}, (error) => {
          if (error || !connection.stalled)
            req.destroy(error ?? new Error('public connection failed'));
        });
      };
      return req;
    },
  };
});

afterEach(() => {
  connection.stalled = true;
  connection.requests = 0;
});

async function request() {
  const body = new TextEncoder().encode('{}');
  return {
    url: 'https://hooks.example.com/in',
    method: 'POST' as const,
    headers: [],
    body,
    signal: new AbortController().signal,
    signed: await notificationHeaders({
      key: new Uint8Array(32),
      timestamp: 1,
      deliveryId: 'd',
      eventId: 'e',
      method: 'POST',
      body,
    }),
  };
}

describe('notification connection budget and rebinding', () => {
  it('bounds a stalled TCP/TLS connection within the total deadline', async () => {
    const transport = createNodeNotificationTransport({
      selfOrigins: [],
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    const started = Date.now();
    expect((await transport.send(await request())).kind).toBe('network');
    expect(Date.now() - started).toBeLessThan(4500);
  }, 15_000);

  it('checks DNS again after a public answer and refuses a private rebind before sending', async () => {
    connection.stalled = false;
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.1.1.1', family: 4 }]);
    const transport = createNodeNotificationTransport({ selfOrigins: [], resolver });
    expect((await transport.send(await request())).kind).toBe('network');
    expect((await transport.send(await request())).kind).toBe('refused');
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});
