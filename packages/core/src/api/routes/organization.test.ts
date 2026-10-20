import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '../../authz/engine.js';
import { createAdministration, type Administration } from '../../authz/administration.js';
import type { GrantRepository } from '../../db/grants.js';
import type { RoleRepository } from '../../db/roles.js';
import { PERMISSIONS } from '../../authz/permissions.js';
import { resolveTokenLifetimePolicy } from '../../authz/token-lifetime.js';
import type { Organization } from '../../db/organization.js';
import { orgContext, type OrgContext } from '../../db/port.js';
import type { User } from '../../db/users.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { defineApi } from '../route.js';
import { ORGANIZATION_API_SPECS } from './organization-schemas.js';
import { organizationRoutes } from './organization.js';

const ORIGIN = 'https://broker.test';
const SESSION_SECRET = 'A'.repeat(43);
const SESSION_ID = 'session-sentinel';
const CSRF = 'B'.repeat(43);
const SELECTOR = 'abcdefghijkl';
const USER_ID = '01JA0000000000000000000009';
const TARGET = '01JA0000000000000000000001';
const UNKNOWN = '01JA0000000000000000000002';
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const patToken = formatToken('pat', SELECTOR, new Uint8Array(32).fill(9));
const svcToken = formatToken('svc', SELECTOR, new Uint8Array(32).fill(9));
const clock = fixedClock('2026-10-19T00:00:00.000Z');
const NO_STORE = 'no-store';

const organization: Organization = {
  id: 'org-1' as Organization['id'],
  slug: 'acme',
  name: 'Acme',
  settings: {
    retentionRemovedUpstreamDays: 30,
    tokenDefaultExpiryDays: 90,
    tokenCiReadonlyExpiryDays: 7,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
};

function user(index: number, overrides: Partial<User> = {}): User {
  return {
    id: `01JA${String(index).padStart(22, '0')}`,
    email: `person${String(index)}@example.test`,
    displayName: `Person ${String(index)}`,
    status: 'active',
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Options {
  credential?: 'session' | 'pat' | 'svc' | 'none' | 'unknown';
  revoked?: boolean;
  expired?: boolean;
  administration?: Pick<Administration, 'suspendUser' | 'reactivateUser'>;
  tokenScope?: 'read' | 'full';
  permissions?: readonly string[];
  users?: readonly User[];
  me?: User | null;
  organization?: Organization | null;
}

async function fixture(options: Options = {}) {
  const all = options.users ?? [];
  const permissions = options.permissions ?? PERMISSIONS.map((p) => p.name);
  const credential = options.credential ?? 'session';
  const suspendUser = vi.fn<Administration['suspendUser']>(async () => ({
    ok: true,
    value: null,
  }));
  const reactivateUser = vi.fn<Administration['reactivateUser']>(async () => ({
    ok: true,
    value: null,
  }));
  const list = vi.fn(async (_org: unknown, page: { afterId: string | null; limit: number }) =>
    all
      .filter((u) => page.afterId === null || u.id > page.afterId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, page.limit),
  );
  const get = vi.fn(async () => (options.me === undefined ? user(9, { id: USER_ID }) : options.me));
  const getOrganization = vi.fn(async () =>
    options.organization === undefined ? organization : options.organization,
  );
  const clientIp = vi.fn(() => '203.0.113.7');
  const ids = { ulid: vi.fn(() => '01JAOPID00000000000000000A') };
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: organizationRoutes({
      organizations: { get: getOrganization },
      users: { list, get },
      administration: options.administration ?? { suspendUser, reactivateUser },
      lifetime: resolveTokenLifetimePolicy({ maxLifetimeDays: { personal: 120, service: 400 } }),
      clock,
      ids,
      clientIp,
    }),
    ports: { organizations: { get: async () => null }, clock, ids },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log: () => undefined,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async () => ({
          session: { id: SESSION_ID, csrfHash: await sha256Hex(CSRF) },
          user: { id: USER_ID },
          identity: null,
          protectedHolder: true,
          project: null,
          organizationPermissions: permissions,
          projectPermissions: [],
        }),
        lookupToken: async () => {
          const service = credential === 'svc';
          return Object.defineProperty(
            {
              token: {
                id: 'token-1',
                kind: service ? 'svc' : 'pat',
                expired: options.expired ?? false,
                revoked: options.revoked ?? false,
                lastUsedAt: null,
                userId: service ? null : USER_ID,
                servicePrincipalId: service ? '01JA0000000000000000000007' : null,
                bindingOk: true,
                projectMode: 'all',
                scope: {
                  level: options.tokenScope ?? 'full',
                  readOnly: options.tokenScope === 'read',
                },
              },
              principalStatus: 'active',
              projectVisible: true,
              validation: service
                ? null
                : { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
              project: null,
              organizationPermissions: permissions,
              projectPermissions: [],
            },
            'verifier',
            {
              value: {
                secretHash: await hashToken(keyring, 1, service ? svcToken : patToken),
                pepperVersion: 1,
              },
            },
          ) as unknown as EngineTokenAccess;
        },
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring,
        nowMs: () => clock.now().getTime(),
        dispatch: (run) => {
          void run();
        },
        log: () => undefined,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (
    method: string,
    path: string,
    body?: unknown,
    auth = credential,
    csrf = true,
  ) => {
    const headers = new Headers({ origin: ORIGIN });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (auth === 'session') {
      headers.set('cookie', `${SESSION_COOKIE}=${SESSION_SECRET}`);
      if (method !== 'GET' && csrf) headers.set('x-csrf-token', CSRF);
    } else if (auth === 'pat') headers.set('authorization', `Bearer ${patToken}`);
    else if (auth === 'svc') headers.set('authorization', `Bearer ${svcToken}`);
    else if (auth === 'unknown') headers.set('authorization', 'Bearer pb_pat_garbage');
    return app.fetch(
      new Request(ORIGIN + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  };
  return { request, suspendUser, reactivateUser, list, get, getOrganization, clientIp, ids };
}

async function normalized(response: Response) {
  const body = (await response.json()) as { error: { requestId: string } };
  const { requestId, ...error } = body.error;
  expect(requestId).toEqual(expect.any(String));
  return {
    status: response.status,
    headers: [...response.headers].filter(([key]) => key !== 'x-request-id'),
    body: { error },
  };
}

const ROUTES = [
  { name: 'getOrganization', method: 'GET', path: '/_pb/organization', permission: 'org:read' },
  { name: 'listUsers', method: 'GET', path: '/_pb/users', permission: 'org:users:read' },
  {
    name: 'updateUser',
    method: 'PATCH',
    path: `/_pb/users/${TARGET}`,
    permission: 'org:users:write',
    body: { status: 'suspended' },
  },
  { name: 'getMe', method: 'GET', path: '/_pb/me', permission: null },
] as const;

describe('organization route specs', () => {
  it('declares the four operations as valid API specs', () => {
    expect(ORGANIZATION_API_SPECS.map((spec) => spec.api.operationId)).toEqual(
      ROUTES.map((route) => route.name),
    );
    for (const spec of ORGANIZATION_API_SPECS) expect(() => defineApi(spec)).not.toThrow();
  });
});

describe.each(ROUTES)('$method $path', (route) => {
  const send = (f: Awaited<ReturnType<typeof fixture>>, auth?: Options['credential']) =>
    f.request(route.method, route.path, 'body' in route ? route.body : undefined, auth);

  it.each([
    ['malformed', { credential: 'unknown' }],
    ['revoked', { credential: 'pat', revoked: true }],
    ['expired', { credential: 'pat', expired: true }],
    ['revoked service', { credential: 'svc', revoked: true }],
  ] as const)('answers the anonymous 401 bytes for a %s bearer', async (_name, options) => {
    const anonymous = await normalized(await send(await fixture({ credential: 'none' })));
    const f = await fixture(options);
    const result = await normalized(await send(f));
    expect(result.status).toBe(401);
    expect(result).toEqual(anonymous);
  });

  it('sends no-store and no CORS header on success', async () => {
    const f = await fixture({ users: [user(1)] });
    const response = await send(f);
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('cache-control')).toContain(NO_STORE);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sends no-store and no CORS header on a denial', async () => {
    const f = await fixture({ permissions: [] });
    const response = await send(f);
    expect(response.headers.get('cache-control')).toContain(NO_STORE);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  if (route.permission !== null) {
    it('denies a session without the permission', async () => {
      const f = await fixture({
        permissions: PERMISSIONS.map((p) => p.name).filter((n) => n !== route.permission),
      });
      expect((await send(f)).status).toBe(403);
      expect(f.suspendUser).not.toHaveBeenCalled();
      expect(f.list).not.toHaveBeenCalled();
      expect(f.getOrganization).not.toHaveBeenCalled();
    });
  }
});

describe('PATCH /_pb/users/:user session-only', () => {
  it.each(['read', 'full'] as const)('denies a %s-scope token', async (tokenScope) => {
    const f = await fixture({ credential: 'pat', tokenScope });
    const response = await f.request('PATCH', `/_pb/users/${TARGET}`, { status: 'suspended' });
    expect(response.status).toBe(403);
    expect(f.suspendUser).not.toHaveBeenCalled();
  });

  it('denies a service token', async () => {
    const f = await fixture({ credential: 'svc' });
    const response = await f.request('PATCH', `/_pb/users/${TARGET}`, { status: 'suspended' });
    expect(response.status).toBe(403);
    expect(f.suspendUser).not.toHaveBeenCalled();
  });
});

describe('GET /_pb/organization', () => {
  it('answers the organization with the resolved token policy', async () => {
    const f = await fixture();
    const response = await f.request('GET', '/_pb/organization');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'org-1',
      slug: 'acme',
      name: 'Acme',
      settings: {
        retentionRemovedUpstreamDays: 30,
        tokenDefaultExpiryDays: 90,
        tokenMaxLifetimeDays: { personal: 120, service: 400 },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('does not expose tokenCiReadonlyExpiryDays', async () => {
    const f = await fixture();
    const text = await (await f.request('GET', '/_pb/organization')).text();
    expect(text).not.toContain('tokenCiReadonlyExpiryDays');
  });

  it('answers 404 when the organization row is absent', async () => {
    const f = await fixture({ organization: null });
    expect((await f.request('GET', '/_pb/organization')).status).toBe(404);
  });

  it('accepts a read-scope token holding org:read', async () => {
    const f = await fixture({ credential: 'pat', tokenScope: 'read' });
    expect((await f.request('GET', '/_pb/organization')).status).toBe(200);
  });

  it('rejects a query string', async () => {
    const f = await fixture();
    expect((await f.request('GET', '/_pb/organization?x=1')).status).toBe(400);
  });
});

describe('GET /_pb/users', () => {
  const five = [1, 2, 3, 4, 5].map((index) => user(index));

  it('pages by id with next equal to the last returned id', async () => {
    const f = await fixture({ users: five });
    const first = (await (await f.request('GET', '/_pb/users?limit=2')).json()) as {
      items: { id: string }[];
      next: string | null;
    };
    expect(first.items.map((item) => item.id)).toEqual([five[0]!.id, five[1]!.id]);
    expect(first.next).toBe(five[1]!.id);
    const second = (await (
      await f.request('GET', `/_pb/users?limit=2&after=${first.next!}`)
    ).json()) as { items: { id: string }[]; next: string | null };
    expect(second.items.map((item) => item.id)).toEqual([five[2]!.id, five[3]!.id]);
    expect(second.next).toBe(five[3]!.id);
    const last = (await (
      await f.request('GET', `/_pb/users?limit=2&after=${second.next!}`)
    ).json()) as { items: { id: string }[]; next: string | null };
    expect(last.items.map((item) => item.id)).toEqual([five[4]!.id]);
    expect(last.next).toBeNull();
  });

  it('fetches limit plus one rows and defaults the limit to 50', async () => {
    const f = await fixture({ users: five });
    await f.request('GET', '/_pb/users?limit=2');
    expect(f.list).toHaveBeenLastCalledWith(orgContext('org-1'), { afterId: null, limit: 3 });
    await f.request('GET', '/_pb/users');
    expect(f.list).toHaveBeenLastCalledWith(orgContext('org-1'), { afterId: null, limit: 51 });
  });

  it('does not serialize e-mail addresses', async () => {
    const f = await fixture({ users: five });
    const text = await (await f.request('GET', '/_pb/users')).text();
    expect(text).not.toContain('@');
    expect(text).not.toContain('"email"');
  });

  it('returns only the documented item keys', async () => {
    const f = await fixture({ users: [user(1, { lastLoginAt: '2026-03-01T00:00:00.000Z' })] });
    const body = (await (await f.request('GET', '/_pb/users')).json()) as {
      items: Record<string, unknown>[];
    };
    expect(Object.keys(body.items[0]!).sort()).toEqual(
      ['createdAt', 'displayName', 'id', 'lastLoginAt', 'status'].sort(),
    );
    expect(body.items[0]!['lastLoginAt']).toBe('2026-03-01T00:00:00.000Z');
  });

  it.each(['101', '0', '-1', 'abc', '1.5'])('rejects limit=%s with 400', async (limit) => {
    const f = await fixture({ users: five });
    expect((await f.request('GET', `/_pb/users?limit=${limit}`)).status).toBe(400);
    expect(f.list).not.toHaveBeenCalled();
  });

  it('rejects an after cursor that is not a ULID', async () => {
    const f = await fixture({ users: five });
    expect((await f.request('GET', '/_pb/users?after=nope')).status).toBe(400);
    expect(f.list).not.toHaveBeenCalled();
  });

  it('rejects an unknown query key', async () => {
    const f = await fixture({ users: five });
    expect((await f.request('GET', '/_pb/users?email=a')).status).toBe(400);
  });

  it('accepts a read-scope token holding org:users:read', async () => {
    const f = await fixture({ credential: 'pat', tokenScope: 'read', users: five });
    expect((await f.request('GET', '/_pb/users')).status).toBe(200);
  });
});

describe('PATCH /_pb/users/:user', () => {
  const path = `/_pb/users/${TARGET}`;

  it('suspends through the service with identity, fence and audit context', async () => {
    const f = await fixture();
    const response = await f.request('PATCH', path, { status: 'suspended' });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(f.reactivateUser).not.toHaveBeenCalled();
    expect(f.suspendUser).toHaveBeenCalledOnce();
    const call = f.suspendUser.mock.calls[0]!;
    expect(call[0]).toEqual(orgContext('org-1'));
    expect(call[1]).toMatchObject({
      kind: 'organization',
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(call[2]).toEqual({ userId: USER_ID, sessionId: SESSION_ID, expected: {} });
    expect(call[3]).toBe(TARGET);
    expect(call[4]).toEqual({
      audit: {
        opId: '01JAOPID00000000000000000A',
        requestId: response.headers.get('x-request-id'),
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
    });
  });

  it('reactivates through the service', async () => {
    const f = await fixture();
    const response = await f.request('PATCH', path, { status: 'active' });
    expect(response.status).toBe(204);
    expect(f.suspendUser).not.toHaveBeenCalled();
    expect(f.reactivateUser).toHaveBeenCalledOnce();
    expect(f.reactivateUser.mock.calls[0]![3]).toBe(TARGET);
  });

  it('answers 409 last_holder when the service refuses', async () => {
    const f = await fixture();
    f.suspendUser.mockResolvedValueOnce({ ok: false, error: 'last_holder' });
    const response = await f.request('PATCH', path, { status: 'suspended' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('last_holder');
  });

  it('answers 403 when the service refuses the live check', async () => {
    const f = await fixture();
    f.suspendUser.mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    expect((await f.request('PATCH', path, { status: 'suspended' })).status).toBe(403);
  });

  it('maps a service not_found to one 404 body regardless of the id', async () => {
    const unknown = await fixture();
    unknown.suspendUser.mockResolvedValueOnce({ ok: false, error: 'not_found' });
    const foreign = await fixture();
    foreign.suspendUser.mockResolvedValueOnce({ ok: false, error: 'not_found' });
    const a = await normalized(
      await unknown.request('PATCH', `/_pb/users/${UNKNOWN}`, { status: 'suspended' }),
    );
    const b = await normalized(await foreign.request('PATCH', path, { status: 'suspended' }));
    expect(a.status).toBe(404);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain(UNKNOWN);
  });

  it('answers byte-identical 404s from the real service for an absent and a foreign-organization user', async () => {
    const foreignUser = user(5);
    const administration = createAdministration({
      roles: {} as RoleRepository,
      grants: {
        isProtectedHolder: async () => false,
        suspendUser: async () => 'suspended',
      } as unknown as GrantRepository,
      users: {
        get: async (org: OrgContext, id: string) =>
          org.orgId === 'org-2' && id === foreignUser.id ? foreignUser : null,
      },
      providers: new Map(),
      clock,
      ids: { ulid: () => '01JA00000000000000000000AA' },
      log: () => undefined,
    });
    const absent = await fixture({ administration });
    const foreign = await fixture({ administration });
    const a = await normalized(
      await absent.request('PATCH', `/_pb/users/${UNKNOWN}`, { status: 'suspended' }),
    );
    const b = await normalized(
      await foreign.request('PATCH', `/_pb/users/${foreignUser.id}`, { status: 'suspended' }),
    );
    expect(a.status).toBe(404);
    expect(b).toEqual(a);
  });

  it('answers the uniform 404 without calling the service when the caller lacks org:users:read', async () => {
    const withRead = await fixture();
    withRead.suspendUser.mockResolvedValueOnce({ ok: false, error: 'not_found' });
    const expected = await normalized(
      await withRead.request('PATCH', `/_pb/users/${UNKNOWN}`, { status: 'suspended' }),
    );
    const f = await fixture({
      permissions: PERMISSIONS.map((p) => p.name).filter((n) => n !== 'org:users:read'),
    });
    const response = await f.request('PATCH', path, { status: 'suspended' });
    expect(response.status).toBe(404);
    expect(await normalized(response)).toEqual(expected);
    expect(f.suspendUser).not.toHaveBeenCalled();
    expect(f.reactivateUser).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized body key with a pointer and no key name', async () => {
    const f = await fixture();
    const response = await f.request('PATCH', path, { status: 'suspended', extra: 1 });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      error: { code: 'invalid_request', details: [{ path: '/body', code: 'unrecognized_keys' }] },
    });
    expect(text).not.toContain('extra');
    expect(f.suspendUser).not.toHaveBeenCalled();
  });

  it('rejects a status outside active and suspended', async () => {
    const f = await fixture();
    expect((await f.request('PATCH', path, { status: 'deleted' })).status).toBe(400);
    expect(f.suspendUser).not.toHaveBeenCalled();
    expect(f.reactivateUser).not.toHaveBeenCalled();
  });

  it('rejects an empty object body', async () => {
    const f = await fixture();
    expect((await f.request('PATCH', path, {})).status).toBe(400);
    expect(f.suspendUser).not.toHaveBeenCalled();
  });

  it('rejects a non-ULID user id before calling the service', async () => {
    const f = await fixture();
    expect(
      (await f.request('PATCH', '/_pb/users/not-a-ulid', { status: 'suspended' })).status,
    ).toBe(400);
    expect(f.suspendUser).not.toHaveBeenCalled();
  });

  it('does not demand If-Match', async () => {
    const f = await fixture();
    const response = await f.request('PATCH', path, { status: 'suspended' });
    expect(response.status).toBe(204);
  });

  it('rejects a session request without a CSRF token', async () => {
    const f = await fixture();
    const response = await f.request('PATCH', path, { status: 'suspended' }, 'session', false);
    expect(response.status).toBe(403);
    expect(f.suspendUser).not.toHaveBeenCalled();
  });
});

describe('GET /_pb/me', () => {
  it('returns the user and organization for a session without session secrets', async () => {
    const f = await fixture({ me: user(9, { id: USER_ID }) });
    const response = await f.request('GET', '/_pb/me');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      principal: { kind: 'user', id: USER_ID },
      user: { id: USER_ID, email: 'person9@example.test', displayName: 'Person 9' },
      organization: { slug: 'acme', name: 'Acme' },
    });
    for (const sentinel of [SESSION_ID, CSRF, SESSION_SECRET, SELECTOR]) {
      expect(text).not.toContain(sentinel);
    }
    expect(f.get).toHaveBeenCalledWith(orgContext('org-1'), USER_ID);
  });

  it.each(['read', 'full'] as const)(
    'withholds the e-mail address from a %s-scope user token',
    async (tokenScope) => {
      const f = await fixture({ credential: 'pat', tokenScope });
      const response = await f.request('GET', '/_pb/me');
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('@');
      expect(JSON.parse(text)).toMatchObject({
        user: { id: USER_ID, email: null, displayName: 'Person 9' },
      });
    },
  );

  it('returns user null and no selector for a service token', async () => {
    const f = await fixture({ credential: 'svc' });
    const response = await f.request('GET', '/_pb/me');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      principal: { kind: 'service', id: '01JA0000000000000000000007' },
      user: null,
      organization: { slug: 'acme', name: 'Acme' },
    });
    expect(text).not.toContain(SELECTOR);
    expect(f.get).not.toHaveBeenCalled();
  });

  it('returns user null when the user row is gone', async () => {
    const f = await fixture({ me: null });
    const body = (await (await f.request('GET', '/_pb/me')).json()) as { user: unknown };
    expect(body.user).toBeNull();
  });

  it('answers 404 when the organization row is absent', async () => {
    const f = await fixture({ organization: null });
    expect((await f.request('GET', '/_pb/me')).status).toBe(404);
  });

  it('is reachable by a caller holding no permissions', async () => {
    const f = await fixture({ permissions: [] });
    expect((await f.request('GET', '/_pb/me')).status).toBe(200);
  });
});

describe('route registration', () => {
  it('fails closed with a TypeError path when the access context is missing', async () => {
    const routes = organizationRoutes({
      organizations: { get: async () => organization },
      users: { list: async () => [], get: async () => null },
      administration: {
        suspendUser: async () => ({ ok: true, value: null }),
        reactivateUser: async () => ({ ok: true, value: null }),
      },
      lifetime: resolveTokenLifetimePolicy(undefined),
      clock,
      ids: { ulid: () => TARGET },
      clientIp: () => null,
    });
    const route = routes.find((r) => r.method === 'PATCH')!;
    const ctx = {
      request: new Request(`${ORIGIN}/_pb/users/${TARGET}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' }),
      }),
      params: { user: TARGET },
      requestId: 'req-1',
      org: orgContext('org-1'),
      principal: null,
      projectId: null,
    } as unknown as Parameters<typeof route.handler>[0];
    await expect(route.handler(ctx)).rejects.toBeInstanceOf(TypeError);
  });
});
