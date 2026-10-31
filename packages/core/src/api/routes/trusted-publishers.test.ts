import { expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import { createAuthorizationEngine, patValidationGate } from '../../authz/engine.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { trustedPublisherRoutes } from './trusted-publishers.js';
import type { TrustedPublisher, TrustedPublisherStore } from './trusted-publishers-store.js';
const ORIGIN = 'https://broker.test';
const ID = '01JA0000000000000000000001';
const USER = '01JA0000000000000000000003';
const SECRET = 'A'.repeat(43),
  CSRF = 'B'.repeat(43);
const now = '2026-10-30T00:00:00.000Z';
const body = {
  packageName: 'widget',
  repository: 'owner/repo',
  workflow: 'publish.yml',
  environment: 'Prod',
};
const row: TrustedPublisher = {
  ...body,
  id: ID,
  repositoryId: '123',
  repositoryOwnerId: '456',
  refPattern: null,
  servicePrincipalId: ID,
  servicePrincipalName: 'trusted:owner/repo:publish.yml',
  createdByUserId: USER,
  createdByName: 'User',
  createdAt: now,
  disabledAt: null,
  lastUsedAt: null,
  revision: 1,
};
async function fixture(
  permissions = ['org:service-principals:write', 'org:packages:publish'],
  platform: 'node' | 'cloudflare' = 'node',
) {
  const store = {
    list: vi.fn<TrustedPublisherStore['list']>().mockResolvedValue({ items: [row] }),
    get: vi.fn<TrustedPublisherStore['get']>().mockResolvedValue(row),
    create: vi.fn<TrustedPublisherStore['create']>().mockResolvedValue(row),
    update: vi.fn<TrustedPublisherStore['update']>().mockResolvedValue({ ...row, revision: 2 }),
    disable: vi.fn<TrustedPublisherStore['disable']>().mockResolvedValue(undefined),
  };
  const lookup = vi
    .fn()
    .mockResolvedValue({ repositoryId: '123', repositoryOwnerId: '456', repository: 'owner/repo' });
  const clock = fixedClock(now),
    ids = { ulid: () => ID },
    log = vi.fn();
  const routes = trustedPublisherRoutes({ store, lookup, clock, ids, clientIp: () => null });
  const kernel = await createKernel({
    platform,
    plugins: [],
    coreRoutes: routes,
    packageResolver: { resolve: async () => ({ kind: 'absent' as const }) },
    ports: { organizations: { get: async () => null }, clock, ids },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: USER },
          identity: null,
          protectedHolder: false,
          project: input.projectSlug === 'demo' ? { id: ID } : null,
          organizationPermissions: permissions.filter((p) => p.startsWith('org:')),
          projectPermissions: permissions.filter((p) => p.startsWith('project:')),
        }),
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
        nowMs: () => clock.now().getTime(),
        dispatch: () => undefined,
        log,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (path: string, method = 'GET', body?: unknown, etag?: string) =>
    kernel.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          origin: ORIGIN,
          cookie: `${SESSION_COOKIE}=${SECRET}`,
          'x-csrf-token': CSRF,
          'content-type': 'application/json',
          ...(etag === undefined ? {} : { 'if-match': etag }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { request, store, lookup, routes, log };
}

it.each(['node', 'cloudflare'] as const)(
  'lists, creates, updates and disables on %s with identical response contracts',
  async (platform) => {
    const f = await fixture(undefined, platform);
    const list = await f.request('/_pb/trusted-publishers');
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect((await f.request('/_pb/trusted-publishers', 'POST', body)).status).toBe(201);
    expect(f.store.create).toHaveBeenCalledWith(
      orgContext('org-1'),
      expect.anything(),
      expect.objectContaining({ input: { ...body, environment: 'prod' } }),
    );
    expect((await f.request(`/_pb/trusted-publishers/${ID}`, 'PUT', body, '"r1"')).status).toBe(
      200,
    );
    expect(
      (await f.request(`/_pb/trusted-publishers/${ID}`, 'DELETE', undefined, '"r1"')).status,
    ).toBe(204);
    expect(f.store.disable).toHaveBeenCalledWith(
      orgContext('org-1'),
      expect.anything(),
      expect.objectContaining({ expectedRevision: 1 }),
    );
  },
);
it.each([['org:packages:publish'], ['org:service-principals:write'], []])(
  'requires both write permissions: %j',
  async (...values) => {
    const f = await fixture(values as string[]);
    expect((await f.request('/_pb/trusted-publishers', 'POST', body)).status).toBe(403);
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.store.create).not.toHaveBeenCalled();
  },
);
it('requires If-Match before updating or disabling', async () => {
  const f = await fixture();
  expect((await f.request(`/_pb/trusted-publishers/${ID}`, 'PUT', body)).status).toBe(428);
  expect((await f.request(`/_pb/trusted-publishers/${ID}`, 'DELETE')).status).toBe(428);
  expect(f.store.update).not.toHaveBeenCalled();
  expect(f.store.disable).not.toHaveBeenCalled();
});
it('refuses missing GitHub credentials and invalid workflow filenames before creating', async () => {
  const f = await fixture();
  expect(
    (await f.request('/_pb/trusted-publishers', 'POST', { ...body, workflow: 'bad@name.yml' }))
      .status,
  ).toBe(400);
  expect(f.lookup).not.toHaveBeenCalled();
  f.lookup.mockResolvedValue(null);
  const response = await f.request('/_pb/trusted-publishers', 'POST', body);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'github_credentials_required' } });
  expect(f.store.create).not.toHaveBeenCalled();
});

it('records the full repository and long workflow in the audit', async () => {
  const f = await fixture();
  const workflow = 'p'.repeat(240) + '.yml';
  expect((await f.request('/_pb/trusted-publishers', 'POST', { ...body, workflow })).status).toBe(
    201,
  );
  const call = f.store.create.mock.calls[0]!;
  expect(JSON.parse(call[2].event.payloadJson)).toMatchObject({
    changes: { repository: { new: body.repository }, workflow: { new: workflow } },
  });
});

it.each(['node', 'cloudflare'] as const)(
  'validates unnameable bindings before lookup on %s',
  async (platform) => {
    const f = await fixture(undefined, platform);
    for (const environment of ['person@example.test', 'prod\u200b']) {
      for (const method of ['POST', 'PUT']) {
        const response = await f.request(
          method === 'POST' ? '/_pb/trusted-publishers' : `/_pb/trusted-publishers/${ID}`,
          method,
          { ...body, environment },
          method === 'PUT' ? '"r1"' : undefined,
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: 'invalid_request', message: 'Invalid request' },
        });
      }
    }
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.store.create).not.toHaveBeenCalled();
    expect(f.store.update).not.toHaveBeenCalled();
    const logs = JSON.stringify(f.log.mock.calls);
    expect(logs).not.toContain('person@example.test');
    expect(logs).not.toContain('prod\u200b');
    expect(logs).not.toContain('http.handler_error');
  },
);
