import { describe, expect, it, vi } from 'vitest';
import { setAccessContext } from '../../authz/access-context.js';
import type { AccessContextSnapshot } from '../../authz/access-context.js';
import { fenceKind } from '../../authz/fence.js';
import { orgContext } from '../../db/port.js';
import type { RequestContext } from '../../plugin.js';
import { auditCall, callContext, hasOrganizationAdminAuthority } from './context.js';
import type { ApiRouteDeps } from './context.js';

function dependencies() {
  let sequence = 0;
  return {
    ids: { ulid: vi.fn(() => `operation-${++sequence}`) },
    clock: { now: () => new Date(0) },
    clientIp: vi.fn<(request: Request) => string | null>(() => '203.0.113.7'),
  } satisfies ApiRouteDeps;
}

function context(
  overrides: Partial<RequestContext> = {},
  snapshot: Partial<AccessContextSnapshot> | null = {},
): RequestContext {
  const ctx: RequestContext = {
    request: new Request('https://broker.test/_pb/example'),
    requestId: 'request-1',
    org: orgContext('org-1'),
    principal: { kind: 'user', id: 'user-1' },
    projectId: null,
    params: {},
    ports: {
      organizations: { get: async () => null },
      clock: { now: () => new Date(0) },
      ids: { ulid: () => 'unused' },
    },
    ...overrides,
  };
  if (snapshot !== null) {
    setAccessContext(ctx, {
      principal: ctx.principal,
      projectId: null,
      boundary: 'organization',
      sessionId: 'session-1',
      token: null,
      actor: {
        session: { id: 'session-1', userId: 'user-1' },
        user: { id: 'user-1' },
        organizationPermissions: ['org:read'],
        projectPermissions: [],
        protectedHolder: false,
      },
      rateKey: {
        stage: 'authenticated',
        tokenSelector: null,
        principalId: 'user-1',
        routeClass: 'organization',
      },
      ...snapshot,
    });
  }
  return ctx;
}

const tokenSnapshot = {
  sessionId: null,
  actor: null,
  token: { kind: 'pat', scope: 'write', readOnly: false },
  rateKey: {
    stage: 'authenticated',
    tokenSelector: 'abcdefghijkl',
    principalId: 'user-1',
    routeClass: 'organization',
  },
} as const satisfies Partial<AccessContextSnapshot>;

describe('callContext', () => {
  it('returns the organization, actor, session fence and audit call', () => {
    const ctx = context();
    const deps = dependencies();
    const expected = { 'role-1': 3 };
    const result = callContext(ctx, deps, expected);
    expect(result.org).toBe(ctx.org);
    expect(result.actor).toMatchObject({
      kind: 'organization',
      userId: 'user-1',
      sessionId: 'session-1',
    });
    expect([...result.actor.permissions]).toEqual(['org:read']);
    expect(fenceKind(result.fence)).toBe('session');
    expect(result.fence).toEqual({ userId: 'user-1', sessionId: 'session-1', expected });
    expect(result.call).toEqual({
      audit: {
        opId: 'operation-1',
        requestId: ctx.requestId,
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
    });
    expect(deps.ids.ulid).toHaveBeenCalledTimes(1);
    expect(deps.clientIp).toHaveBeenCalledExactlyOnceWith(ctx.request);
  });

  it('defaults expected revisions to empty and allocates a fresh operation id each time', () => {
    const ctx = context();
    const deps = dependencies();
    const first = callContext(ctx, deps);
    const second = callContext(ctx, deps);
    expect(first.fence.expected).toEqual({});
    expect(first.call.audit.opId).not.toBe(second.call.audit.opId);
    expect(deps.ids.ulid).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no access snapshot', () => context({}, null)],
    ...(['self', 'authenticated', 'project'] as const).map(
      (boundary) =>
        [
          `${boundary} boundary`,
          () =>
            context(
              { projectId: boundary === 'project' ? 'project-1' : null },
              {
                boundary,
                projectId: boundary === 'project' ? 'project-1' : null,
                rateKey: {
                  stage: 'authenticated',
                  tokenSelector: null,
                  principalId: 'user-1',
                  routeClass: boundary,
                },
              },
            ),
        ] as const,
    ),
    ['token credential', () => context({}, tokenSnapshot)],
    ['no organization', () => context({ org: null })],
  ] as const)('rejects %s before calling dependencies', (_name, makeContext) => {
    const deps = dependencies();
    const ctx = makeContext();
    expect(() => callContext(ctx, deps)).toThrow(TypeError);
    expect(() => callContext(ctx, deps)).toThrow('route requires an organization session context');
    expect(deps.ids.ulid).not.toHaveBeenCalled();
    expect(deps.clientIp).not.toHaveBeenCalled();
  });
});

describe('auditCall', () => {
  it.each([
    ['1.2', null],
    ['abc', null],
    ['::::', null],
    ['999.1.1.1', null],
    ['a'.repeat(8192), null],
    ['', null],
    [null, null],
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8::1', '2001:db8::1'],
    ['::1', '::1'],
    ['2001:0DB8:0:0::1', '2001:0DB8:0:0::1'],
    ['::ffff:192.0.2.7', '::ffff:192.0.2.7'],
    ['fe80::1%eth0', null],
    ['[::1]', null],
    ['192.0.2.1:80', null],
  ])('keeps only IP literals from the resolver for case %#', (value, expected) => {
    const deps = dependencies();
    deps.clientIp.mockReturnValue(value);
    expect(auditCall(context(), deps).audit.sourceIp).toBe(expected);
  });

  it('carries the authenticated token selector without idempotency', () => {
    const result = auditCall(context({}, tokenSnapshot), dependencies());
    expect(result.audit.tokenSelector).toBe('abcdefghijkl');
    expect(result).not.toHaveProperty('idempotency');
  });

  it('uses null for an anonymous snapshot and preserves a null client address', () => {
    const ctx = context(
      { principal: null, org: null },
      {
        boundary: 'none',
        sessionId: null,
        actor: null,
        rateKey: { stage: 'anonymous', ip: '203.0.113.8', routeClass: 'none' },
      },
    );
    const deps = dependencies();
    deps.clientIp.mockReturnValue(null);
    expect(auditCall(ctx, deps)).toEqual({
      audit: {
        opId: 'operation-1',
        requestId: ctx.requestId,
        sourceIp: null,
        tokenSelector: null,
      },
    });
  });

  it('rejects a missing access snapshot before calling dependencies', () => {
    const deps = dependencies();
    expect(() => auditCall(context({}, null), deps)).toThrow(TypeError);
    expect(deps.ids.ulid).not.toHaveBeenCalled();
    expect(deps.clientIp).not.toHaveBeenCalled();
  });
});

import { projectSessionCallContext } from './context.js';

function projectContext() {
  return context(
    { projectId: 'project-1' },
    {
      boundary: 'project',
      projectId: 'project-1',
      actor: {
        session: { id: 'session-1', userId: 'user-1' },
        user: { id: 'user-1' },
        organizationPermissions: ['org:read', 'org:service-principals:write'],
        projectPermissions: ['project:service-principals:write'],
        protectedHolder: true,
      },
      rateKey: {
        stage: 'authenticated',
        tokenSelector: null,
        principalId: 'user-1',
        routeClass: 'project',
      },
    },
  );
}

describe('hasOrganizationAdminAuthority', () => {
  it('fails closed without an organization or access snapshot and on a project boundary', () => {
    expect(hasOrganizationAdminAuthority(context({}, null))).toBe(false);
    expect(hasOrganizationAdminAuthority(context({ org: null }))).toBe(false);
    expect(hasOrganizationAdminAuthority(projectContext())).toBe(false);
    expect(
      hasOrganizationAdminAuthority(
        context(
          {},
          {
            ...tokenSnapshot,
            token: { kind: 'pat', scope: 'full', readOnly: false, projectMode: 'all' },
          },
        ),
      ),
    ).toBe(false);
  });

  it.each([
    { scope: 'read' },
    { scope: 'write' },
    { readOnly: true },
    { projectMode: 'selected', projectIds: ['project-1'] },
    { organizationAdmin: false },
  ] as const)('withholds authority from a restricted token: %j', (restriction) => {
    const ctx = context(
      {},
      {
        ...tokenSnapshot,
        token: {
          kind: 'pat',
          scope: 'full',
          readOnly: false,
          projectMode: 'all',
          organizationAdmin: true,
          ...restriction,
        },
      },
    );
    expect(hasOrganizationAdminAuthority(ctx)).toBe(false);
  });
});

describe('projectSessionCallContext', () => {
  it('returns project identity, revision fence and audit context without copying authority', () => {
    const ctx = projectContext();
    const deps = dependencies();
    const expected = { service_principal: 3 };
    const result = projectSessionCallContext(ctx, deps, expected);
    expect(result.org).toBe(ctx.org);
    expect(result.projectId).toBe('project-1');
    expect(result.actor).toEqual({
      kind: 'organization',
      userId: 'user-1',
      sessionId: 'session-1',
      permissions: expect.anything(),
      isOrganizationAdmin: false,
    });
    expect([...result.actor.permissions]).toEqual([]);
    expect(result.actor.permissions.has('org:service-principals:write')).toBe(false);
    expect(Object.isFrozen(result.actor)).toBe(true);
    expect(Object.isFrozen(result.actor.permissions)).toBe(true);
    expect(result.actor.permissions).not.toHaveProperty('add');
    expect(fenceKind(result.fence)).toBe('session');
    expect(result.fence).toEqual({ userId: 'user-1', sessionId: 'session-1', expected });
    expect(result.call).toEqual({
      audit: {
        opId: 'operation-1',
        requestId: ctx.requestId,
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
    });
    expect(deps.ids.ulid).toHaveBeenCalledTimes(1);
    expect(deps.clientIp).toHaveBeenCalledExactlyOnceWith(ctx.request);
    expect(projectSessionCallContext(ctx, deps).fence.expected).toEqual({});
  });

  it.each([
    ['no snapshot', () => context({}, null)],
    ...(['organization', 'self', 'authenticated'] as const).map(
      (boundary) =>
        [
          boundary,
          () =>
            context(
              {},
              {
                boundary,
                rateKey: {
                  stage: 'authenticated',
                  tokenSelector: null,
                  principalId: 'user-1',
                  routeClass: boundary,
                },
              },
            ),
        ] as const,
    ),
    [
      'token credential',
      () =>
        context(
          { projectId: 'project-1' },
          {
            ...tokenSnapshot,
            boundary: 'project',
            projectId: 'project-1',
            rateKey: { ...tokenSnapshot.rateKey, routeClass: 'project' },
          },
        ),
    ],
    [
      'no organization',
      () => {
        const ctx = projectContext();
        Object.assign(ctx, { org: null });
        return ctx;
      },
    ],
    [
      'different project',
      () => {
        const ctx = projectContext();
        Object.assign(ctx, { projectId: 'other' });
        return ctx;
      },
    ],
    [
      'null project',
      () => {
        const ctx = projectContext();
        Object.assign(ctx, { projectId: null });
        return ctx;
      },
    ],
    [
      'no actor',
      () =>
        context(
          { projectId: 'project-1' },
          {
            boundary: 'project',
            projectId: 'project-1',
            actor: null,
            rateKey: {
              stage: 'authenticated',
              tokenSelector: null,
              principalId: 'user-1',
              routeClass: 'project',
            },
          },
        ),
    ],
  ] as const)('rejects %s before dependencies', (_name, makeContext) => {
    const deps = dependencies();
    expect(() => projectSessionCallContext(makeContext(), deps)).toThrow(
      'route requires a project session context',
    );
    expect(deps.ids.ulid).not.toHaveBeenCalled();
    expect(deps.clientIp).not.toHaveBeenCalled();
  });
});
