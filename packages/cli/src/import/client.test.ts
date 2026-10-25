import { MAX_MANIFEST_BYTES } from '@package-broker/core/import/manifest';
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
  credentials: [{ sourceRef: 'test:source/a', bound: false }],
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
  it('reads credential summaries from a limit-size manifest with hundreds of long refs', async () => {
    const items = Array.from({ length: 700 }, (_, index) => ({
      ...raw.items[0]!,
      name: `source-${index}`,
      external_ref: `${index}:${'x'.repeat(190)}`,
    }));
    const baseBytes = Buffer.byteLength(JSON.stringify({ ...raw, items }));
    const padding = Math.floor((MAX_MANIFEST_BYTES - baseBytes) / items.length);
    const remainder = MAX_MANIFEST_BYTES - baseBytes - padding * items.length;
    for (const [index, item] of items.entries())
      item.credential_ref = `file:${'a'.repeat(padding + 10 + (index < remainder ? 1 : 0))}`;
    const large = await importManifest(JSON.stringify({ ...raw, items }));
    expect(Buffer.byteLength(large.canonical)).toBe(MAX_MANIFEST_BYTES);
    const credentials = items.map((item) => ({ sourceRef: item.external_ref, bound: false }));
    expect(Buffer.byteLength(JSON.stringify(credentials))).toBeGreaterThan(65536);
    expect(
      await client(vi.fn(async () => json({ ...ready, credentials }))).status(ID),
    ).toMatchObject({ credentials });
    await expect(
      client(vi.fn(async () => new Response('x'.repeat(MAX_MANIFEST_BYTES + 65537)))).status(ID),
    ).rejects.toMatchObject({ exitCode: 1 });
  });
  it.each([null, '', 'rate limit: ' + SENTINEL])(
    'reports non-JSON mutation rate limits independently of body %s',
    async (body) => {
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(body, {
            status: 429,
            headers: { 'retry-after': '2' },
          }),
      );
      const error = await client(fetcher)
        .submit(plan.canonical, 'rate-limit-key')
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'rate_limited', exitCode: 1, retryAfterMs: 2000 });
      expect(String(error)).not.toContain(SENTINEL);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('resends the canonical body with the same key after a lost response and reports a replay', async () => {
    let lose = true;
    const requests: RequestInit[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      requests.push(init!);
      if (lose) {
        lose = false;
        throw new Error(SENTINEL);
      }
      return Response.json(
        { id: ID, planHash: plan.hash, state: 'planned' },
        { status: 201, headers: { 'idempotent-replayed': 'true' } },
      );
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
      replayed: true,
    });
    expect(requests.map((r) => new Headers(r.headers).get('idempotency-key'))).toEqual([
      'stable-key',
      'stable-key',
    ]);
    expect(requests.map((r) => r.body)).toEqual([plan.canonical, plan.canonical]);
    expect(requests[0]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    expect(new Headers(requests[0]!.headers).get('cookie')).toBeNull();
  });
  it('explains an idempotency mismatch without echoing server text', async () => {
    const error = await client(
      vi.fn(async () => json({ error: { code: 'idempotency_mismatch', message: SENTINEL } }, 409)),
    )
      .submit(plan.canonical, 'stable-key')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'idempotency_mismatch', exitCode: 1 });
    expect(String(error)).toContain('different manifest under this receipt key');
    expect(String(error)).not.toContain(SENTINEL);
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
    for (const patch of [
      { credentialWindowUntil: undefined },
      { credentials: undefined },
      { credentials: [{ sourceRef: 'a', bound: 'yes' }] },
      { credentials: [{ sourceRef: 'a', bound: true, material: SENTINEL }] },
      {
        credentials: [
          { sourceRef: 'a', bound: true },
          { sourceRef: 'a', bound: false },
        ],
      },
    ]) {
      const error = await client(vi.fn(async () => json({ ...ready, ...patch })))
        .status(ID)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'incompatible_response' });
      expect(String(error)).not.toContain(SENTINEL);
    }
  });
  it('rejects invalid run IDs before making a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).status('../approve')).rejects.toMatchObject({ exitCode: 2 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('credential upload', () => {
  it.each(['.', '..'])(
    'rejects URL-normalized dot ref %s before fetching or resolving',
    async (ref) => {
      const dotPlan = await importManifest(
        JSON.stringify({
          ...raw,
          items: [{ ...raw.items[0]!, external_ref: ref }],
        }),
      );
      expect(
        new URL(`https://broker.test/_pb/import-runs/${ID}/credentials/${encodeURIComponent(ref)}`)
          .pathname,
      ).not.toContain(`/credentials/${ref}`);
      const fetcher = vi.fn<typeof fetch>();
      const resolver = vi.fn(async () => SENTINEL);
      await expect(
        client(fetcher).credentials(
          ID,
          dotPlan.manifest,
          [{ ...binding, external_ref: ref }],
          resolver,
        ),
      ).rejects.toMatchObject({ code: 'invalid_external_ref', exitCode: 2 });
      expect(fetcher).not.toHaveBeenCalled();
      expect(resolver).not.toHaveBeenCalled();
    },
  );
  it('refuses the broker token reference even with an injected resolver', async () => {
    const tokenPlan = await importManifest(
      JSON.stringify({
        ...raw,
        items: [{ ...raw.items[0]!, credential_ref: 'env:PB_IMPORT_TOKEN' }],
      }),
    );
    const fetcher = vi.fn<typeof fetch>();
    const resolver = vi.fn(async () => SENTINEL);
    await expect(
      client(fetcher).credentials(
        ID,
        tokenPlan.manifest,
        [{ ...binding, credential_ref: 'env:PB_IMPORT_TOKEN' }],
        resolver,
      ),
    ).rejects.toMatchObject({ code: 'invalid_credential_ref', exitCode: 2 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });
  it('resolves only approved source references and encodes the ref as one segment', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'GET'
        ? json({ ...ready, ignored: SENTINEL })
        : new Response(null, { status: 204 }),
    );
    const resolver = vi.fn(async () => JSON.stringify({ token: SENTINEL }));
    expect(await client(fetcher).credentials(ID, plan.manifest, [binding], resolver)).toEqual({
      uploaded: 1,
      skipped: 0,
    });
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
    { patch: { approvedAt: null }, code: 'not_ready', exitCode: 3 },
    { patch: { state: 'planned' }, code: 'not_ready', exitCode: 3 },
    { patch: { state: 'applying' }, code: 'not_ready', exitCode: 3 },
    { patch: { state: 'cancelled' }, code: 'not_ready', exitCode: 3 },
    { patch: { planHash: '0'.repeat(64) }, code: 'plan_hash_mismatch', exitCode: 2 },
    { patch: { credentialWindowUntil: undefined }, code: 'incompatible_response', exitCode: 1 },
    { patch: { credentialWindowUntil: null }, code: 'credential_window_closed', exitCode: 1 },
    {
      patch: { credentialWindowUntil: '2026-10-24T12:00:00.000Z' },
      code: 'credential_window_closed',
      exitCode: 1,
    },
    {
      patch: { credentials: [{ sourceRef: 'other', bound: false }] },
      code: 'incompatible_response',
      exitCode: 1,
    },
  ])('checks readiness before resolving ($code, $patch)', async ({ patch, code, exitCode }) => {
    const resolver = vi.fn(async () => SENTINEL);
    const fetcher = vi.fn(async () => json({ ...ready, ...patch }));
    await expect(
      client(fetcher).credentials(ID, plan.manifest, [binding], resolver),
    ).rejects.toMatchObject({ code, exitCode });
    expect(resolver).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('explains a window that is not yet open and one that has closed', async () => {
    const message = async (patch: object) =>
      String(
        await client(vi.fn(async () => json({ ...ready, ...patch })))
          .credentials(ID, plan.manifest, [binding], async () => SENTINEL)
          .catch((e: unknown) => e),
      );
    expect(await message({ approvedAt: null, credentialWindowUntil: null })).toContain(
      'opens when the run is approved',
    );
    expect(await message({ credentialWindowUntil: null })).toContain(
      'window for this run is closed',
    );
  });
  it('skips sources the broker reports bound and succeeds without resolving when none remain', async () => {
    const fetcher = vi.fn(async () =>
      json({
        ...ready,
        credentialWindowUntil: null,
        credentials: [{ ...ready.credentials[0], bound: true }],
      }),
    );
    const resolver = vi.fn(async () => SENTINEL);
    expect(await client(fetcher).credentials(ID, plan.manifest, [], resolver)).toEqual({
      uploaded: 0,
      skipped: 1,
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires a binding only for unbound sources, checked before resolving', async () => {
    const resolver = vi.fn(async () => SENTINEL);
    const fetcher = vi.fn(async () => json(ready));
    await expect(
      client(fetcher).credentials(ID, plan.manifest, [], resolver),
    ).rejects.toMatchObject({ code: 'credential_binding_missing', exitCode: 2 });
    expect(resolver).not.toHaveBeenCalled();
  });
  it.each(
    [
      [{ ...binding, external_ref: 'non-source' }],
      [{ ...binding, credential_ref: 'env:OTHER' }],
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
    ).rejects.toMatchObject({ code: 'credential_window_closed' });
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
