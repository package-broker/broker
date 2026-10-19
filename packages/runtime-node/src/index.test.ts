import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeServer } from './index.js';

describe('runtime-node', () => {
  const { server } = createNodeServer([]);
  afterEach(() => server.close());

  it('answers unknown routes with the error envelope', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
  });
});

describe('close order', () => {
  it('waits for HTTP server close before closing the database', async () => {
    const closeDatabase = vi.fn(() => Promise.resolve());
    const broker = createNodeServer([], { closeDatabase });
    await broker.ready();
    const listening = vi.spyOn(broker.server, 'listening', 'get').mockReturnValue(true);
    let finishHttp!: () => void;
    const close = vi.spyOn(broker.server, 'close').mockImplementation((callback) => {
      finishHttp = () => callback?.();
      return broker.server;
    });
    try {
      const closing = broker.close();
      await Promise.resolve();
      expect(close).toHaveBeenCalledTimes(1);
      expect(closeDatabase).not.toHaveBeenCalled();
      finishHttp();
      await closing;
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      listening.mockRestore();
    }
  });
});
