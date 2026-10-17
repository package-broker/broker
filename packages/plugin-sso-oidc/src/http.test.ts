import type { IdentityContext } from '@package-broker/core/identity/port';
import { describe, expect, it } from 'vitest';
import { BoundedFetchError, fetchBounded } from './http.js';

function ctxFor(respond: () => Response): IdentityContext {
  return {
    fetch: async () => respond(),
    clock: { now: () => new Date(0) },
    env: () => undefined,
  };
}

function json(body: string, status: number, type = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BoundedFetchError) {
      return error.reason;
    }
    throw error;
  }
  return 'resolved';
}

const request = () => new Request('https://idp.example/token', { method: 'POST' });
const limits = { maxBytes: 64, timeoutMs: 1000 };
const optIn = { ...limits, readErrorBody: true };

describe('fetchBounded error bodies', () => {
  it('still refuses a 400 JSON body as status without the opt-in', async () => {
    const ctx = ctxFor(() => json('{"error":"invalid_grant"}', 400));
    expect(await reasonOf(fetchBounded(ctx, request(), limits))).toBe('status');
  });

  it('returns a 400 JSON body with its status when opted in', async () => {
    const ctx = ctxFor(() => json('{"error":"invalid_grant"}', 400));
    await expect(fetchBounded(ctx, request(), optIn)).resolves.toEqual({
      status: 400,
      json: { error: 'invalid_grant' },
    });
  });

  it('maps a non-JSON error body to status when opted in', async () => {
    const ctx = ctxFor(() => json('<html>denied</html>', 401, 'text/html'));
    expect(await reasonOf(fetchBounded(ctx, request(), optIn))).toBe('status');
  });

  it('maps an unparseable JSON error body to status when opted in', async () => {
    const ctx = ctxFor(() => json('{"error":', 400));
    expect(await reasonOf(fetchBounded(ctx, request(), optIn))).toBe('status');
  });

  it('maps an over-cap error body to status when opted in', async () => {
    const ctx = ctxFor(() => json(JSON.stringify({ error: 'x'.repeat(100) }), 400));
    expect(await reasonOf(fetchBounded(ctx, request(), optIn))).toBe('status');
  });

  it('still refuses a redirect when opted in', async () => {
    const ctx = ctxFor(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    );
    expect(await reasonOf(fetchBounded(ctx, request(), optIn))).toBe('redirect');
  });
});
