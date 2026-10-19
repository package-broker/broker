import type { PersonalTokenService } from './pat-service.js';
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
import { mutationFence, type AuthenticatedActor } from './fence.js';
import {
  createPersonalTokenService,
  type IssuePersonalTokenCall,
  type MintedPersonalToken,
  type PersonalTokenIssueInput,
  type PersonalTokenIssueOutcome,
  type PersonalTokenServiceDeps,
} from './pat-service.js';

const ctx = orgContext('org-a');
const NOW = '2026-10-16T12:00:00.000Z';
const DAY = 86_400_000;
const keyring = createKeyring([
  { version: 2, bytes: Uint8Array.from({ length: 32 }, (_, i) => i + 1) },
  { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
]);

function inDays(days: number, extraMs = 0): string {
  return new Date(Date.parse(NOW) + days * DAY + extraMs).toISOString();
}

function session(overrides: { identityId?: string | null; userId?: string } = {}) {
  return {
    session: {
      id: 'session-1',
      userId: overrides.userId ?? 'user-1',
      identityId: overrides.identityId === undefined ? null : overrides.identityId,
      csrfHash: 'x',
      createdAt: NOW,
      expiresAt: inDays(1),
      lastSeenAt: NOW,
      reauthAt: NOW,
      user: { id: overrides.userId ?? 'user-1', email: 'u@example.test', displayName: null },
    },
    principal: { kind: 'user', id: overrides.userId ?? 'user-1' },
  } as unknown as AuthenticatedSession;
}

function fence(userId = 'user-1', sessionId = 'session-1') {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
}

function organization(days = 30): Organization {
  return {
    id: ctx.orgId,
    slug: 'a',
    name: 'A',
    settings: {
      retentionRemovedUpstreamDays: 30,
      tokenDefaultExpiryDays: days,
      tokenCiReadonlyExpiryDays: 365,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface Rig {
  readonly deps: PersonalTokenServiceDeps;
  readonly calls: IssuePersonalTokenCall[];
  readonly logs: Record<string, unknown>[];
  readonly minted: MintedPersonalToken[];
}

function rig(
  options: {
    fresh?: boolean;
    outcome?: PersonalTokenIssueOutcome;
    days?: number | null;
    anchors?: { provider: string; anchor: string; emailAuthoritative: boolean }[];
  } = {},
): Rig {
  const calls: IssuePersonalTokenCall[] = [];
  const logs: Record<string, unknown>[] = [];
  const minted: Rig['minted'] = [];
  const deps: PersonalTokenServiceDeps = {
    tokens: {
      async issuePersonal(callCtx, callFence, input, mint) {
        calls.push({ ctx: callCtx, fence: callFence, input, mint });
        const pair = await mint();
        minted.push(pair);
        return options.outcome ?? { status: 'issued', id: input.id, plaintext: pair.plaintext };
      },
    },
    sessions: { isReauthFresh: () => options.fresh ?? true },
    organizations: {
      get: async () => (options.days === null ? null : organization(options.days ?? 30)),
    },
    providers: { anchors: async () => options.anchors ?? [] },
    keyring,
    clock: fixedClock(NOW),
    ids: { ulid: () => 'tok-1' },
    log: (entry) => logs.push({ ...entry }),
  };
  return { deps, calls, logs, minted };
}

const selectedInput = (projectIds: string[], extra: Partial<PersonalTokenIssueInput> = {}) => ({
  name: 'laptop',
  scope: 'read' as const,
  expiresAt: inDays(7),
  projectMode: 'selected' as const,
  projectIds,
  ...extra,
});

const allInput = (extra: Partial<PersonalTokenIssueInput> = {}) => ({
  name: 'laptop',
  scope: 'write' as const,
  expiresAt: inDays(7),
  projectMode: 'all' as const,
  projectIds: [],
  ...extra,
});

function realSessions(reauthAt: string | null) {
  const service = createSessionService({
    sessions: {} as never,
    clock: fixedClock(NOW),
    publicOrigin: 'https://broker.example.test',
  });
  const authenticated = session();
  return {
    service,
    authenticated: {
      ...authenticated,
      session: { ...authenticated.session, reauthAt },
    } as AuthenticatedSession,
  };
}

describe('personal token issuance', () => {
  it.each(['service', 'customer'])(
    'refuses a forged %s session before repository calls',
    async (kind) => {
      const r = rig();
      const tokens = vi.spyOn(r.deps.tokens, 'issuePersonal');
      const organizations = vi.spyOn(r.deps.organizations, 'get');
      const providers = vi.spyOn(r.deps.providers, 'anchors');
      const authenticated = {
        ...session(),
        principal: { kind, id: 'other-principal' },
      } as unknown as AuthenticatedSession;
      const result = await createPersonalTokenService(r.deps).issue(
        ctx,
        authenticated,
        fence(),
        allInput(),
        apiCall,
      );
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ ok: false, error: 'forbidden' });
      expect(tokens).not.toHaveBeenCalled();
      expect(organizations).not.toHaveBeenCalled();
      expect(providers).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['null', null],
    ['stale', inDays(0, -REAUTH_WINDOW_MS - 1)],
    ['future', inDays(0, 1)],
  ])('refuses a %s reauth_at through the real session check', async (_name, reauthAt) => {
    const r = rig();
    const { service, authenticated } = realSessions(reauthAt);
    const result = await createPersonalTokenService({
      ...r.deps,
      sessions: service,
    }).issue(ctx, authenticated, fence(), allInput(), apiCall);
    expect(result).toEqual({ ok: false, error: 'reauth_required' });
    expect(r.calls).toHaveLength(0);
  });

  it('accepts reauth at the window edge through the real session check', async () => {
    const r = rig();
    const { service, authenticated } = realSessions(inDays(0, -REAUTH_WINDOW_MS));
    const result = await createPersonalTokenService({ ...r.deps, sessions: service }).issue(
      ctx,
      authenticated,
      fence(),
      allInput(),
      apiCall,
    );
    expect(result.ok).toBe(true);
  });

  it('reports reauth_required when freshness is lost before the batch refuses', async () => {
    const r = rig({ outcome: { status: 'refused', reason: 'authority' } });
    let calls = 0;
    const result = await createPersonalTokenService({
      ...r.deps,
      sessions: { isReauthFresh: () => ++calls === 1 },
    }).issue(ctx, session(), fence(), allInput(), apiCall);
    expect(result).toEqual({ ok: false, error: 'reauth_required' });
  });

  it('uses a snapshot of the input, ignoring later mutation', async () => {
    const r = rig();
    const projectIds = ['project-1'];
    const input = selectedInput(projectIds) as {
      -readonly [K in keyof PersonalTokenIssueInput]: PersonalTokenIssueInput[K];
    };
    const deps: PersonalTokenServiceDeps = {
      ...r.deps,
      organizations: {
        get: async () => {
          projectIds.push('project-2');
          input.scope = 'full';
          return organization();
        },
      },
    };
    await createPersonalTokenService(deps).issue(ctx, session(), fence(), input, apiCall);
    expect(r.calls[0]?.input.projectIds).toEqual(['project-1']);
    expect(r.calls[0]?.input.scope).toBe('read');
  });

  it('refuses an expiry that elapses during the organization lookup', async () => {
    const r = rig();
    let current = new Date(NOW);
    const deps: PersonalTokenServiceDeps = {
      ...r.deps,
      clock: { now: () => current },
      organizations: {
        get: async () => {
          current = new Date(Date.parse(NOW) + 2000);
          return organization();
        },
      },
    };
    const result = await createPersonalTokenService(deps).issue(
      ctx,
      session(),
      fence(),
      allInput({ expiresAt: inDays(0, 1000) }),
      apiCall,
    );
    expect(result).toEqual({ ok: false, error: 'invalid_expiry' });
    expect(r.calls).toHaveLength(0);
  });

  it.each([0, -5, 1.5, Number.NaN])('denies a configured expiry of %s days', async (days) => {
    const r = rig({ days });
    expect(
      await createPersonalTokenService(r.deps).issue(ctx, session(), fence(), allInput(), apiCall),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(r.calls).toHaveLength(0);
  });

  it('refuses without fresh reauthentication and never reaches the store', async () => {
    const r = rig({ fresh: false });
    const result = await createPersonalTokenService(r.deps).issue(
      ctx,
      session(),
      fence(),
      allInput(),
      apiCall,
    );
    expect(result).toEqual({ ok: false, error: 'reauth_required' });
    expect(r.calls).toHaveLength(0);
  });

  it('issues for a session with no permission input at all', async () => {
    const r = rig();
    const result = await createPersonalTokenService(r.deps).issue(
      ctx,
      session(),
      fence(),
      allInput(),
      apiCall,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a fence that belongs to another user or session', async () => {
    const service = createPersonalTokenService(rig().deps);
    await expect(
      service.issue(ctx, session(), fence('user-2'), allInput(), apiCall),
    ).rejects.toThrow(TypeError);
    await expect(
      service.issue(ctx, session(), fence('user-1', 'session-2'), allInput(), apiCall),
    ).rejects.toThrow(TypeError);
  });

  it('issues for the session user with a sso origin from the session identity', async () => {
    const r = rig({
      anchors: [{ provider: 'okta', anchor: 'a1', emailAuthoritative: true }],
    });
    await createPersonalTokenService(r.deps).issue(
      ctx,
      session({ identityId: 'identity-1' }),
      fence(),
      allInput(),
      apiCall,
    );
    expect(r.calls[0]?.input).toMatchObject({
      id: 'tok-1',
      name: 'laptop',
      scope: 'write',
      now: NOW,
      validation: { kind: 'sso', identityId: 'identity-1' },
      projectMode: 'all',
      projectIds: [],
      providerAnchors: [{ provider: 'okta', anchor: 'a1', emailAuthoritative: true }],
    });
  });

  it('uses the local origin for a session without an identity', async () => {
    const r = rig();
    await createPersonalTokenService(r.deps).issue(ctx, session(), fence(), allInput(), apiCall);
    expect(r.calls[0]?.input.validation).toEqual({ kind: 'local' });
  });

  it('returns plaintext once, hashed under the current pepper, and never logs it', async () => {
    const r = rig();
    const result = await createPersonalTokenService(r.deps).issue(
      ctx,
      session(),
      fence(),
      allInput(),
      apiCall,
    );
    if (!result.ok) throw new Error('expected issued');
    const parsed = parseToken(result.value.plaintext);
    expect(parsed).toMatchObject({ ok: true, kind: 'pat' });
    const pair = r.minted[0]!;
    expect(pair.pepperVersion).toBe(2);
    expect(pair.plaintext).toBe(result.value.plaintext);
    expect(await verifyToken(keyring, 2, result.value.plaintext, pair.hash)).toBe(true);
    expect(pair.hash).not.toContain(result.value.plaintext);
    expect(JSON.stringify(r.logs)).not.toContain(result.value.plaintext);
    expect(JSON.stringify(Object.keys(result.value))).not.toContain('hash');
    expect(r.logs).toHaveLength(1);
    expect(Object.keys(r.logs[0]!).sort()).toEqual(
      ['actorUserId', 'event', 'kind', 'level', 'orgId', 'projectMode', 'scope', 'tokenId'].sort(),
    );
  });

  it('mints a different token on every call to mint', async () => {
    const r = rig();
    await createPersonalTokenService(r.deps).issue(ctx, session(), fence(), allInput(), apiCall);
    const again = await r.calls[0]!.mint();
    expect(again.plaintext).not.toBe(r.minted[0]!.plaintext);
    expect(again.plaintext.slice(7, 19)).toBe(again.selector);
  });

  describe('scope', () => {
    it.each(['admin', '', 'READ', undefined, ['read']])('refuses scope %j', async (scope) => {
      const r = rig();
      const result = await createPersonalTokenService(r.deps).issue(
        ctx,
        session(),
        fence(),
        allInput({ scope: scope as never }),
        apiCall,
      );
      expect(result).toEqual({ ok: false, error: 'invalid_scope' });
      expect(r.calls).toHaveLength(0);
    });

    it.each(['write', 'full'] as const)('refuses read_only with %s', async (scope) => {
      const r = rig();
      const result = await createPersonalTokenService(r.deps).issue(
        ctx,
        session(),
        fence(),
        allInput({ scope, readOnly: true }),
        apiCall,
      );
      expect(result).toEqual({ ok: false, error: 'scope_conflict' });
      expect(r.calls).toHaveLength(0);
    });

    it('refuses read with read_only=false and accepts read with read_only=true', async () => {
      const r = rig();
      const service = createPersonalTokenService(r.deps);
      expect(
        await service.issue(
          ctx,
          session(),
          fence(),
          allInput({ scope: 'read', readOnly: false }),
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'scope_conflict' });
      expect(
        (
          await service.issue(
            ctx,
            session(),
            fence(),
            allInput({ scope: 'read', readOnly: true }),
            apiCall,
          )
        ).ok,
      ).toBe(true);
    });

    it('maps an authority refusal from the batch to forbidden, never narrowing', async () => {
      const r = rig({ outcome: { status: 'refused', reason: 'authority' } });
      const result = await createPersonalTokenService(r.deps).issue(
        ctx,
        session(),
        fence(),
        allInput({ scope: 'full' }),
        apiCall,
      );
      expect(result).toEqual({ ok: false, error: 'forbidden' });
      expect(r.calls[0]?.input.scope).toBe('full');
      expect(r.logs).toHaveLength(1);
      expect(Object.keys(r.logs[0]!).sort()).toEqual(
        ['actorUserId', 'event', 'level', 'orgId'].sort(),
      );
    });
  });

  describe('expiry', () => {
    it.each([null, undefined, '', 'tomorrow', 12345, '2026-10-20', '2026-10-20T12:00:00Z'])(
      'refuses %j',
      async (expiresAt) => {
        const r = rig();
        const result = await createPersonalTokenService(r.deps).issue(
          ctx,
          session(),
          fence(),
          allInput({ expiresAt: expiresAt as never }),
          apiCall,
        );
        expect(result).toEqual({ ok: false, error: 'invalid_expiry' });
        expect(r.calls).toHaveLength(0);
      },
    );

    it('refuses an expiry that is now or in the past', async () => {
      const service = createPersonalTokenService(rig().deps);
      for (const expiresAt of [NOW, inDays(0, -1), inDays(-1)]) {
        expect(
          await service.issue(ctx, session(), fence(), allInput({ expiresAt }), apiCall),
        ).toEqual({
          ok: false,
          error: 'invalid_expiry',
        });
      }
    });

    it('allows exactly the configured maximum and refuses one millisecond more', async () => {
      const r = rig({ days: 30 });
      const service = createPersonalTokenService(r.deps);
      expect(
        (await service.issue(ctx, session(), fence(), allInput({ expiresAt: inDays(30) }), apiCall))
          .ok,
      ).toBe(true);
      expect(
        await service.issue(
          ctx,
          session(),
          fence(),
          allInput({ expiresAt: inDays(30, 1) }),
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'invalid_expiry' });
    });

    it('caps a larger configured default at 90 days', async () => {
      const r = rig({ days: 365 });
      const service = createPersonalTokenService(r.deps);
      expect(
        (await service.issue(ctx, session(), fence(), allInput({ expiresAt: inDays(90) }), apiCall))
          .ok,
      ).toBe(true);
      expect(
        await service.issue(
          ctx,
          session(),
          fence(),
          allInput({ expiresAt: inDays(90, 1) }),
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'invalid_expiry' });
    });

    it('denies when the organization settings cannot be read', async () => {
      const r = rig({ days: null });
      expect(
        await createPersonalTokenService(r.deps).issue(
          ctx,
          session(),
          fence(),
          allInput(),
          apiCall,
        ),
      ).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(r.calls).toHaveLength(0);
    });
  });

  describe('projects', () => {
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `project-${i + 1}`);

    it('refuses an empty selection and 201 projects', async () => {
      const r = rig();
      const service = createPersonalTokenService(r.deps);
      for (const projectIds of [[], ids(201)]) {
        expect(
          await service.issue(ctx, session(), fence(), selectedInput(projectIds), apiCall),
        ).toEqual({
          ok: false,
          error: 'invalid_projects',
        });
      }
      expect(r.calls).toHaveLength(0);
    });

    it.each([
      [['project-1', 'project-1']],
      [['project-1', '']],
      [['project-1', 7]],
      [['project-1', null]],
    ])('refuses invalid ids %j', async (projectIds) => {
      const r = rig();
      const result = await createPersonalTokenService(r.deps).issue(
        ctx,
        session(),
        fence(),
        selectedInput(projectIds as never),
        apiCall,
      );
      expect(result).toEqual({ ok: false, error: 'invalid_projects' });
      expect(r.calls).toHaveLength(0);
    });

    it('refuses an unknown mode and a non-array selection', async () => {
      const r = rig();
      const service = createPersonalTokenService(r.deps);
      expect(
        await service.issue(
          ctx,
          session(),
          fence(),
          allInput({ projectMode: 'some' as never }),
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'invalid_projects' });
      expect(
        await service.issue(ctx, session(), fence(), selectedInput('project-1' as never), apiCall),
      ).toEqual({ ok: false, error: 'invalid_projects' });
      expect(r.calls).toHaveLength(0);
    });

    it('refuses ids supplied with the all mode instead of ignoring them', async () => {
      const r = rig();
      const result = await createPersonalTokenService(r.deps).issue(
        ctx,
        session(),
        fence(),
        allInput({ projectIds: ['project-1'] }),
        apiCall,
      );
      expect(result).toEqual({ ok: false, error: 'invalid_projects' });
    });

    it('passes the all mode with no ids, so no binding rows are requested', async () => {
      const r = rig();
      await createPersonalTokenService(r.deps).issue(ctx, session(), fence(), allInput(), apiCall);
      expect(r.calls[0]?.input).toMatchObject({ projectMode: 'all', projectIds: [] });
    });

    it('passes exactly 200 ids in one store call', async () => {
      const r = rig();
      const result = await createPersonalTokenService(r.deps).issue(
        ctx,
        session(),
        fence(),
        selectedInput(ids(200)),
        apiCall,
      );
      expect(result.ok).toBe(true);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]?.input.projectIds).toEqual(ids(200));
    });

    it('maps a lost project authority in the batch to forbidden', async () => {
      const r = rig({ outcome: { status: 'refused', reason: 'authority' } });
      const result = await createPersonalTokenService(r.deps).issue(
        ctx,
        session(),
        fence(),
        selectedInput(['project-1']),
        apiCall,
      );
      expect(result).toEqual({ ok: false, error: 'forbidden' });
    });
  });

  describe('name', () => {
    it.each(['', '   \u0000', 'a\nb', 'x'.repeat(101), 7, null])('refuses %j', async (name) => {
      const r = rig();
      const result = await createPersonalTokenService(r.deps).issue(
        ctx,
        session(),
        fence(),
        allInput({ name: name as never }),
        apiCall,
      );
      expect(result).toEqual({ ok: false, error: 'invalid_name' });
      expect(r.calls).toHaveLength(0);
    });
  });

  describe('batch outcomes', () => {
    it.each([
      [{ status: 'refused', reason: 'id_conflict' }, 'conflict'],
      [{ status: 'refused', reason: 'selector_collision' }, 'conflict'],
      [{ status: 'indeterminate' }, 'indeterminate'],
    ] as const)('maps %j to %s', async (outcome, error) => {
      const r = rig({ outcome: outcome as PersonalTokenIssueOutcome });
      expect(
        await createPersonalTokenService(r.deps).issue(
          ctx,
          session(),
          fence(),
          allInput(),
          apiCall,
        ),
      ).toEqual({ ok: false, error });
      expect(r.logs.some((entry) => entry['event'] === 'token.issued')).toBe(false);
    });

    it('throws on an unclassified refusal rather than guessing', async () => {
      const r = rig({ outcome: { status: 'refused', reason: 'unclassified' } });
      await expect(
        createPersonalTokenService(r.deps).issue(ctx, session(), fence(), allInput(), apiCall),
      ).rejects.toThrow(/unclassified/);
    });

    it('does not fail an issued token when the log sink throws', async () => {
      const r = rig();
      const deps = {
        ...r.deps,
        log: vi.fn(() => {
          throw new Error('sink down');
        }),
      };
      expect(
        (await createPersonalTokenService(deps).issue(ctx, session(), fence(), allInput(), apiCall))
          .ok,
      ).toBe(true);
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
  it.each(['selected', 'all'] as const)('passes one issue event for %s', async (mode) => {
    const input = mode === 'selected' ? selectedInput(['project-1', 'project-2']) : allInput();
    const projectId = null;
    const r = rig();
    const generated = ['tok-audit', 'event-audit'];
    r.deps.ids.ulid = () => generated.shift()!;
    const call = { ...apiCall, idempotency: issueRecord };
    const result = await createPersonalTokenService(r.deps).issue(
      ctx,
      session(),
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
        kind: { new: 'pat' },
        name: { new: input.name },
        scope: { new: input.scope },
        expires_at: { new: input.expiresAt },
        project_mode: { new: input.projectMode },
        project_count: { new: input.projectIds.length },
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
    const plaintext = 'pb_pat_abcdefghijkl_' + 'Q'.repeat(43);
    r.deps.tokens.issuePersonal = async (ctx, fence, input, mint) => {
      r.calls.push({ ctx, fence, input, mint });
      r.minted.push(await mint());
      return { status: 'issued', id: input.id, plaintext };
    };
    const input = selectedInput(['project-1', 'project-2']);
    const call = {
      ...apiCall,
      idempotency: { ...issueRecord, responseJson: JSON.stringify({ plaintext }) },
    };
    expect(
      await createPersonalTokenService(r.deps).issue(ctx, session(), fence(), input, call),
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
    const input = selectedInput(['project-1', 'project-2']);
    const call = apiCall;
    await createPersonalTokenService(r.deps).issue(ctx, session(), fence(), input, call);
    expect(r.calls[0]!.input).not.toHaveProperty('idempotency');
  });

  it.each(['reauth_required', 'forbidden', 'scope_conflict'] as const)(
    'refuses %s without a store event',
    async (error) => {
      const r = rig(
        error === 'reauth_required'
          ? { fresh: false }
          : error === 'forbidden'
            ? { days: null }
            : {},
      );
      const input = allInput(error === 'scope_conflict' ? { scope: 'write', readOnly: true } : {});
      const call = apiCall;
      expect(
        await createPersonalTokenService(r.deps).issue(ctx, session(), fence(), input, call),
      ).toEqual({ ok: false, error });
      expect(r.calls).toHaveLength(0);
    },
  );

  it('requires the issue call argument', () => {
    expectTypeOf<Parameters<PersonalTokenService['issue']>['length']>().toEqualTypeOf<5>();
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
