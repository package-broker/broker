import { describe, expect, it, vi } from 'vitest';
import { setAccessContext } from '../../authz/access-context.js';
import type { AccessContextSnapshot } from '../../authz/access-context.js';
import { fenceKind } from '../../authz/fence.js';
import { orgContext } from '../../db/port.js';
import type { RequestContext } from '../../plugin.js';
import { auditCall, callContext } from './context.js';
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
