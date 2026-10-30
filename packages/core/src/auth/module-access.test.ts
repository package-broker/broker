import { createFailureEvents } from '../audit/failure-events.js';
import { authorizeRoute } from '../kernel/authorize.js';
import type { AuthorizationRequest } from '../kernel/authorize.js';
import type { AuditEvent } from '../audit/actions.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createAuthModule, type AuthModuleOptions, type AuthRepositories } from './module.js';
import { SESSION_COOKIE } from './cookies.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from '../kernel/kernel.js';
import { createKeyring } from '../secrets/keyring.js';
import type { EngineAccessPort } from '../authz/engine.js';
import { documented } from '../test-support/documented-routes.js';

const origin = 'https://broker.test';
const clock = fixedClock('2026-10-16T00:00:00.000Z');
const org = orgContext('org-1');

function fixture(wired = true, overrides: Partial<AuthModuleOptions> = {}) {
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
    clientIp: () => null,
    providers: new Map(),
    hooks: { 'access.check': [], 'auth.resolveIdentity': [], 'auth.mapGroups': [] },
    log: vi.fn(),
    ...overrides,
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
    coreRoutes: documented([
      ...auth.coreRoutes,
      {
        method: 'GET',
        path: '/_pb/protected',
        permission: 'org:read',
        boundary: 'organization',
        handler: () => new Response('ok'),
      },
    ]),
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
      {
        audit: {
          opId: '01K7R5V0000000000000000001',
          requestId: '01K7R5V0000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
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

describe('authorization failure capture', () => {
  const userId = '01JA0000000000000000000001';
  const projectId = '01JA0000000000000000000002';
  const template = '/_pb/projects/:project/audit';

  function harness(mode: 'slow' | 'failing' | 'normal' = 'normal') {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stage = vi.fn<(ctx: typeof org, event: AuditEvent) => Promise<void>>(async () => {
      if (mode === 'slow') await hold;
      if (mode === 'failing') throw new Error('private staging failure');
    });
    const log = vi.fn();
    const recorder = createFailureEvents({
      deploymentId: 'test',
      staging: { stage },
      observability: { log, counter: vi.fn(), histogram: vi.fn() },
      routeTemplates: new Set([template]),
      now: () => clock.now(),
    });
    const { auth, access } = fixture(true, {
      clientIp: () => '203.0.113.7',
      recordFailure: (ctx, attempt) => {
        void recorder.record(ctx, attempt);
      },
    });
    vi.mocked(access.lookupSession).mockResolvedValue({
      session: { id: 'session-1', csrfHash: 'unused' },
      user: { id: userId },
      project: { id: projectId },
      identity: null,
      organizationPermissions: [],
      projectPermissions: ['project:read'],
      protectedHolder: false,
    });
    const input: AuthorizationRequest = {
      request: new Request(`${origin}/_pb/projects/private-name/audit?secret=private`, {
        headers: { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` },
      }),
      org,
      params: { project: 'private-name' },
      route: {
        plugin: 'core',
        method: 'GET',
        path: template,
        permission: 'project:audit:read',
        boundary: 'project',
      },
    };
    return { auth, access, input, recorder, stage, log, release };
  }

  it('records the resolved actor, project, compiled template and route permission for a 403', async () => {
    const h = harness();
    expect(await authorizeRoute(h.input, h.auth.authorization, [])).toEqual({
      allow: false,
      status: 403,
    });
    await h.recorder.drain(org);
    expect(h.stage).toHaveBeenCalledExactlyOnceWith(
      org,
      expect.objectContaining({
        action: 'access.denied',
        actor: { type: 'user', id: userId },
        target: { type: 'route', id: template },
        projectId,
        sourceIp: '203.0.113.7',
      }),
    );
    expect(JSON.parse(h.stage.mock.calls[0]![1].payloadJson)).toMatchObject({
      changes: {
        permission: { new: 'project:audit:read' },
        boundary: { new: 'project' },
        count: { new: 1 },
      },
    });
    expect(JSON.stringify(h.stage.mock.calls)).not.toMatch(/private-name|secret|private staging/);
  });

  it.each(['deny', 'throw'] as const)(
    'captures a hook that will %s with the route permission',
    async (mode) => {
      const h = harness();
      const input = { ...h.input, route: { ...h.input.route, permission: 'project:read' } };
      expect(
        await authorizeRoute(input, h.auth.authorization, [
          {
            plugin: 'guard',
            handler: () => {
              if (mode === 'throw') throw new Error('private hook data');
              return { deny: true, reason: 'private hook data' };
            },
          },
        ]),
      ).toEqual({ allow: false, status: 403 });
      await h.recorder.drain(org);
      expect(h.stage).toHaveBeenCalledTimes(1);
      expect(JSON.parse(h.stage.mock.calls[0]![1].payloadJson).changes.permission.new).toBe(
        'project:read',
      );
      expect(JSON.stringify(h.stage.mock.calls)).not.toContain('private hook data');
    },
  );

  it.each(['authenticated', 'self'] as const)(
    'captures %s step-up denials without a catalogue permission',
    async (boundary) => {
      const h = harness();
      vi.mocked(h.access.lookupSession).mockResolvedValue({
        session: { id: 'session-1', csrfHash: 'unused' },
        user: { id: userId },
        project: null,
        identity: { id: 'identity-1', provider: 'oidc', fresh: false },
        organizationPermissions: [],
        projectPermissions: [],
        protectedHolder: false,
      });
      const input = {
        ...h.input,
        route: { ...h.input.route, permission: 'authenticated', boundary },
      };
      expect(await authorizeRoute(input, h.auth.authorization, [])).toEqual({
        allow: false,
        status: 403,
      });
      await h.recorder.drain(org);
      expect(h.stage).toHaveBeenCalledExactlyOnceWith(
        org,
        expect.objectContaining({ actor: { type: 'user', id: userId }, projectId: null }),
      );
      expect(JSON.parse(h.stage.mock.calls[0]![1].payloadJson).changes).toMatchObject({
        permission: { new: null },
        boundary: { new: 'authenticated' },
      });
    },
  );

  it.each(['same_origin', 'csrf'] as const)(
    'does not stage a %s refusal for a resolved session',
    async (mode) => {
      const h = harness();
      const input = {
        ...h.input,
        request: new Request(h.input.request.url, {
          method: 'POST',
          headers: {
            cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}`,
            origin: mode === 'same_origin' ? 'https://foreign.test' : origin,
          },
        }),
      };
      expect(await authorizeRoute(input, h.auth.authorization, [])).toEqual({
        allow: false,
        status: 403,
      });
      await h.recorder.drain(org);
      expect(h.stage).not.toHaveBeenCalled();
    },
  );

  it.each(['allowed', 'unauthorized', 'not_found'] as const)(
    'does not record %s decisions',
    async (mode) => {
      const h = harness();
      const input = { ...h.input, route: { ...h.input.route, permission: 'project:read' } };
      if (mode === 'unauthorized') vi.mocked(h.access.lookupSession).mockResolvedValue(null);
      if (mode === 'not_found') input.params = { project: 'invalid project' };
      const decision = await authorizeRoute(input, h.auth.authorization, []);
      expect(decision).toMatchObject(
        mode === 'allowed'
          ? { allow: true }
          : { allow: false, status: mode === 'unauthorized' ? 401 : 404 },
      );
      await h.recorder.drain(org);
      expect(h.stage).not.toHaveBeenCalled();
    },
  );

  it.each(['slow', 'failing'] as const)(
    'returns 403 without awaiting a %s store and shares the limiter across requests',
    async (mode) => {
      const h = harness(mode);
      try {
        for (let i = 0; i < 2; i++) {
          expect(await authorizeRoute({ ...h.input }, h.auth.authorization, [])).toEqual({
            allow: false,
            status: 403,
          });
        }
        await vi.waitFor(() => expect(h.stage).toHaveBeenCalledTimes(1));
      } finally {
        h.release();
      }
      await h.recorder.drain(org);
      expect(h.stage).toHaveBeenCalledTimes(1);
      if (mode === 'failing')
        expect(h.log).toHaveBeenCalledWith({ level: 'error', event: 'audit.failure_event_failed' });
    },
  );
});
