import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from './kernel.js';

async function harness() {
  const schemaMatches = vi.fn(async () => true);
  const health = vi.fn(async () => true);
  const resolveOrg = vi.fn(async () => orgContext('org-test'));
  const log = vi.fn();
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-26T00:00:00.000Z'),
      ids: { ulid: () => 'test-id' },
    },
    health,
    resolveOrg,
    log,
    schemaMatches,
  });
  return {
    schemaMatches,
    health,
    resolveOrg,
    log,
    request: (path = '/health/ready') => kernel.fetch(new Request(`https://broker.test${path}`)),
  };
}

describe('schema readiness through the kernel', () => {
  it('reports schema drift and leaves liveness unchanged', async () => {
    const h = await harness();
    h.schemaMatches.mockResolvedValue(false);
    const live = await h.request('/health/live');
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'live' });
    expect(h.schemaMatches).not.toHaveBeenCalled();

    const response = await h.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready', reason: 'schema_drift' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(h.health).not.toHaveBeenCalled();
    expect(h.resolveOrg).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledTimes(2);
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        event: 'health.schema_drift',
        request_id: response.headers.get('x-request-id'),
      }),
    );
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'http.request' }));
  });

  it('retries failed reads and mismatches, then caches a pass while probing health every time', async () => {
    const h = await harness();
    h.schemaMatches
      .mockRejectedValueOnce(new Error('database read failed; secret-migration-id secret-checksum'))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const failedRead = await h.request();
    expect(failedRead.status).toBe(503);
    expect(await failedRead.json()).toHaveProperty('error.code', 'not_ready');
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'http.error' }));
    expect(h.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'health.schema_drift' }),
    );
    const drift = await h.request();
    expect(drift.status).toBe(503);
    expect(await drift.json()).toEqual({ status: 'not_ready', reason: 'schema_drift' });
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await h.request();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ready' });
    }
    h.health.mockResolvedValue(false);
    const unavailable = await h.request();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toHaveProperty('error.code', 'not_ready');
    expect(h.schemaMatches).toHaveBeenCalledTimes(3);
    expect(h.health).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('secret-');
  });

  it('shares a pending check across concurrent probes and retries a shared failure', async () => {
    const h = await harness();
    let finish!: (matches: boolean) => void;
    h.schemaMatches.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.request();
    const second = h.request();
    await vi.waitFor(() => expect(h.schemaMatches).toHaveBeenCalledTimes(1));
    finish(false);
    for (const response of await Promise.all([first, second])) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'not_ready', reason: 'schema_drift' });
    }
    expect((await h.request()).status).toBe(200);
    expect((await h.request()).status).toBe(200);
    expect(h.schemaMatches).toHaveBeenCalledTimes(2);
  });
});
