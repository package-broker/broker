import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import type { GrantRepository } from '../db/grants.js';
import type { RoleRepository } from '../db/roles.js';
import { fixedClock } from '../ids.js';
import { buildOrganizationActor } from './actor.js';
import { createAdministration, type ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor } from './fence.js';
import type { ProjectActor } from './project-actor.js';
import { resolveProjectPath } from './project-path.js';

const ctx = orgContext('org-a');
const projectActor: ProjectActor = {
  kind: 'project',
  userId: 'actor',
  orgId: ctx.orgId,
  projectId: 'project-a',
  permissions: new Set([
    'project:read',
    'org:*',
    'org:roles:write',
    'org:grants:write',
    'org:users:write',
  ]),
};

function administration() {
  const write = vi.fn();
  const admin = createAdministration({
    roles: {
      create: write,
      rename: write,
      setPermissions: write,
      delete: write,
    } as unknown as RoleRepository,
    grants: {
      createOrganization: write,
      deleteOrganization: write,
      changeRole: write,
      suspendUser: write,
      reactivateUser: write,
    } as unknown as GrantRepository,
    users: { get: vi.fn() },
    providers: new Map(),
    clock: fixedClock('2026-10-15T12:00:00.000Z'),
    ids: { ulid: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    log: vi.fn(),
  });
  return { admin, write };
}

describe('project authority contract', () => {
  it('keeps ProjectActor out of ActorContext and organization administration at compile time', () => {
    const { admin } = administration();
    const probe = (actor: ProjectActor, fence: ReturnType<typeof mutationFence>) => {
      // @ts-expect-error ProjectActor cannot carry organization authority.
      const organizationActor: ActorContext = actor;
      // @ts-expect-error Organization administration requires an organization actor.
      void admin.deleteRole(ctx, actor, fence, 'role');
      return organizationActor;
    };
    expect(probe).toBeTypeOf('function');
  });

  it('ignores org-looking project permissions when building organization authority', () => {
    const snapshot = {
      session: { id: 'session' },
      user: { id: projectActor.userId },
      organizationPermissions: [],
      projectPermissions: [...projectActor.permissions],
      protectedHolder: false,
    };
    expect(buildOrganizationActor('project', snapshot)).toBeNull();
    expect(buildOrganizationActor('organization', snapshot)?.permissions.size).toBe(0);
  });

  it('refuses every organization mutation even with injected permissions and an admin flag', async () => {
    const { admin, write } = administration();
    const actor = { ...projectActor, isOrganizationAdmin: true } as unknown as ActorContext;
    const fence = mutationFence(
      { userId: actor.userId, sessionId: 'session' } as AuthenticatedActor,
      { role: 1, grant: 1 },
    );
    const outcomes = await Promise.all([
      admin.createRole(ctx, actor, fence, {
        key: 'custom',
        name: 'Custom',
        scope: 'organization',
        permissions: [],
      }),
      admin.renameRole(ctx, actor, fence, 'role', 'Renamed'),
      admin.setRolePermissions(ctx, actor, fence, 'role', []),
      admin.deleteRole(ctx, actor, fence, 'role'),
      admin.grantOrganization(ctx, actor, fence, {
        subject: { type: 'group', provider: 'oidc', value: 'ops' },
        roleId: 'role',
      }),
      admin.revokeOrganizationGrant(ctx, actor, fence, 'grant'),
      admin.changeGrantRole(ctx, actor, fence, 'grant', 'role'),
      admin.suspendUser(ctx, actor, fence, 'target'),
      admin.reactivateUser(ctx, actor, fence, 'target'),
    ]);
    for (const outcome of outcomes) expect(outcome).toEqual({ ok: false, error: 'forbidden' });
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['%61lpha', 'alph%61', '%2561lpha', 'alpha%2fbeta', 'Alpha'])(
    'refuses alias %s in every project path family',
    (slug) => {
      for (const path of [
        `/${slug}/packages.json`,
        `/${slug}/p2/vendor/package.json`,
        `/${slug}/dist/file.zip`,
        `/${slug}/npm/package`,
        `/_pb/projects/${slug}/grants`,
      ]) {
        expect(resolveProjectPath(path, new Set())).toEqual({ ok: false });
      }
    },
  );
});
