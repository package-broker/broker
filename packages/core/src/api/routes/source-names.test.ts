import { expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '../../authz/engine.js';
import { orgContext, type OrgContext, type SqlExecutor, type Statement } from '../../db/port.js';
import type { RegisteredNameRepository, SourceRecord, SourceRepository } from '../../db/source.js';
import { fixedClock, ulid } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { createSourceService } from '../../sources/source-service.js';
import { defineApi } from '../route.js';
import { SOURCE_NAMES_API_SPECS } from './source-names-schemas.js';
import { sourceNameRoutes } from './source-names.js';

const ORIGIN = 'https://broker.test';
const PROJECT = '01JA0000000000000000000001';
const OTHER_PROJECT = '01JA0000000000000000000002';
const SOURCE = '01JA0000000000000000000003';
const NAME = '01JA0000000000000000000004';
const OTHER = '01JA0000000000000000000005';
const SESSION = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const clock = fixedClock('2026-10-21T00:00:00.000Z');
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const bearer = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));

async function fixture(
  options: {
    organizationPermissions?: readonly string[];
    projectPermissions?: readonly string[];
    projectState?: 'absent' | 'archived' | 'foreign' | 'invisible';
    sourceState?: 'absent' | 'foreign' | 'invisible';
    sourceProject?: string;
    paused?: boolean;
    nameSource?: string;
    attachedSourceIds?: readonly string[];
  } = {},
) {
  const logs: string[] = [];
  const log = (entry: unknown) => {
    logs.push(JSON.stringify(entry));
  };
  let sequence = 0;
  const ids = { ulid: () => `01JB${String(++sequence).padStart(22, '0')}` };
  const clientIp = vi.fn(() => '203.0.113.7');
  const authorizedProject =
    options.projectState === undefined || options.projectState === 'invisible'
      ? { id: PROJECT }
      : null;
  const projects = {
    get: vi.fn(async () =>
      authorizedProject === null ? null : { status: 'active' as const, revision: 7 },
    ),
  };
  const row = {
    id: SOURCE,
    projectId: options.sourceProject ?? null,
    name: 'shared',
    ecosystem: 'composer',
    type: 'vcs',
    credentialId: null,
    configJson: '{}',
    status: 'paused',
  } as SourceRecord;
  const sources = {
    syncNow: vi.fn().mockResolvedValue('requested'),
    acceptRemoval: vi.fn().mockResolvedValue('accepted'),
    countAttachedProjects: vi.fn().mockResolvedValue(new Map()),
    get: vi.fn(async (_org: unknown, id: string) =>
      options.sourceState
        ? null
        : id === OTHER
          ? { ...row, id, projectId: OTHER_PROJECT, name: 'other-project-secret' }
          : row,
    ),
    getVisible: vi.fn(async () => (options.sourceState ? null : row)),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    list: vi.fn(),
  };
  const registeredNames = {
    list: vi.fn(async () => ({
      items: [{ id: NAME, sourceId: SOURCE, ecosystem: 'composer' as const, pattern: 'vendor/*' }],
      next: null,
    })),
    owner: vi.fn(async () => ({ sourceId: options.nameSource ?? SOURCE, projectId: null })),
    add: vi.fn().mockResolvedValue('added'),
    remove: vi.fn().mockResolvedValue(options.paused === false ? 'removed' : 'removed_and_paused'),
    enable: vi.fn().mockResolvedValue('activation_requires_registered_names'),
  };
  const catalogue = {
    previewWinners: vi.fn(async () => [
      {
        sourceId: SOURCE,
        sourceType: 'vcs' as const,
        projectLevel: false,
        precedence: 1,
        packageId: NAME,
        eligible: true,
      },
      {
        sourceId: OTHER,
        sourceType: 'vcs' as const,
        projectLevel: true,
        precedence: 2,
        packageId: OTHER,
        eligible: true,
      },
    ]),
  };
  const service = createSourceService({
    sources,
    registeredNames,
    catalogue,
    ids,
    log,
    credentials: { prepare: vi.fn() },
    credentialRepository: { get: vi.fn() },
    organizations: { get: vi.fn() },
    policy: { runtime: 'node', allowPrivateHosts: [], selfOrigins: [ORIGIN] },
    providerAnchors: [],
  });
  const visibility = { setOrder: vi.fn().mockResolvedValue({ ok: true, opId: NAME }) };
  const projectSources = {
    list: vi.fn(async () =>
      (options.attachedSourceIds ?? [SOURCE]).map((sourceId) => ({ sourceId })),
    ),
  };
  const orgPermissions = options.organizationPermissions ?? [
    'org:sources:read',
    'org:sources:write',
  ];
  const projectPermissions = options.projectPermissions ?? [
    'project:read',
    'project:sources:read',
    'project:sources:write',
  ];
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: sourceNameRoutes({
      service,
      sources,
      registeredNames,
      visibility,
      projectSources,
      projects,
      ids,
      clock,
      clientIp,
    }),
    ports: { organizations: { get: async () => null }, ids, clock },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: 'user-1' },
          identity: null,
          protectedHolder: false,
          project: input.boundary === 'project' ? authorizedProject : null,
          organizationPermissions: orgPermissions,
          projectPermissions: options.projectState === 'invisible' ? [] : projectPermissions,
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
                scope: { level: 'read', readOnly: true },
              },
              principalStatus: 'active',
              projectVisible: authorizedProject !== null && options.projectState !== 'invisible',
              validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
              project: input.boundary === 'project' ? authorizedProject : null,
              organizationPermissions: ['org:sources:read'],
              projectPermissions:
                options.projectState === 'invisible' ? [] : ['project:sources:read'],
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
    method: string,
    path: string,
    body?: unknown,
    token = false,
    ifMatch?: string,
  ) => {
    const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' });
    if (ifMatch !== undefined) headers.set('if-match', ifMatch);
    if (token) headers.set('authorization', `Bearer ${bearer}`);
    else {
      headers.set('cookie', `${SESSION_COOKIE}=${SESSION}`);
      headers.set('x-csrf-token', CSRF);
    }
    return app.fetch(
      new Request(ORIGIN + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  };

  return {
    request,
    service,
    registeredNames,
    sources,
    catalogue,
    visibility,
    projectSources,
    logs,
    clientIp,
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

const namesPath = `/_pb/sources/${SOURCE}/names`;
const resolvePath = '/_pb/projects/demo/resolve?name=vendor/x';
const orderPath = '/_pb/projects/demo/sources/order';
const writes = [
  ['POST', namesPath, { pattern: 'vendor/*' }],
  ['DELETE', `${namesPath}/${NAME}`, undefined],
  ['POST', `/_pb/sources/${SOURCE}/enable`, undefined],
  ['PUT', orderPath, { sourceIds: [SOURCE] }],
] as const;

async function sqliteNameWrite(
  method: 'POST' | 'DELETE',
  state: 'active' | 'archived' | 'foreign' | 'missing' | 'archive-at-write' | 'delete-at-write',
) {
  const [{ openMigratedDatabase }, { createSourceRepository }, { createRegisteredNameRepository }] =
    await Promise.all([
      vi.importActual<{
        openMigratedDatabase(options: { twoOrganizations: true }): Promise<{
          executor: SqlExecutor;
          orgs: { a: OrgContext; b: OrgContext } | null;
          close(): Promise<void>;
        }>;
      }>('@package-broker/db-sqlite/testing/migrated-database'),
      vi.importActual<{
        createSourceRepository(executor: SqlExecutor): SourceRepository;
      }>('@package-broker/db-sqlite/repositories/source'),
      vi.importActual<{
        createRegisteredNameRepository(executor: SqlExecutor): RegisteredNameRepository;
      }>('@package-broker/db-sqlite/repositories/registered-name'),
    ]);
  const projectId = PROJECT;
  const sourceId = SOURCE;
  const nameId = NAME;
  const database = await openMigratedDatabase({ twoOrganizations: true });
  try {
    if (database.orgs === null) throw new Error('missing test organizations');
    const ctx = database.orgs.a;
    const executor = database.executor;
    const query = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
    const batch = (...queries: Statement[]) => executor.batch(queries);
    const now = new Date().toISOString();
    const origin = 'https://broker.test';
    const csrf = 'B'.repeat(43);
    const anchors = [
      {
        provider: 'oidc',
        anchor: 'oidc:https://idp.example.test',
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ];
    await batch(
      query(
        "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('writer', ?, 'writer', 'Writer', 'organization', 0)",
        ctx.orgId,
      ),
      query(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'writer', 'org:sources:write')",
        ctx.orgId,
      ),
      query(
        "INSERT INTO user_account (id, org_id, email) VALUES ('writer', ?, 'writer@example.test')",
        ctx.orgId,
      ),
      query(
        "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
        ctx.orgId,
      ),
      query(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'writer', 'oidc', 'writer', 'writer@example.test', 1, ?)",
        ctx.orgId,
        now,
      ),
      query(
        "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES ('session', ?, 'writer', ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
        ctx.orgId,
        'a'.repeat(64),
        await sha256Hex(csrf),
        now,
        now,
      ),
      query(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', 'writer@example.test', 'organization', 'writer')",
        ctx.orgId,
      ),
      query(
        "INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, 'owner', 'Owner', 'active')",
        projectId,
        ctx.orgId,
      ),
      query(
        "INSERT INTO source (id, org_id, project_id, name, ecosystem, type, url, config_json, status) VALUES (?, ?, ?, 'private', 'composer', 'composer_repository', 'https://repo.example.test', '{}', 'active')",
        sourceId,
        ctx.orgId,
        projectId,
      ),
      query(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'vendor/*')",
        nameId,
        ctx.orgId,
        sourceId,
      ),
    );
    if (state === 'archived')
      await batch(
        query(
          "UPDATE project SET status = 'archived' WHERE org_id = ? AND id = ?",
          ctx.orgId,
          projectId,
        ),
      );
    if (state === 'foreign' || state === 'missing') {
      await executor.all(query('PRAGMA foreign_keys = OFF'));
      try {
        await batch(
          state === 'foreign'
            ? query(
                'UPDATE project SET org_id = ? WHERE org_id = ? AND id = ?',
                database.orgs.b.orgId,
                ctx.orgId,
                projectId,
              )
            : query('DELETE FROM project WHERE org_id = ? AND id = ?', ctx.orgId, projectId),
        );
      } finally {
        await executor.all(query('PRAGMA foreign_keys = ON'));
      }
    }
    const sources = createSourceRepository(executor);
    let raced = false;
    const writer: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      async batch(statements) {
        if (!raced && (state === 'archive-at-write' || state === 'delete-at-write')) {
          raced = true;
          await batch(
            state === 'archive-at-write'
              ? query(
                  "UPDATE project SET status = 'archived' WHERE org_id = ? AND id = ?",
                  ctx.orgId,
                  projectId,
                )
              : query('DELETE FROM source WHERE org_id = ? AND id = ?', ctx.orgId, sourceId),
          );
        }
        return executor.batch(statements);
      },
    };
    const registeredNames = createRegisteredNameRepository(writer);
    const write =
      method === 'POST' ? vi.spyOn(registeredNames, 'add') : vi.spyOn(registeredNames, 'remove');
    const ids = { ulid };
    const clock = fixedClock(now);
    const logs: string[] = [];
    const log = (entry: unknown) => logs.push(JSON.stringify(entry));
    const service = createSourceService({
      sources,
      registeredNames,
      ids,
      log,
      providerAnchors: anchors,
      credentials: {
        prepare: async () => {
          throw new Error('unused');
        },
      },
      credentialRepository: { get: async () => null },
      organizations: { get: async () => null },
      catalogue: { previewWinners: async () => [] },
      policy: { runtime: 'node', allowPrivateHosts: [], selfOrigins: [origin] },
    });
    const app = await createKernel({
      platform: 'node',
      plugins: [],
      coreRoutes: sourceNameRoutes({
        service,
        sources,
        registeredNames,
        ids,
        clock,
        clientIp: () => '192.0.2.1',
        visibility: {
          setOrder: async () => {
            throw new Error('unused');
          },
        },
        projectSources: { list: async () => [] },
        projects: { get: async () => null },
      }),
      ports: { organizations: { get: async () => null }, ids, clock },
      resolveOrg: async () => ctx,
      health: async () => true,
      log,
      authorization: createAuthorizationEngine({
        access: {
          lookupSession: async () => ({
            session: { id: 'session', csrfHash: await sha256Hex(csrf) },
            user: { id: 'writer' },
            identity: null,
            protectedHolder: false,
            project: null,
            organizationPermissions: ['org:sources:write'],
            projectPermissions: [],
          }),
          lookupToken: async () => null,
          touchSession: async () => true,
          touchToken: async () => true,
        },
        tokenUse: {
          keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
          nowMs: () => clock.now().getTime(),
          dispatch: (run) => {
            void run();
          },
          log,
        },
        patValidation: patValidationGate,
        publicOrigin: origin,
        providerAnchors: async () => anchors,
      }),
    });
    const snapshot = async () => ({
      names: await executor.all(
        query('SELECT * FROM registered_name WHERE org_id = ? ORDER BY id', ctx.orgId),
      ),
      sources: await executor.all(
        query('SELECT * FROM source WHERE org_id = ? ORDER BY id', ctx.orgId),
      ),
      audit: await executor.all(
        query('SELECT * FROM audit_pending WHERE org_id = ? ORDER BY id', ctx.orgId),
      ),
      epoch: await executor.all(query('SELECT * FROM cache_epoch WHERE org_id = ?', ctx.orgId)),
    });
    const request = (id: string) =>
      app.fetch(
        new Request(
          origin + '/_pb/sources/' + id + '/names' + (method === 'DELETE' ? '/' + nameId : ''),
          {
            method,
            headers: {
              origin,
              'content-type': 'application/json',
              cookie: SESSION_COOKIE + '=' + 'A'.repeat(43),
              'x-csrf-token': csrf,
            },
            ...(method === 'POST' ? { body: JSON.stringify({ pattern: 'other/*' }) } : {}),
          },
        ),
      );
    const normalize = async (response: Response) => {
      const text = await response.text();
      const body = (text === '' ? null : JSON.parse(text)) as {
        error?: { requestId?: string };
      } | null;
      if (body?.error) delete body.error.requestId;
      return {
        status: response.status,
        body,
        headers: [...response.headers].filter(([key]) => key !== 'x-request-id'),
      };
    };
    const before = await snapshot();
    const response = await normalize(await request(sourceId));
    const after = await snapshot();
    const absent = await normalize(await request(ulid()));
    return { before, after, response, absent, logs, writeCalls: write.mock.calls.length };
  } finally {
    await database.close();
  }
}

for (const method of ['POST', 'DELETE'] as const) {
  it.each(['archived', 'foreign', 'missing'] as const)(
    `uniformly hides a source when its owning project is %s in a SQLite-backed ${method} name write`,
    async (state) => {
      const result = await sqliteNameWrite(method, state);
      expect(result.response.status).toBe(404);
      expect(result.response).toEqual(result.absent);
      expect(result.after).toEqual(result.before);
      expect(result.writeCalls).toBe(0);
      expect(result.logs.join('\n')).not.toContain(SOURCE);
      expect(result.logs.join('\n')).not.toContain(PROJECT);
    },
  );

  it.each(['archive-at-write', 'delete-at-write'] as const)(
    `refuses a SQLite-backed ${method} name write when visibility changes at the batch: %s`,
    async (state) => {
      const result = await sqliteNameWrite(method, state);
      expect(result.response.status).toBe(404);
      expect(result.response).toEqual(result.absent);
      expect(result.writeCalls).toBe(1);
      expect(result.after.audit).toEqual(result.before.audit);
      expect(result.after.epoch).toEqual(result.before.epoch);
      if (state === 'archive-at-write') expect(result.after).toEqual(result.before);
      else {
        expect(result.after.names).toEqual([]);
        expect(result.after.sources).toEqual([]);
      }
    },
  );

  it(`allows a SQLite-backed ${method} name write for an active owning project`, async () => {
    const result = await sqliteNameWrite(method, 'active');
    expect(result.response.status).toBe(method === 'POST' ? 201 : 200);
    expect(result.after).not.toEqual(result.before);
    expect(result.writeCalls).toBe(1);
    expect(result.after).toMatchObject({
      names:
        method === 'POST'
          ? expect.arrayContaining([
              expect.objectContaining({ pattern: 'vendor/*' }),
              expect.objectContaining({ pattern: 'other/*' }),
            ])
          : [],
      sources: [expect.objectContaining({ status: method === 'POST' ? 'active' : 'paused' })],
    });
  });
}

it('exports six independently representable strict API specs', () => {
  expect(SOURCE_NAMES_API_SPECS).toHaveLength(6);
  for (const spec of SOURCE_NAMES_API_SPECS) expect(() => defineApi(spec)).not.toThrow();
});

it('lists registered names with the default page size', async () => {
  const f = await fixture();
  const response = await f.request('GET', namesPath);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    items: [{ id: NAME, sourceId: SOURCE, ecosystem: 'composer', pattern: 'vendor/*' }],
    next: null,
  });
  expect(f.registeredNames.list).toHaveBeenCalledWith(orgContext('org-1'), {
    sourceId: SOURCE,
    limit: 50,
  });
});

it('passes the id cursor and bounded page size', async () => {
  const f = await fixture();
  expect((await f.request('GET', `${namesPath}?limit=1&after=${NAME}`)).status).toBe(200);
  expect(f.registeredNames.list).toHaveBeenCalledWith(orgContext('org-1'), {
    sourceId: SOURCE,
    after: NAME,
    limit: 1,
  });
});

it('returns a created id and builds the mutation audit context', async () => {
  const f = await fixture();
  const response = await f.request('POST', namesPath, { pattern: 'vendor/*' });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ id: expect.any(String) });
  expect(f.registeredNames.add).toHaveBeenCalledWith(
    orgContext('org-1'),
    expect.objectContaining({ userId: 'user-1', sessionId: 'session-1' }),
    expect.objectContaining({
      sourceId: SOURCE,
      pattern: 'vendor/*',
      audit: expect.objectContaining({ sourceIp: '203.0.113.7', tokenSelector: null }),
    }),
  );
});

it('does not identify the other source or project in a pattern conflict', async () => {
  const f = await fixture();
  f.registeredNames.add.mockResolvedValue('pattern_taken');
  const response = await f.request('POST', namesPath, { pattern: 'vendor/*' });
  expect(response.status).toBe(409);
  const text = await response.text();
  expect(text).not.toContain('other-project-secret');
  expect(text).not.toContain(OTHER_PROJECT);
  expect(JSON.parse(text)).toMatchObject({ error: { code: 'conflict' } });
});

it('returns paused true when removal pauses a source', async () => {
  const f = await fixture();
  const response = await f.request('DELETE', `${namesPath}/${NAME}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ paused: true });
});

it('returns 204 when removal does not pause a source', async () => {
  const f = await fixture({ paused: false });
  const response = await f.request('DELETE', `${namesPath}/${NAME}`);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
});

it('does not remove a name belonging to another source', async () => {
  const f = await fixture({ nameSource: OTHER });
  expect((await f.request('DELETE', `${namesPath}/${NAME}`)).status).toBe(404);
  expect(f.registeredNames.remove).not.toHaveBeenCalled();
});

it('keeps an uncovered source paused when enable conflicts', async () => {
  const f = await fixture();
  expect((await f.request('POST', `/_pb/sources/${SOURCE}/enable`)).status).toBe(409);
  expect(f.registeredNames.enable).toHaveBeenCalledTimes(1);
  expect(f.sources.resume).not.toHaveBeenCalled();
  expect(await f.sources.get(orgContext('org-1'), SOURCE)).toMatchObject({ status: 'paused' });
});

it('enables a covered source', async () => {
  const f = await fixture();
  f.registeredNames.enable.mockResolvedValue('enabled');
  expect((await f.request('POST', `/_pb/sources/${SOURCE}/enable`)).status).toBe(204);
});

it('enables a project-owned source with its owner actor and authenticated fence', async () => {
  const f = await fixture({ sourceProject: PROJECT });
  f.registeredNames.enable.mockResolvedValue('enabled');
  const enable = vi.spyOn(f.service, 'enable');
  const preflight = vi.spyOn(f.service, 'getVisible');
  expect((await f.request('POST', `/_pb/sources/${SOURCE}/enable`)).status).toBe(204);
  const actor = {
    kind: 'project',
    actor: {
      kind: 'project',
      userId: 'user-1',
      orgId: 'org-1',
      projectId: PROJECT,
      permissions: new Set(['project:sources:write']),
    },
  };
  expect(preflight).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), actor, {
    projectId: PROJECT,
    sourceId: SOURCE,
  });
  expect(enable).toHaveBeenCalledExactlyOnceWith(
    orgContext('org-1'),
    actor,
    expect.objectContaining({ userId: 'user-1', sessionId: 'session-1' }),
    SOURCE,
    expect.objectContaining({ audit: expect.objectContaining({ sourceIp: '203.0.113.7' }) }),
  );
  expect(f.registeredNames.enable).toHaveBeenCalledExactlyOnceWith(
    orgContext('org-1'),
    expect.objectContaining({ userId: 'user-1', sessionId: 'session-1' }),
    expect.objectContaining({
      id: SOURCE,
      audit: expect.objectContaining({ projectId: PROJECT }),
    }),
  );
});

it('uniformly hides a project-owned source when the fenced writer denies another project admin', async () => {
  const f = await fixture({ sourceProject: OTHER_PROJECT });
  f.registeredNames.enable.mockResolvedValue('forbidden');
  const absent = await fixture({ sourceState: 'absent' });
  const response = await normalized(await f.request('POST', `/_pb/sources/${SOURCE}/enable`));
  expect(response.status).toBe(404);
  expect(response).toEqual(
    await normalized(await absent.request('POST', `/_pb/sources/${SOURCE}/enable`)),
  );
  expect(f.registeredNames.enable).toHaveBeenCalledOnce();
  expect(f.sources.resume).not.toHaveBeenCalled();
  expect(await f.sources.get(orgContext('org-1'), SOURCE)).toMatchObject({ status: 'paused' });
});

it('does not enable a project source hidden by the visibility preflight', async () => {
  const f = await fixture({ sourceProject: PROJECT });
  f.sources.getVisible.mockResolvedValue(null);
  f.registeredNames.enable.mockResolvedValue('enabled');
  const absent = await fixture({ sourceState: 'absent' });
  const response = await normalized(await f.request('POST', `/_pb/sources/${SOURCE}/enable`));
  expect(response.status).toBe(404);
  expect(response).toEqual(
    await normalized(await absent.request('POST', `/_pb/sources/${SOURCE}/enable`)),
  );
  expect(f.sources.getVisible).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), {
    projectId: PROJECT,
    sourceId: SOURCE,
  });
  expect(f.registeredNames.enable).not.toHaveBeenCalled();
});

it('keeps the organization actor and forbidden response for an organization source', async () => {
  const f = await fixture();
  f.registeredNames.enable.mockResolvedValue('forbidden');
  const enable = vi.spyOn(f.service, 'enable');
  expect((await f.request('POST', `/_pb/sources/${SOURCE}/enable`)).status).toBe(403);
  expect(enable).toHaveBeenCalledWith(
    orgContext('org-1'),
    expect.objectContaining({ kind: 'org' }),
    expect.anything(),
    SOURCE,
    expect.anything(),
  );
  expect(f.sources.getVisible).not.toHaveBeenCalled();
});

it('resolves a name without disclosing another project source', async () => {
  const f = await fixture();
  const response = await f.request('GET', resolvePath);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    name: 'vendor/x',
    ecosystem: 'composer',
    candidates: [{ sourceId: SOURCE, sourceName: 'shared', projectLevel: false, eligible: true }],
    winner: SOURCE,
  });
  expect(f.catalogue.previewWinners).toHaveBeenCalledWith(orgContext('org-1'), {
    projectId: PROJECT,
    ecosystem: 'composer',
    key: 'vendor/x',
  });
});

it.each(['@scope/name', 'plain'])('resolves npm name %s', async (name) => {
  const f = await fixture();
  const response = await f.request(
    'GET',
    '/_pb/projects/demo/resolve?name=' + encodeURIComponent(name),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name, ecosystem: 'npm' });
});

it('never echoes an invalid package name', async () => {
  const f = await fixture();
  const response = await f.request('GET', '/_pb/projects/demo/resolve?name=invalid%3Fsentinel');
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('sentinel');
  expect(f.catalogue.previewWinners).not.toHaveBeenCalled();
});

it('requires the ordering If-Match', async () => {
  const f = await fixture();
  expect((await f.request('PUT', orderPath, { sourceIds: [SOURCE] })).status).toBe(428);
  expect(f.visibility.setOrder).not.toHaveBeenCalled();
});

it('passes the project revision and call to the atomic ordering service', async () => {
  const f = await fixture();
  expect((await f.request('PUT', orderPath, { sourceIds: [SOURCE] }, false, '"r7"')).status).toBe(
    204,
  );
  expect(f.visibility.setOrder).toHaveBeenCalledWith(
    orgContext('org-1'),
    expect.objectContaining({ expected: { project: 7 } }),
    { projectId: PROJECT, sourceIds: [SOURCE] },
    expect.objectContaining({ audit: expect.objectContaining({ sourceIp: '203.0.113.7' }) }),
  );
});

it('uniformly hides an unattached ordering id', async () => {
  const f = await fixture({ attachedSourceIds: [OTHER] });
  f.visibility.setOrder.mockResolvedValue({ ok: false, error: 'not_found' });
  const response = await f.request('PUT', orderPath, { sourceIds: [OTHER] }, false, '"r7"');
  const missing = await fixture({ projectState: 'absent' });
  expect(response.status).toBe(404);
  expect(await normalized(response)).toEqual(
    await normalized(
      await missing.request('PUT', orderPath, { sourceIds: [OTHER] }, false, '"r7"'),
    ),
  );
  expect(f.visibility.setOrder).toHaveBeenCalledTimes(1);
});

it.each([
  ['an oversized source list', [SOURCE], [SOURCE, OTHER]],
  ['a source on an empty project', [], [SOURCE]],
  ['an unattached source in a same-sized list', [SOURCE], [OTHER]],
] as const)('uniformly hides %s before ordering', async (_label, attachedSourceIds, sourceIds) => {
  const f = await fixture({ attachedSourceIds });
  if (sourceIds.length > attachedSourceIds.length)
    f.visibility.setOrder.mockRejectedValue(new TypeError('invalid visibility order size'));
  const response = await f.request('PUT', orderPath, { sourceIds }, false, '"r7"');
  const missing = await fixture({ projectState: 'absent' });
  expect(response.status).toBe(404);
  expect(await normalized(response)).toEqual(
    await normalized(await missing.request('PUT', orderPath, { sourceIds }, false, '"r7"')),
  );
  expect(f.projectSources.list).toHaveBeenCalledWith(orgContext('org-1'), { projectId: PROJECT });
  expect(f.visibility.setOrder).not.toHaveBeenCalled();
});

it('returns precondition_failed when a complete order has a stale If-Match revision', async () => {
  const f = await fixture({ attachedSourceIds: [SOURCE, OTHER] });
  f.visibility.setOrder.mockResolvedValue({ ok: false, error: 'conflict' });
  const response = await f.request('PUT', orderPath, { sourceIds: [OTHER, SOURCE] }, false, '"r6"');
  expect(response.status).toBe(412);
  expect(await response.json()).toMatchObject({ error: { code: 'precondition_failed' } });
  expect(f.visibility.setOrder).toHaveBeenCalledExactlyOnceWith(
    orgContext('org-1'),
    expect.objectContaining({ expected: { project: 6 } }),
    { projectId: PROJECT, sourceIds: [OTHER, SOURCE] },
    expect.anything(),
  );
});

it('conflicts on an incomplete source order before calling the writer', async () => {
  const f = await fixture({ attachedSourceIds: [SOURCE, OTHER] });
  const response = await f.request('PUT', orderPath, { sourceIds: [SOURCE] }, false, '"r7"');
  expect(response.status).toBe(409);
  expect(f.visibility.setOrder).not.toHaveBeenCalled();
});

it('reorders the complete attached set with only source-write permission', async () => {
  const f = await fixture({
    projectPermissions: ['project:sources:write'],
    attachedSourceIds: [SOURCE, OTHER],
  });
  const sourceIds = [OTHER, SOURCE];
  const response = await f.request('PUT', orderPath, { sourceIds }, false, '"r7"');
  expect(response.status).toBe(204);
  expect(f.visibility.setOrder).toHaveBeenCalledExactlyOnceWith(
    orgContext('org-1'),
    expect.objectContaining({ expected: { project: 7 } }),
    { projectId: PROJECT, sourceIds },
    expect.anything(),
  );
});

it.each([
  ['51 bytes', 'a'.repeat(51)],
  ['empty', ''],
  ['control', 'vendor/\u0001'],
  ['multibyte', 'é'.repeat(26)],
])('rejects %s pattern at the declared pointer', async (_label, pattern) => {
  const f = await fixture();
  const response = await f.request('POST', namesPath, { pattern });
  expect(response.status).toBe(400);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({
    error: { details: [expect.objectContaining({ path: '/body/pattern' })] },
  });
  if (pattern !== '') expect(body).not.toContain(pattern);
  expect(f.registeredNames.add).not.toHaveBeenCalled();
});

for (const [method, path, body] of writes) {
  it(`denies a read-scope token on ${method} ${path}`, async () => {
    const f = await fixture();
    expect((await f.request(method, path, body, true, '"r7"')).status).toBe(403);
    expect(f.registeredNames.add).not.toHaveBeenCalled();
    expect(f.registeredNames.remove).not.toHaveBeenCalled();
    expect(f.registeredNames.enable).not.toHaveBeenCalled();
    expect(f.visibility.setOrder).not.toHaveBeenCalled();
  });
}

for (const [method, path, body] of [
  ...writes,
  ['GET', namesPath, undefined],
  ['GET', resolvePath, undefined],
] as const) {
  const projectScoped = path.startsWith('/_pb/projects/');
  it.each(['absent', 'foreign', 'archived', 'invisible'] as const)(
    projectScoped
      ? `uniformly hides an %s project without route permission on ${method} ${path}`
      : `denies missing route permission before lookup for %s on ${method} ${path}`,
    async (state) => {
      const existing = await fixture({
        organizationPermissions: [],
        projectPermissions: ['project:read'],
      });
      const f = await fixture({
        organizationPermissions: [],
        projectPermissions: ['project:read'],
        projectState: state,
        sourceState: state === 'archived' ? 'absent' : state,
      });
      const result = await normalized(await f.request(method, path, body, false, '"r7"'));
      const visible = await normalized(await existing.request(method, path, body, false, '"r7"'));
      expect(visible.status).toBe(403);
      if (projectScoped) {
        const hidden = await fixture({ projectState: state });
        expect(result.status).toBe(404);
        expect(result).toEqual(
          await normalized(await hidden.request(method, path, body, false, '"r7"')),
        );
      } else {
        expect(result.status).toBe(403);
        expect(result).toEqual(visible);
      }
      expect(f.sources.get).not.toHaveBeenCalled();
      expect(f.registeredNames.list).not.toHaveBeenCalled();
      expect(f.catalogue.previewWinners).not.toHaveBeenCalled();
    },
  );
}

it.each(['absent', 'foreign', 'archived', 'invisible'] as const)(
  'uniformly hides an %s project with resolve permission',
  async (state) => {
    const f = await fixture({ projectState: state });
    const absent = await fixture({ projectState: 'absent' });
    const response = await normalized(await f.request('GET', resolvePath));
    expect(response.status).toBe(404);
    expect(response).toEqual(await normalized(await absent.request('GET', resolvePath)));
    expect(f.catalogue.previewWinners).not.toHaveBeenCalled();
  },
);

it.each(['absent', 'foreign', 'invisible'] as const)(
  'uniformly hides an %s source with list permission',
  async (state) => {
    const f = await fixture({ sourceState: state });
    const absent = await fixture({ sourceState: 'absent' });
    const response = await normalized(await f.request('GET', namesPath));
    expect(response.status).toBe(404);
    expect(response).toEqual(await normalized(await absent.request('GET', namesPath)));
    expect(f.registeredNames.list).not.toHaveBeenCalled();
  },
);
