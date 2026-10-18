import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import { credentialAad } from '@package-broker/core/secrets/cipher';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { ProtectedHolderProvider } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCredentialRepository } from './credential.js';
import { SOURCE_ERROR_CODES, createSourceRepository, dueStatement } from './source.js';
import type { NewSource, SourceRepository } from './source.js';

const ANCHORS: readonly ProtectedHolderProvider[] = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];

const NOW = '2026-10-15T12:00:00.000Z';
const ORG_ROLE = '01J0ROLEORGSRC0000000000A1';
const PROJECT_ROLE = '01J0ROLEPROJSRC000000000A1';
const PROJECT_READER = '01J0ROLEPROJREAD00000000A1';
const P1 = '01J0PROJECT00000000000000A1';
const P2 = '01J0PROJECT00000000000000A2';
const P_ARCHIVED = '01J0PROJECT00000000000000A3';
const ORG_ADMIN = '01J0USER000000000000000001';
const P1_MAINTAINER = '01J0USER000000000000000002';
const P2_MAINTAINER = '01J0USER000000000000000003';
const P1_READER = '01J0USER000000000000000004';
const S_ORG = '01J0SESSION000000000000001';
const S_P1 = '01J0SESSION000000000000002';
const S_P2 = '01J0SESSION000000000000003';
const S_READER = '01J0SESSION000000000000004';
const JOB = '01J0JOB00000000000000000A1';
const JOB_OWNER = '01J0WWWWWWWWWWWWWWWWWW0001';
const SRC_ORG = '01J0SOURCE0000000000000001';
const SRC_P1 = '01J0SOURCE0000000000000002';
const SRC_PROXY = '01J0SOURCE0000000000000003';
const SRC_NEW = '01J0SOURCE0000000000000009';
const CRED_ORG = '01J0CRED0000000000000000A1';
const CRED_P1 = '01J0CRED0000000000000000A2';
const CRED_P2 = '01J0CRED0000000000000000A3';
const CRED_NEW = '01J0CRED0000000000000000A9';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let repository: SourceRepository;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function fenceFor(userId: string, sessionId: string): MutationFence {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
}

const orgFence = () => fenceFor(ORG_ADMIN, S_ORG);
const p1Fence = () => fenceFor(P1_MAINTAINER, S_P1);

function role(id: string, key: string, scope: string, ...permissions: string[]): Statement[] {
  return [
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)',
      id,
      a.orgId,
      key,
      key,
      scope,
    ),
    ...permissions.map((permission) =>
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        a.orgId,
        id,
        permission,
      ),
    ),
  ];
}

function person(userId: string, sessionId: string, email: string, n: number): Statement[] {
  const hash = sessionId
    .toLowerCase()
    .replace(/[^0-9a-f]/g, 'a')
    .padEnd(64, '0')
    .slice(0, 64);
  return [
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      userId,
      a.orgId,
      email,
      'active',
    ),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      sessionId,
      a.orgId,
      userId,
      hash,
      hash,
      new Date().toISOString(),
      new Date().toISOString(),
      '2999-01-01T00:00:00.000Z',
    ),
    stmt(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      `01J0IDENT0000000000000I${String(n)}`,
      a.orgId,
      userId,
      'oidc',
      `subject-${String(n)}`,
      email,
      1,
      new Date(Date.now() - 60_000).toISOString(),
    ),
  ];
}

function grant(id: string, email: string, roleId: string, projectId: string | null): Statement {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)',
    id,
    a.orgId,
    'email',
    email,
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
    NOW,
    NOW,
  );
}

function credentialInsert(id: string, projectId: string | null, org: OrgContext = a): Statement {
  const kind = 'source.token';
  return createCredentialRepository(executor).insertStatement(org, {
    id,
    projectId,
    kind,
    sealed: {
      ciphertext: Uint8Array.of(1, 2, 3),
      nonce: new Uint8Array(12).fill(7),
      keyVersion: 1,
    },
    aad: credentialAad({ id, orgId: org.orgId, kind }),
    rotatedAt: null,
    now: NOW,
  });
}

function seedSource(
  id: string,
  name: string,
  overrides: Partial<{
    project_id: string | null;
    type: string;
    status: string;
    credential_id: string | null;
    next_poll_at: string | null;
    poll_interval_seconds: number;
    consecutive_failures: number;
  }> = {},
): Statement {
  const type = overrides.type ?? 'composer_repository';
  return stmt(
    `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, url, credential_id, status,
      next_poll_at, poll_interval_seconds, consecutive_failures) VALUES (?, ?, ?, ?, 'composer', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    a.orgId,
    overrides.project_id ?? null,
    name,
    type,
    'https://repo.example.test',
    overrides.credential_id ?? null,
    overrides.status ?? 'paused',
    overrides.next_poll_at ?? null,
    overrides.poll_interval_seconds ?? 3600,
    overrides.consecutive_failures ?? 0,
  );
}

async function rows<R = Record<string, unknown>>(sql: string, ...params: Statement['params']) {
  return executor.all<R>(stmt(sql, ...params));
}

function near(value: unknown, offsetSeconds: number): boolean {
  if (typeof value !== 'string') return false;
  return Math.abs(Date.parse(value) - Date.now() - offsetSeconds * 1000) < 5000;
}

const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

async function sourceRow(id: string) {
  return (await rows<Record<string, unknown>>('SELECT * FROM source WHERE id = ?', id))[0];
}

async function snapshot(): Promise<string> {
  return JSON.stringify([
    await rows('SELECT * FROM source ORDER BY id'),
    await rows('SELECT * FROM credential ORDER BY id'),
    await rows('SELECT * FROM project_source ORDER BY source_id'),
  ]);
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  repository = createSourceRepository(executor);
  await executor.batch([
    ...role(ORG_ROLE, 'org_sources', 'organization', 'org:sources:write'),
    ...role(PROJECT_ROLE, 'project_sources', 'project', 'project:sources:write', 'project:read'),
    ...role(PROJECT_READER, 'project_reader', 'project', 'project:read'),
    stmt(
      'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
      P1,
      a.orgId,
      'one',
      'one',
      'active',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
      P2,
      a.orgId,
      'two',
      'two',
      'active',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
      P_ARCHIVED,
      a.orgId,
      'old',
      'old',
      'archived',
    ),
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      a.orgId,
      'oidc',
      'oidc:https://idp.example.test',
    ),
    ...person(ORG_ADMIN, S_ORG, 'admin@example.test', 1),
    ...person(P1_MAINTAINER, S_P1, 'm1@example.test', 2),
    ...person(P2_MAINTAINER, S_P2, 'm2@example.test', 3),
    ...person(P1_READER, S_READER, 'reader@example.test', 4),
    grant('01J0GRANT000000000000000A1', 'admin@example.test', ORG_ROLE, null),
    grant('01J0GRANT000000000000000A2', 'm1@example.test', PROJECT_ROLE, P1),
    grant('01J0GRANT000000000000000A3', 'm2@example.test', PROJECT_ROLE, P2),
    grant('01J0GRANT000000000000000A4', 'm1@example.test', PROJECT_ROLE, P_ARCHIVED),
    grant('01J0GRANT000000000000000A5', 'reader@example.test', PROJECT_READER, P1),
    credentialInsert(CRED_ORG, null),
    credentialInsert(CRED_P1, P1),
    credentialInsert(CRED_P2, P2),
  ]);
});

afterEach(async () => {
  await database.close();
});

function newSource(overrides: Partial<NewSource> = {}): NewSource {
  return {
    id: SRC_NEW,
    projectId: null,
    name: 'acme',
    ecosystem: 'composer',
    type: 'composer_repository',
    url: 'https://repo.example.test',
    configJson: '{}',
    credential: null,
    providerAnchors: ANCHORS,
    ...overrides,
  };
}

describe('source create', () => {
  it('creates an organization source with an org credential, paused and attached nowhere', async () => {
    expect(
      await repository.create(a, orgFence(), newSource({ credential: { id: CRED_ORG } })),
    ).toBe('created');
    const row = await sourceRow(SRC_NEW);
    expect(row).toMatchObject({ status: 'paused', credential_id: CRED_ORG, project_id: null });
    expect(await rows('SELECT * FROM project_source')).toEqual([]);
  });

  it('creates a proxy active', async () => {
    expect(
      await repository.create(
        a,
        orgFence(),
        newSource({ type: 'packagist_proxy', url: 'https://repo.packagist.org' }),
      ),
    ).toBe('created');
    expect(await sourceRow(SRC_NEW)).toMatchObject({ status: 'active' });
    expect(await rows('SELECT * FROM project_source')).toEqual([]);
  });

  it('creates a project source with the owner project credential', async () => {
    expect(
      await repository.create(
        a,
        p1Fence(),
        newSource({ projectId: P1, credential: { id: CRED_P1 } }),
      ),
    ).toBe('created');
    expect(await sourceRow(SRC_NEW)).toMatchObject({ project_id: P1, status: 'paused' });
  });

  it('inserts a prepared credential in the same batch', async () => {
    expect(
      await repository.create(
        a,
        p1Fence(),
        newSource({
          projectId: P1,
          credential: { id: CRED_NEW, projectId: P1, statement: credentialInsert(CRED_NEW, P1) },
        }),
      ),
    ).toBe('created');
    expect(await rows('SELECT id FROM credential WHERE id = ?', CRED_NEW)).toHaveLength(1);
    expect(await sourceRow(SRC_NEW)).toMatchObject({ credential_id: CRED_NEW });
  });

  it.each([
    ['an org-level credential', CRED_ORG],
    ['another project credential', CRED_P2],
  ])('refuses a project source with %s and commits nothing', async (_name, credentialId) => {
    const before = await snapshot();
    expect(
      await repository.create(
        a,
        p1Fence(),
        newSource({ projectId: P1, credential: { id: credentialId } }),
      ),
    ).toBe('credential_scope_mismatch');
    expect(await snapshot()).toBe(before);
  });

  it('refuses a prepared credential of the wrong owner and keeps it out of the database', async () => {
    const before = await snapshot();
    expect(
      await repository.create(
        a,
        p1Fence(),
        newSource({
          projectId: P1,
          credential: {
            id: CRED_NEW,
            projectId: null,
            statement: credentialInsert(CRED_NEW, null),
          },
        }),
      ),
    ).toBe('credential_scope_mismatch');
    expect(await snapshot()).toBe(before);
  });

  it('refuses a prepared credential whose inserted row has another owner than declared', async () => {
    const before = await snapshot();
    expect(
      await repository.create(
        a,
        p1Fence(),
        newSource({
          projectId: P1,
          credential: { id: CRED_NEW, projectId: P1, statement: credentialInsert(CRED_NEW, null) },
        }),
      ),
    ).toBe('credential_scope_mismatch');
    expect(await snapshot()).toBe(before);
  });

  it('makes every new source due on database time, and a proxy is listed at once', async () => {
    await repository.create(a, orgFence(), newSource());
    await repository.create(
      a,
      orgFence(),
      newSource({ id: SRC_PROXY, name: 'proxy', type: 'packagist_proxy', url: null }),
    );
    expect(near((await sourceRow(SRC_NEW))?.next_poll_at, 0)).toBe(true);
    expect(near((await sourceRow(SRC_NEW))?.created_at, 0)).toBe(true);
    expect(near((await sourceRow(SRC_PROXY))?.next_poll_at, 0)).toBe(true);
    expect((await repository.listDue(a, 10)).map((source) => source.id)).toEqual([SRC_PROXY]);
  });

  it('refuses an organization source with a project credential', async () => {
    expect(await repository.create(a, orgFence(), newSource({ credential: { id: CRED_P1 } }))).toBe(
      'credential_scope_mismatch',
    );
    expect(await sourceRow(SRC_NEW)).toBeUndefined();
  });

  it.each([
    ['a project maintainer creating an organization source', () => p1Fence(), null],
    ['a maintainer of another project', () => fenceFor(P2_MAINTAINER, S_P2), P1],
    ['a reader of the project', () => fenceFor(P1_READER, S_READER), P1],
    ['an archived project', () => p1Fence(), P_ARCHIVED],
  ])('refuses %s', async (_name, fence, projectId) => {
    const before = await snapshot();
    expect(await repository.create(a, fence(), newSource({ projectId }))).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('answers duplicate for a name already used by the same owner', async () => {
    await executor.batch([seedSource(SRC_ORG, 'acme')]);
    expect(await repository.create(a, orgFence(), newSource())).toBe('duplicate');
  });
});

describe('source update', () => {
  beforeEach(async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'org-src'),
      seedSource(SRC_P1, 'p1-src', { project_id: P1 }),
    ]);
  });

  it('pauses an active npm_registry source whose scopes change', async () => {
    await executor.batch([
      stmt(
        `INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json, status)
         VALUES (?, ?, 'npm-src', 'npm', 'npm_registry', 'https://npm.example.test', ?, 'active')`,
        '01J0SOURCE0000000000000021',
        a.orgId,
        '{"scopes":["@acme"]}',
      ),
    ]);
    expect(
      await repository.update(a, orgFence(), {
        id: '01J0SOURCE0000000000000021',
        providerAnchors: ANCHORS,
        changes: { configJson: '{"scopes":["@acme","@other"]}' },
      }),
    ).toBe('paused_for_reactivation');
    expect(await sourceRow('01J0SOURCE0000000000000021')).toMatchObject({
      status: 'paused',
      config_json: '{"scopes":["@acme","@other"]}',
    });
  });

  it('pauses a source activated between the read and the write', async () => {
    const racing = new Proxy(executor, {
      get(target, property, receiver) {
        if (property !== 'batch') return Reflect.get(target, property, receiver) as unknown;
        return async (statements: readonly Statement[]) => {
          await target.batch([stmt("UPDATE source SET status = 'active' WHERE id = ?", SRC_ORG)]);
          return target.batch(statements);
        };
      },
    });
    expect(
      await createSourceRepository(racing).update(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        changes: { configJson: '{"scopes":["@new"]}' },
      }),
    ).toBe('paused_for_reactivation');
    expect(await sourceRow(SRC_ORG)).toMatchObject({ status: 'paused' });
  });

  it('pauses a failing non-proxy source when its url changes', async () => {
    await executor.batch([stmt("UPDATE source SET status = 'failing' WHERE id = ?", SRC_ORG)]);
    expect(
      await repository.update(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        changes: { url: 'https://moved.example.test' },
      }),
    ).toBe('paused_for_reactivation');
    expect(await sourceRow(SRC_ORG)).toMatchObject({ status: 'paused' });
  });

  it('keeps an active source active when only the poll interval changes', async () => {
    await executor.batch([stmt("UPDATE source SET status = 'active' WHERE id = ?", SRC_ORG)]);
    expect(
      await repository.update(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        changes: { pollIntervalSeconds: 600 },
      }),
    ).toBe('updated');
    expect(await sourceRow(SRC_ORG)).toMatchObject({
      status: 'active',
      poll_interval_seconds: 600,
    });
  });

  it('leaves a proxy active when its url changes', async () => {
    await executor.batch([
      seedSource(SRC_PROXY, 'proxy', { type: 'packagist_proxy', status: 'active' }),
    ]);
    expect(
      await repository.update(a, orgFence(), {
        id: SRC_PROXY,
        providerAnchors: ANCHORS,
        changes: { url: 'https://repo.packagist.org' },
      }),
    ).toBe('updated');
    expect(await sourceRow(SRC_PROXY)).toMatchObject({ status: 'active' });
  });

  it('changes the allowed fields', async () => {
    expect(
      await repository.update(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        changes: {
          url: 'https://other.example.test',
          configJson: '{"a":1}',
          credentialId: CRED_ORG,
          userAgent: 'broker/1 (ops@example.test)',
          pollIntervalSeconds: 600,
          removalPolicy: 'exclude',
          retentionDaysOverride: 30,
          defaultVisibleToNewProjects: false,
        },
      }),
    ).toBe('updated');
    expect(await sourceRow(SRC_ORG)).toMatchObject({
      url: 'https://other.example.test',
      config_json: '{"a":1}',
      credential_id: CRED_ORG,
      user_agent: 'broker/1 (ops@example.test)',
      poll_interval_seconds: 600,
      removal_policy: 'exclude',
      retention_days_override: 30,
      default_visible_to_new_projects: 0,
      status: 'paused',
    });
  });

  it('refuses a credential of another owner', async () => {
    const before = await snapshot();
    expect(
      await repository.update(a, p1Fence(), {
        id: SRC_P1,
        providerAnchors: ANCHORS,
        changes: { credentialId: CRED_ORG },
      }),
    ).toBe('credential_scope_mismatch');
    expect(await snapshot()).toBe(before);
  });

  it('refuses another project actor and a missing source', async () => {
    expect(
      await repository.update(a, fenceFor(P2_MAINTAINER, S_P2), {
        id: SRC_P1,
        providerAnchors: ANCHORS,
        changes: { pollIntervalSeconds: 5 },
      }),
    ).toBe('forbidden');
    expect(
      await repository.update(a, orgFence(), {
        id: SRC_NEW,
        providerAnchors: ANCHORS,
        changes: { pollIntervalSeconds: 5 },
      }),
    ).toBe('not_found');
  });

  it('cannot reach the status or other fields through update', async () => {
    await expect(
      repository.update(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        changes: { status: 'active' } as never,
      }),
    ).rejects.toThrow(TypeError);
    expect(await sourceRow(SRC_ORG)).toMatchObject({ status: 'paused' });
  });
});

describe('source resume', () => {
  it('activates a proxy', async () => {
    await executor.batch([seedSource(SRC_PROXY, 'proxy', { type: 'packagist_proxy' })]);
    expect(
      await repository.resume(a, orgFence(), { id: SRC_PROXY, providerAnchors: ANCHORS }),
    ).toBe('resumed');
    expect(await sourceRow(SRC_PROXY)).toMatchObject({ status: 'active' });
  });

  it('refuses a non-proxy source and writes nothing', async () => {
    await executor.batch([seedSource(SRC_ORG, 'org-src')]);
    const before = await snapshot();
    expect(await repository.resume(a, orgFence(), { id: SRC_ORG, providerAnchors: ANCHORS })).toBe(
      'activation_requires_registered_names',
    );
    expect(await snapshot()).toBe(before);
  });

  it('answers forbidden before the type or existence is revealed', async () => {
    await executor.batch([seedSource(SRC_ORG, 'org-src')]);
    const outsider = fenceFor(P2_MAINTAINER, S_P2);
    expect(await repository.resume(a, outsider, { id: SRC_ORG, providerAnchors: ANCHORS })).toBe(
      'forbidden',
    );
    expect(await repository.resume(a, outsider, { id: SRC_NEW, providerAnchors: ANCHORS })).toBe(
      'forbidden',
    );
    expect(
      await repository.update(a, outsider, {
        id: SRC_NEW,
        providerAnchors: ANCHORS,
        changes: { pollIntervalSeconds: 5 },
      }),
    ).toBe('forbidden');
    expect(await repository.delete(a, outsider, { id: SRC_NEW, providerAnchors: ANCHORS })).toBe(
      'forbidden',
    );
  });

  it('refuses an unauthorised actor', async () => {
    await executor.batch([seedSource(SRC_PROXY, 'proxy', { type: 'packagist_proxy' })]);
    expect(await repository.resume(a, p1Fence(), { id: SRC_PROXY, providerAnchors: ANCHORS })).toBe(
      'forbidden',
    );
  });
});

describe('source delete', () => {
  beforeEach(async () => {
    await executor.batch([seedSource(SRC_P1, 'p1-src', { project_id: P1 })]);
  });

  it('is refused while a package row references the source', async () => {
    await executor.batch([
      stmt(
        `INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'composer', 'acme/pkg')`,
        '01J0PACKAGE00000000000000A',
        a.orgId,
        SRC_P1,
      ),
    ]);
    expect(await repository.delete(a, p1Fence(), { id: SRC_P1, providerAnchors: ANCHORS })).toBe(
      'has_packages',
    );
    expect(await sourceRow(SRC_P1)).toBeDefined();
  });

  it('removes a source with its attachment and registered names', async () => {
    await executor.batch([
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        a.orgId,
        P1,
        SRC_P1,
      ),
      stmt(
        `INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'acme/*')`,
        '01J0NAME0000000000000000A1',
        a.orgId,
        SRC_P1,
      ),
    ]);
    expect(await repository.delete(a, p1Fence(), { id: SRC_P1, providerAnchors: ANCHORS })).toBe(
      'deleted',
    );
    expect(await sourceRow(SRC_P1)).toBeUndefined();
    expect(await rows('SELECT * FROM project_source')).toEqual([]);
    expect(await rows('SELECT * FROM registered_name')).toEqual([]);
  });

  it('is refused while webhook deliveries reference the source', async () => {
    await executor.batch([
      stmt(
        `INSERT INTO webhook_delivery (org_id, provider, delivery_id, source_id, event) VALUES (?, 'github', 'd1', ?, 'push')`,
        a.orgId,
        SRC_P1,
      ),
    ]);
    expect(await repository.delete(a, p1Fence(), { id: SRC_P1, providerAnchors: ANCHORS })).toBe(
      'has_history',
    );
    expect(await sourceRow(SRC_P1)).toBeDefined();
  });

  it('refuses another project actor and an unknown source', async () => {
    expect(
      await repository.delete(a, fenceFor(P2_MAINTAINER, S_P2), {
        id: SRC_P1,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(await repository.delete(a, orgFence(), { id: SRC_NEW, providerAnchors: ANCHORS })).toBe(
      'not_found',
    );
  });
});

describe('source reads', () => {
  it('get returns the credential id and no secret material', async () => {
    await executor.batch([
      seedSource(SRC_P1, 'p1-src', { project_id: P1, credential_id: CRED_P1 }),
    ]);
    const source = await repository.get(a, SRC_P1);
    expect(source).toMatchObject({ id: SRC_P1, projectId: P1, credentialId: CRED_P1 });
    expect(JSON.stringify(source)).not.toMatch(/ciphertext|nonce|aad|sealed/);
    expect(await repository.get(b, SRC_P1)).toBeNull();
  });

  it('listDue returns due, non-paused sources oldest first and caps the limit', async () => {
    await executor.batch([
      seedSource('01J0SOURCE0000000000000011', 'due-b', {
        status: 'active',
        next_poll_at: at(-3600),
      }),
      seedSource('01J0SOURCE0000000000000012', 'due-a', {
        status: 'degraded',
        next_poll_at: at(-7200),
      }),
      seedSource('01J0SOURCE0000000000000013', 'later', {
        status: 'active',
        next_poll_at: at(3600),
      }),
      seedSource('01J0SOURCE0000000000000014', 'paused', {
        status: 'paused',
        next_poll_at: at(-9000),
      }),
    ]);
    const due = await repository.listDue(a, 10);
    expect(due.map((source) => source.name)).toEqual(['due-a', 'due-b']);
    expect(await repository.listDue(a, 1)).toHaveLength(1);
    await expect(repository.listDue(a, 51)).rejects.toThrow(RangeError);
    await expect(repository.listDue(a, 0)).rejects.toThrow(RangeError);
    expect(await repository.listDue(b, 10)).toEqual([]);
  });

  it('listDue is served by the source_due partial index', async () => {
    const statement = dueStatement(a, 10);
    const plan = await rows<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${statement.sql}`,
      ...statement.params,
    );
    expect(plan.map((row) => row.detail).join('\n')).toContain('source_due');
  });
});

describe('source pollState', () => {
  const guard = { id: JOB, owner: JOB_OWNER, fence: 3 };

  beforeEach(async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'org-src', {
        status: 'active',
        poll_interval_seconds: 3600,
        next_poll_at: at(-60),
      }),
      stmt(
        `INSERT INTO job (id, org_id, type, idempotency_key, resource_key, state, lease_owner, lease_until, fence)
         VALUES (?, ?, 'demo:work:v1', 'k', ?, 'running', ?, '2099-01-01T00:00:00.000Z', 3)`,
        JOB,
        a.orgId,
        `source:${SRC_ORG}`,
        JOB_OWNER,
      ),
    ]);
  });

  const success = {
    id: SRC_ORG,
    outcome: 'success' as const,
    rootHash: 'r1',
    listingHash: 'l1',
    pollEtag: '"e"',
    pollLastModified: 'Wed, 15 Oct 2026 12:00:00 GMT',
  };

  it('records a success', async () => {
    await executor.batch([
      stmt(
        'UPDATE source SET consecutive_failures = 2, status = ?, last_error = ? WHERE id = ?',
        'failing',
        'network',
        SRC_ORG,
      ),
    ]);
    expect(await repository.pollState(a, guard, success)).toBe('written');
    expect(await sourceRow(SRC_ORG)).toMatchObject({
      status: 'active',
      consecutive_failures: 0,
      last_error: null,
      root_hash: 'r1',
      listing_hash: 'l1',
      poll_etag: '"e"',
      poll_last_modified: 'Wed, 15 Oct 2026 12:00:00 GMT',
    });
    const row = await sourceRow(SRC_ORG);
    expect(near(row?.last_polled_at, 0)).toBe(true);
    expect(near(row?.last_success_at, 0)).toBe(true);
    expect(near(row?.next_poll_at, 3600)).toBe(true);
  });

  it('writes nothing with a stale job guard', async () => {
    const before = await snapshot();
    expect(await repository.pollState(a, { ...guard, fence: 4 }, success)).toBe('stale');
    expect(
      await repository.pollState(a, { ...guard, owner: '01J0WWWWWWWWWWWWWWWWWW0002' }, success),
    ).toBe('stale');
    expect(await snapshot()).toBe(before);
  });

  it('writes nothing when the job belongs to another resource', async () => {
    await executor.batch([
      stmt('UPDATE job SET resource_key = ? WHERE id = ?', 'source:other', JOB),
    ]);
    const before = await snapshot();
    expect(await repository.pollState(a, guard, success)).toBe('stale');
    expect(await snapshot()).toBe(before);
  });

  it('waits 300 seconds after the first failure, then doubles, capped at the interval', async () => {
    const failure = { id: SRC_ORG, outcome: 'failure' as const, error: 'network' as const };
    expect(await repository.pollState(a, guard, failure)).toBe('written');
    let row = await sourceRow(SRC_ORG);
    expect(row).toMatchObject({
      consecutive_failures: 1,
      last_error: 'network',
      last_success_at: null,
      status: 'degraded',
    });
    expect(near(row?.last_polled_at, 0)).toBe(true);
    expect(near(row?.next_poll_at, 300)).toBe(true);
    await repository.pollState(a, guard, failure);
    expect(near((await sourceRow(SRC_ORG))?.next_poll_at, 600)).toBe(true);
    await executor.batch([
      stmt('UPDATE source SET consecutive_failures = 30 WHERE id = ?', SRC_ORG),
    ]);
    await repository.pollState(a, guard, failure);
    row = await sourceRow(SRC_ORG);
    expect(near(row?.next_poll_at, 3600)).toBe(true);
    expect(row?.status).toBe('failing');
  });

  it('turns failing only from the fifth consecutive failure', async () => {
    const failure = { id: SRC_ORG, outcome: 'failure' as const, error: 'timeout' as const };
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await repository.pollState(a, guard, failure);
      expect((await sourceRow(SRC_ORG))?.status).toBe('degraded');
    }
    await repository.pollState(a, guard, failure);
    expect((await sourceRow(SRC_ORG))?.status).toBe('failing');
  });

  it('keeps a paused source paused', async () => {
    await executor.batch([stmt("UPDATE source SET status = 'paused' WHERE id = ?", SRC_ORG)]);
    await repository.pollState(a, guard, {
      id: SRC_ORG,
      outcome: 'failure',
      error: 'timeout',
    });
    expect(await sourceRow(SRC_ORG)).toMatchObject({ status: 'paused', consecutive_failures: 1 });
  });

  it('accepts only the fixed error codes', async () => {
    for (const code of SOURCE_ERROR_CODES) {
      expect(
        await repository.pollState(a, guard, {
          id: SRC_ORG,
          outcome: 'failure',
          error: code,
        }),
      ).toBe('written');
    }
    const before = await snapshot();
    await expect(
      repository.pollState(a, guard, {
        id: SRC_ORG,
        outcome: 'failure',
        error: 'connect ECONNREFUSED https://user:pw@host' as never,
      }),
    ).rejects.toThrow(TypeError);
    expect(await snapshot()).toBe(before);
  });
});

describe('other organizations', () => {
  const B_PROJECT = '01J0PROJECT00000000000000B1';
  const B_CRED = '01J0CRED0000000000000000B1';

  beforeEach(async () => {
    await executor.batch([
      stmt(
        'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
        B_PROJECT,
        b.orgId,
        'b',
        'b',
        'active',
      ),
      credentialInsert(B_CRED, null, b),
      seedSource(SRC_ORG, 'org-src', { status: 'active', next_poll_at: at(-60) }),
      seedSource(SRC_PROXY, 'proxy', { type: 'packagist_proxy' }),
    ]);
  });

  it('create refuses another organization project or credential', async () => {
    const before = await snapshot();
    expect(
      await repository.create(a, p1Fence(), newSource({ projectId: B_PROJECT, name: 'x' })),
    ).toBe('forbidden');
    expect(
      await repository.create(a, orgFence(), newSource({ credential: { id: B_CRED }, name: 'y' })),
    ).toBe('credential_scope_mismatch');
    expect(await snapshot()).toBe(before);
  });

  it('update, resume and delete do not reach a source of another organization', async () => {
    const before = await snapshot();
    const target = { id: SRC_ORG, providerAnchors: ANCHORS };
    expect(
      await repository.update(b, orgFence(), { ...target, changes: { pollIntervalSeconds: 5 } }),
    ).toBe('forbidden');
    expect(await repository.resume(b, orgFence(), { ...target, id: SRC_PROXY })).toBe('forbidden');
    expect(await repository.delete(b, orgFence(), target)).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('pollState does not write a source of another organization', async () => {
    await executor.batch([
      stmt(
        `INSERT INTO job (id, org_id, type, idempotency_key, resource_key, state, lease_owner, lease_until, fence)
         VALUES (?, ?, 'demo:work:v1', 'k', ?, 'running', ?, '2099-01-01T00:00:00.000Z', 3)`,
        JOB,
        b.orgId,
        `source:${SRC_ORG}`,
        JOB_OWNER,
      ),
    ]);
    const before = await snapshot();
    const guard = { id: JOB, owner: JOB_OWNER, fence: 3 };
    expect(await repository.pollState(b, guard, { id: SRC_ORG, outcome: 'success' })).toBe(
      'not_found',
    );
    expect(await repository.pollState(a, guard, { id: SRC_ORG, outcome: 'success' })).toBe('stale');
    expect(await snapshot()).toBe(before);
  });
});
