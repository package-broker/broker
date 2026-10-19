import type { TokenRevokeService, TokenRevokeStore } from './token-revoke.js';
import type { ApiCall } from '../api/idempotency.js';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AuthenticatedSession } from '../auth/session.js';
import { orgContext, type OrgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import { mutationFence, type AuthenticatedActor, type FenceGuard } from './fence.js';
import { authenticateToken, type TokenAccessView } from './token-use.js';
import {
  createTokenRevokeService,
  type RevocableToken,
  type TokenRevokeDeps,
  type TokenRevokeOutcome,
} from './token-revoke.js';

const ctx = orgContext('org-a');
const NOW = '2026-10-16T12:00:00.000Z';
const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

const OWN_GUARD = Object.freeze([{ sql: 'select 1', params: ['own'] }]) as unknown as FenceGuard;
const AUTHORITY_GUARD = Object.freeze([
  { sql: 'select 1', params: ['authority'] },
]) as unknown as FenceGuard;

function session(overrides: { userId?: string; kind?: 'user' | 'service' | 'customer' } = {}) {
  const userId = overrides.userId ?? 'user-1';
  return {
    session: {
      id: 'session-1',
      userId,
      identityId: null,
      csrfHash: 'x',
      createdAt: NOW,
      expiresAt: '2026-10-17T12:00:00.000Z',
      lastSeenAt: NOW,
      reauthAt: null,
      user: { id: userId, email: 'u@example.test', displayName: null },
    },
    principal: { kind: overrides.kind ?? 'user', id: userId },
  } as unknown as AuthenticatedSession;
}

function fence(userId = 'user-1', sessionId = 'session-1') {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
}

function own(tokenId: string) {
  return { tokenId, routeProjectId: null, via: 'organization' as const };
}

function onProject(tokenId: string, routeProjectId = PROJECT_A) {
  return { tokenId, routeProjectId, via: 'project' as const };
}

type Stored = RevocableToken & { orgId: string; revokedAt: string | null; lastOpId: string | null };

const TOKENS: readonly (RevocableToken & { orgId?: string })[] = [
  { id: 'pat-own-all', kind: 'pat', userId: 'user-1', projectId: null, projectMode: 'all' },
  {
    id: 'pat-own-selected',
    kind: 'pat',
    userId: 'user-1',
    projectId: null,
    projectMode: 'selected',
  },
  { id: 'pat-other-all', kind: 'pat', userId: 'user-2', projectId: null, projectMode: 'all' },
  {
    id: 'pat-other-selected',
    kind: 'pat',
    userId: 'user-2',
    projectId: null,
    projectMode: 'selected',
  },
  { id: 'svc-a', kind: 'svc', userId: null, projectId: PROJECT_A, projectMode: null },
  { id: 'svc-b', kind: 'svc', userId: null, projectId: PROJECT_B, projectMode: null },
  { id: 'svc-org', kind: 'svc', userId: null, projectId: null, projectMode: null },
  {
    id: 'svc-foreign-org',
    kind: 'svc',
    userId: null,
    projectId: PROJECT_A,
    projectMode: null,
    orgId: 'org-b',
  },
];

interface Setup {
  readonly organization?: readonly string[];
  readonly projects?: Readonly<Record<string, readonly string[]>>;
  readonly revoke?: (tokenId: string) => TokenRevokeOutcome | undefined;
}

function setup(options: Setup = {}) {
  const rows = new Map<string, Stored>(
    TOKENS.map((token) => [
      token.id,
      { ...token, orgId: token.orgId ?? ctx.orgId, revokedAt: null, lastOpId: null } as Stored,
    ]),
  );
  let op = 0;
  const tokens = {
    get: vi.fn(async (scope: OrgContext, id: string): Promise<RevocableToken | null> => {
      const row = rows.get(id);
      if (row === undefined || row.orgId !== scope.orgId) return null;
      return {
        id: row.id,
        kind: row.kind,
        userId: row.userId,
        projectId: row.projectId,
        projectMode: row.projectMode,
      } as RevocableToken;
    }),
    revoke: vi.fn(
      async (
        scope: OrgContext,
        _fence: unknown,
        _guard: FenceGuard,
        { tokenId, now }: Parameters<TokenRevokeStore['revoke']>[3],
      ): Promise<TokenRevokeOutcome> => {
        const forced = options.revoke?.(tokenId);
        if (forced !== undefined) return forced;
        const row = rows.get(tokenId);
        if (row === undefined || row.orgId !== scope.orgId) return { status: 'not_found' };
        if (row.revokedAt !== null) return { status: 'already_revoked' };
        op += 1;
        row.revokedAt = now;
        row.lastOpId = `op-${op}`;
        return { status: 'revoked', opId: row.lastOpId };
      },
    ),
  };
  const organizationGrants = new Set(options.organization ?? []);
  const authority = {
    guard: vi.fn<TokenRevokeDeps['authority']['guard']>(() => AUTHORITY_GUARD),
    livePermissions: vi.fn(async (_ctx: unknown, _fence: unknown, projectId: string | null) => {
      const project = projectId === null ? [] : (options.projects?.[projectId] ?? []);
      return new Set([...organizationGrants, ...project]) as ReadonlySet<string>;
    }),
  };
  const ownership = {
    ownPersonalToken: vi.fn<TokenRevokeDeps['ownership']['ownPersonalToken']>(() => OWN_GUARD),
  };
  const log = vi.fn<(entry: Readonly<Record<string, unknown>>) => void>();
  const service = createTokenRevokeService({
    tokens,
    authority,
    ownership,
    clock: fixedClock(NOW),
    ids: { ulid: () => 'event-revoke' },
    log,
  });
  const events = () =>
    log.mock.calls.map(([entry]) => entry).filter((entry) => entry.event === 'token.revoked');
  return { service, tokens, authority, ownership, log, rows, events };
}

describe('own personal token', () => {
  it('revokes its own PAT with no project or organization grant at all', async () => {
    const { service, tokens, ownership, authority, rows, events } = setup();
    const held = fence();
    expect(await service.revoke(ctx, session(), held, own('pat-own-selected'), apiCall)).toEqual({
      ok: true,
      value: { revoked: true },
    });
    expect(tokens.get).toHaveBeenCalledWith(ctx, 'pat-own-selected');
    expect(ownership.ownPersonalToken).toHaveBeenCalledWith(ctx, held, 'pat-own-selected');
    expect(tokens.revoke).toHaveBeenCalledWith(ctx, held, OWN_GUARD, {
      audit: expect.objectContaining({ action: 'token.revoke' }),
      tokenId: 'pat-own-selected',
      now: NOW,
    });
    expect(authority.guard).not.toHaveBeenCalled();
    expect(rows.get('pat-own-selected')?.revokedAt).toBe(NOW);
    expect(events()).toEqual([
      {
        level: 'info',
        event: 'token.revoked',
        orgId: ctx.orgId,
        tokenId: 'pat-own-selected',
        kind: 'pat',
        projectId: null,
        via: 'own',
        actorUserId: 'user-1',
        opId: 'op-1',
      },
    ]);
  });

  it('revokes its own all-project PAT after losing every project membership', async () => {
    const { service, rows } = setup({ projects: {} });
    expect(
      await service.revoke(ctx, session(), fence(), own('pat-own-all'), apiCall),
    ).toMatchObject({
      ok: true,
    });
    expect(rows.get('pat-own-all')?.revokedAt).toBe(NOW);
  });

  it('does not treat another user PAT as own', async () => {
    const { service, tokens, ownership } = setup();
    expect(await service.revoke(ctx, session(), fence(), own('pat-other-all'), apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(ownership.ownPersonalToken).not.toHaveBeenCalled();
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  it('an unknown id on the own route answers like another user PAT', async () => {
    const { service } = setup();
    expect(await service.revoke(ctx, session(), fence(), own('missing'), apiCall)).toEqual(
      await service.revoke(ctx, session(), fence(), own('pat-other-all'), apiCall),
    );
  });
});

describe('project manager', () => {
  const manager = { projects: { [PROJECT_A]: ['project:tokens:revoke'] } };

  it('revokes a service token bound to the route project under an archived-tolerant guard', async () => {
    const { service, tokens, authority, rows, events } = setup(manager);
    const held = fence();
    expect(await service.revoke(ctx, session(), held, onProject('svc-a'), apiCall)).toMatchObject({
      ok: true,
    });
    expect(authority.guard).toHaveBeenCalledWith(ctx, held, {
      permission: 'project:tokens:revoke',
      projectId: PROJECT_A,
      organizationAdmin: false,
      covers: [],
      allowArchived: true,
    });
    expect(tokens.revoke).toHaveBeenCalledWith(ctx, held, AUTHORITY_GUARD, {
      audit: expect.objectContaining({ action: 'token.revoke' }),
      tokenId: 'svc-a',
      now: NOW,
    });
    expect(rows.get('svc-a')?.revokedAt).toBe(NOW);
    expect(events()[0]).toMatchObject({ via: 'project', projectId: PROJECT_A, kind: 'svc' });
  });

  it('answers one uniform not_found for unknown, foreign-project, org-wide and user tokens', async () => {
    const { service, tokens, rows, log } = setup(manager);
    for (const id of [
      'missing',
      'svc-b',
      'svc-org',
      'pat-other-all',
      'pat-other-selected',
      'svc-foreign-org',
    ]) {
      expect(await service.revoke(ctx, session(), fence(), onProject(id), apiCall)).toEqual({
        ok: false,
        error: 'not_found',
      });
    }
    expect(tokens.revoke).not.toHaveBeenCalled();
    expect(rows.get('pat-other-all')?.revokedAt).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('a token of another project addressed under the route project is not found', async () => {
    const { service, tokens } = setup({
      projects: { [PROJECT_A]: ['project:tokens:revoke'], [PROJECT_B]: ['project:tokens:revoke'] },
    });
    expect(
      await service.revoke(ctx, session(), fence(), onProject('svc-b', PROJECT_A), apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(tokens.revoke).not.toHaveBeenCalled();
    expect(
      await service.revoke(ctx, session(), fence(), onProject('svc-b', PROJECT_B), apiCall),
    ).toMatchObject({ ok: true });
  });

  it('probes project authority the same number of times whether or not the id exists', async () => {
    const counts: number[] = [];
    for (const id of ['missing', 'svc-b', 'pat-other-all', 'svc-a']) {
      const { service, authority } = setup({ projects: {} });
      await service.revoke(ctx, session(), fence(), onProject(id), apiCall);
      counts.push(authority.livePermissions.mock.calls.length);
      expect(authority.livePermissions).toHaveBeenLastCalledWith(ctx, expect.anything(), PROJECT_A);
    }
    expect(new Set(counts)).toEqual(new Set([2]));
  });

  it('without project:tokens:revoke every id is forbidden, existing or not', async () => {
    const { service, tokens } = setup({
      projects: { [PROJECT_A]: ['project:tokens:read', 'project:tokens:create'] },
    });
    for (const id of ['svc-a', 'missing', 'pat-other-all']) {
      expect(await service.revoke(ctx, session(), fence(), onProject(id), apiCall)).toEqual({
        ok: false,
        error: 'forbidden',
      });
    }
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  it('project authority does not reach a service token on the organization route', async () => {
    const { service, tokens } = setup(manager);
    expect(await service.revoke(ctx, session(), fence(), own('svc-a'), apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(tokens.revoke).not.toHaveBeenCalled();
  });
});

describe('organization authority', () => {
  const admin = { organization: ['org:tokens:revoke'] };

  it.each(
    TOKENS.filter((token) => token.userId !== 'user-1' && token.orgId === undefined).map(
      (token) => token.id,
    ),
  )('org:tokens:revoke revokes %s', async (id) => {
    const { service, tokens, authority, rows, events } = setup(admin);
    const held = fence();
    expect(await service.revoke(ctx, session(), held, own(id), apiCall)).toMatchObject({
      ok: true,
    });
    expect(authority.guard).toHaveBeenCalledWith(ctx, held, {
      permission: 'org:tokens:revoke',
      projectId: null,
      organizationAdmin: false,
      covers: [],
    });
    expect(tokens.revoke).toHaveBeenCalledWith(ctx, held, AUTHORITY_GUARD, {
      audit: expect.objectContaining({ action: 'token.revoke' }),
      tokenId: id,
      now: NOW,
    });
    expect(rows.get(id)?.revokedAt).toBe(NOW);
    expect(events()[0]).toMatchObject({ via: 'organization', tokenId: id });
  });

  it('reports an unknown id as not_found to an organization revoker', async () => {
    const { service, tokens } = setup(admin);
    expect(await service.revoke(ctx, session(), fence(), own('missing'), apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  it('a token id of another organization behaves like an unknown id', async () => {
    const { service, tokens, rows } = setup(admin);
    expect(await service.revoke(ctx, session(), fence(), own('svc-foreign-org'), apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(tokens.get).toHaveBeenCalledWith(ctx, 'svc-foreign-org');
    expect(tokens.revoke).not.toHaveBeenCalled();
    expect(rows.get('svc-foreign-org')?.revokedAt).toBeNull();
  });

  it('a route project that differs from the binding behaves like an unknown id', async () => {
    const { service, tokens } = setup(admin);
    expect(
      await service.revoke(ctx, session(), fence(), onProject('svc-b', PROJECT_A), apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(
      await service.revoke(ctx, session(), fence(), onProject('pat-other-all'), apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  it('org:tokens:read alone revokes nothing', async () => {
    const { service, tokens } = setup({ organization: ['org:tokens:read'] });
    expect(await service.revoke(ctx, session(), fence(), own('svc-org'), apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(tokens.revoke).not.toHaveBeenCalled();
  });
});

describe('sessions only', () => {
  it.each(['service', 'customer'] as const)(
    'a %s credential cannot revoke anything, not even with the permission',
    async (kind) => {
      const { service, tokens } = setup({
        organization: ['org:tokens:revoke'],
        projects: { [PROJECT_A]: ['project:tokens:revoke'] },
      });
      for (const input of [onProject('svc-a'), own('svc-org'), own('pat-own-all')]) {
        expect(await service.revoke(ctx, session({ kind }), fence(), input, apiCall)).toEqual({
          ok: false,
          error: 'forbidden',
        });
      }
      expect(tokens.revoke).not.toHaveBeenCalled();
    },
  );

  it('rejects a fence that does not belong to the session', async () => {
    const { service, tokens } = setup();
    await expect(
      service.revoke(ctx, session(), fence('user-1', 'session-2'), own('pat-own-all'), apiCall),
    ).rejects.toThrow(TypeError);
    await expect(
      service.revoke(ctx, session(), fence('user-2'), own('pat-own-all'), apiCall),
    ).rejects.toThrow(TypeError);
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  it('rejects an empty route project id', async () => {
    const { service } = setup();
    await expect(
      service.revoke(
        ctx,
        session(),
        fence(),
        { tokenId: 'svc-a', routeProjectId: '', via: 'project' },
        apiCall,
      ),
    ).rejects.toThrow(TypeError);
  });

  it('refuses an empty token id without reading', async () => {
    const { service, tokens } = setup({ organization: ['org:tokens:revoke'] });
    expect(await service.revoke(ctx, session(), fence(), own(''), apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(tokens.get).not.toHaveBeenCalled();
  });

  it('a session that died before the batch is unauthenticated, with no denial event', async () => {
    const { service, log } = setup({ revoke: () => ({ status: 'refused', reason: 'authority' }) });
    expect(await service.revoke(ctx, session(), fence(), own('pat-own-all'), apiCall)).toEqual({
      ok: false,
      error: 'unauthenticated',
    });
    expect(log).not.toHaveBeenCalled();
  });
});

describe('idempotency and batch outcomes', () => {
  it('a repeated revoke succeeds with one revoked_at and one event', async () => {
    const { service, rows, events, tokens } = setup();
    expect(
      await service.revoke(ctx, session(), fence(), own('pat-own-all'), apiCall),
    ).toMatchObject({
      ok: true,
      value: { revoked: true },
    });
    const first = rows.get('pat-own-all')?.revokedAt;
    expect(await service.revoke(ctx, session(), fence(), own('pat-own-all'), apiCall)).toEqual({
      ok: true,
      value: { revoked: false },
    });
    expect(rows.get('pat-own-all')?.revokedAt).toBe(first);
    expect(rows.get('pat-own-all')?.lastOpId).toBe('op-1');
    expect(tokens.revoke).toHaveBeenCalledTimes(2);
    expect(events()).toHaveLength(1);
  });

  it('two revokes in flight together produce one event', async () => {
    const { service, events } = setup({ organization: ['org:tokens:revoke'] });
    const results = await Promise.all([
      service.revoke(ctx, session(), fence(), own('svc-a'), apiCall),
      service.revoke(ctx, session(), fence(), own('svc-a'), apiCall),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(events()).toHaveLength(1);
  });

  it.each(['conflict', 'collision', 'unclassified'] as const)(
    'a guard lost with a live session (%s) is forbidden',
    async (reason) => {
      const { service, events, log } = setup({
        projects: { [PROJECT_A]: ['project:tokens:revoke'] },
        revoke: () => ({ status: 'refused', reason }),
      });
      expect(await service.revoke(ctx, session(), fence(), onProject('svc-a'), apiCall)).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(events()).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'token.revoke_denied' }));
    },
  );

  it('a token deleted between pre-read and batch is not found', async () => {
    const { service } = setup({
      projects: { [PROJECT_A]: ['project:tokens:revoke'] },
      revoke: () => ({ status: 'not_found' }),
    });
    expect(await service.revoke(ctx, session(), fence(), onProject('svc-a'), apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('a lost response is indeterminate and emits no event', async () => {
    const { service, events } = setup({ revoke: () => ({ status: 'indeterminate' }) });
    expect(await service.revoke(ctx, session(), fence(), own('pat-own-all'), apiCall)).toEqual({
      ok: false,
      error: 'indeterminate',
    });
    expect(events()).toEqual([]);
  });

  it('a failing log sink does not turn a stored revoke into a failure', async () => {
    const { service, log, rows } = setup();
    log.mockImplementation(() => {
      throw new Error('sink down');
    });
    expect(
      await service.revoke(ctx, session(), fence(), own('pat-own-all'), apiCall),
    ).toMatchObject({
      ok: true,
    });
    expect(rows.get('pat-own-all')?.revokedAt).toBe(NOW);
  });
});

describe('effect on use', () => {
  const keyring = createKeyring([
    { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
  ]);
  const presented = formatToken(
    'pat',
    'abcdefghijkl',
    Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1),
  );

  it('a revoked token denies on the next request', async () => {
    const { service, rows } = setup();
    const secretHash = await hashToken(keyring, 1, presented);
    const lookup = async (): Promise<TokenAccessView> => {
      const row = rows.get('pat-own-all');
      return Object.defineProperty(
        {
          token: {
            id: 'pat-own-all',
            kind: 'pat' as const,
            expired: false,
            revoked: row?.revokedAt !== null,
            lastUsedAt: NOW,
          },
          principalStatus: 'active',
        },
        'verifier',
        { value: { secretHash, pepperVersion: 1 }, enumerable: false },
      ) as TokenAccessView;
    };
    const deps = {
      keyring,
      nowMs: () => Date.parse(NOW),
      touch: async () => true,
      dispatch: () => undefined,
      log: () => undefined,
    };
    expect(await authenticateToken(deps, presented, lookup, () => true)).toMatchObject({
      ok: true,
    });
    await service.revoke(ctx, session(), fence(), own('pat-own-all'), apiCall);
    expect(await authenticateToken(deps, presented, lookup, () => true)).toEqual({
      ok: false,
      reason: 'unauthorized',
      diagnostic: 'revoked',
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
  it.each(['pat-own-all', 'svc-a', 'svc-org'])('passes one revoke candidate for %s', async (id) => {
    const r = setup({ organization: ['org:tokens:revoke'] });
    const call = { ...apiCall, idempotency: revokeRecord };
    expect(await r.service.revoke(ctx, session(), fence(), own(id), call)).toEqual({
      ok: true,
      value: { revoked: true },
    });
    expect(r.tokens.revoke).toHaveBeenCalledTimes(1);
    const stored = r.tokens.revoke.mock.calls[0]![3];
    expect(stored.audit).toEqual({
      id: 'event-revoke',
      occurredAt: NOW,
      action: 'token.revoke',
      actor: { type: 'user', id: 'user-1' },
      target: { type: 'token', id },
      projectId: id === 'svc-a' ? PROJECT_A : null,
      sourceIp: null,
      tokenSelector: null,
      payloadJson: JSON.stringify({
        op_id: apiCall.audit.opId,
        request_id: apiCall.audit.requestId,
      }),
    });
    expect(stored.idempotency).toBe(revokeRecord);
  });

  it('a repeat only forwards its candidate and adds no audit log or extra store call', async () => {
    const r = setup({ revoke: () => ({ status: 'already_revoked' }) });
    expect(await r.service.revoke(ctx, session(), fence(), own('pat-own-all'), apiCall)).toEqual({
      ok: true,
      value: { revoked: false },
    });
    expect(r.tokens.revoke).toHaveBeenCalledTimes(1);
    expect(r.tokens.revoke.mock.calls[0]![3].audit).toMatchObject({ action: 'token.revoke' });
    expect(r.tokens.revoke.mock.calls[0]![3]).not.toHaveProperty('idempotency');
    expect(r.log).not.toHaveBeenCalled();
  });

  it('does not retry an indeterminate revoke', async () => {
    const r = setup({ revoke: () => ({ status: 'indeterminate' }) });
    expect(await r.service.revoke(ctx, session(), fence(), own('pat-own-all'), apiCall)).toEqual({
      ok: false,
      error: 'indeterminate',
    });
    expect(r.tokens.revoke).toHaveBeenCalledTimes(1);
  });

  it('requires the revoke call argument', () => {
    expectTypeOf<Parameters<TokenRevokeService['revoke']>['length']>().toEqualTypeOf<5>();
  });
});
const revokeRecord = {
  principalKey: 'user:user-1',
  key: 'revoke',
  route: '/tokens/revoke',
  requestHash: 'hash',
  status: 200,
  responseJson: '{}',
  createdAt: NOW,
  expiresAt: '2026-10-17T12:00:00.000Z',
};

describe('explicit own route', () => {
  it.each(['pat-other-all', 'svc-a', 'svc-org', 'missing'])(
    'hides %s even from an organization revoker',
    async (tokenId) => {
      const r = setup({ organization: ['org:tokens:revoke'] });
      expect(
        await r.service.revoke(
          ctx,
          session(),
          fence(),
          {
            tokenId,
            routeProjectId: null,
            via: 'own',
          },
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'not_found' });
      expect(r.tokens.revoke).not.toHaveBeenCalled();
      expect(r.authority.livePermissions).not.toHaveBeenCalled();
      expect(r.authority.guard).not.toHaveBeenCalled();
      expect(r.ownership.ownPersonalToken).not.toHaveBeenCalled();
      expect(r.rows.get(tokenId)?.revokedAt ?? null).toBeNull();
      expect(r.log).not.toHaveBeenCalled();
    },
  );

  it('revokes its own PAT and reports a repeat as unchanged', async () => {
    const r = setup();
    const input = { tokenId: 'pat-own-all', routeProjectId: null, via: 'own' as const };
    expect(await r.service.revoke(ctx, session(), fence(), input, apiCall)).toEqual({
      ok: true,
      value: { revoked: true },
    });
    expect(r.rows.get(input.tokenId)?.revokedAt).toBe(NOW);
    expect(await r.service.revoke(ctx, session(), fence(), input, apiCall)).toEqual({
      ok: true,
      value: { revoked: false },
    });
    expect(r.authority.livePermissions).not.toHaveBeenCalled();
    expect(r.events()).toHaveLength(1);
  });
});

describe('route consistency', () => {
  it.each(['bogus' as never, undefined as never])(
    'rejects unknown via %s before store, authority or ownership calls',
    async (via) => {
      const r = setup({ organization: ['org:tokens:revoke'] });
      await expect(
        r.service.revoke(
          ctx,
          session(),
          fence(),
          { tokenId: 'svc-org', routeProjectId: null, via },
          apiCall,
        ),
      ).rejects.toThrow(TypeError);
      expect(r.tokens.get).not.toHaveBeenCalled();
      expect(r.tokens.revoke).not.toHaveBeenCalled();
      expect(r.authority.livePermissions).not.toHaveBeenCalled();
      expect(r.authority.guard).not.toHaveBeenCalled();
      expect(r.ownership.ownPersonalToken).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['own', PROJECT_A],
    ['organization', PROJECT_A],
    ['project', null],
  ] as const)(
    'rejects %s with routeProjectId %s before store or authority calls',
    async (via, routeProjectId) => {
      const r = setup({ organization: ['org:tokens:revoke'] });
      await expect(
        r.service.revoke(
          ctx,
          session(),
          fence(),
          {
            tokenId: 'svc-a',
            routeProjectId,
            via,
          },
          apiCall,
        ),
      ).rejects.toThrow(TypeError);
      expect(r.tokens.get).not.toHaveBeenCalled();
      expect(r.tokens.revoke).not.toHaveBeenCalled();
      expect(r.authority.livePermissions).not.toHaveBeenCalled();
      expect(r.authority.guard).not.toHaveBeenCalled();
      expect(r.ownership.ownPersonalToken).not.toHaveBeenCalled();
    },
  );
});
