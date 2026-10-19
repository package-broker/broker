import { afterEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { definePlugin, type RouteDefinition } from '../plugin.js';
import * as securityHeaders from './security-headers.js';
import { createKernel, type KernelOptions } from './kernel.js';
import { createUiRoutes, UI_CSP } from './ui-routes.js';

const HTTPS = 'https://public.test';
const HSTS = 'max-age=31536000; includeSubDomains';
const route = (path: string, extra: Partial<RouteDefinition> = {}): RouteDefinition => ({
  method: 'GET',
  path,
  permission: null,
  needsOrg: false,
  handler: () => Response.json({ ok: true }),
  ...extra,
});

async function app(extra: Partial<KernelOptions> = {}) {
  return createKernel({
    platform: 'node',
    plugins: [],
    publicOrigin: HTTPS,
    ports: {
      organizations: { get: () => Promise.resolve(null) },
      clock: fixedClock('2026-10-15T00:00:00.000Z'),
      ids: { ulid: () => '01JA0000000000000000000000' },
    },
    resolveOrg: () => Promise.resolve(orgContext('org-1')),
    health: () => Promise.resolve(true),
    log: () => undefined,
    coreRoutes: [
      route('/_pb/json'),
      route('/_pb/auth/providers'),
      route('/_pb/auth/local/login', { method: 'POST' }),
      route('/_pb/session'),
      route('/_pb/profile', { boundary: 'self' }),
      route('/_pb/error', {
        handler: () => {
          throw new Error('failure');
        },
      }),
      ...createUiRoutes(
        {
          manifest: () =>
            Promise.resolve({
              version: 1,
              entry: 'index.html',
              files: {
                'index.html': { contentType: 'text/html', bytes: 15 },
              },
            }),
          read: () =>
            Promise.resolve({
              body: new TextEncoder().encode('<!doctype html>'),
              contentType: 'text/html',
              bytes: 15,
            }),
        },
        { publicOrigin: HTTPS },
      ),
    ],
    ...extra,
  });
}

const surfaces = [
  ['JSON', '/_pb/json', 200],
  ['live health', '/health/live', 200],
  ['ready health', '/health/ready', 200],
  ['auth', '/_pb/auth/providers', 200],
  ['session', '/_pb/session', 200],
  ['self denial', '/_pb/profile', 401],
  ['404', '/missing', 404],
  ['error', '/_pb/error', 500],
  ['UI', '/_pb/ui', 200],
] as const;

describe('kernel security headers', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(surfaces)('finalises %s responses', async (_name, path, status) => {
    const finalise = vi.spyOn(securityHeaders, 'finaliseSecurityHeaders');
    const response = await (await app()).fetch(new Request(`http://internal.test${path}`));
    expect(finalise).toHaveBeenCalledTimes(1);
    if (path === '/_pb/profile') {
      expect(finalise).toHaveBeenCalledWith(expect.any(Response), true, true);
    }
    expect(response.status).toBe(status);
    expect(response.headers.get('strict-transport-security')).toBe(HSTS);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe(
      path === '/_pb/ui' ? 'same-origin' : 'no-referrer',
    );
  });

  it.each(['/_pb/auth/providers', '/_pb/session', '/_pb/profile', '/_pb/auth/missing'])(
    'prevents caching %s',
    async (path) => {
      const response = await (await app()).fetch(new Request(`${HTTPS}${path}`));
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it.each(['/_pb/%61uth/providers', '/_pb/%73ession'])(
    'prevents caching encoded auth/session path %s',
    async (path) => {
      const response = await (await app()).fetch(new Request(`${HTTPS}${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it.each([
    ['/_pb/%61uth/missing', 'GET'],
    ['/_pb/%73ession/missing', 'GET'],
    ['/_pb/%61uth/providers', 'PATCH'],
    ['/_pb/%73ession', 'PATCH'],
  ])('prevents caching encoded namespace fallback %s %s', async (path, method) => {
    const finalise = vi.spyOn(securityHeaders, 'finaliseSecurityHeaders');
    const response = await (await app()).fetch(new Request(`${HTTPS}${path}`, { method }));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(finalise).toHaveBeenCalledExactlyOnceWith(expect.any(Response), true, true);
  });

  it('prevents caching session-issuing POST responses', async () => {
    const response = await (
      await app()
    ).fetch(new Request(`${HTTPS}/_pb/auth/local/login`, { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('prevents caching auth handler errors', async () => {
    const kernel = await app({
      coreRoutes: [
        route('/_pb/auth/failure', {
          handler: () => {
            throw new Error('failure');
          },
        }),
      ],
    });
    const response = await kernel.fetch(new Request(`${HTTPS}/_pb/auth/failure`));
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('overrides cache-control on auth responses', async () => {
    const kernel = await app({
      coreRoutes: [
        route('/_pb/auth/providers', {
          handler: () => new Response(null, { headers: { 'cache-control': 'public, max-age=60' } }),
        }),
      ],
    });
    expect(
      (await kernel.fetch(new Request(`${HTTPS}/_pb/auth/providers`))).headers.get('cache-control'),
    ).toBe('no-store');
  });

  it('omits HSTS on an http configured origin despite an https request', async () => {
    const response = await (
      await app({ publicOrigin: 'http://public.test' })
    ).fetch(new Request(`${HTTPS}/_pb/json`));
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });

  it('omits HSTS without a configured origin', async () => {
    const response = await (
      await app({ publicOrigin: undefined })
    ).fetch(new Request(`${HTTPS}/_pb/json`));
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });

  it('removes route HSTS on an http configured origin', async () => {
    const response = await (
      await app({ publicOrigin: 'http://public.test' })
    ).fetch(new Request(`${HTTPS}/_pb/ui`));
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });

  it('leaves a public cacheable plugin response cacheable', async () => {
    const plugin = definePlugin({
      id: 'public',
      package: '@test/public',
      apiVersion: 3,
      platforms: ['node'],
      register: (registry) =>
        registry.route(
          route('/cacheable', {
            handler: () =>
              new Response('cached', { headers: { 'cache-control': 'public, max-age=60' } }),
          }),
        ),
    });
    const response = await (
      await app({ plugins: [plugin] })
    ).fetch(new Request(`${HTTPS}/cacheable`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('does not add no-store to public JSON', async () => {
    const response = await (await app()).fetch(new Request(`${HTTPS}/_pb/json`));
    expect(response.headers.has('cache-control')).toBe(false);
  });

  it('preserves route-provided baseline values', async () => {
    const kernel = await app({
      coreRoutes: [
        route('/_pb/custom', {
          handler: () =>
            new Response(null, {
              headers: { 'x-content-type-options': 'custom', 'referrer-policy': 'same-origin' },
            }),
        }),
      ],
    });
    const response = await kernel.fetch(new Request(`${HTTPS}/_pb/custom`));
    expect(response.headers.get('x-content-type-options')).toBe('custom');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('finalises plugin responses', async () => {
    const plugin = definePlugin({
      id: 'public',
      package: '@test/public',
      apiVersion: 3,
      platforms: ['node'],
      register: (registry) => registry.route(route('/plugin')),
    });
    const response = await (
      await app({ plugins: [plugin] })
    ).fetch(new Request('http://internal.test/plugin'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toBe(HSTS);
  });

  it('preserves UI CSP and cache policy', async () => {
    const response = await (await app()).fetch(new Request(`${HTTPS}/_pb/ui`));
    expect(response.headers.get('content-security-policy')).toBe(UI_CSP);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('preserves denial-page headers through the kernel', async () => {
    const kernel = await app({
      coreRoutes: [
        route('/_pb/protected', {
          permission: 'org:read',
          boundary: 'organization',
          needsOrg: true,
        }),
      ],
      authorization: {
        authorize: () => Promise.resolve({ allow: false, status: 403 }),
      },
    });
    const response = await kernel.fetch(
      new Request(`${HTTPS}/_pb/protected`, { headers: { accept: 'text/html' } }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('finalises failing readiness responses', async () => {
    const response = await (
      await app({ health: () => Promise.resolve(false) })
    ).fetch(new Request(`${HTTPS}/health/ready`));
    expect(response.status).toBe(503);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toBe(HSTS);
  });

  it('finalises routing failures when the request URL cannot be read', async () => {
    const real = new Request(`${HTTPS}/_pb/json`);
    const broken = new Proxy(real, {
      get(target, key) {
        if (key === 'url') throw new Error('unreadable URL');
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const response = await (await app()).fetch(broken);
    expect(response.status).toBe(500);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toBe(HSTS);
  });

  it('finalises HEAD responses without a body', async () => {
    const response = await (
      await app()
    ).fetch(new Request(`${HTTPS}/_pb/json`, { method: 'HEAD' }));
    expect(await response.text()).toBe('');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toBe(HSTS);
  });
});
