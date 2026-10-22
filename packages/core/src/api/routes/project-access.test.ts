import type { ProjectGrantReader } from '../../db/grants.js';
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
  createProjectAdministration,
  type ProjectGrantStore,
} from '../../authz/project-administration.js';
import type { Role } from '../../db/roles.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { readdirSync, readFileSync } from 'node:fs';
import { defineApi } from '../route.js';
import {
  PROJECT_ACCESS_API_SPECS,
  PROJECT_GRANTS_LIST_API_SPEC,
} from './project-access-schemas.js';
import { projectAccessRoutes } from './project-access.js';

const ORIGIN = 'https://broker.test';
const PROJECT = '01JA0000000000000000000001';
const OTHER_PROJECT = '01JA0000000000000000000002';
const GRANT = '01JA0000000000000000000003';
const ROLE = '01JA0000000000000000000004';
const SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const EMAIL = 'alice@example.test';
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const bearer = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
const clock = fixedClock('2026-10-20T00:00:00.000Z');

const emailBody = { subject: { type: 'email', value: EMAIL }, roleId: ROLE };
const cases = [
  { name: 'POST', method: 'POST', path: '/_pb/projects/demo/grants', body: emailBody },
  {
    name: 'PATCH',
    method: 'PATCH',
    path: `/_pb/projects/demo/grants/${GRANT}`,
    body: { roleId: ROLE },
  },
  { name: 'DELETE', method: 'DELETE', path: `/_pb/projects/demo/grants/${GRANT}`, body: undefined },
] as const;
type RouteCase = { readonly method: string; readonly path: string; readonly body?: unknown };
type GrantPage = Awaited<ReturnType<ProjectGrantReader['list']>>;

async function fixture(
  options: {
    visible?: boolean;
    archived?: boolean;
    tokenScope?: 'read' | 'full';
    admin?: boolean;
    permissions?: readonly string[];
    organizationPermissions?: readonly string[];
    userId?: string;
    grantProject?: string;
    roleAbsent?: boolean;
    create?: Awaited<ReturnType<ProjectGrantStore['create']>>;
    changeRole?: Awaited<ReturnType<ProjectGrantStore['changeRole']>>;
  } = {},
) {
  const audits: string[] = [];
  const grantProject = options.grantProject ?? PROJECT;
  const store = {
    create: vi.fn<ProjectGrantStore['create']>(async (_org, _fence, input) => {
      const answer = options.create ?? 'created';
      if (answer === 'created') audits.push(input.audit.action);
      return answer;
    }),
    changeRole: vi.fn<ProjectGrantStore['changeRole']>(async (_org, _fence, input) => {
      if (input.projectId !== grantProject) return 'not_found';
      const answer = options.changeRole ?? 'updated';
      if (answer === 'updated') audits.push(input.audit.action);
      return answer;
    }),
    delete: vi.fn<ProjectGrantStore['delete']>(async (_org, _fence, input) => {
      if (input.projectId !== grantProject) return 'not_found';
      audits.push(input.audit.action);
      return { status: 'deleted', offboardedUserId: null };
    }),
  };
  let sequence = 0;
  const ids = { ulid: () => `01JB${String(++sequence).padStart(22, '0')}` };
  const projectAdministration = createProjectAdministration({
    grants: store,
    providers: new Map([['github', {}]]),
    providerAnchors: [{ provider: 'github', anchor: 'org', emailAuthoritative: false }],
    clock,
    ids,
    log: () => undefined,
  });
  const grant = vi.spyOn(projectAdministration, 'grant');
  const changeRole = vi.spyOn(projectAdministration, 'changeRole');
  const revoke = vi.spyOn(projectAdministration, 'revoke');
  const roles = {
    get: vi.fn(async () =>
      options.roleAbsent ? null : ({ id: ROLE, revision: 7, scope: 'project' } as unknown as Role),
    ),
  };
  const clientIp = vi.fn(() => '203.0.113.7');
  const permissions = options.permissions ?? PERMISSIONS.map((p) => p.name);
  const authority = options.visible ?? true;
  const resolves = (allowArchived: boolean | undefined) =>
    authority && (options.archived !== true || allowArchived === true);
  const reader = {
    list: vi.fn<ProjectGrantReader['list']>(async (_org, input) => {
      const all = [GRANT, OTHER_PROJECT].sort().map((id) => ({
        id,
        revision: 3,
        createdAt: '2026-10-22T00:00:00.000Z',
        principal: { kind: 'user' as const, id: 'user-2', displayName: 'Member' },
        role: { id: ROLE, name: 'Developer', permissions: ['project:read'] },
      }));
      const remaining = all.filter((row) => input.after === undefined || row.id > input.after);
      const items = remaining.slice(0, input.limit);
      return { items, next: remaining.length > input.limit ? items.at(-1)!.id : null };
    }),
  };
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: projectAccessRoutes({ projectAdministration, roles, reader, clock, ids, clientIp }),
    ports: { organizations: { get: async () => null }, clock, ids },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log: () => undefined,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: options.userId ?? 'user-1' },
          identity: null,
          protectedHolder: options.admin ?? false,
          project:
            input.boundary === 'project' && resolves(input.allowArchived) ? { id: PROJECT } : null,
          organizationPermissions: options.organizationPermissions ?? [],
          projectPermissions:
            input.boundary === 'project' && resolves(input.allowArchived) ? permissions : [],
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
              project:
                input.boundary === 'project' && resolves(input.allowArchived)
                  ? { id: PROJECT }
                  : null,
              organizationPermissions: [],
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
    if (route.method !== 'POST' && options.ifMatch !== null) {
      headers.set('if-match', options.ifMatch ?? '"r3"');
    }
    const body = options.body ?? route.body;
    return app.fetch(
      new Request(ORIGIN + (options.path ?? route.path), {
        method: route.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  };
  return { request, store, roles, reader, audits, grant, changeRole, revoke, clientIp };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

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

function noServiceCalls(f: Fixture) {
  for (const method of [f.grant, f.changeRole, f.revoke]) expect(method).not.toHaveBeenCalled();
  for (const method of [f.store.create, f.store.changeRole, f.store.delete]) {
    expect(method).not.toHaveBeenCalled();
  }
  expect(f.audits).toEqual([]);
}

describe('specs', () => {
  it('declare strict, session-only, boundary-bound routes', () => {
    expect(PROJECT_ACCESS_API_SPECS.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /_pb/projects/:project/grants',
      'PATCH /_pb/projects/:project/grants/:grant',
      'DELETE /_pb/projects/:project/grants/:grant',
    ]);
    for (const spec of PROJECT_ACCESS_API_SPECS) {
      expect(() => defineApi(spec)).not.toThrow();
      expect(spec.boundary).toBe('project');
      expect(spec.permission).toBe('project:grants:write');
      expect(PERMISSIONS.find((p) => p.name === spec.permission)?.sessionOnly).toBe(true);
    }
  });
});

describe.each(cases)('$name $path', (route) => {
  it.each(['read', 'full'] as const)('denies a %s-scope token', async (tokenScope) => {
    const f = await fixture({ tokenScope });
    expect((await f.request(route, { auth: 'token' })).status).toBe(403);
    noServiceCalls(f);
  });

  it('denies anonymous credentials', async () => {
    const f = await fixture();
    expect((await f.request(route, { auth: 'anonymous' })).status).toBe(401);
    noServiceCalls(f);
  });

  it('answers 403 on a visible project without project:grants:write', async () => {
    const f = await fixture({ permissions: ['project:read', 'project:grants:read'] });
    expect((await f.request(route)).status).toBe(403);
    noServiceCalls(f);
  });

  it('answers 404 on a project the caller cannot see', async () => {
    const f = await fixture({ visible: false });
    expect((await f.request(route)).status).toBe(404);
    noServiceCalls(f);
  });
});

describe('POST /_pb/projects/:project/grants', () => {
  const post = cases[0];

  it('gives identical 404 bodies for foreign, absent and archived projects', async () => {
    const results = [];
    for (const slug of ['foreign', 'absent', 'archived']) {
      const f = await fixture({ visible: false });
      results.push(
        await normalized(await f.request(post, { path: `/_pb/projects/${slug}/grants` })),
      );
    }
    expect(results[0]!.status).toBe(404);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('answers the uniform 404 for an archived project even with full authority', async () => {
    const archived = await fixture({ archived: true });
    const absent = await fixture({ visible: false });
    const response = await normalized(await archived.request(post));
    expect(response.status).toBe(404);
    expect(response).toEqual(await normalized(await absent.request(post)));
    noServiceCalls(archived);
  });

  it('rejects a projectId in the body as an unknown property', async () => {
    const f = await fixture();
    const response = await f.request(post, { body: { ...emailBody, projectId: OTHER_PROJECT } });
    expect(response.status).toBe(400);
    noServiceCalls(f);
  });

  it('rejects an unknown property inside the subject', async () => {
    const f = await fixture();
    const body = { subject: { type: 'email', value: EMAIL, extra: 1 }, roleId: ROLE };
    expect((await f.request(post, { body })).status).toBe(400);
    noServiceCalls(f);
  });

  it('rejects a non-ULID role id', async () => {
    const f = await fixture();
    expect((await f.request(post, { body: { ...emailBody, roleId: 'admin' } })).status).toBe(400);
    noServiceCalls(f);
  });

  it('uses the resolved project, not the path slug', async () => {
    const f = await fixture();
    const response = await f.request(post, { path: '/_pb/projects/something-else/grants' });
    expect(response.status).toBe(201);
    const call = f.grant.mock.calls[0]!;
    expect(call[3]).toBe(PROJECT);
    expect(call[1]).toMatchObject({ kind: 'project', projectId: PROJECT, userId: 'user-1' });
    expect(f.store.create.mock.calls[0]![2].projectId).toBe(PROJECT);
  });

  it('answers 201 with only the id and never echoes the e-mail', async () => {
    const f = await fixture();
    const response = await f.request(post);
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ id: expect.stringMatching(/^[0-9A-Z]{26}$/) });
    expect(text).not.toContain('@');
    expect(text).not.toContain(EMAIL);
  });

  it('forwards organization, actor, fence and audit context', async () => {
    const f = await fixture();
    const response = await f.request(post);
    const call = f.grant.mock.calls[0]!;
    expect(call[0]).toEqual(orgContext('org-1'));
    expect(call[1]).toMatchObject({ kind: 'project', orgId: 'org-1' });
    expect(call[1].permissions.has('project:grants:write')).toBe(true);
    expect(call[2]).toEqual({ userId: 'user-1', sessionId: 'session-1', expected: {} });
    expect(call[4]).toEqual({ subject: { type: 'email', value: EMAIL }, roleId: ROLE });
    expect(call.at(-1)).toEqual({
      audit: {
        opId: expect.any(String),
        requestId: response.headers.get('x-request-id'),
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
    });
    expect(f.audits).toEqual(['project_grant.create']);
  });

  it('accepts a group subject', async () => {
    const f = await fixture();
    const body = { subject: { type: 'group', provider: 'github', value: 'team-a' }, roleId: ROLE };
    expect((await f.request(post, { body })).status).toBe(201);
    expect(f.grant.mock.calls[0]![4].subject).toEqual({
      type: 'group',
      provider: 'github',
      value: 'team-a',
    });
  });

  it('answers 409 duplicate for a duplicate subject', async () => {
    const f = await fixture({ create: 'duplicate' });
    const response = await f.request(post);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('"duplicate"');
  });

  it('answers 400 for role_scope_mismatch', async () => {
    const f = await fixture({ create: 'role_scope_mismatch' });
    expect((await f.request(post)).status).toBe(400);
  });

  it('answers a generic 403 when the grant would exceed the actor', async () => {
    const f = await fixture({ create: 'forbidden' });
    const response = await f.request(post);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('@');
    expect(f.audits).toEqual([]);
  });

  it('derives the actor from organization-scope grants and the session user', async () => {
    const f = await fixture({
      permissions: [],
      organizationPermissions: ['project:grants:write', 'org:users:write', 'org:grants:write'],
      userId: 'user-2',
    });
    expect((await f.request(post)).status).toBe(201);
    const actor = f.grant.mock.calls[0]![1];
    expect(actor.userId).toBe('user-2');
    expect(f.grant.mock.calls[0]![2].userId).toBe('user-2');
    expect(actor.permissions.has('project:grants:write')).toBe(true);
    expect([...actor.permissions].filter((name) => name.startsWith('org:'))).toEqual([]);
    expect(actor.permissions.has('org:users:write')).toBe(false);
  });

  it('answers 503 when the outcome is indeterminate', async () => {
    const f = await fixture({ create: 'indeterminate' });
    expect((await f.request(post)).status).toBe(503);
  });
});

describe('PATCH /_pb/projects/:project/grants/:grant', () => {
  const patch = cases[1];

  it('answers 404 for an archived project: only revoke opts in', async () => {
    const f = await fixture({ archived: true });
    expect((await f.request(patch)).status).toBe(404);
    noServiceCalls(f);
  });

  it('answers 428 without If-Match', async () => {
    const f = await fixture();
    expect((await f.request(patch, { ifMatch: null })).status).toBe(428);
    noServiceCalls(f);
  });

  it('answers 412 for a stale revision', async () => {
    const f = await fixture({ changeRole: 'conflict' });
    expect((await f.request(patch)).status).toBe(412);
    expect(f.audits).toEqual([]);
  });

  it('answers 204 and fences the grant and role revisions', async () => {
    const f = await fixture();
    const response = await f.request(patch);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    const call = f.changeRole.mock.calls[0]!;
    expect(call[2]).toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
      expected: { [`access_grant:${GRANT}`]: 3, [`role:${ROLE}`]: 7 },
    });
    expect(call[1]).toMatchObject({ kind: 'project', projectId: PROJECT });
    expect(call[3]).toBe(PROJECT);
    expect(call[4]).toBe(GRANT);
    expect(call[5]).toBe(ROLE);
    expect(f.roles.get).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), ROLE);
    expect(f.audits).toEqual(['project_grant.role_change']);
  });

  it('answers 400 for an unknown role without calling the service', async () => {
    const f = await fixture({ roleAbsent: true });
    expect((await f.request(patch)).status).toBe(400);
    noServiceCalls(f);
  });

  it('answers 400 for role_scope_mismatch', async () => {
    const f = await fixture({ changeRole: 'role_scope_mismatch' });
    expect((await f.request(patch)).status).toBe(400);
  });

  it('answers 403 when the replacement role exceeds the actor', async () => {
    const f = await fixture({ changeRole: 'forbidden' });
    expect((await f.request(patch)).status).toBe(403);
    expect(f.audits).toEqual([]);
  });

  it('rejects a projectId in the body', async () => {
    const f = await fixture();
    expect((await f.request(patch, { body: { roleId: ROLE, projectId: PROJECT } })).status).toBe(
      400,
    );
    noServiceCalls(f);
  });

  it('rejects a non-ULID grant id before any lookup', async () => {
    const f = await fixture();
    const path = `/_pb/projects/demo/grants/${'Z'.repeat(26)}`;
    expect((await f.request(patch, { path })).status).toBe(400);
    noServiceCalls(f);
    expect(f.roles.get).not.toHaveBeenCalled();
  });

  it('hides a grant of another project like an absent grant', async () => {
    const foreign = await fixture({ grantProject: OTHER_PROJECT });
    const response = await normalized(await foreign.request(patch));
    expect(response.status).toBe(404);
    const absent = await fixture({ changeRole: 'not_found' });
    expect(response).toEqual(await normalized(await absent.request(patch)));
  });
});

describe('DELETE /_pb/projects/:project/grants/:grant', () => {
  const del = cases[2];

  it('answers 204 for an archived project the caller holds project:grants:write on', async () => {
    const f = await fixture({ archived: true });
    const response = await f.request(del);
    expect(response.status).toBe(204);
    expect(f.audits).toEqual(['project_grant.revoke']);
    expect(f.revoke.mock.calls[0]![3]).toBe(PROJECT);
  });

  it('still answers 403 on an archived project without project:grants:write', async () => {
    const f = await fixture({ archived: true, permissions: ['project:read'] });
    expect((await f.request(del)).status).toBe(403);
    noServiceCalls(f);
  });

  it('answers 403 to a bearer token on an archived project without calling the service', async () => {
    const f = await fixture({ archived: true });
    expect((await f.request(del, { auth: 'token' })).status).toBe(403);
    noServiceCalls(f);
  });

  it('answers 404 on an archived project the caller has no authority over', async () => {
    const f = await fixture({ archived: true, visible: false });
    expect((await f.request(del)).status).toBe(404);
    noServiceCalls(f);
  });

  it('answers 428 without If-Match', async () => {
    const f = await fixture();
    expect((await f.request(del, { ifMatch: null })).status).toBe(428);
    noServiceCalls(f);
  });

  it('answers 400 for a malformed If-Match', async () => {
    const f = await fixture();
    expect((await f.request(del, { ifMatch: 'W/"x"' })).status).toBe(400);
    noServiceCalls(f);
  });

  it('answers 204, fences the grant revision and audits the revoke', async () => {
    const f = await fixture();
    const response = await f.request(del);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    const call = f.revoke.mock.calls[0]!;
    expect(call[2]).toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
      expected: { [`access_grant:${GRANT}`]: 3 },
    });
    expect(call[3]).toBe(PROJECT);
    expect(call[4]).toBe(GRANT);
    expect(f.audits).toEqual(['project_grant.revoke']);
  });

  it('answers 404 for a grant of another project, identical to an absent grant', async () => {
    const foreign = await fixture({ grantProject: OTHER_PROJECT });
    const response = await normalized(await foreign.request(del));
    expect(response.status).toBe(404);
    expect(foreign.audits).toEqual([]);
    const absent = await fixture({ visible: true, grantProject: '01JA0000000000000000000009' });
    expect(response).toEqual(await normalized(await absent.request(del)));
  });

  it('answers 412 for a stale revision', async () => {
    const f = await fixture();
    f.store.delete.mockResolvedValueOnce('conflict');
    expect((await f.request(del)).status).toBe(412);
    expect(f.audits).toEqual([]);
  });

  it('answers 403 when the holder may not be removed', async () => {
    const f = await fixture();
    f.store.delete.mockResolvedValueOnce('forbidden');
    expect((await f.request(del)).status).toBe(403);
    expect(f.audits).toEqual([]);
  });
});

describe('response bodies never contain an e-mail address', () => {
  it('holds for success and every error answer', async () => {
    const outcomes = [
      { create: 'created' },
      { create: 'duplicate' },
      { create: 'role_scope_mismatch' },
      { create: 'forbidden' },
      { create: 'conflict' },
      { create: 'indeterminate' },
      { visible: false },
    ] as const;
    for (const options of outcomes) {
      const f = await fixture(options);
      const response = await f.request(cases[0]);
      expect(await response.text()).not.toContain('@');
    }
  });
});

describe('allowArchived registry', () => {
  const deps = {
    projectAdministration: {} as never,
    roles: { get: async () => null },
    reader: { list: async () => ({ items: [], next: null }) },
    clock,
    ids: { ulid: () => '01JB0000000000000000000001' },
    clientIp: () => null,
  };

  it('is set on exactly the revoke route of the project access routes', () => {
    const flagged = projectAccessRoutes(deps)
      .filter((route) => route.allowArchived === true)
      .map((route) => (route.api as { operationId: string }).operationId);
    expect(flagged).toEqual(['revokeProjectGrant']);
  });

  it('is declared by the revoke spec alone', () => {
    const flagged = PROJECT_ACCESS_API_SPECS.filter(
      (spec) => 'allowArchived' in spec && spec.allowArchived === true,
    ).map((spec) => spec.api.operationId);
    expect(flagged).toEqual(['revokeProjectGrant']);
  });

  it('appears in no other core route module', () => {
    const dir = new URL('./', import.meta.url);
    const users = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => readFileSync(new URL(name, dir), 'utf8').includes('allowArchived'))
      .sort();
    expect(users).toEqual(['project-access-schemas.ts']);
  });
});

describe('GET project grants', () => {
  const read = { method: 'GET', path: '/_pb/projects/demo/grants' } as RouteCase;

  it('paginates by grant id and supplies a stable ETag', async () => {
    const f = await fixture({ permissions: ['project:read', 'project:grants:read'] });
    const first = await f.request(read, { path: read.path + '?limit=1' });
    expect(first.status).toBe(200);
    const page = (await first.json()) as GrantPage;
    expect(page.items).toHaveLength(1);
    expect(page.next).toBe(page.items[0]!.id);
    expect(page.items[0]).toMatchObject({
      principal: { kind: 'user', displayName: 'Member' },
      role: { permissions: ['project:read'] },
    });
    expect(first.headers.get('etag')).toMatch(/^"r[1-9][0-9]*"$/);
    const again = await f.request(read, { path: read.path + '?limit=1' });
    expect(again.headers.get('etag')).toBe(first.headers.get('etag'));
    const second = await f.request(read, { path: read.path + '?limit=1&after=' + page.next });
    expect(second.status).toBe(200);
    const last = (await second.json()) as GrantPage;
    expect(last.items).toHaveLength(1);
    expect(last.items[0]!.id).not.toBe(page.items[0]!.id);
    expect(last.next).toBeNull();
    expect(f.reader.list.mock.calls[0]![1].projectId).toBe(PROJECT);
  });

  it('denies a visible project without permission before reading grants', async () => {
    const f = await fixture({ permissions: ['project:read'] });
    expect((await f.request(read)).status).toBe(403);
    expect(f.reader.list).not.toHaveBeenCalled();
  });

  it('hides a project before reading grants', async () => {
    const f = await fixture({ visible: false });
    expect((await f.request(read)).status).toBe(404);
    expect(f.reader.list).not.toHaveBeenCalled();
  });

  it('rejects an invalid cursor without reading grants', async () => {
    const f = await fixture({ permissions: ['project:read', 'project:grants:read'] });
    expect((await f.request(read, { path: read.path + '?after=bad' })).status).toBe(400);
    expect(f.reader.list).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  'project grant reads derive e-mail disclosure from organization admin authority (%s)',
  async (admin) => {
    const f = await fixture({ admin });
    const response = await f.request({
      method: 'GET',
      path: '/_pb/projects/demo/grants',
    } as RouteCase);
    expect(response.status).toBe(200);
    expect(f.reader.list).toHaveBeenCalledWith(
      orgContext('org-1'),
      expect.objectContaining({ includeEmail: admin }),
    );
  },
);

it('changes the grant list ETag when the returned grant revision changes', async () => {
  const f = await fixture();
  const read = { method: 'GET', path: '/_pb/projects/demo/grants' } as RouteCase;
  const before = await f.request(read);
  const page = (await before.json()) as GrantPage;
  f.reader.list.mockResolvedValueOnce({
    ...page,
    items: page.items.map((item) => ({
      ...item,
      revision: item.revision + 1,
    })),
  });
  const after = await f.request(read);
  expect(after.status).toBe(200);
  expect(after.headers.get('etag')).not.toBe(before.headers.get('etag'));
});

it('declares the project grants read contract', () => {
  expect(() => defineApi(PROJECT_GRANTS_LIST_API_SPEC)).not.toThrow();
  expect(PROJECT_GRANTS_LIST_API_SPEC.permission).toBe('project:grants:read');
});

it('hides an archived project without querying grants', async () => {
  const f = await fixture({ archived: true });
  expect((await f.request({ method: 'GET', path: '/_pb/projects/demo/grants' })).status).toBe(404);
  expect(f.reader.list).not.toHaveBeenCalled();
});

it('returns an empty terminal grant page', async () => {
  const f = await fixture();
  const response = await f.request({
    method: 'GET',
    path: '/_pb/projects/demo/grants?after=' + GRANT,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ items: [], next: null });
});
