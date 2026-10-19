import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../auth/primitives.js';
import { orgContext } from '../db/port.js';
import type { OrgContext } from '../db/port.js';
import { createKernel } from '../kernel/kernel.js';
import { fixedClock } from '../ids.js';
import { authorizeRoute } from '../kernel/authorize.js';
import type { AuthorizationRequest } from '../kernel/authorize.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import { createAuthorizationEngine, engineGrantOf, patValidationGate } from './engine.js';
import type { AuthorizationEngineDeps, EngineSessionAccess, EngineTokenAccess } from './engine.js';

const ORIGIN = 'https://broker.test';
const keyring = createKeyring([
  { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
]);
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 5);
const SELECTOR = 'abcdefghijkl';
const PAT = formatToken('pat', SELECTOR, SECRET);
const SVC = formatToken('svc', 'mnopqrstuvwx', SECRET);
const CST = formatToken('cst', SELECTOR, SECRET);
const SESSION_SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const org = orgContext('org-1');

interface State {
  sessionRevoked: boolean;
  sessionIdentity: { id: string; provider: string; fresh: boolean } | null;
  sessionProject: { id: string } | null;
  sessionOrg: string[];
  sessionProjectPermissions: string[];
  token: {
    kind: 'pat' | 'svc';
    expired: boolean;
    revoked: boolean;
    principalStatus: string;
    fresh: boolean;
    project: { id: string } | null;
    projectPermissions: string[];
    organizationPermissions: string[];
    hashOf: string;
    bindingOk: boolean;
    projectMode: 'all' | 'selected' | null;
    scope: { level: string; readOnly: boolean } | null;
    lastUsedAt: string | null;
  };
  lookups: number;
  touches: string[];
  dispatched: number;
}

function freshState(): State {
  return {
    sessionRevoked: false,
    sessionIdentity: null,
    sessionProject: { id: 'proj-1' },
    sessionOrg: ['org:read'],
    sessionProjectPermissions: ['project:read', 'project:packages:read'],
    token: {
      kind: 'pat',
      expired: false,
      revoked: false,
      principalStatus: 'active',
      fresh: true,
      project: { id: 'proj-1' },
      projectPermissions: ['project:read', 'project:packages:read'],
      organizationPermissions: ['org:read'],
      hashOf: PAT,
      bindingOk: true,
      projectMode: 'all',
      scope: { level: 'full', readOnly: false },
      lastUsedAt: null,
    },
    lookups: 0,
    touches: [],
    dispatched: 0,
  };
}

async function tokenEnvelope(state: State): Promise<EngineTokenAccess> {
  const t = state.token;
  const envelope = {
    token: {
      id: 'tok-1',
      kind: t.kind,
      expired: t.expired,
      revoked: t.revoked,
      lastUsedAt: t.lastUsedAt,
      userId: t.kind === 'pat' ? 'user-1' : null,
      servicePrincipalId: t.kind === 'svc' ? 'svc-1' : null,
      bindingOk: t.bindingOk,
      projectMode: t.projectMode,
      scope: t.scope,
    },
    projectVisible: false,
    principalStatus: t.principalStatus,
    validation:
      t.kind === 'svc'
        ? null
        : { kind: 'local' as const, identityId: null, fresh: t.fresh, evidenceAt: null },
    project: t.project,
    organizationPermissions: t.organizationPermissions,
    projectPermissions: t.projectPermissions,
  };
  return Object.defineProperty(envelope, 'verifier', {
    value: { secretHash: await hashToken(keyring, 1, t.hashOf), pepperVersion: 1 },
    enumerable: false,
  }) as unknown as EngineTokenAccess;
}

function deps(
  state: State,
  overrides: Partial<AuthorizationEngineDeps> = {},
): AuthorizationEngineDeps {
  return {
    access: {
      lookupSession: async (_ctx: OrgContext, input) => {
        state.lookups += 1;
        if (state.sessionRevoked || input.secretHash !== (await sha256Hex(SESSION_SECRET))) {
          return null;
        }
        const found: EngineSessionAccess = {
          session: { id: 'sess-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: 'user-1' },
          identity: state.sessionIdentity,
          protectedHolder: false,
          project: input.boundary === 'project' ? state.sessionProject : null,
          organizationPermissions: state.sessionOrg,
          projectPermissions:
            input.boundary === 'project' && state.sessionProject !== null
              ? state.sessionProjectPermissions
              : [],
        };
        return found;
      },
      touchSession: (_ctx, id) => {
        state.touches.push(`session:${id}`);
        return Promise.resolve(true);
      },
      touchToken: (ctx, id, kind) => {
        state.touches.push(`token:${ctx.orgId}:${kind}:${id}`);
        return Promise.resolve(true);
      },
      lookupToken: async (_ctx, input) => {
        state.lookups += 1;
        if (input.selector !== SELECTOR && input.selector !== 'mnopqrstuvwx') return null;
        return tokenEnvelope(state);
      },
    },
    tokenUse: {
      keyring,
      nowMs: () => Date.parse('2026-10-16T12:00:00.000Z'),
      dispatch: (run) => {
        state.dispatched += 1;
        void run();
      },
      log: () => undefined,
    },
    patValidation: patValidationGate,
    publicOrigin: ORIGIN,
    providerAnchors: () => Promise.resolve([]),
    ...overrides,
  };
}

function req(
  init: {
    headers?: Record<string, string>;
    method?: string;
    permission?: string;
    boundary?: NonNullable<AuthorizationRequest['route']['boundary']> | 'absent';
    params?: Record<string, string>;
  } = {},
): AuthorizationRequest {
  const method = init.method ?? 'GET';
  return {
    request: new Request(`${ORIGIN}/_pb/projects/demo`, { method, headers: init.headers ?? {} }),
    org,
    route: {
      plugin: 'core',
      method,
      path: '/_pb/projects/:project',
      permission: init.permission ?? 'project:packages:read',
      ...(init.boundary === 'absent' ? {} : { boundary: init.boundary ?? 'project' }),
    },
    params: init.params ?? { project: 'demo' },
  };
}

const cookie = { cookie: `__Host-pb_session=${SESSION_SECRET}` };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('construction', () => {
  it('requires the use gate, the PAT gate and the access port', () => {
    const state = freshState();
    const base = deps(state);
    expect(() => createAuthorizationEngine(base)).not.toThrow();
    const noUse = { ...base, tokenUse: undefined };
    const noPat = { ...base, patValidation: undefined };
    const noAccess = { ...base, access: undefined };
    expect(() => createAuthorizationEngine(noUse as never)).toThrow(TypeError);
    expect(() => createAuthorizationEngine(noPat as never)).toThrow(TypeError);
    expect(() => createAuthorizationEngine(noAccess as never)).toThrow(TypeError);
  });

  it.each([['lookupSession'], ['lookupToken'], ['touchSession'], ['touchToken']] as const)(
    'requires the access member %s',
    (member) => {
      const base = deps(freshState());
      const access = { ...base.access, [member]: undefined };
      expect(() => createAuthorizationEngine({ ...base, access } as never)).toThrow(TypeError);
    },
  );

  it.each(['nowMs', 'dispatch', 'log', 'keyring'] as const)(
    'requires the token-use member %s',
    (member) => {
      const base = deps(freshState());
      const tokenUse = { ...base.tokenUse, [member]: undefined };
      expect(() => createAuthorizationEngine({ ...base, tokenUse } as never)).toThrow(TypeError);
    },
  );

  it('requires provider anchors and a PAT gate decide function', () => {
    const base = deps(freshState());
    expect(() =>
      createAuthorizationEngine({ ...base, providerAnchors: undefined } as never),
    ).toThrow(TypeError);
    expect(() => createAuthorizationEngine({ ...base, patValidation: {} } as never)).toThrow(
      TypeError,
    );
  });

  it('refuses a PAT gate that allows a token without validation', () => {
    const lax = {
      decide: (view: { validation: { fresh: boolean } | null }) => ({
        allowed: view.validation === null || view.validation.fresh,
        mode: 'none',
      }),
    };
    expect(() =>
      createAuthorizationEngine(deps(freshState(), { patValidation: lax as never })),
    ).toThrow(TypeError);
  });

  it('refuses a PAT gate that lets a stale token through', () => {
    const permissive = { decide: () => ({ allowed: true, mode: 'local' }) } as never;
    expect(() =>
      createAuthorizationEngine(deps(freshState(), { patValidation: permissive })),
    ).toThrow(TypeError);
  });

  it('refuses a non-canonical public origin', () => {
    expect(() =>
      createAuthorizationEngine(deps(freshState(), { publicOrigin: `${ORIGIN}/` })),
    ).toThrow(TypeError);
  });
});

describe('route shape', () => {
  it.each(['absent', 'none', 'self', 'package'] as const)(
    'denies boundary %s with 403',
    async (b) => {
      const state = freshState();
      const engine = createAuthorizationEngine(deps(state));
      const request = req({ headers: cookie, boundary: b });
      expect(await engine.authorize(request)).toEqual({ allow: false, status: 403 });
      expect(state.lookups).toBe(0);
    },
  );
});

describe('session', () => {
  it('allows a project route when the project set holds the permission', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(req({ headers: cookie }))).toEqual({
      allow: true,
      principal: { kind: 'user', id: 'user-1' },
      projectId: 'proj-1',
    });
  });

  it('allows an organization route from organization rows only', async () => {
    const state = freshState();
    state.sessionOrg = ['org:read'];
    state.sessionProjectPermissions = ['org:users:read'];
    const engine = createAuthorizationEngine(deps(state));
    const allowed = await engine.authorize(
      req({ headers: cookie, boundary: 'organization', permission: 'org:read', params: {} }),
    );
    expect(allowed).toEqual({
      allow: true,
      principal: { kind: 'user', id: 'user-1' },
      projectId: null,
    });
    expect(
      await engine.authorize(
        req({
          headers: cookie,
          boundary: 'organization',
          permission: 'org:users:read',
          params: {},
        }),
      ),
    ).toEqual({ allow: false, status: 403 });
  });

  it('answers 401 without a session, with an unknown one, or with a malformed cookie', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    const denied = { allow: false, status: 401 };
    expect(await engine.authorize(req())).toEqual(denied);
    expect(
      await engine.authorize(req({ headers: { cookie: `__Host-pb_session=${'C'.repeat(43)}` } })),
    ).toEqual(denied);
    expect(await engine.authorize(req({ headers: { cookie: '__Host-pb_session=short' } }))).toEqual(
      denied,
    );
  });

  it('reads the grants on every request: a committed edit or revoke denies the next one', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    expect((await engine.authorize(req({ headers: cookie }))).allow).toBe(true);
    expect((await engine.authorize(req({ headers: cookie }))).allow).toBe(true);
    expect(state.lookups).toBe(2);

    state.sessionProjectPermissions = ['project:read'];
    expect(await engine.authorize(req({ headers: cookie }))).toEqual({ allow: false, status: 403 });

    state.sessionProjectPermissions = ['project:read', 'project:packages:read'];
    expect((await engine.authorize(req({ headers: cookie }))).allow).toBe(true);

    state.sessionRevoked = true;
    expect(await engine.authorize(req({ headers: cookie }))).toEqual({ allow: false, status: 401 });
    expect(state.lookups).toBe(5);
  });

  it('allows a project route from organization-scope project: rows alone', async () => {
    const state = freshState();
    state.sessionOrg = ['project:packages:read', 'org:read'];
    state.sessionProjectPermissions = [];
    const engine = createAuthorizationEngine(deps(state));
    expect((await engine.authorize(req({ headers: cookie }))).allow).toBe(true);
    state.sessionOrg = ['org:read', 'org:users:read'];
    expect(await engine.authorize(req({ headers: cookie }))).toEqual({ allow: false, status: 404 });
    expect(await engine.authorize(req({ headers: cookie, permission: 'org:read' }))).toEqual({
      allow: false,
      status: 404,
    });
  });

  it('ignores projectPermissions on an organization boundary', async () => {
    const state = freshState();
    state.sessionOrg = ['org:read'];
    const base = deps(state);
    const engine = createAuthorizationEngine({
      ...base,
      access: {
        ...base.access,
        lookupSession: async (ctx, input) => {
          const found = await base.access.lookupSession(ctx, input);
          return found === null ? null : { ...found, projectPermissions: ['org:users:read'] };
        },
      },
    });
    expect(
      await engine.authorize(
        req({
          headers: cookie,
          boundary: 'organization',
          permission: 'org:users:read',
          params: {},
        }),
      ),
    ).toEqual({ allow: false, status: 403 });
  });

  it('answers a uniform 404 for an absent, archived, foreign or malformed project', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    const notFound = { allow: false, status: 404 };

    state.sessionProject = null;
    expect(await engine.authorize(req({ headers: cookie }))).toEqual(notFound);

    state.sessionProject = { id: 'proj-1' };
    for (const project of ['Demo', '../x', '', 'a%2fb']) {
      expect(await engine.authorize(req({ headers: cookie, params: { project } }))).toEqual(
        notFound,
      );
    }
    expect(await engine.authorize(req({ headers: cookie, params: {} }))).toEqual(notFound);
  });

  it('answers the same 404 for an existing project with no grants as for an unknown one', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    state.sessionProject = null;
    const unknown = await engine.authorize(req({ headers: cookie }));
    state.sessionProject = { id: 'proj-1' };
    state.sessionProjectPermissions = [];
    state.sessionOrg = ['org:read'];
    const ungranted = await engine.authorize(req({ headers: cookie }));
    expect(ungranted).toEqual({ allow: false, status: 404 });
    expect(ungranted).toEqual(unknown);
  });

  it('passes the boundary, slug and anchors to the lookups', async () => {
    const state = freshState();
    const seen: unknown[] = [];
    const base = deps(state);
    const anchors = [{ provider: 'idp', anchor: 'a1', emailAuthoritative: true }];
    const engine = createAuthorizationEngine({
      ...base,
      providerAnchors: () => Promise.resolve(anchors),
      access: {
        ...base.access,
        lookupSession: (ctx, input) => {
          seen.push({
            boundary: input.boundary,
            slug: input.projectSlug,
            anchors: input.providerAnchors,
          });
          return base.access.lookupSession(ctx, input);
        },
      },
    });
    await engine.authorize(req({ headers: cookie }));
    await engine.authorize(
      req({
        headers: cookie,
        boundary: 'organization',
        permission: 'org:read',
        params: { project: 'demo' },
      }),
    );
    await engine.authorize(req({ headers: cookie, params: { project: 'Bad' } }));
    expect(seen).toEqual([
      { boundary: 'project', slug: 'demo', anchors },
      { boundary: 'organization', slug: null, anchors },
      { boundary: 'project', slug: null, anchors },
    ]);
  });

  it('reads no provider anchors for an anonymous request', async () => {
    let reads = 0;
    const engine = createAuthorizationEngine(
      deps(freshState(), {
        providerAnchors: () => {
          reads += 1;
          return Promise.resolve([]);
        },
      }),
    );
    expect(await engine.authorize(req())).toEqual({ allow: false, status: 401 });
    expect(await engine.authorize(req({ headers: { authorization: 'Bearer x' } }))).toEqual({
      allow: false,
      status: 401,
    });
    expect(reads).toBe(0);
  });

  it('authenticates before it answers 404', async () => {
    const state = freshState();
    state.sessionProject = null;
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(req())).toEqual({ allow: false, status: 401 });
  });

  it('answers 403 for a visible project with a missing permission', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    expect(
      await engine.authorize(req({ headers: cookie, permission: 'project:settings:write' })),
    ).toEqual({ allow: false, status: 403 });
  });

  it('requires same-origin and the CSRF token on an unsafe cookie request', async () => {
    const state = freshState();
    state.sessionProjectPermissions = ['project:packages:write'];
    const engine = createAuthorizationEngine(deps(state));
    const post = (headers: Record<string, string>) =>
      engine.authorize(req({ method: 'POST', permission: 'project:packages:write', headers }));
    const forbidden = { allow: false, status: 403 };
    expect(await post(cookie)).toEqual(forbidden);
    expect(await post({ ...cookie, origin: ORIGIN })).toEqual(forbidden);
    expect(await post({ ...cookie, origin: 'https://evil.test', 'x-csrf-token': CSRF })).toEqual(
      forbidden,
    );
    expect(await post({ ...cookie, origin: ORIGIN, 'x-csrf-token': CSRF })).toMatchObject({
      allow: true,
    });
  });

  it('touches the session only after an allow', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    await engine.authorize(req({ headers: cookie, permission: 'project:settings:write' }));
    expect(state.touches).toEqual([]);
    await engine.authorize(req({ headers: cookie }));
    expect(state.touches).toEqual(['session:sess-1']);
  });

  it('propagates a lookup failure so the kernel denies', async () => {
    const state = freshState();
    const base = deps(state);
    const engine = createAuthorizationEngine({
      ...base,
      access: { ...base.access, lookupSession: () => Promise.reject(new Error('db down')) },
    });
    await expect(engine.authorize(req({ headers: cookie }))).rejects.toThrow('db down');
    const decision = await authorizeRoute(req({ headers: cookie }), engine, []);
    expect(decision).toEqual({ allow: false, status: 403 });
  });
});

describe('token', () => {
  it('allows a PAT and a service token with the right principal kind', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: true,
      principal: { kind: 'user', id: 'user-1' },
      projectId: 'proj-1',
      tokenId: 'tok-1',
    });
    state.token.kind = 'svc';
    state.token.hashOf = SVC;
    expect(await engine.authorize(req({ headers: bearer(SVC) }))).toEqual({
      allow: true,
      principal: { kind: 'service', id: 'svc-1' },
      projectId: 'proj-1',
      tokenId: 'tok-1',
    });
  });

  it('allows a Basic credential on a safe method', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    const basic = `Basic ${btoa(`${PAT}:x`)}`;
    expect((await engine.authorize(req({ headers: { authorization: basic } }))).allow).toBe(true);
  });

  it('refuses Basic on an unsafe method without an Origin check', async () => {
    const state = freshState();
    state.token.projectPermissions = ['project:packages:write'];
    const engine = createAuthorizationEngine(deps(state));
    const basic = `Basic ${btoa(`${PAT}:x`)}`;
    const post = (extra: Record<string, string>) =>
      engine.authorize(
        req({
          method: 'POST',
          permission: 'project:packages:write',
          headers: { authorization: basic, ...extra },
        }),
      );
    expect(await post({})).toEqual({ allow: false, status: 401 });
    expect((await post({ origin: ORIGIN })).allow).toBe(true);
  });

  it('answers one identical 401 for every credential failure', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    const wrongSecret = formatToken(
      'pat',
      SELECTOR,
      Uint8Array.from({ length: 32 }, () => 9),
    );
    const cases: [string, () => Promise<Record<string, string>>][] = [
      ['malformed', () => Promise.resolve(bearer('pb_pat_nope'))],
      [
        'unknown selector',
        () => Promise.resolve(bearer(formatToken('pat', 'zzzzzzzzzzzz', SECRET))),
      ],
      ['wrong secret', () => Promise.resolve(bearer(wrongSecret))],
      ['reserved cst', () => Promise.resolve(bearer(CST))],
      ['unsupported scheme', () => Promise.resolve({ authorization: 'Digest abc' })],
      [
        'expired',
        () => {
          state.token.expired = true;
          return Promise.resolve(bearer(PAT));
        },
      ],
      [
        'revoked',
        () => {
          state.token.expired = false;
          state.token.revoked = true;
          return Promise.resolve(bearer(PAT));
        },
      ],
      [
        'suspended principal',
        () => {
          state.token.revoked = false;
          state.token.principalStatus = 'suspended';
          return Promise.resolve(bearer(PAT));
        },
      ],
      [
        'stale validation',
        () => {
          state.token.principalStatus = 'active';
          state.token.fresh = false;
          return Promise.resolve(bearer(PAT));
        },
      ],
    ];
    for (const [, build] of cases) {
      const decision = await engine.authorize(req({ headers: await build() }));
      expect(decision).toEqual({ allow: false, status: 401 });
    }
  });

  it('lets the Authorization header win over a valid session cookie', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    expect(
      await engine.authorize(req({ headers: { ...cookie, authorization: 'Bearer pb_pat_nope' } })),
    ).toEqual({ allow: false, status: 401 });
  });

  it('answers 404 for a token not bound to the requested project', async () => {
    const state = freshState();
    state.token.project = null;
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: false,
      status: 404,
    });
  });

  it('answers 404 for a token whose effective project set is empty, like an unknown project', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    state.token.project = null;
    state.token.projectPermissions = [];
    const unknown = await engine.authorize(req({ headers: bearer(PAT) }));
    state.token.project = { id: 'proj-1' };
    const ungranted = await engine.authorize(req({ headers: bearer(PAT) }));
    expect(ungranted).toEqual({ allow: false, status: 404 });
    expect(ungranted).toEqual(unknown);
  });

  it('does not union organizationPermissions on the token project boundary', async () => {
    const state = freshState();
    state.token.projectPermissions = ['project:read'];
    state.token.organizationPermissions = ['project:packages:read'];
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: false,
      status: 403,
    });
  });

  it('does not union projectPermissions on the token organization boundary', async () => {
    const state = freshState();
    state.token.organizationPermissions = ['org:read'];
    state.token.projectPermissions = ['org:users:read'];
    const engine = createAuthorizationEngine(deps(state));
    expect(
      await engine.authorize(
        req({
          headers: bearer(PAT),
          boundary: 'organization',
          permission: 'org:users:read',
          params: {},
        }),
      ),
    ).toEqual({ allow: false, status: 403 });
  });

  it('schedules no touch when the session-only check denies', async () => {
    const state = freshState();
    state.token.projectPermissions = ['project:settings:write'];
    const engine = createAuthorizationEngine(deps(state));
    expect(
      await engine.authorize(req({ headers: bearer(PAT), permission: 'project:settings:write' })),
    ).toEqual({ allow: false, status: 403 });
    expect(state.dispatched).toBe(0);
    expect(state.touches).toEqual([]);
  });

  it('denies a session-only permission even when the port returns it', async () => {
    const state = freshState();
    state.token.projectPermissions = ['project:settings:write'];
    const engine = createAuthorizationEngine(deps(state));
    expect(
      await engine.authorize(req({ headers: bearer(PAT), permission: 'project:settings:write' })),
    ).toEqual({ allow: false, status: 403 });
  });

  it('skips the Origin check for Bearer on an unsafe method', async () => {
    const state = freshState();
    state.token.projectPermissions = ['project:packages:write'];
    const engine = createAuthorizationEngine(deps(state));
    expect(
      (
        await engine.authorize(
          req({ method: 'POST', permission: 'project:packages:write', headers: bearer(PAT) }),
        )
      ).allow,
    ).toBe(true);
  });

  it('denies a token whose principal id is missing', async () => {
    const state = freshState();
    const base = deps(state);
    const engine = createAuthorizationEngine({
      ...base,
      access: {
        ...base.access,
        lookupToken: async (ctx, input) => {
          const found = await base.access.lookupToken(ctx, input);
          return found === null
            ? null
            : (Object.defineProperty(
                { ...found, token: { ...found.token, userId: null } },
                'verifier',
                { value: (found as never as { verifier: unknown }).verifier, enumerable: false },
              ) as EngineTokenAccess);
        },
      },
    });
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: false,
      status: 401,
    });
  });

  it('keeps the decision when dispatch and the logger both throw', async () => {
    const state = freshState();
    const throwing = {
      ...deps(state).tokenUse,
      dispatch: () => {
        throw new Error('dispatch');
      },
      log: () => {
        throw new Error('log');
      },
    };
    const engine = createAuthorizationEngine(deps(state, { tokenUse: throwing }));
    expect((await engine.authorize(req({ headers: bearer(PAT) }))).allow).toBe(true);
    expect((await engine.authorize(req({ headers: cookie }))).allow).toBe(true);
  });

  it('keeps the decision when the touch rejects and the logger throws', async () => {
    const state = freshState();
    const base = deps(state);
    const engine = createAuthorizationEngine({
      ...base,
      tokenUse: {
        ...base.tokenUse,
        dispatch: (run) => {
          void run();
        },
        log: () => {
          throw new Error('log');
        },
      },
      access: {
        ...base.access,
        touchSession: () => Promise.reject(new Error('touch')),
        touchToken: () => Promise.reject(new Error('touch')),
      },
    });
    expect((await engine.authorize(req({ headers: cookie }))).allow).toBe(true);
    expect((await engine.authorize(req({ headers: bearer(PAT) }))).allow).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('answers 403 when the token scope lacks the permission', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    expect(
      await engine.authorize(req({ headers: bearer(PAT), permission: 'project:packages:write' })),
    ).toEqual({ allow: false, status: 403 });
  });

  it('reads the token on every request: revoke denies the next one', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    expect((await engine.authorize(req({ headers: bearer(PAT) }))).allow).toBe(true);
    state.token.revoked = true;
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: false,
      status: 401,
    });
    expect(state.lookups).toBe(2);
  });

  it('schedules the last-use touch only after an allow', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    await engine.authorize(req({ headers: bearer(PAT), permission: 'project:settings:write' }));
    expect(state.dispatched).toBe(0);
    await engine.authorize(req({ headers: bearer('pb_pat_nope') }));
    expect(state.dispatched).toBe(0);
    await engine.authorize(req({ headers: bearer(PAT) }));
    expect(state.dispatched).toBe(1);
    expect(state.touches).toEqual(['token:org-1:pat:tok-1']);
  });

  it('applies organization permissions on an organization boundary', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    expect(
      await engine.authorize(
        req({ headers: bearer(PAT), boundary: 'organization', permission: 'org:read', params: {} }),
      ),
    ).toEqual({
      allow: true,
      principal: { kind: 'user', id: 'user-1' },
      projectId: null,
      tokenId: 'tok-1',
    });
  });
});

describe('with the kernel', () => {
  it('turns a hook denial after an engine allow into a generic 403', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    const hooks = [
      { plugin: 'p', handler: () => ({ deny: true as const, reason: 'secret-reason' }) },
    ];
    const decision = await authorizeRoute(req({ headers: cookie }), engine, hooks);
    expect(decision).toEqual({ allow: false, status: 403 });
  });

  it('never runs hooks for an engine denial', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    let ran = false;
    const hooks = [
      {
        plugin: 'p',
        handler: () => {
          ran = true;
          return undefined;
        },
      },
    ];
    expect(await authorizeRoute(req(), engine, hooks)).toEqual({ allow: false, status: 401 });
    expect(ran).toBe(false);
  });
});

describe('engine grants', () => {
  it.each([true, false])(
    'copies and freezes the session snapshot (protected=%s)',
    async (protectedHolder) => {
      const state = freshState();
      const base = deps(state);
      const engine = createAuthorizationEngine({
        ...base,
        access: {
          ...base.access,
          lookupSession: async (ctx, input) => {
            const found = await base.access.lookupSession(ctx, input);
            return found && { ...found, protectedHolder };
          },
        },
      });
      const request = req({ headers: cookie });
      const decision = await engine.authorize(request);
      expect(Object.keys(decision).sort()).toEqual(['allow', 'principal', 'projectId']);
      const grant = engineGrantOf(request)!;
      expect(grant).toMatchObject({
        principal: { kind: 'user', id: 'user-1' },
        projectId: 'proj-1',
        sessionId: 'sess-1',
        tokenSelector: null,
        actor: {
          session: { id: 'sess-1', userId: 'user-1' },
          user: { id: 'user-1' },
          organizationPermissions: ['org:read'],
          projectPermissions: ['project:read', 'project:packages:read'],
          protectedHolder,
        },
      });
      for (const value of [
        grant,
        grant.principal,
        grant.actor,
        grant.actor!.session,
        grant.actor!.user,
        grant.actor!.organizationPermissions,
        grant.actor!.projectPermissions,
      ])
        expect(Object.isFrozen(value)).toBe(true);
      state.sessionOrg.push('org:users:write');
      state.sessionProjectPermissions.length = 0;
      expect(grant.actor!.organizationPermissions).toEqual(['org:read']);
      expect(grant.actor!.projectPermissions).toEqual(['project:read', 'project:packages:read']);
      expect(engineGrantOf({ ...request })).toBeNull();
    },
  );

  it.each(['pat', 'svc'] as const)(
    'records a %s selector and passes the token id through authorizeRoute',
    async (kind) => {
      const state = freshState();
      state.token.kind = kind;
      state.token.hashOf = kind === 'pat' ? PAT : SVC;
      const request = req({ headers: bearer(state.token.hashOf) });
      const decision = await authorizeRoute(request, createAuthorizationEngine(deps(state)), []);
      expect(decision).toMatchObject({ allow: true, tokenId: 'tok-1' });
      expect(Object.keys(decision).sort()).toEqual(['allow', 'principal', 'projectId', 'tokenId']);
      expect(engineGrantOf(request)).toEqual({
        principal:
          kind === 'pat' ? { kind: 'user', id: 'user-1' } : { kind: 'service', id: 'svc-1' },
        projectId: 'proj-1',
        sessionId: null,
        actor: null,
        tokenSelector: kind === 'pat' ? SELECTOR : 'mnopqrstuvwx',
      });
    },
  );

  it.each([
    ['401', () => req(), 401],
    ['403', () => req({ headers: cookie, permission: 'project:settings:write' }), 403],
    ['404', () => req({ headers: cookie, params: { project: 'BAD' } }), 404],
    ['CSRF refusal', () => req({ headers: { ...cookie, origin: ORIGIN }, method: 'POST' }), 403],
    [
      'Origin refusal',
      () =>
        req({
          headers: { ...cookie, origin: 'https://foreign.test', 'x-csrf-token': CSRF },
          method: 'POST',
        }),
      403,
    ],
    [
      'Basic without Origin',
      () => req({ headers: { authorization: `Basic ${btoa(`${PAT}:x`)}` }, method: 'POST' }),
      401,
    ],
    [
      'session-only token permission',
      () => req({ headers: bearer(PAT), permission: 'project:settings:write' }),
      403,
    ],
  ] as const)('records nothing for %s', async (_name, makeRequest, status) => {
    const state = freshState();
    state.token.projectPermissions.push('project:settings:write');
    const request = makeRequest();
    expect(await createAuthorizationEngine(deps(state)).authorize(request)).toEqual({
      allow: false,
      status,
    });
    expect(engineGrantOf(request)).toBeNull();
  });

  it('records nothing when a lookup throws', async () => {
    const base = deps(freshState());
    const engine = createAuthorizationEngine({
      ...base,
      access: {
        ...base.access,
        lookupSession: async () => {
          throw new Error('unavailable');
        },
      },
    });
    const request = req({ headers: cookie });
    await expect(engine.authorize(request)).rejects.toThrow('unavailable');
    expect(engineGrantOf(request)).toBeNull();
  });
});

describe('token scope shortfall on a visible project', () => {
  function withVisibility(state: State, projectVisible: boolean): AuthorizationEngineDeps {
    const base = deps(state);
    return {
      ...base,
      access: {
        ...base.access,
        lookupToken: async (ctx, input) => {
          const found = await base.access.lookupToken(ctx, input);
          return found === null
            ? null
            : (Object.defineProperty({ ...found, projectVisible }, 'verifier', {
                value: (found as never as { verifier: unknown }).verifier,
                enumerable: false,
              }) as EngineTokenAccess);
        },
      },
    };
  }

  it('answers 403 when the principal sees the project but the token scope yields nothing', async () => {
    const state = freshState();
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(withVisibility(state, true));
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: false,
      status: 403,
    });
    expect(state.dispatched).toBe(0);
  });

  it('answers 403 when the principal sees the project but the token binding excludes it', async () => {
    const state = freshState();
    state.token.project = null;
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(withVisibility(state, true));
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: false,
      status: 403,
    });
  });

  it('answers 403 for a service token whose scope excludes a project its principal sees', async () => {
    const state = freshState();
    state.token.kind = 'svc';
    state.token.hashOf = SVC;
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(withVisibility(state, true));
    expect(await engine.authorize(req({ headers: bearer(SVC) }))).toEqual({
      allow: false,
      status: 403,
    });
  });

  it('answers 404 when the principal cannot see the project', async () => {
    const state = freshState();
    state.token.project = null;
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(withVisibility(state, false));
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: false,
      status: 404,
    });
  });

  it('answers 404 for a project of another organization', async () => {
    const state = freshState();
    state.token.project = null;
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(withVisibility(state, false));
    expect(
      await engine.authorize(req({ headers: bearer(PAT), params: { project: 'other-org-demo' } })),
    ).toEqual({ allow: false, status: 404 });
  });

  it('answers 404 for a project the token binding reaches but the principal cannot see', async () => {
    const state = freshState();
    state.token.project = { id: 'proj-1' };
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(withVisibility(state, false));
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: false,
      status: 404,
    });
  });

  it('answers 404 for a malformed slug even when the port reports the project visible', async () => {
    const state = freshState();
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(withVisibility(state, true));
    expect(
      await engine.authorize(req({ headers: bearer(PAT), params: { project: 'Bad Slug' } })),
    ).toEqual({ allow: false, status: 404 });
  });

  it('treats anything other than true as not visible', async () => {
    const state = freshState();
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(withVisibility(state, 'yes' as unknown as boolean));
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: false,
      status: 404,
    });
  });

  it('still answers 401 for an expired token on a visible project', async () => {
    const state = freshState();
    state.token.expired = true;
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(withVisibility(state, true));
    expect(await engine.authorize(req({ headers: bearer(PAT) }))).toEqual({
      allow: false,
      status: 401,
    });
  });

  it('keeps the session decision at 404 for an empty set', async () => {
    const state = freshState();
    state.sessionProjectPermissions = [];
    state.sessionOrg = ['org:read'];
    const engine = createAuthorizationEngine(withVisibility(state, true));
    expect(await engine.authorize(req({ headers: cookie }))).toEqual({
      allow: false,
      status: 404,
    });
  });
});

describe('authenticated boundary', () => {
  const ask = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
    req({
      headers,
      boundary: 'authenticated' as never,
      permission: 'authenticated',
      params: {},
      ...extra,
    });

  it('allows a valid session with no permission check and a null project', async () => {
    const state = freshState();
    state.sessionOrg = [];
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(cookie))).toEqual({
      allow: true,
      principal: { kind: 'user', id: 'user-1' },
      projectId: null,
    });
  });

  it('allows a token that holds no permission at all', async () => {
    const state = freshState();
    state.token.organizationPermissions = [];
    state.token.projectPermissions = [];
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(bearer(PAT)))).toEqual({
      allow: true,
      principal: { kind: 'user', id: 'user-1' },
      projectId: null,
      tokenId: 'tok-1',
    });
  });

  it('answers 401 without a credential', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    expect(await engine.authorize(ask({}))).toEqual({ allow: false, status: 401 });
  });

  it('answers 401 for a malformed Authorization header', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    expect(await engine.authorize(ask({ authorization: 'Bearer' }))).toEqual({
      allow: false,
      status: 401,
    });
  });

  it('answers 401 for a revoked session', async () => {
    const state = freshState();
    state.sessionRevoked = true;
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(cookie))).toEqual({ allow: false, status: 401 });
  });

  it('answers 401 for a revoked token', async () => {
    const state = freshState();
    state.token.revoked = true;
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(bearer(PAT)))).toEqual({ allow: false, status: 401 });
  });

  it('answers 401 for a token whose binding is inconsistent', async () => {
    const state = freshState();
    state.token.bindingOk = false;
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(bearer(PAT)))).toEqual({ allow: false, status: 401 });
  });

  it('answers 401 for a token whose scope is unparseable or inconsistent', async () => {
    const state = freshState();
    state.token.scope = null;
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(bearer(PAT)))).toEqual({ allow: false, status: 401 });
  });

  it('answers 401 for a token with no project mode', async () => {
    const state = freshState();
    state.token.projectMode = null;
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(bearer(PAT)))).toEqual({ allow: false, status: 401 });
  });

  it('answers 401 for a token whose principal is inactive', async () => {
    const state = freshState();
    state.token.principalStatus = 'suspended';
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(bearer(PAT)))).toEqual({ allow: false, status: 401 });
  });

  it('answers 401 for a PAT whose validation is stale', async () => {
    const state = freshState();
    state.token.fresh = false;
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(bearer(PAT)))).toEqual({ allow: false, status: 401 });
  });

  it('allows a read-level token', async () => {
    const state = freshState();
    state.token.scope = { level: 'read', readOnly: true };
    const engine = createAuthorizationEngine(deps(state));
    expect((await engine.authorize(ask(bearer(PAT)))).allow).toBe(true);
  });

  it('allows a project-scoped PAT with a null project id', async () => {
    const state = freshState();
    state.token.organizationPermissions = [];
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(bearer(PAT)))).toMatchObject({
      allow: true,
      projectId: null,
    });
  });

  it('allows a project-bound service token as a service principal', async () => {
    const state = freshState();
    state.token.kind = 'svc';
    state.token.hashOf = SVC;
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(bearer(SVC)))).toEqual({
      allow: true,
      principal: { kind: 'service', id: 'svc-1' },
      projectId: null,
      tokenId: 'tok-1',
    });
  });

  it('accepts a Basic credential on the GET route, as organization routes do', async () => {
    const engine = createAuthorizationEngine(deps(freshState()));
    const basic = `Basic ${btoa(`${PAT}:x`)}`;
    expect((await engine.authorize(ask({ authorization: basic }))).allow).toBe(true);
  });

  it('answers 401 for an expired token', async () => {
    const state = freshState();
    state.token.expired = true;
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(ask(bearer(PAT)))).toEqual({ allow: false, status: 401 });
  });

  it('still answers 403 for the self boundary with a valid session', async () => {
    const state = freshState();
    const engine = createAuthorizationEngine(deps(state));
    expect(await engine.authorize(req({ headers: cookie, boundary: 'self' }))).toEqual({
      allow: false,
      status: 403,
    });
    expect(state.lookups).toBe(0);
  });
});

describe('authenticated boundary through the kernel', () => {
  const BASE = 'http://broker.test';

  async function kernelWith(
    state: State,
    calls: unknown[],
    overrides: Partial<AuthorizationEngineDeps> = {},
  ) {
    return createKernel({
      platform: 'node',
      plugins: [],
      ports: {
        organizations: { get: () => Promise.resolve(null) },
        clock: fixedClock('2026-10-16T12:00:00.000Z'),
        ids: { ulid: () => '01JA0000000000000000000000' },
      },
      resolveOrg: () => Promise.resolve(org),
      health: () => Promise.resolve(true),
      log: () => undefined,
      authorization: createAuthorizationEngine(deps(state, overrides)),
      coreRoutes: [
        {
          method: 'GET',
          path: '/_pb/organization',
          permission: 'org:read',
          boundary: 'organization',
          handler: () => Response.json({ ok: true }),
        },
        {
          method: 'GET',
          path: '/_pb/whoami',
          permission: null,
          boundary: 'authenticated',
          handler: (context) => {
            calls.push({ principal: context.principal, projectId: context.projectId });
            return Response.json({ ok: true });
          },
        },
        {
          method: 'GET',
          path: '/_pb/open',
          permission: null,
          handler: () => Response.json({ open: true }),
        },
      ],
    });
  }

  const strip = (body: { error: { requestId?: string } }) => ({
    ...body,
    error: { ...body.error, requestId: undefined },
  });

  it('answers anonymous, malformed and revoked-session requests with one identical 401 body', async () => {
    const state = freshState();
    state.sessionRevoked = true;
    const calls: unknown[] = [];
    const kernel = await kernelWith(state, calls);
    const bodies: unknown[] = [];
    for (const headers of [{}, { authorization: 'Bearer' }, cookie]) {
      const response = await kernel.fetch(new Request(`${BASE}/_pb/whoami`, { headers }));
      expect(response.status).toBe(401);
      bodies.push(strip((await response.json()) as never));
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(calls).toHaveLength(0);
  });

  it('runs the handler once with the principal for a valid session', async () => {
    const calls: unknown[] = [];
    const kernel = await kernelWith(freshState(), calls);
    const response = await kernel.fetch(new Request(`${BASE}/_pb/whoami`, { headers: cookie }));
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ principal: { kind: 'user', id: 'user-1' }, projectId: null }]);
  });

  it('runs the handler once with the principal for a valid read-scope token', async () => {
    const state = freshState();
    state.token.organizationPermissions = ['org:read'];
    state.token.projectPermissions = [];
    const calls: unknown[] = [];
    const kernel = await kernelWith(state, calls);
    const response = await kernel.fetch(
      new Request(`${BASE}/_pb/whoami`, { headers: bearer(PAT) }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ principal: { kind: 'user', id: 'user-1' }, projectId: null }]);
  });

  it('still serves a permission-less route without a boundary to anonymous callers', async () => {
    const kernel = await kernelWith(freshState(), []);
    const response = await kernel.fetch(new Request(`${BASE}/_pb/open`));
    expect(response.status).toBe(200);
  });

  async function ssoResponse(fresh: boolean, bound: boolean, path = '/_pb/whoami') {
    const state = freshState();
    state.sessionIdentity = { id: 'identity-1', provider: 'oidc', fresh: fresh && bound };
    if (!fresh || !bound) state.sessionOrg = [];
    const calls: unknown[] = [];
    const kernel = await kernelWith(state, calls, {
      providerAnchors: () =>
        Promise.resolve(
          bound ? [{ provider: 'oidc', anchor: 'anchor-1', emailAuthoritative: true }] : [],
        ),
    });
    const response = await kernel.fetch(new Request(`${BASE}${path}`, { headers: cookie }));
    return { status: response.status, body: strip((await response.json()) as never), calls, state };
  }

  it('refuses a stale SSO identity with the organization permission refusal', async () => {
    const stale = await ssoResponse(false, true);
    const organization = await ssoResponse(false, true, '/_pb/organization');
    expect(stale.status).toBe(403);
    expect(stale.body).toEqual(organization.body);
    expect(stale.status).toBe(organization.status);
    expect(stale.calls).toEqual([]);
    expect(stale.state.touches).toEqual([]);
  });

  it('refuses an SSO identity with a missing provider binding', async () => {
    const unbound = await ssoResponse(true, false);
    expect(unbound.status).toBe(403);
    expect(unbound.calls).toEqual([]);
    expect(unbound.state.touches).toEqual([]);
  });

  it('accepts a fresh SSO identity with a provider binding', async () => {
    const bound = await ssoResponse(true, true);
    expect(bound.status).toBe(200);
    expect(bound.calls).toEqual([{ principal: { kind: 'user', id: 'user-1' }, projectId: null }]);
  });

  it('refuses an SSO identity lookup exception with the organization refusal', async () => {
    const state = freshState();
    state.sessionIdentity = { id: 'identity-1', provider: 'oidc', fresh: true };
    const calls: unknown[] = [];
    const base = deps(state);
    const kernel = await kernelWith(state, calls, {
      access: {
        ...base.access,
        lookupSession: () => Promise.reject(new Error('lookup unavailable')),
      },
    });
    const response = await kernel.fetch(new Request(`${BASE}/_pb/whoami`, { headers: cookie }));
    const organization = await kernel.fetch(
      new Request(`${BASE}/_pb/organization`, { headers: cookie }),
    );
    expect(response.status).toBe(503);
    expect(response.status).toBe(organization.status);
    expect(strip((await response.json()) as never)).toEqual(
      strip((await organization.json()) as never),
    );
    expect(calls).toEqual([]);
    expect(state.touches).toEqual([]);
  });

  it('refuses a provider binding lookup exception', async () => {
    const state = freshState();
    state.sessionIdentity = { id: 'identity-1', provider: 'oidc', fresh: true };
    const calls: unknown[] = [];
    const kernel = await kernelWith(state, calls, {
      providerAnchors: () => Promise.reject(new Error('lookup unavailable')),
    });
    const response = await kernel.fetch(new Request(`${BASE}/_pb/whoami`, { headers: cookie }));
    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
    expect(state.lookups).toBe(0);
    expect(state.touches).toEqual([]);
  });

  it('returns identical stale, unbound and organization refusal bodies', async () => {
    const stale = await ssoResponse(false, true);
    const unbound = await ssoResponse(true, false);
    const organization = await ssoResponse(true, false, '/_pb/organization');
    expect(stale.status).toBe(403);
    expect(unbound.status).toBe(stale.status);
    expect(unbound.body).toEqual(stale.body);
    expect(stale.body).toEqual(organization.body);
  });

  it('keeps the local session authenticated without an identity or permissions', async () => {
    const state = freshState();
    state.sessionOrg = [];
    const calls: unknown[] = [];
    const kernel = await kernelWith(state, calls);
    const response = await kernel.fetch(new Request(`${BASE}/_pb/whoami`, { headers: cookie }));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('keeps bearer token authentication independent of session identity freshness', async () => {
    const state = freshState();
    state.sessionIdentity = { id: 'identity-1', provider: 'oidc', fresh: false };
    state.token.organizationPermissions = [];
    const calls: unknown[] = [];
    const kernel = await kernelWith(state, calls);
    const response = await kernel.fetch(
      new Request(`${BASE}/_pb/whoami`, { headers: bearer(PAT) }),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe('SSO freshness outside the authenticated boundary', () => {
  it('leaves organization and project permission decisions unchanged', async () => {
    const state = freshState();
    state.sessionIdentity = { id: 'identity-1', provider: 'oidc', fresh: false };
    const engine = createAuthorizationEngine(deps(state));
    expect(
      (
        await engine.authorize(
          req({ headers: cookie, boundary: 'organization', permission: 'org:read' }),
        )
      ).allow,
    ).toBe(true);
    expect((await engine.authorize(req({ headers: cookie }))).allow).toBe(true);
  });
});
