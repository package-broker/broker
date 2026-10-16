import { describe, expect, it, vi } from 'vitest';
import type { GrantRepository } from '../db/grants.js';
import { orgContext } from '../db/port.js';
import type { Role, RoleRepository } from '../db/roles.js';
import type { User } from '../db/users.js';
import { fixedClock } from '../ids.js';
import type { IdentityProvider } from '../identity/port.js';
import { createAdministration } from './administration.js';
import type { ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor, type MutationFence } from './fence.js';

const ctx = orgContext('org-a');
const NOW = '2026-10-15T08:00:00.000Z';

const actor: ActorContext = {
  userId: 'actor-1',
  permissions: new Set(['org:roles:write', 'org:read']),
  isOrganizationAdmin: false,
};

function fenceOf(userId: string, expected: Record<string, number> = { role: 3 }): MutationFence {
  return mutationFence(
    { userId, sessionId: 'session-1' } as unknown as AuthenticatedActor,
    expected,
  );
}

const role: Role = {
  id: 'role-1',
  key: 'ops',
  name: 'Ops',
  scope: 'organization',
  isSystem: false,
  protectsLastHolder: false,
  permissions: ['org:read'],
  revision: 3,
};

function setup(answer: unknown = undefined) {
  const roles = {
    list: vi.fn(async () => [role]),
    get: vi.fn(async () => role),
    create: vi.fn(async () => answer ?? 'created'),
    rename: vi.fn(async () => answer ?? 'renamed'),
    setPermissions: vi.fn(async () => answer ?? 'updated'),
    delete: vi.fn(async () => answer ?? 'deleted'),
  };
  const log = vi.fn();
  let next = 0;
  const admin = createAdministration({
    roles: roles as unknown as RoleRepository,
    grants: {} as unknown as GrantRepository,
    users: { get: vi.fn(async (): Promise<User | null> => null) },
    providers: new Map<string, IdentityProvider>(),
    clock: fixedClock(NOW),
    ids: { ulid: () => `ID${String(next++).padStart(2, '0')}` },
    log,
  });
  return { admin, roles, log };
}

type Call = (admin: ReturnType<typeof setup>['admin'], fence: MutationFence) => Promise<unknown>;

const CALLS: Record<string, Call> = {
  createRole: (admin, fence) =>
    admin.createRole(ctx, actor, fence, {
      key: 'ops2',
      name: 'Ops 2',
      scope: 'organization',
      permissions: ['org:read'],
    }),
  renameRole: (admin, fence) => admin.renameRole(ctx, actor, fence, 'role-1', 'Operators'),
  setRolePermissions: (admin, fence) =>
    admin.setRolePermissions(ctx, actor, fence, 'role-1', ['org:read']),
  deleteRole: (admin, fence) => admin.deleteRole(ctx, actor, fence, 'role-1'),
};

const REPOSITORY_METHOD: Record<string, 'create' | 'rename' | 'setPermissions' | 'delete'> = {
  createRole: 'create',
  renameRole: 'rename',
  setRolePermissions: 'setPermissions',
  deleteRole: 'delete',
};

describe('role mutators carry the fence', () => {
  for (const [name, call] of Object.entries(CALLS)) {
    const method = REPOSITORY_METHOD[name] as 'create' | 'rename' | 'setPermissions' | 'delete';

    it(`${name} hands the same fence and a fresh op id to the repository`, async () => {
      const { admin, roles } = setup();
      const fence = fenceOf('actor-1');
      expect(await call(admin, fence)).toMatchObject({ ok: true });
      const args = (roles[method] as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      expect(args[0]).toBe(ctx);
      expect(args[1]).toBe(fence);
      const opId =
        method === 'create'
          ? (args[2] as { opId?: string }).opId
          : args.find((value) => typeof value === 'string' && /^ID\d+$/.test(value));
      expect(opId).toBeDefined();
    });

    it(`${name} refuses a fence of another user with TypeError and touches nothing`, async () => {
      const { admin, roles } = setup();
      await expect(call(admin, fenceOf('someone-else'))).rejects.toBeInstanceOf(TypeError);
      expect(roles[method]).not.toHaveBeenCalled();
    });

    it(`${name} refuses a missing fence with TypeError`, async () => {
      const { admin, roles } = setup();
      await expect(call(admin, undefined as unknown as MutationFence)).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(roles[method]).not.toHaveBeenCalled();
    });

    it(`${name} maps authority, conflict and indeterminate without logging a change`, async () => {
      for (const [answer, expected] of [
        ['authority', 'forbidden'],
        ['conflict', 'conflict'],
        ['indeterminate', 'indeterminate'],
      ] as const) {
        if (name === 'createRole' && answer === 'conflict') continue;
        const { admin, log } = setup(answer);
        expect(await call(admin, fenceOf('actor-1'))).toMatchObject({ ok: false, error: expected });
        expect(log.mock.calls.some(([entry]) => entry.event === 'role.changed')).toBe(false);
      }
    });
  }

  it('a fence without an expected role revision is answered, not thrown, for rename, set and delete', async () => {
    for (const name of ['renameRole', 'setRolePermissions', 'deleteRole'] as const) {
      const { admin, roles } = setup();
      const result = await (CALLS[name] as Call)(admin, fenceOf('actor-1', {}));
      expect(result, name).toEqual({ ok: false, error: 'invalid_revision' });
      expect(roles.rename).not.toHaveBeenCalled();
      expect(roles.setPermissions).not.toHaveBeenCalled();
      expect(roles.delete).not.toHaveBeenCalled();
    }
  });

  it('the expected role revision reaches the repository only through the fence', async () => {
    const { admin, roles } = setup();
    const fence = fenceOf('actor-1', { role: 7 });
    await admin.renameRole(ctx, actor, fence, 'role-1', 'Operators');
    expect((roles.rename.mock.calls[0] as unknown[])[1]).toMatchObject({ expected: { role: 7 } });
  });
});
