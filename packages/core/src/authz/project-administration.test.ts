const call = {
  audit: {
    opId: '01K00000000000000000000001',
    requestId: '01K00000000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};
import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor, type MutationFence } from './fence.js';
import type { ProjectActor } from './project-actor.js';
import {
  createProjectAdministration,
  type ProjectGrantStore,
  type ProjectAdministrationDeps,
} from './project-administration.js';

const ctx = orgContext('org-a');
const NOW = '2026-10-16T08:00:00.000Z';
const PROJECT_A = '01J00000000000000000000000';
const PROJECT_B = '01J00000000000000000000009';
const GRANT_ID = '01J00000000000000000000001';
const ROLE_ID = '01J00000000000000000000002';
const NEW_ID = '01J00000000000000000000003';
const ANCHORS = [{ provider: 'okta', anchor: 'sub', emailAuthoritative: true }];

function projectActor(overrides: Partial<ProjectActor> = {}): ProjectActor {
  return {
    kind: 'project',
    userId: 'actor-1',
    orgId: 'org-a' as ProjectActor['orgId'],
    projectId: PROJECT_A,
    permissions: new Set(['project:grants:write']),
    ...overrides,
  };
}

function fenceOf(expected: Record<string, number> = {}, userId = 'actor-1'): MutationFence {
  return mutationFence(
    { userId, sessionId: 'session-1' } as unknown as AuthenticatedActor,
    expected,
  );
}

const grantFence = (): MutationFence =>
  fenceOf({ [`access_grant:${GRANT_ID}`]: 3, [`role:${ROLE_ID}`]: 2 });

type Answers = { [K in keyof ProjectGrantStore]?: Awaited<ReturnType<ProjectGrantStore[K]>> };

function setup(answers: Answers = {}, extra: Partial<ProjectAdministrationDeps> = {}) {
  const store = {
    create: vi.fn<ProjectGrantStore['create']>(async () => answers.create ?? 'created'),
    changeRole: vi.fn<ProjectGrantStore['changeRole']>(async () => answers.changeRole ?? 'updated'),
    delete: vi.fn<ProjectGrantStore['delete']>(
      async () => answers.delete ?? { status: 'deleted', offboardedUserId: null },
    ),
  } satisfies ProjectGrantStore;
  const log = vi.fn();
  const service = createProjectAdministration({
    grants: store,
    providers: new Map([['okta', {}]]),
    providerAnchors: ANCHORS,
    clock: fixedClock(NOW),
    ids: { ulid: () => NEW_ID },
    log,
    ...extra,
  });
  return { service, store, log };
}

const email = { type: 'email', value: 'dev@example.test' } as const;

describe('grant', () => {
  it('hands the store the exact project, a server id, the clock time and the anchors', async () => {
    const { service, store } = setup();
    const fence = fenceOf();
    const result = await service.grant(
      ctx,
      projectActor(),
      fence,
      PROJECT_A,
      {
        subject: { type: 'email', value: ' Dev@Example.Test ' },
        roleId: ROLE_ID,
      },
      call,
    );
    expect(result).toEqual({
      ok: true,
      value: { id: NEW_ID, projectId: PROJECT_A, subject: email, roleId: ROLE_ID },
    });
    expect(store.create).toHaveBeenCalledWith(ctx, fence, {
      id: NEW_ID,
      projectId: PROJECT_A,
      subject: email,
      roleId: ROLE_ID,
      now: NOW,
      providerAnchors: ANCHORS,
      audit: expect.any(Object),
    });
  });

  it('refuses an actor whose authority is for another project and never reaches the store', async () => {
    const { service, store } = setup();
    const result = await service.grant(
      ctx,
      projectActor(),
      fenceOf(),
      PROJECT_B,
      {
        subject: email,
        roleId: ROLE_ID,
      },
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('refuses an actor of another organization', async () => {
    const { service, store } = setup();
    const actor = projectActor({ orgId: 'org-b' as ProjectActor['orgId'] });
    const result = await service.grant(
      ctx,
      actor,
      fenceOf(),
      PROJECT_A,
      {
        subject: email,
        roleId: ROLE_ID,
      },
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('refuses an actor without project:grants:write, whatever organization-looking strings it carries', async () => {
    const { service, store } = setup();
    const actor = projectActor({
      permissions: new Set(['project:read', 'org:grants:write', 'org:roles:write']),
    });
    const result = await service.grant(
      ctx,
      actor,
      fenceOf(),
      PROJECT_A,
      {
        subject: email,
        roleId: ROLE_ID,
      },
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('refuses an organization actor passed in place of a project actor', async () => {
    const { service, store } = setup();
    const organization = {
      kind: 'organization',
      userId: 'actor-1',
      permissions: new Set(['project:grants:write', 'org:grants:write']),
      isOrganizationAdmin: true,
    } as unknown as ProjectActor;
    const result = await service.grant(
      ctx,
      organization,
      fenceOf(),
      PROJECT_A,
      {
        subject: email,
        roleId: ROLE_ID,
      },
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('throws for a fence that belongs to another user', async () => {
    const { service, store } = setup();
    await expect(
      service.grant(
        ctx,
        projectActor(),
        fenceOf({}, 'someone-else'),
        PROJECT_A,
        {
          subject: email,
          roleId: ROLE_ID,
        },
        call,
      ),
    ).rejects.toThrow(TypeError);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('maps a store refusal for a role beyond the live set to forbidden and logs a denial', async () => {
    const { service, log } = setup({ create: 'forbidden' });
    const result = await service.grant(
      ctx,
      projectActor(),
      fenceOf(),
      PROJECT_A,
      {
        subject: email,
        roleId: ROLE_ID,
      },
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin.denied', action: 'project.grant.create' }),
    );
  });

  it.each(['duplicate', 'role_scope_mismatch', 'conflict', 'indeterminate'] as const)(
    'passes the store answer %s through',
    async (answer) => {
      const { service } = setup({ create: answer });
      const result = await service.grant(
        ctx,
        projectActor(),
        fenceOf(),
        PROJECT_A,
        {
          subject: email,
          roleId: ROLE_ID,
        },
        call,
      );
      expect(result).toEqual({ ok: false, error: answer });
    },
  );

  it('rejects malformed subjects, unknown providers and bad role ids before the store', async () => {
    const { service, store } = setup();
    const grant = (subject: unknown, roleId: string = ROLE_ID) =>
      service.grant(
        ctx,
        projectActor(),
        fenceOf(),
        PROJECT_A,
        {
          subject: subject as never,
          roleId,
        },
        call,
      );
    expect(await grant({ type: 'email', value: 'not-an-email' })).toEqual({
      ok: false,
      error: 'invalid_subject',
    });
    expect(await grant(null)).toEqual({ ok: false, error: 'invalid_subject' });
    expect(await grant({ type: 'group', provider: 'okta', value: ' padded ' })).toEqual({
      ok: false,
      error: 'invalid_subject',
    });
    expect(await grant({ type: 'group', provider: 'github', value: 'team' })).toEqual({
      ok: false,
      error: 'unknown_provider',
    });
    expect(await grant(email, '')).toEqual({ ok: false, error: 'role_scope_mismatch' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('accepts a group subject of a configured provider', async () => {
    const { service, store } = setup();
    const subject = { type: 'group', provider: 'okta', value: 'platform' } as const;
    const result = await service.grant(
      ctx,
      projectActor(),
      fenceOf(),
      PROJECT_A,
      {
        subject,
        roleId: ROLE_ID,
      },
      call,
    );
    expect(result.ok).toBe(true);
    expect(store.create).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.objectContaining({ subject }),
    );
  });

  it('does not log the subject value', async () => {
    const { service, log } = setup();
    await service.grant(
      ctx,
      projectActor(),
      fenceOf(),
      PROJECT_A,
      {
        subject: email,
        roleId: ROLE_ID,
      },
      call,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('example.test');
  });
});

describe('changeRole', () => {
  it('hands the store the project, grant, new role and clock time under the fence', async () => {
    const { service, store } = setup();
    const fence = grantFence();
    const result = await service.changeRole(
      ctx,
      projectActor(),
      fence,
      PROJECT_A,
      GRANT_ID,
      ROLE_ID,
      call,
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(store.changeRole).toHaveBeenCalledWith(ctx, fence, {
      id: GRANT_ID,
      projectId: PROJECT_A,
      roleId: ROLE_ID,
      now: NOW,
      providerAnchors: ANCHORS,
      audit: expect.any(Object),
    });
  });

  it('refuses another project before the store', async () => {
    const { service, store } = setup();
    const result = await service.changeRole(
      ctx,
      projectActor(),
      grantFence(),
      PROJECT_B,
      GRANT_ID,
      ROLE_ID,
      call,
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(store.changeRole).not.toHaveBeenCalled();
  });

  it('requires both the grant and the role revision in the fence', async () => {
    const { service, store } = setup();
    for (const expected of [{}, { [`access_grant:${GRANT_ID}`]: 3 }, { [`role:${ROLE_ID}`]: 2 }]) {
      const result = await service.changeRole(
        ctx,
        projectActor(),
        fenceOf(expected),
        PROJECT_A,
        GRANT_ID,
        ROLE_ID,
        call,
      );
      expect(result).toEqual({ ok: false, error: 'invalid_revision' });
    }
    expect(store.changeRole).not.toHaveBeenCalled();
  });

  it('answers not_found for a malformed grant id and role_scope_mismatch for a malformed role id', async () => {
    const { service, store } = setup();
    expect(
      await service.changeRole(ctx, projectActor(), grantFence(), PROJECT_A, '', ROLE_ID, call),
    ).toEqual({ ok: false, error: 'not_found' });
    expect(
      await service.changeRole(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, '', call),
    ).toEqual({ ok: false, error: 'role_scope_mismatch' });
    expect(store.changeRole).not.toHaveBeenCalled();
  });

  it.each([
    ['forbidden', 'forbidden'],
    ['role_scope_mismatch', 'role_scope_mismatch'],
    ['not_found', 'not_found'],
    ['conflict', 'conflict'],
    ['indeterminate', 'indeterminate'],
  ] as const)('maps the store answer %s', async (answer, error) => {
    const { service } = setup({ changeRole: answer });
    const result = await service.changeRole(
      ctx,
      projectActor(),
      grantFence(),
      PROJECT_A,
      GRANT_ID,
      ROLE_ID,
      call,
    );
    expect(result).toEqual({ ok: false, error });
  });
});

describe('revoke', () => {
  it('notifies once when the deleted grant ends project membership', async () => {
    const callback = vi.fn();
    const { service } = setup(
      { delete: { status: 'deleted', offboardedUserId: 'member-1' } },
      { onCreatorOffboarded: callback },
    );
    expect(
      await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith(ctx, {
      userId: 'member-1',
      cause: 'membership_removed',
    });
  });

  it('does not notify when the store reports no offboarded user', async () => {
    const callback = vi.fn();
    const { service } = setup(
      { delete: { status: 'deleted', offboardedUserId: null } },
      { onCreatorOffboarded: callback },
    );
    expect(
      await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(['forbidden', 'not_found', 'conflict', 'indeterminate'] as const)(
    'does not notify after a %s refusal',
    async (answer) => {
      const callback = vi.fn();
      const { service } = setup({ delete: answer }, { onCreatorOffboarded: callback });
      expect(
        await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call),
      ).toEqual({
        ok: false,
        error: answer,
      });
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it('allows a missing callback after offboarding', async () => {
    const { service } = setup({ delete: { status: 'deleted', offboardedUserId: 'member-1' } });
    expect(
      await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call),
    ).toEqual({
      ok: true,
      value: null,
    });
  });

  it('logs a throwing callback by name and preserves success', async () => {
    const { service, log } = setup(
      { delete: { status: 'deleted', offboardedUserId: 'member-1' } },
      {
        onCreatorOffboarded: () => {
          throw new TypeError('private detail');
        },
      },
    );
    expect(
      await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(log).toHaveBeenCalledWith({
      level: 'warn',
      event: 'user.offboarding_callback_failed',
      orgId: ctx.orgId,
      userId: 'member-1',
      cause: 'membership_removed',
      error: 'TypeError',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private detail');
  });

  it('preserves success when the callback and logger both throw', async () => {
    const { service } = setup(
      { delete: { status: 'deleted', offboardedUserId: 'member-1' } },
      {
        onCreatorOffboarded: async () => {
          throw new Error('private detail');
        },
        log: () => {
          throw new Error('sink unavailable');
        },
      },
    );
    expect(
      await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call),
    ).toEqual({
      ok: true,
      value: null,
    });
  });

  it('reports a deleted grant with an offboarded user once to the user trigger', async () => {
    const onUserOffboarded = vi.fn();
    const { service } = setup(
      { delete: { status: 'deleted', offboardedUserId: 'member-1' } },
      { onUserOffboarded },
    );
    expect(
      await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call),
    ).toEqual({ ok: true, value: null });
    expect(onUserOffboarded).toHaveBeenCalledExactlyOnceWith(ctx, {
      userId: 'member-1',
      cause: 'membership_removed',
      at: NOW,
    });
  });

  it('does not report a deleted grant without an offboarded user to the user trigger', async () => {
    const onUserOffboarded = vi.fn();
    const { service } = setup(
      { delete: { status: 'deleted', offboardedUserId: null } },
      { onUserOffboarded },
    );
    expect(
      (await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call)).ok,
    ).toBe(true);
    expect(onUserOffboarded).not.toHaveBeenCalled();
  });

  it('does not report a refused revoke to the user trigger', async () => {
    const onUserOffboarded = vi.fn();
    const { service } = setup({ delete: 'conflict' }, { onUserOffboarded });
    expect(
      (await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call)).ok,
    ).toBe(false);
    expect(onUserOffboarded).not.toHaveBeenCalled();
  });

  it('logs a throwing user trigger by name, keeps success and still ran the creator callback', async () => {
    const onCreatorOffboarded = vi.fn();
    const { service, log } = setup(
      { delete: { status: 'deleted', offboardedUserId: 'member-1' } },
      {
        onCreatorOffboarded,
        onUserOffboarded: async () => {
          throw new TypeError('private detail');
        },
      },
    );
    expect(
      await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call),
    ).toEqual({ ok: true, value: null });
    expect(onCreatorOffboarded).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith({
      level: 'warn',
      event: 'user.pat_offboarding_enqueue_failed',
      orgId: ctx.orgId,
      userId: 'member-1',
      cause: 'membership_removed',
      error: 'TypeError',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private detail');
  });

  it('runs the creator callback before the user trigger', async () => {
    const order: string[] = [];
    const { service } = setup(
      { delete: { status: 'deleted', offboardedUserId: 'member-1' } },
      {
        onCreatorOffboarded: () => {
          order.push('creator');
        },
        onUserOffboarded: () => {
          order.push('user');
        },
      },
    );
    await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call);
    expect(order).toEqual(['creator', 'user']);
  });

  it('still runs the user trigger when the creator callback throws', async () => {
    const onUserOffboarded = vi.fn();
    const { service } = setup(
      { delete: { status: 'deleted', offboardedUserId: 'member-1' } },
      {
        onCreatorOffboarded: () => {
          throw new Error('creator failure');
        },
        onUserOffboarded,
      },
    );
    expect(
      (await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call)).ok,
    ).toBe(true);
    expect(onUserOffboarded).toHaveBeenCalledOnce();
  });

  it('deletes under the fence with only write authority, never reading a role', async () => {
    const { service, store } = setup();
    const fence = fenceOf({ [`access_grant:${GRANT_ID}`]: 3 });
    const result = await service.revoke(ctx, projectActor(), fence, PROJECT_A, GRANT_ID, call);
    expect(result).toEqual({ ok: true, value: null });
    expect(store.delete).toHaveBeenCalledWith(ctx, fence, {
      id: GRANT_ID,
      projectId: PROJECT_A,
      providerAnchors: ANCHORS,
      audit: expect.any(Object),
    });
  });

  it('lets an actor with no other permission than project:grants:write revoke', async () => {
    const { service } = setup();
    const result = await service.revoke(
      ctx,
      projectActor({ permissions: new Set(['project:grants:write']) }),
      fenceOf({ [`access_grant:${GRANT_ID}`]: 1 }),
      PROJECT_A,
      GRANT_ID,
      call,
    );
    expect(result.ok).toBe(true);
  });

  it('succeeds when the last Project Owner grant is the one removed', async () => {
    const { service, store } = setup({ delete: { status: 'deleted', offboardedUserId: null } });
    const result = await service.revoke(
      ctx,
      projectActor(),
      fenceOf({ [`access_grant:${GRANT_ID}`]: 1 }),
      PROJECT_A,
      GRANT_ID,
      call,
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it('applies no archived-state pre-check; the store decides', async () => {
    const { service, store } = setup({ delete: { status: 'deleted', offboardedUserId: null } });
    const result = await service.revoke(
      ctx,
      projectActor(),
      fenceOf({ [`access_grant:${GRANT_ID}`]: 1 }),
      PROJECT_A,
      GRANT_ID,
      call,
    );
    expect(result.ok).toBe(true);
    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it('refuses another project, a missing revision and a malformed id before the store', async () => {
    const { service, store } = setup();
    const fence = fenceOf({ [`access_grant:${GRANT_ID}`]: 1 });
    expect(await service.revoke(ctx, projectActor(), fence, PROJECT_B, GRANT_ID, call)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await service.revoke(ctx, projectActor(), fenceOf(), PROJECT_A, GRANT_ID, call)).toEqual(
      {
        ok: false,
        error: 'invalid_revision',
      },
    );
    expect(await service.revoke(ctx, projectActor(), fence, PROJECT_A, '', call)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(store.delete).not.toHaveBeenCalled();
  });

  it.each(['forbidden', 'not_found', 'conflict', 'indeterminate'] as const)(
    'maps the store answer %s',
    async (answer) => {
      const { service } = setup({ delete: answer });
      const result = await service.revoke(
        ctx,
        projectActor(),
        fenceOf({ [`access_grant:${GRANT_ID}`]: 1 }),
        PROJECT_A,
        GRANT_ID,
        call,
      );
      expect(result).toEqual({ ok: false, error: answer });
    },
  );
});

describe('surface', () => {
  it('offers no role-definition or organization-grant operation to a project actor', () => {
    const { service } = setup();
    expect(Object.keys(service).sort()).toEqual(['changeRole', 'grant', 'revoke']);
  });

  it('keeps ActorContext and ProjectActor mutually unassignable', () => {
    const organization = {} as ActorContext;
    const project = {} as ProjectActor;
    // @ts-expect-error an organization actor is not a project actor
    const asProject: ProjectActor = organization;
    // @ts-expect-error a project actor is not an organization actor
    const asOrganization: ActorContext = project;
    expect([asProject, asOrganization]).toHaveLength(2);
  });

  it('names the project in a denial event', async () => {
    const { service, log } = setup();
    await service.revoke(
      ctx,
      projectActor(),
      fenceOf({ [`access_grant:${GRANT_ID}`]: 1 }),
      PROJECT_B,
      GRANT_ID,
      call,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin.denied', projectId: PROJECT_B }),
    );
  });

  it('keeps logging when the sink throws', async () => {
    const { service, log } = setup();
    log.mockImplementation(() => {
      throw new Error('sink down');
    });
    const result = await service.grant(
      ctx,
      projectActor(),
      fenceOf(),
      PROJECT_A,
      {
        subject: email,
        roleId: ROLE_ID,
      },
      call,
    );
    expect(result.ok).toBe(true);
  });
});

describe('project grant mutation audit', () => {
  it.each(['create', 'changeRole', 'delete'] as const)(
    'stages one %s event and forwards idempotency',
    async (method) => {
      const { service, store } = setup();
      const record = {
        principalKey: 'user:actor-1',
        key: 'key-1',
        route: '/grants',
        requestHash: 'hash',
        status: 200,
        responseJson: '{}',
        createdAt: NOW,
        expiresAt: NOW,
      };
      const apiCall = { ...call, idempotency: record };
      if (method === 'create')
        await service.grant(
          ctx,
          projectActor(),
          grantFence(),
          PROJECT_A,
          { subject: email, roleId: ROLE_ID },
          apiCall,
        );
      if (method === 'changeRole')
        await service.changeRole(
          ctx,
          projectActor(),
          grantFence(),
          PROJECT_A,
          GRANT_ID,
          ROLE_ID,
          apiCall,
        );
      if (method === 'delete')
        await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, apiCall);
      expect(store[method]).toHaveBeenCalledTimes(1);
      const staged = store[method].mock.calls[0]?.[2] as { audit: { payloadJson: string } };
      expect(staged).toMatchObject({
        audit: {
          id: NEW_ID,
          occurredAt: NOW,
          action: `project_grant.${{ create: 'create', changeRole: 'role_change', delete: 'revoke' }[method]}`,
          actor: { type: 'user', id: 'actor-1' },
          target: { type: 'project_grant', id: method === 'create' ? NEW_ID : GRANT_ID },
          projectId: PROJECT_A,
        },
        idempotency: record,
      });
      expect(JSON.parse(staged.audit.payloadJson).changes).toEqual(
        method === 'create'
          ? { subject_kind: { new: 'email' }, role_id: { new: ROLE_ID } }
          : method === 'changeRole'
            ? { role_id: { new: ROLE_ID } }
            : {},
      );
    },
  );

  it.each([email, { type: 'group', provider: 'okta', value: 'private-team' } as const])(
    'omits the $type subject value from the payload',
    async (subject) => {
      const { service, store } = setup();
      await service.grant(
        ctx,
        projectActor(),
        fenceOf(),
        PROJECT_A,
        { subject, roleId: ROLE_ID },
        call,
      );
      const staged = store.create.mock.calls[0]?.[2] as { audit: { payloadJson: string } };
      expect(staged.audit.payloadJson).not.toContain(subject.value);
      expect(JSON.parse(staged.audit.payloadJson).changes).toEqual({
        subject_kind: { new: subject.type },
        role_id: { new: ROLE_ID },
      });
    },
  );

  it.each(['forbidden', 'conflict', 'not_found', 'indeterminate'] as const)(
    'stages only the failed input for %s',
    async (answer) => {
      const { service, store, log } = setup({ delete: answer });
      expect(
        await service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, call),
      ).toEqual({ ok: false, error: answer });
      expect(store.delete).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.some(([entry]) => entry.event === 'project.grant.changed')).toBe(false);
    },
  );

  it('requires a call argument for every grant mutator', () => {
    const { service } = setup();
    const checkCallTypes = () => {
      // @ts-expect-error call is required
      void service.grant(ctx, projectActor(), fenceOf(), PROJECT_A, {
        subject: email,
        roleId: ROLE_ID,
      });
      // @ts-expect-error call is required
      void service.changeRole(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, ROLE_ID);
      // @ts-expect-error call is required
      void service.revoke(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID);
    };
    expect(checkCallTypes).toBeTypeOf('function');
    expect(service).toBeDefined();
  });
});
