import { describe, expect, it, vi } from 'vitest';
import { createPolicyFetch } from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { UpstreamError, type PolicyFetch } from '@package-broker/core/plugin';
import { AppApiError, createAppApi } from './app-api.js';
const pair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  },
  true,
  ['sign', 'verify'],
);
const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
let binary = '';
for (const byte of der) binary += String.fromCharCode(byte);
const PEM = `-----BEGIN PRIVATE KEY-----\n${(btoa(binary).match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;

const API = 'https://api.github.com';
const app = { appId: '123', privateKeyPem: PEM };
const SECRET = 'fake-webhook-secret-012345';
const CLIENT_SECRET = 'fake-client-secret-012345';
const CODE = 'manifest-code-012345';
const HOOK_KEY = 'connection-hook-key-012345';
const conversion = {
  id: 123,
  slug: 'broker',
  owner: { id: 42, type: 'Organization', login: 'acme', email: 'owner@example.test' },
  pem: PEM,
  webhook_secret: SECRET,
  client_secret: CLIENT_SECRET,
};
const installation = {
  id: 10,
  app_id: 123,
  target_type: 'Organization',
  account: { id: 42, login: 'acme', email: 'owner@example.test' },
  repository_selection: 'all',
  suspended_at: null,
  permissions: { contents: 'read', metadata: 'read' },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup(reply: () => Response = () => json(conversion)) {
  const calls: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const logs: unknown[] = [];
  const requests: Parameters<PolicyFetch>[0][] = [];
  const fetch = createPolicyFetch({
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      return reply();
    },
    policy: createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
    userAgent: 'test',
    observability: {
      log: (event) => {
        logs.push(event);
      },
      counter: (...args) => {
        logs.push(args);
      },
      histogram: (...args) => {
        logs.push(args);
      },
    },
  });
  const client = createAppApi({
    fetch: (request) => {
      requests.push(request);
      return fetch(request);
    },
  });
  return { client, calls, logs, requests };
}
function assertRedacted(value: unknown) {
  const text = [inspect(value), JSON.stringify(value), String(value)].join('\n');
  for (const secret of [PEM, SECRET, CLIENT_SECRET, CODE, HOOK_KEY, 'owner@example.test'])
    expect(text).not.toContain(secret);
}

describe('GitHub App API', () => {
  it('rejects an App identity that differs from the supplied App id', async () => {
    const { client, calls } = setup(() => json({ ...conversion, id: 456 }));
    await expect(client.getApp(app)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(calls).toHaveLength(1);
  });

  it.each(['', 'http://broker.example/hook', 'https://', 'relative/hook'])(
    'refuses invalid expected hook URL %j before fetching',
    async (expectedUrl) => {
      const { client, calls } = setup();
      await expect(client.getHookConfig(app, expectedUrl)).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(calls).toHaveLength(0);
    },
  );

  it('converts PKCS#1 RSA private key material', async () => {
    // A 2048-bit RSA PKCS#8 wrapper has a 26-byte header before the PKCS#1 sequence.
    const pkcs1 = btoa(String.fromCharCode(...der.slice(26)));
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${(pkcs1.match(/.{1,64}/g) ?? []).join('\n')}\n-----END RSA PRIVATE KEY-----\n`;
    const { client } = setup(() => json({ ...conversion, pem }));
    const result = await client.convertManifest(CODE, 'acme');
    expect(result.material.privateKeyPem).toBe(pem);
    const verified = setup();
    await expect(verified.client.getApp(result.material)).resolves.toMatchObject({ id: '123' });
    expect(JSON.stringify(result)).not.toContain(pem);
  });

  it.each([
    ['timeout', 'timeout'],
    ['refused', 'unavailable'],
  ] as const)('maps PolicyFetch %s to %s', async (upstreamCode, code) => {
    const client = createAppApi({
      fetch: async () => {
        throw new UpstreamError(upstreamCode);
      },
    });
    const error = await client.updateHookConfig(app, SECRET).catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    assertRedacted(error);
  });

  it('reports a network failure after sending PATCH as possibly applied', async () => {
    const { client, calls, logs } = setup(() => {
      throw new Error(`${SECRET} ${HOOK_KEY}`);
    });
    const error = await client.updateHookConfig(app, SECRET).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'timeout' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PATCH');
    assertRedacted([error, logs]);
  });

  it.each(['timeout', 'network'] as const)('maps streaming %s to timeout', async (code) => {
    const client = createAppApi({
      fetch: async () => ({
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.error(new UpstreamError(code));
          },
        }),
      }),
    });
    await expect(client.updateHookConfig(app, SECRET)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('returns installation continuation from the pinned Link header', async () => {
    const { client, calls } = setup(
      () =>
        new Response(JSON.stringify([installation]), {
          headers: { link: `<${API}/app/installations?per_page=100&page=3>; rel="next"` },
        }),
    );
    expect(await client.listInstallations(app, 2)).toMatchObject({
      hasNext: true,
      installations: [{ id: '10', targetType: 'Organization' }],
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    'https://evil.example/app/installations?page=2',
    `${API}/app?page=2`,
    `${API}/app/installations`,
    `${API}/app/installations?page=invalid`,
    `${API}/app/installations?page=1`,
  ])('rejects untrusted installation pagination link %s', async (next) => {
    const { client, calls } = setup(
      () => new Response('[]', { headers: { link: `<${next}>; rel="next"` } }),
    );
    await expect(client.listInstallations(app)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(calls).toHaveLength(1);
  });

  it('rejects installations belonging to another App in list responses', async () => {
    const { client } = setup(() => json([{ ...installation, app_id: 456 }]));
    await expect(client.listInstallations(app)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('converts a manifest without authorization, discards the OAuth secret and redacts key material', async () => {
    const { client, calls, requests, logs } = setup();
    const result = await client.convertManifest(CODE, 'ACME');
    expect(result.id).toBe('123');
    expect(result.owner).toEqual({ id: '42', login: 'acme' });
    expect(result.material.privateKeyPem).toBe(PEM);
    expect(result.material.webhookSecret).toBe(SECRET);
    expect(result.webhookSecretMissing).toBe(false);
    expect(calls[0]?.url).toBe(`${API}/app-manifests/${CODE}/conversions`);
    expect(calls[0]?.headers.has('authorization')).toBe(false);
    expect(calls[0]?.method).toBe('POST');
    expect(requests[0]).toMatchObject({
      destinations: [API],
      redirects: 'error',
      maxBytes: 65536,
      timeoutMs: 15000,
    });
    expect(Object.getOwnPropertyNames(result)).not.toContain('client_secret');
    assertRedacted(result);
    assertRedacted({ ...result });
    assertRedacted(result.material);
    assertRedacted(logs);
  });

  it('preserves a missing webhook secret explicitly for the repair/bootstrap caller', async () => {
    const { client } = setup(() => json({ ...conversion, webhook_secret: null }));
    const result = await client.convertManifest(CODE, 'acme');
    expect(result.webhookSecretMissing).toBe(true);
    expect(result.material.webhookSecret).toBeNull();
    expect(result.material.privateKeyPem).toBe(PEM);
    assertRedacted(result);
  });

  it.each(['../bad', 'a?state=secret', 'a/b', '', 'a'.repeat(129), 'a\n'])(
    'rejects invalid code %j before sending a request',
    async (code) => {
      const { client, calls } = setup();
      await expect(client.convertManifest(code, 'acme')).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    { id: 'not-an-id' },
    { slug: '../secret' },
    { owner: { id: 42, type: 'Organization', login: 'other' } },
    { owner: { id: 42, type: 'User', login: 'acme' } },
    { owner: { id: 42, login: 'acme' } },
    { pem: 'secret-not-a-pem' },
    { webhook_secret: '' },
    { webhook_secret: undefined },
  ])(
    'rejects malformed or mismatched conversion data without echoing it (%j)',
    async (override) => {
      const { client, logs } = setup(() => json({ ...conversion, ...override }));
      const error = await client.convertManifest(CODE, 'acme').catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AppApiError);
      expect(error).toMatchObject({ code: 'invalid_response' });
      assertRedacted([error, logs]);
    },
  );

  it.each([401, 403, 404, 422, 429, 500])(
    'keeps the status %i and discards error bodies',
    async (status) => {
      const { client, logs } = setup(() => json(conversion, status));
      const error = await client.convertManifest(CODE, 'acme').catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'upstream_status', status });
      assertRedacted([error, logs]);
    },
  );

  it('verifies the App with an origin-bound JWT and projects only identity fields', async () => {
    const { client, calls, logs } = setup();
    expect(await client.getApp(app)).toEqual({
      id: '123',
      slug: 'broker',
      owner: { id: '42', login: 'acme' },
    });
    expect(calls[0]?.url).toBe(`${API}/app`);
    const authorization = calls[0]?.headers.get('authorization');
    expect(authorization).toMatch(/^Bearer ey/);
    expect(JSON.stringify(logs)).not.toContain(authorization);
    assertRedacted(logs);
  });

  it('checks a supplied App key using only the App and hook config reads', async () => {
    let replies = 0;
    const url = `https://broker.example/_pb/hooks/github/${HOOK_KEY}`;
    const { client, calls, logs, requests } = setup(() =>
      json(replies++ === 0 ? { ...conversion, id: 456 } : { url, secret: SECRET }),
    );
    const supplied = { ...app, appId: '456' };
    await client.getApp(supplied);
    const config = await client.getHookConfig(supplied, url);
    expect(config).toEqual({ configured: true, matchesExpectedUrl: true });
    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: `${API}/app`, method: 'GET' },
      { url: `${API}/app/hook/config`, method: 'GET' },
    ]);
    for (const call of calls) {
      const jwt = call.headers.get('authorization')!.slice('Bearer '.length);
      const [header, payload, signature] = jwt.split('.') as [string, string, string];
      const decode = (text: string) =>
        Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      expect(JSON.parse(new TextDecoder().decode(decode(payload)))).toMatchObject({ iss: '456' });
      expect(
        await crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          pair.publicKey,
          decode(signature),
          new TextEncoder().encode(`${header}.${payload}`),
        ),
      ).toBe(true);
      expect(JSON.stringify(logs)).not.toContain(jwt);
    }
    for (const request of requests) {
      expect(request).toMatchObject({
        destinations: [API],
        redirects: 'error',
        maxBytes: 65536,
        timeoutMs: 15000,
      });
    }
    assertRedacted([config, logs]);
  });

  it.each(['https://other.example/', `https://broker.example/_pb/hooks/github/other-key`, ''])(
    'rejects a hook URL mismatch without exposing the configured URL (%s)',
    async (url) => {
      const { client, logs } = setup(() => json({ url }));
      const config = await client.getHookConfig(
        app,
        `https://broker.example/_pb/hooks/github/${HOOK_KEY}`,
      );
      expect(config.matchesExpectedUrl).toBe(false);
      assertRedacted([config, logs]);
    },
  );

  it.each([302, 307, 308, 401, 403, 422, 500])(
    'keeps PATCH failure %i free of secrets',
    async (status) => {
      const { client, calls, logs } = setup(
        () =>
          new Response(JSON.stringify(conversion), {
            status,
            headers: { location: `https://evil.example/${HOOK_KEY}` },
          }),
      );
      const error = await client.updateHookConfig(app, SECRET).catch((error: unknown) => error);
      expect(error).toMatchObject(
        status < 400 ? { code: 'timeout' } : { code: 'upstream_status', status },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe('PATCH');
      const authorization = calls[0]?.headers.get('authorization');
      expect(JSON.stringify(logs)).not.toContain(authorization);
      assertRedacted([error, logs]);
    },
  );

  it('lists installations in numbered pages and preserves suspension and permission state', async () => {
    const { client, calls, requests } = setup(() =>
      json([
        {
          ...installation,
          suspended_at: '2026-10-28T00:00:00Z',
          permissions: { metadata: 'read' },
        },
      ]),
    );
    expect(await client.listInstallations(app, 2)).toEqual({
      installations: [
        {
          id: '10',
          account: { id: '42', login: 'acme' },
          targetType: 'Organization',
          repositorySelection: 'all',
          suspendedAt: '2026-10-28T00:00:00Z',
          permissions: { metadata: 'read' },
        },
      ],
      hasNext: false,
    });
    expect(calls[0]?.url).toBe(`${API}/app/installations?per_page=100&page=2`);
    expect(requests[0]?.maxBytes).toBe(8 * 1024 * 1024);
  });

  it('looks up an installation using only a validated numeric id', async () => {
    const { client, calls } = setup(() => json(installation));
    expect(await client.getInstallation(app, '10')).toMatchObject({ id: '10', suspendedAt: null });
    expect(calls[0]?.url).toBe(`${API}/app/installations/10`);
    await expect(client.getInstallation(app, '../10')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(calls).toHaveLength(1);
  });

  it('reads and patches hook config without exposing its hook key or secret', async () => {
    const { client, calls, logs, requests } = setup(() =>
      json({ url: `https://broker.example/_pb/hooks/github/${HOOK_KEY}`, secret: SECRET }),
    );
    expect(await client.getHookConfig(app)).toEqual({ configured: true });
    expect(await client.updateHookConfig(app, SECRET)).toEqual({ configured: true });
    expect(calls[1]?.method).toBe('PATCH');
    expect(JSON.parse(new TextDecoder().decode(calls[1]?.body as Uint8Array))).toEqual({
      secret: SECRET,
    });
    expect(requests[1]).toMatchObject({
      maxBytes: 65536,
      timeoutMs: 15000,
      redirects: 'error',
      destinations: [API],
    });
    assertRedacted(logs);
  });

  it('lists delivery health with local cursor paths and drops payload fields', async () => {
    const { client, calls, logs } = setup(
      () =>
        new Response(
          JSON.stringify([
            {
              id: 9,
              guid: 'delivery-guid',
              event: 'push',
              redelivery: true,
              status: 'OK',
              delivered_at: '2026-10-28T00:00:00Z',
              status_code: 200,
              request: conversion,
            },
          ]),
          {
            headers: { link: `<${API}/app/hook/deliveries?cursor=next_123>; rel="next"` },
          },
        ),
    );
    const result = await client.listHookDeliveries(app, 'current_123');
    expect(result).toEqual({
      deliveries: [
        {
          id: '9',
          guid: 'delivery-guid',
          event: 'push',
          redelivery: true,
          status: 'OK',
          deliveredAt: '2026-10-28T00:00:00Z',
          statusCode: 200,
        },
      ],
      nextCursor: 'next_123',
    });
    expect(calls[0]?.url).toBe(`${API}/app/hook/deliveries?per_page=100&cursor=current_123`);
    assertRedacted([result, logs]);
  });

  it.each([
    ...['', 'a'.repeat(65), 'bad_guid', 'guid\n', 'é', null].map((guid) => ({ guid })),
    ...['', 'a'.repeat(65), 'Push', 'push-event', 'push\n', 'é', null].map((event) => ({ event })),
    ...['', 'a'.repeat(65), 'OK\n', 'OK\t', '\x1f', '\x7f', 'é', null].map((status) => ({
      status,
    })),
  ])('rejects invalid delivery strings (%j)', async (override) => {
    const { client, logs } = setup(() =>
      json([
        {
          id: 9,
          guid: 'delivery-guid',
          event: 'push',
          redelivery: false,
          status: 'OK',
          delivered_at: '2026-10-28T00:00:00Z',
          status_code: 200,
          ...override,
        },
      ]),
    );
    const error = await client.listHookDeliveries(app).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'invalid_response' });
    assertRedacted([error, logs]);
  });

  it.each([1, 64])('accepts valid delivery strings of length %i', async (length) => {
    const guid = 'Az09-'.repeat(13).slice(0, length);
    const event = 'az_.'.repeat(16).slice(0, length);
    const status = ' ~'.repeat(32).slice(0, length);
    const { client } = setup(() =>
      json([
        {
          id: 9,
          guid,
          event,
          status,
          redelivery: false,
          delivered_at: '2026-10-28T00:00:00Z',
          status_code: 200,
        },
      ]),
    );
    await expect(client.listHookDeliveries(app)).resolves.toMatchObject({
      deliveries: [{ guid, event, status }],
    });
  });

  it('rejects redirects before any credentials or code reach a second host', async () => {
    const { client, calls, logs } = setup(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/leak' } }),
    );
    await expect(client.convertManifest(CODE, 'acme')).rejects.toMatchObject({
      code: 'timeout',
    });
    await expect(client.getApp(app)).rejects.toMatchObject({ code: 'timeout' });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url.startsWith(API))).toBe(true);
    assertRedacted(logs);
  });

  it.each([() => new Response('{secret malformed'), () => new Response('x'.repeat(65537))])(
    'rejects invalid and oversized bodies without leaking content',
    async (reply) => {
      const { client, logs } = setup(reply);
      await expect(client.convertManifest(CODE, 'acme')).rejects.toMatchObject({
        code: 'invalid_response',
      });
      assertRedacted(logs);
    },
  );

  it('replaces transport and signing exceptions with fixed errors and never logs to console', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const client = createAppApi({
        fetch: async () => {
          throw new Error(`${PEM} ${CODE} ${SECRET}`);
        },
      });
      const error = await client.convertManifest(CODE, 'acme').catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'unavailable' });
      assertRedacted(error);
      await expect(
        client.getApp({ ...app, privateKeyPem: 'invalid secret' }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
      consoleError.mockRestore();
    }
  });
});

describe('GitHub App API response and input boundaries', () => {
  it.each([
    null,
    { ...installation, id: 9007199254740992 },
    { ...installation, app_id: 456 },
    { ...installation, app_id: undefined },
    { ...installation, target_type: 'unknown' },
    { ...installation, repository_selection: 'unknown' },
    { ...installation, permissions: null },
    { ...installation, permissions: { contents: SECRET } },
    { ...installation, suspended_at: 'not-a-date' },
    { ...installation, account: { id: 42, login: 'owner@example.test' } },
  ])('rejects malformed installation response %#', async (value) => {
    const { client, logs } = setup(() => json(value));
    const error = await client.getInstallation(app, '10').catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'invalid_response' });
    assertRedacted([error, logs]);
  });

  it.each([0, -1, 1.5, Number.NaN, 1_000_001])(
    'refuses invalid page %s without fetching',
    async (page) => {
      const { client, calls } = setup();
      await expect(client.listInstallations(app, page)).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses callback URLs, forged installation paths, cursor paths and invalid hook secrets before fetching', async () => {
    const { client, calls, logs } = setup();
    const error = await client
      .convertManifest(`https://broker.example/callback?code=${CODE}&state=private-state`, 'acme')
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'invalid_request' });
    assertRedacted(error);
    expect(inspect(error)).not.toContain('private-state');
    await expect(client.getInstallation(app, '10?code=secret')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(client.listHookDeliveries(app, '../secret')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(client.updateHookConfig(app, '')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(client.updateHookConfig(app, 'secret\r\nheader')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(calls).toHaveLength(0);
    assertRedacted(logs);
  });

  it.each([
    'https://evil.example/app/hook/deliveries?cursor=next',
    `${API}/app?cursor=next`,
    `${API}/app/hook/deliveries?cursor=..%2Fsecret`,
  ])('refuses untrusted delivery pagination links %# without following them', async (next) => {
    const { client, calls } = setup(
      () => new Response('[]', { headers: { link: `<${next}>; rel="next"` } }),
    );
    await expect(client.listHookDeliveries(app)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(calls).toHaveLength(1);
  });

  it('accepts empty pages and rejects unbounded page item counts', async () => {
    const empty = setup(() => json([]));
    expect(await empty.client.listInstallations(app)).toEqual({
      installations: [],
      hasNext: false,
    });
    expect(await empty.client.listHookDeliveries(app)).toEqual({
      deliveries: [],
      nextCursor: null,
    });
    const large = setup(() => json(Array.from({ length: 101 }, () => installation)));
    await expect(large.client.listInstallations(app)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('applies the 8 MiB listing cap while streaming', async () => {
    const { client, requests, logs } = setup(() => new Response(' '.repeat(8 * 1024 * 1024 + 1)));
    await expect(client.listInstallations(app)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(requests[0]).toMatchObject({
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 15000,
      redirects: 'error',
      destinations: [API],
    });
    assertRedacted(logs);
  });

  it('drops hook secrets and delivery payloads even on failed calls', async () => {
    const { client, calls, logs } = setup(() => json(conversion, 500));
    const configError = await client.updateHookConfig(app, SECRET).catch((error: unknown) => error);
    const deliveryError = await client.listHookDeliveries(app).catch((error: unknown) => error);
    expect(configError).toMatchObject({ code: 'upstream_status', status: 500 });
    expect(deliveryError).toMatchObject({ code: 'upstream_status', status: 500 });
    assertRedacted([configError, deliveryError, logs]);
    for (const call of calls)
      expect(JSON.stringify(logs)).not.toContain(call.headers.get('authorization'));
  });
});

function inspect(value: unknown): string {
  const custom = (value as { [key: symbol]: unknown } | null)?.[
    Symbol.for('nodejs.util.inspect.custom')
  ];
  if (typeof custom === 'function') return String(custom.call(value));
  if (value instanceof Error) {
    return Object.getOwnPropertyNames(value)
      .map((key) => String((value as unknown as Record<string, unknown>)[key]))
      .join('\n');
  }
  return `${String(value)} ${JSON.stringify(value) ?? ''}`;
}
