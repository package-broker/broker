import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '../../authz/engine.js';
import { PERMISSIONS } from '../../authz/permissions.js';
import type { ProjectLister } from '../../authz/project-list.js';
import {
  createProjectService,
  type ProjectService,
  type ProjectStore,
} from '../../authz/project-service.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import type { IdempotencyRecord } from '../idempotency.js';
import { PROJECT_API_SPECS } from './projects-schemas.js';
import { projectRoutes } from './projects.js';

const ORIGIN = 'https://broker.test';
const PROJECT = '01JA0000000000000000000001';
const OTHER = '01JA0000000000000000000002';
const STRAY = '01JA0000000000000000000003';
const SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const bearer = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
const serviceBearer = formatToken('svc', 'mnopqrstuvwx', new Uint8Array(32).fill(9));
const clock = fixedClock('2026-10-19T00:00:00.000Z');
const ALL = PERMISSIONS.map((p) => p.name);

interface StoredProject {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: 'active' | 'archived';
  readonly tokenMaxScope: 'read' | 'write' | 'full';
  readonly requirePublishApproval: boolean;
  readonly revision: number;
}

const PROJECT_ROW: StoredProject = {
  id: PROJECT,
  slug: 'demo',
  name: 'Demo',
  status: 'active',
  tokenMaxScope: 'full',
  requirePublishApproval: false,
  revision: 7,
};

async function fixture(
  options: {
    permissions?: readonly string[];
    tokenScope?: 'read' | 'full';
    projectMode?: 'all' | 'selected';
    tokenKind?: 'pat' | 'service';
    boundProjectIds?: readonly string[];
    protectedHolder?: boolean;
    inheritsProjectRead?: boolean;
    projectVisible?: boolean;
    row?: StoredProject | null;
    storeAnswer?: Partial<Record<'create' | 'update' | 'archive' | 'restore', string>>;
    listed?: Awaited<ReturnType<ProjectLister['list']>>;
  } = {},
) {
  const audits: string[] = [];
  const created: string[] = [];
  const idempotency = new Map<string, IdempotencyRecord>();
  const slugs = new Set<string>();
  const rows = new Map<string, StoredProject>();
  const answer = (name: 'create' | 'update' | 'archive' | 'restore', ok: string) =>
    options.storeAnswer?.[name] ?? ok;
  const slotOf = (record: IdempotencyRecord): string => `${record.principalKey}|${record.key}`;
  const claim = (record: IdempotencyRecord | undefined): void => {
    if (record !== undefined) idempotency.set(slotOf(record), record);
  };
  const store = {
    create: vi.fn<ProjectStore['create']>(async (_org, _fence, input) => {
      const forced = options.storeAnswer?.create;
      if (forced !== undefined) return forced as 'duplicate';
      if (input.idempotency !== undefined && idempotency.has(slotOf(input.idempotency))) {
        return 'conflict';
      }
      if (slugs.has(input.slug)) return 'duplicate';
      claim(input.idempotency);
      slugs.add(input.slug);
      created.push(input.id);
      rows.set(input.slug, { ...PROJECT_ROW, id: input.id, slug: input.slug, name: input.name });
      audits.push(input.audit.action);
      return 'created';
    }),
    update: vi.fn<ProjectStore['update']>(async (_org, _fence, input) => {
      const result = answer('update', 'updated');
      if (result === 'updated') audits.push(input.audit.action);
      return result as 'updated';
    }),
    archive: vi.fn<ProjectStore['archive']>(async (_org, _fence, input) => {
      const result = answer('archive', 'archived');
      if (result === 'archived') audits.push(input.audit.action);
      return result as 'archived';
    }),
    restore: vi.fn<ProjectStore['restore']>(async (_org, _fence, input) => {
      const result = answer('restore', 'restored');
      if (result === 'restored') audits.push(input.audit.action);
      return result as 'restored';
    }),
  };
  let sequence = 0;
  const ids = { ulid: () => `01JA${String(++sequence).padStart(22, '0')}` };
  const logged: unknown[] = [];
  const service: ProjectService = createProjectService({
    projects: store,
    clock,
    ids,
    log: (entry) => logged.push(entry),
  });
  const createProject = vi.spyOn(service, 'createProject');
  const updateSettings = vi.spyOn(service, 'updateSettings');
  const archiveProject = vi.spyOn(service, 'archiveProject');
  const restoreProject = vi.spyOn(service, 'restoreProject');
  const row = options.row === undefined ? PROJECT_ROW : options.row;
  const projects = {
    get: vi.fn(async () => row),
    getBySlug: vi.fn(
      async (_org: unknown, slug: string) =>
        rows.get(slug) ?? (row !== null && row.slug === slug ? row : null),
    ),
  };
  const lister: ProjectLister = {
    list: vi.fn(
      async () => options.listed ?? { ok: true as const, value: { items: [], nextAfterId: null } },
    ),
  };
  const idempotencyPort = {
    find: vi.fn(
      async (_org: unknown, principalKey: string, key: string) =>
        idempotency.get(`${principalKey}|${key}`) ?? null,
    ),
  };
  const clientIp = vi.fn(() => '203.0.113.7');
  const permissions = options.permissions ?? ALL;
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: projectRoutes({
      ids,
      clock,
      clientIp,
      lister,
      service,
      projects,
      idempotency: idempotencyPort,
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
          protectedHolder: true,
          project:
            input.boundary === 'project' && options.projectVisible !== false
              ? { id: PROJECT }
              : null,
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
                kind: options.tokenKind === 'service' ? 'svc' : 'pat',
                expired: false,
                revoked: false,
                lastUsedAt: null,
                userId: options.tokenKind === 'service' ? null : 'user-1',
                servicePrincipalId: options.tokenKind === 'service' ? 'svc-1' : null,
                bindingOk: true,
                boundProjectIds: options.boundProjectIds ?? [],
                projectMode: options.projectMode ?? 'all',
                scope: {
                  level: options.tokenScope ?? 'full',
                  readOnly: options.tokenScope === 'read',
                },
              },
              principalStatus: 'active',
              protectedHolder: options.protectedHolder ?? false,
              projectReadInherited: options.inheritsProjectRead ?? false,
              projectVisible: true,
              validation:
                options.tokenKind === 'service'
                  ? null
                  : { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
              project: input.boundary === 'project' ? { id: PROJECT } : null,
              organizationPermissions: permissions,
              projectPermissions: permissions.filter((p) => p.startsWith('project:')),
            },
            'verifier',
            {
              value: {
                secretHash: await hashToken(
                  keyring,
                  1,
                  options.tokenKind === 'service' ? serviceBearer : bearer,
                ),
                pepperVersion: 1,
              },
            },
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
    method: string,
    path: string,
    init: {
      auth?: 'anonymous' | 'token' | 'session';
      ifMatch?: string | null;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const headers = new Headers({ origin: ORIGIN, ...init.headers });
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (init.auth === 'token')
      headers.set(
        'authorization',
        `Bearer ${options.tokenKind === 'service' ? serviceBearer : bearer}`,
      );
    else if (init.auth !== 'anonymous') {
      headers.set('cookie', `${SESSION_COOKIE}=${SECRET}`);
      headers.set('x-csrf-token', CSRF);
    }
    if (init.ifMatch !== undefined && init.ifMatch !== null) headers.set('if-match', init.ifMatch);
    return app.fetch(
      new Request(ORIGIN + path, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  };
  return {
    request,
    store,
    service,
    createProject,
    updateSettings,
    archiveProject,
    restoreProject,
    projects,
    lister,
    idempotencyPort,
    audits,
    created,
    clientIp,
    logged,
  };
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
  for (const method of [f.createProject, f.updateSettings, f.archiveProject, f.restoreProject]) {
    expect(method).not.toHaveBeenCalled();
  }
}

describe('PROJECT_API_SPECS', () => {
  it('declares the six routes with their permissions and boundaries', () => {
    expect(
      PROJECT_API_SPECS.map((s) => [s.method, s.path, s.permission, s.boundary, s.api.operationId]),
    ).toEqual([
      ['GET', '/_pb/projects', null, 'authenticated', 'listProjects'],
      ['POST', '/_pb/projects', 'org:projects:create', 'organization', 'createProject'],
      ['GET', '/_pb/projects/:project', 'project:read', 'project', 'getProject'],
      ['PATCH', '/_pb/projects/:project', 'project:settings:write', 'project', 'updateProject'],
      [
        'POST',
        '/_pb/projects/:project/archive',
        'org:projects:archive',
        'organization',
        'archiveProject',
      ],
      [
        'POST',
        '/_pb/projects/:project/restore',
        'org:projects:archive',
        'organization',
        'restoreProject',
      ],
    ]);
  });
});

describe('GET /_pb/projects', () => {
  const entry = { id: PROJECT, slug: 'demo', name: 'Demo', status: 'active' as const };

  it('answers 401 to an anonymous caller', async () => {
    const f = await fixture();
    expect((await f.request('GET', '/_pb/projects', { auth: 'anonymous' })).status).toBe(401);
    expect(f.lister.list).not.toHaveBeenCalled();
  });

  it('lists a read-scope PAT through the lister with the owner and no org permissions', async () => {
    const f = await fixture({
      tokenScope: 'read',
      listed: { ok: true, value: { items: [entry], nextAfterId: null } },
    });
    const response = await f.request('GET', '/_pb/projects', { auth: 'token' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [entry], next: null });
    const [, actor, request] = vi.mocked(f.lister.list).mock.calls[0]!;
    expect(actor).toMatchObject({ kind: 'organization', userId: 'user-1' });
    expect(actor.isOrganizationAdmin).toBe(false);
    expect([...actor.permissions]).toEqual([]);
    expect(request).not.toHaveProperty('restrictTo');
  });

  it('gives an all-mode PAT the owner project:read inheritance only when the lookup says so', async () => {
    const f = await fixture({ inheritsProjectRead: true });
    await f.request('GET', '/_pb/projects', { auth: 'token' });
    const actor = vi.mocked(f.lister.list).mock.calls[0]![1];
    expect([...actor.permissions]).toEqual(['project:read']);
  });

  it('marks the lister actor of an admin all-mode PAT and forwards the archived status', async () => {
    const f = await fixture({ protectedHolder: true });
    await f.request('GET', '/_pb/projects?status=archived', { auth: 'token' });
    const [, actor, request] = vi.mocked(f.lister.list).mock.calls[0]!;
    expect(actor.isOrganizationAdmin).toBe(true);
    expect(request.status).toBe('archived');
    expect(request).not.toHaveProperty('restrictTo');
  });

  it('does not mark a PAT admin when the lookup does not', async () => {
    const f = await fixture({ protectedHolder: false });
    await f.request('GET', '/_pb/projects?status=archived', { auth: 'token' });
    expect(vi.mocked(f.lister.list).mock.calls[0]![1].isOrganizationAdmin).toBe(false);
  });

  it('narrows a PAT bound to selected projects to those projects', async () => {
    const f = await fixture({
      projectMode: 'selected',
      boundProjectIds: [PROJECT, OTHER],
      listed: { ok: true, value: { items: [entry], nextAfterId: null } },
    });
    const response = await f.request('GET', '/_pb/projects', { auth: 'token' });
    expect(await response.json()).toEqual({ items: [entry], next: null });
    expect(vi.mocked(f.lister.list).mock.calls[0]![2]).toMatchObject({
      restrictTo: [PROJECT, OTHER],
    });
  });

  it('drops a listed project the selected PAT is not bound to', async () => {
    const stray = { ...entry, id: STRAY, slug: 'stray' };
    const f = await fixture({
      projectMode: 'selected',
      boundProjectIds: [PROJECT],
      listed: { ok: true, value: { items: [entry, stray], nextAfterId: null } },
    });
    const response = await f.request('GET', '/_pb/projects', { auth: 'token' });
    expect(await response.json()).toEqual({ items: [entry], next: null });
  });

  it('answers an empty list to a selected PAT with no bound project without asking the lister', async () => {
    const f = await fixture({
      projectMode: 'selected',
      boundProjectIds: [],
      listed: { ok: true, value: { items: [entry], nextAfterId: null } },
    });
    const response = await f.request('GET', '/_pb/projects', { auth: 'token' });
    expect(await response.json()).toEqual({ items: [], next: null });
    expect(f.lister.list).not.toHaveBeenCalled();
  });

  it('never grants a selected PAT the admin flag', async () => {
    const f = await fixture({
      projectMode: 'selected',
      boundProjectIds: [PROJECT],
      protectedHolder: true,
    });
    await f.request('GET', '/_pb/projects?status=archived', { auth: 'token' });
    expect(vi.mocked(f.lister.list).mock.calls[0]![1].isOrganizationAdmin).toBe(false);
  });

  it('answers an empty list to a service token', async () => {
    const f = await fixture({
      tokenKind: 'service',
      listed: { ok: true, value: { items: [entry], nextAfterId: null } },
    });
    const response = await f.request('GET', '/_pb/projects', { auth: 'token' });
    expect(await response.json()).toEqual({ items: [], next: null });
    expect(f.lister.list).not.toHaveBeenCalled();
  });

  it('answers an empty list, not 403, to a caller who may read nothing', async () => {
    const f = await fixture({ permissions: [] });
    const response = await f.request('GET', '/_pb/projects');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], next: null });
  });

  it('builds the lister actor from the session grants', async () => {
    const f = await fixture({ permissions: ['org:read'] });
    await f.request('GET', '/_pb/projects');
    const actor = vi.mocked(f.lister.list).mock.calls[0]![1];
    expect(actor).toMatchObject({ kind: 'organization', userId: 'user-1' });
    expect([...actor.permissions]).toEqual(['org:read']);
  });

  it('forwards the cursor, the limit and the status and answers the next cursor', async () => {
    const after = '01JA0000000000000000000009';
    const f = await fixture({
      listed: { ok: true, value: { items: [entry], nextAfterId: PROJECT } },
    });
    const response = await f.request('GET', `/_pb/projects?limit=2&after=${after}&status=archived`);
    expect(await response.json()).toEqual({ items: [entry], next: PROJECT });
    expect(vi.mocked(f.lister.list).mock.calls[0]![2]).toEqual({
      limit: 2,
      afterId: after,
      status: 'archived',
    });
  });

  it('answers 403 when the lister refuses the status', async () => {
    const f = await fixture({ listed: { ok: false, error: 'forbidden' } });
    expect((await f.request('GET', '/_pb/projects?status=archived')).status).toBe(403);
  });

  it('rejects an unknown status with a pointer and without echoing the value', async () => {
    const f = await fixture();
    const response = await f.request('GET', '/_pb/projects?status=deleted');
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('deleted');
    expect(JSON.parse(text)).toMatchObject({
      error: { details: [expect.objectContaining({ path: '/query/status' })] },
    });
    expect(f.lister.list).not.toHaveBeenCalled();
  });

  it.each(['0', '101', 'x'])('rejects limit=%s', async (limit) => {
    const f = await fixture();
    const response = await f.request('GET', `/_pb/projects?limit=${limit}`);
    expect(response.status).toBe(400);
    expect(f.lister.list).not.toHaveBeenCalled();
  });

  it('rejects a malformed cursor', async () => {
    const f = await fixture();
    expect((await f.request('GET', '/_pb/projects?after=nope')).status).toBe(400);
  });
});

describe('POST /_pb/projects', () => {
  const body = { slug: 'fresh', name: 'Fresh' };

  it('creates a project, audits it and answers 201', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/projects', { body });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: expect.any(String), slug: 'fresh' });
    expect(f.audits).toEqual(['project.create']);
    const call = f.createProject.mock.calls[0]!;
    expect(call[0]).toEqual(orgContext('org-1'));
    expect(call[1]).toMatchObject({ kind: 'organization', userId: 'user-1' });
    expect(call[2]).toEqual({ userId: 'user-1', sessionId: 'session-1', expected: {} });
    expect(call[3]).toEqual(body);
    expect(call[4]).toEqual({
      audit: {
        opId: expect.any(String),
        requestId: response.headers.get('x-request-id'),
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
    });
  });

  it('answers 409 duplicate for a taken slug', async () => {
    const f = await fixture({ storeAnswer: { create: 'duplicate' } });
    const response = await f.request('POST', '/_pb/projects', { body });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'duplicate' } });
  });

  it('answers 400 for a malformed slug', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/projects', {
      body: { slug: 'Not A Slug', name: 'x' },
    });
    expect(response.status).toBe(400);
    expect(f.store.create).not.toHaveBeenCalled();
  });

  it('answers 400 for a reserved slug', async () => {
    const f = await fixture({ storeAnswer: { create: 'reserved_slug' } });
    expect((await f.request('POST', '/_pb/projects', { body })).status).toBe(400);
  });

  it('refuses a body key the schema does not name', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/projects', { body: { ...body, id: PROJECT } });
    expect(response.status).toBe(400);
    noServiceCalls(f);
  });

  it('denies a caller without org:projects:create', async () => {
    const f = await fixture({ permissions: ['org:projects:archive'] });
    expect((await f.request('POST', '/_pb/projects', { body })).status).toBe(403);
    noServiceCalls(f);
  });

  it('denies a token', async () => {
    const f = await fixture();
    expect((await f.request('POST', '/_pb/projects', { auth: 'token', body })).status).toBe(403);
    noServiceCalls(f);
  });

  it('rejects a malformed Idempotency-Key', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/projects', {
      body,
      headers: { 'idempotency-key': 'not valid!' },
    });
    expect(response.status).toBe(400);
    noServiceCalls(f);
  });

  describe('with an Idempotency-Key', () => {
    const headers = { 'idempotency-key': 'key-1' };

    it('answers the replay of the same key and body', async () => {
      const f = await fixture();
      const first = await f.request('POST', '/_pb/projects', { body, headers });
      expect(first.status).toBe(201);
      expect(first.headers.get('idempotent-replayed')).toBeNull();
      const created = (await first.json()) as { id: string; slug: string };
      const second = await f.request('POST', '/_pb/projects', { body, headers });
      expect(second.status).toBe(201);
      expect(second.headers.get('idempotent-replayed')).toBe('true');
      expect(await second.json()).toEqual(created);
      expect(f.created).toHaveLength(1);
      expect(f.audits).toEqual(['project.create']);
    });

    it('stores the created id with the idempotency record and replays it without a slug lookup', async () => {
      const f = await fixture();
      const first = await f.request('POST', '/_pb/projects', { body, headers });
      const created = (await first.json()) as { id: string; slug: string };
      const stored = JSON.parse(
        f.store.create.mock.calls[0]![2].idempotency!.responseJson,
      ) as Record<string, unknown>;
      expect(stored).toEqual({ id: created.id, slug: body.slug });
      f.projects.getBySlug.mockClear();
      const second = await f.request('POST', '/_pb/projects', { body, headers });
      expect(await second.json()).toEqual(created);
      expect(f.projects.getBySlug).not.toHaveBeenCalled();
      expect(f.projects.get).not.toHaveBeenCalled();
    });

    it('replays the stored id even when the slug now belongs to another project', async () => {
      const f = await fixture();
      const first = await f.request('POST', '/_pb/projects', { body, headers });
      const created = (await first.json()) as { id: string; slug: string };
      f.projects.getBySlug.mockResolvedValue({ ...PROJECT_ROW, id: STRAY, slug: body.slug });
      const second = await f.request('POST', '/_pb/projects', { body, headers });
      expect(await second.json()).toEqual(created);
    });

    it('answers 409 idempotency_mismatch for the same key and another body', async () => {
      const f = await fixture();
      await f.request('POST', '/_pb/projects', { body, headers });
      const response = await f.request('POST', '/_pb/projects', {
        body: { slug: 'other', name: 'Other' },
        headers,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'idempotency_mismatch' } });
      expect(f.created).toHaveLength(1);
    });

    it('settles two concurrent creates into one row, one audit row and one replay', async () => {
      const f = await fixture();
      const [a, b] = await Promise.all([
        f.request('POST', '/_pb/projects', { body, headers }),
        f.request('POST', '/_pb/projects', { body, headers }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect([a, b].filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(1);
      expect(await a.json()).toEqual(await b.json());
      expect(f.created).toHaveLength(1);
      expect(f.audits).toEqual(['project.create']);
    });

    it('does not replay a taken slug under another key', async () => {
      const f = await fixture();
      await f.request('POST', '/_pb/projects', { body, headers });
      const response = await f.request('POST', '/_pb/projects', {
        body,
        headers: { 'idempotency-key': 'key-2' },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'duplicate' } });
    });
  });
});

describe('GET /_pb/projects/:project', () => {
  it('answers the project with its revision as ETag', async () => {
    const f = await fixture();
    const response = await f.request('GET', '/_pb/projects/demo');
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"r7"');
    expect(await response.json()).toEqual(PROJECT_ROW);
  });

  it('answers a read-scope token', async () => {
    const f = await fixture({ tokenScope: 'read' });
    expect((await f.request('GET', '/_pb/projects/demo', { auth: 'token' })).status).toBe(200);
  });

  it('answers 401 to an anonymous caller', async () => {
    const f = await fixture();
    expect((await f.request('GET', '/_pb/projects/demo', { auth: 'anonymous' })).status).toBe(401);
  });

  it('answers byte-identical 404s for an invisible project and a missing row', async () => {
    const invisible = await fixture({ projectVisible: false });
    const vanished = await fixture({ row: null });
    const archived = await fixture({ row: { ...PROJECT_ROW, status: 'archived' } });
    const reference = await normalized(await invisible.request('GET', '/_pb/projects/demo'));
    expect(reference.status).toBe(404);
    expect(await normalized(await vanished.request('GET', '/_pb/projects/demo'))).toEqual(
      reference,
    );
    expect(await normalized(await archived.request('GET', '/_pb/projects/demo'))).toEqual(
      reference,
    );
  });

  it('never returns an e-mail address', async () => {
    const f = await fixture();
    const text = await (await f.request('GET', '/_pb/projects/demo')).text();
    expect(text).not.toContain('@');
  });
});

describe('PATCH /_pb/projects/:project', () => {
  const patch = (f: Fixture, init: Parameters<Fixture['request']>[2] = {}) =>
    f.request('PATCH', '/_pb/projects/demo', {
      ifMatch: '"r7"',
      body: { name: 'Renamed' },
      ...init,
    });

  it('updates the settings and audits the change', async () => {
    const f = await fixture();
    const response = await patch(f, { body: { name: 'Renamed', tokenMaxScope: 'read' } });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(f.audits).toEqual(['project.update']);
    const call = f.updateSettings.mock.calls[0]!;
    expect(call[0]).toEqual(orgContext('org-1'));
    expect(call[1]).toMatchObject({
      kind: 'project',
      userId: 'user-1',
      orgId: 'org-1',
      projectId: PROJECT,
    });
    expect(call[1].permissions.has('project:settings:write')).toBe(true);
    expect(call[2]).toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
      expected: { project: 7 },
    });
    expect(call[3]).toBe(PROJECT);
    expect(call[4]).toEqual({ name: 'Renamed', tokenMaxScope: 'read' });
    expect(call[5]).toEqual({
      audit: {
        opId: expect.any(String),
        requestId: response.headers.get('x-request-id'),
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
    });
  });

  it('feeds the ETag of the GET into the expected revision', async () => {
    const f = await fixture();
    const etag = (await f.request('GET', '/_pb/projects/demo')).headers.get('etag');
    expect(etag).toBe('"r7"');
    await patch(f, { ifMatch: etag });
    expect(f.updateSettings.mock.calls[0]![2].expected).toEqual({ project: 7 });
  });

  it('answers 428 without If-Match', async () => {
    const f = await fixture();
    expect((await patch(f, { ifMatch: null })).status).toBe(428);
    noServiceCalls(f);
  });

  it('answers 412 for a stale revision', async () => {
    const f = await fixture({ storeAnswer: { update: 'conflict' } });
    expect((await patch(f)).status).toBe(412);
  });

  it('answers 400 for the empty body', async () => {
    const f = await fixture();
    expect((await patch(f, { body: {} })).status).toBe(400);
    noServiceCalls(f);
  });

  it('answers 400 for a slug in the body', async () => {
    const f = await fixture();
    expect((await patch(f, { body: { slug: 'x' } })).status).toBe(400);
    noServiceCalls(f);
  });

  it('answers 403 to a visible project without the settings permission', async () => {
    const f = await fixture({ permissions: ['project:read'] });
    expect((await patch(f)).status).toBe(403);
    noServiceCalls(f);
  });

  it('answers the uniform 404 for an invisible project', async () => {
    const f = await fixture({ projectVisible: false });
    const absent = await fixture({ projectVisible: false });
    expect(await normalized(await patch(f))).toEqual(
      await normalized(await absent.request('GET', '/_pb/projects/demo')),
    );
    noServiceCalls(f);
  });

  it('denies a token', async () => {
    const f = await fixture();
    expect((await patch(f, { auth: 'token' })).status).toBe(403);
    noServiceCalls(f);
  });
});

describe.each(['archive', 'restore'] as const)('POST /_pb/projects/:project/%s', (action) => {
  const path = `/_pb/projects/demo/${action}`;
  const call = (f: Fixture) => (action === 'archive' ? f.archiveProject : f.restoreProject);
  const send = (f: Fixture, init: Parameters<Fixture['request']>[2] = {}) =>
    f.request('POST', path, { ifMatch: '"r7"', ...init });

  it('answers 204, audits and fences on the stored revision', async () => {
    const f = await fixture();
    const response = await send(f);
    expect(response.status).toBe(204);
    expect(f.audits).toEqual([`project.${action}`]);
    const args = call(f).mock.calls[0]!;
    expect(args[0]).toEqual(orgContext('org-1'));
    expect(args[1]).toMatchObject({ kind: 'organization', userId: 'user-1' });
    expect(args[2]).toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
      expected: { project: 7 },
    });
    expect(args[3]).toBe(PROJECT);
    expect(args[4]).toEqual({
      audit: {
        opId: expect.any(String),
        requestId: response.headers.get('x-request-id'),
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
    });
  });

  it('answers 428 without If-Match', async () => {
    const f = await fixture();
    expect((await send(f, { ifMatch: null })).status).toBe(428);
    noServiceCalls(f);
  });

  it('answers 400 for a malformed If-Match', async () => {
    const f = await fixture();
    expect((await send(f, { ifMatch: 'r7' })).status).toBe(400);
    noServiceCalls(f);
  });

  it('answers 412 for a stale revision', async () => {
    const f = await fixture({ storeAnswer: { [action]: 'conflict' } });
    expect((await send(f)).status).toBe(412);
  });

  it('answers 409 for a project already in the target state', async () => {
    const f = await fixture({
      storeAnswer: { [action]: action === 'archive' ? 'not_active' : 'not_archived' },
    });
    const response = await send(f);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  it('answers the uniform 404 for an unknown slug', async () => {
    const f = await fixture({ row: null });
    const response = await send(f);
    const reference = await fixture({ projectVisible: false });
    expect(await normalized(response)).toEqual(
      await normalized(await reference.request('GET', '/_pb/projects/demo')),
    );
    noServiceCalls(f);
  });

  it('denies a read-scope token', async () => {
    const f = await fixture({ tokenScope: 'read' });
    expect((await send(f, { auth: 'token' })).status).toBe(403);
    noServiceCalls(f);
  });

  it('denies a caller without org:projects:archive', async () => {
    const f = await fixture({ permissions: ['project:read'] });
    expect((await send(f)).status).toBe(403);
    noServiceCalls(f);
  });

  it('answers 401 to an anonymous caller', async () => {
    const f = await fixture();
    expect((await send(f, { auth: 'anonymous' })).status).toBe(401);
  });
});

describe('POST /_pb/projects/:project/restore reauthentication', () => {
  it('answers 403 reauth_required when the store reports a stale reauthentication', async () => {
    const f = await fixture({ storeAnswer: { restore: 'reauth_required' } });
    const response = await f.request('POST', '/_pb/projects/demo/restore', { ifMatch: '"r7"' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'reauth_required' } });
  });

  it('answers 403 forbidden when the store reports lost authority', async () => {
    const f = await fixture({ storeAnswer: { restore: 'authority' } });
    const response = await f.request('POST', '/_pb/projects/demo/restore', { ifMatch: '"r7"' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('keeps a refused archive a generic 403', async () => {
    const f = await fixture({ storeAnswer: { archive: 'authority' } });
    const response = await f.request('POST', '/_pb/projects/demo/archive', { ifMatch: '"r7"' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
  });
});
