import { describe, expect, it, vi } from 'vitest';
import type { GrantRepository, OrganizationGrant } from '../db/grants.js';
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
  kind: 'organization',
  userId: 'actor-1',
  permissions: new Set(['org:grants:write', 'org:read']),
  isOrganizationAdmin: false,
};

function fenceOf(userId: string, expected: Record<string, number> = { grant: 4 }): MutationFence {
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
  revision: 1,
};
const grant: OrganizationGrant = {
  id: 'g1',
  subject: { type: 'email', value: 'someone@example.com' },
  roleId: 'role-1',
  createdBy: null,
  createdAt: NOW,
  revision: 1,
};

function setup(answer: unknown = undefined) {
  const grants = {
    listOrganization: vi.fn(async () => [grant]),
    createOrganization: vi.fn(async () => answer ?? 'created'),
    deleteOrganization: vi.fn(async () => answer ?? 'deleted'),
    changeRole: vi.fn(async () => answer ?? 'updated'),
  };
  const log = vi.fn();
  let next = 0;
  const admin = createAdministration({
    roles: {
      list: vi.fn(async () => [role]),
      get: vi.fn(async () => role),
    } as unknown as RoleRepository,
    grants: grants as unknown as GrantRepository,
    users: { get: vi.fn(async (): Promise<User | null> => ({ id: 'actor-1' }) as User) },
    providers: new Map<string, IdentityProvider>(),
    clock: fixedClock(NOW),
    ids: { ulid: () => `ID${String(next++).padStart(2, '0')}` },
    log,
  });
  return { admin, grants, log };
}

type Call = (admin: ReturnType<typeof setup>['admin'], fence: MutationFence) => Promise<unknown>;
type Method = 'createOrganization' | 'deleteOrganization' | 'changeRole';

const CALLS: Record<string, Call> = {
  grantOrganization: (admin, fence) =>
    admin.grantOrganization(ctx, actor, fence, {
      subject: { type: 'email', value: 'new@example.com' },
      roleId: 'role-1',
    }),
  revokeOrganizationGrant: (admin, fence) => admin.revokeOrganizationGrant(ctx, actor, fence, 'g1'),
  changeGrantRole: (admin, fence) => admin.changeGrantRole(ctx, actor, fence, 'g1', 'role-1'),
};

const METHOD: Record<string, Method> = {
  grantOrganization: 'createOrganization',
  revokeOrganizationGrant: 'deleteOrganization',
  changeGrantRole: 'changeRole',
};

describe('grant mutators carry the fence', () => {
  for (const [name, call] of Object.entries(CALLS)) {
    const method = METHOD[name] as Method;

    it(`${name} hands the same fence and a fresh op id to the repository`, async () => {
      const { admin, grants } = setup();
      const fence = fenceOf('actor-1');
      expect(await call(admin, fence)).toMatchObject({ ok: true });
      const args = (grants[method] as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      expect(args[0]).toBe(ctx);
      expect(args[1]).toBe(fence);
      const opId =
        method === 'createOrganization'
          ? (args[2] as { opId?: string }).opId
          : args.find((value) => typeof value === 'string' && /^ID\d+$/.test(value));
      expect(opId).toMatch(/^ID\d+$/);
    });

    it(`${name} refuses a fence of another user with TypeError and touches nothing`, async () => {
      const { admin, grants } = setup();
      await expect(call(admin, fenceOf('someone-else'))).rejects.toBeInstanceOf(TypeError);
      expect(grants[method]).not.toHaveBeenCalled();
    });

    it(`${name} refuses a missing fence with TypeError`, async () => {
      const { admin, grants } = setup();
      await expect(call(admin, undefined as unknown as MutationFence)).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(grants[method]).not.toHaveBeenCalled();
    });

    it(`${name} maps authority, conflict and indeterminate without logging a change`, async () => {
      for (const [answer, expected] of [
        ['authority', 'forbidden'],
        ['conflict', 'conflict'],
        ['indeterminate', 'indeterminate'],
      ] as const) {
        if (name === 'grantOrganization' && answer === 'conflict') continue;
        const { admin, log } = setup(answer);
        expect(await call(admin, fenceOf('actor-1'))).toMatchObject({ ok: false, error: expected });
        expect(log.mock.calls.some(([entry]) => entry.event === 'grant.changed')).toBe(false);
      }
    });
  }

  it('revoke and change answer invalid_revision, not an exception, for a fence without a grant revision', async () => {
    for (const name of ['revokeOrganizationGrant', 'changeGrantRole'] as const) {
      const { admin, grants } = setup();
      const result = await (CALLS[name] as Call)(admin, fenceOf('actor-1', { role: 1 }));
      expect(result, name).toEqual({ ok: false, error: 'invalid_revision' });
      expect(grants.deleteOrganization).not.toHaveBeenCalled();
      expect(grants.changeRole).not.toHaveBeenCalled();
    }
  });

  it('creating a grant needs no revision', async () => {
    const { admin } = setup();
    expect(await (CALLS['grantOrganization'] as Call)(admin, fenceOf('actor-1', {}))).toMatchObject(
      { ok: true },
    );
  });

  it('the expected grant revision reaches the repository only through the fence', async () => {
    const { admin, grants } = setup();
    const fence = fenceOf('actor-1', { grant: 9 });
    await admin.changeGrantRole(ctx, actor, fence, 'g1', 'role-1');
    expect((grants.changeRole.mock.calls[0] as unknown[])[1]).toMatchObject({
      expected: { grant: 9 },
    });
  });
});

describe('revocation needs no subset of the removed role', () => {
  it('a non-admin revokes a grant whose role holds a permission the actor lacks', async () => {
    const wide: Role = { ...role, id: 'role-wide', permissions: ['org:read', 'org:users:write'] };
    const admin = createAdministration({
      roles: { list: vi.fn(async () => [wide]), get: vi.fn(async () => wide) } as never,
      grants: {
        listOrganization: vi.fn(async () => [{ ...grant, roleId: 'role-wide' }]),
        deleteOrganization: vi.fn(async () => 'deleted'),
      } as never,
      users: { get: vi.fn() },
      providers: new Map<string, IdentityProvider>(),
      clock: fixedClock(NOW),
      ids: { ulid: () => 'ID00' },
      log: vi.fn(),
    });
    expect(await admin.revokeOrganizationGrant(ctx, actor, fenceOf('actor-1'), 'g1')).toEqual({
      ok: true,
      value: null,
    });
  });
});
