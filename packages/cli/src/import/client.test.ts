import { describe, expect, it, vi } from 'vitest';
import { ImportClient, brokerOrigin, importManifest, type RunStatus } from './client.js';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENTINEL = 'sentinel-secret-never-in-output';
const raw = {
  version: 1,
  source_system: 'test',
  widening: [],
  items: [
    {
      type: 'source',
      external_ref: 'test:source/a',
      name: 'test-source',
      ecosystem: 'composer',
      source_type: 'composer_repository',
      project: null,
      url: 'https://repo.test/',
      credential_ref: 'env:SOURCE_AUTH',
      config: {
        selection: { packages: ['acme/lib'], patterns: [], expandPatterns: false },
        distHosts: [],
        mirrorsFallback: false,
      },
    },
  ],
};
const plan = await importManifest(JSON.stringify(raw));
const binding = {
  external_ref: 'test:source/a',
  credential_ref: 'env:SOURCE_AUTH',
  kind: 'bearer' as const,
};
const ready: RunStatus = {
  id: ID,
  state: 'applied',
  planHash: plan.hash,
  approvedAt: '2026-10-24T11:50:00.000Z',
  acceptedAt: null,
  credentialWindowUntil: '2026-10-24T12:50:00.000Z',
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const client = (fetcher: typeof fetch, now = () => NOW) =>
  new ImportClient({
    broker: 'https://broker.test',
    token: 'broker-token-sentinel',
    fetch: fetcher,
    now,
  });

describe('broker transport', () => {
  it.each([
    'http://broker.test',
    'http://127.0.0.1',
    'http://localhost.evil',
    'https://user:password@broker.test',
    'https://broker.test/path',
    'https://broker.test?token=secret',
    'https://broker.test/#x',
    'https://broker.test/../',
    'ftp://localhost',
  ])('refuses unsafe origin %s', (origin) => {
    expect(() => brokerOrigin(origin)).toThrow('Use a bare HTTPS');
  });
  it.each(['https://broker.test', 'https://broker.test/', 'http://localhost:8787'])(
    'allows %s',
    (origin) => expect(brokerOrigin(origin)).toBe(new URL(origin).origin),
  );
  it('replays canonical POST with the same key after a lost response', async () => {
    const runs = new Map<string, string>();
    let lose = true;
    const requests: RequestInit[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      requests.push(init!);
      const key = new Headers(init!.headers).get('idempotency-key')!;
      runs.set(key, ID);
      if (lose) {
        lose = false;
        throw new Error(SENTINEL);
      }
      return json({ id: runs.get(key), planHash: plan.hash, state: 'planned' }, 201);
    });
    const api = client(fetcher);
    await expect(api.submit(plan.canonical, 'stable-key')).rejects.toMatchObject({
      code: 'outcome_unknown',
      exitCode: 6,
    });
    expect(await api.submit(plan.canonical, 'stable-key')).toEqual({
      id: ID,
      planHash: plan.hash,
      state: 'planned',
    });
    expect(runs.size).toBe(1);
    expect(requests.map((r) => r.body)).toEqual([plan.canonical, plan.canonical]);
    expect(requests[0]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    expect(new Headers(requests[0]!.headers).get('cookie')).toBeNull();
  });
  it.each([
    'not_found',
    'not_approved',
    'conflict',
    'unauthorized',
    'forbidden',
    'idempotency_mismatch',
    'unavailable',
  ])('prints fixed envelope text for %s', async (code) => {
    const api = client(
      vi.fn(async () =>
        json({ error: { code, message: SENTINEL, details: SENTINEL }, extra: SENTINEL }, 409),
      ),
    );
    const error = await api.status(ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ code, exitCode: 1 });
    expect(String(error)).not.toContain(SENTINEL);
  });
  it.each([
    json({ error: { code: SENTINEL, message: SENTINEL } }, 500),
    new Response(SENTINEL, { status: 500 }),
    new Response('x'.repeat(65537), { status: 500 }),
  ])('does not echo malformed responses', async (response) => {
    const error = await client(vi.fn(async () => response))
      .status(ID)
      .catch((e: unknown) => e);
    expect(String(error)).not.toContain(SENTINEL);
    expect(error).toMatchObject({ exitCode: 1 });
  });
  it('rejects unrecognized status fields without echoing their values', async () => {
    await expect(
      client(vi.fn(async () => json({ ...ready, state: SENTINEL }))).status(ID),
    ).rejects.toMatchObject({ code: 'incompatible_response' });
    await expect(
      client(vi.fn(async () => json({ ...ready, approvedAt: SENTINEL }))).status(ID),
    ).rejects.toMatchObject({ code: 'incompatible_response' });
  });
  it('rejects invalid run IDs before making a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).status('../approve')).rejects.toMatchObject({ exitCode: 2 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('credential upload', () => {
  it('resolves only approved source references and encodes the ref as one segment', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'GET'
        ? json({ ...ready, ignored: SENTINEL })
        : new Response(null, { status: 204 }),
    );
    const resolver = vi.fn(async () => JSON.stringify({ token: SENTINEL }));
    expect(await client(fetcher).credentials(ID, plan.manifest, [binding], resolver)).toBe(1);
    expect(resolver).toHaveBeenCalledExactlyOnceWith('env:SOURCE_AUTH');
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `https://broker.test/_pb/import-runs/${ID}/credentials/test%3Asource%2Fa`,
    );
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
      kind: 'bearer',
      material: JSON.stringify({ token: SENTINEL }),
    });
  });
  it.each([
    { approvedAt: null },
    { state: 'planned' },
    { state: 'applying' },
    { state: 'cancelled' },
    { planHash: '0'.repeat(64) },
    { credentialWindowUntil: undefined },
    { credentialWindowUntil: null },
    { credentialWindowUntil: '2026-10-24T12:00:00.000Z' },
  ])('checks readiness before resolving (%j)', async (patch) => {
    const resolver = vi.fn(async () => SENTINEL);
    const fetcher = vi.fn(async () => json({ ...ready, ...patch }));
    await expect(
      client(fetcher).credentials(ID, plan.manifest, [binding], resolver),
    ).rejects.toBeInstanceOf(Error);
    expect(resolver).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(
    [
      [{ ...binding, external_ref: 'non-source' }],
      [{ ...binding, credential_ref: 'env:OTHER' }],
      [],
      [binding, binding],
    ].map((bindings) => ({ bindings })),
  )('refuses invalid bindings before resolving (%j)', async ({ bindings }) => {
    const resolver = vi.fn(async () => SENTINEL);
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      client(fetcher).credentials(ID, plan.manifest, bindings, resolver),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });
  it('checks source-specific credential kinds before fetching or resolving', async () => {
    const resolver = vi.fn(async () => SENTINEL);
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      client(fetcher).credentials(
        ID,
        plan.manifest,
        [{ ...binding, kind: 'github_app' }],
        resolver,
      ),
    ).rejects.toMatchObject({ code: 'invalid_credential_kind', exitCode: 2 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });
  it('rechecks the deadline after slow resolution', async () => {
    let now = NOW;
    const fetcher = vi.fn(async () => json(ready));
    const resolver = async () => {
      now += 3600000;
      return JSON.stringify({ token: SENTINEL });
    };
    await expect(
      client(fetcher, () => now).credentials(ID, plan.manifest, [binding], resolver),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves a server window-race refusal code without retrying PUT', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'GET'
        ? json(ready)
        : json({ error: { code: 'conflict', message: SENTINEL } }, 409),
    );
    await expect(
      client(fetcher).credentials(ID, plan.manifest, [binding], async () =>
        JSON.stringify({ token: SENTINEL }),
      ),
    ).rejects.toMatchObject({ code: 'conflict', message: 'Conflict', exitCode: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['resolver throws', 'invalid material', 'too large', 'lost upload'])(
    'never exposes secrets when %s',
    async (mode) => {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === 'GET') return json(ready);
        throw new Error(SENTINEL);
      });
      const resolver = async () => {
        if (mode === 'resolver throws') throw new Error(SENTINEL);
        return mode === 'invalid material'
          ? SENTINEL
          : JSON.stringify({ token: mode === 'too large' ? SENTINEL.repeat(1000) : SENTINEL });
      };
      const error = await client(fetcher)
        .credentials(ID, plan.manifest, [binding], resolver)
        .catch((e: unknown) => e);
      expect(String(error)).not.toContain(SENTINEL);
      expect(error).toMatchObject({ exitCode: mode === 'lost upload' ? 6 : 2 });
      expect(fetcher).toHaveBeenCalledTimes(mode === 'lost upload' ? 2 : 1);
    },
  );
});
