import { describe, expect, it, vi } from 'vitest';
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
import { SERVICE_PRINCIPAL_API_SPECS } from './service-principals-schemas.js';
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
  const store = {
    get: vi.fn<ServicePrincipalStore['get']>(async () => (options.absent ? null : current)),
    create: vi.fn<ServicePrincipalStore['create']>(),
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
    authority,
    directory: { createdBy: async () => [] },
    clock,
    ids,
    log: () => undefined,
  });
  const setPermissions = vi.spyOn(servicePrincipals, 'setPermissions');
  const suspend = vi.spyOn(servicePrincipals, 'suspend');
  const restore = vi.spyOn(servicePrincipals, 'restore');
  const get = vi.fn<ServicePrincipalStore['get']>(async () => (options.absent ? null : current));
  const clientIp = vi.fn(() => '203.0.113.7');
  const permissions = options.permissions ?? PERMISSIONS.map((p) => p.name);
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: servicePrincipalRoutes({
      servicePrincipals,
      principals: { get },
      clock,
      ids,
      clientIp,
    }),
    ports: { organizations: { get: async () => null }, clock, ids },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log: () => undefined,
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
        log: () => undefined,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (
    route: RouteCase,
    options: {
      auth?: 'anonymous' | 'token';
      ifMatch?: string | null;
      body?: unknown;
      path?: string;
    } = {},
  ) => {
    const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' });
    if (options.auth === 'token') headers.set('authorization', `Bearer ${bearer}`);
    else if (options.auth !== 'anonymous') {
      headers.set('cookie', `${SESSION_COOKIE}=${SECRET}`);
      headers.set('x-csrf-token', CSRF);
    }
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
  return { request, get, store, authority, audits, setPermissions, suspend, restore, clientIp };
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

it('exports six representable route specs without constructing services', () => {
  expect(SERVICE_PRINCIPAL_API_SPECS).toHaveLength(6);
  expect(new Set(SERVICE_PRINCIPAL_API_SPECS.map((spec) => spec.api.operationId)).size).toBe(6);
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
