import { describe, expect, it } from 'vitest';
import { createWorker } from './index.js';

describe('Worker public origin security headers', () => {
  it('uses configured HTTPS on an internal HTTP request', async () => {
    const response = await createWorker([], { log: () => undefined }).fetch(
      new Request('http://internal.test/health/live'),
      { PB_PUBLIC_URL: 'https://public.test' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('does not infer HSTS from the request without a configured origin', async () => {
    const response = await createWorker([], { log: () => undefined }).fetch(
      new Request('https://internal.test/health/live'),
    );
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });
});
