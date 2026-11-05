import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { expect } from 'vitest';
import { compile, db } from '../../kysely.js';
import { sql, type Kysely } from 'kysely';
import {
  holdsPermission,
  lookupSessionStatement,
  lookupTokenStatement,
  tokenAccessCondition,
  permissionRows,
} from '../../repositories/access.js';
import {
  sessionOfForeignUser,
  HASH,
  seedUser,
  OTHER_HASH,
  FUTURE,
  type Layer,
  seedBindings,
  seedSubject,
  ANCHORS,
  seedProject,
  type Subject,
  PROJECT_PERMISSION,
  held,
  PERMISSION_ROWS,
  ref,
  NOT_NULL,
  ALWAYS,
  GROUP_BRANCH,
  permissionRowsWaiver,
} from './fixtures.js';

const sessionLookupIgnoresForeign: ContractCase = {
  name: 'a session lookup does not return a session of another organization',
  async run(context) {
    const { own } = orgOf(context);
    await sessionOfForeignUser(context);
    const rows = await context.executor.all(
      context.mutate(
        lookupSessionStatement(own, {
          secretHash: HASH,
          boundary: 'organization',
          projectSlug: null,
          providerAnchors: [],
        }),
      ),
    );
    expect(rows).toEqual([]);
  },
};

const sessionJoinsForeignUser: ContractCase = {
  name: 'a session does not join a user of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedUser(seed, 'U-FOREIGN', foreign.orgId);
    await seed(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      'SES-OWN',
      own.orgId,
      'U-FOREIGN',
      HASH,
      OTHER_HASH,
      FUTURE,
    );
    expect(await sessionLookupRows(context)).toEqual([]);
  },
};

const sessionJoinsForeignIdentity: ContractCase = {
  name: 'a session does not join an identity of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedUser(seed, 'U-OWN', own.orgId);
    await seed(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES ('I-FOREIGN', ?, 'U-OWN', 'oidc', 'sub', 'x@example.test')",
      foreign.orgId,
    );
    await seed.forged(
      'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'SES-OWN',
      own.orgId,
      'U-OWN',
      'I-FOREIGN',
      HASH,
      OTHER_HASH,
      FUTURE,
    );
    expect(await sessionLookupRows(context)).toEqual([]);
  },
};

async function sessionLookupRows(context: CaseContext): Promise<unknown[]> {
  return context.executor.all(
    context.mutate(
      lookupSessionStatement(orgOf(context).own, {
        secretHash: HASH,
        boundary: 'organization',
        projectSlug: null,
        providerAnchors: [],
      }),
    ),
  );
}

const tokenJoinsForeignUser: ContractCase = {
  name: 'a token does not join a user of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedUser(seed, 'U-FOREIGN', foreign.orgId);
    await seed(
      `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at)
        VALUES (?, ?, 'pat', ?, ?, 1, 'ci', '["read"]', ?, ?)`,
      'TOK-OWN',
      own.orgId,
      'abcdefabcdef',
      HASH,
      'U-FOREIGN',
      FUTURE,
    );
    const rows = await context.executor.all<{ principal_status: string | null }>(
      context.mutate(
        lookupTokenStatement(own, {
          selector: 'abcdefabcdef',
          boundary: 'organization',
          projectSlug: null,
          providerAnchors: [],
        }),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.principal_status).toBeNull();
  },
};

const tokenLookupIgnoresForeign: ContractCase = {
  name: 'a token lookup does not return a token of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedUser(seed, 'U-FOREIGN', foreign.orgId);
    await seed(
      `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at)
        VALUES (?, ?, 'pat', ?, ?, 1, 'ci', '["read"]', ?, ?)`,
      'TOK-FOREIGN',
      foreign.orgId,
      'abcdefabcdef',
      HASH,
      'U-FOREIGN',
      FUTURE,
    );
    const rows = await context.executor.all(
      context.mutate(
        lookupTokenStatement(own, {
          selector: 'abcdefabcdef',
          boundary: 'organization',
          projectSlug: null,
          providerAnchors: [],
        }),
      ),
    );
    expect(rows).toEqual([]);
  },
};

const LAYERS: readonly Layer[] = ['user', 'grant', 'role', 'permission', 'identity', 'binding'];

const loose = db as unknown as Kysely<Record<string, Record<string, unknown>>>;

const rowsCase = (layer: Layer): ContractCase => ({
  name: `a ${layer} row of another organization yields no permission row`,
  async run(context) {
    const { own } = orgOf(context);
    await seedBindings(context);
    const control = await seedSubject(context, 'ok');
    const bad = await seedSubject(context, 'bad', { mismatched: layer });
    const rowsOf = (userId: string, mutated: boolean) => {
      const statement = compile(
        loose
          .selectFrom(permissionRows(own, userId, null, ANCHORS).as('pr'))
          .select('pr.permission' as never),
      );
      return context.executor.all(mutated ? context.mutate(statement) : statement);
    };
    expect((await rowsOf(control.userId, false)).length).toBeGreaterThan(0);
    expect(await rowsOf(bad.userId, true)).toEqual([]);
  },
});

const holdsForeignProject: ContractCase = {
  name: 'a project of another organization is not an active project for holdsPermission',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    await seedProject(seed, 'P-OWN', own.orgId);
    await seedProject(seed, 'P-FOREIGN', foreign.orgId);
    const control = await seedSubject(context, 'ok', { projectId: 'P-OWN' });
    const bad = await seedSubject(context, 'bad', { projectId: 'P-FOREIGN' });
    const guardFor = (subject: Subject, projectId: string) =>
      holdsPermission(own, {
        userId: subject.userId,
        permission: PROJECT_PERMISSION,
        projectId,
        providerAnchors: ANCHORS,
        projectState: 'active',
      });
    expect(await held(context, guardFor(control, 'P-OWN'), false)).toBe(true);
    expect(await held(context, guardFor(bad, 'P-FOREIGN'), true)).toBe(false);
  },
};

const lookupSessionEntry: MutationEntry = {
  builder: 'lookupSessionStatement',
  file: 'repositories/access.ts',
  cases: [sessionLookupIgnoresForeign, sessionJoinsForeignUser, sessionJoinsForeignIdentity],
  waivers: [{ locate: /"guard_\w+"\."org_id" = /, reason: PERMISSION_ROWS }],
  predicates: [
    {
      name: 'session rows are scoped to the organization',
      locate: ref('s', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: sessionLookupIgnoresForeign.name,
    },
    {
      name: 'the user joins within the session organization',
      locate: ref('u', 'org_id', '"s"\\."org_id"'),
      neutral: ALWAYS,
      caseName: sessionJoinsForeignUser.name,
    },
    {
      name: 'the identity joins within the session organization',
      locate: ref('i', 'org_id', '"s"\\."org_id"'),
      neutral: ALWAYS,
      caseName: sessionJoinsForeignIdentity.name,
    },
  ],
};

const lookupTokenEntry: MutationEntry = {
  builder: 'lookupTokenStatement',
  file: 'repositories/access.ts',
  cases: [tokenLookupIgnoresForeign, tokenJoinsForeignUser],
  waivers: [
    { locate: /"guard_\w+"\."org_id" = /, reason: PERMISSION_ROWS },
    {
      locate: /\bev_[il]\.org_id = \?/,
      reason:
        'validation evidence subqueries are also bound by the token identity or user id; no case yet pairs them with a row of another organization',
    },
    {
      locate: ref('spp', 'org_id', '\\?'),
      reason:
        'service permission rows are also bound by the principal id; no case yet pairs them with a row of another organization',
    },
    {
      locate: ref('sp', 'org_id', '"t"\\."org_id"'),
      reason: 'no case yet binds a token to a service principal of another organization',
    },
  ],
  predicates: [
    {
      name: 'token rows are scoped to the organization',
      locate: ref('t', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: tokenLookupIgnoresForeign.name,
    },
    {
      name: 'the user joins within the token organization',
      locate: ref('u', 'org_id', '"t"\\."org_id"'),
      neutral: ALWAYS,
      caseName: tokenJoinsForeignUser.name,
    },
  ],
};

const tokenConditionIsolation: ContractCase = {
  name: 'the typed token condition excludes foreign tokens',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'CONDITION-FOREIGN', foreign.orgId);
    await seed(
      `INSERT INTO token (id,org_id,kind,selector,hash,pepper_version,name,scopes_json,user_id,expires_at)
      VALUES ('CONDITION-TOKEN',?,'pat','abcdefabcdef',?,1,'ci','["read"]','CONDITION-FOREIGN',?)`,
      foreign.orgId,
      HASH,
      FUTURE,
    );
    const condition = tokenAccessCondition(
      own,
      {
        selector: 'abcdefabcdef',
        boundary: 'organization',
        projectSlug: null,
        providerAnchors: [],
      },
      sql<boolean>`1`,
    );
    const rows = await context.executor.all(
      context.mutate(compile(db.selectNoFrom(sql<number>`${condition}`.as('allowed')))),
    );
    expect(rows).toEqual([{ allowed: 0 }]);
  },
};
const tokenConditionEntry: MutationEntry = {
  ...lookupTokenEntry,
  builder: 'tokenAccessCondition',
  cases: [tokenConditionIsolation],
  waivers: [
    ...(lookupTokenEntry.waivers ?? []),
    {
      locate: ref('u', 'org_id', '"t"\\."org_id"'),
      reason:
        'The same tokenLookupQuery user join is independently mutation-tested by lookupTokenStatement.',
    },
  ],
  predicates: [
    {
      name: 'typed token condition is organization-scoped',
      locate: ref('t', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: tokenConditionIsolation.name,
    },
  ],
};

const SELECT_ORG = '\\(select "guard_values"\\."org_id" from "guard_values"\\)';

const permissionRowsEntry: MutationEntry = {
  builder: 'permissionRows',
  file: 'repositories/access.ts',
  cases: LAYERS.map(rowsCase),
  waivers: [
    {
      locate: /"guard_user"\."org_id" = "guard_member"\."org_id"/,
      reason: GROUP_BRANCH,
    },
    {
      locate: /"guard_grant"\."org_id" = "guard_member"\."org_id"/,
      reason: GROUP_BRANCH,
    },
    { locate: /"guard_member"\."org_id" = \(select/, reason: GROUP_BRANCH },
  ],
  predicates: [
    {
      name: 'the user is scoped to the organization',
      locate: ref('guard_user', 'org_id', SELECT_ORG),
      neutral: ALWAYS,
      caseName: rowsCase('user').name,
      waivedCopies: { 1: GROUP_BRANCH },
    },
    {
      name: 'the grant joins within the user organization',
      locate: ref('guard_grant', 'org_id', '"guard_user"\\."org_id"'),
      neutral: ALWAYS,
      caseName: rowsCase('grant').name,
    },
    {
      name: 'the role joins within the grant organization',
      locate: ref('guard_role', 'org_id', '"guard_grant"\\."org_id"'),
      neutral: ALWAYS,
      caseName: rowsCase('role').name,
      waivedCopies: { 1: GROUP_BRANCH },
    },
    {
      name: 'the permission joins within the role organization',
      locate: ref('guard_perm', 'org_id', '"guard_role"\\."org_id"'),
      neutral: ALWAYS,
      caseName: rowsCase('permission').name,
      waivedCopies: { 1: GROUP_BRANCH },
    },
    {
      name: 'the identity is scoped to the organization',
      locate: ref('guard_identity', 'org_id', SELECT_ORG),
      neutral: ALWAYS,
      caseName: rowsCase('identity').name,
      waivedCopies: { 1: GROUP_BRANCH },
    },
    {
      name: 'the provider binding is scoped to the organization',
      locate: ref('guard_binding', 'org_id', SELECT_ORG),
      neutral: ALWAYS,
      caseName: rowsCase('binding').name,
      waivedCopies: { 1: GROUP_BRANCH },
    },
  ],
};

const holdsPermissionEntry: MutationEntry = {
  builder: 'holdsPermission',
  file: 'repositories/access.ts',
  cases: [holdsForeignProject],
  waivers: [permissionRowsWaiver],
  predicates: [
    {
      name: 'the project is scoped to the organization',
      locate: ref('hp_project', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: holdsForeignProject.name,
    },
  ],
};

export const entries: readonly MutationEntry[] = [
  lookupSessionEntry,
  lookupTokenEntry,
  tokenConditionEntry,
  permissionRowsEntry,
  holdsPermissionEntry,
];
