import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import * as pluginEntry from '../plugin.js';
import type { Principal, RequestContext } from '../plugin.js';
import {
  accessContextOf,
  authenticatedActorOf,
  authenticatedTokenActor,
  organizationActorOf,
  projectActorOf,
  setAccessContext,
} from './access-context.js';
import type { AccessContextSnapshot } from './access-context.js';
import { tokenMutationFence } from './fence.js';

const USER: Principal = { kind: 'user', id: 'user-1' };
const SERVICE: Principal = { kind: 'service', id: 'svc-1' };

function requestContext(
  principal: Principal | null = USER,
  projectId: string | null = 'project-1',
): RequestContext {
  return Object.freeze({
    request: new Request('https://broker.test/acme/packages.json'),
    requestId: 'req-1',
    org: orgContext('org-a'),
    principal: principal === null ? null : Object.freeze({ ...principal }),
    projectId,
    params: Object.freeze({}),
    ports: Object.freeze({
      organizations: { get: async () => null },
      clock: { now: () => new Date(0) },
      ids: { ulid: () => 'id' },
    }),
  }) as unknown as RequestContext;
}

const actor = (overrides: Record<string, unknown> = {}) => ({
  session: { id: 'session-1', userId: 'user-1' },
  user: { id: 'user-1' },
  organizationPermissions: ['org:read'],
  projectPermissions: ['project:read'],
  protectedHolder: false,
  ...overrides,
});

const userKey = (routeClass = 'project', tokenSelector: string | null = null) => ({
  stage: 'authenticated',
  tokenSelector,
  principalId: 'user-1',
  routeClass,
});

function snapshot(overrides: Partial<Record<keyof AccessContextSnapshot, unknown>> = {}) {
  return {
    principal: { ...USER },
    projectId: 'project-1',
    boundary: 'project',
    sessionId: 'session-1',
    token: null,
    actor: actor(),
    rateKey: userKey(),
    ...overrides,
  } as unknown as AccessContextSnapshot;
}

const serviceSnapshot = (overrides: Partial<Record<keyof AccessContextSnapshot, unknown>> = {}) =>
  snapshot({
    principal: { ...SERVICE },
    sessionId: null,
    token: { kind: 'svc', scope: 'write', readOnly: false },
    actor: null,
    rateKey: {
      stage: 'authenticated',
      tokenSelector: 'abcdefghijkl',
      principalId: 'svc-1',
      routeClass: 'project',
    },
    ...overrides,
  });

const organizationSnapshot = (
  overrides: Partial<Record<keyof AccessContextSnapshot, unknown>> = {},
) =>
  snapshot({
    boundary: 'organization',
    projectId: null,
    rateKey: userKey('organization'),
    ...overrides,
  });

const patSnapshot = (token: Record<string, unknown>) =>
  organizationSnapshot({
    sessionId: null,
    actor: null,
    token: { kind: 'pat', scope: 'full', readOnly: false, ...token },
    rateKey: userKey('organization', 'abcdefghijkl'),
  });

const PROJECT_A = '01JA0000000000000000000001';
const PROJECT_B = '01JA0000000000000000000002';

describe('access context token project binding', () => {
  it('stores the selected binding frozen', () => {
    const ctx = requestContext(USER, null);
    setAccessContext(
      ctx,
      patSnapshot({
        projectMode: 'selected',
        projectIds: [PROJECT_A, PROJECT_B],
        organizationAdmin: false,
        projectReadInherited: true,
      }),
    );
    const token = accessContextOf(ctx)!.token!;
    expect(token.projectMode).toBe('selected');
    expect(token.projectIds).toEqual([PROJECT_A, PROJECT_B]);
    expect(token.projectReadInherited).toBe(true);
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.isFrozen(token.projectIds)).toBe(true);
  });

  it('stores an all-mode binding with no project ids', () => {
    const ctx = requestContext(USER, null);
    setAccessContext(
      ctx,
      patSnapshot({ projectMode: 'all', projectIds: [], organizationAdmin: true }),
    );
    expect(accessContextOf(ctx)!.token).toMatchObject({
      projectMode: 'all',
      projectIds: [],
      organizationAdmin: true,
    });
  });

  it('keeps a token snapshot without a binding free of binding fields', () => {
    const ctx = requestContext(USER, null);
    setAccessContext(ctx, patSnapshot({}));
    const token = accessContextOf(ctx)!.token!;
    expect(token.projectMode).toBeUndefined();
    expect(token.projectIds).toBeUndefined();
  });

  it('keeps an explicit null mode', () => {
    const ctx = requestContext(USER, null);
    setAccessContext(ctx, patSnapshot({ projectMode: null, projectIds: [] }));
    expect(accessContextOf(ctx)!.token).toMatchObject({ projectMode: null, projectIds: [] });
  });

  it.each([
    ['an unknown mode', { projectMode: 'some', projectIds: [] }],
    ['ids on an all-mode token', { projectMode: 'all', projectIds: [PROJECT_A] }],
    ['ids on an unbound token', { projectMode: null, projectIds: [PROJECT_A] }],
    ['an empty id', { projectMode: 'selected', projectIds: [''] }],
    ['a non-string id', { projectMode: 'selected', projectIds: [7] }],
    ['non-array ids', { projectMode: 'selected', projectIds: PROJECT_A }],
    ['a duplicate id', { projectMode: 'selected', projectIds: [PROJECT_A, PROJECT_A] }],
    ['a non-boolean admin flag', { projectMode: 'all', projectIds: [], organizationAdmin: 1 }],
    [
      'a non-boolean inheritance flag',
      { projectMode: 'all', projectIds: [], projectReadInherited: 'yes' },
    ],
  ])('refuses %s', (_name, token) => {
    const ctx = requestContext(USER, null);
    expect(() => setAccessContext(ctx, patSnapshot(token))).toThrow(TypeError);
    expect(accessContextOf(ctx)).toBeNull();
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('access context', () => {
  it('refuses a session id alongside token metadata', () => {
    const ctx = requestContext();
    expect(() =>
      setAccessContext(ctx, snapshot({ token: { kind: 'pat', scope: 'read', readOnly: true } })),
    ).toThrow(TypeError);
    expect(accessContextOf(ctx)).toBeNull();
  });

  it('refuses an unknown token kind', () => {
    const ctx = requestContext(SERVICE);
    expect(() =>
      setAccessContext(
        ctx,
        serviceSnapshot({ token: { kind: 'cst', scope: 'read', readOnly: true } }),
      ),
    ).toThrow(TypeError);
    expect(accessContextOf(ctx)).toBeNull();
  });

  it('refuses a token selector without token metadata', () => {
    const ctx = requestContext(SERVICE);
    expect(() => setAccessContext(ctx, serviceSnapshot({ token: null }))).toThrow(TypeError);
    expect(accessContextOf(ctx)).toBeNull();
  });

  it('refuses an unknown token scope', () => {
    const ctx = requestContext(SERVICE);
    expect(() =>
      setAccessContext(
        ctx,
        serviceSnapshot({ token: { kind: 'svc', scope: 'admin', readOnly: false } }),
      ),
    ).toThrow(TypeError);
    expect(accessContextOf(ctx)).toBeNull();
  });

  it('refuses a non-boolean token read-only flag', () => {
    const ctx = requestContext(SERVICE);
    expect(() =>
      setAccessContext(
        ctx,
        serviceSnapshot({ token: { kind: 'svc', scope: 'write', readOnly: 0 } }),
      ),
    ).toThrow(TypeError);
    expect(accessContextOf(ctx)).toBeNull();
  });

  it.each(['read', 'write', 'full', null] as const)(
    'copies and freezes token scope %s',
    (scope) => {
      const ctx = requestContext(SERVICE);
      const token = { kind: 'svc', scope, readOnly: scope === 'read' };
      setAccessContext(ctx, serviceSnapshot({ token }));
      token.readOnly = !token.readOnly;
      const stored = accessContextOf(ctx)!.token;
      expect(stored).toEqual({ kind: 'svc', scope, readOnly: scope === 'read' });
      expect(stored).not.toBe(token);
      expect(Object.isFrozen(stored)).toBe(true);
      expect(() => {
        (stored as { readOnly: boolean }).readOnly = !stored!.readOnly;
      }).toThrow(TypeError);
    },
  );

  it('keeps each snapshot with its own context across interleaved awaits', async () => {
    const a = requestContext();
    const b = requestContext(SERVICE);
    const first = (async () => {
      await tick();
      setAccessContext(a, snapshot());
      await tick();
      await tick();
      return accessContextOf(a);
    })();
    const second = (async () => {
      expect(accessContextOf(b)).toBeNull();
      await tick();
      await tick();
      expect(accessContextOf(a)?.principal?.id).toBe('user-1');
      setAccessContext(b, serviceSnapshot());
      await tick();
      return accessContextOf(b);
    })();
    const [fromA, fromB] = await Promise.all([first, second]);
    expect(fromA?.principal).toEqual(USER);
    expect(fromB?.principal).toEqual(SERVICE);
    expect(fromB?.rateKey).toMatchObject({ tokenSelector: 'abcdefghijkl', principalId: 'svc-1' });
  });

  it('is keyed by the context, not by its Request', () => {
    const ctx = requestContext();
    setAccessContext(ctx, snapshot());
    const sameRequest = Object.freeze({ ...ctx }) as RequestContext;
    expect(sameRequest.request).toBe(ctx.request);
    expect(accessContextOf(sameRequest)).toBeNull();
  });

  it('returns null for a context that never had a snapshot', () => {
    expect(accessContextOf(requestContext())).toBeNull();
  });

  it('stores a deep-frozen copy the caller cannot mutate afterwards', () => {
    const ctx = requestContext();
    const input = snapshot();
    setAccessContext(ctx, input);
    (input.actor!.organizationPermissions as string[]).push('org:admin');
    (input.rateKey as { principalId: string }).principalId = 'user-2';
    const stored = accessContextOf(ctx)!;
    expect(stored).not.toBe(input);
    expect(stored.actor?.organizationPermissions).toEqual(['org:read']);
    expect(stored.rateKey).toMatchObject({ principalId: 'user-1' });
    for (const part of [
      stored,
      stored.principal,
      stored.rateKey,
      stored.actor,
      stored.actor?.session,
      stored.actor?.user,
      stored.actor?.organizationPermissions,
      stored.actor?.projectPermissions,
    ]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
    expect(() => {
      (stored as { projectId: string | null }).projectId = 'project-2';
    }).toThrow(TypeError);
  });

  it('refuses a second snapshot for the same context', () => {
    const ctx = requestContext();
    setAccessContext(ctx, snapshot());
    expect(() => setAccessContext(ctx, snapshot({ sessionId: 'session-1' }))).toThrow(TypeError);
    expect(accessContextOf(ctx)?.principal?.id).toBe('user-1');
  });

  it('stores the session owner only when it was supplied', () => {
    const withOwner = requestContext();
    setAccessContext(withOwner, snapshot());
    expect(accessContextOf(withOwner)?.actor?.session).toEqual({
      id: 'session-1',
      userId: 'user-1',
    });
    const withoutOwner = requestContext();
    setAccessContext(withoutOwner, snapshot({ actor: actor({ session: { id: 'session-1' } }) }));
    const session = accessContextOf(withoutOwner)?.actor?.session;
    expect(session).toEqual({ id: 'session-1' });
    expect(Object.hasOwn(session ?? {}, 'userId')).toBe(false);
  });

  it.each<[string, () => RequestContext, () => unknown]>([
    ['a non-object snapshot', () => requestContext(), () => null],
    [
      'the reserved package boundary',
      () => requestContext(),
      () => snapshot({ boundary: 'package' }),
    ],
    ['an unknown boundary', () => requestContext(), () => snapshot({ boundary: 'admin' })],
    [
      'a principal of unknown kind',
      () => requestContext(),
      () => snapshot({ principal: { kind: 'root', id: 'user-1' } }),
    ],
    [
      'an empty principal id',
      () => requestContext(),
      () => snapshot({ principal: { kind: 'user', id: '' } }),
    ],
    [
      'a principal kind other than the context',
      () => requestContext({ kind: 'service', id: 'user-1' }),
      () => snapshot(),
    ],
    [
      'a principal id other than the context',
      () => requestContext({ kind: 'user', id: 'user-2' }),
      () => snapshot(),
    ],
    [
      'no principal while the context has one',
      () => requestContext(),
      () =>
        snapshot({
          principal: null,
          rateKey: { stage: 'anonymous', ip: null, routeClass: 'project' },
        }),
    ],
    ['a principal while the context has none', () => requestContext(null), () => snapshot()],
    ['a project other than the context', () => requestContext(USER, 'project-2'), () => snapshot()],
    [
      'a project boundary without a project',
      () => requestContext(USER, null),
      () => snapshot({ projectId: null }),
    ],
    [
      'an organization boundary with a project',
      () => requestContext(),
      () => organizationSnapshot({ projectId: 'project-1' }),
    ],
    [
      'a self boundary with a project',
      () => requestContext(),
      () => snapshot({ boundary: 'self', rateKey: userKey('self') }),
    ],
    [
      'a self boundary without a principal',
      () => requestContext(null, null),
      () =>
        snapshot({
          principal: null,
          projectId: null,
          boundary: 'self',
          sessionId: null,
          actor: null,
          rateKey: { stage: 'anonymous', ip: null, routeClass: 'self' },
        }),
    ],
    [
      'an organization boundary without a principal',
      () => requestContext(null, null),
      () =>
        organizationSnapshot({
          principal: null,
          sessionId: null,
          actor: null,
          rateKey: { stage: 'anonymous', ip: null, routeClass: 'organization' },
        }),
    ],
    [
      'a public boundary carrying an actor',
      () => requestContext(USER, null),
      () => snapshot({ boundary: 'none', projectId: null, rateKey: userKey('none') }),
    ],
    [
      'a public boundary carrying a session',
      () => requestContext(USER, null),
      () => snapshot({ boundary: 'none', projectId: null, actor: null, rateKey: userKey('none') }),
    ],
    [
      'a session id other than the actor session',
      () => requestContext(),
      () => snapshot({ sessionId: 'session-2' }),
    ],
    ['an actor without a session id', () => requestContext(), () => snapshot({ sessionId: null })],
    [
      'a service principal with a session',
      () => requestContext(SERVICE),
      () => serviceSnapshot({ sessionId: 'session-1' }),
    ],
    [
      'a service principal with an actor',
      () => requestContext(SERVICE),
      () => serviceSnapshot({ actor: actor({ user: { id: 'svc-1' }, session: { id: 's' } }) }),
    ],
    [
      'a service principal without a token selector',
      () => requestContext(SERVICE),
      () =>
        serviceSnapshot({
          rateKey: {
            stage: 'authenticated',
            tokenSelector: null,
            principalId: 'svc-1',
            routeClass: 'project',
          },
        }),
    ],
    [
      'unauthenticated with an authenticated rate key',
      () => requestContext(null, null),
      () =>
        snapshot({
          principal: null,
          projectId: null,
          boundary: 'none',
          sessionId: null,
          actor: null,
          rateKey: userKey('none'),
        }),
    ],
    [
      'authenticated with an anonymous rate key',
      () => requestContext(),
      () => snapshot({ rateKey: { stage: 'anonymous', ip: '203.0.113.7', routeClass: 'project' } }),
    ],
    [
      'a rate key naming another principal',
      () => requestContext(),
      () => snapshot({ rateKey: { ...userKey(), principalId: 'user-2' } }),
    ],
    [
      'a route class that differs from the boundary',
      () => requestContext(),
      () => snapshot({ rateKey: userKey('organization') }),
    ],
    [
      'an empty token selector',
      () => requestContext(),
      () => snapshot({ rateKey: userKey('project', '') }),
    ],
    [
      'a non-string permission',
      () => requestContext(),
      () => snapshot({ actor: actor({ projectPermissions: [1] }) }),
    ],
    [
      'an actor for another user',
      () => requestContext(),
      () => snapshot({ actor: actor({ user: { id: 'user-2' }, session: { id: 'session-1' } }) }),
    ],
    [
      'a session owned by another user',
      () => requestContext(),
      () => snapshot({ actor: actor({ session: { id: 'session-1', userId: 'user-2' } }) }),
    ],
    [
      'a session owner that is undefined',
      () => requestContext(),
      () => snapshot({ actor: actor({ session: { id: 'session-1', userId: undefined } }) }),
    ],
    [
      'a non-boolean protected holder',
      () => requestContext(),
      () => snapshot({ actor: actor({ protectedHolder: 'true' }) }),
    ],
  ])('rejects %s and stores nothing', (_name, context, value) => {
    const ctx = context();
    expect(() => setAccessContext(ctx, value() as AccessContextSnapshot)).toThrow(TypeError);
    expect(accessContextOf(ctx)).toBeNull();
  });

  it('accepts an anonymous snapshot keyed by IP before authentication', () => {
    const ctx = requestContext(null, null);
    setAccessContext(
      ctx,
      snapshot({
        principal: null,
        projectId: null,
        boundary: 'none',
        sessionId: null,
        actor: null,
        rateKey: { stage: 'anonymous', ip: '203.0.113.7', routeClass: 'none' },
      }),
    );
    expect(accessContextOf(ctx)?.rateKey).toEqual({
      stage: 'anonymous',
      ip: '203.0.113.7',
      routeClass: 'none',
    });
  });

  it('accepts a self route and a personal token without a session', () => {
    const self = requestContext(USER, null);
    setAccessContext(
      self,
      snapshot({ boundary: 'self', projectId: null, rateKey: userKey('self') }),
    );
    expect(accessContextOf(self)?.boundary).toBe('self');
    const pat = requestContext();
    setAccessContext(
      pat,
      snapshot({
        sessionId: null,
        actor: null,
        token: { kind: 'pat', scope: 'read', readOnly: true },
        rateKey: userKey('project', 'abcdefghijkl'),
      }),
    );
    expect(accessContextOf(pat)?.rateKey).toMatchObject({ tokenSelector: 'abcdefghijkl' });
  });

  it('builds a frozen organization actor with a read-only permission view', () => {
    const org = requestContext(USER, null);
    setAccessContext(org, organizationSnapshot());
    const built = organizationActorOf(org)!;
    expect(built).toMatchObject({ kind: 'organization', userId: 'user-1', sessionId: 'session-1' });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.permissions)).toBe(true);
    expect(built.permissions.has('org:read')).toBe(true);
    expect(built.permissions.size).toBe(1);
    expect([...built.permissions]).toEqual(['org:read']);
    const seen: string[] = [];
    built.permissions.forEach((value) => seen.push(value));
    expect(seen).toEqual(['org:read']);
    expect(built.permissions).not.toBeInstanceOf(Set);
    expect('add' in built.permissions).toBe(false);
    expect(() => {
      (built.permissions as unknown as { has: unknown }).has = () => true;
    }).toThrow(TypeError);
    expect(organizationActorOf(org)?.permissions).not.toBe(built.permissions);
  });

  it('builds no organization actor off the organization boundary or without a snapshot', () => {
    const project = requestContext();
    setAccessContext(project, snapshot());
    expect(organizationActorOf(project)).toBeNull();
    expect(organizationActorOf(requestContext())).toBeNull();
  });

  it('lets the snapshot be collected with its context when the engine collects', async (test) => {
    const collected: string[] = [];
    const registry = new FinalizationRegistry<string>((held) => collected.push(held));
    (() => {
      const ctx = requestContext();
      setAccessContext(ctx, snapshot());
      registry.register(accessContextOf(ctx)!, 'snapshot');
    })();
    const gc = (globalThis as { gc?: () => void }).gc;
    for (let i = 0; i < 50 && collected.length === 0; i++) {
      gc?.();
      await tick();
    }
    if (collected.length === 0) test.skip();
    expect(collected).toEqual(['snapshot']);
  });
});

describe('access context isolation (source probe)', () => {
  const source = readFileSync(new URL('./access-context.ts', import.meta.url), 'utf8');
  const pluginSource = readFileSync(new URL('../plugin.ts', import.meta.url), 'utf8');

  it('holds no module-level current actor and no strong map', () => {
    expect(source).not.toMatch(/^(export )?let\s/m);
    expect(source).not.toMatch(/new Map\b|globalThis/);
    expect(source.match(/new WeakMap</g)).toHaveLength(1);
    expect(source.match(/new Set\b/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/const values = new Set\(source\)/);
  });

  it('carries the PB-94 key fields and no limiter', () => {
    for (const field of ['tokenSelector', 'principalId', 'routeClass', 'ip']) {
      expect(source).toContain(`readonly ${field}:`);
    }
    expect(source).not.toMatch(/limit(er)?\b|bucket|throttle|quota/i);
  });

  it('keeps the plugin RequestContext free of access snapshots and writable repositories', () => {
    const block = (name: string) => {
      const start = pluginSource.indexOf(`export interface ${name} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      return pluginSource.slice(start, pluginSource.indexOf('\n}', start));
    };
    for (const body of [block('RequestContext'), block('PluginPorts')]) {
      expect(body).not.toMatch(/access|snapshot|actor|repositor|writer|grant|token/i);
    }
    const exported = Object.keys(pluginEntry);
    for (const name of ['setAccessContext', 'accessContextOf', 'organizationActorOf']) {
      expect(exported).not.toContain(name);
    }
  });

  it('adds nothing to the plugin-visible context object', () => {
    const ctx = requestContext();
    const before = Reflect.ownKeys(ctx);
    setAccessContext(ctx, snapshot());
    expect(Reflect.ownKeys(ctx)).toEqual(before);
  });
});

describe('authenticated actor', () => {
  it('mints a frozen actor from a stored session snapshot', () => {
    const ctx = requestContext();
    setAccessContext(ctx, snapshot());
    const built = authenticatedActorOf(ctx);
    expect(built).toEqual({ userId: 'user-1', sessionId: 'session-1' });
    expect(Object.isFrozen(built)).toBe(true);
  });

  it('returns null without a stored snapshot', () => {
    expect(authenticatedActorOf(requestContext())).toBeNull();
  });

  it.each(['pat', 'service', 'public', 'missing actor', 'missing session'] as const)(
    'returns null for %s',
    (kind) => {
      const ctx =
        kind === 'service'
          ? requestContext(SERVICE)
          : kind === 'public'
            ? requestContext(null, null)
            : requestContext();
      const value =
        kind === 'service'
          ? serviceSnapshot()
          : kind === 'public'
            ? snapshot({
                principal: null,
                projectId: null,
                boundary: 'none',
                sessionId: null,
                actor: null,
                rateKey: { stage: 'anonymous', ip: null, routeClass: 'none' },
              })
            : snapshot({ actor: null, sessionId: kind === 'missing actor' ? 'session-1' : null });
      setAccessContext(ctx, value);
      expect(authenticatedActorOf(ctx)).toBeNull();
    },
  );
});

describe('authenticated token actor', () => {
  it('mints a frozen actor carrying token id, kind and principal', () => {
    const ctx = requestContext(SERVICE);
    setAccessContext(
      ctx,
      serviceSnapshot({ token: { id: 'tok-1', kind: 'svc', scope: 'write', readOnly: false } }),
    );
    const built = authenticatedTokenActor(ctx);
    expect(built).toEqual({ tokenId: 'tok-1', tokenKind: 'svc', principalId: 'svc-1' });
    expect(Object.isFrozen(built)).toBe(true);
  });

  it('mints a user PAT actor with the owner as principal', () => {
    const ctx = requestContext();
    setAccessContext(
      ctx,
      snapshot({
        sessionId: null,
        actor: null,
        token: { id: 'tok-2', kind: 'pat', scope: 'full', readOnly: false },
        rateKey: userKey('project', 'abcdefghijkl'),
      }),
    );
    expect(authenticatedTokenActor(ctx)).toEqual({
      tokenId: 'tok-2',
      tokenKind: 'pat',
      principalId: 'user-1',
    });
  });

  it('returns undefined for a session request', () => {
    const ctx = requestContext();
    setAccessContext(ctx, snapshot());
    expect(authenticatedTokenActor(ctx)).toBeUndefined();
  });

  it('returns undefined without a stored snapshot', () => {
    expect(authenticatedTokenActor(requestContext())).toBeUndefined();
  });

  it('returns undefined for a token snapshot carrying no token id', () => {
    const ctx = requestContext(SERVICE);
    setAccessContext(ctx, serviceSnapshot());
    expect(authenticatedTokenActor(ctx)).toBeUndefined();
  });

  it('refuses an empty token id', () => {
    const ctx = requestContext(SERVICE);
    expect(() =>
      setAccessContext(
        ctx,
        serviceSnapshot({ token: { id: '', kind: 'svc', scope: 'write', readOnly: false } }),
      ),
    ).toThrow(TypeError);
    expect(accessContextOf(ctx)).toBeNull();
  });

  it('feeds tokenMutationFence for a token request', () => {
    const ctx = requestContext(SERVICE);
    setAccessContext(
      ctx,
      serviceSnapshot({ token: { id: 'tok-1', kind: 'svc', scope: 'write', readOnly: false } }),
    );
    const fence = tokenMutationFence(authenticatedTokenActor(ctx)!, 'org:import:write', {});
    expect(fence).toMatchObject({
      tokenId: 'tok-1',
      tokenKind: 'svc',
      principalId: 'svc-1',
      permission: 'org:import:write',
    });
  });
});

describe('project actor', () => {
  it('builds a frozen project actor over the union of project rows and project names of organization rows', () => {
    const ctx = requestContext();
    setAccessContext(
      ctx,
      snapshot({
        actor: actor({
          organizationPermissions: ['org:read', 'project:grants:write'],
          projectPermissions: ['project:read'],
        }),
      }),
    );
    const built = projectActorOf(ctx)!;
    expect(built).toMatchObject({
      kind: 'project',
      userId: 'user-1',
      orgId: 'org-a',
      projectId: 'project-1',
    });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.permissions)).toBe(true);
    expect([...built.permissions].sort()).toEqual(['project:grants:write', 'project:read']);
    expect(built.permissions.has('org:read')).toBe(false);
    expect(built.permissions).not.toBeInstanceOf(Set);
    expect('add' in built.permissions).toBe(false);
    expect(projectActorOf(ctx)?.permissions).not.toBe(built.permissions);
  });

  it('takes the user from the session snapshot, not from a second source', () => {
    const ctx = requestContext({ kind: 'user', id: 'user-2' });
    setAccessContext(
      ctx,
      snapshot({
        principal: { kind: 'user', id: 'user-2' },
        actor: actor({ user: { id: 'user-2' }, session: { id: 'session-1', userId: 'user-2' } }),
        rateKey: { ...userKey(), principalId: 'user-2' },
      }),
    );
    expect(projectActorOf(ctx)?.userId).toBe('user-2');
  });

  it('builds nothing off the project boundary, for tokens, or without a snapshot', () => {
    const org = requestContext(USER, null);
    setAccessContext(org, organizationSnapshot());
    expect(projectActorOf(org)).toBeNull();
    const service = requestContext(SERVICE);
    setAccessContext(service, serviceSnapshot());
    expect(projectActorOf(service)).toBeNull();
    expect(projectActorOf(requestContext())).toBeNull();
  });

  it('builds nothing without an organization on the context', () => {
    const base = requestContext();
    const ctx = Object.freeze({ ...base, org: null }) as unknown as RequestContext;
    setAccessContext(ctx, snapshot());
    expect(projectActorOf(ctx)).toBeNull();
  });
});
