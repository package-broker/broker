import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
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
