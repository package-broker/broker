import { expect, it, vi } from 'vitest';
import { planRepository } from './github-discovery.js';
import type { PolicyFetch } from './policy-fetch.js';
for (const [status, remaining, body, code] of [
  [403, '4999', 'permission denied', 'upstream_status'],
  [403, '0', '', 'rate_limited'],
  [403, '4999', 'secondary rate limit', 'rate_limited'],
  [429, '4999', '', 'rate_limited'],
] as const)
  it(`classifies ${status}/${remaining}/${body} from throttle evidence`, async () => {
    const fetch = vi.fn(async () => {
      const response = new Response(body, {
        status,
        headers: { 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': '9999999999' },
      });
      return { status: response.status, headers: response.headers, body: response.body };
    }) as unknown as PolicyFetch;
    await expect(
      planRepository({
        tokens: { forListing: async () => ({ value: 'token' }), observe: () => {} } as never,
        fetch,
        installationId: '41',
        repository: 'acme/library',
        exists: () => false,
        now: () => Date.parse('2026-11-04T12:00:00Z'),
      }),
    ).rejects.toMatchObject({
      code,
      ...(code === 'rate_limited' ? { retryAfter: 3600 } : { retryAfter: undefined }),
    });
  });

it('uses the injected clock to compute the remaining reset wait', async () => {
  const now = Date.parse('2026-11-04T12:00:00.000Z');
  const fetch = async () => ({
    status: 429,
    headers: new Headers({ 'x-ratelimit-reset': String(now / 1000 + 600) }),
    body: null,
  });
  await expect(
    planRepository({
      tokens: { forListing: async () => ({ value: 'token' }), observe: () => {} } as never,
      fetch,
      installationId: '41',
      repository: 'acme/library',
      exists: () => false,
      now: () => now,
    }),
  ).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 600 });
});
