import { describe, expect, it, vi } from 'vitest';
import { createWorker, unboundExecutor } from './index.js';

describe('runtime-cloudflare', () => {
  it('answers unknown routes with the error envelope', async () => {
    const response = await createWorker([]).fetch(new Request('https://broker.invalid/nope'));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('reports the no-binding stub executor as driver none', async () => {
    const executor = unboundExecutor();
    expect(executor.driver).toBe('none');
    await expect(executor.all({ sql: 'SELECT 1', params: [] })).rejects.toThrow('no DB binding');
    await expect(executor.batch([])).rejects.toThrow('no DB binding');
  });

  it('answers an unexpected kernel rejection with the error envelope', async () => {
    vi.resetModules();
    vi.doMock('@package-broker/core/kernel/kernel', () => ({
      createKernel: () =>
        Promise.resolve({
          fetch: () => Promise.reject(new Error('kernel exploded')),
          registration: { routes: [], hooks: { 'access.check': [] }, bindings: new Map() },
        }),
    }));
    try {
      const { createWorker: createWorkerWithFailingKernel } = await import('./index.js');
      const response = await createWorkerWithFailingKernel([], { log: () => undefined }).fetch(
        new Request('https://broker.invalid/anything'),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe('internal');
      expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
    } finally {
      vi.doUnmock('@package-broker/core/kernel/kernel');
      vi.resetModules();
    }
  });
});
