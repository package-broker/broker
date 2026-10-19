import type { ServiceTokenService } from './service-token-service.js';
import type { ApiCall } from '../api/idempotency.js';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  REAUTH_WINDOW_MS,
  createSessionService,
  type AuthenticatedSession,
} from '../auth/session.js';
import { orgContext } from '../db/port.js';
import type { Organization } from '../db/organization.js';
import { fixedClock } from '../ids.js';
import { createKeyring } from '../secrets/keyring.js';
import { parseToken } from '../secrets/token-format.js';
import { verifyToken } from '../secrets/token-hash.js';
import type { ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor } from './fence.js';
import {
  createServicePrincipalService,
  type ServicePrincipalRecord,
} from './service-principal-service.js';
import {
  createServiceTokenService,
  type IssueServiceTokenCall,
  type MintedServiceToken,
  type ServiceTokenIssueInput,
  type ServiceTokenIssueOutcome,
  type ServiceTokenServiceDeps,
} from './service-token-service.js';

const ctx = orgContext('org-a');
const NOW = '2026-10-16T12:00:00.000Z';
const DAY = 86_400_000;
const keyring = createKeyring([
  { version: 2, bytes: Uint8Array.from({ length: 32 }, (_, i) => i + 1) },
  { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
]);

const ANCHORS = [{ provider: 'idp', anchor: 'anchor-1', emailAuthoritative: true }];

const ISSUER = [
  'project:read',
  'project:packages:read',
  'project:packages:write',
  'project:tokens:create',
];

function inDays(days: number, extraMs = 0): string {
  return new Date(Date.parse(NOW) + days * DAY + extraMs).toISOString();
}

function session(
  overrides: { userId?: string; kind?: 'user' | 'service' | 'customer'; principalId?: string } = {},
) {
  const userId = overrides.userId ?? 'user-1';
  return {
    session: {
      id: 'session-1',
      userId,
      identityId: null,
      csrfHash: 'x',
      createdAt: NOW,
      expiresAt: inDays(1),
      lastSeenAt: NOW,
      reauthAt: NOW,
      user: { id: userId, email: 'u@example.test', displayName: null },
    },
    principal: { kind: overrides.kind ?? 'user', id: overrides.principalId ?? userId },
  } as unknown as AuthenticatedSession;
}

function fence(userId = 'user-1', sessionId = 'session-1') {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
}

function organization(days = 30, ciDays = 365): Organization {
  return {
    id: ctx.orgId,
    slug: 'a',
    name: 'A',
    settings: {
      retentionRemovedUpstreamDays: 30,
      tokenDefaultExpiryDays: days,
      tokenCiReadonlyExpiryDays: ciDays,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function principal(overrides: Partial<ServicePrincipalRecord> = {}): ServicePrincipalRecord {
  return {
    id: 'sp-1',
    name: 'ci',
    projectId: 'project-1',
    createdByUserId: 'user-9',
    status: 'active',
    revision: 3,
    permissions: ['project:packages:read', 'project:packages:write', 'project:read'],
    ...overrides,
  };
}

interface Rig {
  readonly deps: ServiceTokenServiceDeps;
  readonly calls: IssueServiceTokenCall[];
  readonly logs: Record<string, unknown>[];
  readonly minted: MintedServiceToken[];
  readonly liveCalls: (string | null)[];
}

function rig(
  options: {
    fresh?: boolean;
    outcome?: ServiceTokenIssueOutcome;
    days?: number;
    ciDays?: number;
    organization?: null;
    principal?: ServicePrincipalRecord | null;
    live?: readonly string[];
  } = {},
): Rig {
  const calls: IssueServiceTokenCall[] = [];
  const logs: Record<string, unknown>[] = [];
  const minted: MintedServiceToken[] = [];
  const liveCalls: (string | null)[] = [];
  const deps: ServiceTokenServiceDeps = {
    tokens: {
      async issueService(callCtx, callFence, input, mint) {
        calls.push({ ctx: callCtx, fence: callFence, input, mint });
        const pair = await mint();
        minted.push(pair);
        return options.outcome ?? { status: 'issued', id: input.id, plaintext: pair.plaintext };
      },
    },
    principals: {
      get: async (_ctx, id) =>
        options.principal === null
          ? null
          : id === 'sp-1'
            ? (options.principal ?? principal())
            : null,
    },
    authority: {
      livePermissions: async (_ctx, _fence, projectId) => {
        liveCalls.push(projectId);
        return new Set(options.live ?? ISSUER);
      },
    },
    sessions: { isReauthFresh: () => options.fresh ?? true },
    organizations: {
      get: async () =>
        options.organization === null
          ? null
          : organization(options.days ?? 30, options.ciDays ?? 365),
    },
    providers: { anchors: async () => ANCHORS },
    keyring,
    clock: fixedClock(NOW),
    ids: { ulid: () => 'tok-1' },
    log: (entry) => logs.push({ ...entry }),
  };
  return { deps, calls, logs, minted, liveCalls };
}

const request = (extra: Partial<ServiceTokenIssueInput> = {}): ServiceTokenIssueInput => ({
  servicePrincipalId: 'sp-1',
  routeProjectId: 'project-1',
  name: 'deploy',
  scope: 'read',
  expiresAt: inDays(30),
  ...extra,
});

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: 'organization',
    userId: 'user-1',
    permissions: new Set<string>(),
    isOrganizationAdmin: false,
    ...overrides,
  };
}

async function issue(
  r: Rig,
  input = request(),
  auth = session(),
  held = fence(),
  issuer = actor(),
) {
  return createServiceTokenService(r.deps).issue(ctx, auth, issuer, held, input, apiCall);
}

describe('service token issuance', () => {
  it('issues an svc token bound to the principal and its project, without project bindings', async () => {
    const r = rig();
    const result = await issue(r);
    expect(result.ok).toBe(true);
    expect(r.calls).toHaveLength(1);
    const input = r.calls[0]!.input;
    expect(input.servicePrincipalId).toBe('sp-1');
    expect(input.projectId).toBe('project-1');
    expect(input).not.toHaveProperty('projectIds');
    expect(input).not.toHaveProperty('projectMode');
    expect(input.principalRevision).toBe(3);
    expect(input.scope).toBe('read');
    expect(input.readOnly).toBe(true);
    expect(input.now).toBe(NOW);
    expect(input.authority).toEqual({
      permission: 'project:tokens:create',
      organizationAdmin: false,
      covers: ['project:packages:read', 'project:read'],
    });
    expect(input.providerAnchors).toEqual(ANCHORS);
    expect(r.liveCalls).toEqual(['project-1']);
  });

  it('mints an svc-kind token whose hash verifies and returns it once', async () => {
    const r = rig();
    const result = await issue(r);
    const pair = r.minted[0]!;
    expect(result).toEqual({ ok: true, value: { id: 'tok-1', plaintext: pair.plaintext } });
    expect(parseToken(pair.plaintext)).toMatchObject({
      ok: true,
      kind: 'svc',
      selector: pair.selector,
    });
    expect(pair.pepperVersion).toBe(2);
    expect(await verifyToken(keyring, pair.pepperVersion, pair.plaintext, pair.hash)).toBe(true);
  });

  it('logs the issue without the plaintext, selector or hash', async () => {
    const r = rig();
    await issue(r);
    const serialized = JSON.stringify(r.logs);
    const pair = r.minted[0]!;
    expect(serialized).not.toContain(pair.plaintext);
    expect(serialized).not.toContain(pair.hash);
    expect(serialized).not.toContain(pair.selector);
    expect(r.logs).toContainEqual(
      expect.objectContaining({
        event: 'token.issued',
        kind: 'svc',
        tokenId: 'tok-1',
        servicePrincipalId: 'sp-1',
        projectId: 'project-1',
      }),
    );
  });

  it('carries the principal binding for an organization-wide principal', async () => {
    const r = rig({
      principal: principal({ projectId: null, permissions: ['org:audit:read', 'project:read'] }),
      live: ['org:audit:read', 'org:service-principals:write', 'project:read'],
    });
    const result = await issue(
      r,
      request({ routeProjectId: null, scope: 'full', expiresAt: inDays(30) }),
      session(),
      fence(),
      actor({ isOrganizationAdmin: true }),
    );
    expect(result.ok).toBe(true);
    expect(r.calls[0]!.input.projectId).toBeNull();
    expect(r.calls[0]!.input.authority).toEqual({
      permission: 'org:service-principals:write',
      organizationAdmin: true,
      covers: ['org:audit:read', 'project:read'],
    });
  });

  it('refuses an organization-wide principal to an issuer who is not an organization admin', async () => {
    const r = rig({
      principal: principal({ projectId: null, permissions: ['project:read'] }),
      live: ['org:service-principals:write', 'project:read'],
    });
    const result = await issue(r, request({ routeProjectId: null, scope: 'full' }));
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(r.calls).toHaveLength(0);
  });

  describe('requested authority', () => {
    it('refuses write when the principal stores no packages:write', async () => {
      const r = rig({
        principal: principal({ permissions: ['project:packages:read', 'project:read'] }),
      });
      expect(await issue(r, request({ scope: 'write', expiresAt: inDays(7) }))).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(r.calls).toHaveLength(0);
    });

    it('refuses read when the principal stores no packages:read', async () => {
      const r = rig({ principal: principal({ permissions: ['project:read'] }) });
      expect(await issue(r)).toEqual({ ok: false, error: 'forbidden' });
      expect(r.calls).toHaveLength(0);
    });

    it('refuses write when the issuer no longer holds packages:write', async () => {
      const r = rig({ live: ['project:read', 'project:packages:read', 'project:tokens:create'] });
      expect(await issue(r, request({ scope: 'write', expiresAt: inDays(7) }))).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(r.calls).toHaveLength(0);
    });

    it('refuses full when the issuer lacks one of the principal permissions it would confer', async () => {
      const r = rig({
        principal: principal({
          permissions: ['project:audit:read', 'project:packages:read', 'project:read'],
        }),
      });
      expect(await issue(r, request({ scope: 'full', expiresAt: inDays(7) }))).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(r.calls).toHaveLength(0);
    });

    it('confers only the principal permissions under full, never the issuer surplus', async () => {
      const r = rig({
        principal: principal({ permissions: ['project:packages:read', 'project:read'] }),
        live: [...ISSUER, 'project:audit:read', 'project:settings:write'],
      });
      const result = await issue(r, request({ scope: 'full', expiresAt: inDays(7) }));
      expect(result.ok).toBe(true);
      expect(r.calls[0]!.input.authority.covers).toEqual(['project:packages:read', 'project:read']);
    });

    it('never covers a sessionOnly permission even when the principal row carries one', async () => {
      const r = rig({
        principal: principal({
          permissions: ['project:packages:read', 'project:read', 'project:tokens:create'],
        }),
      });
      const result = await issue(r, request({ scope: 'full', expiresAt: inDays(7) }));
      expect(result.ok).toBe(true);
      expect(r.calls[0]!.input.authority.covers).not.toContain('project:tokens:create');
    });

    it('refuses an issuer without project:tokens:create', async () => {
      const r = rig({ live: ['project:read', 'project:packages:read', 'project:packages:write'] });
      expect(await issue(r)).toEqual({ ok: false, error: 'forbidden' });
      expect(r.calls).toHaveLength(0);
    });

    it('refuses a suspended principal', async () => {
      const r = rig({ principal: principal({ status: 'suspended' }) });
      expect(await issue(r)).toEqual({ ok: false, error: 'forbidden' });
      expect(r.calls).toHaveLength(0);
    });

    it('refuses an unknown principal without revealing it to an issuer without authority', async () => {
      const r = rig({ principal: null, live: [] });
      expect(await issue(r)).toEqual({ ok: false, error: 'forbidden' });
      const managed = rig({ principal: null });
      expect(await issue(managed)).toEqual({ ok: false, error: 'not_found' });
      expect(managed.calls).toHaveLength(0);
    });

    it('surfaces a batch authority loss as forbidden', async () => {
      const r = rig({ outcome: { status: 'refused', reason: 'authority' } });
      expect(await issue(r)).toEqual({ ok: false, error: 'forbidden' });
      expect(r.logs).toContainEqual(expect.objectContaining({ event: 'token.issue_denied' }));
    });

    it('surfaces a principal revision change as conflict', async () => {
      const r = rig({ outcome: { status: 'refused', reason: 'conflict' } });
      expect(await issue(r)).toEqual({ ok: false, error: 'conflict' });
    });
  });

  describe('scope', () => {
    it.each([['admin'], [''], [null], [['read']]])('refuses scope %j', async (scope) => {
      const r = rig();
      expect(await issue(r, request({ scope: scope as never }))).toEqual({
        ok: false,
        error: 'invalid_scope',
      });
    });

    it.each([
      ['write', true],
      ['full', true],
      ['read', false],
    ] as const)('refuses %s with readOnly=%s', async (scope, readOnly) => {
      const r = rig();
      expect(await issue(r, request({ scope, readOnly, expiresAt: inDays(7) }))).toEqual({
        ok: false,
        error: 'scope_conflict',
      });
    });
  });

  describe('expiry', () => {
    it('accepts a read-only CI token up to 365 days', async () => {
      const r = rig({ days: 365 });
      expect((await issue(r, request({ expiresAt: inDays(365) }))).ok).toBe(true);
    });

    it('refuses a read-only CI token one millisecond beyond 365 days', async () => {
      const r = rig({ ciDays: 400 });
      expect(await issue(r, request({ expiresAt: inDays(365, 1) }))).toEqual({
        ok: false,
        error: 'invalid_expiry',
      });
    });

    it('applies a configured CI maximum below 365 days', async () => {
      const r = rig({ ciDays: 30 });
      expect(await issue(r, request({ expiresAt: inDays(30, 1) }))).toEqual({
        ok: false,
        error: 'invalid_expiry',
      });
      expect((await issue(r, request({ expiresAt: inDays(30) }))).ok).toBe(true);
    });

    it.each(['write', 'full'] as const)('caps a %s token at 90 days', async (scope) => {
      const r = rig({ days: 365 });
      expect((await issue(r, request({ scope, expiresAt: inDays(90) }))).ok).toBe(true);
      expect(await issue(r, request({ scope, expiresAt: inDays(90, 1) }))).toEqual({
        ok: false,
        error: 'invalid_expiry',
      });
    });

    it('never grants a non-read-only token the CI maximum', async () => {
      const r = rig({ days: 30, ciDays: 365 });
      expect(await issue(r, request({ scope: 'write', expiresAt: inDays(31) }))).toEqual({
        ok: false,
        error: 'invalid_expiry',
      });
    });

    it.each([
      ['null', null],
      ['missing', undefined],
      ['past', inDays(0, -1)],
      ['now', NOW],
      ['non-canonical', '2026-10-20T12:00:00Z'],
      ['offset', '2026-10-20T14:00:00.000+02:00'],
      ['number', Date.parse(NOW) + DAY],
    ])('refuses a %s expiry', async (_name, expiresAt) => {
      const r = rig();
      expect(await issue(r, request({ expiresAt: expiresAt as never }))).toEqual({
        ok: false,
        error: 'invalid_expiry',
      });
      expect(r.calls).toHaveLength(0);
    });

    it('refuses when the organization settings are unusable', async () => {
      expect(await issue(rig({ organization: null }))).toEqual({ ok: false, error: 'forbidden' });
      expect(await issue(rig({ ciDays: 0 }))).toEqual({ ok: false, error: 'forbidden' });
    });
  });

  describe('issuer', () => {
    it.each([
      ['null', null],
      ['stale', inDays(0, -REAUTH_WINDOW_MS - 1)],
      ['future', inDays(0, 1)],
    ])('refuses a %s reauth_at through the real session check', async (_name, reauthAt) => {
      const r = rig();
      const sessions = createSessionService({
        sessions: {} as never,
        clock: fixedClock(NOW),
        publicOrigin: 'https://broker.example.test',
      });
      const base = session();
      const authenticated = {
        ...base,
        session: { ...base.session, reauthAt },
      } as AuthenticatedSession;
      const result = await createServiceTokenService({ ...r.deps, sessions }).issue(
        ctx,
        authenticated,
        actor(),
        fence(),
        request(),
        apiCall,
      );
      expect(result).toEqual({ ok: false, error: 'reauth_required' });
      expect(r.calls).toHaveLength(0);
    });

    it.each(['service', 'customer'] as const)(
      'refuses a %s credential: only a user session may issue',
      async (kind) => {
        const r = rig();
        expect(await issue(r, request(), session({ kind, principalId: 'sp-1' }))).toEqual({
          ok: false,
          error: 'forbidden',
        });
        expect(r.calls).toHaveLength(0);
        expect(r.liveCalls).toHaveLength(0);
      },
    );

    it('refuses a session whose principal is not its user', async () => {
      const r = rig();
      expect(await issue(r, request(), session({ principalId: 'user-2' }))).toEqual({
        ok: false,
        error: 'forbidden',
      });
    });

    it('refuses an untagged actor or one for another user', async () => {
      const r = rig();
      const untagged = { ...actor(), kind: undefined } as unknown as ActorContext;
      expect(await issue(r, request(), session(), fence(), untagged)).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(await issue(r, request(), session(), fence(), actor({ userId: 'user-2' }))).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(r.calls).toHaveLength(0);
    });

    it('throws for a fence of another session', async () => {
      const r = rig();
      await expect(issue(r, request(), session(), fence('user-1', 'session-2'))).rejects.toThrow(
        TypeError,
      );
      await expect(issue(r, request(), session(), fence('user-2'))).rejects.toThrow(TypeError);
    });

    it.each([[''], ['\u0000x'], ['x'.repeat(101)], [42]])('refuses name %j', async (name) => {
      const r = rig();
      expect(await issue(r, request({ name: name as never }))).toEqual({
        ok: false,
        error: 'invalid_name',
      });
    });
  });

  it('a service credential cannot edit its principal', async () => {
    const serviceActor = {
      kind: 'service',
      userId: 'sp-1',
      isOrganizationAdmin: true,
    } as unknown as ActorContext;
    const logs: Record<string, unknown>[] = [];
    const principals = createServicePrincipalService({
      principals: {
        get: async () => principal(),
        create: async () => 'created',
        setPermissions: async () => 'updated',
        suspend: async () => 'suspended',
        restore: async () => 'restored',
      },
      authority: {
        guard: () => [] as never,
        livePermissions: async () => new Set(['project:service-principals:write']),
      },
      directory: { createdBy: async () => [] },
      clock: fixedClock(NOW),
      ids: { ulid: () => 'op-1' },
      log: (entry) => logs.push({ ...entry }),
    });
    const held = fence('sp-1');
    expect(await principals.setPermissions(ctx, serviceActor, held, 'sp-1', [], apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await principals.restore(ctx, serviceActor, held, 'sp-1', apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});

const apiCall: ApiCall = {
  audit: {
    opId: '01K00000000000000000000001',
    requestId: '01K00000000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};

describe('lifecycle audit and idempotency', () => {
  it.each(['project-1', null] as const)('passes one issue event for %s', async (mode) => {
    const input = request({ routeProjectId: mode });
    const projectId = mode;
    const r = rig({
      principal: principal({ projectId, permissions: ['project:packages:read'] }),
      live: ['project:packages:read', 'project:tokens:create', 'org:service-principals:write'],
    });
    const generated = ['tok-audit', 'event-audit'];
    r.deps.ids.ulid = () => generated.shift()!;
    const call = { ...apiCall, idempotency: issueRecord };
    const result = await createServiceTokenService(r.deps).issue(
      ctx,
      session(),
      actor({ isOrganizationAdmin: true }),
      fence(),
      input,
      call,
    );
    expect(result.ok).toBe(true);
    expect(r.calls).toHaveLength(1);
    const stored = r.calls[0]!.input;
    expect(stored.audit).toEqual({
      id: 'event-audit',
      occurredAt: NOW,
      action: 'token.issue',
      actor: { type: 'user', id: 'user-1' },
      target: { type: 'token', id: 'tok-audit' },
      projectId,
      sourceIp: null,
      tokenSelector: null,
      payloadJson: expect.any(String),
    });
    expect(JSON.parse(stored.audit!.payloadJson)).toEqual({
      op_id: apiCall.audit.opId,
      request_id: apiCall.audit.requestId,
      changes: {
        kind: { new: 'svc' },
        name: { new: input.name },
        scope: { new: input.scope },
        expires_at: { new: input.expiresAt },
        project_mode: { new: projectId === null ? 'all' : 'selected' },
        project_count: { new: projectId === null ? 0 : 1 },
      },
    });
    expect(stored.idempotency).toEqual({
      ...issueRecord,
      responseJson: JSON.stringify({ code: 'already_issued', id: stored.id }),
    });
    expect(issueRecord.responseJson).toBe('{}');
  });

  it('excludes a sentinel minted plaintext from audit and idempotency', async () => {
    const r = rig();
    const plaintext = 'pb_svc_abcdefghijkl_' + 'Q'.repeat(43);
    r.deps.tokens.issueService = async (ctx, fence, input, mint) => {
      r.calls.push({ ctx, fence, input, mint });
      r.minted.push(await mint());
      return { status: 'issued', id: input.id, plaintext };
    };
    const input = request();
    const call = {
      ...apiCall,
      idempotency: { ...issueRecord, responseJson: JSON.stringify({ plaintext }) },
    };
    expect(
      await createServiceTokenService(r.deps).issue(
        ctx,
        session(),
        actor({ isOrganizationAdmin: true }),
        fence(),
        input,
        call,
      ),
    ).toMatchObject({ ok: true, value: { plaintext } });
    const stored = r.calls[0]!.input;
    const serialized = JSON.stringify([stored.audit, stored.idempotency]);
    expect(stored.audit).toBeDefined();
    expect(stored.idempotency).toBeDefined();
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain('Q'.repeat(43));
    const minted = parseToken(r.minted[0]!.plaintext);
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error('Expected minted token');
    expect(serialized).not.toContain(minted.canonical);
    expect(serialized).not.toContain(minted.secret);
  });

  it('omits absent issue idempotency', async () => {
    const r = rig();
    const input = request();
    const call = apiCall;
    await createServiceTokenService(r.deps).issue(
      ctx,
      session(),
      actor({ isOrganizationAdmin: true }),
      fence(),
      input,
      call,
    );
    expect(r.calls[0]!.input).not.toHaveProperty('idempotency');
  });

  it.each(['reauth_required', 'forbidden', 'scope_conflict'] as const)(
    'refuses %s without a store event',
    async (error) => {
      const r = rig(
        error === 'reauth_required' ? { fresh: false } : error === 'forbidden' ? { live: [] } : {},
      );
      const input = request(error === 'scope_conflict' ? { scope: 'write', readOnly: true } : {});
      const call = apiCall;
      expect(
        await createServiceTokenService(r.deps).issue(
          ctx,
          session(),
          actor({ isOrganizationAdmin: true }),
          fence(),
          input,
          call,
        ),
      ).toEqual({ ok: false, error });
      expect(r.calls).toHaveLength(0);
    },
  );

  it('requires the issue call argument', () => {
    expectTypeOf<Parameters<ServiceTokenService['issue']>['length']>().toEqualTypeOf<6>();
  });
});

const issueRecord = {
  principalKey: 'user:user-1',
  key: 'issue',
  route: '/tokens',
  requestHash: 'hash',
  status: 201,
  responseJson: '{}',
  createdAt: NOW,
  expiresAt: inDays(1),
};

describe('route principal binding', () => {
  it.each(['', 42 as never])('rejects malformed routeProjectId %s', async (routeProjectId) => {
    const r = rig();
    const get = vi.spyOn(r.deps.principals, 'get');
    const store = vi.spyOn(r.deps.tokens, 'issueService');
    await expect(issue(r, request({ routeProjectId }))).rejects.toThrow(TypeError);
    expect(get).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(r.liveCalls).toHaveLength(0);
    expect(r.minted).toHaveLength(0);
  });

  it.each([
    ['project route', 'project-2'],
    ['organization route', null],
  ] as const)('%s hides a principal outside its boundary', async (_name, routeProjectId) => {
    const r = rig();
    const absent = rig({ principal: null });
    const store = vi.spyOn(r.deps.tokens, 'issueService');
    const input = request({ routeProjectId });
    expect(await issue(r, input)).toEqual(await issue(absent, input));
    expect(r.logs).toEqual(absent.logs);
    expect(r.liveCalls).toEqual([null]);
    expect(store).not.toHaveBeenCalled();
    expect(absent.calls).toHaveLength(0);
  });

  it('uses the absent-principal denial for a caller without issue permission', async () => {
    const r = rig({ live: [] });
    const absent = rig({ principal: null, live: [] });
    const store = vi.spyOn(r.deps.tokens, 'issueService');
    const input = request({ routeProjectId: 'project-2' });
    expect(await issue(r, input)).toEqual(await issue(absent, input));
    expect(r.logs).toEqual(absent.logs);
    expect(r.liveCalls).toEqual([null]);
    expect(store).not.toHaveBeenCalled();
    expect(absent.calls).toHaveLength(0);
  });
});
