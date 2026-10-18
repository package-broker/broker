import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { orgContext, type Statement } from '@package-broker/core/db/port';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  guardBindings,
  protectedHolder,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { holdsPermission, lookupSessionStatement, permissionRows } from './access.js';

const D1_MAX_BOUND_PARAMETERS = 100;

const org = orgContext('01J00000000000000000000A0A');

const ANCHORS: readonly ProtectedHolderProvider[] = Array.from({ length: 8 }, (_, index) => ({
  provider: `idp${index}`,
  anchor: `https://idp${index}.example.test/"quoted"/'single'/\\`,
  emailAuthoritative: index % 2 === 0,
  emailAuthoritativeDomains: ['example.test'],
}));

const SELECTED_PROJECTS = JSON.stringify(
  Array.from({ length: 200 }, (_, index) => `01J0PROJECT${String(index).padStart(15, '0')}`),
);

function boundParameters(statement: Statement): number {
  return statement.params.length;
}

function maxBound(statements: readonly Statement[]): number {
  return Math.max(...statements.map(boundParameters));
}

function asStatement(condition: Guard): Statement {
  return compile(db.selectFrom('organization').select('organization.id').where(condition));
}

function holds(permission: string, project: string) {
  return holdsPermission(org, {
    userId: sql.ref<string>('issuing_user.id'),
    permission,
    projectId: sql.ref<string>(project),
    providerAnchors: ANCHORS,
    projectState: 'active',
    session: '01J0SESSION000000000000001',
  });
}

describe('bound parameters stay within the D1 limit with 8 provider anchors', () => {
  it('counts the bound parameters of a compiled statement', () => {
    expect(
      boundParameters(
        compile(db.selectFrom('organization').select('id').where('id', 'in', ['a', 'b', 'c'])),
      ),
    ).toBe(3);
  });

  for (const boundary of ['project', 'organization'] as const) {
    it(`lookupSession on a ${boundary} boundary`, () => {
      const statement = lookupSessionStatement(org, {
        secretHash: 'a'.repeat(64),
        boundary,
        projectSlug: 'alpha',
        providerAnchors: ANCHORS,
      });
      expect(boundParameters(statement)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    });
  }

  it('holdsPermission inside assertGuard', () => {
    const guard = assertGuard(
      holdsPermission(org, {
        userId: '01J0USER000000000000000001',
        permission: 'project:packages:write',
        projectId: '01J0PROJECT0000000000000P1',
        providerAnchors: ANCHORS,
        projectState: 'active',
        session: '01J0SESSION000000000000001',
      }),
      org,
    ) as unknown as readonly Statement[];
    expect(maxBound(guard)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });

  it('two holdsPermission conditions over 200 selected projects in one guard', () => {
    const condition = sql<boolean>`exists (
      select 1 from user_account as issuing_user
      where issuing_user.org_id = ${org.orgId}
        and not exists (
          select 1 from json_each(${SELECTED_PROJECTS}) as selected_item
          where not (${holds('project:packages:read', 'selected_item.value')})
            or not (${holds('project:packages:write', 'selected_item.value')})))`;
    expect(maxBound(assertCheck(condition))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });

  it('protectedHolder with every exclusion', () => {
    const statement = compile(
      db
        .selectFrom('user_account as u')
        .select('u.id')
        .where((eb) =>
          protectedHolder(org, eb.ref('u.id'), {
            kind: 'fresh',
            now: '2026-10-16T12:00:00.000Z',
            providers: ANCHORS,
            exclude: {
              grantId: '01J0GRANT00000000000000001',
              userId: '01J0USER000000000000000002',
              identityId: '01J0IDENT00000000000000001',
              membership: {
                userId: '01J0USER000000000000000003',
                provider: 'idp1',
                groupName: 'admins',
              },
            },
          }),
        ),
    );
    expect(boundParameters(statement)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });

  it('permissionRows used twice in one condition', () => {
    const rows = () =>
      permissionRows(org, '01J0USER000000000000000001', '01J0PROJECT0000000000000P1', ANCHORS);
    const condition = sql<boolean>`exists (select 1 from ${rows().as('first_rows')})
      and exists (select 1 from ${rows().as('second_rows')})`;
    expect(boundParameters(asStatement(condition))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });

  it('does not grow with the number of provider anchors', () => {
    const lookup = (providerAnchors: readonly ProtectedHolderProvider[]) =>
      boundParameters(
        lookupSessionStatement(org, {
          secretHash: 'a'.repeat(64),
          boundary: 'project',
          projectSlug: 'alpha',
          providerAnchors,
        }),
      );
    const guard = (providerAnchors: readonly ProtectedHolderProvider[]) =>
      boundParameters(
        asStatement(
          holdsPermission(org, {
            userId: '01J0USER000000000000000001',
            permission: 'project:packages:write',
            projectId: '01J0PROJECT0000000000000P1',
            providerAnchors,
            projectState: 'active',
            session: '01J0SESSION000000000000001',
          }),
        ),
      );
    const holder = (providers: readonly ProtectedHolderProvider[]) =>
      boundParameters(
        compile(
          db
            .selectFrom('user_account as u')
            .select('u.id')
            .where((eb) =>
              protectedHolder(org, eb.ref('u.id'), {
                kind: 'fresh',
                now: '2026-10-16T12:00:00.000Z',
                providers,
              }),
            ),
        ),
      );
    for (const count of ANCHORS.keys()) {
      const providers = ANCHORS.slice(0, count + 1);
      expect(lookup(providers)).toBe(lookup(ANCHORS));
      expect(guard(providers)).toBe(guard(ANCHORS));
      expect(holder(providers)).toBe(holder(ANCHORS));
    }
  });
});

describe('holdsPermission negation', () => {
  const U1 = '01J0USER000000000000000001';
  const P_ACTIVE = '01J0PROJECT0000000000000P1';
  const P_ARCHIVED = '01J0PROJECT0000000000000P2';
  const VIEWER = '01J0ROLEVIEWER0000000000AA';
  const OWNER = '01J0ROLEOWNER00000000000AA';
  const anchors: ProtectedHolderProvider[] = ANCHORS.map((entry, index) =>
    index === 0
      ? {
          provider: 'oidc',
          anchor: 'https://idp.example.test',
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test'],
        }
      : entry,
  );
  let database: MigratedDatabase;
  let seeded: typeof org;

  function st(text: string, ...params: Statement['params']): Statement {
    return { sql: text, params };
  }

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    if (database.orgs === null) throw new Error('two organizations were not seeded');
    seeded = database.orgs.a;
    const id = seeded.orgId;
    const grant = (grantId: string, role: string, projectId: string | null) =>
      st(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, 'email', 'u1@example.test', NULL, ?, ?, ?)",
        grantId,
        id,
        projectId === null ? 'organization' : 'project',
        projectId,
        role,
      );
    await database.executor.batch([
      st(
        'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        id,
        'oidc',
        'https://idp.example.test',
      ),
      st(
        "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'viewer', 'viewer', 'organization', 0)",
        VIEWER,
        id,
      ),
      st(
        "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'owner', 'owner', 'project', 0)",
        OWNER,
        id,
      ),
      st(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'project:read')",
        id,
        VIEWER,
      ),
      st(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'project:packages:write')",
        id,
        OWNER,
      ),
      st(
        "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'u1@example.test', 'active')",
        U1,
        id,
      ),
      st(
        "INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, 'alpha', 'alpha', 'active')",
        P_ACTIVE,
        id,
      ),
      st(
        "INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, 'beta', 'beta', 'archived')",
        P_ARCHIVED,
        id,
      ),
      st(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('01J0IDENT00000000000000001', ?, ?, 'oidc', 'subject-1', 'u1@example.test', 1, ?)",
        id,
        U1,
        new Date(Date.now() - 3600_000).toISOString(),
      ),
      grant('01J0GRANT00000000000000001', VIEWER, null),
      grant('01J0GRANT00000000000000002', OWNER, P_ACTIVE),
      grant('01J0GRANT00000000000000003', OWNER, P_ARCHIVED),
    ]);
  });

  afterEach(async () => {
    await database.close();
  });

  it('eb.not(holdsPermission) with an active project is the logical negation', async () => {
    const cases: [string, string, string, boolean][] = [];
    for (const userId of [U1, '01J0USER00000000000000000X']) {
      for (const projectId of [P_ACTIVE, P_ARCHIVED, '01J0PROJECT00000000000000X']) {
        for (const permission of [
          'project:read',
          'project:packages:write',
          'project:settings:write',
        ]) {
          const expected =
            userId === U1 && projectId === P_ACTIVE && permission !== 'project:settings:write';
          cases.push([userId, projectId, permission, expected]);
        }
      }
    }
    for (const [userId, projectId, permission, expected] of cases) {
      const guard = () =>
        holdsPermission(seeded, {
          userId,
          permission,
          projectId,
          providerAnchors: anchors,
          projectState: 'active',
        });
      const rows = await database.executor.all<{ held: number; negated: number }>(
        compile(
          db.selectNoFrom((eb) => [
            eb.case().when(guard()).then(1).else(0).end().as('held'),
            eb.case().when(eb.not(guard())).then(1).else(0).end().as('negated'),
          ]),
        ),
      );
      const label = `${userId} ${projectId} ${permission}`;
      expect(rows[0]?.held, label).toBe(expected ? 1 : 0);
      expect(rows[0]?.negated, label).toBe(expected ? 0 : 1);
    }
  });
});

describe('guardBindings', () => {
  it('refuses names that are not SQL identifiers', () => {
    for (const names of [
      { values: 'guard values', anchors: 'guard_anchors' },
      { values: 'guard_values', anchors: 'x"; drop table role; --' },
      { values: '', anchors: 'guard_anchors' },
    ]) {
      expect(() => guardBindings(names, { org_id: org.orgId }, ANCHORS)).toThrow(TypeError);
    }
    expect(() =>
      guardBindings(
        { values: 'guard_values', anchors: 'guard_anchors' },
        { org_id: org.orgId },
        ANCHORS,
      ),
    ).not.toThrow();
  });
});
