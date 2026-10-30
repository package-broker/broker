import { describe, expect, it, vi } from 'vitest';
import type { ApiCall } from '../api/idempotency.js';
import type { AuthenticatedSession } from '../auth/session.js';
import { mutationFence, type AuthenticatedActor } from '../authz/fence.js';
import type { VisibilityStore, VisibilityWriteResult } from '../db/catalogue.js';
import type { ManagedVersion, PackageAdminReader } from '../db/package-admin.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  createPackageManageService,
  type PackageManageInput,
  type PackageManageScope,
} from './package-manage-service.js';
import type { VersionStatus } from './version-rules.js';

const ctx = orgContext('org-a');
const packageId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const versionId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const projectId = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const otherProjectId = '01ARZ3NDEKTSV4RRFFQ69G5FAY';
const auditId = '01ARZ3NDEKTSV4RRFFQ69G5FAZ';
const now = '2026-10-21T10:00:00.000Z';
const authenticated = {
  session: {
    id: 'session',
    userId: 'actor',
    identityId: null,
    csrfHash: 'hash',
    createdAt: now,
    expiresAt: now,
    lastSeenAt: now,
    reauthAt: null,
    user: { id: 'actor', email: '', displayName: null },
  },
  principal: { kind: 'user', id: 'actor' },
} satisfies AuthenticatedSession;
const fence = mutationFence({ userId: 'actor', sessionId: 'session' } as AuthenticatedActor, {});
const apiCall: ApiCall = {
  audit: { opId: packageId, requestId: versionId, sourceIp: '192.0.2.1', tokenSelector: null },
};
const managed: ManagedVersion = {
  packageId,
  versionId,
  ecosystem: 'npm',
  packageName: '@example/pkg',
  version: '1.2.3',
  status: 'active',
  sourceId: auditId,
  sourceProjectId: null,
};
const input: PackageManageInput = {
  packageId,
  versionId,
  action: 'quarantine',
  scope: { kind: 'organization' },
};

function setup(
  row: ManagedVersion | null = managed,
  session: AuthenticatedSession = authenticated,
) {
  const reader = {
    findManagedVersion: vi.fn<PackageAdminReader['findManagedVersion']>().mockResolvedValue(row),
  };
  const answer: VisibilityWriteResult = { ok: true, opId: apiCall.audit.opId };
  const store = {
    quarantineVersion: vi.fn<VisibilityStore['quarantineVersion']>().mockResolvedValue(answer),
    tombstoneVersion: vi.fn<VisibilityStore['tombstoneVersion']>().mockResolvedValue(answer),
    releaseQuarantine: vi.fn<VisibilityStore['releaseQuarantine']>().mockResolvedValue(answer),
  };
  const sessions = { isReauthFresh: vi.fn().mockReturnValue(true) };
  const log = vi.fn();
  const service = createPackageManageService({
    reader,
    store,
    sessions,
    clock: fixedClock(now),
    ids: { ulid: () => auditId },
    log,
  });
  return {
    reader,
    store,
    sessions,
    log,
    call: (request: PackageManageInput = input, call: ApiCall = apiCall) =>
      service.manage(ctx, session, fence, request, call),
  };
}

function noWrites(store: ReturnType<typeof setup>['store']) {
  for (const write of Object.values(store)) expect(write).not.toHaveBeenCalled();
}

function event(
  action: PackageManageInput['action'],
  scope: PackageManageScope['kind'],
  changed = false,
) {
  return {
    event: changed ? 'package.version_state_changed' : 'package.version_state_denied',
    orgId: ctx.orgId,
    versionId,
    action,
    scopeKind: scope,
    actorUserId: fence.userId,
    opId: apiCall.audit.opId,
  };
}

describe('package version management', () => {
  for (const action of ['release', 'quarantine', 'tombstone'] as const) {
    it(`refuses ${action} of a publish-gated version before writing`, async () => {
      const { call, store } = setup(Object.assign({}, managed, { publishGate: true }));
      expect(await call({ ...input, action })).toEqual({ ok: false, error: 'publish_gate' });
      noWrites(store);
    });
  }

  it('tombstones an organization version with a fenced audit and idempotency record', async () => {
    const { call, reader, store, sessions, log } = setup();
    const idempotency = {
      principalKey: 'user:actor',
      key: 'key',
      route: '/test',
      requestHash: 'hash',
      status: 200,
      responseJson: '{}',
      createdAt: now,
      expiresAt: now,
    };
    expect(await call({ ...input, action: 'tombstone' }, { ...apiCall, idempotency })).toEqual({
      ok: true,
      value: { versionId, status: 'tombstoned' },
    });
    expect(sessions.isReauthFresh).toHaveBeenCalledExactlyOnceWith(authenticated);
    expect(reader.findManagedVersion).toHaveBeenCalledExactlyOnceWith(ctx, {
      packageId,
      versionId,
      projectId: null,
    });
    expect(store.tombstoneVersion).toHaveBeenCalledExactlyOnceWith(ctx, fence, {
      packageId,
      versionId,
      expectedStatus: 'active',
      manage: input.scope,
      reason: 'admin_tombstone',
      idempotency,
      audit: {
        id: auditId,
        occurredAt: now,
        action: 'version.state_change',
        actor: { type: 'user', id: fence.userId },
        target: { type: 'version', id: versionId },
        projectId: null,
        sourceIp: apiCall.audit.sourceIp,
        tokenSelector: null,
        payloadJson: expect.any(String),
      },
    });
    expect(store.quarantineVersion).not.toHaveBeenCalled();
    expect(store.releaseQuarantine).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(event('tombstone', 'organization', true));
  });

  it('passes the read status and source project for an own-source project quarantine', async () => {
    const { call, reader, store } = setup({
      ...managed,
      status: 'removed_upstream',
      sourceProjectId: projectId,
    });
    const scope = { kind: 'project', projectId } as const;
    expect(await call({ ...input, scope })).toEqual({
      ok: true,
      value: { versionId, status: 'quarantined' },
    });
    expect(reader.findManagedVersion).toHaveBeenCalledExactlyOnceWith(ctx, {
      packageId,
      versionId,
      projectId,
    });
    expect(store.quarantineVersion).toHaveBeenCalledExactlyOnceWith(
      ctx,
      fence,
      expect.objectContaining({
        packageId,
        versionId,
        expectedStatus: 'removed_upstream',
        manage: scope,
        reason: 'admin_quarantine',
        audit: expect.objectContaining({ projectId }),
      }),
    );
  });

  it.each([
    ['an organization-level package', managed],
    ["another project's package", { ...managed, sourceProjectId: otherProjectId }],
    ['an absent package', null],
  ] as const)(
    'conceals %s from project management with the same result and event',
    async (_label, row) => {
      const { call, reader, store, log } = setup();
      reader.findManagedVersion.mockImplementation(async (_ctx, query) =>
        row !== null && row.sourceProjectId === query.projectId ? row : null,
      );
      expect(await call({ ...input, scope: { kind: 'project', projectId } })).toEqual({
        ok: false,
        error: 'not_found',
      });
      expect(reader.findManagedVersion).toHaveBeenCalledExactlyOnceWith(ctx, {
        packageId,
        versionId,
        projectId,
      });
      noWrites(store);
      expect(log).toHaveBeenCalledExactlyOnceWith(event('quarantine', 'project'));
    },
  );

  it.each<VersionStatus>(['tombstoned', 'yanked', 'active', 'removed_upstream'])(
    'refuses release from %s without writing',
    async (status) => {
      const { call, store } = setup({ ...managed, status });
      expect(await call({ ...input, action: 'release' })).toEqual({ ok: false, error: 'conflict' });
      noWrites(store);
    },
  );

  it.each(['quarantine', 'tombstone'] as const)(
    'refuses %s of a tombstoned version without writing',
    async (action) => {
      const { call, store } = setup({ ...managed, status: 'tombstoned' });
      expect(await call({ ...input, action })).toEqual({ ok: false, error: 'conflict' });
      noWrites(store);
    },
  );

  it('requires fresh reauthentication for tombstone before reading', async () => {
    const { call, reader, store, sessions, log } = setup();
    sessions.isReauthFresh.mockReturnValue(false);
    expect(await call({ ...input, action: 'tombstone' })).toEqual({
      ok: false,
      error: 'reauth_required',
    });
    expect(reader.findManagedVersion).not.toHaveBeenCalled();
    noWrites(store);
    expect(log).toHaveBeenCalledExactlyOnceWith(event('tombstone', 'organization'));
  });

  it.each([
    ['another session of the same user', { id: 'other-session', userId: fence.userId }],
    ['another user with the same session id', { id: fence.sessionId, userId: 'other-actor' }],
  ])('refuses fresh tombstone reauthentication from %s', async (_label, overrides) => {
    const session: AuthenticatedSession = {
      session: {
        ...authenticated.session,
        reauthAt: now,
        ...overrides,
        user: { ...authenticated.session.user, id: overrides.userId },
      },
      principal: { kind: 'user', id: overrides.userId },
    };
    const { call, reader, store, sessions, log } = setup(managed, session);
    expect(await call({ ...input, action: 'tombstone' })).toEqual({
      ok: false,
      error: 'reauth_required',
    });
    expect(sessions.isReauthFresh).not.toHaveBeenCalled();
    expect(reader.findManagedVersion).not.toHaveBeenCalled();
    noWrites(store);
    expect(log).toHaveBeenCalledExactlyOnceWith(event('tombstone', 'organization'));
  });

  it('accepts fresh tombstone reauthentication from the matching session', async () => {
    const session: AuthenticatedSession = {
      ...authenticated,
      session: { ...authenticated.session, reauthAt: now },
    };
    const { call, store, sessions } = setup(managed, session);
    expect(await call({ ...input, action: 'tombstone' })).toEqual({
      ok: true,
      value: { versionId, status: 'tombstoned' },
    });
    expect(sessions.isReauthFresh).toHaveBeenCalledExactlyOnceWith(session);
    expect(store.tombstoneVersion).toHaveBeenCalledTimes(1);
  });

  it('quarantines with stale reauthentication', async () => {
    const { call, store, sessions } = setup();
    sessions.isReauthFresh.mockReturnValue(false);
    expect(await call()).toEqual({ ok: true, value: { versionId, status: 'quarantined' } });
    expect(sessions.isReauthFresh).not.toHaveBeenCalled();
    expect(store.quarantineVersion).toHaveBeenCalledTimes(1);
  });

  it('releases quarantine with stale reauthentication and the read status', async () => {
    const { call, store, sessions } = setup({ ...managed, status: 'quarantined' });
    sessions.isReauthFresh.mockReturnValue(false);
    expect(await call({ ...input, action: 'release' })).toEqual({
      ok: true,
      value: { versionId, status: 'active' },
    });
    expect(sessions.isReauthFresh).not.toHaveBeenCalled();
    expect(store.releaseQuarantine).toHaveBeenCalledExactlyOnceWith(
      ctx,
      fence,
      expect.objectContaining({
        packageId,
        versionId,
        expectedStatus: 'quarantined',
        manage: input.scope,
        audit: expect.any(Object),
      }),
    );
  });

  it.each([
    ['packageId', { ...input, packageId: 'invalid' }],
    ['versionId', { ...input, versionId: '01ARZ3NDEKTSV4RRFFQ69G5FAI' }],
    ['projectId', { ...input, scope: { kind: 'project', projectId: 'short' } }],
    ['overflow ULID', { ...input, packageId: '81ARZ3NDEKTSV4RRFFQ69G5FAV' }],
  ] satisfies [string, PackageManageInput][])(
    'rejects invalid %s before reauthentication or reading',
    async (_label, request) => {
      const { call, sessions, reader, store, log } = setup();
      expect(await call({ ...request, action: 'tombstone' })).toEqual({
        ok: false,
        error: 'invalid_input',
      });
      expect(sessions.isReauthFresh).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(reader.findManagedVersion).not.toHaveBeenCalled();
      noWrites(store);
    },
  );

  it.each([
    ['not_found', 'not_found'],
    ['authority', 'forbidden'],
    ['conflict', 'conflict'],
    ['indeterminate', 'indeterminate'],
  ] as const)('maps store refusal %s without retry', async (reason, error) => {
    const { call, store, log } = setup();
    store.quarantineVersion.mockResolvedValue({ ok: false, reason });
    expect(await call()).toEqual({ ok: false, error });
    expect(store.quarantineVersion).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith(event('quarantine', 'organization'));
  });

  it.each([
    'collision',
    'unclassified',
    'invalid_pattern',
    'too_many_patterns',
    'not_attached',
    'not_eligible',
    'unexpected',
  ])('throws for unexpected store refusal %s', async (reason) => {
    const { call, store } = setup();
    store.quarantineVersion.mockResolvedValue({ ok: false, reason } as VisibilityWriteResult);
    await expect(call()).rejects.toThrow('Unexpected package manage store outcome');
    expect(store.quarantineVersion).toHaveBeenCalledTimes(1);
  });

  it('builds only the allowed audit changes and correlation fields', async () => {
    const { call, store } = setup();
    await call();
    const audit = store.quarantineVersion.mock.calls[0]?.[2].audit;
    expect(audit).toBeDefined();
    expect(JSON.parse(audit!.payloadJson)).toEqual({
      op_id: apiCall.audit.opId,
      request_id: apiCall.audit.requestId,
      changes: {
        from_status: { old: 'active' },
        to_status: { new: 'quarantined' },
        package_name: { new: managed.packageName },
        version: { new: managed.version },
      },
    });
  });

  it('preserves the result when the event sink throws', async () => {
    const { call, log, store } = setup();
    log.mockImplementation(() => {
      throw new Error('sink unavailable');
    });
    expect(await call()).toEqual({ ok: true, value: { versionId, status: 'quarantined' } });
    expect(store.quarantineVersion).toHaveBeenCalledTimes(1);
  });
});
