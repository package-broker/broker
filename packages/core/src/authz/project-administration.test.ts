import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { ActorContext } from './administration.js';
import { mutationFence, type AuthenticatedActor, type MutationFence } from './fence.js';
import type { ProjectActor } from './project-actor.js';
import { createProjectAdministration, type ProjectGrantStore } from './project-administration.js';

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

function setup(answers: Answers = {}) {
  const store = {
    create: vi.fn<ProjectGrantStore['create']>(async () => answers.create ?? 'created'),
    changeRole: vi.fn<ProjectGrantStore['changeRole']>(async () => answers.changeRole ?? 'updated'),
    delete: vi.fn<ProjectGrantStore['delete']>(async () => answers.delete ?? 'deleted'),
  } satisfies ProjectGrantStore;
  const log = vi.fn();
  const service = createProjectAdministration({
    grants: store,
    providers: new Map([['okta', {}]]),
    providerAnchors: ANCHORS,
    clock: fixedClock(NOW),
    ids: { ulid: () => NEW_ID },
    log,
  });
  return { service, store, log };
}

const email = { type: 'email', value: 'dev@example.test' } as const;

describe('grant', () => {
  it('hands the store the exact project, a server id, the clock time and the anchors', async () => {
    const { service, store } = setup();
    const fence = fenceOf();
    const result = await service.grant(ctx, projectActor(), fence, PROJECT_A, {
      subject: { type: 'email', value: ' Dev@Example.Test ' },
      roleId: ROLE_ID,
    });
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
    });
  });

  it('refuses an actor whose authority is for another project and never reaches the store', async () => {
    const { service, store } = setup();
    const result = await service.grant(ctx, projectActor(), fenceOf(), PROJECT_B, {
      subject: email,
      roleId: ROLE_ID,
    });
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('refuses an actor of another organization', async () => {
    const { service, store } = setup();
    const actor = projectActor({ orgId: 'org-b' as ProjectActor['orgId'] });
    const result = await service.grant(ctx, actor, fenceOf(), PROJECT_A, {
      subject: email,
      roleId: ROLE_ID,
    });
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('refuses an actor without project:grants:write, whatever organization-looking strings it carries', async () => {
    const { service, store } = setup();
    const actor = projectActor({
      permissions: new Set(['project:read', 'org:grants:write', 'org:roles:write']),
    });
    const result = await service.grant(ctx, actor, fenceOf(), PROJECT_A, {
      subject: email,
      roleId: ROLE_ID,
    });
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
    const result = await service.grant(ctx, organization, fenceOf(), PROJECT_A, {
      subject: email,
      roleId: ROLE_ID,
    });
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('throws for a fence that belongs to another user', async () => {
    const { service, store } = setup();
    await expect(
      service.grant(ctx, projectActor(), fenceOf({}, 'someone-else'), PROJECT_A, {
        subject: email,
        roleId: ROLE_ID,
      }),
    ).rejects.toThrow(TypeError);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('maps a store refusal for a role beyond the live set to forbidden and logs a denial', async () => {
    const { service, log } = setup({ create: 'forbidden' });
    const result = await service.grant(ctx, projectActor(), fenceOf(), PROJECT_A, {
      subject: email,
      roleId: ROLE_ID,
    });
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin.denied', action: 'project.grant.create' }),
    );
  });

  it.each(['duplicate', 'role_scope_mismatch', 'conflict', 'indeterminate'] as const)(
    'passes the store answer %s through',
    async (answer) => {
      const { service } = setup({ create: answer });
      const result = await service.grant(ctx, projectActor(), fenceOf(), PROJECT_A, {
        subject: email,
        roleId: ROLE_ID,
      });
      expect(result).toEqual({ ok: false, error: answer });
    },
  );

  it('rejects malformed subjects, unknown providers and bad role ids before the store', async () => {
    const { service, store } = setup();
    const grant = (subject: unknown, roleId: string = ROLE_ID) =>
      service.grant(ctx, projectActor(), fenceOf(), PROJECT_A, {
        subject: subject as never,
        roleId,
      });
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
    const result = await service.grant(ctx, projectActor(), fenceOf(), PROJECT_A, {
      subject,
      roleId: ROLE_ID,
    });
    expect(result.ok).toBe(true);
    expect(store.create).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.objectContaining({ subject }),
    );
  });

  it('does not log the subject value', async () => {
    const { service, log } = setup();
    await service.grant(ctx, projectActor(), fenceOf(), PROJECT_A, {
      subject: email,
      roleId: ROLE_ID,
    });
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
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(store.changeRole).toHaveBeenCalledWith(ctx, fence, {
      id: GRANT_ID,
      projectId: PROJECT_A,
      roleId: ROLE_ID,
      now: NOW,
      providerAnchors: ANCHORS,
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
      );
      expect(result).toEqual({ ok: false, error: 'invalid_revision' });
    }
    expect(store.changeRole).not.toHaveBeenCalled();
  });

  it('answers not_found for a malformed grant id and role_scope_mismatch for a malformed role id', async () => {
    const { service, store } = setup();
    expect(
      await service.changeRole(ctx, projectActor(), grantFence(), PROJECT_A, '', ROLE_ID),
    ).toEqual({ ok: false, error: 'not_found' });
    expect(
      await service.changeRole(ctx, projectActor(), grantFence(), PROJECT_A, GRANT_ID, ''),
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
    );
    expect(result).toEqual({ ok: false, error });
  });
});

describe('revoke', () => {
  it('deletes under the fence with only write authority, never reading a role', async () => {
    const { service, store } = setup();
    const fence = fenceOf({ [`access_grant:${GRANT_ID}`]: 3 });
    const result = await service.revoke(ctx, projectActor(), fence, PROJECT_A, GRANT_ID);
    expect(result).toEqual({ ok: true, value: null });
    expect(store.delete).toHaveBeenCalledWith(ctx, fence, {
      id: GRANT_ID,
      projectId: PROJECT_A,
      providerAnchors: ANCHORS,
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
    );
    expect(result.ok).toBe(true);
  });

  it('succeeds when the last Project Owner grant is the one removed', async () => {
    const { service, store } = setup({ delete: 'deleted' });
    const result = await service.revoke(
      ctx,
      projectActor(),
      fenceOf({ [`access_grant:${GRANT_ID}`]: 1 }),
      PROJECT_A,
      GRANT_ID,
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it('applies no archived-state pre-check; the store decides', async () => {
    const { service, store } = setup({ delete: 'deleted' });
    const result = await service.revoke(
      ctx,
      projectActor(),
      fenceOf({ [`access_grant:${GRANT_ID}`]: 1 }),
      PROJECT_A,
      GRANT_ID,
    );
    expect(result.ok).toBe(true);
    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it('refuses another project, a missing revision and a malformed id before the store', async () => {
    const { service, store } = setup();
    const fence = fenceOf({ [`access_grant:${GRANT_ID}`]: 1 });
    expect(await service.revoke(ctx, projectActor(), fence, PROJECT_B, GRANT_ID)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await service.revoke(ctx, projectActor(), fenceOf(), PROJECT_A, GRANT_ID)).toEqual({
      ok: false,
      error: 'invalid_revision',
    });
    expect(await service.revoke(ctx, projectActor(), fence, PROJECT_A, '')).toEqual({
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
    const result = await service.grant(ctx, projectActor(), fenceOf(), PROJECT_A, {
      subject: email,
      roleId: ROLE_ID,
    });
    expect(result.ok).toBe(true);
  });
});
