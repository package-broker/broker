import { SOURCE_ERROR_CODES } from '@package-broker/core/sources/source-error-codes';
import { settleIdempotent, type IdempotencyRecord } from '@package-broker/core/api/idempotency';
import { createIdempotencyRepository, idempotencyInsertStatement } from './idempotency.js';
import { countCalls } from '../contract/count-calls.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourceService } from '@package-broker/core/sources/source-service';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import { credentialAad } from '@package-broker/core/secrets/cipher';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { ProtectedHolderProvider } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCredentialRepository } from './credential.js';
import { createSourceRepository, dueStatement, listSourcesStatement } from './source.js';
import type { NewSource, SourceRepository } from './source.js';
import type { AuditAction, AuditEvent } from '@package-broker/core/audit/actions';

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
    org_id: string;
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
    overrides.org_id ?? a.orgId,
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

let stagedAudits = 0;
function stagedAudit(action: AuditAction): AuditEvent {
  stagedAudits += 1;
  return {
    id: `01ARZ3NDEKTSV4RRFG${String(stagedAudits).padStart(8, '0')}`,
    occurredAt: '2026-10-25T12:00:00.000Z',
    action,
    actor: { type: 'user', id: ORG_ADMIN },
    tokenSelector: null,
    sourceIp: null,
    target: { type: 'source', id: null },
    projectId: null,
    payloadJson: '{}',
  };
}

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
    audit: stagedAudit('source.create'),
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
        audit: [stagedAudit('source.update')],
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
        audit: [stagedAudit('source.update')],
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
        audit: [stagedAudit('source.update')],
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
        audit: [stagedAudit('source.update')],
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
        audit: [stagedAudit('source.update')],
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
        audit: [stagedAudit('source.update')],
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
        audit: [stagedAudit('source.update')],
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
        audit: [stagedAudit('source.update')],
        id: SRC_P1,
        providerAnchors: ANCHORS,
        changes: { pollIntervalSeconds: 5 },
      }),
    ).toBe('forbidden');
    expect(
      await repository.update(a, orgFence(), {
        audit: [stagedAudit('source.update')],
        id: SRC_NEW,
        providerAnchors: ANCHORS,
        changes: { pollIntervalSeconds: 5 },
      }),
    ).toBe('not_found');
  });

  it('cannot reach the status or other fields through update', async () => {
    await expect(
      repository.update(a, orgFence(), {
        audit: [stagedAudit('source.update')],
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
      await repository.resume(a, orgFence(), {
        audit: stagedAudit('source.resume'),
        id: SRC_PROXY,
        providerAnchors: ANCHORS,
      }),
    ).toBe('resumed');
    expect(await sourceRow(SRC_PROXY)).toMatchObject({ status: 'active' });
  });

  it('refuses a non-proxy source and writes nothing', async () => {
    await executor.batch([seedSource(SRC_ORG, 'org-src')]);
    const before = await snapshot();
    expect(
      await repository.resume(a, orgFence(), {
        audit: stagedAudit('source.resume'),
        id: SRC_ORG,
        providerAnchors: ANCHORS,
      }),
    ).toBe('activation_requires_registered_names');
    expect(await snapshot()).toBe(before);
  });

  it('answers forbidden before the type or existence is revealed', async () => {
    await executor.batch([seedSource(SRC_ORG, 'org-src')]);
    const outsider = fenceFor(P2_MAINTAINER, S_P2);
    expect(
      await repository.resume(a, outsider, {
        audit: stagedAudit('source.resume'),
        id: SRC_ORG,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(
      await repository.resume(a, outsider, {
        audit: stagedAudit('source.resume'),
        id: SRC_NEW,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(
      await repository.update(a, outsider, {
        audit: [stagedAudit('source.update')],
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
    expect(
      await repository.resume(a, p1Fence(), {
        audit: stagedAudit('source.resume'),
        id: SRC_PROXY,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
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

describe('source project visibility', () => {
  function visible(projectId: string, sourceId: string, ctx = a) {
    const service = createSourceService({
      sources: repository,
      organizations: { get: vi.fn() },
      credentials: { prepare: vi.fn() },
      credentialRepository: { get: vi.fn() },
      registeredNames: {
        list: vi.fn(),
        owner: vi.fn(),
        add: vi.fn(),
        remove: vi.fn(),
        enable: vi.fn(),
      },
      catalogue: { previewWinners: vi.fn() },
      policy: { runtime: 'node', allowPrivateHosts: [], selfOrigins: [] },
      providerAnchors: ANCHORS,
      ids: { ulid: vi.fn() },
      log: vi.fn(),
    });
    return service.getVisible(
      ctx,
      {
        kind: 'project',
        actor: {
          kind: 'project',
          userId: P1_MAINTAINER,
          orgId: ctx.orgId,
          projectId,
          permissions: new Set(['project:sources:write']),
        },
      },
      { projectId, sourceId },
    );
  }

  it('reads a project-owned source', async () => {
    await executor.batch([seedSource(SRC_P1, 'owned', { project_id: P1 })]);
    expect(await repository.getVisible(a, { projectId: P1, sourceId: SRC_P1 })).toEqual(
      await repository.get(a, SRC_P1),
    );
    expect(await visible(P1, SRC_P1)).toMatchObject({
      ok: true,
      value: { id: SRC_P1, projectId: P1, hasCredential: false },
    });
  });

  it('reads an attached organization source', async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'shared'),
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        a.orgId,
        P1,
        SRC_ORG,
      ),
    ]);
    expect(await repository.getVisible(a, { projectId: P1, sourceId: SRC_ORG })).toEqual(
      await repository.get(a, SRC_ORG),
    );
    expect(await visible(P1, SRC_ORG)).toMatchObject({
      ok: true,
      value: { id: SRC_ORG, projectId: null, hasCredential: false },
    });
  });

  it('hides an absent source', async () => {
    expect(await repository.getVisible(a, { projectId: P1, sourceId: SRC_NEW })).toBeNull();
    expect(await visible(P1, SRC_NEW)).toEqual({ ok: false, error: 'not_found' });
  });

  it('hides a source owned by another project', async () => {
    await executor.batch([seedSource(SRC_P1, 'foreign', { project_id: P2 })]);
    expect(await repository.getVisible(a, { projectId: P1, sourceId: SRC_P1 })).toBeNull();
    expect(await visible(P1, SRC_P1)).toEqual({ ok: false, error: 'not_found' });
  });

  it('hides a source in another organization', async () => {
    await executor.batch([seedSource(SRC_ORG, 'foreign')]);
    expect(await repository.getVisible(b, { projectId: P1, sourceId: SRC_ORG })).toBeNull();
    expect(await visible(P1, SRC_ORG, b)).toEqual({ ok: false, error: 'not_found' });
  });

  it('hides a source of an archived project', async () => {
    await executor.batch([seedSource(SRC_P1, 'archived', { project_id: P_ARCHIVED })]);
    expect(await repository.getVisible(a, { projectId: P_ARCHIVED, sourceId: SRC_P1 })).toBeNull();
    expect(await visible(P_ARCHIVED, SRC_P1)).toEqual({ ok: false, error: 'not_found' });
  });

  it('hides an attached organization source from an archived project', async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'shared'),
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        a.orgId,
        P_ARCHIVED,
        SRC_ORG,
      ),
    ]);
    expect(await repository.getVisible(a, { projectId: P_ARCHIVED, sourceId: SRC_ORG })).toBeNull();
    expect(await visible(P_ARCHIVED, SRC_ORG)).toEqual({ ok: false, error: 'not_found' });
  });

  it('hides an unattached organization source', async () => {
    await executor.batch([seedSource(SRC_ORG, 'unattached')]);
    expect(await repository.getVisible(a, { projectId: P1, sourceId: SRC_ORG })).toBeNull();
    expect(await visible(P1, SRC_ORG)).toEqual({ ok: false, error: 'not_found' });
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

  it('exposes credential_unavailable in the DTO and clears it after recovery', async () => {
    expect(
      await repository.pollState(a, guard, {
        id: SRC_ORG,
        outcome: 'failure',
        error: 'credential_unavailable',
      }),
    ).toBe('written');
    const service = createSourceService({
      sources: repository,
      providerAnchors: ANCHORS,
    } as unknown as Parameters<typeof createSourceService>[0]);
    const actor = {
      kind: 'org' as const,
      actor: {
        kind: 'organization' as const,
        userId: ORG_ADMIN,
        isOrganizationAdmin: true,
        permissions: new Set(['org:sources:read'] as const),
      },
    };
    const list = () => service.list(a, actor, { cursor: null, limit: 10 });
    expect(await list()).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            lastError: 'credential_unavailable',
            lastPolledAt: expect.any(String),
            nextPollAt: expect.any(String),
          },
        ],
      },
    });
    expect(await repository.pollState(a, guard, success)).toBe('written');
    expect(await list()).toMatchObject({ ok: true, value: { items: [{ lastError: null }] } });
  });

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
      await repository.update(b, orgFence(), {
        audit: [stagedAudit('source.update')],
        ...target,
        changes: { pollIntervalSeconds: 5 },
      }),
    ).toBe('forbidden');
    expect(
      await repository.resume(b, orgFence(), {
        audit: stagedAudit('source.resume'),
        ...target,
        id: SRC_PROXY,
      }),
    ).toBe('forbidden');
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

describe('source repository lookup', () => {
  async function insert(
    id: string,
    configJson = JSON.stringify({ provider: 'github', repository: 'Acme/Widget' }),
    options: { org?: OrgContext; projectId?: string; type?: string } = {},
  ) {
    await executor.batch([
      stmt(
        `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, config_json)
         VALUES (?, ?, ?, ?, 'composer', ?, ?)`,
        id,
        (options.org ?? a).orgId,
        options.projectId ?? null,
        id,
        options.type ?? 'vcs',
        configJson,
      ),
    ]);
  }

  async function lookup(repositoryName = 'acme/widget', provider = 'github') {
    const counted = countCalls(executor);
    const result = await createSourceRepository(counted.executor).findByRepository(a, {
      provider,
      repository: repositoryName,
    });
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    return result;
  }

  it('finds the stored id with either repository case and compares providers exactly', async () => {
    await insert('LOOKUP-ORG');
    expect(await lookup()).toEqual(await createSourceRepository(executor).get(a, 'LOOKUP-ORG'));
    expect((await lookup('ACME/WIDGET'))?.id).toBe('LOOKUP-ORG');
    expect(await lookup('acme/widget', 'git')).toBeNull();
    expect(await lookup('acme/widget', 'GitHub')).toBeNull();
    expect(await lookup('acme/missing')).toBeNull();
  });

  it('does not find a matching source of another real organization', async () => {
    await insert('LOOKUP-FOREIGN', undefined, { org: b });
    expect(await lookup()).toBeNull();
  });

  it('ignores non-vcs, malformed and non-object configurations without throwing', async () => {
    await insert('LOOKUP-NON-VCS', undefined, { type: 'composer_repository' });
    await executor.all(stmt('PRAGMA ignore_check_constraints = ON'));
    for (const [index, config] of ['{broken', 'null', '[]', '"Acme/Widget"', '42'].entries()) {
      await insert(`LOOKUP-INVALID-${String(index)}`, config);
    }
    await executor.all(stmt('PRAGMA ignore_check_constraints = OFF'));
    expect(await lookup()).toBeNull();
    await insert('LOOKUP-VALID');
    expect((await lookup())?.id).toBe('LOOKUP-VALID');
  });

  it('finds project and organization sources and returns the lower id regardless of insertion order', async () => {
    const projectId = 'LOOKUP-PROJECT';
    await executor.batch([
      stmt(
        'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
        projectId,
        a.orgId,
        'lookup-project',
        'Lookup',
      ),
    ]);
    await insert('LOOKUP-Z-PROJECT', undefined, { projectId });
    expect(await lookup()).toMatchObject({ id: 'LOOKUP-Z-PROJECT', projectId });
    await insert('LOOKUP-A-ORG');
    expect(await lookup()).toMatchObject({ id: 'LOOKUP-A-ORG', projectId: null });
    await insert('LOOKUP-0-PROJECT', undefined, { projectId });
    expect(await lookup()).toMatchObject({ id: 'LOOKUP-0-PROJECT', projectId });
  });
});

describe('source attachment counts', () => {
  beforeEach(async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'attached'),
      seedSource(SRC_PROXY, 'unattached'),
      seedSource(SRC_NEW, 'next-page'),
      ...[P1, P2, P_ARCHIVED].map((projectId) =>
        stmt(
          'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
          a.orgId,
          projectId,
          SRC_ORG,
        ),
      ),
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        a.orgId,
        P2,
        SRC_NEW,
      ),
    ]);
  });

  const query = (sourceIds: readonly string[], allProjects = false, includeArchived = false) => ({
    sourceIds,
    userId: P1_MAINTAINER,
    allProjects,
    includeArchived,
    providerAnchors: ANCHORS,
  });

  it('counts only readable active projects, excluding hidden and archived attachments', async () => {
    expect(await repository.countAttachedProjects(a, query([SRC_ORG]))).toEqual(
      new Map([[SRC_ORG, 1]]),
    );
    await executor.batch([stmt('DELETE FROM access_grant WHERE project_id = ?', P1)]);
    expect(await repository.countAttachedProjects(a, query([SRC_ORG]))).toEqual(new Map());
  });

  it('intersects attachment visibility with the token project cap, including empty caps', async () => {
    const input = query([SRC_ORG], true, true);
    expect(await repository.countAttachedProjects(a, { ...input, restrictTo: [P1] })).toEqual(
      new Map([[SRC_ORG, 1]]),
    );
    expect(await repository.countAttachedProjects(a, { ...input, restrictTo: [] })).toEqual(
      new Map(),
    );
    expect(await repository.countAttachedProjects(b, { ...input, restrictTo: [P1] })).toEqual(
      new Map(),
    );
    expect(
      await repository.countAttachedProjects(a, { ...query([SRC_ORG]), restrictTo: [P2] }),
    ).toEqual(new Map());
  });

  it('returns the full count for an organization administrator, including archived projects', async () => {
    expect(await repository.countAttachedProjects(a, query([SRC_ORG], true, true))).toEqual(
      new Map([[SRC_ORG, 3]]),
    );
  });

  it('counts only projects in a service token scope using its own read authority', async () => {
    await executor.batch([
      stmt(
        'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        'service-1',
        a.orgId,
        'source-reader',
        P2,
        ORG_ADMIN,
        'active',
      ),
      stmt(
        'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
        a.orgId,
        'service-1',
        'project:read',
      ),
    ]);
    const input = {
      ...query([SRC_ORG, SRC_NEW]),
      userId: 'service-1',
      servicePrincipalId: 'service-1',
    };
    expect(await repository.countAttachedProjects(a, input)).toEqual(
      new Map([
        [SRC_ORG, 1],
        [SRC_NEW, 1],
      ]),
    );
    await executor.batch([
      stmt('UPDATE service_principal SET project_id = NULL WHERE id = ?', 'service-1'),
    ]);
    expect(await repository.countAttachedProjects(a, input)).toEqual(
      new Map([
        [SRC_ORG, 2],
        [SRC_NEW, 1],
      ]),
    );
    expect(await repository.countAttachedProjects(b, input)).toEqual(new Map());
    await executor.batch([
      stmt('UPDATE service_principal SET status = ? WHERE id = ?', 'suspended', 'service-1'),
    ]);
    expect(await repository.countAttachedProjects(a, input)).toEqual(new Map());
    await executor.batch([
      stmt('UPDATE service_principal SET status = ? WHERE id = ?', 'active', 'service-1'),
    ]);
    await executor.batch([
      stmt('DELETE FROM service_principal_permission WHERE service_principal_id = ?', 'service-1'),
    ]);
    expect(await repository.countAttachedProjects(a, input)).toEqual(new Map());
  });

  it('counts active projects for inherited organization project read authority', async () => {
    expect(await repository.countAttachedProjects(a, query([SRC_ORG], true))).toEqual(
      new Map([[SRC_ORG, 2]]),
    );
  });

  it('returns no count rows for zero attachments or a foreign organization', async () => {
    expect(await repository.countAttachedProjects(a, query([SRC_PROXY], true))).toEqual(new Map());
    expect(await repository.countAttachedProjects(b, query([SRC_ORG], true))).toEqual(new Map());
  });

  it('uses one grouped read per page and counts only that page, including 100 source ids', async () => {
    const counted = countCalls(executor);
    const store = createSourceRepository(counted.executor);
    const first = await store.list(a, { projectId: null, after: null, limit: 2 });
    expect(
      await store.countAttachedProjects(
        a,
        query(
          first.slice(0, 2).map((row) => row.id),
          true,
        ),
      ),
    ).toEqual(new Map([[SRC_ORG, 2]]));
    const second = await store.list(a, { projectId: null, after: SRC_PROXY, limit: 2 });
    expect(
      await store.countAttachedProjects(
        a,
        query(
          second.map((row) => row.id),
          true,
        ),
      ),
    ).toEqual(new Map([[SRC_NEW, 1]]));
    expect(counted.counts()).toEqual({ all: 4, batch: 0 });
    expect(
      await store.countAttachedProjects(
        a,
        query([SRC_ORG, ...Array.from({ length: 99 }, (_, n) => `missing-${String(n)}`)]),
      ),
    ).toEqual(new Map([[SRC_ORG, 1]]));
    expect(
      await store.countAttachedProjects(
        a,
        query([SRC_ORG, ...Array.from({ length: 99 }, (_, n) => `missing-${String(n)}`)], true),
      ),
    ).toEqual(new Map([[SRC_ORG, 2]]));
    expect(counted.counts()).toEqual({ all: 6, batch: 0 });
  });
});

describe('source paginated list and pause', () => {
  function pauseInput(id = SRC_ORG) {
    return {
      id,
      providerAnchors: ANCHORS,
      audit: {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        occurredAt: NOW,
        action: 'source.pause' as const,
        actor: { type: 'user' as const, id: ORG_ADMIN },
        tokenSelector: null,
        sourceIp: '192.0.2.1',
        target: { type: 'source', id },
        projectId: null,
        payloadJson: '{}',
      },
    };
  }

  it('requests immediate polling without changing the daily interval and stages an audit', async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'daily', {
        status: 'degraded',
        next_poll_at: at(86400),
        poll_interval_seconds: 86400,
      }),
    ]);
    const input = {
      ...pauseInput(),
      audit: { ...pauseInput().audit, action: 'source.sync_requested' as const },
    };
    expect(await repository.syncNow(a, orgFence(), input)).toBe('requested');
    const row = await repository.get(a, SRC_ORG);
    expect(near(row?.nextPollAt, 0)).toBe(true);
    expect(row).toMatchObject({ status: 'degraded', pollIntervalSeconds: 86400 });
    expect(await rows('SELECT action FROM audit_pending WHERE org_id = ?', a.orgId)).toEqual([
      { action: 'source.sync_requested' },
    ]);
  });

  it.each(['packagist_proxy', 'npmjs_proxy'])(
    'bumps the epoch on %s Sync now to invalidate negative entries',
    async (type) => {
      await executor.batch([seedSource(SRC_ORG, 'proxy', { status: 'active', type })]);
      const before = await rows('SELECT version FROM cache_epoch WHERE org_id = ?', a.orgId);
      expect(before).toHaveLength(1);
      expect(await repository.syncNow(a, orgFence(), pauseInput())).toBe('requested');
      expect(await rows('SELECT version FROM cache_epoch WHERE org_id = ?', a.orgId)).not.toEqual(
        before,
      );
    },
  );

  it('preserves cache epoch on sync requests and changes it on served-content updates', async () => {
    await executor.batch([seedSource(SRC_ORG, 'daily', { status: 'active' })]);
    const epoch = () => rows('SELECT version FROM cache_epoch WHERE org_id = ?', a.orgId);
    const before = await epoch();
    expect(before).toHaveLength(1);
    expect(await repository.syncNow(a, orgFence(), pauseInput())).toBe('requested');
    expect(await epoch()).toEqual(before);
    expect(
      await repository.syncNow(a, orgFence(), {
        ...pauseInput(),
        audit: { ...pauseInput().audit, id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' },
      }),
    ).toBe('requested');
    expect(await epoch()).toEqual(before);
    expect(
      await repository.update(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        audit: [stagedAudit('source.update')],
        changes: { url: 'https://updated.example.test' },
      }),
    ).toBe('paused_for_reactivation');
    expect(await epoch()).not.toEqual(before);
  });

  it('does not schedule paused, foreign or unauthorized sources', async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'paused', { status: 'paused', next_poll_at: at(86400) }),
    ]);
    const before = await snapshot();
    expect(await repository.syncNow(a, orgFence(), pauseInput())).toBe('source_paused');
    expect(await repository.syncNow(b, orgFence(), pauseInput())).toBe('forbidden');
    expect(await repository.syncNow(a, p1Fence(), pauseInput())).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('rechecks paused status inside the sync fence', async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'racing', { status: 'active', next_poll_at: at(86400) }),
    ]);
    const before = (await repository.get(a, SRC_ORG))!.nextPollAt;
    const racing: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        await executor.batch([
          stmt("UPDATE source SET status = 'paused' WHERE org_id = ? AND id = ?", a.orgId, SRC_ORG),
        ]);
        return executor.batch(statements);
      },
    };
    expect(await createSourceRepository(racing).syncNow(a, orgFence(), pauseInput())).toBe(
      'source_paused',
    );
    expect((await repository.get(a, SRC_ORG))!.nextPollAt).toBe(before);
    expect(await rows('SELECT action FROM audit_pending WHERE org_id = ?', a.orgId)).toEqual([]);
  });

  it('rolls back a sync request when staging its audit fails', async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'daily', { status: 'active', next_poll_at: at(86400) }),
    ]);
    const before = await snapshot();
    expect(
      await repository.syncNow(a, orgFence(), {
        ...pauseInput(),
        audit: { ...pauseInput().audit, payloadJson: 'invalid-json' },
      }),
    ).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('lists in id order without repeating rows when an earlier source is inserted', async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'one'),
      seedSource(SRC_PROXY, 'three'),
      seedSource(SRC_NEW, 'nine'),
    ]);
    const first = await repository.list(a, { projectId: null, after: null, limit: 1 });
    expect(first.map((row) => row.id)).toEqual([SRC_ORG, SRC_PROXY]);
    await executor.batch([seedSource('01J0SOURCE0000000000000000', 'zero')]);
    const second = await repository.list(a, { projectId: null, after: first[0]!.id, limit: 1 });
    expect(second.map((row) => row.id)).toEqual([SRC_PROXY, SRC_NEW]);
    expect(await repository.list(b, { projectId: null, after: null, limit: 100 })).toEqual([]);
    expect(JSON.stringify(first)).not.toMatch(/ciphertext|nonce|sealed/);
  });

  it('lists project-owned and attached organization sources, excluding other owners and unattached sources', async () => {
    await executor.batch([
      seedSource(SRC_ORG, 'shared'),
      seedSource(SRC_PROXY, 'hidden'),
      seedSource(SRC_P1, 'owned', { project_id: P1 }),
      seedSource(SRC_NEW, 'other', { project_id: P2 }),
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        a.orgId,
        P1,
        SRC_ORG,
      ),
    ]);
    expect(
      (await repository.list(a, { projectId: P1, after: null, limit: 100 })).map((row) => row.id),
    ).toEqual([SRC_ORG, SRC_P1]);
    expect(
      (await repository.list(a, { projectId: null, after: null, limit: 100 })).map((row) => row.id),
    ).toEqual([SRC_ORG, SRC_PROXY]);
    expect(await repository.list(b, { projectId: P1, after: null, limit: 100 })).toEqual([]);
    await executor.batch([stmt("UPDATE project SET status = 'archived' WHERE id = ?", P1)]);
    expect(await repository.list(a, { projectId: P1, after: null, limit: 100 })).toEqual([]);
  });

  it.each(['organization', 'project', 'all'] as const)(
    'paginates %s ownership within the organization',
    async (ownership) => {
      await executor.batch([
        seedSource('foreign-source', 'foreign', { org_id: b.orgId }),
        seedSource(SRC_ORG, 'shared'),
        seedSource(SRC_P1, 'owned', { project_id: P1 }),
        seedSource(SRC_NEW, 'other', { project_id: P2 }),
      ]);
      const expected =
        ownership === 'organization'
          ? [SRC_ORG]
          : ownership === 'project'
            ? [SRC_P1, SRC_NEW]
            : [SRC_ORG, SRC_P1, SRC_NEW];
      const ids: string[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await repository.list(a, { projectId: null, ownership, after, limit: 1 });
        if (!page[0]) break;
        ids.push(page[0].id);
        expect(page[0].projectName).toBe(
          page[0].projectId === null ? null : page[0].projectId === P1 ? 'one' : 'two',
        );
        after = page[0].id;
      }
      expect(ids).toEqual(expected);
      expect(
        (await repository.list(b, { projectId: null, ownership, after: null, limit: 100 })).map(
          (row) => row.id,
        ),
      ).toEqual(ownership === 'project' ? [] : ['foreign-source']);
    },
  );

  it.each(['project', 'all'] as const)(
    'applies caller project visibility before %s pagination',
    async (ownership) => {
      await executor.batch([
        seedSource(SRC_ORG, 'shared'),
        seedSource(SRC_P1, 'one', { project_id: P1 }),
        seedSource(SRC_PROXY, 'archived', { project_id: P_ARCHIVED }),
        seedSource(SRC_NEW, 'two', { project_id: P2 }),
      ]);
      const service = createSourceService({
        sources: repository,
        providerAnchors: ANCHORS,
      } as unknown as Parameters<typeof createSourceService>[0]);
      const cases = [
        { userId: P1_MAINTAINER, admin: false, inherited: false, expected: [SRC_P1] },
        { userId: ORG_ADMIN, admin: false, inherited: false, expected: [] },
        { userId: ORG_ADMIN, admin: false, inherited: true, expected: [SRC_P1, SRC_NEW] },
        {
          userId: ORG_ADMIN,
          admin: true,
          inherited: false,
          expected: [SRC_P1, SRC_PROXY, SRC_NEW],
        },
        { userId: ORG_ADMIN, admin: true, inherited: false, restrictTo: [P2], expected: [SRC_NEW] },
        { userId: ORG_ADMIN, admin: true, inherited: false, restrictTo: [], expected: [] },
      ];
      for (const scenario of cases) {
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const result = await service.list(
            a,
            {
              kind: 'org',
              ...('restrictTo' in scenario ? { restrictTo: scenario.restrictTo } : {}),
              actor: {
                kind: 'organization',
                userId: scenario.userId,
                isOrganizationAdmin: scenario.admin,
                permissions: new Set([
                  'org:sources:read',
                  ...(scenario.inherited ? ['project:read'] : []),
                ]),
              },
            },
            { ownership, cursor, limit: 1 },
          );
          if (!result.ok) throw new Error('expected source page');
          ids.push(...result.value.items.map((row) => row.id));
          cursor = result.value.next;
        } while (cursor !== null);
        expect(ids).toEqual(
          ownership === 'all' ? [SRC_ORG, ...scenario.expected] : scenario.expected,
        );
      }
    },
  );

  it('uses stored service project read authority for project-owned source rows', async () => {
    await executor.batch([
      seedSource(SRC_P1, 'one', { project_id: P1 }),
      seedSource(SRC_NEW, 'two', { project_id: P2 }),
      stmt(
        'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        'source-service',
        a.orgId,
        'source-reader',
        P2,
        ORG_ADMIN,
        'active',
      ),
    ]);
    const query = {
      projectId: null,
      ownership: 'project' as const,
      after: null,
      limit: 100,
      projectVisibility: {
        userId: 'source-service',
        servicePrincipalId: 'source-service',
        allProjects: true,
        includeArchived: false,
        providerAnchors: ANCHORS,
      },
    };
    expect(await repository.list(a, query)).toEqual([]);
    await executor.batch([
      stmt(
        'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
        a.orgId,
        'source-service',
        'project:read',
      ),
    ]);
    expect((await repository.list(a, query)).map((row) => row.id)).toEqual([SRC_NEW]);
    expect(await repository.list(b, query)).toEqual([]);
    await executor.batch([
      stmt("UPDATE service_principal SET status = 'suspended' WHERE id = ?", 'source-service'),
    ]);
    expect(await repository.list(a, query)).toEqual([]);
  });

  it.each(['organization', 'project', 'all'] as const)(
    'keeps %s list statements under the parameter limit',
    (ownership) => {
      for (const projectId of [null, P1]) {
        expect(
          listSourcesStatement(a, {
            projectId,
            ownership,
            after: SRC_ORG,
            limit: 100,
            projectVisibility: {
              userId: P1_MAINTAINER,
              allProjects: false,
              includeArchived: false,
              restrictTo: Array.from({ length: 150 }, (_, index) => `project-${index}`),
              providerAnchors: ANCHORS,
            },
          }).params.length,
        ).toBeLessThanOrEqual(100);
      }
    },
  );

  it.each([0, 101, 1.5])('rejects repository list limit %s', async (limit) => {
    await expect(repository.list(a, { projectId: null, after: null, limit })).rejects.toThrow(
      RangeError,
    );
  });

  describe('pause idempotency', () => {
    function record(): IdempotencyRecord {
      return {
        principalKey: `user:${ORG_ADMIN}`,
        key: 'pause-operation',
        route: '/sources/pause',
        requestHash: 'a'.repeat(64),
        status: 200,
        responseJson: '{"ok":true}',
        createdAt: NOW,
        expiresAt: '2999-01-01T00:00:00.000Z',
      };
    }

    const find = (saved: IdempotencyRecord) =>
      createIdempotencyRepository(executor).find(a, saved.principalKey, saved.key, NOW);
    const state = () =>
      Promise.all(
        ['source', 'audit_pending', 'api_idempotency'].map((table) =>
          rows(`SELECT * FROM ${table} WHERE org_id = ? ORDER BY 1, 2`, a.orgId),
        ),
      );

    it('persists pause idempotency and replays after another user enables the source', async () => {
      await executor.batch([
        seedSource(SRC_PROXY, 'proxy', { type: 'packagist_proxy', status: 'active' }),
        grant('01J0GRANT000000000000000A6', 'm1@example.test', ORG_ROLE, null),
      ]);
      const saved = record();
      const invoke = () =>
        repository.pause(a, orgFence(), { ...pauseInput(SRC_PROXY), idempotency: saved });
      expect(await invoke()).toBe('paused');
      expect(await find(saved)).toEqual(saved);
      expect(
        await repository.resume(a, p1Fence(), {
          audit: stagedAudit('source.resume'),
          id: SRC_PROXY,
          providerAnchors: ANCHORS,
        }),
      ).toBe('resumed');
      const before = await state();
      expect(
        await settleIdempotent({
          record: saved,
          hash: saved.requestHash,
          now: new Date(NOW),
          find: () => find(saved),
          run: invoke,
          failed: (result) => result !== 'paused',
        }),
      ).toEqual({ kind: 'replay', record: saved });
      expect(await state()).toEqual(before);
      expect(await repository.get(a, SRC_PROXY)).toMatchObject({ status: 'active' });
    });

    it.each(['a', 'b'])(
      'rejects a direct pause retry with hash %s without effects',
      async (hash) => {
        await executor.batch([seedSource(SRC_ORG, 'due', { status: 'active' })]);
        const saved = record();
        expect(await repository.pause(a, orgFence(), { ...pauseInput(), idempotency: saved })).toBe(
          'paused',
        );
        await executor.batch([
          stmt("UPDATE source SET status = 'active' WHERE org_id = ? AND id = ?", a.orgId, SRC_ORG),
        ]);
        const before = await state();
        expect(
          await repository.pause(a, orgFence(), {
            ...pauseInput(),
            audit: { ...pauseInput().audit, id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' },
            idempotency: { ...saved, requestHash: hash.repeat(64) },
          }),
        ).toBe('conflict');
        expect(await find(saved)).toEqual(saved);
        expect(await state()).toEqual(before);
      },
    );

    it.each(['a', 'b'])('fences a concurrent pause key winner with hash %s', async (hash) => {
      await executor.batch([seedSource(SRC_ORG, 'due', { status: 'active' })]);
      const winner = record();
      const racing: SqlExecutor = {
        driver: executor.driver,
        all: (statement) => executor.all(statement),
        batch: async (statements) => {
          await executor.batch([idempotencyInsertStatement(a, winner)]);
          return executor.batch(statements);
        },
      };
      const before = await state();
      expect(
        await createSourceRepository(racing).pause(a, orgFence(), {
          ...pauseInput(),
          idempotency: { ...winner, requestHash: hash.repeat(64) },
        }),
      ).toBe('conflict');
      expect((await state()).slice(0, 2)).toEqual(before.slice(0, 2));
      expect(await find(winner)).toEqual(winner);
    });

    it.each(['audit', 'after-record'])(
      'rolls back pause idempotency on %s failure',
      async (failure) => {
        await executor.batch([seedSource(SRC_ORG, 'due', { status: 'active' })]);
        if (failure === 'audit')
          await executor.batch([
            stmt(
              'CREATE TRIGGER reject_idempotent_pause_audit BEFORE INSERT ON audit_pending BEGIN INSERT INTO source (id, org_id, name, ecosystem, type) SELECT id, org_id, name, ecosystem, type FROM source; END',
            ),
          ]);
        const failing: SqlExecutor = {
          driver: executor.driver,
          all: (statement) => executor.all(statement),
          batch: (statements) =>
            executor.batch([
              ...statements,
              stmt("INSERT INTO access_mutation_guard (key) VALUES ('injected'), ('injected')"),
            ]),
        };
        const before = await state();
        expect(
          await createSourceRepository(failure === 'audit' ? executor : failing).pause(
            a,
            orgFence(),
            {
              ...pauseInput(),
              idempotency: record(),
            },
          ),
        ).toBe('conflict');
        expect(await state()).toEqual(before);
      },
    );

    it.each(['expired', 'organization', 'principal'])(
      'accepts a pause key with an %s record',
      async (scope) => {
        await executor.batch([seedSource(SRC_ORG, 'due', { status: 'active' })]);
        const saved = record();
        const previous = {
          ...saved,
          ...(scope === 'expired'
            ? { createdAt: '2026-10-13T00:00:00.000Z', expiresAt: '2026-10-14T00:00:00.000Z' }
            : {}),
          ...(scope === 'principal' ? { principalKey: 'user:other' } : {}),
        };
        await executor.batch([
          idempotencyInsertStatement(scope === 'organization' ? b : a, previous),
        ]);
        expect(await repository.pause(a, orgFence(), { ...pauseInput(), idempotency: saved })).toBe(
          'paused',
        );
        expect(await find(saved)).toEqual(saved);
        if (scope !== 'expired')
          expect(
            await createIdempotencyRepository(executor).find(
              scope === 'organization' ? b : a,
              previous.principalKey,
              previous.key,
              NOW,
            ),
          ).toEqual(previous);
      },
    );

    it('checks pause authority before a reused idempotency key', async () => {
      await executor.batch([
        seedSource(SRC_ORG, 'due', { status: 'active' }),
        idempotencyInsertStatement(a, record()),
      ]);
      await executor.batch([
        stmt('DELETE FROM role_permission WHERE org_id = ? AND role_id = ?', a.orgId, ORG_ROLE),
      ]);
      const before = await state();
      expect(
        await repository.pause(a, orgFence(), { ...pauseInput(), idempotency: record() }),
      ).toBe('forbidden');
      expect(await state()).toEqual(before);
    });
  });

  it('pause stops scheduling and writes an audit in the same batch', async () => {
    await executor.batch([seedSource(SRC_ORG, 'due', { status: 'active', next_poll_at: at(-60) })]);
    expect((await repository.listDue(a, 10)).map((row) => row.id)).toEqual([SRC_ORG]);
    expect(await repository.pause(a, orgFence(), pauseInput())).toBe('paused');
    expect(await repository.get(a, SRC_ORG)).toMatchObject({ status: 'paused' });
    expect(await repository.listDue(a, 10)).toEqual([]);
    expect(await rows('SELECT org_id, action, target_id FROM audit_pending')).toEqual([
      { org_id: a.orgId, action: 'source.pause', target_id: SRC_ORG },
    ]);
  });

  it('permits a project owner to pause its own source', async () => {
    await executor.batch([seedSource(SRC_P1, 'project', { project_id: P1, status: 'active' })]);
    expect(
      await repository.pause(a, p1Fence(), {
        ...pauseInput(SRC_P1),
        audit: { ...pauseInput(SRC_P1).audit, projectId: P1 },
      }),
    ).toBe('paused');
    expect(await repository.get(a, SRC_P1)).toMatchObject({ status: 'paused' });
  });

  it('refuses a reader without changing status or writing an audit', async () => {
    await executor.batch([seedSource(SRC_P1, 'project', { project_id: P1, status: 'active' })]);
    const before = await snapshot();
    expect(await repository.pause(a, fenceFor(P1_READER, S_READER), pauseInput(SRC_P1))).toBe(
      'forbidden',
    );
    expect(await snapshot()).toBe(before);
    expect(await rows('SELECT * FROM audit_pending')).toEqual([]);
  });

  it('rolls back pause when audit persistence fails', async () => {
    await executor.batch([seedSource(SRC_ORG, 'due', { status: 'active' })]);
    await executor.batch([
      stmt(
        'CREATE TRIGGER reject_pause_audit BEFORE INSERT ON audit_pending BEGIN INSERT INTO source (id, org_id, name, ecosystem, type) SELECT id, org_id, name, ecosystem, type FROM source; END',
      ),
    ]);
    expect(await repository.pause(a, orgFence(), pauseInput())).toBe('conflict');
    expect(await repository.get(a, SRC_ORG)).toMatchObject({ status: 'active' });
    expect(await rows('SELECT * FROM audit_pending')).toEqual([]);
  });

  it('rechecks live authority inside the fenced batch', async () => {
    await executor.batch([seedSource(SRC_ORG, 'due', { status: 'active' })]);
    let revoked = false;
    const racing: SqlExecutor = {
      ...executor,
      all: executor.all.bind(executor),
      async batch(statements) {
        if (!revoked) {
          revoked = true;
          await executor.batch([
            stmt('DELETE FROM role_permission WHERE org_id = ? AND role_id = ?', a.orgId, ORG_ROLE),
          ]);
        }
        return executor.batch(statements);
      },
    };
    expect(await createSourceRepository(racing).pause(a, orgFence(), pauseInput())).toBe(
      'forbidden',
    );
    expect(await repository.get(a, SRC_ORG)).toMatchObject({ status: 'active' });
    expect(await rows('SELECT * FROM audit_pending')).toEqual([]);
  });

  it('answers not_found for absent targets with organization authority', async () => {
    expect(await repository.pause(a, orgFence(), pauseInput())).toBe('not_found');
    expect(await rows('SELECT * FROM audit_pending')).toEqual([]);
  });

  it('answers not_found for foreign targets with organization authority and writes nothing', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'foreign', 'npm', 'npmjs_proxy')",
        SRC_ORG,
        b.orgId,
      ),
    ]);
    const before = await snapshot();
    expect(await repository.pause(a, orgFence(), pauseInput())).toBe('not_found');
    expect(await snapshot()).toBe(before);
    expect(await rows('SELECT * FROM audit_pending')).toEqual([]);
  });
});
