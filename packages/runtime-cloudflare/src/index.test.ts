import { describe, expect, it } from 'vitest';
import { createWorker } from './index.js';

describe('runtime-cloudflare', () => {
  it('answers unknown routes with the error envelope', async () => {
    const response = await createWorker([]).fetch(new Request('https://broker.invalid/nope'));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
  });
});
