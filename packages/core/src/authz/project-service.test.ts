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
import type { ProjectActor } from './project-actor.js';
import { mutationFence, type AuthenticatedActor, type MutationFence } from './fence.js';
import {
  createProjectService,
  projectOperationAllowed,
  type ProjectStore,
} from './project-service.js';

const ctx = orgContext('org-a');
const NOW = '2026-10-15T08:00:00.000Z';
const ID = '01J00000000000000000000000';
const ROLE_ID = '01J00000000000000000000001';

const projectActor: ProjectActor = {
  kind: 'project',
  userId: 'actor-1',
  orgId: 'org-a' as ProjectActor['orgId'],
  projectId: ID,
  permissions: new Set(['project:settings:write']),
};

const actor: ActorContext = {
  kind: 'organization',
  userId: 'actor-1',
  permissions: new Set(['org:projects:create', 'org:projects:archive']),
  isOrganizationAdmin: false,
};

function fenceOf(userId = 'actor-1', expected: Record<string, number> = {}): MutationFence {
  return mutationFence(
    { userId, sessionId: 'session-1' } as unknown as AuthenticatedActor,
    expected,
  );
}

type Answers = { [K in keyof ProjectStore]?: Awaited<ReturnType<ProjectStore[K]>> };

function setup(answers: Answers = {}) {
  const store = {
    create: vi.fn<ProjectStore['create']>(async () => answers.create ?? 'created'),
    update: vi.fn<ProjectStore['update']>(async () => answers.update ?? 'updated'),
    archive: vi.fn<ProjectStore['archive']>(async () => answers.archive ?? 'archived'),
    restore: vi.fn<ProjectStore['restore']>(async () => answers.restore ?? 'restored'),
  } satisfies ProjectStore;
  const log = vi.fn();
  const service = createProjectService({
    projects: store,
    clock: fixedClock(NOW),
    ids: { ulid: () => ID },
    log,
  });
  return { service, store, log };
}

const input = { slug: 'shop', name: 'Shop' };

describe('createProject', () => {
  it('returns invalid_slug for an overlong slug before staging a mutation', async () => {
    const { service, store, log } = setup();
    const result = await service.createProject(
      ctx,
      actor,
      fenceOf(),
      { ...input, slug: 'x'.repeat(201) },
      call,
    );
    expect(result).toEqual({ ok: false, error: 'invalid_slug' });
    expect(store.create).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('returns invalid_name when a create name is rejected by audit redaction', async () => {
    const { service, store, log } = setup();
    const result = await service.createProject(
      ctx,
      actor,
      fenceOf(),
      { ...input, name: ['Contact', ['owner', 'example.test'].join('@')].join(' ') },
      call,
    );
    expect(result).toEqual({ ok: false, error: 'invalid_name' });
    expect(store.create).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('hands one create call with the fence, a server id and the clock time to the store', async () => {
    const { service, store } = setup();
    const fence = fenceOf();
    const result = await service.createProject(
      ctx,
      actor,
      fence,
      {
        ...input,
        tokenMaxScope: 'write',
        requirePublishApproval: true,
      },
      call,
    );
    expect(result).toEqual({ ok: true, value: { id: ID, slug: 'shop' } });
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.create).toHaveBeenCalledWith(ctx, fence, {
      id: ID,
      slug: 'shop',
      name: 'Shop',
      tokenMaxScope: 'write',
      requirePublishApproval: true,
      now: NOW,
      audit: expect.any(Object),
    });
  });

  it('passes a supplied initial role through', async () => {
    const { service, store } = setup();
    await service.createProject(ctx, actor, fenceOf(), { ...input, initialRoleId: ROLE_ID }, call);
    expect(store.create.mock.calls[0]?.[2]).toMatchObject({ initialRoleId: ROLE_ID });
  });

  it('refuses without org:projects:create before touching the store', async () => {
    const { service, store, log } = setup();
    const weak = { ...actor, permissions: new Set(['org:projects:archive']) };
    expect(await service.createProject(ctx, weak, fenceOf(), input, call)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(store.create).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([entry]) => entry.event === 'admin.denied')).toBe(true);
  });

  it('does not treat organization admin as a wildcard', async () => {
    const { service, store } = setup();
    const admin = {
      kind: 'organization' as const,
      userId: 'actor-1',
      permissions: new Set<string>(),
      isOrganizationAdmin: true,
    };
    expect(await service.createProject(ctx, admin, fenceOf(), input, call)).toMatchObject({
      error: 'forbidden',
    });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('refuses a fence that belongs to another user', async () => {
    const { service, store } = setup();
    await expect(
      service.createProject(ctx, actor, fenceOf('someone-else'), input, call),
    ).rejects.toThrow(TypeError);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('maps a store refusal to a stable error and leaves no success event', async () => {
    for (const [answer, error] of [
      ['authority', 'forbidden'],
      ['duplicate', 'duplicate'],
      ['invalid_slug', 'invalid_slug'],
      ['reserved_slug', 'reserved_slug'],
      ['initial_role_not_allowed', 'initial_role_not_allowed'],
      ['indeterminate', 'indeterminate'],
    ] as const) {
      const { service, log } = setup({ create: answer });
      expect(await service.createProject(ctx, actor, fenceOf(), input, call)).toEqual({
        ok: false,
        error,
      });
      expect(log.mock.calls.some(([entry]) => entry.event === 'project.changed')).toBe(false);
    }
  });

  it('rejects invalid names and scopes without calling the store', async () => {
    const { service, store } = setup();
    for (const name of ['', 'x'.repeat(101), 'bad\u0000name', 'bad‮name']) {
      expect(await service.createProject(ctx, actor, fenceOf(), { ...input, name }, call)).toEqual({
        ok: false,
        error: 'invalid_name',
      });
    }
    expect(
      await service.createProject(
        ctx,
        actor,
        fenceOf(),
        {
          ...input,
          tokenMaxScope: 'root' as never,
        },
        call,
      ),
    ).toEqual({ ok: false, error: 'invalid_scope' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('logs ids only, never the project name', async () => {
    const { service, log } = setup();
    await service.createProject(ctx, actor, fenceOf(), input, call);
    const entry = log.mock.calls.map(([e]) => e).find((e) => e.event === 'project.changed');
    expect(entry).toMatchObject({
      action: 'create',
      orgId: 'org-a',
      projectId: ID,
      actorUserId: 'actor-1',
    });
    expect(JSON.stringify(entry)).not.toContain('Shop');
  });

  it('does not report a failed log sink as a failed create', async () => {
    const { service, log } = setup();
    log.mockImplementation(() => {
      throw new Error('sink down');
    });
    expect(await service.createProject(ctx, actor, fenceOf(), input, call)).toMatchObject({
      ok: true,
    });
  });
});

describe('updateSettings', () => {
  it('returns invalid_name when an updated name is rejected by audit redaction', async () => {
    const { service, store, log } = setup();
    const result = await service.updateSettings(
      ctx,
      projectActor,
      fenceOf('actor-1', { project: 1 }),
      ID,
      { name: ['Contact', ['owner', 'example.test'].join('@')].join(' ') },
      call,
    );
    expect(result).toEqual({ ok: false, error: 'invalid_name' });
    expect(store.update).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('requires an expected project revision in the fence', async () => {
    const { service, store } = setup();
    expect(
      await service.updateSettings(ctx, projectActor, fenceOf(), ID, { name: 'New' }, call),
    ).toEqual({
      ok: false,
      error: 'invalid_revision',
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  it('passes changes, fence and time to the store', async () => {
    const { service, store } = setup();
    const fence = fenceOf('actor-1', { project: 3 });
    expect(
      await service.updateSettings(ctx, projectActor, fence, ID, { name: 'New' }, call),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(store.update).toHaveBeenCalledWith(ctx, fence, {
      id: ID,
      changes: { name: 'New' },
      now: NOW,
      audit: expect.any(Object),
    });
  });

  it('maps store answers', async () => {
    for (const [answer, error] of [
      ['archived', 'archived'],
      ['not_found', 'not_found'],
      ['conflict', 'conflict'],
      ['authority', 'forbidden'],
      ['indeterminate', 'indeterminate'],
    ] as const) {
      const { service, log } = setup({ update: answer });
      expect(
        await service.updateSettings(
          ctx,
          projectActor,
          fenceOf('actor-1', { project: 1 }),
          ID,
          {
            requirePublishApproval: true,
          },
          call,
        ),
      ).toEqual({ ok: false, error });
      expect(log.mock.calls.some(([entry]) => entry.event === 'project.changed')).toBe(false);
    }
  });

  it('treats an unchanged answer as success without a change event', async () => {
    const { service, log } = setup({ update: 'unchanged' });
    expect(
      await service.updateSettings(
        ctx,
        projectActor,
        fenceOf('actor-1', { project: 1 }),
        ID,
        {
          name: 'Same',
        },
        call,
      ),
    ).toEqual({ ok: true, value: null });
    expect(log.mock.calls.some(([entry]) => entry.event === 'project.changed')).toBe(false);
  });

  it('rejects an empty change set, an invalid name and an invalid scope', async () => {
    const { service, store } = setup();
    const fence = fenceOf('actor-1', { project: 1 });
    expect(await service.updateSettings(ctx, projectActor, fence, ID, {}, call)).toEqual({
      ok: false,
      error: 'no_changes',
    });
    expect(await service.updateSettings(ctx, projectActor, fence, ID, { name: '' }, call)).toEqual({
      ok: false,
      error: 'invalid_name',
    });
    expect(
      await service.updateSettings(
        ctx,
        projectActor,
        fence,
        ID,
        {
          tokenMaxScope: 'root' as never,
        },
        call,
      ),
    ).toEqual({ ok: false, error: 'invalid_scope' });
    expect(store.update).not.toHaveBeenCalled();
  });
});

describe('project actor and id validation', () => {
  const fence = () => fenceOf('actor-1', { project: 1 });

  it('updateSettings refuses an actor of another organization', async () => {
    const { service, store } = setup();
    const foreign = { ...projectActor, orgId: 'org-b' as ProjectActor['orgId'] };
    expect(await service.updateSettings(ctx, foreign, fence(), ID, { name: 'New' }, call)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  it('org-scope paths refuse a project-kind actor', async () => {
    const { service, store } = setup();
    const sneaky = {
      ...actor,
      kind: 'project',
      permissions: new Set(['org:projects:create', 'org:projects:archive']),
    } as unknown as ActorContext;
    expect(await service.createProject(ctx, sneaky, fenceOf(), input, call)).toMatchObject({
      error: 'forbidden',
    });
    expect(await service.archiveProject(ctx, sneaky, fence(), ID, call)).toMatchObject({
      error: 'forbidden',
    });
    expect(await service.restoreProject(ctx, sneaky, fence(), ID, call)).toMatchObject({
      error: 'forbidden',
    });
    expect(store.create).not.toHaveBeenCalled();
    expect(store.archive).not.toHaveBeenCalled();
    expect(store.restore).not.toHaveBeenCalled();
  });

  it('updateSettings refuses an actor of another project or without the permission', async () => {
    const { service, store, log } = setup();
    const other = { ...projectActor, projectId: '01J00000000000000000000009' };
    const weak = { ...projectActor, permissions: new Set<string>() };
    for (const who of [other, weak]) {
      expect(await service.updateSettings(ctx, who, fence(), ID, { name: 'New' }, call)).toEqual({
        ok: false,
        error: 'forbidden',
      });
    }
    expect(store.update).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([entry]) => entry.event === 'admin.denied')).toHaveLength(2);
  });

  it('updateSettings refuses a non-project actor shape', async () => {
    const { service, store } = setup();
    expect(
      await service.updateSettings(ctx, actor as never, fence(), ID, { name: 'New' }, call),
    ).toMatchObject({ error: 'forbidden' });
    expect(
      await service.updateSettings(ctx, null as never, fence(), ID, { name: 'N' }, call),
    ).toMatchObject({
      error: 'forbidden',
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  it('a malformed project id is not_found without a store call', async () => {
    const { service, store } = setup();
    expect(
      await service.updateSettings(
        ctx,
        { ...projectActor, projectId: 'x' },
        fence(),
        'x',
        {
          name: 'N',
        },
        call,
      ),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await service.archiveProject(ctx, actor, fence(), 'x', call)).toMatchObject({
      error: 'not_found',
    });
    expect(await service.restoreProject(ctx, actor, fence(), 'x', call)).toMatchObject({
      error: 'not_found',
    });
    expect(store.update).not.toHaveBeenCalled();
    expect(store.archive).not.toHaveBeenCalled();
    expect(store.restore).not.toHaveBeenCalled();
  });

  it('a malformed initial role id is initial_role_not_allowed', async () => {
    const { service, store } = setup();
    expect(
      await service.createProject(
        ctx,
        actor,
        fenceOf(),
        { ...input, initialRoleId: 'role-1' },
        call,
      ),
    ).toEqual({ ok: false, error: 'initial_role_not_allowed' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('requirePublishApproval must be a boolean', async () => {
    const { service, store } = setup();
    expect(
      await service.createProject(
        ctx,
        actor,
        fenceOf(),
        {
          ...input,
          requirePublishApproval: 'yes' as never,
        },
        call,
      ),
    ).toEqual({ ok: false, error: 'invalid_policy' });
    expect(
      await service.updateSettings(
        ctx,
        projectActor,
        fence(),
        ID,
        {
          requirePublishApproval: 1 as never,
        },
        call,
      ),
    ).toEqual({ ok: false, error: 'invalid_policy' });
    expect(store.create).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it('a malformed actor is forbidden for create', async () => {
    const { service, store } = setup();
    expect(await service.createProject(ctx, null as never, fenceOf(), input, call)).toMatchObject({
      error: 'forbidden',
    });
    expect(store.create).not.toHaveBeenCalled();
  });
});

describe('archiveProject and restoreProject', () => {
  it('archive requires org:projects:archive and a project revision (invalid_revision)', async () => {
    const { service, store } = setup();
    const weak = { ...actor, permissions: new Set(['org:projects:create']) };
    expect(
      await service.archiveProject(ctx, weak, fenceOf('actor-1', { project: 1 }), ID, call),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await service.archiveProject(ctx, actor, fenceOf(), ID, call)).toEqual({
      ok: false,
      error: 'invalid_revision',
    });
    expect(store.archive).not.toHaveBeenCalled();
  });

  it('archive and restore hand the fence and time to the store', async () => {
    const { service, store, log } = setup();
    const fence = fenceOf('actor-1', { project: 2 });
    expect(await service.archiveProject(ctx, actor, fence, ID, call)).toEqual({
      ok: true,
      value: null,
    });
    expect(await service.restoreProject(ctx, actor, fence, ID, call)).toEqual({
      ok: true,
      value: null,
    });
    expect(store.archive).toHaveBeenCalledWith(ctx, fence, {
      id: ID,
      now: NOW,
      audit: expect.any(Object),
    });
    expect(store.restore).toHaveBeenCalledWith(ctx, fence, {
      id: ID,
      now: NOW,
      audit: expect.any(Object),
    });
    const actions = log.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.event === 'project.changed')
      .map((entry) => entry.action);
    expect(actions).toEqual(['archive', 'restore']);
  });

  it('restore also requires org:projects:archive', async () => {
    const { service, store } = setup();
    const weak = { ...actor, permissions: new Set<string>() };
    expect(
      await service.restoreProject(ctx, weak, fenceOf('actor-1', { project: 2 }), ID, call),
    ).toMatchObject({ error: 'forbidden' });
    expect(store.restore).not.toHaveBeenCalled();
  });

  it('reports a stale reauth or lost authority as forbidden, a stale revision as conflict', async () => {
    for (const [answer, error] of [
      ['authority', 'forbidden'],
      ['conflict', 'conflict'],
      ['not_archived', 'wrong_state'],
      ['not_found', 'not_found'],
      ['indeterminate', 'indeterminate'],
    ] as const) {
      const { service } = setup({ restore: answer });
      expect(
        await service.restoreProject(ctx, actor, fenceOf('actor-1', { project: 1 }), ID, call),
      ).toEqual({ ok: false, error });
    }
    for (const [answer, error] of [
      ['not_active', 'wrong_state'],
      ['conflict', 'conflict'],
    ] as const) {
      const { service } = setup({ archive: answer });
      expect(
        await service.archiveProject(ctx, actor, fenceOf('actor-1', { project: 1 }), ID, call),
      ).toEqual({ ok: false, error });
    }
  });
});

describe('projectOperationAllowed', () => {
  it('allows everything on an active project', () => {
    for (const op of [
      'registry',
      'token_issue',
      'inspect',
      'narrow_write',
      'widening_write',
    ] as const) {
      expect(projectOperationAllowed('active', op)).toBe(true);
    }
  });

  it('denies registry and token issuance on an archived project', () => {
    expect(projectOperationAllowed('archived', 'registry')).toBe(false);
    expect(projectOperationAllowed('archived', 'token_issue')).toBe(false);
    expect(projectOperationAllowed('archived', 'widening_write')).toBe(false);
  });

  it('keeps an archived project inspectable and prunable', () => {
    expect(projectOperationAllowed('archived', 'inspect')).toBe(true);
    expect(projectOperationAllowed('archived', 'narrow_write')).toBe(true);
  });

  it('denies unknown operations and statuses', () => {
    expect(projectOperationAllowed('archived', 'publish' as never)).toBe(false);
    expect(projectOperationAllowed('deleted' as never, 'inspect')).toBe(false);
  });
});

describe('project mutation audit', () => {
  it.each(['create', 'update', 'archive', 'restore'] as const)(
    'stages one %s event with idempotency',
    async (method) => {
      const { service, store } = setup();
      const record = {
        principalKey: 'user:actor-1',
        key: 'key-1',
        route: '/projects',
        requestHash: 'hash',
        status: 200,
        responseJson: '{}',
        createdAt: NOW,
        expiresAt: NOW,
      };
      const apiCall = { ...call, idempotency: record };
      const fence = fenceOf('actor-1', { project: 1 });
      if (method === 'create') await service.createProject(ctx, actor, fence, input, apiCall);
      if (method === 'update')
        await service.updateSettings(ctx, projectActor, fence, ID, { name: 'New' }, apiCall);
      if (method === 'archive') await service.archiveProject(ctx, actor, fence, ID, apiCall);
      if (method === 'restore') await service.restoreProject(ctx, actor, fence, ID, apiCall);
      expect(store[method]).toHaveBeenCalledTimes(1);
      const staged = store[method].mock.calls[0]?.[2];
      expect(staged).toMatchObject({
        audit: {
          id: ID,
          occurredAt: NOW,
          action: `project.${method}`,
          actor: { type: 'user', id: actor.userId },
          target: { type: 'project', id: ID },
          projectId: ID,
        },
        idempotency:
          method === 'create'
            ? { ...record, responseJson: '{"id":"' + ID + '","slug":"shop"}' }
            : record,
      });
      const payload = JSON.parse((staged as { audit: { payloadJson: string } }).audit.payloadJson);
      expect(payload).toMatchObject({ op_id: call.audit.opId, request_id: call.audit.requestId });
      if (method === 'create')
        expect(payload.changes).toEqual({
          slug: { new: 'shop' },
          name: { new: 'Shop' },
          token_max_scope: { new: 'full' },
          require_publish_approval: { new: false },
        });
      if (method === 'archive' || method === 'restore') expect(payload.changes).toEqual({});
    },
  );

  it('omits fields absent from a name-only update', async () => {
    const { service, store } = setup();
    await service.updateSettings(
      ctx,
      projectActor,
      fenceOf('actor-1', { project: 1 }),
      ID,
      { name: 'New' },
      call,
    );
    const staged = store.update.mock.calls[0]?.[2] as { audit: { payloadJson: string } };
    expect(JSON.parse(staged.audit.payloadJson).changes).toEqual({ name: { new: 'New' } });
  });

  it('stages nothing for no_changes', async () => {
    const { service, store } = setup();
    expect(
      await service.updateSettings(
        ctx,
        projectActor,
        fenceOf('actor-1', { project: 1 }),
        ID,
        {},
        call,
      ),
    ).toEqual({ ok: false, error: 'no_changes' });
    expect(store.update).not.toHaveBeenCalled();
  });

  it.each(['authority', 'conflict', 'not_found', 'indeterminate'] as const)(
    'does not retry a %s store refusal',
    async (answer) => {
      const { service, store, log } = setup({ update: answer });
      expect(
        await service.updateSettings(
          ctx,
          projectActor,
          fenceOf('actor-1', { project: 1 }),
          ID,
          { name: 'New' },
          call,
        ),
      ).toEqual({ ok: false, error: answer === 'authority' ? 'forbidden' : answer });
      expect(store.update).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.some(([entry]) => entry.event === 'project.changed')).toBe(false);
    },
  );

  it('requires a call argument for every project mutator', () => {
    const { service } = setup();
    const checkCallTypes = () => {
      // @ts-expect-error call is required
      void service.createProject(ctx, actor, fenceOf(), input);
      // @ts-expect-error call is required
      void service.updateSettings(ctx, projectActor, fenceOf(), ID, {});
      // @ts-expect-error call is required
      void service.archiveProject(ctx, actor, fenceOf(), ID);
      // @ts-expect-error call is required
      void service.restoreProject(ctx, actor, fenceOf(), ID);
    };
    expect(checkCallTypes).toBeTypeOf('function');
    expect(service).toBeDefined();
  });
});

it('a create idempotency conflict is returned without logging a change', async () => {
  const { service, log } = setup({ create: 'conflict' });
  expect(await service.createProject(ctx, actor, fenceOf(), input, call)).toEqual({
    ok: false,
    error: 'conflict',
  });
  expect(log).not.toHaveBeenCalled();
});

describe('restore refused for a stale reauthentication', () => {
  it('answers reauth_required and emits admin.denied with a reason', async () => {
    const { service, log } = setup({ restore: 'reauth_required' });
    const fence = fenceOf('actor-1', { project: 2 });
    expect(await service.restoreProject(ctx, actor, fence, ID, call)).toEqual({
      ok: false,
      error: 'reauth_required',
    });
    const denied = log.mock.calls.map(([entry]) => entry).filter((e) => e.event === 'admin.denied');
    expect(denied).toEqual([
      expect.objectContaining({
        action: 'project.restore',
        reason: 'reauth_required',
        actorUserId: actor.userId,
      }),
    ]);
    expect(log.mock.calls.some(([entry]) => entry.event === 'project.changed')).toBe(false);
  });

  it('keeps a lost-authority refusal reasonless', async () => {
    const { service, log } = setup({ restore: 'authority' });
    await service.restoreProject(ctx, actor, fenceOf('actor-1', { project: 2 }), ID, call);
    const denied = log.mock.calls.map(([entry]) => entry).filter((e) => e.event === 'admin.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).not.toHaveProperty('reason');
  });
});
