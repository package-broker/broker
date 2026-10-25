import type { ApiCall } from '../api/idempotency.js';
import type { AuditEvent } from '../audit/actions.js';
import { describe, expect, it, vi } from 'vitest';
import {
  REAUTH_WINDOW_MS,
  createSessionService,
  type AuthenticatedSession,
} from '../auth/session.js';
import { orgContext } from '../db/port.js';
import { fixedClock, type Clock } from '../ids.js';
import type { ActorAccessSnapshot } from './actor.js';
import { mutationFence, type AuthenticatedActor, type MutationFence } from './fence.js';
import {
  createUnblockService,
  createUnlinkService,
  type IdentityBlockStore,
  type UnblockIdentityRequest,
  type UnblockStoreOutcome,
  type IdentityUnlinkStore,
  type UnlinkIdentityRequest,
  type UnlinkStoreInput,
  type UnlinkStoreOutcome,
} from './unlink-service.js';

const call: ApiCall = {
  audit: {
    opId: '01K7R5V0000000000000000001',
    requestId: '01K7R5V0000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};

const ctx = orgContext('org-a');
const NOW = '2026-10-16T12:00:00.000Z';
const ANCHOR = 'oidc:https://anchor-sentinel-5b1e.example.test';
const SUBJECT = 'subject-sentinel-7f3a';
const PROVIDER = 'prov-sentinel-c9d2';

function authenticated(
  overrides: {
    reauthAt?: string | null;
    sessionId?: string;
    userId?: string;
    principal?: { kind: string; id: string } | null;
  } = {},
): AuthenticatedSession {
  const userId = overrides.userId ?? 'admin-1';
  return {
    session: {
      id: overrides.sessionId ?? 'session-1',
      userId,
      identityId: null,
      csrfHash: 'x',
      createdAt: NOW,
      expiresAt: '2026-10-16T20:00:00.000Z',
      lastSeenAt: NOW,
      reauthAt: overrides.reauthAt === undefined ? NOW : overrides.reauthAt,
      user: { id: userId, email: 'admin@example.test', displayName: null },
    },
    principal:
      overrides.principal === undefined ? { kind: 'user', id: userId } : overrides.principal,
  } as unknown as AuthenticatedSession;
}

function snapshot(overrides: Partial<ActorAccessSnapshot> = {}): ActorAccessSnapshot {
  return {
    session: { id: 'session-1', userId: 'admin-1' },
    user: { id: 'admin-1' },
    organizationPermissions: ['org:users:write', 'org:users:read'],
    projectPermissions: [],
    protectedHolder: true,
    ...overrides,
  };
}

function fence(userId = 'admin-1', sessionId = 'session-1'): MutationFence {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
}

const REQUEST: UnlinkIdentityRequest = {
  identityId: 'identity-1',
  userId: 'user-9',
  provider: PROVIDER,
  subject: SUBJECT,
};

function setup(
  options: {
    outcome?: UnlinkStoreOutcome;
    anchors?: readonly { provider: string; anchor: string; emailAuthoritative: boolean }[];
    now?: string;
    clock?: Clock;
    store?: IdentityUnlinkStore['unlinkIdentity'];
  } = {},
) {
  const clock = options.clock ?? fixedClock(options.now ?? NOW);
  const sessions = createSessionService({
    sessions: {} as never,
    clock,
    publicOrigin: 'https://broker.example.test',
  });
  const calls: {
    fence: MutationFence;
    input: UnlinkStoreInput;
    audit: { unlink: AuditEvent; block: AuditEvent };
  }[] = [];
  const unlinks: IdentityUnlinkStore = {
    unlinkIdentity: (c, f, input, audit) => {
      calls.push({ fence: f, input, audit });
      return options.store
        ? options.store(c, f, input, audit)
        : Promise.resolve(options.outcome ?? 'unlinked');
    },
  };
  const anchors = vi.fn(() =>
    Promise.resolve(
      options.anchors ?? [{ provider: PROVIDER, anchor: ANCHOR, emailAuthoritative: true }],
    ),
  );
  const log = vi.fn();
  const service = createUnlinkService({
    unlinks,
    sessions,
    providers: { anchors },
    clock,
    log,
  });
  return { service, calls, anchors, log };
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function expectNoLeak(value: unknown): void {
  const text = serialized(value);
  expect(text).not.toContain(SUBJECT);
  expect(text).not.toContain(PROVIDER);
  expect(text).not.toContain(ANCHOR);
}

function deniedEvents(log: ReturnType<typeof vi.fn>): unknown[] {
  return log.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .filter((entry) => entry['event'] === 'identity.unlink_denied');
}

function expectOneDenied(log: ReturnType<typeof vi.fn>, actorUserId: string | null): void {
  expect(log).toHaveBeenCalledTimes(1);
  expect(deniedEvents(log)).toEqual([
    { level: 'warn', event: 'identity.unlink_denied', orgId: 'org-a', actorUserId },
  ]);
  expectNoLeak(log.mock.calls);
}

describe('unlinkIdentity success', () => {
  it('unlinks for an organization admin with a fresh session, through the fence', async () => {
    const { service, calls } = setup();
    const f = fence();
    const result = await service.unlinkIdentity(ctx, authenticated(), snapshot(), f, REQUEST, call);
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fence).toBe(f);
    expect(calls[0]?.input).toEqual({ ...REQUEST, anchor: ANCHOR, now: NOW });
  });

  it('emits exactly one info event with ids only', async () => {
    const { service, log } = setup();
    await service.unlinkIdentity(ctx, authenticated(), snapshot(), fence(), REQUEST, call);
    expect(log.mock.calls).toEqual([
      [
        {
          level: 'info',
          event: 'identity.unlinked',
          orgId: 'org-a',
          actorUserId: 'admin-1',
          identityId: 'identity-1',
          userId: 'user-9',
        },
      ],
    ]);
    expectNoLeak(log.mock.calls);
  });

  it('accepts reauth exactly at the window edge and refuses one millisecond past it', async () => {
    const reauthAt = new Date(Date.parse(NOW) - REAUTH_WINDOW_MS).toISOString();
    const edge = setup();
    expect(
      await edge.service.unlinkIdentity(
        ctx,
        authenticated({ reauthAt }),
        snapshot(),
        fence(),
        REQUEST,
        call,
      ),
    ).toEqual({ ok: true });
    const late = setup({ now: new Date(Date.parse(NOW) + 1).toISOString() });
    expect(
      await late.service.unlinkIdentity(
        ctx,
        authenticated({ reauthAt }),
        snapshot(),
        fence(),
        REQUEST,
        call,
      ),
    ).toEqual({ ok: false, error: 'reauth_required' });
    expect(late.calls).toHaveLength(0);
  });

  it('keeps a successful unlink successful when the log sink throws', async () => {
    const { service, log } = setup();
    log.mockImplementation(() => {
      throw new Error('sink down');
    });
    expect(
      await service.unlinkIdentity(ctx, authenticated(), snapshot(), fence(), REQUEST, call),
    ).toEqual({ ok: true });
  });
});

describe('unlinkIdentity snapshots its inputs once', () => {
  it('validates and stores the first read of each request field', async () => {
    const { service, calls } = setup();
    const reads: Record<string, number> = {};
    const first = { ...REQUEST };
    const later: Record<string, string> = {
      identityId: 'identity-other',
      userId: 'user-other',
      provider: 'other',
      subject: 'a\u0000b',
    };
    const request = {} as Record<string, string>;
    for (const key of Object.keys(first)) {
      Object.defineProperty(request, key, {
        enumerable: true,
        get() {
          reads[key] = (reads[key] ?? 0) + 1;
          return reads[key] === 1 ? first[key as keyof typeof first] : later[key];
        },
      });
    }
    const result = await service.unlinkIdentity(
      ctx,
      authenticated(),
      snapshot(),
      fence(),
      request as unknown as UnlinkIdentityRequest,
      call,
    );
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.input).toMatchObject(REQUEST);
    expect(Object.values(reads).every((count) => count === 1)).toBe(true);
  });

  it('reads the session reauth time once', async () => {
    const { service, calls } = setup();
    const auth = authenticated();
    let reads = 0;
    Object.defineProperty(auth.session, 'reauthAt', {
      get() {
        reads += 1;
        return reads === 1 ? NOW : null;
      },
    });
    expect(await service.unlinkIdentity(ctx, auth, snapshot(), fence(), REQUEST, call)).toEqual({
      ok: true,
    });
    expect(reads).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe('unlinkIdentity refusals', () => {
  it('refuses a session that never reauthenticated, with no event', async () => {
    const { service, calls, log } = setup();
    const result = await service.unlinkIdentity(
      ctx,
      authenticated({ reauthAt: null }),
      snapshot(),
      fence(),
      REQUEST,
      call,
    );
    expect(result).toEqual({ ok: false, error: 'reauth_required' });
    expect(calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses a protected holder without org:users:write before reauth, input or provider checks', async () => {
    const { service, calls, anchors, log } = setup();
    const result = await service.unlinkIdentity(
      ctx,
      authenticated({ reauthAt: null }),
      snapshot({ organizationPermissions: ['org:users:read'] }),
      fence(),
      { ...REQUEST, subject: '' },
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(anchors).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expectOneDenied(log, 'admin-1');
  });

  it('refuses a non-admin holding org:users:write, even with a fresh session', async () => {
    const { service, calls, log } = setup();
    const result = await service.unlinkIdentity(
      ctx,
      authenticated(),
      snapshot({ protectedHolder: false }),
      fence(),
      REQUEST,
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
    expectOneDenied(log, 'admin-1');
  });

  it('refuses a non-admin with a stale session as forbidden, not reauth_required', async () => {
    const { service } = setup();
    const result = await service.unlinkIdentity(
      ctx,
      authenticated({ reauthAt: null }),
      snapshot({ protectedHolder: false }),
      fence(),
      REQUEST,
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
  });

  it('gives a project owner with org-looking project permissions no authority', async () => {
    const { service, calls, log } = setup();
    const result = await service.unlinkIdentity(
      ctx,
      authenticated(),
      snapshot({
        organizationPermissions: [],
        projectPermissions: ['org:users:write', 'org:*'],
        protectedHolder: false,
      }),
      fence(),
      REQUEST,
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
    expectOneDenied(log, 'admin-1');
  });

  it.each(['service', 'customer'])('refuses a %s token principal', async (kind) => {
    const { service, calls, log } = setup();
    const result = await service.unlinkIdentity(
      ctx,
      authenticated({ principal: { kind, id: 'admin-1' } }),
      snapshot(),
      fence(),
      REQUEST,
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
    expectOneDenied(log, 'admin-1');
  });

  it('refuses a principal that is not the session user', async () => {
    const { service, calls, log } = setup();
    const result = await service.unlinkIdentity(
      ctx,
      authenticated({ principal: { kind: 'user', id: 'other' } }),
      snapshot(),
      fence(),
      REQUEST,
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
    expectOneDenied(log, 'admin-1');
  });

  it('refuses a missing authenticated session before any write', async () => {
    const missing = [
      null,
      undefined,
      { principal: { kind: 'user', id: 'admin-1' } },
      authenticated({ sessionId: '' }),
    ] as unknown as AuthenticatedSession[];
    for (const value of missing) {
      const { service, calls, log } = setup();
      expect(await service.unlinkIdentity(ctx, value, snapshot(), fence(), REQUEST, call)).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(calls).toHaveLength(0);
      expect(deniedEvents(log)).toHaveLength(1);
      expectNoLeak(log.mock.calls);
    }
  });

  it('refuses a snapshot that does not belong to the authenticated session', async () => {
    const foreign = [
      snapshot({ session: { id: 'session-2', userId: 'admin-1' } }),
      snapshot({ session: { id: 'session-1', userId: 'admin-2' }, user: { id: 'admin-2' } }),
      snapshot({ session: { id: '' } }),
      null,
    ] as unknown as ActorAccessSnapshot[];
    for (const value of foreign) {
      const { service, calls, log } = setup();
      expect(
        await service.unlinkIdentity(ctx, authenticated(), value, fence(), REQUEST, call),
      ).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(calls).toHaveLength(0);
      expectOneDenied(log, 'admin-1');
    }
  });

  it('refuses a fence issued for another user or session', async () => {
    for (const f of [fence('admin-2'), fence('admin-1', 'session-2')]) {
      const { service, calls, log } = setup();
      expect(
        await service.unlinkIdentity(ctx, authenticated(), snapshot(), f, REQUEST, call),
      ).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(calls).toHaveLength(0);
      expectOneDenied(log, 'admin-1');
    }
  });

  it('requires a mutation fence', async () => {
    const { service, calls } = setup();
    for (const f of [null, undefined, {}]) {
      await expect(
        service.unlinkIdentity(ctx, authenticated(), snapshot(), f as never, REQUEST, call),
      ).rejects.toThrow(TypeError);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses invalid input with one code and no detail', async () => {
    const { service, calls, anchors } = setup();
    const bad: UnlinkIdentityRequest[] = [
      { ...REQUEST, identityId: '' },
      { ...REQUEST, userId: '' },
      { ...REQUEST, provider: 'Bad Provider!' },
      { ...REQUEST, subject: '' },
      { ...REQUEST, subject: 'a\u0000b' },
      { ...REQUEST, identityId: 7 as unknown as string },
      null as unknown as UnlinkIdentityRequest,
    ];
    for (const input of bad) {
      expect(
        await service.unlinkIdentity(ctx, authenticated(), snapshot(), fence(), input, call),
      ).toEqual({
        ok: false,
        error: 'invalid_input',
      });
    }
    expect(calls).toHaveLength(0);
    expect(anchors).not.toHaveBeenCalled();
  });

  it('refuses a provider with no configured anchor as a conflict, without naming it', async () => {
    const { service, calls, log } = setup({ anchors: [] });
    const result = await service.unlinkIdentity(
      ctx,
      authenticated(),
      snapshot(),
      fence(),
      REQUEST,
      call,
    );
    expect(result).toEqual({ ok: false, error: 'conflict' });
    expectNoLeak(result);
    expectNoLeak(log.mock.calls);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['conflict', 'conflict'],
    ['last_holder', 'last_holder'],
    ['indeterminate', 'indeterminate'],
  ] as const)('maps a %s outcome to %s with no event', async (outcome, error) => {
    const { service, log } = setup({ outcome });
    const result = await service.unlinkIdentity(
      ctx,
      authenticated(),
      snapshot(),
      fence(),
      REQUEST,
      call,
    );
    expect(result).toEqual({ ok: false, error });
    expectNoLeak(result);
    expect(log).not.toHaveBeenCalled();
  });

  it('maps a batch authority refusal to forbidden with one warn event and no leak', async () => {
    const { service, log } = setup({ outcome: 'authority' });
    const result = await service.unlinkIdentity(
      ctx,
      authenticated(),
      snapshot(),
      fence(),
      REQUEST,
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expectNoLeak(result);
    expectOneDenied(log, 'admin-1');
  });

  it('reports reauth_required when the batch refused authority after the window closed', async () => {
    let now = Date.parse(NOW);
    const clock = { now: () => new Date(now) };
    const { service, log } = setup({
      clock,
      store: () => {
        now += REAUTH_WINDOW_MS + 1;
        return Promise.resolve('authority');
      },
    });
    expect(
      await service.unlinkIdentity(ctx, authenticated(), snapshot(), fence(), REQUEST, call),
    ).toEqual({ ok: false, error: 'reauth_required' });
    expect(log).not.toHaveBeenCalled();
  });

  it('does not expose an unblock operation', () => {
    const { service } = setup();
    expect('unblockIdentity' in service).toBe(false);
  });
});

const UNBLOCK: UnblockIdentityRequest = { provider: PROVIDER, issuer: ANCHOR, subject: SUBJECT };

function setupUnblock(
  options: {
    outcome?: UnblockStoreOutcome;
    now?: string;
    clock?: Clock;
    store?: IdentityBlockStore['unblock'];
  } = {},
) {
  const clock = options.clock ?? fixedClock(options.now ?? NOW);
  const sessions = createSessionService({
    sessions: {} as never,
    clock,
    publicOrigin: 'https://broker.example.test',
  });
  const calls: { fence: MutationFence; request: UnblockIdentityRequest; audit: AuditEvent }[] = [];
  const blocks: IdentityBlockStore = {
    unblock: (c, f, request, audit) => {
      calls.push({ fence: f, request, audit });
      return options.store
        ? options.store(c, f, request, audit)
        : Promise.resolve(options.outcome ?? 'unblocked');
    },
  };
  const log = vi.fn();
  const service = createUnblockService({ blocks, sessions, clock, log });
  return { service, calls, log };
}

function expectNoBlockLeak(value: unknown): void {
  const text = serialized(value);
  expect(text).not.toContain(SUBJECT);
  expect(text).not.toContain(ANCHOR);
}

function expectOneUnblockDenied(
  log: ReturnType<typeof vi.fn>,
  actorUserId: string | null,
  provider: string | null,
): void {
  expect(log.mock.calls).toEqual([
    [{ level: 'warn', event: 'identity.unblock_denied', orgId: 'org-a', actorUserId, provider }],
  ]);
  expectNoBlockLeak(log.mock.calls);
  if (provider === null) expectNoLeak(log.mock.calls);
}

describe('unblockIdentity success', () => {
  it('unblocks through the fence with the validated request', async () => {
    const { service, calls } = setupUnblock();
    const f = fence();
    const result = await service.unblockIdentity(
      ctx,
      authenticated(),
      snapshot(),
      f,
      UNBLOCK,
      call,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fence).toBe(f);
    expect(calls[0]?.request).toEqual(UNBLOCK);
  });

  it('stamps the audit row with the injected clock', async () => {
    const now = '2026-10-16T12:03:04.567Z';
    const { service, calls } = setupUnblock({ now });
    await service.unblockIdentity(
      ctx,
      authenticated({ reauthAt: now }),
      snapshot(),
      fence(),
      UNBLOCK,
      call,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.audit.occurredAt).toBe(now);
  });

  it('emits exactly one info event with ids only', async () => {
    const { service, log } = setupUnblock();
    await service.unblockIdentity(ctx, authenticated(), snapshot(), fence(), UNBLOCK, call);
    expect(log.mock.calls).toEqual([
      [
        {
          level: 'info',
          event: 'identity.unblocked',
          orgId: 'org-a',
          actorUserId: 'admin-1',
          provider: PROVIDER,
        },
      ],
    ]);
    expectNoBlockLeak(log.mock.calls);
  });

  it('accepts reauth exactly at the window edge and refuses one millisecond past it', async () => {
    const reauthAt = new Date(Date.parse(NOW) - REAUTH_WINDOW_MS).toISOString();
    const edge = setupUnblock();
    expect(
      await edge.service.unblockIdentity(
        ctx,
        authenticated({ reauthAt }),
        snapshot(),
        fence(),
        UNBLOCK,
        call,
      ),
    ).toEqual({ ok: true });
    const late = setupUnblock({ now: new Date(Date.parse(NOW) + 1).toISOString() });
    expect(
      await late.service.unblockIdentity(
        ctx,
        authenticated({ reauthAt }),
        snapshot(),
        fence(),
        UNBLOCK,
        call,
      ),
    ).toEqual({ ok: false, error: 'reauth_required' });
    expect(late.calls).toHaveLength(0);
  });

  it('keeps a successful unblock successful when the log sink throws', async () => {
    const { service, log } = setupUnblock();
    log.mockImplementation(() => {
      throw new Error('sink down');
    });
    expect(
      await service.unblockIdentity(ctx, authenticated(), snapshot(), fence(), UNBLOCK, call),
    ).toEqual({ ok: true });
  });

  it('is a separate service from unlink', () => {
    const { service } = setupUnblock();
    expect('unlinkIdentity' in service).toBe(false);
  });
});

describe('unblockIdentity snapshots its inputs once', () => {
  it('validates and stores the first read of each request field', async () => {
    const { service, calls } = setupUnblock();
    const reads: Record<string, number> = {};
    const first: Record<string, string> = { ...UNBLOCK };
    const later: Record<string, string> = {
      provider: 'other',
      issuer: 'not-an-anchor',
      subject: 'a\u0000b',
    };
    const request = {} as Record<string, string>;
    for (const key of Object.keys(first)) {
      Object.defineProperty(request, key, {
        enumerable: true,
        get() {
          reads[key] = (reads[key] ?? 0) + 1;
          return reads[key] === 1 ? first[key] : later[key];
        },
      });
    }
    const result = await service.unblockIdentity(
      ctx,
      authenticated(),
      snapshot(),
      fence(),
      request as unknown as UnblockIdentityRequest,
      call,
    );
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.request).toEqual(UNBLOCK);
    expect(Object.values(reads)).toEqual([1, 1, 1]);
  });

  it('reads the session reauth time once', async () => {
    const { service, calls } = setupUnblock();
    const auth = authenticated();
    let reads = 0;
    Object.defineProperty(auth.session, 'reauthAt', {
      get() {
        reads += 1;
        return reads === 1 ? NOW : null;
      },
    });
    expect(await service.unblockIdentity(ctx, auth, snapshot(), fence(), UNBLOCK, call)).toEqual({
      ok: true,
    });
    expect(reads).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe('unblockIdentity refusals', () => {
  it('refuses a session that never reauthenticated, with no event', async () => {
    const { service, calls, log } = setupUnblock();
    expect(
      await service.unblockIdentity(
        ctx,
        authenticated({ reauthAt: null }),
        snapshot(),
        fence(),
        UNBLOCK,
        call,
      ),
    ).toEqual({ ok: false, error: 'reauth_required' });
    expect(calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses a protected holder without org:users:write before reauth or input checks', async () => {
    const { service, calls, log } = setupUnblock();
    expect(
      await service.unblockIdentity(
        ctx,
        authenticated({ reauthAt: null }),
        snapshot({ organizationPermissions: ['org:users:read'] }),
        fence(),
        { ...UNBLOCK, subject: '' },
        call,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
    expectOneUnblockDenied(log, 'admin-1', null);
  });

  it('refuses a non-admin holding org:users:write, even with a fresh session', async () => {
    const { service, calls, log } = setupUnblock();
    expect(
      await service.unblockIdentity(
        ctx,
        authenticated(),
        snapshot({ protectedHolder: false }),
        fence(),
        UNBLOCK,
        call,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
    expectOneUnblockDenied(log, 'admin-1', null);
  });

  it('gives project-scoped org-looking permissions no authority', async () => {
    const { service, calls } = setupUnblock();
    expect(
      await service.unblockIdentity(
        ctx,
        authenticated(),
        snapshot({
          organizationPermissions: [],
          projectPermissions: ['org:users:write', 'org:*'],
          protectedHolder: false,
        }),
        fence(),
        UNBLOCK,
        call,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
  });

  it.each(['service', 'customer'])('refuses a %s token principal', async (kind) => {
    const { service, calls, log } = setupUnblock();
    expect(
      await service.unblockIdentity(
        ctx,
        authenticated({ principal: { kind, id: 'admin-1' } }),
        snapshot(),
        fence(),
        UNBLOCK,
        call,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
    expectOneUnblockDenied(log, 'admin-1', null);
  });

  it('refuses a missing session, a foreign snapshot or a foreign fence before any write', async () => {
    const cases: [AuthenticatedSession, ActorAccessSnapshot | null, MutationFence][] = [
      [null as unknown as AuthenticatedSession, snapshot(), fence()],
      [authenticated({ sessionId: '' }), snapshot(), fence()],
      [authenticated(), snapshot({ session: { id: 'session-2', userId: 'admin-1' } }), fence()],
      [authenticated(), null, fence()],
      [authenticated(), snapshot(), fence('admin-2')],
      [authenticated(), snapshot(), fence('admin-1', 'session-2')],
    ];
    for (const [auth, snap, f] of cases) {
      const { service, calls, log } = setupUnblock();
      expect(
        await service.unblockIdentity(ctx, auth, snap as ActorAccessSnapshot, f, UNBLOCK, call),
      ).toEqual({ ok: false, error: 'forbidden' });
      expect(calls).toHaveLength(0);
      expect(log).toHaveBeenCalledTimes(1);
      expectNoLeak(log.mock.calls);
    }
  });

  it('requires a mutation fence', async () => {
    const { service, calls } = setupUnblock();
    for (const f of [null, undefined, {}]) {
      await expect(
        service.unblockIdentity(ctx, authenticated(), snapshot(), f as never, UNBLOCK, call),
      ).rejects.toThrow('identity unblock requires a mutation fence');
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses invalid input with one code and no detail', async () => {
    const { service, calls, log } = setupUnblock();
    const bad: UnblockIdentityRequest[] = [
      { ...UNBLOCK, provider: 'Bad Provider!' },
      { ...UNBLOCK, issuer: 'not-an-anchor' },
      { ...UNBLOCK, issuer: 7 as unknown as string },
      { ...UNBLOCK, subject: '' },
      { ...UNBLOCK, subject: 'a\u0000b' },
      null as unknown as UnblockIdentityRequest,
    ];
    for (const input of bad) {
      expect(
        await service.unblockIdentity(ctx, authenticated(), snapshot(), fence(), input, call),
      ).toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 'not_found'],
    ['indeterminate', 'indeterminate'],
  ] as const)('maps a %s outcome to %s with no event', async (outcome, error) => {
    const { service, log } = setupUnblock({ outcome });
    const result = await service.unblockIdentity(
      ctx,
      authenticated(),
      snapshot(),
      fence(),
      UNBLOCK,
      call,
    );
    expect(result).toEqual({ ok: false, error });
    expectNoLeak(result);
    expect(log).not.toHaveBeenCalled();
  });

  it('maps a batch authority refusal to forbidden with one warn event and no leak', async () => {
    const { service, log } = setupUnblock({ outcome: 'authority' });
    const result = await service.unblockIdentity(
      ctx,
      authenticated(),
      snapshot(),
      fence(),
      UNBLOCK,
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expectNoLeak(result);
    expectOneUnblockDenied(log, 'admin-1', PROVIDER);
  });

  function reauthCheckingStore(advanceMs: number) {
    let now = Date.parse(NOW);
    const clock = { now: () => new Date(now) };
    const store: IdentityBlockStore['unblock'] = () => {
      now += advanceMs;
      const fresh = now - Date.parse(NOW) <= REAUTH_WINDOW_MS;
      return Promise.resolve(fresh ? 'unblocked' : 'authority');
    };
    return { clock, store };
  }

  it('reports reauth_required when the window closes between the service check and the batch', async () => {
    const { service, log } = setupUnblock(reauthCheckingStore(REAUTH_WINDOW_MS + 1));
    expect(
      await service.unblockIdentity(ctx, authenticated(), snapshot(), fence(), UNBLOCK, call),
    ).toEqual({ ok: false, error: 'reauth_required' });
    expect(log).not.toHaveBeenCalled();
  });

  it('unblocks when the window is still open at the batch', async () => {
    const { service } = setupUnblock(reauthCheckingStore(REAUTH_WINDOW_MS));
    expect(
      await service.unblockIdentity(ctx, authenticated(), snapshot(), fence(), UNBLOCK, call),
    ).toEqual({ ok: true });
  });

  it('throws on an outcome the store must never answer', async () => {
    const { service } = setupUnblock({ outcome: 'conflict' as unknown as UnblockStoreOutcome });
    await expect(
      service.unblockIdentity(ctx, authenticated(), snapshot(), fence(), UNBLOCK, call),
    ).rejects.toThrow('identity unblock answered an unknown outcome');
  });
});

describe('identity audit events', () => {
  const ADMIN_EMAIL = 'admin@example.test';

  function expectNoIdpDetail(event: AuditEvent | undefined): void {
    expect(event).toBeDefined();
    for (const text of [serialized(event), event!.payloadJson]) {
      expect(text).not.toContain(SUBJECT);
      expect(text).not.toContain(ANCHOR);
      expect(text).not.toContain(ADMIN_EMAIL);
      expect(text).not.toContain('@');
    }
  }

  function payload(event: AuditEvent | undefined): unknown {
    return JSON.parse(event!.payloadJson);
  }

  it('names the block, not the IdP subject, as the unblock target and carries the provider', async () => {
    const { service, calls } = setupUnblock();
    await service.unblockIdentity(ctx, authenticated(), snapshot(), fence(), UNBLOCK, call);
    expect(calls[0]?.audit).toMatchObject({
      action: 'identity.unblock',
      actor: { type: 'user', id: 'admin-1' },
      target: { type: 'identity_block', id: null },
      projectId: null,
    });
    expect(payload(calls[0]?.audit)).toEqual({
      op_id: call.audit.opId,
      request_id: call.audit.requestId,
      changes: { provider: { new: UNBLOCK.provider } },
    });
    expectNoIdpDetail(calls[0]?.audit);
  });

  it('targets the affected broker user on the unlink and block rows and carries the provider', async () => {
    const { service, calls } = setup();
    await service.unlinkIdentity(ctx, authenticated(), snapshot(), fence(), REQUEST, call);
    const audit = calls[0]?.audit;
    for (const [event, action] of [
      [audit?.unlink, 'identity.unlink'],
      [audit?.block, 'identity.block'],
    ] as const) {
      expect(event).toMatchObject({
        action,
        actor: { type: 'user', id: 'admin-1' },
        target: { type: 'user', id: REQUEST.userId },
        projectId: null,
      });
      expect(payload(event)).toEqual({
        op_id: call.audit.opId,
        request_id: call.audit.requestId,
        changes: { provider: { new: PROVIDER } },
      });
      expectNoIdpDetail(event);
    }
    expect(audit?.unlink.id).not.toBe(audit?.block.id);
  });

  it('names the user whose identity is unlinked, not the acting admin', async () => {
    const { service, calls } = setup();
    const request = { ...REQUEST, userId: 'user-77' };
    await service.unlinkIdentity(ctx, authenticated(), snapshot(), fence(), request, call);
    expect(calls[0]?.audit.unlink.target).toEqual({ type: 'user', id: 'user-77' });
    expect(calls[0]?.audit.block.target).toEqual({ type: 'user', id: 'user-77' });
  });

  it.each([
    'k8s3jd9fh2kd8sj3hd8sk2jd9fk3ls8d',
    '01j0user000000000000000009',
    'glpat-abcdefghijklmnop1234',
    'xoxb-1234-abcdefgh',
  ])('writes the unlink, block and unblock rows for the provider id %s', async (provider) => {
    const anchors = [{ provider, anchor: ANCHOR, emailAuthoritative: true }];
    const unlink = setup({ anchors });
    expect(
      await unlink.service.unlinkIdentity(
        ctx,
        authenticated(),
        snapshot(),
        fence(),
        { ...REQUEST, provider },
        call,
      ),
    ).toEqual({ ok: true });
    const unblock = setupUnblock();
    expect(
      await unblock.service.unblockIdentity(
        ctx,
        authenticated(),
        snapshot(),
        fence(),
        { ...UNBLOCK, provider },
        call,
      ),
    ).toEqual({ ok: true });
    for (const event of [
      unlink.calls[0]?.audit.unlink,
      unlink.calls[0]?.audit.block,
      unblock.calls[0]?.audit,
    ]) {
      expect(payload(event)).toMatchObject({ changes: { provider: { new: provider } } });
      expectNoIdpDetail(event);
    }
  });
});
