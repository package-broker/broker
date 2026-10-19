import type {
  ServicePrincipalService,
  ServicePrincipalStore,
} from './service-principal-service.js';
import { createSessionService, type AuthenticatedSession } from '../auth/session.js';
import type { ApiCall } from '../api/idempotency.js';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor, type FenceGuard } from './fence.js';
import {
  createServicePrincipalService,
  type ServicePrincipalAuthority,
  type ServicePrincipalDeps,
  type ServicePrincipalRecord,
} from './service-principal-service.js';

const ctx = orgContext('org-a');
const NOW = '2026-10-15T08:00:00.000Z';
const PROJECT = 'project-1';

function authenticated(reauthAt: string | null = NOW): AuthenticatedSession {
  return {
    session: {
      id: 'session-1',
      userId: 'actor-1',
      identityId: null,
      csrfHash: 'x',
      createdAt: NOW,
      expiresAt: '2026-10-16T08:00:00.000Z',
      lastSeenAt: NOW,
      reauthAt,
      user: { id: 'actor-1', email: 'actor@example.test', displayName: null },
    },
    principal: { kind: 'user', id: 'actor-1' },
  };
}

const actor: ActorContext = {
  kind: 'organization',
  userId: 'actor-1',
  permissions: new Set(['org:read']),
  isOrganizationAdmin: false,
};
const admin: ActorContext = {
  kind: 'organization',
  userId: 'actor-1',
  permissions: new Set(['org:service-principals:write', 'org:read']),
  isOrganizationAdmin: true,
};

const PROJECT_LIVE = [
  'project:read',
  'project:packages:read',
  'project:packages:write',
  'project:service-principals:write',
  'project:tokens:create',
  'org:read',
  'org:audit:read',
];
const ORG_LIVE = [
  'org:read',
  'org:users:read',
  'org:service-principals:write',
  'org:users:write',
  'project:read',
];

function fenceOf(expected: Record<string, number> = { service_principal: 3 }, userId = 'actor-1') {
  return mutationFence(
    { userId, sessionId: 'session-1' } as unknown as AuthenticatedActor,
    expected,
  );
}

function principal(overrides: Partial<ServicePrincipalRecord> = {}): ServicePrincipalRecord {
  return {
    id: 'sp-1',
    name: 'ci',
    projectId: PROJECT,
    createdByUserId: 'creator-1',
    status: 'active',
    revision: 3,
    permissions: ['project:packages:read'],
    ...overrides,
  };
}

function setup(
  options: { live?: readonly string[]; existing?: ServicePrincipalRecord | null } = {},
) {
  const guard = Object.freeze([{ sql: 'select 1', params: [] }]) as unknown as FenceGuard;
  const principals = {
    get: vi.fn(async () => (options.existing === undefined ? principal() : options.existing)),
    create: vi.fn(async (): Promise<string> => 'created'),
    setPermissions: vi.fn(async (): Promise<string> => 'updated'),
    suspend: vi.fn(async (): Promise<string> => 'suspended'),
    restore: vi.fn(async (): Promise<string> => 'restored'),
  };
  const authority = {
    guard: vi.fn<ServicePrincipalAuthority['guard']>(() => guard),
    livePermissions: vi.fn(
      async (_c: unknown, _f: unknown, projectId: string | null) =>
        new Set(options.live ?? (projectId === null ? ORG_LIVE : PROJECT_LIVE)),
    ),
  };
  const createdBy = vi.fn(async () => [
    { id: 'sp-1', projectId: PROJECT },
    { id: 'sp-2', projectId: null },
  ]);
  const log = vi.fn();
  let next = 0;
  const service = createServicePrincipalService({
    principals: principals as unknown as ServicePrincipalDeps['principals'],
    authority: authority as unknown as ServicePrincipalDeps['authority'],
    directory: { createdBy },
    sessions: createSessionService({
      sessions: {} as never,
      clock: fixedClock(NOW),
      publicOrigin: 'https://broker.example.test',
    }),
    clock: fixedClock(NOW),
    ids: { ulid: () => `ID${String(next++).padStart(2, '0')}` },
    log,
  });
  return { service, principals, authority, createdBy, log, guard };
}

const events = (log: ReturnType<typeof vi.fn>, name: string) =>
  log.mock.calls.map(([entry]) => entry).filter((entry) => entry.event === name);

describe('create', () => {
  it.each([
    ['stale', '2026-10-15T07:49:59.000Z'],
    ['null', null],
    ['future', '2026-10-15T08:00:01.000Z'],
  ])(
    'refuses %s reauth before any repository or authority call and stages no event',
    async (_name, reauthAt) => {
      const { service, principals, authority, createdBy, log } = setup();
      expect(
        await service.create(
          ctx,
          authenticated(reauthAt),
          actor,
          fenceOf({}),
          { name: 'ci', projectId: PROJECT },
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'reauth_required' });
      for (const method of Object.values(principals)) expect(method).not.toHaveBeenCalled();
      expect(authority.livePermissions).not.toHaveBeenCalled();
      expect(authority.guard).not.toHaveBeenCalled();
      expect(createdBy).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('requires the fence to belong to the authenticated session', async () => {
    const { service, principals, authority } = setup();
    const auth = authenticated();
    await expect(
      service.create(
        ctx,
        { ...auth, session: { ...auth.session, id: 'other-session' } },
        actor,
        fenceOf({}),
        { name: 'ci', projectId: PROJECT },
        apiCall,
      ),
    ).rejects.toThrow(TypeError);
    for (const method of Object.values(principals)) expect(method).not.toHaveBeenCalled();
    expect(authority.livePermissions).not.toHaveBeenCalled();
    expect(authority.guard).not.toHaveBeenCalled();
  });

  it.each(['service', 'customer'] as const)(
    'refuses a %s principal before any repository or authority call',
    async (kind) => {
      const { service, principals, authority } = setup();
      expect(
        await service.create(
          ctx,
          { ...authenticated(), principal: { kind, id: 'actor-1' } },
          actor,
          fenceOf({}),
          { name: 'ci', projectId: PROJECT },
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'forbidden' });
      for (const method of Object.values(principals)) expect(method).not.toHaveBeenCalled();
      expect(authority.livePermissions).not.toHaveBeenCalled();
      expect(authority.guard).not.toHaveBeenCalled();
    },
  );

  it('snapshots exactly the creator non-sessionOnly permissions inside the project boundary', async () => {
    const { service, principals, authority, guard } = setup();
    const fence = fenceOf({});
    const result = await service.create(
      ctx,
      authenticated(),
      actor,
      fence,
      { name: 'ci', projectId: PROJECT },
      apiCall,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        id: 'ID00',
        permissions: ['project:packages:read', 'project:packages:write', 'project:read'],
      },
    });
    expect(principals.create).toHaveBeenCalledWith(ctx, fence, guard, {
      audit: expect.objectContaining({ action: 'service_principal.create' }),
      id: 'ID00',
      name: 'ci',
      projectId: PROJECT,
      createdByUserId: 'actor-1',
      permissions: ['project:packages:read', 'project:packages:write', 'project:read'],
      now: NOW,
      opId: 'ID01',
    });
    expect(authority.guard).toHaveBeenCalledWith(ctx, fence, {
      permission: 'project:service-principals:write',
      projectId: PROJECT,
      organizationAdmin: false,
      covers: ['project:packages:read', 'project:packages:write', 'project:read'],
      freshReauth: true,
    });
  });

  it('never snapshots session-only permissions such as the management and token-issue grants', async () => {
    const { service, principals } = setup();
    await service.create(
      ctx,
      authenticated(),
      actor,
      fenceOf({}),
      { name: 'ci', projectId: PROJECT },
      apiCall,
    );
    const stored = (principals.create.mock.calls[0] as unknown[])[3] as { permissions: string[] };
    expect(stored.permissions).not.toContain('project:service-principals:write');
    expect(stored.permissions).not.toContain('project:tokens:create');
    expect(stored.permissions.some((name) => name.startsWith('org:'))).toBe(false);
  });

  it('refuses when the creator lacks project:service-principals:write, even with project:tokens:create', async () => {
    const { service, principals, log } = setup({ live: ['project:read', 'project:tokens:create'] });
    expect(
      await service.create(
        ctx,
        authenticated(),
        actor,
        fenceOf({}),
        { name: 'ci', projectId: PROJECT },
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(principals.create).not.toHaveBeenCalled();
    expect(events(log, 'admin.denied')).toHaveLength(1);
  });

  it('creates an organization-wide principal for a current admin from the org grants', async () => {
    const { service, principals, authority } = setup();
    const fence = fenceOf({});
    const result = await service.create(
      ctx,
      authenticated(),
      admin,
      fence,
      { name: 'ci', projectId: null },
      apiCall,
    );
    expect(result).toEqual({
      ok: true,
      value: { id: 'ID00', permissions: ['org:read', 'org:users:read', 'project:read'] },
    });
    expect(principals.create).toHaveBeenCalledTimes(1);
    expect(authority.guard).toHaveBeenCalledWith(ctx, fence, {
      permission: 'org:service-principals:write',
      projectId: null,
      organizationAdmin: true,
      covers: ['org:read', 'org:users:read', 'project:read'],
      freshReauth: true,
    });
  });

  it('refuses an organization-wide principal without current admin status', async () => {
    const { service, principals } = setup();
    const notAdmin = { ...admin, isOrganizationAdmin: false };
    expect(
      await service.create(
        ctx,
        authenticated(),
        notAdmin,
        fenceOf({}),
        { name: 'ci', projectId: null },
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(principals.create).not.toHaveBeenCalled();
  });

  it('refuses an organization-wide principal for an admin missing org:service-principals:write', async () => {
    const { service, principals } = setup({ live: ['org:read'] });
    expect(
      await service.create(
        ctx,
        authenticated(),
        admin,
        fenceOf({}),
        { name: 'ci', projectId: null },
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(principals.create).not.toHaveBeenCalled();
  });

  it('maps repository outcomes without leaking a stored row', async () => {
    const cases: Array<[string, unknown]> = [
      ['authority', { ok: false, error: 'forbidden' }],
      ['project_mismatch', { ok: false, error: 'project_mismatch' }],
      ['duplicate', { ok: false, error: 'duplicate' }],
      ['indeterminate', { ok: false, error: 'indeterminate' }],
    ];
    for (const [outcome, expected] of cases) {
      const { service, principals, log } = setup();
      principals.create.mockResolvedValue(outcome);
      expect(
        await service.create(
          ctx,
          authenticated(),
          actor,
          fenceOf({}),
          { name: 'ci', projectId: PROJECT },
          apiCall,
        ),
      ).toEqual(expected);
      expect(events(log, 'service_principal.changed')).toHaveLength(0);
    }
  });

  it('refuses a malformed project id before reading authority', async () => {
    const { service, authority } = setup();
    for (const projectId of ['', 7, undefined]) {
      expect(
        await service.create(
          ctx,
          authenticated(),
          actor,
          fenceOf({}),
          {
            name: 'ci',
            projectId: projectId as never,
          },
          apiCall,
        ),
      ).toEqual({ ok: false, error: 'project_mismatch' });
    }
    expect(authority.livePermissions).not.toHaveBeenCalled();
  });

  it('rejects an invalid name before reading authority', async () => {
    const { service, authority } = setup();
    for (const name of ['', 'a\u0000b', 'x'.repeat(101), 7 as unknown as string]) {
      expect(
        await service.create(
          ctx,
          authenticated(),
          actor,
          fenceOf({}),
          { name, projectId: PROJECT },
          apiCall,
        ),
      ).toEqual({
        ok: false,
        error: 'invalid_name',
      });
    }
    expect(authority.livePermissions).not.toHaveBeenCalled();
  });

  it('throws when the fence belongs to another user', async () => {
    const { service, principals } = setup();
    await expect(
      service.create(
        ctx,
        authenticated(),
        actor,
        fenceOf({}, 'someone-else'),
        { name: 'ci', projectId: PROJECT },
        apiCall,
      ),
    ).rejects.toThrow(TypeError);
    expect(principals.create).not.toHaveBeenCalled();
  });

  it('emits one change event on success', async () => {
    const { service, log } = setup();
    await service.create(
      ctx,
      authenticated(),
      actor,
      fenceOf({}),
      { name: 'ci', projectId: PROJECT },
      apiCall,
    );
    expect(events(log, 'service_principal.changed')).toEqual([
      expect.objectContaining({
        action: 'created',
        orgId: 'org-a',
        servicePrincipalId: 'ID00',
        projectId: PROJECT,
        actorUserId: 'actor-1',
      }),
    ]);
  });
});

describe('setPermissions', () => {
  it('replaces the set with a subset of the actor live permissions', async () => {
    const { service, principals, authority, guard } = setup();
    const fence = fenceOf();
    expect(
      await service.setPermissions(
        ctx,
        actor,
        fence,
        'sp-1',
        ['project:read', 'project:packages:write'],
        apiCall,
      ),
    ).toEqual({ ok: true, value: null });
    expect(principals.setPermissions).toHaveBeenCalledWith(ctx, fence, guard, {
      audit: expect.objectContaining({ action: 'service_principal.permissions_set' }),
      id: 'sp-1',
      permissions: ['project:packages:write', 'project:read'],
      now: NOW,
      opId: 'ID00',
    });
    expect(authority.guard).toHaveBeenCalledWith(ctx, fence, {
      permission: 'project:service-principals:write',
      projectId: PROJECT,
      organizationAdmin: false,
      covers: ['project:packages:write', 'project:read'],
    });
  });

  it('refuses a change beyond the actor live set', async () => {
    const { service, principals, log } = setup();
    expect(
      await service.setPermissions(
        ctx,
        actor,
        fenceOf(),
        'sp-1',
        ['project:sources:read'],
        apiCall,
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(principals.setPermissions).not.toHaveBeenCalled();
    expect(events(log, 'admin.denied')).toHaveLength(1);
  });

  it('refuses without the management permission', async () => {
    const { service, principals } = setup({ live: ['project:read'] });
    expect(
      await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:read'], apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(principals.setPermissions).not.toHaveBeenCalled();
  });

  it('refuses session-only, unknown and out-of-boundary permissions', async () => {
    const { service, principals } = setup();
    for (const list of [
      ['project:tokens:create'],
      ['project:nope'],
      ['org:read'],
      ['project:read', 'project:read'],
    ]) {
      expect(
        await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', list, apiCall),
      ).toMatchObject({
        ok: false,
        error: 'invalid_permission',
      });
    }
    expect(principals.setPermissions).not.toHaveBeenCalled();
  });

  it('keeps an organization-wide principal inside token-eligible permissions and requires admin', async () => {
    const wide = principal({ projectId: null });
    const { service, principals } = setup({ existing: wide });
    expect(
      await service.setPermissions(ctx, admin, fenceOf(), 'sp-1', ['org:settings:write'], apiCall),
    ).toMatchObject({
      ok: false,
      error: 'invalid_permission',
    });
    expect(
      await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['org:read'], apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(principals.setPermissions).not.toHaveBeenCalled();
    expect(
      await service.setPermissions(
        ctx,
        admin,
        fenceOf(),
        'sp-1',
        ['org:read', 'project:read'],
        apiCall,
      ),
    ).toEqual({ ok: true, value: null });
  });

  it('never carries a project binding to the repository', async () => {
    const { service, principals } = setup();
    await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:read'], apiCall);
    const args = principals.setPermissions.mock.calls[0] as unknown[];
    expect(args).toHaveLength(4);
    expect(args[3]).not.toHaveProperty('projectId');
  });

  it('answers not_found for an unknown id and invalid_revision for a fence with no revision', async () => {
    const missing = setup({ existing: null });
    expect(
      await missing.service.setPermissions(
        ctx,
        actor,
        fenceOf(),
        'nope',
        ['project:read'],
        apiCall,
      ),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    const { service, principals } = setup();
    expect(
      await service.setPermissions(ctx, actor, fenceOf({}), 'sp-1', ['project:read'], apiCall),
    ).toEqual({
      ok: false,
      error: 'invalid_revision',
    });
    expect(principals.setPermissions).not.toHaveBeenCalled();
  });

  it('allows archived projects only when the change narrows the stored set', async () => {
    const { service, authority } = setup({
      existing: principal({ permissions: ['project:read', 'project:packages:read'] }),
    });
    await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:read'], apiCall);
    expect(authority.guard.mock.calls[0]?.[2]).toMatchObject({ allowArchived: true });
    await service.setPermissions(
      ctx,
      actor,
      fenceOf(),
      'sp-1',
      ['project:packages:write'],
      apiCall,
    );
    expect(authority.guard.mock.calls[1]?.[2]).not.toHaveProperty('allowArchived');
  });

  it('maps repository outcomes', async () => {
    const cases: Array<[string, unknown]> = [
      ['conflict', { ok: false, error: 'conflict' }],
      ['authority', { ok: false, error: 'forbidden' }],
      ['indeterminate', { ok: false, error: 'indeterminate' }],
      ['not_found', { ok: false, error: 'not_found' }],
      ['invalid_permissions', { ok: false, error: 'invalid_permission' }],
    ];
    for (const [outcome, expected] of cases) {
      const { service, principals } = setup();
      principals.setPermissions.mockResolvedValue(outcome);
      expect(
        await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:read'], apiCall),
      ).toMatchObject(expected as object);
    }
  });
});

describe('suspend and restore', () => {
  it('suspends one principal and touches nothing else', async () => {
    const { service, principals, createdBy, log } = setup();
    expect(await service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall)).toEqual({
      ok: true,
      value: null,
    });
    expect(principals.suspend).toHaveBeenCalledTimes(1);
    expect(principals.suspend).toHaveBeenCalledWith(ctx, expect.anything(), expect.anything(), {
      audit: expect.objectContaining({ action: 'service_principal.suspend' }),
      id: 'sp-1',
      now: NOW,
      opId: 'ID00',
    });
    expect(principals.setPermissions).not.toHaveBeenCalled();
    expect(principals.restore).not.toHaveBeenCalled();
    expect(createdBy).not.toHaveBeenCalled();
    expect(events(log, 'service_principal.changed')).toEqual([
      expect.objectContaining({ action: 'suspended', servicePrincipalId: 'sp-1' }),
    ]);
  });

  it('restores and reports not_suspended without an event', async () => {
    const { service, principals, log } = setup();
    expect(await service.restore(ctx, actor, fenceOf(), 'sp-1', apiCall)).toEqual({
      ok: true,
      value: null,
    });
    principals.restore.mockResolvedValue('not_suspended');
    expect(await service.restore(ctx, actor, fenceOf(), 'sp-1', apiCall)).toEqual({
      ok: false,
      error: 'not_suspended',
    });
    expect(events(log, 'service_principal.changed')).toHaveLength(1);
  });

  it('requires the management permission and, for organization-wide, admin status', async () => {
    const none = setup({ live: ['project:read'] });
    expect(await none.service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    const wide = setup({ existing: principal({ projectId: null, permissions: ['org:read'] }) });
    expect(await wide.service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await wide.service.restore(ctx, admin, fenceOf(), 'sp-1', apiCall)).toEqual({
      ok: true,
      value: null,
    });
    expect(none.principals.suspend).not.toHaveBeenCalled();
    expect(wide.principals.suspend).not.toHaveBeenCalled();
  });

  it('restores only when the stored set is within the live set, and the guard covers it', async () => {
    const stale = principal({
      status: 'suspended',
      permissions: ['project:packages:read', 'project:sources:read'],
    });
    const refused = setup({ existing: stale });
    expect(await refused.service.restore(ctx, actor, fenceOf(), 'sp-1', apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(refused.principals.restore).not.toHaveBeenCalled();
    const { service, principals, authority } = setup({
      existing: principal({
        status: 'suspended',
        permissions: ['project:read', 'project:packages:read'],
      }),
    });
    expect(await service.restore(ctx, actor, fenceOf(), 'sp-1', apiCall)).toEqual({
      ok: true,
      value: null,
    });
    expect(principals.restore).toHaveBeenCalledTimes(1);
    expect(authority.guard).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.objectContaining({ covers: [], coversStoredOf: 'sp-1' }),
    );
    expect(authority.guard.mock.calls[0]?.[2]).not.toHaveProperty('allowArchived');
  });

  it('restores only against the current revision, before any guard is built', async () => {
    const { service, principals, authority } = setup({
      existing: principal({ status: 'suspended', permissions: ['project:read'], revision: 4 }),
    });
    expect(await service.restore(ctx, actor, fenceOf({}), 'sp-1', apiCall)).toEqual({
      ok: false,
      error: 'invalid_revision',
    });
    expect(
      await service.restore(ctx, actor, fenceOf({ service_principal: 3 }), 'sp-1', apiCall),
    ).toEqual({
      ok: false,
      error: 'conflict',
    });
    expect(principals.restore).not.toHaveBeenCalled();
    expect(authority.guard).not.toHaveBeenCalled();
    principals.restore.mockResolvedValue('conflict');
    expect(
      await service.restore(ctx, actor, fenceOf({ service_principal: 4 }), 'sp-1', apiCall),
    ).toEqual({
      ok: false,
      error: 'conflict',
    });
  });

  it('refuses a stale permission change before building a guard', async () => {
    const { service, principals, authority } = setup({
      existing: principal({ revision: 5 }),
    });
    expect(
      await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:read'], apiCall),
    ).toEqual({
      ok: false,
      error: 'conflict',
    });
    expect(authority.guard).not.toHaveBeenCalled();
    expect(principals.setPermissions).not.toHaveBeenCalled();
  });

  it('treats an empty or non-string id as unknown, not_found for an actor who manages nothing', async () => {
    const { service } = setup({ live: ['project:read'] });
    for (const id of ['', 7 as unknown as string]) {
      expect(await service.suspend(ctx, actor, fenceOf({}), id, apiCall)).toEqual({
        ok: false,
        error: 'not_found',
      });
      expect(
        await service.setPermissions(ctx, actor, fenceOf(), id, ['project:read'], apiCall),
      ).toEqual({
        ok: false,
        error: 'not_found',
      });
    }
  });

  it('allows suspension on an archived project and answers an unchanged repeat without an event', async () => {
    const { service, principals, authority, log } = setup();
    principals.suspend.mockResolvedValue('unchanged');
    expect(await service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall)).toEqual({
      ok: true,
      value: null,
    });
    expect(authority.guard).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.objectContaining({ allowArchived: true, covers: [] }),
    );
    expect(events(log, 'service_principal.changed')).toHaveLength(0);
  });

  it('answers not_found for an unknown id when the actor manages nothing', async () => {
    const { service } = setup({ existing: null, live: ['project:read'] });
    expect(await service.suspend(ctx, actor, fenceOf({}), 'nope', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await service.restore(ctx, actor, fenceOf(), 'nope', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(
      await service.setPermissions(ctx, actor, fenceOf(), 'nope', ['project:read'], apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('answers not_found and maps repository refusals', async () => {
    const missing = setup({ existing: null });
    expect(await missing.service.suspend(ctx, actor, fenceOf({}), 'nope', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    const { service, principals } = setup();
    principals.suspend.mockResolvedValue('authority');
    expect(await service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    principals.suspend.mockResolvedValue('indeterminate');
    expect(await service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall)).toEqual({
      ok: false,
      error: 'indeterminate',
    });
  });
});

describe('creatorOffboarded', () => {
  it('emits one event per created principal and changes none of them', async () => {
    const { service, principals, log } = setup();
    await service.creatorOffboarded(ctx, { userId: 'creator-1', cause: 'suspended' });
    expect(events(log, 'service_principal.creator_offboarded')).toEqual([
      expect.objectContaining({
        orgId: 'org-a',
        servicePrincipalId: 'sp-1',
        userId: 'creator-1',
        cause: 'suspended',
      }),
      expect.objectContaining({
        servicePrincipalId: 'sp-2',
        userId: 'creator-1',
        cause: 'suspended',
      }),
    ]);
    for (const method of Object.values(principals)) expect(method).not.toHaveBeenCalled();
  });

  it('swallows a directory failure and logs a fixed event', async () => {
    const { service, createdBy, log } = setup();
    createdBy.mockRejectedValue(new Error('secret detail'));
    await expect(
      service.creatorOffboarded(ctx, { userId: 'creator-1', cause: 'suspended' }),
    ).resolves.toBeUndefined();
    expect(events(log, 'service_principal.offboarding_lookup_failed')).toEqual([
      expect.objectContaining({ userId: 'creator-1', cause: 'suspended' }),
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret detail');
  });

  it('does not fail when the log sink throws', async () => {
    const { service, log } = setup();
    log.mockImplementation(() => {
      throw new Error('sink');
    });
    await expect(
      service.creatorOffboarded(ctx, { userId: 'creator-1', cause: 'membership_removed' }),
    ).resolves.toBeUndefined();
  });
});

describe('the actor must be organization-kind', () => {
  const untaggedActor = {
    userId: 'actor-1',
    permissions: new Set(['org:service-principals:write']),
    isOrganizationAdmin: true,
  } as unknown as ActorContext;
  const projectActor = {
    ...untaggedActor,
    kind: 'project',
    projectId: PROJECT,
  } as unknown as ActorContext;

  it.each([
    ['an untagged actor', untaggedActor],
    ['a project-kind actor', projectActor],
  ])('%s is refused before any store call, with one denial', async (_name, bad) => {
    const { service, principals, authority, log } = setup();
    const fence = fenceOf();
    const results = [
      await service.create(
        ctx,
        authenticated(),
        bad,
        fence,
        { name: 'ci', projectId: null },
        apiCall,
      ),
      await service.setPermissions(ctx, bad, fence, 'sp-1', [], apiCall),
      await service.suspend(ctx, bad, fence, 'sp-1', apiCall),
      await service.restore(ctx, bad, fence, 'sp-1', apiCall),
    ];
    for (const result of results) expect(result).toEqual({ ok: false, error: 'forbidden' });
    for (const call of Object.values(principals)) expect(call).not.toHaveBeenCalled();
    expect(authority.livePermissions).not.toHaveBeenCalled();
    expect(authority.guard).not.toHaveBeenCalled();
    expect(events(log, 'admin.denied')).toHaveLength(4);
    for (const entry of events(log, 'admin.denied')) {
      expect(entry).toMatchObject({ orgId: 'org-a', actorUserId: null });
    }
  });
});

describe('existence of organization-wide principals', () => {
  const projectManager = ['project:read', 'project:service-principals:write'];
  const wide = principal({ projectId: null, permissions: ['org:read'] });

  it('answers any actor who cannot manage the same for an existing organization-wide id and a missing one', async () => {
    const existing = setup({ existing: wide, live: projectManager });
    const absent = setup({ existing: null, live: projectManager });
    const results = [
      [
        await existing.service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall),
        await absent.service.suspend(ctx, actor, fenceOf({}), 'nope', apiCall),
      ],
      [
        await existing.service.restore(ctx, actor, fenceOf(), 'sp-1', apiCall),
        await absent.service.restore(ctx, actor, fenceOf(), 'nope', apiCall),
      ],
      [
        await existing.service.setPermissions(
          ctx,
          actor,
          fenceOf(),
          'sp-1',
          ['project:read'],
          apiCall,
        ),
        await absent.service.setPermissions(
          ctx,
          actor,
          fenceOf(),
          'nope',
          ['project:read'],
          apiCall,
        ),
      ],
    ];
    for (const [found, missing] of results) expect(found).toEqual(missing);
    for (const [found] of results) expect(found).toEqual({ ok: false, error: 'not_found' });
    expect(existing.principals.suspend).not.toHaveBeenCalled();
  });

  it('answers a non-admin holding the organization permission the same for both ids', async () => {
    const existing = setup({ existing: wide });
    const absent = setup({ existing: null });
    expect(await existing.service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall)).toEqual(
      await absent.service.suspend(ctx, actor, fenceOf({}), 'nope', apiCall),
    );
    expect(await existing.service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('costs the same lookups for a missing, a hidden org-wide and a hidden project-bound id', async () => {
    const cases = [
      setup({ existing: null, live: projectManager }),
      setup({ existing: wide, live: projectManager }),
      setup({ existing: principal(), live: ['project:read'] }),
    ];
    for (const { service } of cases)
      await service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall);
    for (const { principals, authority } of cases) {
      expect(principals.get).toHaveBeenCalledTimes(1);
      expect(authority.livePermissions).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps a full manager mistyped id out of the denial log', async () => {
    const { service, log } = setup({ existing: null });
    expect(await service.suspend(ctx, admin, fenceOf({}), 'nope', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(events(log, 'admin.denied')).toEqual([]);
  });

  it('logs the same denial for both ids', async () => {
    const existing = setup({ existing: wide, live: projectManager });
    const absent = setup({ existing: null, live: projectManager });
    await existing.service.suspend(ctx, actor, fenceOf({}), 'sp-1', apiCall);
    await absent.service.suspend(ctx, actor, fenceOf({}), 'nope', apiCall);
    expect(events(existing.log, 'admin.denied')).toEqual(events(absent.log, 'admin.denied'));
  });

  it('keeps not_found for a missing id when the actor manages at organization scope', async () => {
    const { service } = setup({ existing: null });
    expect(await service.suspend(ctx, admin, fenceOf({}), 'nope', apiCall)).toEqual({
      ok: false,
      error: 'not_found',
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
  it.each(['create', 'setPermissions', 'suspend', 'restore'] as const)(
    'passes one %s event',
    async (method) => {
      const r = setup();
      const held = fenceOf();
      const call = { ...apiCall, idempotency: principalRecord };
      const result =
        method === 'create'
          ? await r.service.create(
              ctx,
              authenticated(),
              actor,
              held,
              { name: 'ci', projectId: PROJECT },
              call,
            )
          : method === 'setPermissions'
            ? await r.service.setPermissions(ctx, actor, held, 'sp-1', ['project:read'], call)
            : await r.service[method](ctx, actor, held, 'sp-1', call);
      expect(result.ok).toBe(true);
      expect(r.principals[method]).toHaveBeenCalledTimes(1);
      const stored = (r.principals[method].mock.calls[0] as unknown[])[3] as Parameters<
        ServicePrincipalStore['create']
      >[3];
      expect(stored.audit).toEqual({
        id: method === 'create' ? 'ID02' : 'ID01',
        occurredAt: NOW,
        action: 'service_principal.' + (method === 'setPermissions' ? 'permissions_set' : method),
        actor: { type: 'user', id: actor.userId },
        target: { type: 'service_principal', id: method === 'create' ? 'ID00' : 'sp-1' },
        projectId: PROJECT,
        sourceIp: null,
        tokenSelector: null,
        payloadJson: expect.any(String),
      });
      const changes =
        method === 'create'
          ? {
              name: { new: 'ci' },
              project_id: { new: PROJECT },
              permissions: {
                new: ['project:packages:read', 'project:packages:write', 'project:read'],
              },
            }
          : method === 'setPermissions'
            ? { permissions: { new: ['project:read'] } }
            : undefined;
      expect(JSON.parse(stored.audit!.payloadJson)).toEqual({
        op_id: call.audit.opId,
        request_id: call.audit.requestId,
        ...(changes === undefined ? {} : { changes }),
      });
      expect(stored.idempotency).toBe(principalRecord);
    },
  );

  it.each(['create', 'setPermissions', 'suspend', 'restore'] as const)(
    'omits absent %s idempotency',
    async (method) => {
      const r = setup();
      const held = fenceOf();
      if (method === 'create')
        await r.service.create(
          ctx,
          authenticated(),
          actor,
          held,
          { name: 'ci', projectId: PROJECT },
          apiCall,
        );
      else if (method === 'setPermissions')
        await r.service.setPermissions(ctx, actor, held, 'sp-1', ['project:read'], apiCall);
      else await r.service[method](ctx, actor, held, 'sp-1', apiCall);
      expect((r.principals[method].mock.calls[0] as unknown[])[3]).not.toHaveProperty(
        'idempotency',
      );
    },
  );

  it('requires a call for every user mutation', () => {
    expectTypeOf<Parameters<ServicePrincipalService['create']>['length']>().toEqualTypeOf<6>();
    expectTypeOf<
      Parameters<ServicePrincipalService['setPermissions']>['length']
    >().toEqualTypeOf<6>();
    expectTypeOf<Parameters<ServicePrincipalService['suspend']>['length']>().toEqualTypeOf<5>();
    expectTypeOf<Parameters<ServicePrincipalService['restore']>['length']>().toEqualTypeOf<5>();
  });
});
const principalRecord = {
  principalKey: 'user:actor-1',
  key: 'principal',
  route: '/principals',
  requestHash: 'hash',
  status: 200,
  responseJson: '{}',
  createdAt: NOW,
  expiresAt: '2026-10-16T08:00:00.000Z',
};

import { setAccessContext } from './access-context.js';
import { projectSessionCallContext } from '../api/routes/context.js';
import type { RequestContext } from '../plugin.js';

function projectIdentity() {
  const request: RequestContext = {
    request: new Request('https://broker.test/_pb/projects/demo/service-principals'),
    requestId: apiCall.audit.requestId,
    org: ctx,
    principal: { kind: 'user', id: 'actor-1' },
    projectId: PROJECT,
    params: {},
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock(NOW),
      ids: { ulid: () => 'unused' },
    },
  };
  setAccessContext(request, {
    principal: request.principal,
    boundary: 'project',
    projectId: PROJECT,
    sessionId: 'session-1',
    token: null,
    actor: {
      session: { id: 'session-1' },
      user: { id: 'actor-1' },
      organizationPermissions: ['org:service-principals:write'],
      projectPermissions: ['project:service-principals:write'],
      protectedHolder: true,
    },
    rateKey: {
      stage: 'authenticated',
      tokenSelector: null,
      principalId: 'actor-1',
      routeClass: 'project',
    },
  });
  return projectSessionCallContext(request, {
    ids: { ulid: () => apiCall.audit.opId },
    clock: fixedClock(NOW),
    clientIp: () => null,
  });
}

describe('project session identity actor', () => {
  it('suspends a project principal through the live fenced project authority', async () => {
    const identity = projectIdentity();
    const { service, authority, principals } = setup({
      live: ['project:service-principals:write'],
    });
    expect(
      await service.suspend(identity.org, identity.actor, identity.fence, 'sp-1', identity.call),
    ).toEqual({ ok: true, value: null });
    expect(authority.guard).toHaveBeenCalledTimes(1);
    expect(principals.suspend).toHaveBeenCalledTimes(1);
  });

  it('cannot manage an organization principal even with both live permissions', async () => {
    const identity = projectIdentity();
    const { service, authority, principals } = setup({
      existing: principal({ projectId: null }),
      live: ['org:service-principals:write', 'project:service-principals:write'],
    });
    expect(
      await service.suspend(identity.org, identity.actor, identity.fence, 'sp-1', identity.call),
    ).toEqual({ ok: false, error: 'not_found' });
    expect(authority.guard).not.toHaveBeenCalled();
    for (const write of [
      principals.create,
      principals.setPermissions,
      principals.suspend,
      principals.restore,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
  });
});
