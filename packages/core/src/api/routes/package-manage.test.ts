import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyRecord } from '../idempotency.js';
import type { AuthenticatedSession } from '../../auth/session.js';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineAccessPort,
  type EngineTokenAccess,
} from '../../authz/engine.js';
import { fenceKind } from '../../authz/fence.js';
import { createPackageManageService } from '../../catalogue/package-manage-service.js';
import type { VersionStatus } from '../../catalogue/version-rules.js';
import type { VisibilityStore } from '../../db/catalogue.js';
import type { ManagedVersion, PackageAdminReader } from '../../db/package-admin.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { MAX_BODY_BYTES } from '../validate.js';
import { packageManageRoutes, type TagRebuildPort } from './package-manage.js';

const PKG = '01JA0000000000000000000001';
const VERSION = '01JA0000000000000000000002';
const PROJECT = '01JA0000000000000000000003';
const OTHER = '01JA0000000000000000000004';
const ABSENT = '01JA0000000000000000000005';
const NOW = '2026-10-21T10:00:00.000Z';
const ORIGIN = 'https://broker.test';
const SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const SENTINEL = 'S3CR3T-SENTINEL';
const org = orgContext('org-1');
const clock = fixedClock(NOW);
const actions = ['quarantine', 'tombstone', 'release'] as const;
const path = (action: string, project?: string, pkg = PKG) =>
  `/_pb/${project === undefined ? '' : `projects/${project}/`}packages/${pkg}/versions/${VERSION}/${action}`;
const paths = [...actions.flatMap((a) => [path(a), path(a, 'demo')]), path('rebuild')];

beforeEach(() => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
});
afterEach(() => vi.restoreAllMocks());

async function fixture(
  options: {
    permissions?: string[];
    sourceProjectId?: string | null;
    status?: VersionStatus;
    reauth?: boolean;
    race?: 'throw' | 'refuse';
    sessionId?: string;
  } = {},
) {
  const permissions = options.permissions ?? ['org:packages:manage', 'project:packages:manage'];
  const records = new Map<string, IdempotencyRecord>();
  const audits: unknown[] = [];
  const log = vi.fn();
  let sequence = 100;
  const ids = { ulid: () => `01JA${String(++sequence).padStart(22, '0')}` };
  let row: ManagedVersion = {
    packageId: PKG,
    versionId: VERSION,
    ecosystem: 'npm',
    packageName: '@example/lib',
    version: '1.0.0',
    status: options.status ?? 'active',
    sourceId: OTHER,
    sourceProjectId: options.sourceProjectId === undefined ? PROJECT : options.sourceProjectId,
  };
  const reader = {
    findManagedVersion: vi.fn<PackageAdminReader['findManagedVersion']>(async (ctx, query) =>
      ctx.orgId === org.orgId &&
      query.packageId === PKG &&
      query.versionId === VERSION &&
      (query.projectId === null || query.projectId === row.sourceProjectId)
        ? { ...row }
        : null,
    ),
  };
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = {
    quarantineVersion: vi.fn<VisibilityStore['quarantineVersion']>(async (_ctx, _fence, input) => {
      if (options.race !== undefined) {
        if (++arrivals === 2) release();
        await barrier;
      }
      if (!claim(input.idempotency)) return { ok: false, reason: 'conflict' };
      row = { ...row, status: 'quarantined' };
      audits.push(input.audit);
      return { ok: true, opId: (JSON.parse(input.audit!.payloadJson) as { op_id: string }).op_id };
    }),
    tombstoneVersion: vi.fn<VisibilityStore['tombstoneVersion']>(async (_ctx, _fence, input) => {
      if (!claim(input.idempotency)) return { ok: false, reason: 'conflict' };
      row = { ...row, status: 'tombstoned' };
      audits.push(input.audit);
      return { ok: true, opId: (JSON.parse(input.audit!.payloadJson) as { op_id: string }).op_id };
    }),
    releaseQuarantine: vi.fn<VisibilityStore['releaseQuarantine']>(async (_ctx, _fence, input) => {
      if (!claim(input.idempotency)) return { ok: false, reason: 'conflict' };
      row = { ...row, status: 'active' };
      audits.push(input.audit);
      return { ok: true, opId: (JSON.parse(input.audit!.payloadJson) as { op_id: string }).op_id };
    }),
  };
  function claim(record: IdempotencyRecord | undefined) {
    if (record === undefined) return true;
    const key = `${org.orgId}|${record.principalKey}|${record.key}`;
    if (records.has(key)) {
      if (options.race === 'refuse') return false;
      throw new Error('UNIQUE constraint failed: api_idempotency');
    }
    records.set(key, record);
    return true;
  }
  const authenticated: AuthenticatedSession = {
    principal: { kind: 'user', id: 'user-1' },
    session: {
      id: options.sessionId ?? 'session-1',
      userId: 'user-1',
      identityId: null,
      csrfHash: await sha256Hex(CSRF),
      createdAt: NOW,
      expiresAt: NOW,
      lastSeenAt: NOW,
      reauthAt: options.reauth === false ? null : NOW,
      user: { id: 'user-1', email: '', displayName: null },
    },
  };
  const sessions = {
    authenticate: vi.fn(async () => authenticated),
    isReauthFresh: (session: AuthenticatedSession) => session.session.reauthAt !== null,
  };
  const service = createPackageManageService({ reader, store, sessions, clock, ids, log });
  const manage = vi.spyOn(service, 'manage');
  const rebuild: TagRebuildPort = {
    requestTagRebuild: vi.fn<TagRebuildPort['requestTagRebuild']>(
      async (_ctx, _authenticated, _fence, _input, call) => {
        claim(call.idempotency);
        return { ok: true };
      },
    ),
  };
  const idempotency = {
    find: vi.fn(
      async (ctx: typeof org, principal: string, key: string) =>
        records.get(`${ctx.orgId}|${principal}|${key}`) ?? null,
    ),
  };
  const routes = packageManageRoutes({
    service,
    rebuild,
    sessions,
    idempotency,
    clock,
    ids,
    clientIp: () => null,
  });
  const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
  const bearer = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
  const projects = [
    { slug: 'demo', id: PROJECT, archivedAt: null, visible: true },
    { slug: 'archived', id: PROJECT, archivedAt: NOW, visible: true },
    { slug: 'invisible', id: PROJECT, archivedAt: null, visible: false },
  ];
  const lookupSession = vi.fn<EngineAccessPort['lookupSession']>(async (_org, input) => {
    if (input.secretHash !== (await sha256Hex(SECRET))) return null;
    const project = projects.find(
      (project) =>
        project.slug === input.projectSlug &&
        (project.archivedAt === null || input.allowArchived === true),
    );
    return {
      session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
      user: { id: 'user-1' },
      identity: null,
      protectedHolder: false,
      project: project === undefined ? null : { id: project.id },
      organizationPermissions: permissions.filter((p) => p.startsWith('org:')),
      projectPermissions: project?.visible
        ? ['project:read', ...permissions.filter((p) => p.startsWith('project:'))]
        : [],
    };
  });
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: routes,
    packageResolver: { resolve: async () => ({ kind: 'absent' as const }) },
    ports: { organizations: { get: async () => null }, clock, ids },
    resolveOrg: async () => org,
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession,
        lookupToken: async () =>
          Object.defineProperty(
            {
              token: {
                id: 'token-1',
                kind: 'pat',
                expired: false,
                revoked: false,
                lastUsedAt: null,
                userId: 'user-1',
                servicePrincipalId: null,
                bindingOk: true,
                projectMode: 'all',
                scope: { level: 'full', readOnly: false },
              },
              principalStatus: 'active',
              projectVisible: true,
              project: { id: PROJECT },
              validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
              organizationPermissions: permissions,
              projectPermissions: permissions,
            },
            'verifier',
            { value: { secretHash: await hashToken(keyring, 1, bearer), pepperVersion: 1 } },
          ) as unknown as EngineTokenAccess,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring,
        nowMs: () => clock.now().getTime(),
        dispatch: () => undefined,
        log: () => undefined,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  function request(
    url: string,
    init: {
      auth?: 'none' | 'malformed' | 'wrong' | 'token';
      body?: unknown;
      stream?: ReadableStream<Uint8Array>;
      contentType?: string | undefined;
      key?: string;
    } = {},
  ) {
    const headers = new Headers({ origin: ORIGIN, 'x-csrf-token': CSRF });
    if (init.auth === 'token') headers.set('authorization', `Bearer ${bearer}`);
    else if (init.auth !== 'none')
      headers.set(
        'cookie',
        `__Host-pb_session=${
          init.auth === 'malformed' ? 'invalid' : init.auth === 'wrong' ? 'Z'.repeat(43) : SECRET
        }`,
      );
    if (init.key !== undefined) headers.set('idempotency-key', init.key);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (init.contentType !== undefined) headers.set('content-type', init.contentType);
    return kernel.fetch(
      new Request(ORIGIN + url, {
        method: 'POST',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.stream === undefined ? {} : { body: init.stream, duplex: 'half' }),
      } as RequestInit),
    );
  }
  return {
    request,
    routes,
    service,
    manage,
    rebuild,
    reader,
    store,
    audits,
    records,
    idempotency,
    log,
    lookupSession,
  };
}

async function dump(response: Response) {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

describe('package manage routes', () => {
  it('declares seven session-only operations at organization and project boundaries', async () => {
    const f = await fixture();
    expect(f.routes).toHaveLength(7);
    expect(new Set(f.routes.map((r) => r.path)).size).toBe(7);
    for (const route of f.routes) {
      const project = route.path.startsWith('/_pb/projects/');
      expect(route.method).toBe('POST');
      expect(route.boundary).toBe(project ? 'project' : 'organization');
      expect(route.permission).toBe(project ? 'project:packages:manage' : 'org:packages:manage');
      expect(route.api).toBeDefined();
    }
  });
  for (const url of paths) {
    it.each(['none', 'malformed', 'wrong'] as const)(
      `uses one 401 for %s credentials on ${url}`,
      async (auth) => {
        const f = await fixture();
        const response = await f.request(url, { auth });
        expect(response.status).toBe(401);
        expect(await dump(response)).toEqual(await dump(await f.request(url, { auth: 'none' })));
        expect(f.manage).not.toHaveBeenCalled();
        expect(f.rebuild.requestTagRebuild).not.toHaveBeenCalled();
      },
    );
    it(`denies a token on ${url} with the generic permission-denial body`, async () => {
      const f = await fixture();
      const denied = await fixture({ permissions: [] });
      const response = await f.request(url, { auth: 'token' });
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toBe(await (await denied.request(url)).text());
      expect(text).not.toContain('packages:manage');
      expect(f.manage).not.toHaveBeenCalled();
      expect(f.rebuild.requestTagRebuild).not.toHaveBeenCalled();
    });
    it(`denies a session without permission on ${url}`, async () => {
      const f = await fixture({ permissions: [] });
      await error(await f.request(url), 403, 'forbidden');
      expect(f.manage).not.toHaveBeenCalled();
      expect(f.rebuild.requestTagRebuild).not.toHaveBeenCalled();
    });
  }
  it.each(['absent', 'foreign', 'archived', 'invisible'])(
    `uses the uniform 404 for %s`,
    async (cause) => {
      const f = await fixture({ sourceProjectId: cause === 'foreign' ? OTHER : PROJECT });
      const absent = await fixture();
      const url =
        cause === 'foreign'
          ? path('quarantine', 'demo')
          : cause === 'absent'
            ? path('quarantine', 'demo', ABSENT)
            : path('quarantine', cause);
      const response = await f.request(url);
      expect(response.status).toBe(404);
      expect(await dump(response)).toEqual(
        await dump(await absent.request(path('quarantine', 'demo', ABSENT))),
      );
      expect(f.audits).toEqual([]);
      expect(f.store.quarantineVersion).not.toHaveBeenCalled();
      expect(f.store.tombstoneVersion).not.toHaveBeenCalled();
      expect(f.store.releaseQuarantine).not.toHaveBeenCalled();
      expect(f.rebuild.requestTagRebuild).not.toHaveBeenCalled();
      if (cause === 'archived' || cause === 'invisible') {
        expect(f.manage).not.toHaveBeenCalled();
        expect(f.lookupSession.mock.calls[0]![1].projectSlug).toBe(cause);
        expect(f.lookupSession.mock.calls[0]![1].allowArchived).toBeUndefined();
      }
    },
  );
  it('lets an organization administrator tombstone an organization-source version', async () => {
    const f = await fixture({ sourceProjectId: null });
    const response = await f.request(path('tombstone'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: VERSION, status: 'tombstoned' });
    expect(response.headers.has('etag')).toBe(false);
    const [ctx, authenticated, fence, input, call] = f.manage.mock.calls[0]!;
    expect(ctx).toEqual(org);
    expect(authenticated.session.id).toBe('session-1');
    expect(fenceKind(fence)).toBe('session');
    expect(input).toEqual({
      packageId: PKG,
      versionId: VERSION,
      action: 'tombstone',
      scope: { kind: 'organization' },
    });
    expect(call.audit).toMatchObject({ sourceIp: null, tokenSelector: null });
    expect(f.audits).toHaveLength(1);
  });
  it('hides an organization-source package from a project manager', async () => {
    const f = await fixture({ permissions: ['project:packages:manage'], sourceProjectId: null });
    expect(await dump(await f.request(path('tombstone', 'demo')))).toEqual(
      await dump(await f.request(path('tombstone', 'demo', ABSENT))),
    );
    expect(f.audits).toEqual([]);
  });
  it('manages an own-source version with the resolved project id', async () => {
    const f = await fixture({ permissions: ['project:packages:manage'] });
    expect((await f.request(path('quarantine', 'demo'), { body: {} })).status).toBe(200);
    expect(f.manage.mock.calls[0]![3].scope).toEqual({ kind: 'project', projectId: PROJECT });
  });
  it.each([undefined, 'application/json', 'text/plain'])(
    'accepts a Node adapter empty body stream with content-type %s',
    async (contentType) => {
      const f = await fixture();
      const stream = Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>;
      const response = await f.request(path('quarantine'), { stream, contentType });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: VERSION, status: 'quarantined' });
      expect(f.manage).toHaveBeenCalledOnce();
    },
  );
  it('requires JSON for a non-empty Node adapter body stream', async () => {
    const f = await fixture();
    const stream = Readable.toWeb(Readable.from([Buffer.from('{}')])) as ReadableStream<Uint8Array>;
    await error(await f.request(path('quarantine'), { stream }), 415, 'unsupported_media_type');
    expect(f.manage).not.toHaveBeenCalled();
  });
  it('bounds a non-empty Node adapter JSON body stream', async () => {
    const f = await fixture();
    const stream = Readable.toWeb(
      Readable.from([Buffer.from(' '.repeat(MAX_BODY_BYTES)), Buffer.from('{}')]),
    ) as ReadableStream<Uint8Array>;
    await error(
      await f.request(path('quarantine'), { stream, contentType: 'application/json' }),
      413,
      'payload_too_large',
    );
    expect(f.manage).not.toHaveBeenCalled();
  });
  it.each([
    ['unknown property', { body: { [SENTINEL]: SENTINEL } }, '/body', 'unrecognized_keys'],
    ['non-object body', { body: SENTINEL }, '/body', 'invalid_type'],
    ['overlong key', { key: SENTINEL.repeat(10) }, '/headers/idempotency-key', 'invalid'],
  ] as const)('sanitizes %s validation', async (_name, init, pointer, code) => {
    const f = await fixture();
    const response = await f.request(path('quarantine'), init);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: { code: 'invalid_request', details: [{ path: pointer, code }] },
    });
    expect((body as { error: { details: unknown } }).error.details).toEqual([
      { path: pointer, code },
    ]);
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(SENTINEL);
    expect(f.manage).not.toHaveBeenCalled();
  });
  it.each(['tombstone', 'rebuild'])('requires fresh reauthentication for %s', async (action) => {
    const f = await fixture({ reauth: false });
    const response = await f.request(path(action));
    await error(response.clone(), 403, 'reauth_required');
    expect(await dump(response)).toEqual(
      await dump(await f.request(path(action, undefined, ABSENT))),
    );
    expect(f.audits).toEqual([]);
    expect(f.reader.findManagedVersion).not.toHaveBeenCalled();
    expect(f.manage).not.toHaveBeenCalled();
    expect(f.rebuild.requestTagRebuild).not.toHaveBeenCalled();
  });
  it.each(['quarantine', 'release'] as const)(
    'does not require fresh reauthentication for %s',
    async (action) => {
      const f = await fixture({
        reauth: false,
        status: action === 'release' ? 'quarantined' : 'active',
      });
      expect((await f.request(path(action))).status).toBe(200);
    },
  );
  it.each(actions)('refuses %s of a tombstoned version without audit', async (action) => {
    const f = await fixture({ status: 'tombstoned' });
    await error(await f.request(path(action)), 409, 'conflict');
    expect(f.audits).toEqual([]);
  });
  it.each(['active', 'yanked', 'removed_upstream'] as const)(
    'refuses release from %s',
    async (status) => {
      const f = await fixture({ status });
      await error(await f.request(path('release')), 409, 'conflict');
      expect(f.audits).toEqual([]);
    },
  );
  it.each(['throw', 'refuse'] as const)(
    'settles a concurrent quarantine key race when the loser will %s',
    async (race) => {
      const f = await fixture({ race });
      const responses = await Promise.all(
        [1, 2].map(() => f.request(path('quarantine'), { key: 'race' })),
      );
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      expect(responses.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(
        1,
      );
      expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
      expect(f.audits).toHaveLength(1);
      expect(f.records.size).toBe(1);
    },
  );
  it.each([...actions, 'rebuild'])('replays %s without a second operation', async (action) => {
    const f = await fixture({ status: action === 'release' ? 'quarantined' : 'active' });
    const first = await f.request(path(action), { key: 'once' });
    const replay = await f.request(path(action), { key: 'once', body: {} });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.text()).toBe(await first.text());
    expect(
      f.manage.mock.calls.length + vi.mocked(f.rebuild.requestTagRebuild).mock.calls.length,
    ).toBe(1);
    expect(f.idempotency.find.mock.calls.every(([ctx]) => ctx.orgId === org.orgId)).toBe(true);
  });
  it('returns idempotency_mismatch when a key names another action', async () => {
    const f = await fixture();
    expect((await f.request(path('quarantine'), { key: 'same' })).status).toBe(200);
    await error(await f.request(path('release'), { key: 'same' }), 409, 'idempotency_mismatch');
    expect(f.audits).toHaveLength(1);
  });
  it('calls the rebuild port with ids, authenticated session, fence and ApiCall', async () => {
    const f = await fixture();
    expect((await f.request(path('rebuild'), { key: 'rebuild' })).status).toBe(200);
    const [ctx, session, fence, input, call] = vi.mocked(f.rebuild.requestTagRebuild).mock
      .calls[0]!;
    expect(ctx).toEqual(org);
    expect(session.session.id).toBe(fence.sessionId);
    expect(fenceKind(fence)).toBe('session');
    expect(input).toEqual({ packageId: PKG, versionId: VERSION });
    expect(call.idempotency).toMatchObject({ key: 'rebuild', status: 200 });
  });
  it.each([
    ['reauth_required', 403],
    ['forbidden', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['indeterminate', 503],
  ] as const)('maps rebuild %s to %s', async (code, status) => {
    const f = await fixture();
    vi.mocked(f.rebuild.requestTagRebuild).mockResolvedValue({ ok: false, error: code });
    await error(
      await f.request(path('rebuild')),
      status,
      code === 'indeterminate' ? 'unavailable' : code,
    );
  });
  it('rejects a reauthenticated session that differs from the kernel actor', async () => {
    const f = await fixture({ sessionId: 'another-session' });
    const response = await f.request(path('quarantine'));
    expect(response.status).toBe(401);
    expect(await dump(response)).toEqual(
      await dump(await f.request(path('quarantine'), { auth: 'none' })),
    );
    expect(f.manage).not.toHaveBeenCalled();
  });
  it.each([true, false])('sets no-store and no CORS headers on success=%s', async (success) => {
    const f = await fixture();
    const response = await f.request(path('quarantine'), success ? {} : { auth: 'none' });
    expect(response.status).toBe(success ? 200 : 401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect([...response.headers.keys()].some((k) => k.startsWith('access-control-'))).toBe(false);
  });
});
