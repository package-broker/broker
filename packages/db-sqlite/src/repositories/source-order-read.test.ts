import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import { createAuthorizationEngine, patValidationGate } from '@package-broker/core/authz/engine';
import { createVisibilityService } from '@package-broker/core/catalogue/visibility-service';
import { sourceRoutes } from '@package-broker/core/api/routes/sources';
import { sourceNameRoutes } from '@package-broker/core/api/routes/source-names';
import { sourceAttachmentRoutes } from '@package-broker/core/api/routes/source-attachment';
import { createSourceService } from '@package-broker/core/sources/source-service';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { ulid } from '@package-broker/core/ids';
import type { Statement } from '@package-broker/core/db/port';
import { createSourceRepository } from './source.js';
import { createProjectRepository } from './project.js';
import { createProjectSourceReader } from './project-source-read.js';
import { createVisibilityStore } from './catalogue-writer.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';

let database: MigratedDatabase | undefined;
afterEach(() => database?.close());
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });

it('round-trips source order and changes the read ETag on reorder, attach and detach', async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  const org = database.orgs!.a;
  const executor = database.executor;
  const project = ulid(),
    user = ulid(),
    session = ulid(),
    role = ulid();
  const sourceIds = [ulid(), ulid(), ulid()];
  const anchors = [
    {
      provider: 'oidc',
      anchor: 'oidc:https://idp.example.test',
      emailAuthoritative: true,
      emailAuthoritativeDomains: ['example.test'],
    },
  ];
  const permissions = [
    'project:read',
    'project:sources:read',
    'project:sources:write',
    'org:sources:write',
  ];
  await executor.batch([
    stmt(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
      org.orgId,
    ),
    stmt(
      "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'demo', 'Demo')",
      project,
      org.orgId,
    ),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, 'owner', 'Owner', 'organization')",
      role,
      org.orgId,
    ),
    ...permissions.map((permission) =>
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        org.orgId,
        role,
        permission,
      ),
    ),
    stmt(
      "INSERT INTO user_account (id, org_id, email) VALUES (?, ?, 'owner@example.test')",
      user,
      org.orgId,
    ),
    stmt(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, 'oidc', 'owner', 'owner@example.test', 1, ?)",
      ulid(),
      org.orgId,
      user,
      new Date().toISOString(),
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, scope, role_id, subject_type, subject_value) VALUES (?, ?, 'organization', ?, 'email', 'owner@example.test')",
      ulid(),
      org.orgId,
      role,
    ),
    stmt(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
      session,
      org.orgId,
      user,
      'a'.repeat(64),
      'b'.repeat(64),
    ),
    ...sourceIds.map((id, index) =>
      stmt(
        "INSERT INTO source (id, org_id, project_id, name, ecosystem, type) VALUES (?, ?, ?, ?, 'npm', 'hosted')",
        id,
        org.orgId,
        project,
        `Source ${index}`,
      ),
    ),
    ...sourceIds
      .slice(0, 2)
      .map((id, index) =>
        stmt(
          'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
          org.orgId,
          project,
          id,
          index,
        ),
      ),
  ]);
  const sources = createSourceRepository(executor);
  const projectSources = createProjectSourceReader(executor);
  const projects = createProjectRepository(executor);
  const registeredNames = {
    get: async () => null,
    claimProxy: vi.fn().mockResolvedValue(null),
    list: vi.fn(),
    owner: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    enable: vi.fn(),
  };
  const service = createSourceService({
    sources,
    registeredNames,
    organizations: { get: vi.fn() },
    credentials: { prepare: vi.fn() },
    credentialRepository: { get: vi.fn() },
    catalogue: { previewWinners: vi.fn() },
    providerAnchors: anchors,
    policy: { runtime: 'node', allowPrivateHosts: [], selfOrigins: ['https://broker.test'] },
    ids: { ulid },
    log: vi.fn(),
  });
  const visibility = createVisibilityService({
    store: createVisibilityStore(executor, { providerAnchors: anchors }),
    log: vi.fn(),
  });
  const common = {
    sources,
    projectSources,
    projects,
    ids: { ulid },
    clock: { now: () => new Date() },
    clientIp: () => null,
  };
  const csrf = 'B'.repeat(43);
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: [
      ...sourceRoutes({
        ...common,
        service,
        sessions: { authenticate: vi.fn(), isReauthFresh: vi.fn() },
      }),
      ...sourceNameRoutes({ ...common, service, registeredNames, visibility }),
      ...sourceAttachmentRoutes({ ...common, visibility }),
    ],
    ports: { organizations: { get: vi.fn() }, ids: { ulid }, clock: common.clock },
    resolveOrg: async () => org,
    health: async () => true,
    log: vi.fn(),
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async () => ({
          session: { id: session, csrfHash: await sha256Hex(csrf) },
          user: { id: user },
          identity: null,
          protectedHolder: false,
          project: { id: project },
          organizationPermissions: permissions,
          projectPermissions: [],
        }),
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
        nowMs: () => Date.now(),
        dispatch: (run) => {
          void run();
        },
        log: vi.fn(),
      },
      patValidation: patValidationGate,
      publicOrigin: 'https://broker.test',
      providerAnchors: async () => [],
    }),
  });
  const request = (method = 'GET', suffix = '', body?: unknown, etag?: string) =>
    app.fetch(
      new Request('https://broker.test/_pb/projects/demo/sources' + suffix, {
        method,
        headers: {
          origin: 'https://broker.test',
          cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}`,
          'x-csrf-token': csrf,
          'content-type': 'application/json',
          ...(etag === undefined ? {} : { 'if-match': etag }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  type Page = { items: { id: string; attached: boolean; precedence?: number }[] };
  const before = await request();
  expect(before.status).toBe(200);
  const beforePage = (await before.json()) as Page;
  expect(beforePage.items.find((item) => item.id === sourceIds[2])).toMatchObject({
    attached: false,
  });
  const ordered = [...sourceIds.slice(0, 2)].reverse();
  expect(
    (await request('PUT', '/order', { sourceIds: ordered }, before.headers.get('etag')!)).status,
  ).toBe(204);
  const reordered = await request();
  expect(reordered.status).toBe(200);
  const page = (await reordered.json()) as Page;
  expect(
    page.items
      .filter((item) => item.attached)
      .sort((a, b) => a.precedence! - b.precedence!)
      .map((item) => item.id),
  ).toEqual(ordered);
  expect(reordered.headers.get('etag')).not.toBe(before.headers.get('etag'));
  expect(
    (await request('PUT', '/order', { sourceIds: ordered }, reordered.headers.get('etag')!)).status,
  ).toBe(204);
  expect((await request()).headers.get('etag')).toBe(reordered.headers.get('etag'));
  expect(
    (
      await request(
        'PUT',
        '/order',
        { sourceIds: sourceIds.slice(0, 2) },
        before.headers.get('etag')!,
      )
    ).status,
  ).toBe(412);
  expect((await request('PUT', `/${sourceIds[2]}/attachment`, {})).status).toBe(204);
  const attached = await request();
  expect(attached.headers.get('etag')).not.toBe(reordered.headers.get('etag'));
  expect(
    (await request('PUT', '/order', { sourceIds }, reordered.headers.get('etag')!)).status,
  ).toBe(412);
  expect(
    ((await attached.json()) as Page).items.find((item) => item.id === sourceIds[2])!.attached,
  ).toBe(true);
  expect((await request('PUT', `/${sourceIds[2]}/attachment`, {})).status).toBe(204);
  expect((await request()).headers.get('etag')).toBe(attached.headers.get('etag'));
  expect((await request('PUT', `/${sourceIds[2]}/attachment`, { precedence: 7 })).status).toBe(204);
  const precedenceChanged = await request();
  expect(precedenceChanged.headers.get('etag')).not.toBe(attached.headers.get('etag'));
  expect(
    ((await precedenceChanged.json()) as Page).items.find((item) => item.id === sourceIds[2])!
      .precedence,
  ).toBe(7);
  expect(
    (await request('PUT', '/order', { sourceIds }, attached.headers.get('etag')!)).status,
  ).toBe(412);
  expect((await request('DELETE', `/${sourceIds[2]}/attachment`)).status).toBe(204);
  const detached = await request();
  expect(detached.headers.get('etag')).not.toBe(precedenceChanged.headers.get('etag'));
  expect(
    (await request('PUT', '/order', { sourceIds: ordered }, precedenceChanged.headers.get('etag')!))
      .status,
  ).toBe(412);
  expect(
    ((await detached.json()) as Page).items.find((item) => item.id === sourceIds[2]),
  ).toMatchObject({ attached: false });
});
