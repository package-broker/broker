import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedSession } from '../../auth/session.js';
import type { IdempotencyRecord } from '../idempotency.js';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '../../authz/engine.js';
import { PERMISSIONS } from '../../authz/permissions.js';
import {
  createServicePrincipalService,
  type ServicePrincipalRecord,
  type ServicePrincipalStore,
  type ServicePrincipalAuthority,
} from '../../authz/service-principal-service.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { defineApi } from '../route.js';
import { SERVICE_ERROR_TABLE } from '../response.js';
import {
  createServicePrincipalSpec,
  SERVICE_PRINCIPAL_API_SPECS,
} from './service-principals-schemas.js';
import { servicePrincipalRoutes } from './service-principals.js';

const ORIGIN = 'https://broker.test';
const ID = '01JA0000000000000000000000';
const PROJECT = '01JA0000000000000000000001';
const SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const bearer = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
const clock = fixedClock('2026-10-19T00:00:00.000Z');
const cases = [false, true].flatMap((project) =>
  ['permissions', 'suspend', 'restore'].map((action) => ({
    project,
    action,
    method: action === 'permissions' ? 'PUT' : 'POST',
    path: `${project ? '/_pb/projects/demo' : '/_pb'}/service-principals/${ID}/${action}`,
  })),
);
type RouteCase = (typeof cases)[number];

async function fixture(
  options: {
    projectId?: string | null;
    absent?: boolean;
    tokenScope?: 'read' | 'full';
    permissions?: readonly string[];
    livePermissions?: readonly string[];
    protectedHolder?: boolean;
    projectArchived?: boolean;
    principalPermissions?: readonly string[];
    principalStatus?: 'active' | 'suspended';
    staleSession?: boolean;
    duplicate?: boolean;
  } = {},
) {
  let current: ServicePrincipalRecord = {
    id: ID,
    name: 'ci',
    projectId: options.projectId ?? null,
    createdByUserId: 'user-1',
    status: options.principalStatus ?? 'active',
    revision: 3,
    permissions: options.principalPermissions ?? ['project:read'],
  };
  const audits: string[] = [];
  const log = vi.fn();
  const replays = new Map<string, IdempotencyRecord>();
  const records = new Map<string, ServicePrincipalRecord>();
  const store = {
    get: vi.fn<ServicePrincipalStore['get']>(async () => (options.absent ? null : current)),
    create: vi.fn<ServicePrincipalStore['create']>(async (_org, _fence, _guard, input) => {
      if (options.duplicate || [...records.values()].some((p) => p.name === input.name))
        return 'duplicate';
      current = {
        id: input.id,
        name: input.name,
        projectId: input.projectId,
        createdByUserId: input.createdByUserId,
        permissions: input.permissions,
        status: 'active',
        revision: 1,
      };
      records.set(current.id, current);
      audits.push(input.audit.action);
      if (input.idempotency !== undefined) replays.set(input.idempotency.key, input.idempotency);
      return 'created';
    }),
    setPermissions: vi.fn<ServicePrincipalStore['setPermissions']>(
      async (_org, _fence, _guard, input) => {
        current = { ...current, permissions: input.permissions, revision: current.revision + 1 };
        audits.push(input.audit.action);
        return 'updated';
      },
    ),
    suspend: vi.fn<ServicePrincipalStore['suspend']>(async (_org, _fence, _guard, input) => {
      if (current.status === 'suspended') return 'unchanged';
      current = { ...current, status: 'suspended', revision: current.revision + 1 };
      audits.push(input.audit.action);
      return 'suspended';
    }),
    restore: vi.fn<ServicePrincipalStore['restore']>(async (_org, _fence, _guard, input) => {
      if (current.status !== 'suspended') return 'not_suspended';
      current = { ...current, status: 'active', revision: current.revision + 1 };
      audits.push(input.audit.action);
      return 'restored';
    }),
  };
  const authority = {
    livePermissions: vi.fn<ServicePrincipalAuthority['livePermissions']>(
      async () => new Set(options.livePermissions ?? PERMISSIONS.map((p) => p.name)),
    ),
    guard: vi.fn<ServicePrincipalAuthority['guard']>(),
  };
  let sequence = 0;
  const ids = { ulid: () => `01JA${String(++sequence).padStart(22, '0')}` };
  const servicePrincipals = createServicePrincipalService({
    principals: store,
    sessions: { isReauthFresh: () => true },
    authority,
    directory: { createdBy: async () => [] },
    clock,
    ids,
    log,
  });
  const setPermissions = vi.spyOn(servicePrincipals, 'setPermissions');
  const suspend = vi.spyOn(servicePrincipals, 'suspend');
  const restore = vi.spyOn(servicePrincipals, 'restore');
  const get = vi.fn<ServicePrincipalStore['get']>(async (_org, id) =>
    options.absent ? null : (records.get(id) ?? current),
  );
  const list = vi.fn(
    async (
      _org: unknown,
      input: { limit: number; after?: string; projectId?: string; includeProjects: boolean },
    ) => {
      const items = [...records.values()]
        .filter(
          (p) =>
            (input.after === undefined || p.id > input.after) &&
            (input.projectId === undefined || p.projectId === input.projectId) &&
            (input.includeProjects || p.projectId === null),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      return {
        items: items.slice(0, input.limit),
        next: items.length > input.limit ? items[input.limit - 1]!.id : null,
      };
    },
  );
  const projects = {
    get: vi.fn(async () => (options.projectArchived ? null : { status: 'active' as const })),
  };
  const sessions = {
    authenticate: vi.fn(async () =>
      options.staleSession
        ? null
        : ({
            session: { id: 'session-1', userId: 'user-1' },
            principal: { kind: 'user', id: 'user-1' },
          } as AuthenticatedSession),
    ),
  };
  const idempotency = {
    find: vi.fn(async (_org: unknown, _principal: string, key: string) => replays.get(key) ?? null),
  };
  const clientIp = vi.fn(() => '203.0.113.7');
  const permissions = options.permissions ?? PERMISSIONS.map((p) => p.name);
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: servicePrincipalRoutes({
      servicePrincipals,
      principals: { get, list },
      sessions,
      projects,
      idempotency,
      clock,
      ids,
      clientIp,
    }),
    ports: { organizations: { get: async () => null }, clock, ids },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: 'user-1' },
          identity: null,
          protectedHolder: options.protectedHolder ?? true,
          project:
            input.boundary === 'project' && !options.projectArchived ? { id: PROJECT } : null,
          organizationPermissions: permissions,
          projectPermissions:
            input.boundary === 'project'
              ? ['project:read', ...permissions.filter((p) => p.startsWith('project:'))]
              : [],
        }),
        lookupToken: async (_org, input) =>
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
                scope: {
                  level: options.tokenScope ?? 'full',
                  readOnly: options.tokenScope === 'read',
                },
              },
              principalStatus: 'active',
              projectVisible: true,
              validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
              project: input.boundary === 'project' ? { id: PROJECT } : null,
              organizationPermissions: permissions,
              projectPermissions: permissions.filter((p) => p.startsWith('project:')),
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
        dispatch: (run) => {
          void run();
        },
        log,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (
    route: Pick<RouteCase, 'method' | 'path' | 'action'>,
    options: {
      auth?: 'anonymous' | 'token';
      ifMatch?: string | null;
      body?: unknown;
      path?: string;
      key?: string | null;
    } = {},
  ) => {
    const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' });
    if (options.auth === 'token') headers.set('authorization', `Bearer ${bearer}`);
    else if (options.auth !== 'anonymous') {
      headers.set('cookie', `${SESSION_COOKIE}=${SECRET}`);
      headers.set('x-csrf-token', CSRF);
    }
    if (options.key !== null) headers.set('idempotency-key', options.key ?? 'create-key');
    if (options.ifMatch !== null) headers.set('if-match', options.ifMatch ?? '"r3"');
    return app.fetch(
      new Request(ORIGIN + (options.path ?? route.path), {
        method: route.method,
        headers,
        ...(route.action === 'permissions' || options.body !== undefined
          ? { body: JSON.stringify(options.body ?? { permissions: ['project:read'] }) }
          : {}),
      }),
    );
  };
  return {
    request,
    get,
    list,
    projects,
    sessions,
    idempotency,
    store,
    authority,
    audits,
    setPermissions,
    suspend,
    restore,
    clientIp,
    log,
  };
}

async function normalized(response: Response) {
  const body = (await response.json()) as { error: { requestId: string } };
  const { requestId, ...error } = body.error;
  expect(requestId).toEqual(expect.any(String));
  return {
    status: response.status,
    headers: [...response.headers].filter(([key]) => key !== 'x-request-id'),
    body: { error },
  };
}

function noServiceCalls(f: Awaited<ReturnType<typeof fixture>>) {
  for (const method of [f.setPermissions, f.suspend, f.restore])
    expect(method).not.toHaveBeenCalled();
}

function noStoreWrites(f: Awaited<ReturnType<typeof fixture>>) {
  for (const method of [f.store.create, f.store.setPermissions, f.store.suspend, f.store.restore])
    expect(method).not.toHaveBeenCalled();
  expect(f.audits).toEqual([]);
}

describe.each(cases)('$method $path', (route) => {
  it.each(['read', 'full'] as const)('denies a %s-scope token', async (tokenScope) => {
    const f = await fixture({ tokenScope, projectId: route.project ? PROJECT : null });
    expect((await f.request(route, { auth: 'token' })).status).toBe(403);
    expect(f.get).not.toHaveBeenCalled();
    noServiceCalls(f);
  });
  it('denies anonymous credentials', async () => {
    const f = await fixture();
    expect((await f.request(route, { auth: 'anonymous' })).status).toBe(401);
    noServiceCalls(f);
  });
  it('denies a visible boundary without write permission', async () => {
    const f = await fixture({ permissions: ['org:read', 'project:read'] });
    expect((await f.request(route)).status).toBe(403);
    expect(f.get).not.toHaveBeenCalled();
    noServiceCalls(f);
  });
  it.each(route.project ? ['other project', 'organization'] : ['project'])(
    'hides an unmanageable principal bound to %s like an absent id',
    async (binding) => {
      const absent = await fixture({ absent: true });
      const foreign = await fixture({
        projectId: binding === 'organization' ? null : '01JA0000000000000000000002',
        protectedHolder: route.project || route.action === 'restore',
      });
      const result = await normalized(await foreign.request(route));
      expect(result.status).toBe(404);
      expect(result).toEqual(await normalized(await absent.request(route)));
      noServiceCalls(absent);
      noServiceCalls(foreign);
    },
  );
  it('rejects a non-ULID principal before lookup', async () => {
    const f = await fixture();
    expect((await f.request(route, { path: route.path.replace(ID, 'Z'.repeat(26)) })).status).toBe(
      400,
    );
    expect(f.get).not.toHaveBeenCalled();
    noServiceCalls(f);
  });
  it('forwards identity, organization, revision and audit context', async () => {
    const f = await fixture({ projectId: route.project ? PROJECT : null });
    if (route.action === 'restore') f.restore.mockResolvedValueOnce({ ok: true, value: null });
    const response = await f.request(route);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(f.get).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), ID);
    const method =
      route.action === 'permissions'
        ? f.setPermissions
        : route.action === 'suspend'
          ? f.suspend
          : f.restore;
    const call = method.mock.calls[0]!;
    expect(call[0]).toEqual(orgContext('org-1'));
    expect(call[1]).toMatchObject({
      kind: 'organization',
      userId: 'user-1',
      sessionId: 'session-1',
      isOrganizationAdmin: !route.project,
    });
    if (route.project) expect([...call[1].permissions]).toEqual([]);
    expect(call[2]).toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
      expected: route.action === 'suspend' ? {} : { service_principal: 3 },
    });
    expect(call[3]).toBe(ID);
    expect(call.at(-1)).toEqual({
      audit: {
        opId: expect.any(String),
        requestId: response.headers.get('x-request-id'),
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
    });
  });
});

describe('organization kill switch for project principals', () => {
  const route = (action: string, project = false) =>
    cases.find((c) => c.project === project && c.action === action)!;

  it.each(['suspend', 'permissions'])(
    'allows an admin to %s in an archived project',
    async (action) => {
      const f = await fixture({
        projectId: PROJECT,
        projectArchived: true,
        principalPermissions: ['project:read', 'project:packages:read'],
      });
      expect((await f.request(route(action, true))).status).toBe(404);
      expect(f.get).not.toHaveBeenCalled();
      noServiceCalls(f);
      expect((await f.request(route(action))).status).toBe(204);
      expect(await f.store.get(orgContext('org-1'), ID)).toMatchObject(
        action === 'suspend' ? { status: 'suspended' } : { permissions: ['project:read'] },
      );
      expect(f.audits).toEqual([
        action === 'suspend' ? 'service_principal.suspend' : 'service_principal.permissions_set',
      ]);
      expect(f.authority.livePermissions).toHaveBeenCalledWith(
        orgContext('org-1'),
        expect.anything(),
        PROJECT,
      );
      expect(f.authority.guard).toHaveBeenCalledExactlyOnceWith(
        orgContext('org-1'),
        expect.anything(),
        expect.objectContaining({ projectId: PROJECT, allowArchived: true }),
      );
    },
  );

  it.each(['suspend', 'permissions'])(
    'hides %s from a non-admin like an absent id',
    async (action) => {
      const f = await fixture({
        projectId: PROJECT,
        projectArchived: true,
        protectedHolder: false,
      });
      const absent = await fixture({ absent: true, protectedHolder: false });
      const response = await normalized(await f.request(route(action)));
      expect(response.status).toBe(404);
      expect(response).toEqual(await normalized(await absent.request(route(action))));
      noServiceCalls(f);
      noServiceCalls(absent);
      noStoreWrites(f);
    },
  );

  it.each(['suspend', 'permissions'])(
    'keeps the live project permission check for %s',
    async (action) => {
      const f = await fixture({
        projectId: PROJECT,
        projectArchived: true,
        livePermissions: ['org:service-principals:write'],
      });
      const absent = await fixture({ absent: true });
      const response = await normalized(await f.request(route(action)));
      expect(response.status).toBe(404);
      expect(response).toEqual(await normalized(await absent.request(route(action))));
      expect(f.authority.livePermissions).toHaveBeenCalledOnce();
      noStoreWrites(f);
    },
  );

  it('hides a widening PUT through the organization form like an absent id', async () => {
    const f = await fixture({ projectId: PROJECT });
    const absent = await fixture({ absent: true });
    const body = { permissions: ['project:read', 'project:packages:read'] };
    const response = await normalized(await f.request(route('permissions'), { body }));
    expect(response.status).toBe(404);
    expect(response).toEqual(
      await normalized(await absent.request(route('permissions'), { body })),
    );
    noServiceCalls(f);
    noServiceCalls(absent);
    noStoreWrites(f);
  });

  it('hides restore through the organization form like an absent id', async () => {
    const f = await fixture({ projectId: PROJECT, principalStatus: 'suspended' });
    const absent = await fixture({ absent: true });
    const response = await normalized(await f.request(route('restore')));
    expect(response.status).toBe(404);
    expect(response).toEqual(await normalized(await absent.request(route('restore'))));
    noServiceCalls(f);
    noServiceCalls(absent);
    noStoreWrites(f);
  });

  it('allows widening through the live project form', async () => {
    const f = await fixture({ projectId: PROJECT });
    const permissions = ['project:packages:read', 'project:read'];
    expect((await f.request(route('permissions', true), { body: { permissions } })).status).toBe(
      204,
    );
    expect(f.store.setPermissions).toHaveBeenCalledOnce();
    expect((await f.store.get(orgContext('org-1'), ID))?.permissions).toEqual(permissions);
    expect(f.audits).toEqual(['service_principal.permissions_set']);
    expect(f.authority.guard).toHaveBeenCalledExactlyOnceWith(
      orgContext('org-1'),
      expect.anything(),
      expect.not.objectContaining({ allowArchived: true }),
    );
  });

  it('allows restore through the live project form', async () => {
    const f = await fixture({ projectId: PROJECT, principalStatus: 'suspended' });
    expect((await f.request(route('restore', true))).status).toBe(204);
    expect(f.store.restore).toHaveBeenCalledOnce();
    expect((await f.store.get(orgContext('org-1'), ID))?.status).toBe('active');
    expect(f.audits).toEqual(['service_principal.restore']);
    expect(f.authority.guard).toHaveBeenCalledExactlyOnceWith(
      orgContext('org-1'),
      expect.anything(),
      expect.not.objectContaining({ allowArchived: true }),
    );
  });
});

describe('project permission ceiling', () => {
  it.each(['permissions', 'restore'])(
    'refuses %s beyond the live permissions without store writes',
    async (action) => {
      const f = await fixture({
        projectId: PROJECT,
        permissions: ['project:service-principals:write'],
        livePermissions: ['project:service-principals:write'],
        principalStatus: action === 'restore' ? 'suspended' : 'active',
      });
      const route = cases.find((c) => c.project && c.action === action)!;
      const response = await f.request(route, {
        body: action === 'permissions' ? { permissions: ['project:read'] } : undefined,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
      expect(action === 'permissions' ? f.setPermissions : f.restore).toHaveBeenCalledOnce();
      expect(f.authority.livePermissions).toHaveBeenCalledOnce();
      expect(f.authority.guard).not.toHaveBeenCalled();
      noStoreWrites(f);
      expect(f.audits).toEqual([]);
    },
  );
});

for (const project of [false, true]) {
  const route = (action: string) =>
    cases.find((c) => c.project === project && c.action === action)!;
  describe(project ? 'project actions' : 'organization actions', () => {
    it.each(['permissions', 'restore'])('%s requires If-Match', async (action) => {
      const f = await fixture();
      expect((await f.request(route(action), { ifMatch: null })).status).toBe(428);
      expect(f.get).not.toHaveBeenCalled();
      noServiceCalls(f);
    });
    it.each(['permissions', 'restore'])('%s rejects stale revisions', async (action) => {
      const f = await fixture({ projectId: project ? PROJECT : null });
      expect((await f.request(route(action), { ifMatch: '"r2"' })).status).toBe(412);
      expect(f.audits).toEqual([]);
    });
    it.each(['"r1x"', '"r9007199254740992"'])(
      'restore rejects malformed revision %s',
      async (ifMatch) => {
        const f = await fixture();
        expect((await f.request(route('restore'), { ifMatch })).status).toBe(400);
        expect(f.get).not.toHaveBeenCalled();
        noServiceCalls(f);
      },
    );
    it('suspends without If-Match and audits only effective status changes', async () => {
      const f = await fixture({ projectId: project ? PROJECT : null });
      expect((await f.request(route('suspend'), { ifMatch: null })).status).toBe(204);
      expect((await f.request(route('suspend'), { ifMatch: null })).status).toBe(204);
      expect(f.audits).toEqual(['service_principal.suspend']);
      expect((await f.request(route('restore'), { ifMatch: '"r4"' })).status).toBe(204);
      expect((await f.request(route('restore'), { ifMatch: '"r5"' })).status).toBe(409);
      expect(f.audits).toEqual(['service_principal.suspend', 'service_principal.restore']);
    });
    it('preserves a suspend conflict from the service', async () => {
      const f = await fixture({ projectId: project ? PROJECT : null });
      f.suspend.mockResolvedValue({ ok: false, error: 'conflict' });
      expect((await f.request(route('suspend'), { ifMatch: null })).status).toBe(409);
    });
    it('rejects unknown permissions without reflecting them', async () => {
      const f = await fixture({ projectId: project ? PROJECT : null });
      const response = await f.request(route('permissions'), {
        body: { permissions: ['org:unknown-sentinel'] },
      });
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ error: { code: 'invalid_request' } });
      expect(body).not.toContain('unknown-sentinel');
      expect(f.audits).toEqual([]);
    });
    it('rejects unknown body properties before lookup', async () => {
      const f = await fixture();
      expect(
        (await f.request(route('permissions'), { body: { permissions: [], projectId: PROJECT } }))
          .status,
      ).toBe(400);
      expect(f.get).not.toHaveBeenCalled();
      noServiceCalls(f);
    });
  });
}

it('exports nine representable route specs without constructing services', () => {
  expect(SERVICE_PRINCIPAL_API_SPECS).toHaveLength(9);
  expect(new Set(SERVICE_PRINCIPAL_API_SPECS.map((spec) => spec.api.operationId)).size).toBe(9);
  for (const spec of SERVICE_PRINCIPAL_API_SPECS) expect(defineApi(spec)).toBe(spec);
});

it.each(Object.keys(SERVICE_ERROR_TABLE.ServicePrincipalError))(
  'maps service error %s through the error table',
  async (error) => {
    const f = await fixture();
    const name = error as keyof typeof SERVICE_ERROR_TABLE.ServicePrincipalError;
    f.suspend.mockResolvedValueOnce({ ok: false, error: name });
    const response = await f.request(cases.find((c) => !c.project && c.action === 'suspend')!);
    const mapping = SERVICE_ERROR_TABLE.ServicePrincipalError[name];
    expect(response.status).toBe(mapping.status);
    expect(await response.json()).toMatchObject({ error: { code: mapping.code } });
  },
);

const createRoute = { method: 'POST', path: '/_pb/service-principals', action: 'create' };
const listRoute = { method: 'GET', path: '/_pb/service-principals', action: 'list' };
const readRoute = { method: 'GET', path: `/_pb/service-principals/${ID}`, action: 'read' };
const createBody = { name: 'build-bot', permissions: ['project:read'] };

describe('service principal create, list and read', () => {
  it('creates with an ETag and exactly one audit row, then replays the original response', async () => {
    const f = await fixture();
    const response = await f.request(createRoute, { body: createBody });
    expect(response.status).toBe(201);
    expect(response.headers.get('etag')).toBe('"r1"');
    const principal = await response.json();
    expect(principal).toMatchObject({
      ...createBody,
      projectId: null,
      status: 'active',
      revision: 1,
    });
    expect(f.audits).toEqual(['service_principal.create']);
    const replay = await f.request(createRoute, { body: createBody });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('etag')).toBe('"r1"');
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual(principal);
    expect(f.store.create).toHaveBeenCalledOnce();
    expect(f.audits).toEqual(['service_principal.create']);
  });

  it('returns the defined duplicate conflict', async () => {
    const f = await fixture({ duplicate: true });
    const response = await f.request(createRoute, { body: createBody });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'duplicate' } });
    expect(f.audits).toEqual([]);
  });

  it.each([createRoute, listRoute, readRoute])(
    'denies $action before lookups without permission',
    async (route) => {
      const f = await fixture({ permissions: [] });
      const response = await f.request(route, {
        ...(route === createRoute ? { body: createBody } : {}),
      });
      expect(response.status).toBe(403);
      expect(f.get).not.toHaveBeenCalled();
      expect(f.list).not.toHaveBeenCalled();
      expect(f.projects.get).not.toHaveBeenCalled();
      expect(f.sessions.authenticate).not.toHaveBeenCalled();
      noStoreWrites(f);
    },
  );

  it('refuses a project-scoped caller creating in another project before lookup', async () => {
    const f = await fixture({
      protectedHolder: false,
      permissions: ['project:service-principals:write'],
    });
    expect(
      (await f.request(createRoute, { body: { ...createBody, project: PROJECT } })).status,
    ).toBe(403);
    expect(f.projects.get).not.toHaveBeenCalled();
    noStoreWrites(f);
  });

  it('creates in an active project and hides an unavailable project', async () => {
    const f = await fixture();
    const response = await f.request(createRoute, { body: { ...createBody, project: PROJECT } });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ projectId: PROJECT });
    const hidden = await fixture({ projectArchived: true });
    expect(
      (await hidden.request(createRoute, { body: { ...createBody, project: PROJECT } })).status,
    ).toBe(404);
    noStoreWrites(hidden);
  });

  it.each([null, '', 'bad key'])('requires a valid Idempotency-Key (%s)', async (key) => {
    const f = await fixture();
    expect((await f.request(createRoute, { body: createBody, key })).status).toBe(400);
    noStoreWrites(f);
  });

  it('rejects a changed request under the same idempotency key', async () => {
    const f = await fixture();
    expect((await f.request(createRoute, { body: createBody })).status).toBe(201);
    const response = await f.request(createRoute, { body: { ...createBody, name: 'other' } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'idempotency_mismatch' } });
    expect(f.store.create).toHaveBeenCalledOnce();
  });

  it.each([['org:service-principals:write'], ['unknown'], ['project:read', 'project:read']])(
    'rejects invalid permissions %j',
    async (...permissions) => {
      const f = await fixture();
      expect((await f.request(createRoute, { body: { ...createBody, permissions } })).status).toBe(
        400,
      );
      noStoreWrites(f);
    },
  );

  it('refuses permissions beyond the live ceiling', async () => {
    const f = await fixture({ livePermissions: ['org:service-principals:write'] });
    expect((await f.request(createRoute, { body: createBody })).status).toBe(403);
    noStoreWrites(f);
  });

  it('paginates and filters by project', async () => {
    const f = await fixture();
    for (const [index, project] of [undefined, PROJECT, PROJECT].entries()) {
      expect(
        (
          await f.request(createRoute, {
            key: `key-${index}`,
            body: { ...createBody, name: `bot-${index}`, ...(project ? { project } : {}) },
          })
        ).status,
      ).toBe(201);
    }
    const first = await f.request(listRoute, {
      path: `/_pb/service-principals?limit=1&project=${PROJECT}`,
    });
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      items: { id: string; projectId: string }[];
      next: string;
    };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.projectId).toBe(PROJECT);
    expect(page.next).toBe(page.items[0]!.id);
    const second = await f.request(listRoute, {
      path: `/_pb/service-principals?limit=1&project=${PROJECT}&after=${page.next}`,
    });
    const last = (await second.json()) as typeof page;
    expect(last.items).toHaveLength(1);
    expect(last.items[0]!.id).not.toBe(page.items[0]!.id);
    expect(last.next).toBeNull();
  });

  it('reads a principal with its ETag', async () => {
    const f = await fixture();
    const response = await f.request(readRoute);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"r3"');
    expect(await response.json()).toMatchObject({ id: ID, name: 'ci' });
  });

  it('answers 404 for an unknown principal', async () => {
    const f = await fixture({ absent: true });
    expect((await f.request(readRoute)).status).toBe(404);
  });

  it('hides project principals from a non-admin and archived project principals from an admin', async () => {
    for (const options of [{ protectedHolder: false }, { projectArchived: true }]) {
      const f = await fixture({ projectId: PROJECT, ...options });
      expect((await f.request(readRoute)).status).toBe(404);
    }
  });

  it('refuses a session that disappeared after authorization', async () => {
    const f = await fixture({ staleSession: true });
    expect((await f.request(createRoute, { body: createBody })).status).toBe(403);
    noStoreWrites(f);
  });
});

describe('creation replay races and validation', () => {
  it.each([
    ['empty', ''],
    ['overlong', 'build bot '.repeat(10) + 'x'],
    ['overlong Unicode', '😀'.repeat(101)],
    ['control character', 'build\u0000bot'],
    ['trailing newline', 'build\nbot\n'],
    ['format character', 'build\u200dbot'],
    ['astral format character', 'build\u{e0001}bot'],
    ['line separator', 'build\u2028bot'],
    ['paragraph separator', 'build\u2029bot'],
    ['lone surrogate', 'build\ud800bot'],
  ])('rejects a name at the schema (%s) without saving a replay', async (_kind, name) => {
    const body = { ...createBody, name };
    expect(createServicePrincipalSpec.api.body.safeParse(body).success).toBe(false);
    const f = await fixture();
    const response = await f.request(createRoute, { body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(f.sessions.authenticate).not.toHaveBeenCalled();
    expect(f.authority.livePermissions).not.toHaveBeenCalled();
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(JSON.stringify(body));
    noStoreWrites(f);
    const valid = await f.request(createRoute, { body: createBody });
    expect(valid.status).toBe(201);
    const replay = await f.request(createRoute, { body: createBody });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual(await valid.json());
    expect(f.store.create).toHaveBeenCalledOnce();
  });

  it.each([
    ['broker token', `pb_pat_abcdefghijkl_${'Q'.repeat(43)}`],
    ['URL with userinfo', 'https://deploy:password@broker.example.test/repo'],
    ['high-entropy string', 'a8K2mQ7xR4vN9zB3pL6wT1yH5cD0sF8j'],
  ])('refuses a credential-bearing name (%s) without saving a replay', async (_kind, name) => {
    const f = await fixture();
    const response = await f.request(createRoute, { body: { ...createBody, name } });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'invalid_request' } });
    expect(text).not.toContain(name);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(name);
    noStoreWrites(f);
    expect(f.authority.livePermissions).not.toHaveBeenCalled();
    const valid = await f.request(createRoute, { body: createBody });
    expect(valid.status).toBe(201);
    const replay = await f.request(createRoute, { body: createBody });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual(await valid.json());
    expect(f.store.create).toHaveBeenCalledOnce();
  });

  it.each(['b', 'build bot '.repeat(10), '😀'.repeat(100)])(
    'accepts a safe name of %s at the schema and service',
    async (name) => {
      const body = { ...createBody, name };
      expect(createServicePrincipalSpec.api.body.safeParse(body).success).toBe(true);
      const f = await fixture();
      const response = await f.request(createRoute, { body });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ name });
    },
  );

  it('settles a concurrent loser using the stored winning response', async () => {
    const f = await fixture();
    const winner = await f.request(createRoute, { body: createBody });
    const body = await winner.json();
    f.idempotency.find.mockResolvedValueOnce(null);
    const loser = await f.request(createRoute, { body: createBody });
    expect(loser.status).toBe(201);
    expect(loser.headers.get('idempotent-replayed')).toBe('true');
    expect(await loser.json()).toEqual(body);
    expect(f.store.create).toHaveBeenCalledTimes(2);
    expect(f.audits).toEqual(['service_principal.create']);
  });

  it.each(['?limit=0', '?limit=101', '?after=bad', '?project=bad', '?limit=1&limit=2'])(
    'rejects malformed list query %s before reading rows',
    async (query) => {
      const f = await fixture();
      expect((await f.request(listRoute, { path: listRoute.path + query })).status).toBe(400);
      expect(f.list).not.toHaveBeenCalled();
    },
  );

  it('keeps invalid name data out of errors and logs', async () => {
    const f = await fixture();
    const name = 'request-private-value\u0000';
    const response = await f.request(createRoute, { body: { ...createBody, name } });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('request-private-value');
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('request-private-value');
    noStoreWrites(f);
  });
});
