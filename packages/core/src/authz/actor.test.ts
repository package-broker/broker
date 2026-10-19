import { describe, expect, it, vi } from 'vitest';
import type { GrantRepository } from '../db/grants.js';
import { orgContext } from '../db/port.js';
import type { Role, RoleRepository } from '../db/roles.js';
import { fixedClock } from '../ids.js';
import type { IdentityProvider } from '../identity/port.js';
import { buildOrganizationActor } from './actor.js';
import type { ActorAccessSnapshot, ProjectActor } from './actor.js';
import type { ProjectActor as ProjectActorFromModule } from './project-actor.js';
import { createAdministration } from './administration.js';
import type { ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor } from './fence.js';

const ctx = orgContext('org-a');

const snapshot = (
  overrides: Partial<Record<keyof ActorAccessSnapshot | 'project', unknown>> = {},
) =>
  ({
    session: { id: 'session-1', userId: 'user-1' },
    user: { id: 'user-1' },
    project: null,
    organizationPermissions: ['org:read'],
    projectPermissions: [],
    protectedHolder: false,
    ...overrides,
  }) as unknown as ActorAccessSnapshot;

function administration(rolePermissions: string[] = ['org:read']) {
  const roles = {
    list: vi.fn(async () => []),
    get: vi.fn(async (_ctx: unknown, id: string): Promise<Role> => ({
      id,
      key: id,
      name: id,
      scope: 'organization',
      isSystem: false,
      protectsLastHolder: false,
      revision: 1,
      permissions: rolePermissions,
    })),
    create: vi.fn(async () => 'created'),
    rename: vi.fn(async () => 'renamed'),
    setPermissions: vi.fn(async () => 'updated'),
    delete: vi.fn(async () => 'deleted'),
  };
  const admin = createAdministration({
    roles: roles as unknown as RoleRepository,
    grants: {} as unknown as GrantRepository,
    users: { get: vi.fn(async () => null) },
    providers: new Map<string, IdentityProvider>(),
    clock: fixedClock('2026-10-16T08:00:00.000Z'),
    ids: { ulid: () => 'ID00' },
    log: vi.fn(),
  });
  return { admin, roles };
}

const testFence = (userId: string) =>
  mutationFence({ userId, sessionId: 'fixture' } as unknown as AuthenticatedActor, { role: 1 });

describe('buildOrganizationActor keeps organization grant rows only', () => {
  it('ignores project rows and org-looking strings injected into the project set', () => {
    const actor = buildOrganizationActor(
      'organization',
      snapshot({
        organizationPermissions: ['org:read', 'project:read'],
        projectPermissions: ['org:roles:write', 'org:grants:write', 'org:*', 'organization_admin'],
      }),
    );
    expect(actor).not.toBeNull();
    expect(actor?.kind).toBe('organization');
    expect([...(actor?.permissions ?? [])].sort()).toEqual(['org:read', 'project:read']);
    expect(actor?.isOrganizationAdmin).toBe(false);
  });

  it('keeps project:* names that come from an organization grant row', () => {
    const actor = buildOrganizationActor(
      'organization',
      snapshot({ organizationPermissions: ['project:settings:write', 'project:read'] }),
    );
    expect(actor?.permissions.has('project:settings:write')).toBe(true);
    expect(actor?.permissions.has('project:read')).toBe(true);
  });

  it('sets isOrganizationAdmin from a protects-last-holder organization grant', () => {
    const actor = buildOrganizationActor('organization', snapshot({ protectedHolder: true }));
    expect(actor?.isOrganizationAdmin).toBe(true);
  });

  it('carries the session id from the access snapshot', () => {
    const actor = buildOrganizationActor(
      'organization',
      snapshot({ session: { id: 'session-42' } }),
    );
    expect(actor?.sessionId).toBe('session-42');
    expect(actor?.userId).toBe('user-1');
  });

  it('copies the permissions so a later change to the snapshot does not reach the actor', () => {
    const permissions = ['org:read'];
    const actor = buildOrganizationActor(
      'organization',
      snapshot({ organizationPermissions: permissions }),
    );
    permissions.push('org:roles:write');
    expect(actor?.permissions.has('org:roles:write')).toBe(false);
    expect(Object.isFrozen(actor)).toBe(true);
  });
});

describe('isOrganizationAdmin is set only by the stored protected-holder bit', () => {
  it.each([
    ['the string false', 'false'],
    ['the string true', 'true'],
    ['the number 1', 1],
    ['a project role key', 'organization_admin'],
    ['a PAT prefix', 'pbp_'],
    ['a service token prefix', 'pbs_'],
    ['an object', { value: true }],
    ['null', null],
    ['undefined', undefined],
  ])('%s does not set it', (_label, value) => {
    const actor = buildOrganizationActor('organization', snapshot({ protectedHolder: value }));
    expect(actor?.isOrganizationAdmin).toBe(false);
  });

  it('a project role key, token prefix or admin-looking name in the permission sets does not set it', () => {
    const actor = buildOrganizationActor(
      'organization',
      snapshot({
        organizationPermissions: ['organization_admin', 'pbp_', 'isOrganizationAdmin'],
        projectPermissions: ['organization_admin', 'project_owner'],
        protectedHolder: false,
      }),
    );
    expect(actor?.isOrganizationAdmin).toBe(false);
  });

  it('an injected isOrganizationAdmin on the snapshot does not set it', () => {
    const actor = buildOrganizationActor(
      'organization',
      snapshot({ isOrganizationAdmin: true, kind: 'organization' } as never),
    );
    expect(actor?.isOrganizationAdmin).toBe(false);
  });
});

describe('a malformed snapshot builds no actor', () => {
  it.each([
    ['a non-object', null],
    [
      'a session belonging to another user',
      snapshot({ session: { id: 'session-1', userId: 'user-2' } }),
    ],
    ['a session with an empty user id', snapshot({ session: { id: 'session-1', userId: '' } })],
    ['a session with a non-string user id', snapshot({ session: { id: 'session-1', userId: 7 } })],
    ['an empty user id', snapshot({ user: { id: '' } })],
    ['a missing user', snapshot({ user: null })],
    ['a non-string user id', snapshot({ user: { id: 7 } })],
    ['an empty session id', snapshot({ session: { id: '' } })],
    ['a missing session', snapshot({ session: undefined })],
    ['non-array organization permissions', snapshot({ organizationPermissions: 'org:read' })],
    [
      'a Set of organization permissions',
      snapshot({ organizationPermissions: new Set(['org:read']) }),
    ],
    ['a non-string permission', snapshot({ organizationPermissions: ['org:read', 7] })],
    ['an empty permission name', snapshot({ organizationPermissions: [''] })],
  ])('%s', (_label, input) => {
    expect(buildOrganizationActor('organization', input as ActorAccessSnapshot)).toBeNull();
  });
});

describe('the lookup boundary is explicit', () => {
  it.each(['project', 'Organization', '', null, undefined])(
    'boundary %j builds no actor',
    (boundary) => {
      expect(buildOrganizationActor(boundary as 'organization', snapshot())).toBeNull();
    },
  );

  it('a project-boundary lookup builds no actor even when its project is null', () => {
    expect(buildOrganizationActor('project', snapshot({ project: null }))).toBeNull();
  });

  it('an organization-boundary lookup builds an actor whatever the project field holds', () => {
    const actor = buildOrganizationActor('organization', snapshot({ project: { id: 'p1' } }));
    expect(actor?.kind).toBe('organization');
  });

  it('a session without a userId field is accepted on the user id alone', () => {
    const actor = buildOrganizationActor(
      'organization',
      snapshot({ session: { id: 'session-1' } }),
    );
    expect(actor?.userId).toBe('user-1');
  });
});

describe('the built actor and the administration service', () => {
  it('is accepted by the administration service and carries the session id', async () => {
    const { admin, roles } = administration();
    const actor = buildOrganizationActor(
      'organization',
      snapshot({ organizationPermissions: ['org:roles:write'], protectedHolder: true }),
    );
    if (actor === null) throw new Error('expected an actor');
    expect(actor.sessionId).toBe('session-1');
    expect(await admin.deleteRole(ctx, actor, testFence(actor.userId), 'r1', apiCall)).toEqual({
      ok: true,
      value: null,
    });
    expect(roles.delete).toHaveBeenCalledOnce();
  });

  it('a project owner with org-looking project permissions gets no organization authority', async () => {
    const { admin, roles } = administration(['org:roles:write']);
    const actor = buildOrganizationActor(
      'organization',
      snapshot({
        organizationPermissions: [],
        projectPermissions: ['org:roles:write', 'project:grants:write'],
      }),
    );
    if (actor === null) throw new Error('expected an actor');
    expect(actor.permissions.size).toBe(0);
    expect(await admin.deleteRole(ctx, actor, testFence(actor.userId), 'r1', apiCall)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(roles.delete).not.toHaveBeenCalled();
  });

  it('ProjectActor is re-exported unchanged and is not an ActorContext', () => {
    const project: ProjectActor = {
      kind: 'project',
      userId: 'user-1',
      orgId: ctx.orgId,
      projectId: 'p1',
      permissions: new Set(['org:roles:write']),
    };
    const sameType: ProjectActorFromModule = project;
    // @ts-expect-error a project actor never carries organization authority
    const asContext: ActorContext = { ...project, isOrganizationAdmin: false };
    const organization = buildOrganizationActor('organization', snapshot());
    if (organization === null) throw new Error('expected an actor');
    // @ts-expect-error an organization actor is not a project actor
    const asProject: ProjectActor = { ...organization, orgId: ctx.orgId, projectId: 'p1' };
    expect([sameType.kind, asContext.userId, asProject.userId]).toEqual([
      'project',
      'user-1',
      'user-1',
    ]);
  });

  it('the administration service signature refuses a ProjectActor at compile time', () => {
    const { admin } = administration();
    const project: ProjectActor = {
      kind: 'project',
      userId: 'user-1',
      orgId: ctx.orgId,
      projectId: 'p1',
      permissions: new Set(['org:roles:write']),
    };
    const fence = testFence('user-1');
    const probe = () =>
      // @ts-expect-error the administration service accepts an ActorContext only
      admin.deleteRole(ctx, project, fence, 'r1');
    expect(typeof probe).toBe('function');
  });

  it('an actor that differs from an ActorContext only in kind does not compile as one', () => {
    const organization = buildOrganizationActor('organization', snapshot());
    if (organization === null) throw new Error('expected an actor');
    const relabelled = { ...organization, kind: 'project' as const };
    // @ts-expect-error only the kind differs, and the kind decides
    const asContext: ActorContext = relabelled;
    const { admin } = administration();
    const probe = () =>
      // @ts-expect-error the administration service refuses a non-organization kind
      admin.deleteRole(ctx, relabelled, testFence('user-1'), 'r1');
    expect([asContext.kind, typeof probe]).toEqual(['project', 'function']);
  });
});

const apiCall = {
  audit: {
    opId: '01K00000000000000000000001',
    requestId: '01K00000000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};
