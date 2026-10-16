import { describe, expect, it, vi } from 'vitest';
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

const actor: ActorContext = {
  userId: 'actor-1',
  permissions: new Set(['org:read']),
  isOrganizationAdmin: false,
};
const admin: ActorContext = {
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
    clock: fixedClock(NOW),
    ids: { ulid: () => `ID${String(next++).padStart(2, '0')}` },
    log,
  });
  return { service, principals, authority, createdBy, log, guard };
}

const events = (log: ReturnType<typeof vi.fn>, name: string) =>
  log.mock.calls.map(([entry]) => entry).filter((entry) => entry.event === name);

describe('create', () => {
  it('snapshots exactly the creator non-sessionOnly permissions inside the project boundary', async () => {
    const { service, principals, authority, guard } = setup();
    const fence = fenceOf({});
    const result = await service.create(ctx, actor, fence, { name: 'ci', projectId: PROJECT });
    expect(result).toEqual({
      ok: true,
      value: {
        id: 'ID00',
        permissions: ['project:packages:read', 'project:packages:write', 'project:read'],
      },
    });
    expect(principals.create).toHaveBeenCalledWith(ctx, fence, guard, {
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
    });
  });

  it('never snapshots session-only permissions such as the management and token-issue grants', async () => {
    const { service, principals } = setup();
    await service.create(ctx, actor, fenceOf({}), { name: 'ci', projectId: PROJECT });
    const stored = (principals.create.mock.calls[0] as unknown[])[3] as { permissions: string[] };
    expect(stored.permissions).not.toContain('project:service-principals:write');
    expect(stored.permissions).not.toContain('project:tokens:create');
    expect(stored.permissions.some((name) => name.startsWith('org:'))).toBe(false);
  });

  it('refuses when the creator lacks project:service-principals:write, even with project:tokens:create', async () => {
    const { service, principals, log } = setup({ live: ['project:read', 'project:tokens:create'] });
    expect(
      await service.create(ctx, actor, fenceOf({}), { name: 'ci', projectId: PROJECT }),
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
    const result = await service.create(ctx, admin, fence, { name: 'ci', projectId: null });
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
    });
  });

  it('refuses an organization-wide principal without current admin status', async () => {
    const { service, principals } = setup();
    const notAdmin = { ...admin, isOrganizationAdmin: false };
    expect(
      await service.create(ctx, notAdmin, fenceOf({}), { name: 'ci', projectId: null }),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(principals.create).not.toHaveBeenCalled();
  });

  it('refuses an organization-wide principal for an admin missing org:service-principals:write', async () => {
    const { service, principals } = setup({ live: ['org:read'] });
    expect(await service.create(ctx, admin, fenceOf({}), { name: 'ci', projectId: null })).toEqual({
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
        await service.create(ctx, actor, fenceOf({}), { name: 'ci', projectId: PROJECT }),
      ).toEqual(expected);
      expect(events(log, 'service_principal.changed')).toHaveLength(0);
    }
  });

  it('refuses a malformed project id before reading authority', async () => {
    const { service, authority } = setup();
    for (const projectId of ['', 7, undefined]) {
      expect(
        await service.create(ctx, actor, fenceOf({}), {
          name: 'ci',
          projectId: projectId as never,
        }),
      ).toEqual({ ok: false, error: 'project_mismatch' });
    }
    expect(authority.livePermissions).not.toHaveBeenCalled();
  });

  it('rejects an invalid name before reading authority', async () => {
    const { service, authority } = setup();
    for (const name of ['', 'a\u0000b', 'x'.repeat(101), 7 as unknown as string]) {
      expect(await service.create(ctx, actor, fenceOf({}), { name, projectId: PROJECT })).toEqual({
        ok: false,
        error: 'invalid_name',
      });
    }
    expect(authority.livePermissions).not.toHaveBeenCalled();
  });

  it('throws when the fence belongs to another user', async () => {
    const { service, principals } = setup();
    await expect(
      service.create(ctx, actor, fenceOf({}, 'someone-else'), { name: 'ci', projectId: PROJECT }),
    ).rejects.toThrow(TypeError);
    expect(principals.create).not.toHaveBeenCalled();
  });

  it('emits one change event on success', async () => {
    const { service, log } = setup();
    await service.create(ctx, actor, fenceOf({}), { name: 'ci', projectId: PROJECT });
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
      await service.setPermissions(ctx, actor, fence, 'sp-1', [
        'project:read',
        'project:packages:write',
      ]),
    ).toEqual({ ok: true, value: null });
    expect(principals.setPermissions).toHaveBeenCalledWith(
      ctx,
      fence,
      guard,
      'sp-1',
      ['project:packages:write', 'project:read'],
      NOW,
      'ID00',
    );
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
      await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:sources:read']),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(principals.setPermissions).not.toHaveBeenCalled();
    expect(events(log, 'admin.denied')).toHaveLength(1);
  });

  it('refuses without the management permission', async () => {
    const { service, principals } = setup({ live: ['project:read'] });
    expect(await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:read'])).toEqual({
      ok: false,
      error: 'forbidden',
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
      expect(await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', list)).toMatchObject({
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
      await service.setPermissions(ctx, admin, fenceOf(), 'sp-1', ['org:settings:write']),
    ).toMatchObject({
      ok: false,
      error: 'invalid_permission',
    });
    expect(await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['org:read'])).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(principals.setPermissions).not.toHaveBeenCalled();
    expect(
      await service.setPermissions(ctx, admin, fenceOf(), 'sp-1', ['org:read', 'project:read']),
    ).toEqual({ ok: true, value: null });
  });

  it('never carries a project binding to the repository', async () => {
    const { service, principals } = setup();
    await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:read']);
    const args = principals.setPermissions.mock.calls[0] as unknown[];
    expect(args).toHaveLength(7);
    expect(JSON.stringify(args.slice(3))).not.toContain(PROJECT);
  });

  it('answers not_found for an unknown id and invalid_revision for a fence with no revision', async () => {
    const missing = setup({ existing: null });
    expect(
      await missing.service.setPermissions(ctx, actor, fenceOf(), 'nope', ['project:read']),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    const { service, principals } = setup();
    expect(await service.setPermissions(ctx, actor, fenceOf({}), 'sp-1', ['project:read'])).toEqual(
      {
        ok: false,
        error: 'invalid_revision',
      },
    );
    expect(principals.setPermissions).not.toHaveBeenCalled();
  });

  it('allows archived projects only when the change narrows the stored set', async () => {
    const { service, authority } = setup({
      existing: principal({ permissions: ['project:read', 'project:packages:read'] }),
    });
    await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:read']);
    expect(authority.guard.mock.calls[0]?.[2]).toMatchObject({ allowArchived: true });
    await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:packages:write']);
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
        await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:read']),
      ).toMatchObject(expected as object);
    }
  });
});

describe('suspend and restore', () => {
  it('suspends one principal and touches nothing else', async () => {
    const { service, principals, createdBy, log } = setup();
    expect(await service.suspend(ctx, actor, fenceOf({}), 'sp-1')).toEqual({
      ok: true,
      value: null,
    });
    expect(principals.suspend).toHaveBeenCalledTimes(1);
    expect(principals.suspend).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.anything(),
      'sp-1',
      NOW,
      'ID00',
    );
    expect(principals.setPermissions).not.toHaveBeenCalled();
    expect(principals.restore).not.toHaveBeenCalled();
    expect(createdBy).not.toHaveBeenCalled();
    expect(events(log, 'service_principal.changed')).toEqual([
      expect.objectContaining({ action: 'suspended', servicePrincipalId: 'sp-1' }),
    ]);
  });

  it('restores and reports not_suspended without an event', async () => {
    const { service, principals, log } = setup();
    expect(await service.restore(ctx, actor, fenceOf(), 'sp-1')).toEqual({
      ok: true,
      value: null,
    });
    principals.restore.mockResolvedValue('not_suspended');
    expect(await service.restore(ctx, actor, fenceOf(), 'sp-1')).toEqual({
      ok: false,
      error: 'not_suspended',
    });
    expect(events(log, 'service_principal.changed')).toHaveLength(1);
  });

  it('requires the management permission and, for organization-wide, admin status', async () => {
    const none = setup({ live: ['project:read'] });
    expect(await none.service.suspend(ctx, actor, fenceOf({}), 'sp-1')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    const wide = setup({ existing: principal({ projectId: null, permissions: ['org:read'] }) });
    expect(await wide.service.suspend(ctx, actor, fenceOf({}), 'sp-1')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await wide.service.restore(ctx, admin, fenceOf(), 'sp-1')).toEqual({
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
    expect(await refused.service.restore(ctx, actor, fenceOf(), 'sp-1')).toEqual({
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
    expect(await service.restore(ctx, actor, fenceOf(), 'sp-1')).toEqual({
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
    expect(await service.restore(ctx, actor, fenceOf({}), 'sp-1')).toEqual({
      ok: false,
      error: 'invalid_revision',
    });
    expect(await service.restore(ctx, actor, fenceOf({ service_principal: 3 }), 'sp-1')).toEqual({
      ok: false,
      error: 'conflict',
    });
    expect(principals.restore).not.toHaveBeenCalled();
    expect(authority.guard).not.toHaveBeenCalled();
    principals.restore.mockResolvedValue('conflict');
    expect(await service.restore(ctx, actor, fenceOf({ service_principal: 4 }), 'sp-1')).toEqual({
      ok: false,
      error: 'conflict',
    });
  });

  it('refuses a stale permission change before building a guard', async () => {
    const { service, principals, authority } = setup({
      existing: principal({ revision: 5 }),
    });
    expect(await service.setPermissions(ctx, actor, fenceOf(), 'sp-1', ['project:read'])).toEqual({
      ok: false,
      error: 'conflict',
    });
    expect(authority.guard).not.toHaveBeenCalled();
    expect(principals.setPermissions).not.toHaveBeenCalled();
  });

  it('treats an empty or non-string id as unknown, forbidden for an actor who manages nothing', async () => {
    const { service } = setup({ live: ['project:read'] });
    for (const id of ['', 7 as unknown as string]) {
      expect(await service.suspend(ctx, actor, fenceOf({}), id)).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(await service.setPermissions(ctx, actor, fenceOf(), id, ['project:read'])).toEqual({
        ok: false,
        error: 'forbidden',
      });
    }
  });

  it('allows suspension on an archived project and answers an unchanged repeat without an event', async () => {
    const { service, principals, authority, log } = setup();
    principals.suspend.mockResolvedValue('unchanged');
    expect(await service.suspend(ctx, actor, fenceOf({}), 'sp-1')).toEqual({
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

  it('answers forbidden, not not_found, for an unknown id when the actor manages nothing', async () => {
    const { service } = setup({ existing: null, live: ['project:read'] });
    expect(await service.suspend(ctx, actor, fenceOf({}), 'nope')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await service.restore(ctx, actor, fenceOf(), 'nope')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await service.setPermissions(ctx, actor, fenceOf(), 'nope', ['project:read'])).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('answers not_found and maps repository refusals', async () => {
    const missing = setup({ existing: null });
    expect(await missing.service.suspend(ctx, actor, fenceOf({}), 'nope')).toEqual({
      ok: false,
      error: 'not_found',
    });
    const { service, principals } = setup();
    principals.suspend.mockResolvedValue('authority');
    expect(await service.suspend(ctx, actor, fenceOf({}), 'sp-1')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    principals.suspend.mockResolvedValue('indeterminate');
    expect(await service.suspend(ctx, actor, fenceOf({}), 'sp-1')).toEqual({
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
