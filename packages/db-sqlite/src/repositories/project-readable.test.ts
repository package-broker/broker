import { seedStatements } from '../testing/seed-statements.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext, Permission } from '@package-broker/core/authz/administration';
import { createProjectLister } from '@package-broker/core/authz/project-list';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { sql, type Kysely } from 'kysely';
import { compile, db } from '../kysely.js';
import {
  createAccessRepository,
  holdsPermission,
  permissionRows,
  type ProtectedHolderProvider,
} from './access.js';
import { createProjectRepository } from './project.js';
import {
  createReadableProjectRepository,
  listReadableProjectsStatement,
} from './project-readable.js';

const HOUR = 3600_000;
const ANCHOR = 'https://idp.example.test';
const OIDC: ProtectedHolderProvider = {
  provider: 'oidc',
  anchor: ANCHOR,
  emailAuthoritative: true,
};
const OTHER: ProtectedHolderProvider = {
  provider: 'other',
  anchor: 'https://other.example.test',
  emailAuthoritative: false,
};
const ANCHORS = [OIDC, OTHER];

const ORG_READER = '01J0R0LE000000000000000001';
const ORG_VIEWER = '01J0R0LE000000000000000002';
const PROJECT_READER = '01J0R0LE000000000000000003';
const PROJECT_WRITER = '01J0R0LE000000000000000004';
const ORG_READER_B = '01J0R0LE000000000000000005';

const U1 = '01J0USER000000000000000001';
const U2 = '01J0USER000000000000000002';
const UB = '01J0USER00000000000000000B';

let database: MigratedDatabase;
let executor: SqlExecutor;
let a: OrgContext;
let b: OrgContext;
let counter = 0;
const looseDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function hash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

function seq(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(26 - prefix.length, '0')}`;
}

function projectId(n: number): string {
  return `01J0PR0J${String(n).padStart(18, '0')}`;
}

async function seed(...statements: Statement[]): Promise<void> {
  await seedStatements(executor, statements);
}

function role(
  org: OrgContext,
  id: string,
  scope: 'organization' | 'project',
  permissions: readonly string[],
  protects = 0,
): Statement[] {
  return [
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      org.orgId,
      `role-${id.toLowerCase()}`,
      id,
      scope,
      protects,
    ),
    ...permissions.map((permission) =>
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        org.orgId,
        id,
        permission,
      ),
    ),
  ];
}

function user(org: OrgContext, id: string, email: string, status = 'active'): Statement {
  return stmt(
    'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
    id,
    org.orgId,
    email,
    status,
  );
}

function project(org: OrgContext, n: number, status = 'active'): Statement {
  return stmt(
    'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
    projectId(n),
    org.orgId,
    `p${n}`,
    `Project ${n}`,
    status,
  );
}

function grant(
  org: OrgContext,
  type: 'email' | 'group',
  value: string,
  roleId: string,
  options: { readonly provider?: string; readonly projectId?: string } = {},
): Statement {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    seq('01J0GRANT'),
    org.orgId,
    type,
    value,
    type === 'group' ? (options.provider ?? 'oidc') : null,
    options.projectId === undefined ? 'organization' : 'project',
    options.projectId ?? null,
    roleId,
  );
}

function identity(
  org: OrgContext,
  userId: string,
  email: string,
  options: {
    readonly id?: string;
    readonly provider?: string;
    readonly verified?: number;
    readonly validatedAt?: string;
  } = {},
): Statement {
  const id = options.id ?? seq('01J0IDENT');
  return stmt(
    'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    userId,
    options.provider ?? 'oidc',
    `subject-${id}`,
    email,
    options.verified ?? 1,
    options.validatedAt ?? at(-HOUR),
  );
}

function member(
  org: OrgContext,
  userId: string,
  group: string,
  options: { readonly provider?: string; readonly refreshedAt?: string } = {},
): Statement {
  return stmt(
    'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
    org.orgId,
    userId,
    options.provider ?? 'oidc',
    group,
    options.refreshedAt ?? at(-HOUR),
  );
}

function session(
  org: OrgContext,
  userId: string,
  label: string,
  identityId: string | null,
  id = seq('01J0SESSION'),
): Statement {
  return stmt(
    'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    userId,
    identityId,
    hash(label),
    hash('csrf'),
    at(-60_000),
    at(8 * HOUR),
  );
}

function localLogin(org: OrgContext, userId: string): Statement[] {
  const credentialId = seq('01J0CRED');
  return [
    stmt(
      'INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, ?, ?, ?, ?, ?)',
      credentialId,
      org.orgId,
      'totp',
      new Uint8Array([1]),
      new Uint8Array(12),
      1,
      'aad',
    ),
    stmt(
      'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
      userId,
      org.orgId,
      'pbkdf2-sha256$test',
      credentialId,
      at(-HOUR),
      at(-HOUR),
    ),
  ];
}

function binding(org: OrgContext, provider: string, anchor: string): Statement {
  return stmt(
    'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    org.orgId,
    provider,
    anchor,
  );
}

function repository(target: SqlExecutor = executor) {
  return createReadableProjectRepository(target, { providerAnchors: ANCHORS });
}

async function listAll(
  org: OrgContext,
  userId: string,
  limit: number,
  status: 'active' | 'archived' = 'active',
) {
  const repo = repository();
  const seen: string[] = [];
  let afterId: string | undefined;
  for (;;) {
    const rows = await repo.listReadableProjects(
      org,
      { userId },
      { ...(afterId === undefined ? {} : { afterId }), limit, status },
    );
    seen.push(...rows.map((row) => row.id));
    if (rows.length < limit) return seen;
    afterId = rows[rows.length - 1]?.id;
  }
}

beforeEach(async () => {
  counter = 0;
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  await seed(
    ...role(a, ORG_READER, 'organization', ['org:read', 'project:read']),
    ...role(a, ORG_VIEWER, 'organization', ['org:read', 'project:write']),
    ...role(a, PROJECT_READER, 'project', ['project:read']),
    ...role(a, PROJECT_WRITER, 'project', ['project:write']),
    ...role(b, ORG_READER_B, 'organization', ['project:read']),
    binding(a, 'oidc', ANCHOR),
    binding(a, 'other', OTHER.anchor),
    binding(b, 'oidc', ANCHOR),
  );
});

afterEach(async () => {
  await database.close();
});

const FULL_KEY_AFTER =
  '(org_id=? AND subject_type=? AND subject_provider=? AND subject_value=? AND project_id>?)';

async function planOf(statement: Statement): Promise<string[]> {
  const plan = await executor.all<{ detail: string }>({
    sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
    params: statement.params,
  });
  return plan.map((row) => row.detail);
}

/**
 * Grant and project rows are always reached by key. With statistics, SQLite may scan the
 * single-row user and role tables of a test database, so those checks apply only to plans
 * built without them.
 */
async function expectIndexedPlan(statement: Statement, smallTablesByKey: boolean): Promise<void> {
  const details = await planOf(statement);
  expect(details).toContain(`SEARCH ge USING INDEX access_grant_subject ${FULL_KEY_AFTER}`);
  expect(details).toContain(`SEARCH gg USING INDEX access_grant_subject ${FULL_KEY_AFTER}`);
  expect(details.filter((d) => /access_grant/.test(d) && !d.includes(FULL_KEY_AFTER))).toEqual([]);
  for (const alias of ['pe', 'pg']) {
    expect(details).toContain(`SEARCH ${alias} USING INDEX sqlite_autoindex_project_1 (id=?)`);
  }
  expect(details.filter((d) => /^SCAN (ge|gg|pe|pg)\b/.test(d))).toEqual([]);
  if (!smallTablesByKey) return;
  expect(details).toContain('SEARCH gm USING PRIMARY KEY (user_id=?)');
  for (const alias of ['eu', 'gu']) {
    expect(details).toContain(`SEARCH ${alias} USING INDEX sqlite_autoindex_user_account_1 (id=?)`);
  }
  for (const alias of ['er', 'gr']) {
    expect(details).toContain(`SEARCH ${alias} USING INDEX sqlite_autoindex_role_1 (id=?)`);
  }
  for (const alias of ['ep', 'gp']) {
    expect(details).toContain(`SEARCH ${alias} USING PRIMARY KEY (role_id=? AND permission=?)`);
  }
  expect(details.filter((d) => /^SCAN (eu|er|ep|gm|gu|gr|gp)\b/.test(d))).toEqual([]);
}

describe('listReadableProjects', () => {
  beforeEach(async () => {
    await seed(
      user(a, U1, 'u1@example.test'),
      user(a, U2, 'u2@example.test'),
      user(b, UB, 'u1@example.test'),
      identity(a, U1, 'u1@example.test'),
      identity(b, UB, 'u1@example.test'),
      ...[1, 2, 3, 4, 5].map((n) => project(a, n)),
      project(a, 6, 'archived'),
      project(b, 7),
    );
  });

  it('returns projects granted by e-mail and by a fresh group, projected to four fields', async () => {
    await seed(
      member(a, U1, 'team'),
      grant(a, 'email', 'u1@example.test', PROJECT_READER, { projectId: projectId(2) }),
      grant(a, 'group', 'team', PROJECT_READER, { projectId: projectId(4) }),
      grant(a, 'email', 'u1@example.test', PROJECT_WRITER, { projectId: projectId(3) }),
      grant(a, 'email', 'u2@example.test', PROJECT_READER, { projectId: projectId(5) }),
    );
    const rows = await repository().listReadableProjects(
      a,
      { userId: U1 },
      { limit: 10, status: 'active' },
    );
    expect(rows).toEqual([
      { id: projectId(2), slug: 'p2', name: 'Project 2', status: 'active' },
      { id: projectId(4), slug: 'p4', name: 'Project 4', status: 'active' },
    ]);
  });

  it('leaves organization project:read to the caller and never crosses organizations', async () => {
    await seed(
      grant(a, 'email', 'u1@example.test', ORG_READER),
      grant(b, 'email', 'u1@example.test', ORG_READER_B),
      grant(a, 'email', 'u1@example.test', PROJECT_READER, { projectId: projectId(6) }),
    );
    expect(await listAll(a, U1, 2)).toEqual([]);
    expect(await listAll(a, U1, 2, 'archived')).toEqual([projectId(6)]);
    expect(await listAll(b, UB, 2)).toEqual([]);
  });

  it('ignores stale group evidence, unverified e-mail, a suspended user and an organization grant without project:read', async () => {
    await seed(
      member(a, U1, 'stale', { refreshedAt: at(-30 * HOUR) }),
      grant(a, 'group', 'stale', PROJECT_READER, { projectId: projectId(1) }),
      grant(a, 'email', 'u1@example.test', ORG_VIEWER),
      identity(a, U2, 'u2@example.test', { verified: 0 }),
      grant(a, 'email', 'u2@example.test', PROJECT_READER, { projectId: projectId(2) }),
    );
    expect(await listAll(a, U1, 10)).toEqual([]);
    expect(await listAll(a, U2, 10)).toEqual([]);
    await seed(
      grant(a, 'email', 'u1@example.test', PROJECT_READER, { projectId: projectId(3) }),
      stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U1),
    );
    expect(await listAll(a, U1, 10)).toEqual([]);
  });

  it('dedupes a project granted several ways before the limit applies, and honours the cursor', async () => {
    await seed(
      member(a, U1, 'team'),
      member(a, U1, 'crew'),
      grant(a, 'email', 'u1@example.test', PROJECT_READER, { projectId: projectId(1) }),
      grant(a, 'email', 'u1@example.test', PROJECT_READER, { projectId: projectId(2) }),
      grant(a, 'group', 'team', PROJECT_READER, { projectId: projectId(2) }),
      grant(a, 'group', 'crew', PROJECT_READER, { projectId: projectId(2) }),
      grant(a, 'group', 'team', PROJECT_READER, { projectId: projectId(3) }),
      grant(a, 'group', 'crew', PROJECT_READER, { projectId: projectId(3) }),
      grant(a, 'group', 'crew', PROJECT_READER, { projectId: projectId(4) }),
    );
    const rows = await repository().listReadableProjects(
      a,
      { userId: U1 },
      { afterId: projectId(1), limit: 2, status: 'active' },
    );
    expect(rows.map((row) => row.id)).toEqual([2, 3].map(projectId));
  });

  it.each([
    [{ limit: 0, status: 'active' }],
    [{ limit: 201, status: 'active' }],
    [{ limit: 1.5, status: 'active' }],
    [{ limit: 5, status: 'deleted' }],
    [{ limit: 5, status: 'active', afterId: 'not-a-ulid' }],
  ])('refuses page %j', async (page) => {
    await expect(
      repository().listReadableProjects(a, { userId: U1 }, page as never),
    ).rejects.toThrow(TypeError);
  });
});

describe('scale', () => {
  it('returns one readable project at row 10,040 behind 10,050 hidden ones and 15,000 group grants, with and without statistics', async () => {
    const hidden = 10_050;
    const target = 10_040;
    const statements: Statement[] = [
      user(a, U1, 'u1@example.test'),
      user(a, U2, 'u2@example.test'),
      identity(a, U1, 'u1@example.test'),
      identity(a, U2, 'u2@example.test'),
      member(a, U1, 'team'),
      member(a, U2, 'team'),
      member(a, U2, 'others'),
      grant(a, 'email', 'u1@example.test', ORG_VIEWER),
    ];
    let groupGrants = 0;
    for (let n = 1; n <= hidden + 1; n += 1) {
      statements.push(project(a, n));
      if (n === target) {
        statements.push(
          grant(a, 'email', 'u1@example.test', PROJECT_READER, { projectId: projectId(n) }),
        );
        continue;
      }
      if (n % 3 === 0) {
        statements.push(
          grant(a, 'email', 'u2@example.test', PROJECT_READER, { projectId: projectId(n) }),
        );
      }
      if (n % 2 === 0) {
        statements.push(grant(a, 'group', 'team', PROJECT_WRITER, { projectId: projectId(n) }));
        groupGrants += 1;
      }
      statements.push(grant(a, 'group', 'others', PROJECT_READER, { projectId: projectId(n) }));
      groupGrants += 1;
    }
    expect(groupGrants).toBeGreaterThanOrEqual(15_000);
    await seed(...statements);

    const after = listReadableProjectsStatement(
      a,
      { userId: U1 },
      { afterId: projectId(0), limit: 200, status: 'active' },
      ANCHORS,
    );
    for (const analysed of [false, true]) {
      if (analysed) await database.analyze();
      await expectIndexedPlan(after, !analysed);
      const counted = countCalls(executor);
      const repo = repository(counted.executor);
      const started = performance.now();
      const page = await repo.listReadableProjects(
        a,
        { userId: U1 },
        { limit: 200, status: 'active' },
      );
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(page.map((row) => row.id)).toEqual([projectId(target)]);
      expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    }

    const repo = repository();
    const single = await repo.listReadableProjects(
      a,
      { userId: U1 },
      { limit: 1, status: 'active' },
    );
    expect(single.map((row) => row.id)).toEqual([projectId(target)]);

    const lister = createProjectLister({
      source: createProjectRepository(executor),
      readable: repo,
    });
    const actor: ActorContext = {
      kind: 'organization',
      userId: U1,
      permissions: new Set<Permission>(['org:read', 'project:write']),
      isOrganizationAdmin: false,
    };
    const result = await lister.list(a, actor, { limit: 1 });
    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          {
            id: projectId(target),
            slug: `p${target}`,
            name: `Project ${target}`,
            status: 'active',
          },
        ],
        nextAfterId: projectId(target),
      },
    });
    const ids = JSON.stringify(result).match(/01J0PR0J\d+/g) ?? [];
    expect(new Set(ids)).toEqual(new Set([projectId(target)]));
    expect(await lister.list(a, actor, { limit: 1, afterId: projectId(target) })).toEqual({
      ok: true,
      value: { items: [], nextAfterId: null },
    });
  }, 120_000);
});

describe('query shape', () => {
  it('uses indexes on project and grant tables and binds fewer than 100 parameters', async () => {
    const statement = listReadableProjectsStatement(
      a,
      { userId: U1 },
      { afterId: projectId(1), limit: 200, status: 'active' },
      [
        ...ANCHORS,
        { provider: 'third', anchor: 'https://third.example.test', emailAuthoritative: true },
      ],
    );
    expect(statement.params.length).toBeLessThan(100);
    await expectIndexedPlan(statement, true);
  });
});

function mulberry32(seedValue: number): () => number {
  let state = seedValue >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function projectScopeRead(userId: string, n: number): Promise<boolean> {
  const rows = permissionRows(a, userId, projectId(n), ANCHORS);
  const [row] = await executor.all<{ held: number }>(
    compile(
      looseDb.selectNoFrom(
        sql<number>`exists ${looseDb
          .selectFrom(rows.as('oracle_rows'))
          .select(sql.lit(1).as('one'))
          .where('oracle_rows.scope', '=', 'project')
          .where('oracle_rows.permission', '=', 'project:read')}`.as('held'),
      ),
    ),
  );
  return row?.held === 1;
}

async function holdsAnyStatus(userId: string, n: number, sessionId: string): Promise<boolean> {
  const guard = holdsPermission(a, {
    userId,
    permission: 'project:read',
    projectId: projectId(n),
    providerAnchors: ANCHORS,
    projectState: 'any',
    session: sessionId,
  });
  const [row] = await executor.all<{ held: number }>(
    compile(looseDb.selectNoFrom(sql<number>`${guard}`.as('held'))),
  );
  return row?.held === 1;
}

describe('oracle against the access engine', () => {
  const USERS = 4;
  const PROJECTS = 14;
  const GROUPS = ['g1', 'g2', 'g3'];
  const ORG_PROTECTED = '01J0R0LE000000000000000009';

  it.each(Array.from({ length: 24 }, (_, i) => i + 1))(
    'agrees per project for layout %i',
    async (layoutSeed) => {
      const random = mulberry32(layoutSeed * 7919);
      const pick = <T>(values: readonly T[]): T =>
        values[Math.floor(random() * values.length)] as T;
      const statements: Statement[] = [
        ...role(a, ORG_PROTECTED, 'organization', ['org:read', 'project:read'], 1),
      ];
      const users = Array.from({ length: USERS }, (_, i) => ({
        id: `01J0USER0000000000000000${String(i + 10)}`,
        email: `user${i}@example.test`,
        label: `layout-${layoutSeed}-${i}`,
        sessionId: seq('01J0SESSION'),
      }));
      for (let n = 1; n <= PROJECTS; n += 1) {
        statements.push(project(a, n, random() < 0.3 ? 'archived' : 'active'));
      }
      for (const entry of users) {
        statements.push(user(a, entry.id, entry.email, random() < 0.1 ? 'suspended' : 'active'));
        const identityId = seq('01J0IDENT');
        const hasIdentity = random() < 0.7;
        if (hasIdentity) {
          statements.push(
            identity(a, entry.id, entry.email, {
              id: identityId,
              verified: random() < 0.85 ? 1 : 0,
              validatedAt: random() < 0.8 ? at(-HOUR) : at(-30 * HOUR),
            }),
          );
        }
        if (random() < 0.3) {
          statements.push(
            identity(a, entry.id, entry.email, { provider: 'other', validatedAt: at(-HOUR) }),
          );
        }
        if (random() < 0.4) statements.push(...localLogin(a, entry.id));
        for (const group of GROUPS) {
          if (random() < 0.45) {
            statements.push(
              member(a, entry.id, group, {
                provider: random() < 0.8 ? 'oidc' : 'other',
                refreshedAt: random() < 0.8 ? at(-HOUR) : at(-30 * HOUR),
              }),
            );
          }
        }
        statements.push(
          session(
            a,
            entry.id,
            entry.label,
            hasIdentity && random() < 0.5 ? identityId : null,
            entry.sessionId,
          ),
        );
      }
      const subjects = [
        ...users.map((entry) => ({ type: 'email' as const, value: entry.email })),
        ...GROUPS.map((g) => ({ type: 'group' as const, value: g })),
      ];
      const used = new Set<string>();
      for (let i = 0; i < 20; i += 1) {
        const subject = pick(subjects);
        const organization = random() < 0.2;
        const target = organization ? null : projectId(1 + Math.floor(random() * PROJECTS));
        const provider = subject.type === 'group' ? pick(['oidc', 'other']) : undefined;
        const key = `${subject.type}|${provider ?? ''}|${subject.value}|${target ?? 'org'}`;
        if (used.has(key)) continue;
        used.add(key);
        const roleId = organization
          ? pick([ORG_READER, ORG_VIEWER, ORG_PROTECTED])
          : pick([PROJECT_READER, PROJECT_WRITER]);
        statements.push(
          grant(a, subject.type, subject.value, roleId, {
            ...(provider === undefined ? {} : { provider }),
            ...(target === null ? {} : { projectId: target }),
          }),
        );
      }
      await seed(...statements);

      const statuses = new Map<number, string>();
      const projectRows = await executor.all<{ id: string; status: string }>(
        stmt('SELECT id, status FROM project WHERE org_id = ?', a.orgId),
      );
      for (let n = 1; n <= PROJECTS; n += 1) {
        statuses.set(n, projectRows.find((row) => row.id === projectId(n))?.status ?? '');
      }

      const access = createAccessRepository(executor);
      const lister = createProjectLister({
        source: createProjectRepository(executor),
        readable: repository(),
      });
      for (const entry of users) {
        for (const status of ['active', 'archived'] as const) {
          const scoped: string[] = [];
          for (let n = 1; n <= PROJECTS; n += 1) {
            if (statuses.get(n) === status && (await projectScopeRead(entry.id, n))) {
              scoped.push(projectId(n));
            }
          }
          expect(await listAll(a, entry.id, 3, status)).toEqual(scoped);
        }

        const organization = await access.lookupSession(a, {
          secretHash: hash(entry.label),
          boundary: 'organization',
          projectSlug: null,
          providerAnchors: ANCHORS,
        });
        if (organization === null) continue;
        const actor: ActorContext = {
          kind: 'organization',
          userId: entry.id,
          permissions: new Set(organization.organizationPermissions as Permission[]),
          isOrganizationAdmin: true,
        };

        for (const status of ['active', 'archived'] as const) {
          const expected: string[] = [];
          for (let n = 1; n <= PROJECTS; n += 1) {
            if (statuses.get(n) !== status) continue;
            if (status === 'active') {
              const found = await access.lookupSession(a, {
                secretHash: hash(entry.label),
                boundary: 'project',
                projectSlug: `p${n}`,
                providerAnchors: ANCHORS,
              });
              if (found === null || found.project === null) continue;
              const effective = new Set([
                ...found.projectPermissions,
                ...found.organizationPermissions.filter((name) => name.startsWith('project:')),
              ]);
              if (effective.has('project:read')) expected.push(projectId(n));
            } else if (await holdsAnyStatus(entry.id, n, entry.sessionId)) {
              expected.push(projectId(n));
            }
          }
          const listed: string[] = [];
          let afterId: string | undefined;
          for (;;) {
            const result = await lister.list(a, actor, {
              limit: 2,
              status,
              ...(afterId === undefined ? {} : { afterId }),
            });
            if (!result.ok) throw new Error(result.error);
            listed.push(...result.value.items.map((item) => item.id));
            if (result.value.nextAfterId === null) break;
            afterId = result.value.nextAfterId;
          }
          expect(listed).toEqual(expected);
        }
      }
    },
  );
});
