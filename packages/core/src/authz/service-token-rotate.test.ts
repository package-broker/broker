import { describe, expect, it, vi } from 'vitest';
import type { ApiCall } from '../api/idempotency.js';
import type { AuthenticatedSession } from '../auth/session.js';
import { orgContext } from '../db/port.js';
import type { Organization } from '../db/organization.js';
import { fixedClock, ulid } from '../ids.js';
import { createKeyring } from '../secrets/keyring.js';
import type { ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor } from './fence.js';
import type { ServicePrincipalRecord } from './service-principal-service.js';
import {
  createServiceTokenService,
  type ServiceTokenRotateInput,
  type ServiceTokenRecord,
  type ServiceTokenRotateStoreInput,
  type ServiceTokenRotateOutcome,
  type ServiceTokenRotationStore,
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

function actor(): ActorContext {
  return {
    kind: 'organization',
    userId: 'user-1',
    permissions: new Set(),
    isOrganizationAdmin: false,
  };
}

const old: ServiceTokenRecord = {
  id: 'old-token',
  servicePrincipalId: 'sp-1',
  projectId: 'project-1',
  scope: 'read',
  readOnly: true,
  name: 'deploy',
  expiresAt: inDays(30),
  revokedAt: null,
};
function rig(
  options: {
    old?: ServiceTokenRecord | null;
    live?: readonly string[];
    fresh?: boolean;
    principal?: ServicePrincipalRecord;
    outcome?: ServiceTokenRotateOutcome;
  } = {},
) {
  const logs: Record<string, unknown>[] = [];
  const inputs: ServiceTokenRotateStoreInput[] = [];
  const tokens = {
    issueService: vi.fn(),
    getService: vi.fn(async () => (options.old === undefined ? old : options.old)),
    rotateService: vi.fn<ServiceTokenRotationStore['rotateService']>(
      async (_ctx, _fence, input, mint) => {
        inputs.push(input);
        const pair = await mint();
        return (
          options.outcome ?? {
            status: 'rotated',
            id: input.id,
            plaintext: pair.plaintext,
            replacedExpiresAt: input.overlapDays === 0 ? input.now : inDays(7),
          }
        );
      },
    ),
  };
  const livePermissions = vi.fn(
    async () => new Set(options.live ?? [...ISSUER, 'project:tokens:revoke']),
  );
  const service = createServiceTokenService({
    tokens,
    principals: { get: async () => options.principal ?? principal() },
    authority: { livePermissions },
    sessions: { isReauthFresh: () => options.fresh ?? true },
    organizations: { get: async () => organization() },
    providers: { anchors: async () => ANCHORS },
    keyring,
    clock: fixedClock(NOW),
    ids: { ulid },
    log: (entry) => logs.push({ ...entry }),
  });
  return {
    service,
    tokens,
    logs,
    inputs,
    livePermissions,
    rotate: (
      extra: Partial<ServiceTokenRotateInput> = {},
      auth = session(),
      issuer = actor(),
      held = fence(),
    ) =>
      service.rotate(ctx, auth, issuer, held, {
        tokenId: old.id,
        routeProjectId: 'project-1',
        overlapDays: 7,
        ...extra,
      }),
  };
}

describe('service token rotation', () => {
  it('lets a project owner replace another user’s token with the same principal, scope and name', async () => {
    const r = rig();
    const result = await r.rotate();
    expect(result).toMatchObject({
      ok: true,
      value: { replacedTokenId: old.id, replacedExpiresAt: inDays(7) },
    });
    expect(r.inputs[0]).toMatchObject({
      name: old.name,
      servicePrincipalId: old.servicePrincipalId,
      projectId: old.projectId,
      scope: old.scope,
      readOnly: old.readOnly,
      expiresAt: inDays(30),
      maxLifetimeDays: 365,
    });
    expect(r.tokens.issueService).not.toHaveBeenCalled();
    expect(r.logs).toEqual([
      expect.objectContaining({
        event: 'token.rotated',
        orgId: ctx.orgId,
        tokenId: old.id,
        replacementId: expect.any(String),
        projectId: old.projectId,
        overlapDays: 7,
        actorUserId: 'user-1',
        replacedExpiresAt: inDays(7),
        expiresAt: inDays(30),
      }),
    ]);
    if (!result.ok) throw new Error('rotation failed');
    expect(JSON.stringify(r.logs)).not.toContain(result.value.plaintext);
    expect(r.inputs[0]?.audit.action).toBe('token.issue');
    expect(r.inputs[0]?.rotationAudit.action).toBe('token.rotate');
  });

  it.each([
    ['another project', 'project-2'],
    ['organization route', null],
  ] as const)(
    'hides a project token on %s exactly like an absent id',
    async (_label, routeProjectId) => {
      const r = rig();
      const absent = rig({ old: null });
      expect(await r.rotate({ routeProjectId })).toEqual(await absent.rotate({ routeProjectId }));
      expect(r.logs).toEqual(absent.logs);
      expect(r.livePermissions.mock.calls).toEqual(absent.livePermissions.mock.calls);
      expect(r.tokens.rotateService).not.toHaveBeenCalled();
    },
  );

  it('uses the generic absent denial without issue permission', async () => {
    const r = rig({ live: [] });
    const absent = rig({ old: null, live: [] });
    expect(await r.rotate({ routeProjectId: 'project-2' })).toEqual(
      await absent.rotate({ routeProjectId: 'project-2' }),
    );
    expect(r.logs).toEqual(absent.logs);
  });

  describe.each([
    ['create permission only', ['project:tokens:create']],
    ['no token permissions', []],
  ])('with %s', (_label, live) => {
    it.each([
      { extra: { name: '' }, error: 'invalid_name' },
      { extra: { name: undefined }, error: 'invalid_name' },
      { extra: { expiresAt: inDays(-1) }, error: 'invalid_expiry' },
      { extra: { expiresAt: NOW }, error: 'invalid_expiry' },
      { extra: { expiresAt: undefined }, error: 'invalid_expiry' },
      { extra: { expiresAt: 'invalid' }, error: 'invalid_expiry' },
      { extra: { expiresAt: inDays(366) }, error: 'invalid_expiry' },
      { extra: { lifetimeDays: 0 }, error: 'invalid_expiry' },
      { extra: { lifetimeDays: 1.5 }, error: 'invalid_expiry' },
      { extra: { lifetimeDays: 366 }, error: 'invalid_expiry' },
      { extra: { lifetimeDays: undefined }, error: 'invalid_expiry' },
      { extra: { lifetimeDays: 1, expiresAt: inDays(1) }, error: 'invalid_expiry' },
    ])('validates supplied replacement $extra before token lookup', async ({ extra, error }) => {
      const existing = rig({ live });
      const absent = rig({ old: null, live });
      const foreign = rig({ old: { ...old, projectId: 'project-2' }, live });
      const outcomes = [];
      for (const r of [existing, absent, foreign]) {
        const result = await r.rotate(extra as Partial<ServiceTokenRotateInput>);
        outcomes.push({ result, logs: r.logs });
      }
      expect(outcomes[0]).toEqual({ result: { ok: false, error }, logs: [] });
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(outcomes[2]).toEqual(outcomes[0]);
      for (const r of [existing, absent, foreign]) {
        expect(r.tokens.getService).not.toHaveBeenCalled();
        expect(r.tokens.issueService).not.toHaveBeenCalled();
        expect(r.tokens.rotateService).not.toHaveBeenCalled();
        expect(r.livePermissions).not.toHaveBeenCalled();
      }
    });
  });

  it('denies a caller with create but without revoke before the mutation store', async () => {
    const r = rig({ live: ISSUER });
    expect(await r.rotate()).toEqual({ ok: false, error: 'forbidden' });
    expect(r.tokens.rotateService).not.toHaveBeenCalled();
  });
  it('denies a caller with revoke but without create before the mutation store', async () => {
    const r = rig({ live: ['project:packages:read', 'project:read', 'project:tokens:revoke'] });
    expect(await r.rotate()).toEqual({ ok: false, error: 'forbidden' });
    expect(r.tokens.rotateService).not.toHaveBeenCalled();
  });
  it.each([
    ['revoked', { revokedAt: NOW }],
    ['expired', { expiresAt: NOW }],
  ])('refuses a %s token without writing', async (_label, change) => {
    const r = rig({ old: { ...old, ...change } });
    expect(await r.rotate()).toEqual({ ok: false, error: 'conflict' });
    expect(r.tokens.rotateService).not.toHaveBeenCalled();
  });
  it('rejects overlap 2 before any token store call', async () => {
    const r = rig();
    expect(await r.rotate({ overlapDays: 2 as 7 })).toEqual({
      ok: false,
      error: 'invalid_overlap',
    });
    expect(r.tokens.getService).not.toHaveBeenCalled();
    expect(r.tokens.rotateService).not.toHaveBeenCalled();
  });
  it('requires fresh reauthentication before reading a token', async () => {
    const r = rig({ fresh: false });
    expect(await r.rotate()).toEqual({ ok: false, error: 'reauth_required' });
    expect(r.tokens.getService).not.toHaveBeenCalled();
  });
  it('requires a matching mutation fence', async () => {
    const r = rig();
    await expect(r.rotate({}, session(), actor(), fence('user-2'))).rejects.toThrow(TypeError);
    expect(r.tokens.getService).not.toHaveBeenCalled();
  });
  it('denies a service principal actor before reading a token', async () => {
    const r = rig();
    expect(await r.rotate({}, session({ kind: 'service' }))).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(r.tokens.getService).not.toHaveBeenCalled();
  });
  it('requires organization administrator status for organization tokens', async () => {
    const r = rig({
      old: { ...old, projectId: null },
      principal: principal({ projectId: null }),
      live: [...ISSUER, 'org:service-principals:write', 'org:tokens:revoke'],
    });
    expect(await r.rotate({ routeProjectId: null })).toEqual({ ok: false, error: 'forbidden' });
    expect(r.tokens.rotateService).not.toHaveBeenCalled();
  });
  it('requires all conferred permissions in the rotating user’s live set', async () => {
    const r = rig({ live: ['project:tokens:create', 'project:tokens:revoke'] });
    expect(await r.rotate()).toEqual({ ok: false, error: 'forbidden' });
    expect(r.tokens.rotateService).not.toHaveBeenCalled();
  });
  it.each([
    { lifetimeDays: 0 },
    { lifetimeDays: 1.5 },
    { lifetimeDays: 366 },
    { lifetimeDays: 1, expiresAt: inDays(1) },
    { expiresAt: NOW },
    { expiresAt: undefined },
  ])('rejects invalid replacement expiry %j', async (extra) => {
    const r = rig();
    expect(await r.rotate(extra as Partial<ServiceTokenRotateInput>)).toEqual({
      ok: false,
      error: 'invalid_expiry',
    });
    expect(r.tokens.rotateService).not.toHaveBeenCalled();
  });
  it('accepts lifetimeDays and a replacement name', async () => {
    const r = rig();
    expect((await r.rotate({ lifetimeDays: 1, name: 'next' })).ok).toBe(true);
    expect(r.inputs[0]).toMatchObject({ name: 'next', expiresAt: inDays(1) });
  });
  it('rejects an invalid replacement name', async () => {
    const r = rig();
    expect(await r.rotate({ name: '' })).toEqual({ ok: false, error: 'invalid_name' });
    expect(r.tokens.rotateService).not.toHaveBeenCalled();
  });
  it.each(['authority', 'conflict'] as const)(
    'maps batch refusal %s without success events',
    async (reason) => {
      const r = rig({ outcome: { status: 'refused', reason } });
      expect(await r.rotate()).toEqual({
        ok: false,
        error: reason === 'authority' ? 'forbidden' : 'conflict',
      });
      expect(r.logs.some((entry) => entry['event'] === 'token.rotated')).toBe(false);
    },
  );
});

describe('rotation request context', () => {
  it('passes request audit data and a plaintext-free replay record into the rotation batch', async () => {
    const r = rig();
    const call: ApiCall = {
      audit: {
        opId: '01K00000000000000000000001',
        requestId: '01K00000000000000000000002',
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
      idempotency: {
        principalKey: 'user:user-1',
        key: 'rotate-once',
        route: 'POST /_pb/projects/:project/tokens/:token/rotate',
        requestHash: 'hash',
        status: 201,
        responseJson: '{}',
        createdAt: NOW,
        expiresAt: inDays(1),
      },
    };
    const result = await r.service.rotate(
      ctx,
      session(),
      actor(),
      fence(),
      {
        tokenId: old.id,
        routeProjectId: 'project-1',
        overlapDays: 7,
      },
      call,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('rotation failed');
    const input = r.inputs[0]!;
    expect(input.idempotency).toEqual({
      ...call.idempotency,
      responseJson: JSON.stringify({ code: 'already_issued', id: result.value.id }),
    });
    for (const audit of [input.audit, input.rotationAudit]) {
      expect(audit.sourceIp).toBe(call.audit.sourceIp);
      expect(JSON.parse(audit.payloadJson)).toMatchObject({
        op_id: call.audit.opId,
        request_id: call.audit.requestId,
      });
    }
    expect(JSON.stringify([input.audit, input.rotationAudit, input.idempotency])).not.toContain(
      result.value.plaintext,
    );
  });
});
