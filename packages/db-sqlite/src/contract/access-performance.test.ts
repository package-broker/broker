import { describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import {
  createAccessRepository,
  lookupSessionStatement,
  lookupTokenStatement,
  type AccessBoundary,
} from '../repositories/access.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { countCalls } from './count-calls.js';
import { batchInChunks } from '../testing/chunked-batch.js';

const providers = [
  {
    provider: 'first',
    anchor: 'https://first.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
  {
    provider: 'second',
    anchor: 'https://second.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const roles = [
  ['org:read', 'project:packages:read'],
  ['org:users:read', 'project:read'],
  ['project:packages:write'],
  ['project:settings:write'],
] as const;
const hash = (n: number) => n.toString(16).padStart(64, '0');
const selector = (n: number) =>
  `perf${Array.from(n.toString(32).padStart(8, '0'), (digit) => 'abcdefghijklmnopqrstuvwxyz234567'[Number.parseInt(digit, 32)]).join('')}`;
const st = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });

interface Grant {
  readonly subject: 'email' | 'group';
  readonly value: number;
  readonly provider: number;
  readonly project: number | null;
  readonly role: number;
}

function grants(): Grant[] {
  return Array.from({ length: 600 }, (_, n) => {
    if (n < 200) {
      return {
        subject: 'email',
        value: n % 100,
        provider: 0,
        project: n < 100 ? null : n % 50,
        role: n < 100 ? 0 : 2,
      };
    }
    const k = n - 200;
    return {
      subject: 'group',
      value: k % 100,
      provider: Math.floor(k / 200),
      project: k % 200 < 100 ? null : k % 50,
      role: k % 200 < 100 ? 1 : 3,
    };
  });
}

function oracle(user: number, project: number | null) {
  const organization = new Set<string>();
  const local = new Set<string>();
  for (const grant of grants()) {
    const matches =
      grant.subject === 'email'
        ? grant.value === user && user % 11 !== 0 && user % 13 !== 0
        : grant.provider === 0 &&
          user % 7 !== 0 &&
          user % 17 !== 0 &&
          user % 11 !== 0 &&
          user % 13 !== 0 &&
          Array.from({ length: 4 }, (_, j) => (user + j) % 100).includes(grant.value);
    if (!matches || (grant.project !== null && grant.project !== project)) continue;
    for (const permission of roles[grant.role] ?? []) {
      if (grant.project === null) organization.add(permission);
      if (grant.project !== null && project !== null && permission.startsWith('project:'))
        local.add(permission);
    }
  }
  return { organization: [...organization].sort(), project: [...local].sort() };
}

function assertPlan(
  statement: Statement,
  details: readonly string[],
  credential: 'token' | 'session',
  project: boolean,
) {
  const aliases = new Map<string, string>();
  for (const match of statement.sql.matchAll(
    /\b(?:from|join)\s+"?(token|session|user_group|access_grant|project)"?(?:\s+(?:as\s+)?(?!(?:where|join|on|left|right|inner|outer|cross|full|group|order|having|limit|union|indexed|not)\b)"?(\w+)"?)?/gi,
  )) {
    const table = match[1];
    if (table !== undefined) aliases.set(match[2] ?? table, table);
  }
  const diagnostic = details.join('\n');
  const nodes = details.flatMap((detail) => {
    const match = /^(SCAN|SEARCH)\s+(\w+)\b/i.exec(detail);
    const table = aliases.get(match?.[2] ?? '');
    return table === undefined ? [] : [{ table, detail, operation: match?.[1] }];
  });
  for (const node of nodes) {
    expect(node.operation, diagnostic).toBe('SEARCH');
    expect(node.detail, diagnostic).toMatch(/USING (?:COVERING )?INDEX|PRIMARY KEY/i);
    const lookupKey = { token: 'selector', session: 'secret_hash', project: 'slug' }[node.table];
    if (lookupKey !== undefined) {
      const constraints = [...node.detail.matchAll(/\(([^()]*)\)/g)].flatMap((match) =>
        (match[1] ?? '').split(/\s+AND\s+/i),
      );
      const equalityColumns = constraints.map((constraint) =>
        /^\s*(\w+)\s*=\s*\?\s*$/.exec(constraint)?.[1]?.toLowerCase(),
      );
      expect(equalityColumns, diagnostic).toContain(lookupKey);
    }
  }
  expect(
    nodes.some((node) => node.table === credential),
    diagnostic,
  ).toBe(true);
  if (project)
    expect(
      nodes.some((node) => node.table === 'project'),
      diagnostic,
    ).toBe(true);
  for (const table of ['user_group', 'access_grant']) {
    expect(
      nodes.some((node) => node.table === table),
      diagnostic,
    ).toBe(true);
  }
}

function assertPermissions(
  actual: {
    organizationPermissions: readonly string[];
    projectPermissions: readonly string[];
  } | null,
  expected: ReturnType<typeof oracle>,
) {
  expect(actual?.organizationPermissions).toEqual(expected.organization);
  expect(actual?.projectPermissions).toEqual(expected.project);
}

async function seed(executor: SqlExecutor, org: OrgContext): Promise<void> {
  const fresh = new Date(Date.now() - 60_000).toISOString();
  const stale = new Date(Date.now() - 30 * 3600_000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();
  const statements: Statement[] = [];
  for (const [n, provider] of providers.entries()) {
    statements.push(
      st(
        'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        org.orgId,
        provider.provider,
        n === 0 ? provider.anchor : 'https://changed.example.test',
      ),
    );
  }
  for (const [n, permissions] of roles.entries()) {
    statements.push(
      st(
        'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
        `role-${n}`,
        org.orgId,
        `role-${n}`,
        `Role ${n}`,
        n < 2 ? 'organization' : 'project',
      ),
    );
    for (const permission of permissions)
      statements.push(
        st(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          org.orgId,
          `role-${n}`,
          permission,
        ),
      );
  }
  for (let n = 0; n < 50; n += 1)
    statements.push(
      st(
        'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
        `project-${n}`,
        org.orgId,
        `project-${n}`,
        `Project ${n}`,
        n === 49 ? 'archived' : 'active',
      ),
    );
  for (let user = 0; user < 100; user += 1) {
    const email = `member-${user}@example.test`;
    statements.push(
      st(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        `user-${user}`,
        org.orgId,
        email,
      ),
    );
    for (const [p, provider] of providers.entries()) {
      statements.push(
        st(
          'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          `identity-${p}-${user}`,
          org.orgId,
          `user-${user}`,
          provider.provider,
          `subject-${user}`,
          user % 13 === 0 ? `changed-${user}@example.test` : email,
          user % 11 === 0 ? 0 : 1,
          user % 7 === 0 ? stale : fresh,
        ),
      );
      for (let j = 0; j < 5; j += 1)
        statements.push(
          st(
            'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
            org.orgId,
            `user-${user}`,
            provider.provider,
            `group-${(user + j) % 100}`,
            j === 4 || user % 17 === 0 ? stale : fresh,
          ),
        );
    }
    statements.push(
      st(
        'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        `session-${user}`,
        org.orgId,
        `user-${user}`,
        `identity-0-${user}`,
        hash(user + 1),
        hash(5000 + user),
        future,
      ),
    );
  }
  for (const [n, grant] of grants().entries())
    statements.push(
      st(
        'INSERT INTO access_grant (id, org_id, subject_type, subject_provider, subject_value, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        `grant-${n}`,
        org.orgId,
        grant.subject,
        grant.subject === 'email' ? null : (providers[grant.provider]?.provider ?? null),
        grant.subject === 'email' ? `member-${grant.value}@example.test` : `group-${grant.value}`,
        grant.project === null ? 'organization' : 'project',
        grant.project === null ? null : `project-${grant.project}`,
        `role-${grant.role}`,
      ),
    );
  for (let n = 0; n < 3000; n += 1)
    statements.push(
      st(
        'INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, user_id, project_mode, validation_kind, validation_identity_id, expires_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?, ?, ?)',
        `token-${n}`,
        org.orgId,
        'pat',
        selector(n),
        hash(10000 + n),
        'Performance fixture',
        '["full"]',
        `user-${n % 100}`,
        'all',
        'sso',
        `identity-0-${n % 100}`,
        future,
      ),
    );
  await batchInChunks(executor, statements);
}

describe('access performance contract', () => {
  it('rejects scan mutations for every guarded table, including renamed aliases', () => {
    const statement = st(
      'SELECT 1 FROM token AS credential JOIN session AS login JOIN user_group AS membership JOIN access_grant AS grant_row JOIN project AS target',
    );
    const details = [
      'SEARCH credential USING INDEX fixture_index (org_id=? AND selector=?)',
      'SEARCH login USING INDEX fixture_index (secret_hash=?)',
      'SEARCH membership USING INDEX fixture_index (org_id=?)',
      'SEARCH grant_row USING INDEX fixture_index (org_id=?)',
      'SEARCH target USING INDEX fixture_index (org_id=? AND slug=?)',
    ];
    expect(() => assertPlan(statement, details, 'token', true)).not.toThrow();
    for (let n = 0; n < details.length; n += 1) {
      const mutated = [...details];
      mutated[n] = (mutated[n] ?? '').replace('SEARCH', 'SCAN');
      expect(() => assertPlan(statement, mutated, 'token', true)).toThrow();
    }
    expect(() => assertPlan(statement, details.slice(1), 'token', true)).toThrow();
    expect(() => assertPlan(statement, details.slice(0, -1), 'token', true)).toThrow();
    expect(() =>
      assertPlan(
        statement,
        details.map((line) => line.replace('USING INDEX fixture_index', '')),
        'token',
        true,
      ),
    ).toThrow();
  });

  it.each([
    ['token', 'selector'],
    ['session', 'secret_hash'],
    ['project', 'slug'],
  ] as const)('rejects an indexed %s search without its %s constraint', (...[table]) => {
    const statement = st(
      'SELECT 1 FROM token JOIN session JOIN user_group JOIN access_grant JOIN project WHERE 1',
    );
    const details = [
      'SEARCH token USING COVERING INDEX selector_index (org_id=? AND selector=?)',
      'SEARCH session USING INDEX secret_hash_index (secret_hash=? AND org_id=?)',
      'SEARCH user_group USING PRIMARY KEY (org_id=? AND user_id=?)',
      'SEARCH access_grant USING INDEX grant_index (org_id=?)',
      'SEARCH project USING INDEX slug_index (slug=? AND org_id=?)',
    ];
    const credential = table === 'session' ? 'session' : 'token';
    expect(() => assertPlan(statement, details, credential, true)).not.toThrow();
    const mutated = details.map((detail) =>
      detail.startsWith(`SEARCH ${table} `) ? detail.replace(/\([^)]*\)$/, '(org_id=?)') : detail,
    );
    expect(() => assertPlan(statement, mutated, credential, true)).toThrow();
  });

  it('rejects an implicit grant alias scan alongside an explicitly aliased indexed branch', () => {
    const statement = st(
      'SELECT 1 FROM token AS t JOIN user_group AS ug JOIN access_grant AS indexed_grant ON 1 UNION ALL SELECT 1 FROM access_grant scanning_grant WHERE 1',
    );
    const details = [
      'SEARCH t USING INDEX token_index (org_id=? AND selector=?)',
      'SEARCH ug USING PRIMARY KEY (org_id=? AND user_id=?)',
      'SEARCH indexed_grant USING INDEX grant_index (org_id=?)',
      'SEARCH scanning_grant USING INDEX grant_index (org_id=?)',
    ];
    expect(() => assertPlan(statement, details, 'token', false)).not.toThrow();
    expect(() =>
      assertPlan(statement, [...details.slice(0, -1), 'SCAN scanning_grant'], 'token', false),
    ).toThrow();
  });

  it('rejects permission widening and missing permissions', () => {
    const expected = oracle(1, 1);
    const actual = {
      organizationPermissions: expected.organization,
      projectPermissions: expected.project,
    };
    expect(() => assertPermissions(actual, expected)).not.toThrow();
    expect(() =>
      assertPermissions(
        { ...actual, projectPermissions: [...expected.project, 'project:grants:write'] },
        expected,
      ),
    ).toThrow();
    expect(() => assertPermissions({ ...actual, organizationPermissions: [] }, expected)).toThrow();
  });

  it('matches the oracle and uses one indexed read before and after ANALYZE', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    try {
      if (database.orgs === null) throw new Error('organizations were not seeded');
      const { a, b } = database.orgs;
      const executor = database.executor;
      await seed(executor, a);
      for (const [table, count] of [
        ['user_group', 1000],
        ['access_grant', 600],
        ['project', 50],
        ['token', 3000],
      ] as const) {
        expect(
          await executor.all(
            st(`SELECT count(*) AS total FROM ${table} WHERE org_id = ?`, a.orgId),
          ),
        ).toEqual([{ total: count }]);
      }
      const eligible = new Set(
        PERMISSIONS.filter((permission) => !permission.sessionOnly).map(
          (permission) => permission.name,
        ),
      );
      for (const phase of ['before ANALYZE', 'after ANALYZE']) {
        if (phase === 'after ANALYZE') await database.analyze();
        for (const boundary of ['organization', 'project'] as const) {
          for (let user = 0; user < 100; user += 1) {
            const project = boundary === 'project' && user % 50 !== 49 ? user % 50 : null;
            const expected = oracle(user, project);
            const common = {
              boundary,
              projectSlug: boundary === 'project' ? `project-${user % 50}` : null,
              providerAnchors: providers,
            };
            const counted = countCalls(executor);
            const repository = createAccessRepository(counted.executor);
            const session = await repository.lookupSession(a, {
              ...common,
              secretHash: hash(user + 1),
            });
            expect(counted.counts()).toEqual({ all: 1, batch: 0 });
            assertPermissions(session, expected);
            const token = await repository.lookupToken(a, { ...common, selector: selector(user) });
            expect(counted.counts()).toEqual({ all: 2, batch: 0 });
            const fresh = user % 7 !== 0 && user % 11 !== 0 && user % 13 !== 0;
            assertPermissions(token, {
              organization:
                boundary === 'organization' && fresh
                  ? expected.organization.filter(
                      (name) => name.startsWith('org:') && eligible.has(name),
                    )
                  : [],
              project:
                boundary === 'project' && fresh
                  ? [...new Set([...expected.organization, ...expected.project])]
                      .filter((name) => name.startsWith('project:') && eligible.has(name))
                      .sort()
                  : [],
            });
          }
          for (const kind of ['token', 'session'] as const) {
            const common = {
              boundary,
              projectSlug: boundary === 'project' ? 'project-1' : null,
              providerAnchors: providers,
            };
            const statement =
              kind === 'token'
                ? lookupTokenStatement(a, { ...common, selector: selector(1) })
                : lookupSessionStatement(a, { ...common, secretHash: hash(2) });
            const plan = await executor.all<{ detail: string }>({
              sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
              params: statement.params,
            });
            const details = plan.map((row) => row.detail);
            console.info(`${phase}: ${kind}, ${boundary}\n${details.join('\n')}`);
            assertPlan(statement, details, kind, boundary === 'project');
          }
        }
        await negatives(executor, a, b);
      }
    } finally {
      await database.close();
    }
  }, 120_000);
});

async function negatives(executor: SqlExecutor, a: OrgContext, b: OrgContext) {
  for (const boundary of ['organization', 'project'] as const) {
    const counted = countCalls(executor);
    const repository = createAccessRepository(counted.executor);
    const common = {
      boundary,
      projectSlug: 'project-1',
      providerAnchors: providers.map((provider) => ({
        ...provider,
        anchor: 'https://unknown.example.test',
      })),
    };
    const session = await repository.lookupSession(a, { ...common, secretHash: hash(2) });
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    assertPermissions(session, { organization: [], project: [] });
    const token = await repository.lookupToken(a, { ...common, selector: selector(1) });
    expect(counted.counts()).toEqual({ all: 2, batch: 0 });
    assertPermissions(token, { organization: [], project: [] });
  }
  for (const org of [a, b]) {
    for (const slug of ['missing', 'project-49', 'project%2D1']) {
      const counted = countCalls(executor);
      const repository = createAccessRepository(counted.executor);
      const common = {
        boundary: 'project' as AccessBoundary,
        projectSlug: slug,
        providerAnchors: providers,
      };
      const session = await repository.lookupSession(org, { ...common, secretHash: hash(2) });
      expect(counted.counts()).toEqual({ all: 1, batch: 0 });
      const token = await repository.lookupToken(org, { ...common, selector: selector(1) });
      expect(counted.counts()).toEqual({ all: 2, batch: 0 });
      if (org === b) {
        expect(session === null && token === null).toBe(true);
      } else {
        expect(session?.project === null && token?.project === null).toBe(true);
        expect(session?.projectPermissions).toEqual([]);
        expect(token?.projectPermissions).toEqual([]);
      }
    }
    for (const kind of ['token', 'session'] as const) {
      const counted = countCalls(executor);
      const repository = createAccessRepository(counted.executor);
      const common = {
        boundary: 'organization' as const,
        projectSlug: null,
        providerAnchors: providers,
      };
      const result =
        kind === 'token'
          ? await repository.lookupToken(org, { ...common, selector: selector(9999) })
          : await repository.lookupSession(org, { ...common, secretHash: hash(9999) });
      expect(counted.counts()).toEqual({ all: 1, batch: 0 });
      expect(result === null).toBe(true);
    }
  }
}
