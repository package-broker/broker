import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '../../authz/engine.js';
import { createAdministration, type Administration } from '../../authz/administration.js';
import { PERMISSIONS } from '../../authz/permissions.js';
import type { GrantRepository, OrganizationGrant } from '../../db/grants.js';
import { orgContext } from '../../db/port.js';
import type { Role, RoleRepository } from '../../db/roles.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { defineApi } from '../route.js';
import { SERVICE_ERROR_TABLE } from '../response.js';
import { ACCESS_API_SPECS, ACCESS_SPECS } from './access-schemas.js';
import { accessRoutes } from './access.js';

const ORIGIN = 'https://broker.test';
const SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const EMAIL = 'sentinel-user@example.test';
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const bearer = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
const serviceBearer = formatToken('svc', 'mnopqrstuvwx', new Uint8Array(32).fill(9));
const clock = fixedClock('2026-10-20T00:00:00.000Z');

const ROLE_ADMIN = '01JA0000000000000000000010';
const ROLE_CUSTOM = '01JA0000000000000000000011';
const ROLE_PROJECT = '01JA0000000000000000000012';
const ROLE_INUSE = '01JA0000000000000000000013';
const ROLE_FOREIGN = '01JA0000000000000000000014';
const ROLE_WIDE = '01JA0000000000000000000015';
const ROLE_ABSENT = '01JA0000000000000000000019';
const GRANT_ADMIN = '01JA0000000000000000000020';
const GRANT_FIRST = '01JA0000000000000000000021';
const GRANT_FOREIGN = '01JA0000000000000000000025';
const GRANT_ABSENT = '01JA0000000000000000000029';

type StoredRole = Role & { readonly orgId: string };
type StoredGrant = OrganizationGrant & { readonly orgId: string };

function role(id: string, patch: Partial<StoredRole> = {}): StoredRole {
  return {
    id,
    key: `key_${id.slice(-2)}`,
    name: 'Role',
    scope: 'organization',
    isSystem: false,
    protectsLastHolder: false,
    revision: 3,
    permissions: ['org:read'],
    orgId: 'org-1',
    ...patch,
  };
}

function grant(id: string, roleId: string, patch: Partial<StoredGrant> = {}): StoredGrant {
  return {
    id,
    subject: { type: 'email', value: `holder-${id.slice(-2)}@example.test` },
    roleId,
    createdBy: 'user-1',
    createdAt: `2026-10-0${Number(id.slice(-1)) + 1}T00:00:00.000Z`,
    revision: 2,
    orgId: 'org-1',
    ...patch,
  };
}

type RouteCase = { method: string; path: string; body?: unknown; write: boolean };
const WRITES: RouteCase[] = [
  {
    method: 'POST',
    path: '/_pb/roles',
    body: { key: 'auditor', name: 'Auditor', scope: 'organization', permissions: ['org:read'] },
    write: true,
  },
  { method: 'PATCH', path: `/_pb/roles/${ROLE_CUSTOM}`, body: { name: 'Renamed' }, write: true },
  { method: 'DELETE', path: `/_pb/roles/${ROLE_CUSTOM}`, write: true },
  {
    method: 'POST',
    path: '/_pb/grants',
    body: { subject: { type: 'email', value: EMAIL }, roleId: ROLE_CUSTOM },
    write: true,
  },
  {
    method: 'PATCH',
    path: `/_pb/grants/${GRANT_FIRST}`,
    body: { roleId: ROLE_CUSTOM },
    write: true,
  },
  { method: 'DELETE', path: `/_pb/grants/${GRANT_FIRST}`, write: true },
];
const IF_MATCH_ROUTES = WRITES.filter(({ method }) => method !== 'POST');

async function fixture(
  options: {
    tokenScope?: 'read' | 'full';
    admin?: boolean;
    projectPermissions?: readonly string[];
    wideRole?: boolean;
    permissions?: readonly string[];
    roleResult?: Partial<Record<'create' | 'rename' | 'setPermissions' | 'delete', string>>;
    grantResult?: Partial<Record<'create' | 'delete' | 'changeRole', string>>;
    tokenKind?: 'pat' | 'svc';
    org?: string;
    extraGrants?: readonly StoredGrant[];
    distinctRoles?: boolean;
  } = {},
) {
  const roles: StoredRole[] = [
    role(ROLE_ADMIN, {
      key: 'organization_admin',
      isSystem: true,
      protectsLastHolder: true,
      revision: 1,
      ...(options.distinctRoles === true
        ? { name: 'Organization Admin', permissions: ['org:grants:read', 'org:read'] }
        : {}),
    }),
    role(
      ROLE_CUSTOM,
      options.distinctRoles === true ? { name: 'Auditor', permissions: ['org:audit:read'] } : {},
    ),
    role(ROLE_PROJECT, { scope: 'project', permissions: ['project:read'], revision: 1 }),
    role(ROLE_INUSE),
    ...(options.wideRole === true ? [role(ROLE_WIDE, { permissions: ['org:audit:read'] })] : []),
    role(ROLE_FOREIGN, { orgId: 'org-2' }),
  ];
  const grants: StoredGrant[] = [
    grant(GRANT_ADMIN, ROLE_ADMIN),
    ...[1, 2, 3, 4].map((n) => grant(`01JA000000000000000000002${n}`, ROLE_CUSTOM)),
    grant('01JA0000000000000000000026', ROLE_INUSE, {
      subject: { type: 'group', provider: 'okta', value: 'engineers' },
    }),
    grant('01JA0000000000000000000027', ROLE_CUSTOM, {
      subject: { type: 'group', provider: 'okta', value: 'ops@example.test' },
    }),
    grant(GRANT_FOREIGN, ROLE_CUSTOM, { orgId: 'org-2' }),
    ...(options.extraGrants ?? []),
  ];
  const visibleRoles = (ctx: { orgId: string }) => roles.filter((r) => r.orgId === ctx.orgId);
  const visibleGrants = (ctx: { orgId: string }) => grants.filter((g) => g.orgId === ctx.orgId);
  const strip = (stored: StoredRole): Role => {
    const { orgId, ...rest } = stored;
    void orgId;
    return rest;
  };
  const stripGrant = (stored: StoredGrant): OrganizationGrant => {
    const { orgId, ...rest } = stored;
    void orgId;
    return rest;
  };

  const roleRepo = {
    list: vi.fn(async (ctx: { orgId: string }) => visibleRoles(ctx).map(strip)),
    get: vi.fn(async (ctx: { orgId: string }, id: string) => {
      const found = visibleRoles(ctx).find((r) => r.id === id);
      return found === undefined ? null : strip(found);
    }),
    create: vi.fn(async (_ctx, _fence, input) => {
      const forced = options.roleResult?.create;
      if (forced !== undefined) return forced;
      if (roles.some((r) => r.key === input.key)) return 'duplicate_key';
      return 'created';
    }),
    rename: vi.fn(async (ctx: { orgId: string }, fence, input) => {
      const forced = options.roleResult?.rename;
      if (forced !== undefined) return forced;
      const found = visibleRoles(ctx).find((r) => r.id === input.id);
      if (found === undefined) return 'not_found';
      if (fence.expected['role'] !== found.revision) return 'conflict';
      if (found.protectsLastHolder) return 'locked';
      return 'renamed';
    }),
    setPermissions: vi.fn(async (ctx: { orgId: string }, fence, input) => {
      const forced = options.roleResult?.setPermissions;
      if (forced !== undefined) return forced;
      const found = visibleRoles(ctx).find((r) => r.id === input.id);
      if (found === undefined) return 'not_found';
      if (fence.expected['role'] !== found.revision) return 'conflict';
      return 'updated';
    }),
    delete: vi.fn(async (ctx: { orgId: string }, fence, input) => {
      const forced = options.roleResult?.delete;
      if (forced !== undefined) return forced;
      const found = visibleRoles(ctx).find((r) => r.id === input.id);
      if (found === undefined) return 'not_found';
      if (fence.expected['role'] !== found.revision) return 'conflict';
      if (found.isSystem) return 'system';
      if (grants.some((g) => g.roleId === found.id)) return 'in_use';
      return 'deleted';
    }),
  } as unknown as RoleRepository & {
    create: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    setPermissions: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  const grantRepo = {
    listOrganization: vi.fn(async (ctx: { orgId: string }) => visibleGrants(ctx).map(stripGrant)),
    createOrganization: vi.fn(async (ctx: { orgId: string }, _fence, input) => {
      const forced = options.grantResult?.create;
      if (forced !== undefined) return forced;
      const target = visibleRoles(ctx).find((r) => r.id === input.roleId);
      if (target === undefined || target.scope !== 'organization') return 'role_scope_mismatch';
      return 'created';
    }),
    deleteOrganization: vi.fn(async (ctx: { orgId: string }, fence, input) => {
      const forced = options.grantResult?.delete;
      if (forced !== undefined) return forced;
      const found = visibleGrants(ctx).find((g) => g.id === input.id);
      if (found === undefined) return 'not_found';
      if (fence.expected['grant'] !== found.revision) return 'conflict';
      const protectedRole = roles.find((r) => r.id === found.roleId)?.protectsLastHolder === true;
      const others = visibleGrants(ctx).filter(
        (g) => g.id !== found.id && roles.find((r) => r.id === g.roleId)?.protectsLastHolder,
      );
      if (protectedRole && others.length === 0) return 'last_holder';
      return { outcome: 'deleted', offboardedUserId: null };
    }),
    changeRole: vi.fn(async (ctx: { orgId: string }, fence, input) => {
      const forced = options.grantResult?.changeRole;
      if (forced !== undefined) return forced;
      const found = visibleGrants(ctx).find((g) => g.id === input.id);
      if (found === undefined) return 'not_found';
      if (fence.expected['grant'] !== found.revision) return 'conflict';
      return 'updated';
    }),
    isProtectedHolder: vi.fn(async () => false),
  } as unknown as GrantRepository & {
    createOrganization: ReturnType<typeof vi.fn>;
    deleteOrganization: ReturnType<typeof vi.fn>;
    changeRole: ReturnType<typeof vi.fn>;
  };

  let sequence = 0;
  const ids = { ulid: () => `01JB${String(++sequence).padStart(22, '0')}` };
  const log = vi.fn();
  const administration = createAdministration({
    roles: roleRepo,
    grants: grantRepo,
    users: { get: async () => ({ id: 'user-1' }) } as never,
    providers: { has: (name: string) => name === 'okta' },
    clock,
    ids,
    log,
  });
  const spies = {
    createRole: vi.spyOn(administration, 'createRole'),
    renameRole: vi.spyOn(administration, 'renameRole'),
    setRolePermissions: vi.spyOn(administration, 'setRolePermissions'),
    deleteRole: vi.spyOn(administration, 'deleteRole'),
    grantOrganization: vi.spyOn(administration, 'grantOrganization'),
    revokeOrganizationGrant: vi.spyOn(administration, 'revokeOrganizationGrant'),
    changeGrantRole: vi.spyOn(administration, 'changeGrantRole'),
  };
  const clientIp = vi.fn(() => '203.0.113.7');
  let permissions = options.permissions ?? PERMISSIONS.map((p) => p.name);
  const setPermissions = (next: readonly string[]) => {
    permissions = next;
  };
  const tokenKind = options.tokenKind ?? 'pat';
  const presented = tokenKind === 'svc' ? serviceBearer : bearer;
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: accessRoutes({
      administration: administration as Administration,
      grants: grantRepo,
      clock,
      ids,
      clientIp,
    }),
    ports: { organizations: { get: async () => null }, clock, ids },
    resolveOrg: async () => orgContext(options.org ?? 'org-1'),
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (org) =>
          org.orgId !== 'org-1'
            ? null
            : {
                session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
                user: { id: 'user-1' },
                identity: null,
                protectedHolder: options.admin ?? true,
                project: null,
                organizationPermissions: permissions,
                projectPermissions: options.projectPermissions ?? [],
              },
        lookupToken: async (org) =>
          org.orgId !== 'org-1'
            ? null
            : (Object.defineProperty(
                {
                  token: {
                    id: 'token-1',
                    kind: tokenKind,
                    expired: false,
                    revoked: false,
                    lastUsedAt: null,
                    userId: tokenKind === 'svc' ? null : 'user-1',
                    servicePrincipalId: tokenKind === 'svc' ? 'service-1' : null,
                    bindingOk: true,
                    projectMode: 'all',
                    scope: {
                      level: options.tokenScope ?? 'full',
                      readOnly: options.tokenScope === 'read',
                    },
                  },
                  protectedHolder: options.admin ?? true,
                  principalStatus: 'active',
                  projectVisible: true,
                  validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
                  project: null,
                  organizationPermissions: permissions,
                  projectPermissions: options.projectPermissions ?? [],
                },
                'verifier',
                { value: { secretHash: await hashToken(keyring, 1, presented), pepperVersion: 1 } },
              ) as unknown as EngineTokenAccess),
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
    method: string,
    path: string,
    options: {
      auth?: 'anonymous' | 'token';
      ifMatch?: string | null;
      body?: unknown;
      raw?: string;
    } = {},
  ) => {
    const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' });
    if (options.auth === 'token') headers.set('authorization', `Bearer ${presented}`);
    else if (options.auth !== 'anonymous') {
      headers.set('cookie', `${SESSION_COOKIE}=${SECRET}`);
      headers.set('x-csrf-token', CSRF);
    }
    if (options.ifMatch !== undefined && options.ifMatch !== null) {
      headers.set('if-match', options.ifMatch);
    }
    const body =
      options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    return app.fetch(
      new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body }) }),
    );
  };
  return { request, roleRepo, grantRepo, spies, clientIp, log, setPermissions };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function noWrites(f: Fixture) {
  for (const spy of Object.values(f.spies)) expect(spy).not.toHaveBeenCalled();
  for (const method of [
    f.roleRepo.create,
    f.roleRepo.rename,
    f.roleRepo.setPermissions,
    f.roleRepo.delete,
  ])
    expect(method).not.toHaveBeenCalled();
  for (const method of [
    f.grantRepo.createOrganization,
    f.grantRepo.deleteOrganization,
    f.grantRepo.changeRole,
  ])
    expect(method).not.toHaveBeenCalled();
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

const currentRevision = (route: RouteCase): string =>
  route.path.includes('/grants/') ? '"r2"' : '"r3"';

describe.each(WRITES)('$method $path', (route) => {
  const send = (f: Fixture, options: Parameters<Fixture['request']>[2] = {}) =>
    f.request(route.method, route.path, {
      body: route.body,
      ifMatch: route.method === 'POST' ? null : currentRevision(route),
      ...options,
    });

  it('denies anonymous callers with 401', async () => {
    const f = await fixture();
    expect((await send(f, { auth: 'anonymous' })).status).toBe(401);
    noWrites(f);
  });
  it('denies a caller without write permission with 403', async () => {
    const f = await fixture({ permissions: ['org:roles:read', 'org:grants:read'] });
    expect((await send(f)).status).toBe(403);
    noWrites(f);
  });
  it.each(['read', 'full'] as const)(
    'denies a %s-scope token as session-only',
    async (tokenScope) => {
      const f = await fixture({ tokenScope });
      expect((await send(f, { auth: 'token' })).status).toBe(403);
      noWrites(f);
    },
  );
  it('rejects an unknown body property without echoing it', async () => {
    if (route.body === undefined) return;
    const f = await fixture();
    const response = await send(f, { body: { ...(route.body as object), sentinelProp: 1 } });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('sentinelProp');
    noWrites(f);
  });
});

describe.each(IF_MATCH_ROUTES)('$method $path concurrency', (route) => {
  const send = (f: Fixture, ifMatch: string | null) =>
    f.request(route.method, route.path, { body: route.body, ifMatch });

  it('requires If-Match with 428', async () => {
    const f = await fixture();
    expect((await send(f, null)).status).toBe(428);
    noWrites(f);
  });
  it('rejects a malformed If-Match with 400', async () => {
    const f = await fixture();
    expect((await send(f, '"r1x"')).status).toBe(400);
    noWrites(f);
  });
  it('answers 412 for a stale revision raised by the repository', async () => {
    const f = await fixture();
    const response = await send(f, '"r1"');
    expect(response.status).toBe(412);
    expect(await response.json()).toMatchObject({ error: { code: 'precondition_failed' } });
  });
  it('answers 412 for a stale revision reported by the service', async () => {
    const f = await fixture();
    for (const spy of [
      f.spies.renameRole,
      f.spies.deleteRole,
      f.spies.changeGrantRole,
      f.spies.revokeOrganizationGrant,
    ]) {
      spy.mockResolvedValue({ ok: false, error: 'conflict' });
    }
    expect((await send(f, currentRevision(route))).status).toBe(412);
  });
});

describe('unknown and foreign resources', () => {
  it.each([
    ['PATCH', '/_pb/roles', { name: 'Renamed' }, ROLE_ABSENT, ROLE_FOREIGN],
    ['DELETE', '/_pb/roles', undefined, ROLE_ABSENT, ROLE_FOREIGN],
    ['PATCH', '/_pb/grants', { roleId: ROLE_CUSTOM }, GRANT_ABSENT, GRANT_FOREIGN],
    ['DELETE', '/_pb/grants', undefined, GRANT_ABSENT, GRANT_FOREIGN],
  ])(
    '%s %s answers the same 404 for an absent and a foreign id',
    async (method, base, body, absent, foreign) => {
      const f = await fixture();
      const first = await f.request(method, `${base}/${absent}`, { body, ifMatch: '"r3"' });
      const second = await f.request(method, `${base}/${foreign}`, { body, ifMatch: '"r3"' });
      expect(first.status).toBe(404);
      expect(await normalized(second)).toEqual(await normalized(first));
    },
  );
  it.each([
    ['PATCH', '/_pb/roles', { name: 'Renamed' }],
    ['DELETE', '/_pb/roles', undefined],
    ['PATCH', '/_pb/grants', { roleId: ROLE_CUSTOM }],
    ['DELETE', '/_pb/grants', undefined],
  ])('%s %s rejects a non-ULID id with 400 before any service call', async (method, base, body) => {
    const f = await fixture();
    expect((await f.request(method, `${base}/not-a-ulid`, { body, ifMatch: '"r3"' })).status).toBe(
      400,
    );
    noWrites(f);
  });
});

describe('PATCH /_pb/roles/:role', () => {
  const path = `/_pb/roles/${ROLE_CUSTOM}`;

  it('renames with the current revision and fences on it', async () => {
    const f = await fixture();
    const response = await f.request('PATCH', path, { body: { name: 'Renamed' }, ifMatch: '"r3"' });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    const [org, actor, fence, id, name, call] = f.spies.renameRole.mock.calls[0]!;
    expect(org).toEqual(orgContext('org-1'));
    expect(actor).toMatchObject({ userId: 'user-1', kind: 'organization' });
    expect(fence).toMatchObject({
      userId: 'user-1',
      sessionId: 'session-1',
      expected: { role: 3 },
    });
    expect([id, name]).toEqual([ROLE_CUSTOM, 'Renamed']);
    expect(call.audit).toMatchObject({ sourceIp: '203.0.113.7' });
    expect(f.spies.setRolePermissions).not.toHaveBeenCalled();
  });
  it('sets permissions with the current revision', async () => {
    const f = await fixture();
    const response = await f.request('PATCH', path, {
      body: { permissions: ['org:read'] },
      ifMatch: '"r3"',
    });
    expect(response.status).toBe(204);
    expect(f.spies.setRolePermissions.mock.calls[0]![2]).toMatchObject({ expected: { role: 3 } });
    expect(f.spies.renameRole).not.toHaveBeenCalled();
  });
  it('rejects a body with both name and permissions', async () => {
    const f = await fixture();
    const response = await f.request('PATCH', path, {
      body: { name: 'Renamed', permissions: [] },
      ifMatch: '"r3"',
    });
    expect(response.status).toBe(400);
    noWrites(f);
  });
  it('rejects a body with neither name nor permissions', async () => {
    const f = await fixture();
    expect((await f.request('PATCH', path, { body: {}, ifMatch: '"r3"' })).status).toBe(400);
    noWrites(f);
  });
});

describe('role writes', () => {
  it('creates a role and answers 201 with the new id only', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/roles', {
      body: { key: 'auditor', name: 'Auditor', scope: 'organization', permissions: ['org:read'] },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: expect.stringMatching(/^[0-9A-Z]{26}$/) });
    const [org, actor, fence, input, call] = f.spies.createRole.mock.calls[0]!;
    expect(org).toEqual(orgContext('org-1'));
    expect(actor).toMatchObject({ userId: 'user-1', isOrganizationAdmin: true });
    expect(fence.expected).toEqual({});
    expect(input).toEqual({
      key: 'auditor',
      name: 'Auditor',
      scope: 'organization',
      permissions: ['org:read'],
    });
    expect(call.audit.requestId).toBe(response.headers.get('x-request-id'));
    expect(call.audit.opId).toEqual(expect.any(String));
  });
  it('answers 409 duplicate for an existing key', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/roles', {
      body: { key: 'key_11', name: 'Again', scope: 'organization', permissions: [] },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'duplicate' } });
  });
  it('answers 400 invalid_request for an unknown permission without echoing it', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/roles', {
      body: {
        key: 'auditor',
        name: 'Auditor',
        scope: 'organization',
        permissions: ['org:sentinel-unknown'],
      },
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'invalid_request' } });
    expect(text).not.toContain('sentinel-unknown');
    expect(f.roleRepo.create).not.toHaveBeenCalled();
  });
  it('deletes an unused role with its revision and refuses one in use', async () => {
    const f = await fixture();
    const response = await f.request('DELETE', `/_pb/roles/${ROLE_CUSTOM}`, { ifMatch: '"r3"' });
    expect(response.status).toBe(409);
    const free = await f.request('DELETE', `/_pb/roles/${ROLE_PROJECT}`, { ifMatch: '"r1"' });
    expect(free.status).toBe(204);
    expect(f.spies.deleteRole.mock.calls.at(-1)![2]).toMatchObject({ expected: { role: 1 } });
  });
});

describe('business conflicts on If-Match routes', () => {
  it.each([
    ['system_role', 'DELETE', `/_pb/roles/${ROLE_ADMIN}`, undefined, '"r1"'],
    ['in_use', 'DELETE', `/_pb/roles/${ROLE_INUSE}`, undefined, '"r3"'],
    ['locked', 'PATCH', `/_pb/roles/${ROLE_ADMIN}`, { name: 'Renamed' }, '"r1"'],
  ])('%s answers 409 conflict, not 412', async (_name, method, path, body, ifMatch) => {
    const f = await fixture();
    const response = await f.request(method, path, { body, ifMatch });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
  });
  it.each(['system', 'in_use'])(
    'does not retry after the repository answers %s',
    async (result) => {
      const f = await fixture({ roleResult: { delete: result } });
      await f.request('DELETE', `/_pb/roles/${ROLE_CUSTOM}`, { ifMatch: '"r3"' });
      expect(f.roleRepo.delete).toHaveBeenCalledOnce();
    },
  );
  it('answers 503 unavailable without retry when the outcome is indeterminate', async () => {
    const f = await fixture({ roleResult: { delete: 'indeterminate' } });
    const response = await f.request('DELETE', `/_pb/roles/${ROLE_CUSTOM}`, { ifMatch: '"r3"' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
    expect(f.roleRepo.delete).toHaveBeenCalledOnce();
  });
  it('answers 409 conflict for a conflict on a route without If-Match', async () => {
    const f = await fixture({ roleResult: { create: 'conflict' } });
    const response = await f.request('POST', '/_pb/roles', {
      body: { key: 'auditor', name: 'Auditor', scope: 'organization', permissions: [] },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
  });
});

describe('grants', () => {
  const POST_EMAIL = {
    subject: { type: 'email', value: EMAIL },
    roleId: ROLE_CUSTOM,
  };

  it('creates an e-mail grant without echoing or auditing the address', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/grants', { body: POST_EMAIL });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ id: expect.stringMatching(/^[0-9A-Z]{26}$/) });
    expect(text).not.toContain(EMAIL);
    const input = f.grantRepo.createOrganization.mock.calls[0]![2] as {
      audit: { payloadJson: string };
      subject: unknown;
    };
    expect(input.subject).toEqual({ type: 'email', value: EMAIL });
    expect(JSON.stringify(input.audit)).not.toContain(EMAIL);
  });
  it('creates a group grant', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/grants', {
      body: { subject: { type: 'group', provider: 'okta', value: 'ops' }, roleId: ROLE_CUSTOM },
    });
    expect(response.status).toBe(201);
  });
  it('answers 400 invalid_request for a role of the wrong scope', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/grants', {
      body: { subject: { type: 'email', value: EMAIL }, roleId: ROLE_PROJECT },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(f.grantRepo.createOrganization).not.toHaveBeenCalled();
  });
  it('answers 409 duplicate for an existing subject', async () => {
    const f = await fixture({ grantResult: { create: 'duplicate' } });
    const response = await f.request('POST', '/_pb/grants', { body: POST_EMAIL });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'duplicate' } });
  });
  it('rejects a subject with an unknown type', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/grants', {
      body: { subject: { type: 'sentinel', value: EMAIL }, roleId: ROLE_CUSTOM },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('sentinel');
    noWrites(f);
  });
  it('changes the role of a grant with the grant revision', async () => {
    const f = await fixture();
    const response = await f.request('PATCH', `/_pb/grants/${GRANT_FIRST}`, {
      body: { roleId: ROLE_INUSE },
      ifMatch: '"r2"',
    });
    expect(response.status).toBe(204);
    const [org, actor, fence, id, roleId] = f.spies.changeGrantRole.mock.calls[0]!;
    expect(org).toEqual(orgContext('org-1'));
    expect(actor).toMatchObject({ userId: 'user-1' });
    expect(fence).toMatchObject({ sessionId: 'session-1', expected: { grant: 2 } });
    expect([id, roleId]).toEqual([GRANT_FIRST, ROLE_INUSE]);
  });
  it('answers 400 invalid_request when the replacement role has the wrong scope', async () => {
    const f = await fixture();
    const response = await f.request('PATCH', `/_pb/grants/${GRANT_FIRST}`, {
      body: { roleId: ROLE_PROJECT },
      ifMatch: '"r2"',
    });
    expect(response.status).toBe(400);
    expect(f.grantRepo.changeRole).not.toHaveBeenCalled();
  });
  it('revokes a grant with the grant revision', async () => {
    const f = await fixture();
    const response = await f.request('DELETE', `/_pb/grants/${GRANT_FIRST}`, { ifMatch: '"r2"' });
    expect(response.status).toBe(204);
    expect(f.spies.revokeOrganizationGrant.mock.calls[0]![2]).toMatchObject({
      expected: { grant: 2 },
    });
  });
  it('answers 409 last_holder when revoking the last Organization Admin grant', async () => {
    const f = await fixture();
    const response = await f.request('DELETE', `/_pb/grants/${GRANT_ADMIN}`, { ifMatch: '"r2"' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'last_holder' } });
    expect(f.grantRepo.deleteOrganization).toHaveBeenCalledOnce();
  });
});

type ListedGrant = {
  id: string;
  subject: Record<string, unknown>;
  roleId: string;
  role: { id: string; name: string; permissions: string[] } | null;
};

async function listedGrants(response: Response) {
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(GRANT_FOREIGN);
  expect(text).not.toContain('holder-25@');
  const body = JSON.parse(text) as { items: ListedGrant[]; next: string | null };
  expect(ACCESS_SPECS.listGrants.api.responses[200].safeParse(body).success).toBe(true);
  return new Map(body.items.map((item) => [item.id, item]));
}

describe('grant listing subject visibility', () => {
  it.each([
    ['organization admin', {}],
    ['delegated org:grants:read holder', { admin: false, permissions: ['org:grants:read'] }],
    ['custom role with every permission', { admin: false }],
    [
      'non-admin with project and organization permissions',
      { admin: false, projectPermissions: PERMISSIONS.map((p) => p.name) },
    ],
  ] as const)('returns e-mail and group values to a session of an %s', async (_name, options) => {
    const f = await fixture(options);
    const grants = await listedGrants(await f.request('GET', '/_pb/grants'));
    expect(grants.get(GRANT_FIRST)?.subject).toEqual({
      type: 'email',
      value: 'holder-21@example.test',
      visibility: 'visible',
    });
    expect(grants.get('01JA0000000000000000000026')?.subject).toEqual({
      type: 'group',
      provider: 'okta',
      value: 'engineers',
      visibility: 'visible',
    });
    expect(grants.get('01JA0000000000000000000027')?.subject).toEqual({
      type: 'group',
      provider: 'okta',
      value: 'ops@example.test',
      visibility: 'visible',
    });
  });

  it.each([
    ['read-only admin token', { tokenScope: 'read' }],
    ['full admin token', {}],
    ['non-admin full token', { tokenScope: 'full', admin: false }],
    ['token holding only org:grants:read', { admin: false, permissions: ['org:grants:read'] }],
    ['service token', { tokenKind: 'svc' }],
  ] as const)('redacts every subject value for a %s', async (_name, options) => {
    const f = await fixture(options);
    const response = await f.request('GET', '/_pb/grants', { auth: 'token' });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('@');
    expect(text).not.toContain('engineers');
    expect(text).not.toContain(GRANT_FOREIGN);
    const body = JSON.parse(text) as { items: ListedGrant[] };
    expect(ACCESS_SPECS.listGrants.api.responses[200].safeParse(body).success).toBe(true);
    const subjects = new Map(body.items.map((item) => [item.id, item.subject]));
    expect(subjects.get(GRANT_FIRST)).toEqual({ type: 'email', visibility: 'redacted' });
    expect(subjects.get('01JA0000000000000000000026')).toEqual({
      type: 'group',
      provider: 'okta',
      visibility: 'redacted',
    });
    expect(subjects.get('01JA0000000000000000000027')).toEqual({
      type: 'group',
      provider: 'okta',
      visibility: 'redacted',
    });
  });

  it('denies a session without org:grants:read before reading grants', async () => {
    const f = await fixture({ admin: false, permissions: ['org:read', 'org:roles:read'] });
    const response = await f.request('GET', '/_pb/grants');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('@');
    expect(f.grantRepo.listOrganization).not.toHaveBeenCalled();
  });

  it('denies a session of another organization before reading grants', async () => {
    const f = await fixture({ org: 'org-2' });
    for (const auth of [undefined, 'token'] as const) {
      const response = await f.request('GET', '/_pb/grants', auth === undefined ? {} : { auth });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('@');
    }
    expect(f.grantRepo.listOrganization).not.toHaveBeenCalled();
  });

  it('stops returning values on the request after org:grants:read is removed', async () => {
    const f = await fixture({ admin: false, permissions: ['org:grants:read'] });
    const first = await listedGrants(await f.request('GET', '/_pb/grants'));
    expect(first.get(GRANT_FIRST)?.subject).toMatchObject({ visibility: 'visible' });
    f.setPermissions(['org:read']);
    const second = await f.request('GET', '/_pb/grants');
    expect(second.status).toBe(403);
    expect(await second.text()).not.toContain('@');
    expect(f.grantRepo.listOrganization).toHaveBeenCalledOnce();
  });

  it('keeps list responses out of logs and makes no audit-producing write', async () => {
    const f = await fixture();
    expect((await f.request('GET', '/_pb/grants')).status).toBe(200);
    expect(f.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'http.request', status: 200 }),
    );
    vi.spyOn(f.grantRepo, 'listOrganization').mockRejectedValueOnce(new Error(EMAIL));
    const failure = await f.request('GET', '/_pb/grants');
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain('@');
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('@');
    noWrites(f);
  });

  it('declares a value exactly when the subject is visible', () => {
    const parse = (subject: unknown) =>
      ACCESS_SPECS.listGrants.api.responses[200].safeParse({
        items: [
          {
            id: GRANT_FIRST,
            subject,
            roleId: ROLE_CUSTOM,
            role: null,
            createdAt: '2026-10-01T00:00:00.000Z',
            revision: 2,
          },
        ],
        next: null,
      }).success;
    expect(parse({ type: 'email', value: EMAIL, visibility: 'visible' })).toBe(true);
    expect(parse({ type: 'email', visibility: 'redacted' })).toBe(true);
    expect(parse({ type: 'email', value: EMAIL, visibility: 'redacted' })).toBe(false);
    expect(parse({ type: 'email', visibility: 'visible' })).toBe(false);
    expect(parse({ type: 'email', value: EMAIL })).toBe(false);
    expect(parse({ type: 'group', provider: 'okta', value: 'ops', visibility: 'redacted' })).toBe(
      false,
    );
  });
});

describe('grant listing role summary', () => {
  it('resolves system and custom roles of the organization under org:grants:read alone', async () => {
    const f = await fixture({
      admin: false,
      permissions: ['org:grants:read'],
      distinctRoles: true,
    });
    const grants = await listedGrants(await f.request('GET', '/_pb/grants'));
    expect(grants.get(GRANT_ADMIN)?.role).toEqual({
      id: ROLE_ADMIN,
      name: 'Organization Admin',
      permissions: ['org:grants:read', 'org:read'],
    });
    expect(grants.get(GRANT_FIRST)?.role).toEqual({
      id: ROLE_CUSTOM,
      name: 'Auditor',
      permissions: ['org:audit:read'],
    });
    expect(grants.get('01JA0000000000000000000026')?.role?.id).toBe(ROLE_INUSE);
  });

  it('returns a null role for a missing role or one outside the organization or scope', async () => {
    const f = await fixture({
      extraGrants: [
        grant('01JA000000000000000000002A', ROLE_ABSENT),
        grant('01JA000000000000000000002B', ROLE_FOREIGN),
        grant('01JA000000000000000000002C', ROLE_PROJECT),
      ],
    });
    const grants = await listedGrants(await f.request('GET', '/_pb/grants'));
    expect(grants.get('01JA000000000000000000002A')).toMatchObject({
      roleId: ROLE_ABSENT,
      role: null,
    });
    expect(grants.get('01JA000000000000000000002B')).toMatchObject({
      roleId: ROLE_FOREIGN,
      role: null,
    });
    expect(grants.get('01JA000000000000000000002C')).toMatchObject({
      roleId: ROLE_PROJECT,
      role: null,
    });
  });

  it('returns the role summary to tokens as well', async () => {
    const f = await fixture({ tokenScope: 'read' });
    const grants = await listedGrants(await f.request('GET', '/_pb/grants', { auth: 'token' }));
    expect(grants.get(GRANT_FIRST)?.role).toEqual({
      id: ROLE_CUSTOM,
      name: 'Role',
      permissions: ['org:read'],
    });
  });
});

describe('non-admin writers', () => {
  const limited = ['org:roles:write', 'org:grants:write', 'org:read'];
  it('cannot revoke a grant of a protects-last-holder role', async () => {
    const f = await fixture({ admin: false, wideRole: true, permissions: limited });
    const response = await f.request('DELETE', `/_pb/grants/${GRANT_ADMIN}`, { ifMatch: '"r2"' });
    expect(response.status).toBe(403);
    expect(f.grantRepo.deleteOrganization).not.toHaveBeenCalled();
  });
  it('cannot move a grant to a role beyond its own permissions', async () => {
    const f = await fixture({ admin: false, wideRole: true, permissions: limited });
    const response = await f.request('PATCH', `/_pb/grants/${GRANT_FIRST}`, {
      body: { roleId: ROLE_WIDE },
      ifMatch: '"r2"',
    });
    expect(response.status).toBe(403);
    expect(f.grantRepo.changeRole).not.toHaveBeenCalled();
  });
  it('cannot change a grant that holds a protects-last-holder role', async () => {
    const f = await fixture({ admin: false, wideRole: true, permissions: limited });
    const response = await f.request('PATCH', `/_pb/grants/${GRANT_ADMIN}`, {
      body: { roleId: ROLE_CUSTOM },
      ifMatch: '"r2"',
    });
    expect(response.status).toBe(403);
    expect(f.grantRepo.changeRole).not.toHaveBeenCalled();
  });
  it('cannot delete a role beyond its own permissions', async () => {
    const f = await fixture({ admin: false, wideRole: true, permissions: limited });
    const response = await f.request('DELETE', `/_pb/roles/${ROLE_WIDE}`, { ifMatch: '"r3"' });
    expect(response.status).toBe(403);
    expect(f.roleRepo.delete).not.toHaveBeenCalled();
  });
});

it('answers 409 last_holder when demoting the last Organization Admin grant', async () => {
  const f = await fixture({ grantResult: { changeRole: 'last_holder' } });
  const response = await f.request('PATCH', `/_pb/grants/${GRANT_ADMIN}`, {
    body: { roleId: ROLE_CUSTOM },
    ifMatch: '"r2"',
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'last_holder' } });
});

describe('listing', () => {
  it('lists system roles with isSystem true', async () => {
    const f = await fixture();
    const response = await f.request('GET', '/_pb/roles');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Role[]; next: string | null };
    expect(body.next).toBeNull();
    expect(body.items.map((r) => r.id)).toEqual([
      ROLE_ADMIN,
      ROLE_CUSTOM,
      ROLE_PROJECT,
      ROLE_INUSE,
    ]);
    expect(body.items[0]).toEqual({
      id: ROLE_ADMIN,
      key: 'organization_admin',
      name: 'Role',
      scope: 'organization',
      isSystem: true,
      protectsLastHolder: true,
      revision: 1,
      permissions: ['org:read'],
    });
  });
  it('pages roles in id order', async () => {
    const f = await fixture();
    const first = (await (await f.request('GET', '/_pb/roles?limit=3')).json()) as {
      items: Role[];
      next: string | null;
    };
    expect(first.items).toHaveLength(3);
    expect(first.next).toBe(first.items[2]!.id);
    const second = (await (
      await f.request('GET', `/_pb/roles?limit=3&after=${first.next}`)
    ).json()) as { items: Role[]; next: string | null };
    expect(second.items.map((r) => r.id)).toEqual([ROLE_INUSE]);
    expect(second.next).toBeNull();
  });
  it('pages grants without overlap', async () => {
    const f = await fixture();
    const seen: string[] = [];
    let after = '';
    for (let page = 0; page < 5; page += 1) {
      const response = await f.request('GET', `/_pb/grants?limit=2${after}`);
      const body = (await response.json()) as {
        items: {
          id: string;
          subject: unknown;
          roleId: string;
          role: unknown;
          createdAt: string;
          revision: number;
        }[];
        next: string | null;
      };
      expect(body.items.length).toBeLessThanOrEqual(2);
      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'createdAt',
          'id',
          'revision',
          'role',
          'roleId',
          'subject',
        ]);
        expect(seen).not.toContain(item.id);
        seen.push(item.id);
      }
      if (body.next === null) break;
      after = `&after=${body.next}`;
    }
    expect(seen).toEqual([...seen].sort());
    expect(seen).toHaveLength(7);
    expect(seen).not.toContain(GRANT_FOREIGN);
  });
  it.each(['0', '101', 'x', '-1', '1.5'])('rejects limit=%s with 400', async (limit) => {
    const f = await fixture();
    expect((await f.request('GET', `/_pb/grants?limit=${limit}`)).status).toBe(400);
  });
  it('rejects a malformed after cursor with 400', async () => {
    const f = await fixture();
    expect((await f.request('GET', '/_pb/roles?after=nope')).status).toBe(400);
  });
  it('rejects an unknown query parameter with 400', async () => {
    const f = await fixture();
    expect((await f.request('GET', '/_pb/roles?sentinel=1')).status).toBe(400);
  });
  it.each(['/_pb/roles', '/_pb/grants'])('allows a read-scope token on %s', async (path) => {
    const f = await fixture({ tokenScope: 'read' });
    expect((await f.request('GET', path, { auth: 'token' })).status).toBe(200);
  });
  it.each(['/_pb/roles', '/_pb/grants'])('denies %s without the read permission', async (path) => {
    const f = await fixture({ permissions: ['org:read'] });
    expect((await f.request('GET', path)).status).toBe(403);
  });
  it.each(['/_pb/roles', '/_pb/grants'])('denies anonymous callers on %s', async (path) => {
    const f = await fixture();
    expect((await f.request('GET', path, { auth: 'anonymous' })).status).toBe(401);
  });
});

it('exports eight representable route specs without constructing services', () => {
  expect(ACCESS_API_SPECS).toHaveLength(8);
  expect(new Set(ACCESS_API_SPECS.map((spec) => spec.api.operationId)).size).toBe(8);
  for (const spec of ACCESS_API_SPECS) expect(defineApi(spec)).toBe(spec);
});

it('declares If-Match only on role update and delete and grant change and revoke', () => {
  expect(
    ACCESS_API_SPECS.filter((spec) => 'concurrency' in spec).map((spec) => spec.api.operationId),
  ).toEqual(['updateRole', 'deleteRole', 'changeGrant', 'revokeGrant']);
});

describe('service error mapping', () => {
  const cases = Object.entries(SERVICE_ERROR_TABLE.AdminError);
  it.each(cases)(
    'maps %s through the error table on a write without If-Match',
    async (error, mapping) => {
      const f = await fixture();
      f.spies.createRole.mockResolvedValueOnce({ ok: false, error: error as never });
      const response = await f.request('POST', '/_pb/roles', {
        body: { key: 'auditor', name: 'Auditor', scope: 'organization', permissions: [] },
      });
      expect(response.status).toBe(mapping.status);
      expect(await response.json()).toMatchObject({ error: { code: mapping.code } });
    },
  );
  it.each(cases.filter(([error]) => error !== 'conflict'))(
    'maps %s on an If-Match route exactly as the table does',
    async (error, mapping) => {
      const f = await fixture();
      f.spies.deleteRole.mockResolvedValueOnce({ ok: false, error: error as never });
      const response = await f.request('DELETE', `/_pb/roles/${ROLE_CUSTOM}`, { ifMatch: '"r3"' });
      expect(response.status).toBe(mapping.status);
      expect(await response.json()).toMatchObject({ error: { code: mapping.code } });
    },
  );
});
