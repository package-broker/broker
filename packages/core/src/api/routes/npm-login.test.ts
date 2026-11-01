import { createKernel } from '../../kernel/kernel.js';
import { expect, it, vi } from 'vitest';
import type { RequestContext } from '../../plugin.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { npmLoginRoutes, type NpmLoginDeps } from './npm-login.js';
function fixture() {
  const deps: NpmLoginDeps = {
    ids: { ulid: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    clock: fixedClock('2026-10-31T00:00:00.000Z'),
    clientIp: () => '127.0.0.1',
    publicUrl: 'https://registry.example.test',
    store: {
      start: vi.fn(async () => true),
      confirmation: vi.fn(async () => null),
      poll: vi.fn(async () => ({ status: 'pending' as const })),
    },
    projects: { getBySlug: vi.fn(async () => ({ id: 'project', status: 'active' })) },
    sessions: { authenticate: vi.fn(async () => null), isReauthFresh: () => false },
    personal: () => {
      throw new Error('unused');
    },
  };
  const ctx = (path: string, body?: string) =>
    ({
      org: orgContext('org'),
      params: { project: 'demo', session: 'b'.repeat(43) },
      requestId: 'request',
      request: new Request(`https://registry.example.test${path}`, {
        ...(body === undefined ? {} : { method: 'POST', body }),
      }),
    }) as unknown as RequestContext;
  return { deps, ctx, routes: npmLoginRoutes(deps) };
}
it('starts with separate random secrets, stores only hashes and returns project-relative URLs with no-store', async () => {
  const { deps, ctx, routes } = fixture();
  const response = await routes[0]!.handler(ctx('/demo/npm/-/v1/login', '{}'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const value = (await response.json()) as { loginUrl: string; doneUrl: string };
  expect(value.loginUrl).toMatch(
    /^https:\/\/registry.example.test\/#\/npm-login\/[A-Za-z0-9_-]{43}$/,
  );
  expect(value.doneUrl).toMatch(
    /^https:\/\/registry.example.test\/demo\/npm\/-\/v1\/done\/[A-Za-z0-9_-]{43}$/,
  );
  const input = vi.mocked(deps.store.start).mock.calls[0]![1];
  expect(input.selectorHash).toMatch(/^[0-9a-f]{64}$/);
  expect(input.doneHash).not.toBe(input.selectorHash);
  expect(JSON.stringify(input)).not.toContain(value.loginUrl.split('/').at(-1)!);
});
it('refuses malformed input, cap overflow and unknown or archived projects without retaining input', async () => {
  const { deps, ctx, routes } = fixture();
  const route = routes[0]!;
  const invalid = await route.handler(ctx('/demo/npm/-/v1/login', '{"extra":true}'));
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({
    error: 'Invalid request',
    code: 'invalid_request',
    requestId: 'request',
  });
  expect(deps.store.start).not.toHaveBeenCalled();
  vi.mocked(deps.store.start).mockResolvedValue(false);
  const capped = await route.handler(ctx('/demo/npm/-/v1/login', '{}'));
  expect(capped.status).toBe(409);
  expect(await capped.json()).toEqual({
    error: 'There are too many pending login sessions',
    code: 'too_many_sessions',
    requestId: 'request',
  });
  vi.mocked(deps.projects.getBySlug).mockResolvedValue(null);
  const absent = await route.handler(ctx('/demo/npm/-/v1/login', '{}'));
  vi.mocked(deps.projects.getBySlug).mockResolvedValue({ id: 'project', status: 'archived' });
  const archived = await route.handler(ctx('/demo/npm/-/v1/login', '{}'));
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual(await archived.json());
});
it('returns JSON pending with retry-after and never caches poll outcomes', async () => {
  const { deps, ctx, routes } = fixture();
  const route = routes[1]!;
  const response = await route.handler(ctx('/demo/npm/-/v1/done/' + 'b'.repeat(43)));
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({});
  expect(response.headers.get('retry-after')).toBe('5');
  expect(response.headers.get('cache-control')).toBe('no-store');
  vi.mocked(deps.store.poll).mockResolvedValue({ status: 'not_found' });
  expect((await route.handler(ctx('/demo/npm/-/v1/done/' + 'b'.repeat(43)))).status).toBe(404);
});

it('matches the kernel unmatched npm route body on start and done refusals', async () => {
  const { deps, ctx, routes } = fixture();
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    ports: {
      organizations: { get: async () => null },
      clock: deps.clock,
      ids: deps.ids,
    },
    resolveOrg: async () => orgContext('org'),
    health: async () => true,
    log: () => undefined,
  });
  const path = '/demo/npm/-/v1/done/' + 'b'.repeat(43);
  const unmatched = await kernel.fetch(new Request('https://registry.example.test' + path));
  const expected = (await unmatched.json()) as { requestId: string };
  vi.mocked(deps.projects.getBySlug).mockResolvedValue(null);
  for (const [index, target, body] of [
    [0, '/demo/npm/-/v1/login', '{}'],
    [1, path, undefined],
  ] as const) {
    const context = ctx(target, body);
    const response = await routes[index]!.handler({ ...context, requestId: expected.requestId });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(expected);
  }
});

it('uses the nested envelope for malformed approval bodies', async () => {
  const { ctx, routes } = fixture();
  const route = routes.find((route) => route.method === 'POST' && route.path.startsWith('/_pb/'))!;
  for (const body of ['{', '{"extra":true}', '{"scope":"admin"}']) {
    const response = await route.handler(ctx('/_pb/me/npm-login/' + 'a'.repeat(43), body));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: { code: 'invalid_request', message: 'Invalid request', requestId: 'request' },
    });
  }
});

it('bounds anonymous start and poll independently before database work', async () => {
  const { deps, ctx, routes } = fixture();
  for (let i = 0; i < 10; i++) await routes[0]!.handler(ctx('/demo/npm/-/v1/login', '{}'));
  const blocked = await routes[0]!.handler(ctx('/demo/npm/-/v1/login', '{}'));
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('retry-after')).toBe('60');
  expect(blocked.headers.get('cache-control')).toBe('no-store');
  expect(deps.store.start).toHaveBeenCalledTimes(10);
  for (let i = 0; i < 60; i++) await routes[1]!.handler(ctx('/demo/npm/-/v1/done/secret'));
  expect((await routes[1]!.handler(ctx('/demo/npm/-/v1/done/secret'))).status).toBe(429);
  expect(deps.store.poll).toHaveBeenCalledTimes(60);
});

it('uses admission IP separately from the legacy audit IP', async () => {
  const { deps, ctx } = fixture();
  let socket = '192.0.2.1';
  const routes = npmLoginRoutes({ ...deps, admissionIp: () => socket });
  for (let n = 0; n < 10; n++)
    expect((await routes[0]!.handler(ctx('/demo/npm/-/v1/login', '{}'))).status).toBe(200);
  expect((await routes[0]!.handler(ctx('/demo/npm/-/v1/login', '{}'))).status).toBe(429);
  socket = '192.0.2.2';
  expect((await routes[0]!.handler(ctx('/demo/npm/-/v1/login', '{}'))).status).toBe(200);
  expect(
    vi.mocked(deps.store.start).mock.calls.every(([, input]) => input.sourceIp === '127.0.0.1'),
  ).toBe(true);
});

it('allows an unknown-IP CLI to poll for a minute at the route Retry-After cadence', async () => {
  const { deps, ctx } = fixture();
  const routes = npmLoginRoutes({ ...deps, admissionIp: () => null });
  const poll = () => routes[1]!.handler(ctx('/demo/npm/-/v1/done/' + 'b'.repeat(43)));
  const first = await poll();
  expect(first.status).toBe(202);
  const retryAfter = Number(first.headers.get('retry-after'));
  expect(retryAfter).toBeGreaterThan(0);
  for (let n = 1; n < Math.ceil(60 / retryAfter); n++) expect((await poll()).status).toBe(202);
});
