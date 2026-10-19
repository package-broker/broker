import { describe, expect, it } from 'vitest';
import type { AuthenticatedSession } from '../auth/session.js';
import { orgContext } from '../db/port.js';
import type { Organization } from '../db/organization.js';
import { fixedClock } from '../ids.js';
import type { AuthorizationRequest } from '../kernel/authorize.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import type { ActorContext } from './administration.js';
import { createAuthorizationEngine, patValidationGate } from './engine.js';
import type { AuthorizationEngineDeps, EngineTokenAccess } from './engine.js';
import { mutationFence, type AuthenticatedActor } from './fence.js';
import {
  createPersonalTokenService,
  type IssuePersonalTokenCall,
  type PersonalTokenIssueInput,
  type PersonalTokenIssueOutcome,
  type PersonalTokenServiceDeps,
} from './pat-service.js';
import { PERMISSIONS } from './permissions.js';
import { SCOPE_LEVELS, tokenEffectivePermissions, type ScopeLevel } from './scope.js';
import type { ServicePrincipalRecord } from './service-principal-service.js';
import {
  createServiceTokenService,
  type IssueServiceTokenCall,
  type ServiceTokenIssueInput,
  type ServiceTokenIssueOutcome,
  type ServiceTokenServiceDeps,
} from './service-token-service.js';

const ctx = orgContext('org-a');
const NOW = '2026-10-16T12:00:00.000Z';
const DAY = 86_400_000;
const ORIGIN = 'https://broker.test';
const keyring = createKeyring([
  { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
]);

const ALL = PERMISSIONS.map(({ name }) => name);
const PROJECT_ALL = ALL.filter((name) => name.startsWith('project:'));
const ORG_ALL = ALL.filter((name) => name.startsWith('org:'));
const SESSION_ONLY = PERMISSIONS.filter(({ sessionOnly }) => sessionOnly).map(({ name }) => name);
const SELF_AUTHORITY = [
  'project:tokens:create',
  'project:tokens:revoke',
  'project:grants:write',
  'project:service-principals:write',
  'org:tokens:revoke',
  'org:grants:write',
  'org:roles:write',
  'org:users:write',
  'org:service-principals:write',
];
const RANK: Readonly<Record<ScopeLevel, number>> = { read: 0, write: 1, full: 2 };

function inDays(days: number): string {
  return new Date(Date.parse(NOW) + days * DAY).toISOString();
}

function projectEffective(
  grants: readonly string[],
  level: ScopeLevel,
  tokenMaxScope: ScopeLevel,
  readOnly = level === 'read',
): ReadonlySet<string> {
  return tokenEffectivePermissions({
    boundary: 'project',
    grants,
    projectMode: 'selected',
    scope: { level, readOnly },
    tokenMaxScope,
  });
}

function isSubset(small: ReadonlySet<string>, large: ReadonlySet<string>): boolean {
  return [...small].every((name) => large.has(name));
}

describe('effective permissions: each mask term only narrows', () => {
  it('the catalogue partitions into session-only and token-eligible names', () => {
    expect(SESSION_ONLY.length).toBeGreaterThan(0);
    expect(SELF_AUTHORITY.every((name) => SESSION_ONLY.includes(name))).toBe(true);
  });

  it('the scope mask is monotone read < write < full and each step removes something', () => {
    const read = projectEffective(PROJECT_ALL, 'read', 'full');
    const write = projectEffective(PROJECT_ALL, 'write', 'full');
    const full = projectEffective(PROJECT_ALL, 'full', 'full');
    expect(isSubset(read, write)).toBe(true);
    expect(isSubset(write, full)).toBe(true);
    expect(write.size).toBeGreaterThan(read.size);
    expect(full.size).toBeGreaterThan(write.size);
    expect([...read].sort()).toEqual(['project:packages:read', 'project:read']);
    expect([...write].sort()).toEqual([
      'project:packages:read',
      'project:packages:write',
      'project:read',
    ]);
  });

  it('the project token_max_scope mask caps every scope level', () => {
    for (const level of SCOPE_LEVELS) {
      for (const cap of SCOPE_LEVELS) {
        const capped = projectEffective(PROJECT_ALL, level, cap);
        const lower = RANK[level] <= RANK[cap] ? level : cap;
        expect([...capped].sort()).toEqual(
          [...projectEffective(PROJECT_ALL, lower, 'full')].sort(),
        );
        expect(isSubset(capped, projectEffective(PROJECT_ALL, level, 'full'))).toBe(true);
      }
    }
    expect(projectEffective(PROJECT_ALL, 'full', 'read').size).toBeLessThan(
      projectEffective(PROJECT_ALL, 'full', 'full').size,
    );
  });

  it('the read_only mask: a read_only flag disagreeing with the level yields nothing', () => {
    expect(projectEffective(PROJECT_ALL, 'write', 'full', true).size).toBe(0);
    expect(projectEffective(PROJECT_ALL, 'full', 'full', true).size).toBe(0);
    expect(projectEffective(PROJECT_ALL, 'read', 'full', false).size).toBe(0);
    const readOnly = projectEffective(PROJECT_ALL, 'read', 'full', true);
    expect(readOnly.has('project:packages:write')).toBe(false);
  });

  it('live grants bound every level: removing a grant removes the permission', () => {
    for (const level of SCOPE_LEVELS) {
      const before = projectEffective(PROJECT_ALL, level, 'full');
      for (const name of before) {
        const after = projectEffective(
          PROJECT_ALL.filter((grant) => grant !== name),
          level,
          'full',
        );
        expect(after.has(name)).toBe(false);
        expect(isSubset(after, before)).toBe(true);
      }
    }
    expect(projectEffective([], 'full', 'full').size).toBe(0);
  });

  it('a selected PAT has no organization authority, whatever its scope', () => {
    for (const level of SCOPE_LEVELS) {
      const effective = tokenEffectivePermissions({
        boundary: 'organization',
        grants: ORG_ALL,
        projectMode: 'selected',
        scope: { level, readOnly: level === 'read' },
      });
      expect(effective.size).toBe(0);
    }
  });

  it.each(SESSION_ONLY)('a full token with every grant never holds session-only %s', (name) => {
    expect(projectEffective(ALL, 'full', 'full').has(name)).toBe(false);
    const org = tokenEffectivePermissions({
      boundary: 'organization',
      grants: ALL,
      projectMode: 'all',
      scope: { level: 'full', readOnly: false },
    });
    expect(org.has(name)).toBe(false);
  });
});

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
const PAT = formatToken('pat', 'abcdefghijkl', SECRET);
const SVC = formatToken('svc', 'mnopqrstuvwx', SECRET);

interface Lookup {
  readonly kind: 'pat' | 'svc';
  readonly project: { id: string } | null;
  readonly projectPermissions: readonly string[];
  readonly organizationPermissions: readonly string[];
}

async function envelope(found: Lookup, plaintext: string): Promise<EngineTokenAccess> {
  const value = {
    token: {
      id: 'tok-1',
      kind: found.kind,
      expired: false,
      revoked: false,
      lastUsedAt: NOW,
      userId: found.kind === 'pat' ? 'user-1' : null,
      servicePrincipalId: found.kind === 'svc' ? 'sp-1' : null,
    },
    principalStatus: 'active',
    validation:
      found.kind === 'svc'
        ? null
        : { kind: 'local' as const, identityId: null, fresh: true, evidenceAt: null },
    project: found.project,
    organizationPermissions: found.organizationPermissions,
    projectPermissions: found.projectPermissions,
  };
  return Object.defineProperty(value, 'verifier', {
    value: { secretHash: await hashToken(keyring, 1, plaintext), pepperVersion: 1 },
    enumerable: false,
  }) as unknown as EngineTokenAccess;
}

function engineFor(found: Lookup) {
  const plaintext = found.kind === 'pat' ? PAT : SVC;
  const deps: AuthorizationEngineDeps = {
    access: {
      lookupSession: () => Promise.resolve(null),
      touchSession: () => Promise.resolve(true),
      touchToken: () => Promise.resolve(true),
      lookupToken: async () => envelope(found, plaintext),
    },
    tokenUse: {
      keyring,
      nowMs: () => Date.parse(NOW),
      dispatch: () => undefined,
      log: () => undefined,
    },
    patValidation: patValidationGate,
    publicOrigin: ORIGIN,
    providerAnchors: () => Promise.resolve([]),
  };
  return { engine: createAuthorizationEngine(deps), plaintext };
}

async function decide(found: Lookup, permission: string, method = 'GET') {
  const { engine, plaintext } = engineFor(found);
  const boundary = permission.startsWith('org:') ? 'organization' : 'project';
  const request: AuthorizationRequest = {
    request: new Request(`${ORIGIN}/_pb/projects/demo`, {
      method,
      headers: { authorization: `Bearer ${plaintext}`, origin: ORIGIN },
    }),
    org: ctx,
    route: { plugin: 'core', method, path: '/_pb/projects/:project', permission, boundary },
    params: { project: 'demo' },
  };
  return engine.authorize(request);
}

const everything = (kind: 'pat' | 'svc'): Lookup => ({
  kind,
  project: { id: 'proj-1' },
  projectPermissions: ALL,
  organizationPermissions: ALL,
});

describe('engine: a token never performs a session-only action', () => {
  it('the fixture allows a token-eligible permission it was handed', async () => {
    expect(await decide(everything('pat'), 'project:packages:read')).toMatchObject({
      allow: true,
    });
    expect(await decide(everything('svc'), 'org:read')).toMatchObject({ allow: true });
  });

  it.each(SESSION_ONLY.flatMap((name) => [['pat', name] as const, ['svc', name] as const]))(
    'a %s token whose lookup carries every permission is denied session-only %s',
    async (kind, name) => {
      for (const method of ['GET', 'POST']) {
        const decision = await decide(everything(kind), name, method);
        expect(decision.allow).toBe(false);
      }
    },
  );

  it.each(SELF_AUTHORITY)(
    'no token kind can exercise %s to mint, grant or manage',
    async (name) => {
      for (const kind of ['pat', 'svc'] as const) {
        expect(await decide(everything(kind), name, 'POST')).toMatchObject({
          allow: false,
          status: 403,
        });
      }
    },
  );
});

describe('engine fails closed on an empty or unbound lookup', () => {
  it('a project outside the bindings resolves to no project and is 404 for every permission', async () => {
    const outside: Lookup = {
      kind: 'pat',
      project: null,
      projectPermissions: [],
      organizationPermissions: ORG_ALL,
    };
    for (const name of PROJECT_ALL) {
      expect(await decide(outside, name)).toMatchObject({ allow: false, status: 404 });
    }
  });

  it('a bound project whose intersection is empty is 404 rather than an allow', async () => {
    const empty: Lookup = {
      kind: 'pat',
      project: { id: 'proj-1' },
      projectPermissions: [],
      organizationPermissions: [],
    };
    expect(await decide(empty, 'project:read')).toMatchObject({ allow: false, status: 404 });
  });

  it('project permissions handed for one boundary never authorize the other', async () => {
    const bound: Lookup = {
      kind: 'pat',
      project: { id: 'proj-1' },
      projectPermissions: ['project:read', 'project:packages:read'],
      organizationPermissions: [],
    };
    expect(await decide(bound, 'project:packages:read')).toMatchObject({ allow: true });
    expect(await decide(bound, 'project:packages:write', 'POST')).toMatchObject({
      allow: false,
      status: 403,
    });
    expect(await decide(bound, 'org:read')).toMatchObject({ allow: false, status: 403 });
  });
});

function session(principalKind: 'user' | 'service' = 'user'): AuthenticatedSession {
  return {
    session: {
      id: 'session-1',
      userId: 'user-1',
      identityId: null,
      csrfHash: 'x',
      createdAt: NOW,
      expiresAt: inDays(1),
      lastSeenAt: NOW,
      reauthAt: NOW,
      user: { id: 'user-1', email: 'u@example.test', displayName: null },
    },
    principal: { kind: principalKind, id: principalKind === 'user' ? 'user-1' : 'sp-1' },
  } as unknown as AuthenticatedSession;
}

function fence() {
  return mutationFence(
    { userId: 'user-1', sessionId: 'session-1' } as unknown as AuthenticatedActor,
    {},
  );
}

function organization(): Organization {
  return {
    id: ctx.orgId,
    slug: 'a',
    name: 'A',
    settings: {
      retentionRemovedUpstreamDays: 30,
      tokenDefaultExpiryDays: 90,
      tokenCiReadonlyExpiryDays: 365,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function patRig(outcome?: PersonalTokenIssueOutcome) {
  const calls: IssuePersonalTokenCall[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: PersonalTokenServiceDeps = {
    tokens: {
      async issuePersonal(callCtx, callFence, input, mint) {
        calls.push({ ctx: callCtx, fence: callFence, input, mint });
        const pair = await mint();
        return outcome ?? { status: 'issued', id: input.id, plaintext: pair.plaintext };
      },
    },
    sessions: { isReauthFresh: () => true },
    organizations: { get: () => Promise.resolve(organization()) },
    providers: { anchors: () => Promise.resolve([]) },
    keyring,
    clock: fixedClock(NOW),
    ids: { ulid: () => 'tok-1' },
    log: (entry) => logs.push({ ...entry }),
  };
  return { service: createPersonalTokenService(deps), calls, logs, deps };
}

function patInput(extra: Partial<PersonalTokenIssueInput> = {}): PersonalTokenIssueInput {
  return {
    name: 'laptop',
    scope: 'write',
    expiresAt: inDays(7),
    projectMode: 'selected',
    projectIds: ['proj-1'],
    ...extra,
  };
}

describe('PAT issuance: refuse, never narrow', () => {
  it.each(SCOPE_LEVELS)(
    'forwards the requested %s level unchanged to the guarded batch',
    async (level) => {
      const { service, calls } = patRig();
      const result = await service.issue(ctx, session(), fence(), patInput({ scope: level }), {
        audit: {
          opId: '01K00000000000000000000001',
          requestId: '01K00000000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
      });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input.scope).toBe(level);
    },
  );

  it.each(SCOPE_LEVELS)(
    'a %s request above a target policy is refused with no credential',
    async (level) => {
      const { service, calls, logs } = patRig({ status: 'refused', reason: 'authority' });
      const result = await service.issue(ctx, session(), fence(), patInput({ scope: level }), {
        audit: {
          opId: '01K00000000000000000000001',
          requestId: '01K00000000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
      });
      expect(result).toEqual({ ok: false, error: 'forbidden' });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input.scope).toBe(level);
      expect(logs.some((entry) => entry['event'] === 'token.issued')).toBe(false);
    },
  );

  it.each(['write', 'full'] as const)('refuses %s with read_only=true', async (level) => {
    const { service, calls } = patRig();
    const result = await service.issue(
      ctx,
      session(),
      fence(),
      patInput({ scope: level, readOnly: true }),
      {
        audit: {
          opId: '01K00000000000000000000001',
          requestId: '01K00000000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
      },
    );
    expect(result).toEqual({ ok: false, error: 'scope_conflict' });
    expect(calls).toHaveLength(0);
  });

  it.each([null, undefined, ''])(
    'refuses expiry %s instead of issuing a non-expiring token',
    async (expiresAt) => {
      const { service, calls } = patRig();
      const result = await service.issue(
        ctx,
        session(),
        fence(),
        patInput({ expiresAt: expiresAt as unknown as string }),
        {
          audit: {
            opId: '01K00000000000000000000001',
            requestId: '01K00000000000000000000002',
            sourceIp: null,
            tokenSelector: null,
          },
        },
      );
      expect(result).toEqual({ ok: false, error: 'invalid_expiry' });
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses an expiry past the cap rather than clamping it', async () => {
    const { service, calls } = patRig();
    const result = await service.issue(
      ctx,
      session(),
      fence(),
      patInput({ expiresAt: inDays(91) }),
      {
        audit: {
          opId: '01K00000000000000000000001',
          requestId: '01K00000000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
      },
    );
    expect(result).toEqual({ ok: false, error: 'invalid_expiry' });
    expect(calls).toHaveLength(0);
  });

  it('a self PAT issues with no permission port at all, so project:tokens:create is never consulted', async () => {
    const { service } = patRig();
    const result = await service.issue(ctx, session(), fence(), patInput({ scope: 'full' }), {
      audit: {
        opId: '01K00000000000000000000001',
        requestId: '01K00000000000000000000002',
        sourceIp: null,
        tokenSelector: null,
      },
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a selected PAT with an empty binding set', async () => {
    const { service, calls } = patRig();
    const result = await service.issue(ctx, session(), fence(), patInput({ projectIds: [] }), {
      audit: {
        opId: '01K00000000000000000000001',
        requestId: '01K00000000000000000000002',
        sourceIp: null,
        tokenSelector: null,
      },
    });
    expect(result).toEqual({ ok: false, error: 'invalid_projects' });
    expect(calls).toHaveLength(0);
  });
});

const ISSUER = [
  'project:read',
  'project:packages:read',
  'project:packages:write',
  'project:tokens:create',
];

function servicePrincipal(overrides: Partial<ServicePrincipalRecord> = {}): ServicePrincipalRecord {
  return {
    id: 'sp-1',
    name: 'ci',
    projectId: 'proj-1',
    createdByUserId: 'user-9',
    status: 'active',
    revision: 1,
    permissions: ['project:read', 'project:packages:read'],
    ...overrides,
  };
}

const actor: ActorContext = {
  kind: 'organization',
  userId: 'user-1',
  permissions: new Set(),
  isOrganizationAdmin: false,
};

function svcRig(
  options: {
    principal?: ServicePrincipalRecord;
    live?: readonly string[];
    outcome?: ServiceTokenIssueOutcome;
  } = {},
) {
  const calls: IssueServiceTokenCall[] = [];
  const deps: ServiceTokenServiceDeps = {
    tokens: {
      async issueService(callCtx, callFence, input, mint) {
        calls.push({ ctx: callCtx, fence: callFence, input, mint });
        const pair = await mint();
        return options.outcome ?? { status: 'issued', id: input.id, plaintext: pair.plaintext };
      },
    },
    principals: {
      get: (_ctx, id) =>
        Promise.resolve(id === 'sp-1' ? (options.principal ?? servicePrincipal()) : null),
    },
    authority: { livePermissions: () => Promise.resolve(new Set(options.live ?? ISSUER)) },
    sessions: { isReauthFresh: () => true },
    organizations: { get: () => Promise.resolve(organization()) },
    providers: { anchors: () => Promise.resolve([]) },
    keyring,
    clock: fixedClock(NOW),
    ids: { ulid: () => 'tok-1' },
    log: () => undefined,
  };
  return { service: createServiceTokenService(deps), calls };
}

function svcInput(extra: Partial<ServiceTokenIssueInput> = {}): ServiceTokenIssueInput {
  return {
    servicePrincipalId: 'sp-1',
    routeProjectId: 'proj-1',
    name: 'ci',
    scope: 'read',
    expiresAt: inDays(30),
    ...extra,
  };
}

describe('service token issuance: refuse, never narrow', () => {
  it('a write request against a read-only principal is refused, not issued as read', async () => {
    const { service, calls } = svcRig();
    const result = await service.issue(
      ctx,
      session(),
      actor,
      fence(),
      svcInput({ scope: 'write' }),
      {
        audit: {
          opId: '01K00000000000000000000001',
          requestId: '01K00000000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
      },
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
  });

  it('a level whose permissions the issuer no longer holds is refused', async () => {
    const { service, calls } = svcRig({
      principal: servicePrincipal({
        permissions: ['project:read', 'project:packages:read', 'project:packages:write'],
      }),
      live: ['project:read', 'project:packages:read', 'project:tokens:create'],
    });
    const result = await service.issue(
      ctx,
      session(),
      actor,
      fence(),
      svcInput({ scope: 'write' }),
      {
        audit: {
          opId: '01K00000000000000000000001',
          requestId: '01K00000000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
      },
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
  });

  it.each(['write', 'full'] as const)(
    'a batch refusal at any level is not retried lower (%s)',
    async (level) => {
      const { service, calls } = svcRig({
        principal: servicePrincipal({
          permissions: ['project:read', 'project:packages:read', 'project:packages:write'],
        }),
        outcome: { status: 'refused', reason: 'authority' },
      });
      const result = await service.issue(
        ctx,
        session(),
        actor,
        fence(),
        svcInput({ scope: level, expiresAt: inDays(30) }),
        {
          audit: {
            opId: '01K00000000000000000000001',
            requestId: '01K00000000000000000000002',
            sourceIp: null,
            tokenSelector: null,
          },
        },
      );
      expect(result).toEqual({ ok: false, error: 'forbidden' });
      expect(calls[0]?.input.scope).toBe(level);
    },
  );

  it('covers carries no session-only permission even when the principal stores one', async () => {
    const { service, calls } = svcRig({
      principal: servicePrincipal({
        permissions: ['project:read', 'project:packages:read', 'project:tokens:create'],
      }),
    });
    const result = await service.issue(
      ctx,
      session(),
      actor,
      fence(),
      svcInput({ scope: 'full' }),
      {
        audit: {
          opId: '01K00000000000000000000001',
          requestId: '01K00000000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(calls[0]?.input.authority.covers).toEqual(['project:packages:read', 'project:read']);
  });

  it.each(['write', 'full'] as const)('refuses %s with read_only=true', async (level) => {
    const { service, calls } = svcRig();
    const result = await service.issue(
      ctx,
      session(),
      actor,
      fence(),
      svcInput({ scope: level, readOnly: true }),
      {
        audit: {
          opId: '01K00000000000000000000001',
          requestId: '01K00000000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
      },
    );
    expect(result).toEqual({ ok: false, error: 'scope_conflict' });
    expect(calls).toHaveLength(0);
  });

  it.each([null, undefined, ''])('refuses expiry %s', async (expiresAt) => {
    const { service, calls } = svcRig();
    const result = await service.issue(
      ctx,
      session(),
      actor,
      fence(),
      svcInput({ expiresAt: expiresAt as unknown as string }),
      {
        audit: {
          opId: '01K00000000000000000000001',
          requestId: '01K00000000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
      },
    );
    expect(result).toEqual({ ok: false, error: 'invalid_expiry' });
    expect(calls).toHaveLength(0);
  });

  it('a non-user session is refused', async () => {
    const { service, calls } = svcRig();
    const result = await service.issue(ctx, session('service'), actor, fence(), svcInput(), {
      audit: {
        opId: '01K00000000000000000000001',
        requestId: '01K00000000000000000000002',
        sourceIp: null,
        tokenSelector: null,
      },
    });
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toHaveLength(0);
  });
});
