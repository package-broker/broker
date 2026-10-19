import type { ApiCall } from '../api/idempotency.js';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedSession } from '../auth/session.js';
import type { Organization } from '../db/organization.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKeyring } from '../secrets/keyring.js';
import { parseToken } from '../secrets/token-format.js';
import type { ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor, type FenceGuard } from './fence.js';
import { scopeAllows, type ScopeLevel } from './scope.js';
import {
  createServicePrincipalService,
  type CreatorOffboardingCause,
  type ServicePrincipalRecord,
  type ServicePrincipalStore,
} from './service-principal-service.js';
import { createServiceTokenService, type ServiceTokenStore } from './service-token-service.js';
import { authenticateToken, type TokenAccessView, type TokenUseDeps } from './token-use.js';

const ctx = orgContext('org-a');
const NOW = '2026-10-16T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY = 86_400_000;
const keyring = createKeyring([
  { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i + 7) },
]);

const CREATOR = 'creator-1';
const ADMIN = 'admin-2';
const READ = 'project:packages:read';
const WRITE = 'project:packages:write';

const PROJECT_MANAGER = [
  'project:read',
  READ,
  WRITE,
  'project:service-principals:write',
  'project:tokens:create',
];
const ORG_ADMIN = [...PROJECT_MANAGER, 'org:read', 'org:service-principals:write'];

interface User {
  status: 'active' | 'suspended';
  member: boolean;
  isOrganizationAdmin: boolean;
}

interface Project {
  readonly id: string;
  status: 'active' | 'archived';
  cap: ScopeLevel;
}

interface StoredToken {
  readonly id: string;
  readonly kind: 'pat' | 'svc';
  readonly hash: string;
  readonly pepperVersion: number;
  readonly principalId: string;
  readonly projectId: string | null;
  readonly scope: ScopeLevel;
  readonly expiresAt: string;
  revoked: boolean;
}

interface SvcAccess extends TokenAccessView {
  readonly projectId: string | null;
  readonly scope: ScopeLevel;
  readonly permissions: readonly string[];
}

interface Route {
  readonly projectSlug: string | null;
  readonly permission: string;
}

function world() {
  const users = new Map<string, User>([
    [CREATOR, { status: 'active', member: true, isOrganizationAdmin: true }],
    [ADMIN, { status: 'active', member: true, isOrganizationAdmin: true }],
  ]);
  const projects = new Map<string, Project>([
    ['alpha', { id: 'project-1', status: 'active', cap: 'full' }],
    ['beta', { id: 'project-2', status: 'active', cap: 'full' }],
  ]);
  const principals = new Map<string, ServicePrincipalRecord>();
  const tokens = new Map<string, StoredToken>();
  const logs: string[] = [];
  let nowMs = NOW_MS;
  let next = 0;

  function liveFor(userId: string): string[] {
    const user = users.get(userId);
    if (user === undefined || user.status !== 'active' || !user.member) return [];
    return user.isOrganizationAdmin ? ORG_ADMIN : PROJECT_MANAGER;
  }

  const authority = {
    guard: () => Object.freeze([]) as unknown as FenceGuard,
    livePermissions: async (_ctx: unknown, fence: { userId: string }) =>
      new Set(liveFor(fence.userId)),
  };

  const principalStore: ServicePrincipalStore = {
    get: async (_ctx, id) => {
      const found = principals.get(id);
      return found === undefined ? null : { ...found, permissions: [...found.permissions] };
    },
    async create(_ctx, _fence, _guard, input) {
      principals.set(input.id, {
        id: input.id,
        name: input.name,
        projectId: input.projectId,
        createdByUserId: input.createdByUserId,
        status: 'active',
        revision: 1,
        permissions: [...input.permissions],
      });
      return 'created';
    },
    async setPermissions(_ctx, _fence, _guard, { id, permissions }) {
      const found = principals.get(id);
      if (found === undefined) return 'not_found';
      principals.set(id, { ...found, permissions: [...permissions], revision: found.revision + 1 });
      return 'updated';
    },
    async suspend(_ctx, _fence, _guard, { id }) {
      const found = principals.get(id);
      if (found === undefined) return 'not_found';
      if (found.status === 'suspended') return 'unchanged';
      principals.set(id, { ...found, status: 'suspended', revision: found.revision + 1 });
      return 'suspended';
    },
    async restore() {
      return 'not_suspended';
    },
  };

  const tokenStore: ServiceTokenStore = {
    async issueService(_ctx, fence, input, mint) {
      const target = principals.get(input.servicePrincipalId);
      if (target === undefined || target.status !== 'active') {
        return { status: 'refused', reason: 'authority' };
      }
      if (target.revision !== input.principalRevision) {
        return { status: 'refused', reason: 'conflict' };
      }
      const live = liveFor(fence.userId);
      if (!input.authority.covers.every((name) => live.includes(name))) {
        return { status: 'refused', reason: 'authority' };
      }
      const pair = await mint();
      tokens.set(pair.selector, {
        id: input.id,
        kind: 'svc',
        hash: pair.hash,
        pepperVersion: pair.pepperVersion,
        principalId: target.id,
        projectId: target.projectId,
        scope: input.scope,
        expiresAt: input.expiresAt,
        revoked: false,
      });
      return { status: 'issued', id: input.id, plaintext: pair.plaintext };
    },
  };

  const record = (entry: Readonly<Record<string, unknown>>) => logs.push(JSON.stringify(entry));
  const ids = { ulid: () => `ID${String(next++).padStart(4, '0')}` };
  const clock = fixedClock(NOW);

  const principalService = createServicePrincipalService({
    principals: principalStore,
    sessions: { isReauthFresh: () => true },
    authority,
    directory: {
      createdBy: async (_ctx, userId) =>
        [...principals.values()]
          .filter((entry) => entry.createdByUserId === userId)
          .map((entry) => ({ id: entry.id, projectId: entry.projectId })),
    },
    clock,
    ids,
    log: record,
  });

  const tokenService = createServiceTokenService({
    tokens: tokenStore,
    principals: { get: (c, id) => principalStore.get(c, id) },
    authority,
    sessions: { isReauthFresh: () => true },
    organizations: { get: async () => organization() },
    providers: { anchors: async () => [] },
    keyring,
    clock,
    ids,
    log: record,
  });

  async function lookup(selector: string): Promise<SvcAccess | null> {
    const token = tokens.get(selector);
    if (token === undefined) return null;
    const holder = principals.get(token.principalId);
    const envelope = {
      token: {
        id: token.id,
        kind: token.kind,
        expired: Date.parse(token.expiresAt) <= nowMs,
        revoked: token.revoked,
        lastUsedAt: null,
      },
      principalStatus: holder?.status ?? 'missing',
      projectId: token.projectId,
      scope: token.scope,
      permissions: holder === undefined ? [] : [...holder.permissions],
    };
    return Object.defineProperty(envelope, 'verifier', {
      value: { secretHash: token.hash, pepperVersion: token.pepperVersion },
      enumerable: false,
    }) as unknown as SvcAccess;
  }

  function decide(route: Route) {
    return (access: SvcAccess): boolean => {
      if (route.projectSlug === null) return false;
      const project = projects.get(route.projectSlug);
      if (project === undefined || project.status !== 'active') return false;
      if (access.projectId !== null && access.projectId !== project.id) return false;
      return (
        access.permissions.includes(route.permission) &&
        scopeAllows(access.scope, route.permission) &&
        scopeAllows(project.cap, route.permission)
      );
    };
  }

  const useDeps: TokenUseDeps = {
    keyring,
    nowMs: () => nowMs,
    touch: async () => true,
    dispatch: () => undefined,
    log: (event) => logs.push(event),
  };

  async function use(plaintext: string, route: Route) {
    const result = await authenticateToken(useDeps, plaintext, lookup, decide(route));
    return result.ok ? 'allowed' : result.diagnostic;
  }

  function actorOf(userId: string): ActorContext {
    const user = users.get(userId)!;
    return {
      kind: 'organization',
      userId,
      permissions: new Set(),
      isOrganizationAdmin: user.isOrganizationAdmin,
    } as ActorContext;
  }

  function fenceOf(userId: string, revision?: number) {
    return mutationFence(
      { userId, sessionId: `session-${userId}` } as unknown as AuthenticatedActor,
      revision === undefined ? {} : { service_principal: revision },
    );
  }

  async function createPrincipal(userId: string, projectId: string | null): Promise<string> {
    const created = await principalService.create(
      ctx,
      authenticated(userId),
      actorOf(userId),
      fenceOf(userId),
      {
        name: 'ci',
        projectId,
      },
      apiCall,
    );
    if (!created.ok) throw new Error(`create refused: ${created.error}`);
    return created.value.id;
  }

  function attemptIssue(userId: string, principalId: string, scope: ScopeLevel) {
    return tokenService.issue(
      ctx,
      authenticated(userId),
      actorOf(userId),
      fenceOf(userId),
      {
        servicePrincipalId: principalId,
        routeProjectId: principals.get(principalId)!.projectId,
        name: 'deploy',
        scope,
        expiresAt: new Date(NOW_MS + 30 * DAY).toISOString(),
      },
      apiCall,
    );
  }

  async function issue(userId: string, principalId: string, scope: ScopeLevel): Promise<string> {
    const result = await attemptIssue(userId, principalId, scope);
    if (!result.ok) throw new Error(`issue refused: ${result.error}`);
    return result.value.plaintext;
  }

  async function offboard(cause: CreatorOffboardingCause): Promise<void> {
    const creator = users.get(CREATOR)!;
    if (cause === 'suspended') creator.status = 'suspended';
    else creator.member = false;
    const before = JSON.stringify([...principals.values()]);
    await principalService.creatorOffboarded(ctx, { userId: CREATOR, cause });
    expect(JSON.stringify([...principals.values()])).toBe(before);
    expect([...tokens.values()].every((token) => !token.revoked)).toBe(true);
  }

  async function revision(id: string): Promise<number> {
    return principals.get(id)!.revision;
  }

  return {
    users,
    projects,
    principals,
    tokens,
    logs,
    principalService,
    createPrincipal,
    issue,
    attemptIssue,
    offboard,
    use,
    actorOf,
    fenceOf,
    revision,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
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

function authenticated(userId: string): AuthenticatedSession {
  return {
    session: {
      id: `session-${userId}`,
      userId,
      identityId: null,
      csrfHash: 'x',
      createdAt: NOW,
      expiresAt: new Date(NOW_MS + DAY).toISOString(),
      lastSeenAt: NOW,
      reauthAt: NOW,
      user: { id: userId, email: null, displayName: null },
    },
    principal: { kind: 'user', id: userId },
  } as unknown as AuthenticatedSession;
}

const alpha = (permission = WRITE): Route => ({ projectSlug: 'alpha', permission });
const beta = (permission = WRITE): Route => ({ projectSlug: 'beta', permission });

async function projectRig() {
  const w = world();
  w.users.get(CREATOR)!.isOrganizationAdmin = false;
  const principalId = await w.createPrincipal(CREATOR, 'project-1');
  const plaintext = await w.issue(CREATOR, principalId, 'write');
  return { w, principalId, plaintext };
}

describe('creator offboarding leaves service principals and tokens unchanged', () => {
  it.each(['suspended', 'membership_removed'] as const)(
    'keeps a project service token working after the creator is %s',
    async (cause) => {
      const { w, plaintext } = await projectRig();
      expect(await w.use(plaintext, alpha())).toBe('allowed');
      await w.offboard(cause);
      expect(await w.use(plaintext, alpha())).toBe('allowed');
      expect(await w.use(plaintext, alpha(READ))).toBe('allowed');
    },
  );

  it.each(['suspended', 'membership_removed'] as const)(
    'keeps an organization-wide service token working after its admin creator is %s',
    async (cause) => {
      const w = world();
      const principalId = await w.createPrincipal(CREATOR, null);
      const plaintext = await w.issue(CREATOR, principalId, 'write');
      await w.offboard(cause);
      expect(await w.use(plaintext, alpha())).toBe('allowed');
      expect(await w.use(plaintext, beta())).toBe('allowed');
    },
  );

  it('records the offboarding without changing the principals the creator made', async () => {
    const { w, principalId } = await projectRig();
    await w.offboard('membership_removed');
    expect(w.principals.get(principalId)?.status).toBe('active');
    const events = w.logs.filter((line) => line.includes('service_principal.creator_offboarded'));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(principalId);
  });

  it('does not let an offboarded creator issue further tokens', async () => {
    const { w, principalId } = await projectRig();
    await w.offboard('suspended');
    const refused = await w.attemptIssue(CREATOR, principalId, 'read');
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toBe('forbidden');
  });

  it('still honours expiry and revocation after the creator leaves', async () => {
    const { w, plaintext } = await projectRig();
    await w.offboard('suspended');
    const selector = parseToken(plaintext);
    if (!selector.ok) throw new Error('issued token does not parse');
    w.tokens.get(selector.selector)!.revoked = true;
    expect(await w.use(plaintext, alpha())).toBe('revoked');
    w.tokens.get(selector.selector)!.revoked = false;
    w.advance(31 * DAY);
    expect(await w.use(plaintext, alpha())).toBe('expired');
  });
});

describe('service authority removal through the principal service and the principal status check', () => {
  it('denies the next request once a service permission is removed, though the creator is still admin', async () => {
    const w = world();
    const principalId = await w.createPrincipal(CREATOR, 'project-1');
    const plaintext = await w.issue(CREATOR, principalId, 'write');
    expect(await w.use(plaintext, alpha())).toBe('allowed');
    const narrowed = await w.principalService.setPermissions(
      ctx,
      w.actorOf(ADMIN),
      w.fenceOf(ADMIN, await w.revision(principalId)),
      principalId,
      ['project:read', READ],
      apiCall,
    );
    expect(narrowed).toEqual({ ok: true, value: null });
    expect(await w.use(plaintext, alpha())).toBe('denied');
    expect(await w.use(plaintext, alpha(READ))).toBe('allowed');
  });

  it('denies the next request once the principal is suspended, after the creator has left', async () => {
    const { w, principalId, plaintext } = await projectRig();
    await w.offboard('membership_removed');
    const suspended = await w.principalService.suspend(
      ctx,
      w.actorOf(ADMIN),
      w.fenceOf(ADMIN),
      principalId,
      apiCall,
    );
    expect(suspended).toEqual({ ok: true, value: null });
    expect(await w.use(plaintext, alpha())).toBe('principal_inactive');
    expect(await w.use(plaintext, alpha(READ))).toBe('principal_inactive');
  });

  it('denies an organization-wide token once its permission set is narrowed', async () => {
    const w = world();
    const principalId = await w.createPrincipal(CREATOR, null);
    const plaintext = await w.issue(CREATOR, principalId, 'write');
    await w.offboard('suspended');
    await w.principalService.setPermissions(
      ctx,
      w.actorOf(ADMIN),
      w.fenceOf(ADMIN, await w.revision(principalId)),
      principalId,
      ['project:read', READ],
      apiCall,
    );
    expect(await w.use(plaintext, beta())).toBe('denied');
    expect(await w.use(plaintext, beta(READ))).toBe('allowed');
  });
});

describe('organization-wide service token on registry routes', () => {
  async function wideRig() {
    const w = world();
    const principalId = await w.createPrincipal(CREATOR, null);
    const plaintext = await w.issue(CREATOR, principalId, 'write');
    return { w, plaintext };
  }

  it('needs a project URL for a registry operation', async () => {
    const { w, plaintext } = await wideRig();
    expect(await w.use(plaintext, { projectSlug: null, permission: READ })).toBe('denied');
    expect(await w.use(plaintext, alpha(READ))).toBe('allowed');
  });

  it('passes the selected project cap, not the widest cap', async () => {
    const { w, plaintext } = await wideRig();
    w.projects.get('alpha')!.cap = 'read';
    expect(await w.use(plaintext, alpha())).toBe('denied');
    expect(await w.use(plaintext, alpha(READ))).toBe('allowed');
    expect(await w.use(plaintext, beta())).toBe('allowed');
  });

  it('denies an unknown or archived project slug', async () => {
    const { w, plaintext } = await wideRig();
    w.projects.get('beta')!.status = 'archived';
    expect(await w.use(plaintext, beta(READ))).toBe('denied');
    expect(await w.use(plaintext, { projectSlug: 'gamma', permission: READ })).toBe('denied');
  });

  it('keeps a project-bound token off another project', async () => {
    const { w, plaintext } = await projectRig();
    await w.offboard('suspended');
    expect(await w.use(plaintext, beta(READ))).toBe('denied');
  });
});

describe('secret handling', () => {
  it('never writes the presented token into a log line', async () => {
    const { w, plaintext } = await projectRig();
    await w.offboard('suspended');
    await w.use(plaintext, alpha());
    await w.use(`${plaintext}x`, alpha());
    const parsed = parseToken(plaintext);
    if (!parsed.ok) throw new Error('issued token does not parse');
    expect(w.logs.some((line) => line.includes(plaintext))).toBe(false);
    expect(w.logs.some((line) => line.includes(parsed.canonical))).toBe(false);
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
