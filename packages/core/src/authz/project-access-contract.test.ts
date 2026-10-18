import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import type { GrantRepository } from '../db/grants.js';
import type { RoleRepository } from '../db/roles.js';
import { fixedClock } from '../ids.js';
import type { RequestContext } from '../plugin.js';
import { organizationActorOf, setAccessContext } from './access-context.js';
import { buildOrganizationActor } from './actor.js';
import { createAdministration, type ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor } from './fence.js';
import type { ProjectActor } from './project-actor.js';
import { createProjectAdministration, type ProjectGrantStore } from './project-administration.js';
import { createProjectLister } from './project-list.js';
import { resolveProjectPath } from './project-path.js';
import { createProjectService, type ProjectStore } from './project-service.js';

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

const PROJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const clock = fixedClock('2026-10-15T12:00:00.000Z');
const ids = { ulid: () => PROJECT_ID };

function kernelActor(organizationPermissions: readonly string[]) {
  const requestContext: RequestContext = {
    request: new Request('https://broker.test/_pb/projects'),
    requestId: 'request',
    org: ctx,
    principal: { kind: 'user', id: 'actor' },
    projectId: null,
    params: {},
    ports: { organizations: { get: async () => null }, clock, ids },
  };
  setAccessContext(requestContext, {
    principal: requestContext.principal,
    projectId: null,
    boundary: 'organization',
    sessionId: 'session',
    actor: {
      session: { id: 'session', userId: 'actor' },
      user: { id: 'actor' },
      organizationPermissions,
      projectPermissions: [],
      protectedHolder: false,
    },
    rateKey: {
      stage: 'authenticated',
      tokenSelector: null,
      principalId: 'actor',
      routeClass: 'organization',
    },
  });
  const actor = organizationActorOf(requestContext);
  if (actor === null) throw new Error('expected a kernel actor');
  expect(actor.permissions).not.toBeInstanceOf(Set);
  return actor;
}

function fenceFor(actor: { readonly userId: string; readonly sessionId: string }) {
  return mutationFence(actor as AuthenticatedActor, {});
}

describe('kernel permission views across services', () => {
  it('project-service accepts a kernel actor and enforces org:projects:create', async () => {
    const create = vi.fn<ProjectStore['create']>(async () => 'created');
    const service = createProjectService({
      projects: { create } as unknown as ProjectStore,
      clock,
      ids,
      log: vi.fn(),
    });
    const allowed = kernelActor(['org:projects:create']);
    expect(
      await service.createProject(ctx, allowed, fenceFor(allowed), { slug: 'shop', name: 'Shop' }),
    ).toEqual({ ok: true, value: { id: PROJECT_ID, slug: 'shop' } });
    expect(create).toHaveBeenCalledOnce();
    create.mockClear();
    const denied = kernelActor(['org:projects:archive']);
    expect(
      await service.createProject(ctx, denied, fenceFor(denied), { slug: 'shop', name: 'Shop' }),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(create).not.toHaveBeenCalled();
  });

  it('administration accepts a kernel actor and enforces org:roles:write', async () => {
    const { admin, write } = administration();
    write.mockResolvedValue('created');
    const input = {
      key: 'custom',
      name: 'Custom',
      scope: 'organization',
      permissions: [],
    } as const;
    const allowed = kernelActor(['org:roles:write']);
    expect(await admin.createRole(ctx, allowed, fenceFor(allowed), input)).toMatchObject({
      ok: true,
      value: { id: PROJECT_ID, key: 'custom' },
    });
    expect(write).toHaveBeenCalledOnce();
    write.mockClear();
    const denied = kernelActor(['org:read']);
    expect(await admin.createRole(ctx, denied, fenceFor(denied), input)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('project-list accepts a kernel actor and enforces project:read', async () => {
    const project = { id: PROJECT_ID, slug: 'shop', name: 'Shop', status: 'active' } as const;
    const list = vi.fn(async () => [project]);
    const permissionsFor = vi.fn(async () => new Map<string, ReadonlySet<string>>());
    const lister = createProjectLister({ source: { list }, access: { permissionsFor } });
    expect(await lister.list(ctx, kernelActor(['project:read']), { limit: 10 })).toEqual({
      ok: true,
      value: { items: [project], nextAfterId: null },
    });
    expect(permissionsFor).not.toHaveBeenCalled();
    expect(await lister.list(ctx, kernelActor(['org:read']), { limit: 10 })).toEqual({
      ok: true,
      value: { items: [], nextAfterId: null },
    });
    expect(permissionsFor).toHaveBeenCalledExactlyOnceWith(ctx, 'actor', [PROJECT_ID]);
  });

  it('project-administration accepts a kernel permission view and enforces project:grants:write', async () => {
    const create = vi.fn<ProjectGrantStore['create']>(async () => 'created');
    const service = createProjectAdministration({
      grants: { create } as unknown as ProjectGrantStore,
      providers: new Map(),
      providerAnchors: [],
      clock,
      ids,
      log: vi.fn(),
    });
    const input = {
      subject: { type: 'email', value: 'dev@example.test' },
      roleId: PROJECT_ID,
    } as const;
    for (const permitted of [true, false]) {
      const kernel = kernelActor(permitted ? ['project:grants:write'] : ['project:read']);
      // Project administration still requires authority bound to this organization and project.
      const actor: ProjectActor = {
        kind: 'project',
        userId: kernel.userId,
        orgId: ctx.orgId,
        projectId: PROJECT_ID,
        permissions: kernel.permissions,
      };
      const result = await service.grant(ctx, actor, fenceFor(kernel), PROJECT_ID, input);
      if (permitted) {
        expect(result).toMatchObject({ ok: true, value: { projectId: PROJECT_ID } });
        expect(create).toHaveBeenCalledOnce();
      } else {
        expect(result).toEqual({ ok: false, error: 'forbidden' });
        expect(create).not.toHaveBeenCalled();
      }
      create.mockClear();
    }
    const organization = kernelActor(['project:grants:write']);
    expect(
      // @ts-expect-error A kernel organization actor cannot supply project-bound authority.
      await service.grant(ctx, organization, fenceFor(organization), PROJECT_ID, input),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([undefined, null, [], 'project:read', {}, { has: () => true }, { has: true }])(
    'project-list rejects malformed permissions %j before consulting any source',
    async (permissions) => {
      const list = vi.fn(async () => []);
      const permissionsFor = vi.fn(async () => new Map<string, ReadonlySet<string>>());
      const listReadableProjects = vi.fn(async () => []);
      const actor = { ...kernelActor([]), permissions } as unknown as ActorContext;
      for (const deps of [
        { source: { list }, access: { permissionsFor } },
        { source: { list }, readable: { listReadableProjects } },
      ]) {
        expect(await createProjectLister(deps).list(ctx, actor, { limit: 10 })).toEqual({
          ok: false,
          error: 'forbidden',
        });
      }
      expect(list).not.toHaveBeenCalled();
      expect(permissionsFor).not.toHaveBeenCalled();
      expect(listReadableProjects).not.toHaveBeenCalled();
    },
  );
});

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
