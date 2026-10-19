import * as accessContext from '../authz/access-context.js';
import * as engineModule from '../authz/engine.js';
import {
  accessContextOf,
  authenticatedActorOf,
  organizationActorOf,
} from '../authz/access-context.js';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { sha256Hex } from '../auth/primitives.js';
import { createAuthorizationEngine, patValidationGate } from '../authz/engine.js';
import type { EngineSessionAccess, EngineTokenAccess } from '../authz/engine.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  SUPPORTED_PLUGIN_API,
  type PluginDefinition,
  type PluginPorts,
  type RequestContext,
  type RouteDefinition,
} from '../plugin.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import type { AuthorizationEngine } from './authorize.js';
import { AUTHORIZATION_RETRY_AFTER_SECONDS, createKernel } from './kernel.js';

const ORIGIN = 'https://broker.test';
const ORG = orgContext('org-1');
const SESSION_SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const SELECTOR = 'abcdefghijkl';
const keyring = createKeyring([
  { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
]);
const PAT = formatToken(
  'pat',
  SELECTOR,
  Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 5),
);

const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) },
  clock: fixedClock('2026-10-16T00:00:00.000Z'),
  ids: { ulid: () => '01JA0000000000000000000000' },
};

interface Access {
  organizationPermissions: string[];
  projectPermissions: string[];
  lookups: number;
}

function echo(ctx: RequestContext): Response {
  return Response.json({ principal: ctx.principal, projectId: ctx.projectId });
}

const routes: readonly RouteDefinition[] = [
  { method: 'GET', path: '/pub', permission: null, handler: echo },
  {
    method: 'GET',
    path: '/org',
    permission: 'org:read',
    boundary: 'organization',
    handler: echo,
  },
  {
    method: 'GET',
    path: '/p/:project',
    permission: 'project:read',
    boundary: 'project',
    handler: echo,
  },
  {
    method: 'POST',
    path: '/p/:project',
    permission: 'project:settings:write',
    boundary: 'project',
    handler: echo,
  },
];

const plugin: PluginDefinition = {
  id: 'demo',
  package: '@test/demo',
  apiVersion: SUPPORTED_PLUGIN_API[1],
  platforms: ['node'],
  register(registry) {
    for (const route of routes) registry.route(route);
  },
};

function liveEngine(state: Access): AuthorizationEngine {
  return createAuthorizationEngine({
    access: {
      lookupSession: async (_ctx, input) => {
        state.lookups += 1;
        if (input.secretHash !== (await sha256Hex(SESSION_SECRET))) return null;
        const found: EngineSessionAccess = {
          session: { id: 'sess-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: 'user-1' },
          identity: null,
          protectedHolder: false,
          project: input.boundary === 'project' ? { id: 'proj-1' } : null,
          organizationPermissions: state.organizationPermissions,
          projectPermissions: input.boundary === 'project' ? state.projectPermissions : [],
        };
        return found;
      },
      lookupToken: async (_ctx, input) => {
        state.lookups += 1;
        if (input.selector !== SELECTOR) return null;
        const envelope = {
          token: {
            id: 'tok-1',
            kind: 'pat' as const,
            expired: false,
            revoked: false,
            lastUsedAt: null,
            userId: 'user-1',
            servicePrincipalId: null,
          },
          principalStatus: 'active',
          validation: { kind: 'local' as const, identityId: null, fresh: true, evidenceAt: null },
          project: input.boundary === 'project' ? { id: 'proj-1' } : null,
          organizationPermissions: state.organizationPermissions,
          projectPermissions: input.boundary === 'project' ? state.projectPermissions : [],
        };
        return Object.defineProperty(envelope, 'verifier', {
          value: { secretHash: await hashToken(keyring, 1, PAT), pepperVersion: 1 },
          enumerable: false,
        }) as unknown as EngineTokenAccess;
      },
      touchSession: () => Promise.resolve(true),
      touchToken: () => Promise.resolve(true),
    },
    tokenUse: {
      keyring,
      nowMs: () => Date.parse('2026-10-16T12:00:00.000Z'),
      dispatch: (run) => {
        void run();
      },
      log: () => undefined,
    },
    patValidation: patValidationGate,
    publicOrigin: ORIGIN,
    providerAnchors: () => Promise.resolve([]),
  });
}

function state(overrides: Partial<Access> = {}): Access {
  return {
    organizationPermissions: ['org:read'],
    projectPermissions: ['project:read', 'project:settings:write'],
    lookups: 0,
    ...overrides,
  };
}

async function kernel(authorization?: AuthorizationEngine) {
  return createKernel({
    platform: 'node',
    plugins: [plugin],
    ports,
    log: () => undefined,
    resolveOrg: () => Promise.resolve(ORG),
    health: () => Promise.resolve(true),
    ...(authorization === undefined ? {} : { authorization }),
  });
}

const cookie = { cookie: `${SESSION_COOKIE}=${SESSION_SECRET}` };
const basic = `Basic ${btoa(`${PAT}:${PAT}`)}`;

function call(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

describe('kernel with the live authorization engine', () => {
  it('allows a project route from the project-scoped permission and passes the project id', async () => {
    const k = await kernel(liveEngine(state()));
    const response = await k.fetch(call('/p/demo', { headers: cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principal: { kind: 'user', id: 'user-1' },
      projectId: 'proj-1',
    });
  });

  it('denies a project route when only an org-scoped grant holds the permission name', async () => {
    const access = state({ organizationPermissions: ['org:read'], projectPermissions: ['x'] });
    const k = await kernel(liveEngine(access));
    expect((await k.fetch(call('/p/demo', { headers: cookie }))).status).toBe(403);
  });

  it('allows an organization route from the organization permission with no project id', async () => {
    const k = await kernel(liveEngine(state()));
    const response = await k.fetch(call('/org', { headers: cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principal: { kind: 'user', id: 'user-1' },
      projectId: null,
    });
  });

  it('returns 503 unavailable for protected routes without an engine (denyAllEngine)', async () => {
    const k = await kernel();
    for (const path of ['/p/demo', '/org']) {
      const response = await k.fetch(call(path, { headers: cookie }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
    }
  });

  it('serves a public route without consulting the engine', async () => {
    const access = state();
    const k = await kernel(liveEngine(access));
    const response = await k.fetch(call('/pub'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principal: null, projectId: null });
    expect(access.lookups).toBe(0);
  });

  it('refuses an unsafe cookie request without the CSRF token before the handler runs', async () => {
    const k = await kernel(liveEngine(state()));
    const missing = await k.fetch(
      call('/p/demo', { method: 'POST', headers: { ...cookie, origin: ORIGIN } }),
    );
    expect(missing.status).toBe(403);
    const crossOrigin = await k.fetch(
      call('/p/demo', {
        method: 'POST',
        headers: { ...cookie, origin: 'https://evil.test', 'x-csrf-token': CSRF },
      }),
    );
    expect(crossOrigin.status).toBe(403);
    const valid = await k.fetch(
      call('/p/demo', {
        method: 'POST',
        headers: { ...cookie, origin: ORIGIN, 'x-csrf-token': CSRF },
      }),
    );
    expect(valid.status).toBe(200);
  });

  it('does not fall back to the cookie when an Authorization header is present', async () => {
    const access = state();
    const k = await kernel(liveEngine(access));
    const response = await k.fetch(
      call('/p/demo', { headers: { ...cookie, authorization: 'Bearer not-a-token' } }),
    );
    expect(response.status).toBe(401);
    expect(access.lookups).toBe(0);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('refuses Basic on an unsafe method without Origin and never sends a Basic challenge', async () => {
    const access = state();
    const k = await kernel(liveEngine(access));
    const response = await k.fetch(
      call('/p/demo', { method: 'POST', headers: { authorization: basic } }),
    );
    expect(response.status).toBe(401);
    expect(access.lookups).toBe(0);
    expect(response.headers.get('www-authenticate') ?? '').not.toMatch(/basic/i);
  });

  it('denies a session-only permission to a token even with a valid Origin', async () => {
    const k = await kernel(liveEngine(state()));
    const response = await k.fetch(
      call('/p/demo', { method: 'POST', headers: { authorization: basic, origin: ORIGIN } }),
    );
    expect(response.status).toBe(403);
  });

  it('allows a token on a token-eligible permission', async () => {
    const k = await kernel(liveEngine(state()));
    const response = await k.fetch(
      call('/p/demo', { headers: { authorization: `Bearer ${PAT}` } }),
    );
    expect(response.status).toBe(200);
  });

  it('authorizes HEAD as GET, strips the body, and returns 503 without an engine', async () => {
    const access = state();
    const k = await kernel(liveEngine(access));
    const allowed = await k.fetch(call('/p/demo', { method: 'HEAD', headers: cookie }));
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe('');
    const denied = await k.fetch(call('/p/demo', { method: 'HEAD' }));
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe('');
    const noEngine = await kernel();
    const unavailable = await noEngine.fetch(call('/p/demo', { method: 'HEAD', headers: cookie }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe('');
  });
});

async function snapshotKernel(
  authorization: AuthorizationEngine,
  boundary: 'organization' | 'project' | 'none' = 'organization',
  denyHook = false,
) {
  const contexts: RequestContext[] = [];
  const logs: unknown[] = [];
  const probe: PluginDefinition = {
    ...plugin,
    register(registry) {
      registry.route({
        method: 'GET',
        path: boundary === 'project' ? '/probe/:project' : '/probe',
        permission:
          boundary === 'none' ? null : boundary === 'project' ? 'project:read' : 'org:read',
        ...(boundary === 'none' ? {} : { boundary }),
        handler(ctx) {
          contexts.push(ctx);
          return new Response('ok');
        },
      });
      if (denyHook) registry.hook('access.check', () => ({ deny: true, reason: 'refused' }));
    },
  };
  const k = await createKernel({
    platform: 'node',
    plugins: [probe],
    ports,
    authorization,
    resolveOrg: async () => ORG,
    health: async () => true,
    log: (entry) => {
      logs.push(entry);
    },
  });
  return { k, contexts, logs };
}

describe('kernel access snapshots', () => {
  it.each([true, false])(
    'sets the organization session actor before invoking (protected=%s)',
    async (protectedHolder) => {
      const engine = sessionEngine(protectedHolder);
      const { k, contexts } = await snapshotKernel(engine);
      expect((await k.fetch(call('/probe', { headers: cookie }))).status).toBe(200);
      const ctx = contexts[0]!;
      expect(accessContextOf(ctx)).toMatchObject({
        boundary: 'organization',
        sessionId: 'sess-1',
        actor: { protectedHolder },
        rateKey: {
          stage: 'authenticated',
          tokenSelector: null,
          principalId: 'user-1',
          routeClass: 'organization',
        },
      });
      expect(organizationActorOf(ctx)?.isOrganizationAdmin).toBe(protectedHolder);
      expect(authenticatedActorOf(ctx)).toEqual({ userId: 'user-1', sessionId: 'sess-1' });
      expect(Object.isFrozen(ctx)).toBe(true);
    },
  );

  it('sets the project boundary and decision project id', async () => {
    const { k, contexts } = await snapshotKernel(liveEngine(state()), 'project');
    expect((await k.fetch(call('/probe/demo', { headers: cookie }))).status).toBe(200);
    expect(accessContextOf(contexts[0]!)).toMatchObject({
      boundary: 'project',
      projectId: 'proj-1',
    });
  });

  it('sets an anonymous public snapshot', async () => {
    const { k, contexts } = await snapshotKernel(liveEngine(state()), 'none');
    expect((await k.fetch(call('/probe'))).status).toBe(200);
    expect(accessContextOf(contexts[0]!)).toEqual({
      principal: null,
      projectId: null,
      boundary: 'none',
      sessionId: null,
      actor: null,
      rateKey: { stage: 'anonymous', ip: null, routeClass: 'none' },
    });
    expect(authenticatedActorOf(contexts[0]!)).toBeNull();
  });

  it('keeps a fake engine without a grant working without a snapshot', async () => {
    const { k, contexts } = await snapshotKernel({
      authorize: async () => ({
        allow: true,
        principal: { kind: 'user', id: 'user-1' },
        projectId: null,
      }),
    });
    expect((await k.fetch(call('/probe'))).status).toBe(200);
    expect(accessContextOf(contexts[0]!)).toBeNull();
    expect(authenticatedActorOf(contexts[0]!)).toBeNull();
    expect(organizationActorOf(contexts[0]!)).toBeNull();
  });

  it.each(['principal id', 'principal kind', 'projectId'] as const)(
    'fails closed for a mismatched %s',
    async (field) => {
      const base = liveEngine(state());
      const engine: AuthorizationEngine = {
        async authorize(request) {
          const decision = await base.authorize(request);
          if (!decision.allow) return decision;
          return {
            ...decision,
            ...(field === 'projectId'
              ? { projectId: 'other-project' }
              : {
                  principal: {
                    kind: field === 'principal kind' ? ('customer' as const) : ('user' as const),
                    id: field === 'principal id' ? 'other-user' : 'user-1',
                  },
                }),
          };
        },
      };
      const { k, contexts, logs } = await snapshotKernel(engine);
      const response = await k.fetch(call('/probe', { headers: cookie }));
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe(String(AUTHORIZATION_RETRY_AFTER_SECONDS));
      expect(await response.text()).not.toContain('administrator');
      expect(contexts).toHaveLength(0);
      expect(logs).toContainEqual(
        expect.objectContaining({ level: 'error', event: 'authz.error' }),
      );
      expect(JSON.stringify(logs)).not.toContain('sess-1');
    },
  );

  it('fails closed for a package route without a package actor', async () => {
    const spy = vi.spyOn(engineModule, 'engineGrantOf').mockReturnValue({
      principal: { kind: 'user', id: 'user-1' },
      projectId: 'proj-1',
      sessionId: 'sess-1',
      tokenSelector: null,
      actor: null,
    });
    try {
      const contexts: RequestContext[] = [];
      const logs: unknown[] = [];
      const pkgPlugin: PluginDefinition = {
        ...plugin,
        register(registry) {
          registry.route({
            method: 'GET',
            path: '/p/:project/pkg/:name',
            permission: 'project:packages:read',
            boundary: 'package',
            package: { ecosystem: 'composer', name: (params) => params['name'] ?? null },
            handler(ctx) {
              contexts.push(ctx);
              return new Response('ok');
            },
          });
        },
      };
      const k = await createKernel({
        platform: 'node',
        plugins: [pkgPlugin],
        ports,
        authorization: {
          authorize: async () => ({
            allow: true,
            principal: { kind: 'user', id: 'user-1' },
            projectId: 'proj-1',
          }),
        },
        packageResolver: { resolve: async () => ({ kind: 'absent' }) },
        resolveOrg: async () => ORG,
        health: async () => true,
        log: (entry) => {
          logs.push(entry);
        },
      });
      const response = await k.fetch(call('/p/demo/pkg/vendor-x', { headers: cookie }));
      expect(response.status).toBe(503);
      expect(response.headers.has('retry-after')).toBe(true);
      expect(logs).toContainEqual(expect.objectContaining({ event: 'authz.error' }));
      expect(contexts).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('never applies a grant after an access hook denies', async () => {
    const spy = vi.spyOn(accessContext, 'setAccessContext');
    try {
      const { k, contexts } = await snapshotKernel(liveEngine(state()), 'organization', true);
      expect((await k.fetch(call('/probe', { headers: cookie }))).status).toBe(403);
      expect(contexts).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('fails closed when storing the snapshot throws', async () => {
    const spy = vi.spyOn(accessContext, 'setAccessContext').mockImplementation(() => {
      throw new TypeError('invalid snapshot');
    });
    try {
      const { k, contexts, logs } = await snapshotKernel(liveEngine(state()));
      const response = await k.fetch(call('/probe', { headers: cookie }));
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe(String(AUTHORIZATION_RETRY_AFTER_SECONDS));
      expect(await response.text()).not.toContain('administrator');
      expect(contexts).toHaveLength(0);
      expect(logs).toContainEqual(
        expect.objectContaining({ level: 'error', event: 'authz.error' }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('sets a service selector without minting a session actor', async () => {
    const token = formatToken(
      'svc',
      SELECTOR,
      Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 5),
    );
    const engine = sessionEngine(false, token);
    const { k, contexts } = await snapshotKernel(engine);
    expect(
      (await k.fetch(call('/probe', { headers: { authorization: `Bearer ${token}` } }))).status,
    ).toBe(200);
    expect(accessContextOf(contexts[0]!)).toMatchObject({
      principal: { kind: 'service', id: 'svc-1' },
      sessionId: null,
      actor: null,
      rateKey: { tokenSelector: SELECTOR },
    });
    expect(authenticatedActorOf(contexts[0]!)).toBeNull();
  });
});

function sessionEngine(protectedHolder: boolean, serviceToken?: string): AuthorizationEngine {
  return createAuthorizationEngine({
    access: {
      lookupSession: async () => ({
        session: { id: 'sess-1', csrfHash: await sha256Hex(CSRF) },
        user: { id: 'user-1' },
        identity: null,
        protectedHolder,
        project: null,
        organizationPermissions: ['org:read'],
        projectPermissions: [],
      }),
      lookupToken: async () =>
        Object.defineProperty(
          {
            token: {
              id: 'tok-1',
              kind: 'svc',
              expired: false,
              revoked: false,
              lastUsedAt: null,
              userId: null,
              servicePrincipalId: 'svc-1',
            },
            principalStatus: 'active',
            validation: null,
            project: null,
            organizationPermissions: ['org:read'],
            projectPermissions: [],
          },
          'verifier',
          {
            value: { secretHash: await hashToken(keyring, 1, serviceToken!), pepperVersion: 1 },
            enumerable: false,
          },
        ) as unknown as EngineTokenAccess,
      touchSession: async () => true,
      touchToken: async () => true,
    },
    tokenUse: {
      keyring,
      nowMs: () => Date.parse('2026-10-16T12:00:00.000Z'),
      dispatch: (run) => {
        void run();
      },
      log: () => undefined,
    },
    patValidation: patValidationGate,
    publicOrigin: ORIGIN,
    providerAnchors: async () => [],
  });
}
