import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createAuthModule, type AuthModuleOptions, type AuthRepositories } from './module.js';
import { SESSION_COOKIE } from './cookies.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from '../kernel/kernel.js';
import { createKeyring } from '../secrets/keyring.js';
import type { EngineAccessPort } from '../authz/engine.js';

const origin = 'https://broker.test';
const clock = fixedClock('2026-10-16T00:00:00.000Z');
const org = orgContext('org-1');

function fixture(wired = true) {
  const findActive = vi.fn(() => Promise.resolve(null));
  const repositories = new Proxy({}, { get: () => ({ findActive }) }) as AuthRepositories;
  const access: EngineAccessPort = {
    lookupSession: vi.fn(() =>
      Promise.resolve({
        session: { id: 'session-1', csrfHash: 'unused' },
        user: { id: 'user-1' },
        project: null,
        identity: null,
        organizationPermissions: ['org:read'],
        projectPermissions: [],
        protectedHolder: false,
      }),
    ),
    lookupToken: vi.fn(() => Promise.resolve(null)),
    touchSession: vi.fn(() => Promise.resolve(true)),
    touchToken: vi.fn(() => Promise.resolve(true)),
  };
  const dispatch = vi.fn();
  const anchors = vi.fn(() => Promise.resolve([]));
  const unlinkIdentity = vi.fn(() => Promise.resolve('unlinked' as const));
  const options: AuthModuleOptions = {
    repositories,
    keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
    clock,
    ids: { ulid: () => '01JA0000000000000000000000' },
    publicOrigin: origin,
    providers: new Map(),
    hooks: { 'access.check': [], 'auth.resolveIdentity': [], 'auth.mapGroups': [] },
    log: vi.fn(),
    ...(wired
      ? {
          access: { access, providerAnchors: anchors, dispatch },
          unlink: { unlinks: { unlinkIdentity }, providers: { anchors } },
        }
      : {}),
  };
  return { auth: createAuthModule(options), access, findActive, dispatch, anchors, unlinkIdentity };
}

async function kernelFor(auth: ReturnType<typeof fixture>['auth']) {
  return createKernel({
    platform: 'node',
    plugins: [],
    ports: {
      organizations: { get: () => Promise.resolve(null) },
      clock,
      ids: { ulid: () => 'id' },
    },
    resolveOrg: () => Promise.resolve(org),
    health: () => Promise.resolve(true),
    log: () => undefined,
    authorization: auth.authorization,
    coreRoutes: [
      ...auth.coreRoutes,
      {
        method: 'GET',
        path: '/_pb/protected',
        permission: 'org:read',
        boundary: 'organization',
        handler: () => new Response('ok'),
      },
    ],
  });
}

function request(method = 'GET', headers: Record<string, string> = {}) {
  return new Request(`${origin}/_pb/protected`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}`, ...headers },
  });
}

describe('auth module access wiring', () => {
  it.each(['GET', 'HEAD'])(
    '%s uses one combined lookup without authenticating separately',
    async (method) => {
      const { auth, access, findActive, anchors, dispatch } = fixture();
      const authenticate = vi.spyOn(auth.sessions, 'authenticate');
      const kernel = await kernelFor(auth);
      expect((await kernel.fetch(request(method))).status).toBe(200);
      expect(access.lookupSession).toHaveBeenCalledTimes(1);
      expect(anchors).toHaveBeenCalledExactlyOnceWith(org);
      expect(authenticate).not.toHaveBeenCalled();
      expect(findActive).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('returns 503 unavailable for protected routes without access wiring', async () => {
    const { auth, findActive } = fixture(false);
    const kernel = await kernelFor(auth);
    const response = await kernel.fetch(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
    expect(findActive).not.toHaveBeenCalled();
    expect(auth.unlink).toBeNull();
  });

  it('keeps every public auth route on its needsOrg decision without a boundary', async () => {
    const { auth, access, findActive } = fixture();
    expect(auth.coreRoutes).toHaveLength(9);
    for (const route of auth.coreRoutes) {
      expect(route.permission).toBeNull();
      expect(route.boundary).toBeUndefined();
      expect(route.needsOrg).toBe(route.path !== '/_pb/auth/providers');
    }
    const kernel = await kernelFor(auth);
    expect((await kernel.fetch(new Request(`${origin}/_pb/auth/providers`))).status).toBe(200);
    expect((await kernel.fetch(new Request(`${origin}/_pb/session`))).status).toBe(401);
    expect(access.lookupSession).not.toHaveBeenCalled();
    expect(findActive).not.toHaveBeenCalled();
  });

  it('refuses a malformed authorization header instead of falling back to the cookie', async () => {
    const { auth, access, findActive } = fixture();
    const kernel = await kernelFor(auth);
    expect((await kernel.fetch(request('GET', { authorization: 'Bearer invalid' }))).status).toBe(
      401,
    );
    expect(access.lookupSession).not.toHaveBeenCalled();
    expect(findActive).not.toHaveBeenCalled();
  });

  it('refuses unsafe cookie access without CSRF', async () => {
    const { auth, access } = fixture();
    expect(
      await auth.authorization.authorize({
        request: request('POST'),
        org,
        params: {},
        route: {
          plugin: 'core',
          method: 'POST',
          path: '/_pb/protected',
          permission: 'org:read',
          boundary: 'organization',
        },
      }),
    ).toEqual({ allow: false, status: 403 });
    expect(access.lookupSession).toHaveBeenCalledTimes(1);
    expect(access.touchSession).not.toHaveBeenCalled();
  });

  it('exposes the unlink service with the module session reauth gate', async () => {
    const { auth, unlinkIdentity } = fixture();
    expect(auth.unlink?.unlinkIdentity).toBeTypeOf('function');
    const isReauthFresh = vi.spyOn(auth.sessions, 'isReauthFresh').mockReturnValue(false);
    const result = await auth.unlink?.unlinkIdentity(
      org,
      {
        session: { id: 'session-1', userId: 'user-1', reauthAt: null },
        principal: { kind: 'user', id: 'user-1' },
      } as Parameters<NonNullable<typeof auth.unlink>['unlinkIdentity']>[1],
      {
        session: { id: 'session-1' },
        user: { id: 'user-1' },
        protectedHolder: true,
        organizationPermissions: ['org:users:write'],
        projectPermissions: [],
      },
      { userId: 'user-1', sessionId: 'session-1', expected: {} } as Parameters<
        NonNullable<typeof auth.unlink>['unlinkIdentity']
      >[3],
      {
        identityId: 'identity-1',
        userId: 'target-1',
        provider: 'oidc',
        subject: 'subject-1',
      },
    );
    expect(result).toEqual({ ok: false, error: 'reauth_required' });
    expect(isReauthFresh).toHaveBeenCalledTimes(1);
    expect(unlinkIdentity).not.toHaveBeenCalled();
  });

  it('adds no token creation route or CLI wiring', () => {
    const { auth } = fixture();
    expect(auth.coreRoutes.some((route) => /token/i.test(route.path))).toBe(false);
    const source = readFileSync(new URL('./module.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/create(?:Pat|ServiceToken|Token)|commander|yargs/);
  });
});
