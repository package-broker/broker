import { describe, expect, it, vi } from 'vitest';
import type { GrantRepository } from '../db/grants.js';
import { orgContext } from '../db/port.js';
import type { RoleRepository } from '../db/roles.js';
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
  permissions: new Set(['org:users:write']),
  isOrganizationAdmin: false,
};

function fenceOf(userId: string): MutationFence {
  return mutationFence({ userId, sessionId: 'session-1' } as unknown as AuthenticatedActor, {});
}

function userOf(status: 'active' | 'suspended'): User {
  return { id: 'u1', email: 'target@example.com', status } as User;
}

function setup(options: { answer?: unknown; status?: 'active' | 'suspended' } = {}) {
  const grants = {
    isProtectedHolder: vi.fn(async () => false),
    listOrganization: vi.fn(async () => []),
    suspendUser: vi.fn(async () => options.answer ?? 'suspended'),
    reactivateUser: vi.fn(async () => options.answer ?? 'reactivated'),
  };
  const log = vi.fn();
  const admin = createAdministration({
    roles: { list: vi.fn(async () => []), get: vi.fn() } as unknown as RoleRepository,
    grants: grants as unknown as GrantRepository,
    users: { get: vi.fn(async () => userOf(options.status ?? 'active')) },
    providers: new Map<string, IdentityProvider>(),
    clock: fixedClock(NOW),
    ids: { ulid: () => 'ID00' },
    log,
  });
  return { admin, grants, log };
}

type Call = (admin: ReturnType<typeof setup>['admin'], fence: MutationFence) => Promise<unknown>;

const CALLS: Record<'suspendUser' | 'reactivateUser', Call> = {
  suspendUser: (admin, fence) => admin.suspendUser(ctx, actor, fence, 'u1', apiCall),
  reactivateUser: (admin, fence) => admin.reactivateUser(ctx, actor, fence, 'u1', apiCall),
};

const changes = (log: ReturnType<typeof vi.fn>) =>
  log.mock.calls.filter(([entry]) => entry.event === 'user.changed');

describe('user status mutators carry the fence', () => {
  for (const [name, call] of Object.entries(CALLS) as [keyof typeof CALLS, Call][]) {
    it(`${name} hands the same fence to the repository`, async () => {
      const { admin, grants } = setup({ status: name === 'suspendUser' ? 'active' : 'suspended' });
      const fence = fenceOf('actor-1');
      expect(await call(admin, fence)).toMatchObject({ ok: true });
      const args = (grants[name] as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      expect(args[0]).toBe(ctx);
      expect(args[1]).toBe(fence);
      expect(args[2]).toEqual({ userId: 'u1', now: NOW, audit: expect.any(Object) });
    });

    it(`${name} refuses a fence of another user with TypeError and touches nothing`, async () => {
      const { admin, grants } = setup();
      await expect(call(admin, fenceOf('someone-else'))).rejects.toBeInstanceOf(TypeError);
      expect(grants[name]).not.toHaveBeenCalled();
    });

    it(`${name} refuses a missing fence with TypeError`, async () => {
      const { admin, grants } = setup();
      await expect(call(admin, undefined as unknown as MutationFence)).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(grants[name]).not.toHaveBeenCalled();
    });

    it(`${name} maps authority, conflict and indeterminate without logging a change`, async () => {
      for (const [answer, expected] of [
        ['authority', 'forbidden'],
        ['conflict', 'conflict'],
        ['indeterminate', 'indeterminate'],
      ] as const) {
        const { admin, log } = setup({ answer });
        expect(await call(admin, fenceOf('actor-1'))).toMatchObject({ ok: false, error: expected });
        expect(changes(log)).toHaveLength(0);
      }
    });

    it(`${name} records an admin.denied event when the batch refuses on authority`, async () => {
      const { admin, log } = setup({ answer: 'authority' });
      await call(admin, fenceOf('actor-1'));
      expect(log.mock.calls.map(([entry]) => entry.event)).toContain('admin.denied');
    });
  }
});

describe('status changes are idempotent', () => {
  it('a suspension the repository applied logs one event, an unchanged one logs none', async () => {
    const applied = setup({ status: 'active' });
    await applied.admin.suspendUser(ctx, actor, fenceOf('actor-1'), 'u1', apiCall);
    expect(changes(applied.log)).toHaveLength(1);
    const unchanged = setup({ answer: 'unchanged', status: 'active' });
    expect(
      await unchanged.admin.suspendUser(ctx, actor, fenceOf('actor-1'), 'u1', apiCall),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(changes(unchanged.log)).toHaveLength(0);
  });

  it('the event follows the repository result, not the status read before the batch', async () => {
    const stale = setup({ answer: 'suspended', status: 'suspended' });
    await stale.admin.suspendUser(ctx, actor, fenceOf('actor-1'), 'u1', apiCall);
    expect(changes(stale.log)).toHaveLength(1);
  });

  it('reactivating an active user is ok and records nothing; an unknown one is not_found', async () => {
    const same = setup({ answer: 'unchanged', status: 'active' });
    expect(await same.admin.reactivateUser(ctx, actor, fenceOf('actor-1'), 'u1', apiCall)).toEqual({
      ok: true,
      value: null,
    });
    expect(changes(same.log)).toHaveLength(0);
    const unknown = setup({ answer: 'not_found', status: 'active' });
    expect(
      await unknown.admin.reactivateUser(ctx, actor, fenceOf('actor-1'), 'u1', apiCall),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(changes(unknown.log)).toHaveLength(0);
  });

  it('last_holder from the batch is surfaced and nothing is recorded', async () => {
    const { admin, log } = setup({ answer: 'last_holder' });
    expect(await admin.suspendUser(ctx, actor, fenceOf('actor-1'), 'u1', apiCall)).toEqual({
      ok: false,
      error: 'last_holder',
    });
    expect(changes(log)).toHaveLength(0);
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
