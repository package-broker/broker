import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { compile, db, type ProtectedHolderProvider } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  coveredByRegisteredNames,
  createRegisteredNameRepository,
  sourceActivatable,
  type RegisteredNameRepository,
} from './registered-name.js';

const ANCHORS: readonly ProtectedHolderProvider[] = [
  { provider: 'oidc', anchor: 'oidc:https://idp.example.test', emailAuthoritative: true },
];

const NOW = '2026-10-15T12:00:00.000Z';
const ORG_ROLE = '01J0ROLEORGSRC0000000000A1';
const PROJECT_ROLE = '01J0ROLEPROJSRC000000000A1';
const P1 = '01J0PROJECT00000000000000A1';
const P2 = '01J0PROJECT00000000000000A2';
const ORG_ADMIN = '01J0USER000000000000000001';
const P1_MAINTAINER = '01J0USER000000000000000002';
const S_ORG = '01J0SESSION000000000000001';
const S_P1 = '01J0SESSION000000000000002';
const SRC_ORG = '01J0SOURCE0000000000000001';
const SRC_P1 = '01J0SOURCE0000000000000002';
const SRC_P2 = '01J0SOURCE0000000000000003';
const SRC_NPM = '01J0SOURCE0000000000000004';
const SRC_PROXY = '01J0SOURCE0000000000000005';
const SRC_MISSING = '01J0SOURCE0000000000000009';
const NAME_1 = '01J0NAME0000000000000000A1';
const NAME_2 = '01J0NAME0000000000000000A2';
const NAME_3 = '01J0NAME0000000000000000A3';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let seedOrg: OrgContext;
let executor: SqlExecutor;
let names: RegisteredNameRepository;

function stmt(text: string, ...params: Statement['params']): Statement {
  return { sql: text, params };
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
      seedOrg.orgId,
      key,
      key,
      scope,
    ),
    ...permissions.map((permission) =>
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        seedOrg.orgId,
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
      seedOrg.orgId,
      email,
      'active',
    ),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      sessionId,
      seedOrg.orgId,
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
      seedOrg.orgId,
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
    seedOrg.orgId,
    'email',
    email,
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
    NOW,
    NOW,
  );
}

function seedSource(
  id: string,
  name: string,
  overrides: Partial<{
    project_id: string | null;
    type: string;
    ecosystem: string;
    status: string;
    config_json: string;
  }> = {},
): Statement {
  return stmt(
    `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, url, config_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    seedOrg.orgId,
    overrides.project_id ?? null,
    name,
    overrides.ecosystem ?? 'composer',
    overrides.type ?? 'composer_repository',
    'https://repo.example.test',
    overrides.config_json ?? '{}',
    overrides.status ?? 'paused',
  );
}

async function rows<R = Record<string, unknown>>(text: string, ...params: Statement['params']) {
  return executor.all<R>(stmt(text, ...params));
}

async function status(id: string): Promise<unknown> {
  return (await rows<{ status: string }>('SELECT status FROM source WHERE id = ?', id))[0]?.status;
}

async function epoch(): Promise<unknown> {
  return (
    await rows<{ version: string }>('SELECT version FROM cache_epoch WHERE org_id = ?', a.orgId)
  )[0]?.version;
}

async function snapshot(): Promise<string> {
  return JSON.stringify([
    await rows('SELECT * FROM source ORDER BY id'),
    await rows('SELECT * FROM registered_name ORDER BY id'),
    await epoch(),
  ]);
}

const add = (fence: MutationFence, id: string, sourceId: string, pattern: string) =>
  names.add(a, fence, { id, sourceId, pattern, providerAnchors: ANCHORS });

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  seedOrg = a;
  executor = database.executor;
  names = createRegisteredNameRepository(executor);
  await executor.batch([
    ...role(ORG_ROLE, 'org_sources', 'organization', 'org:sources:write'),
    ...role(PROJECT_ROLE, 'project_sources', 'project', 'project:sources:write', 'project:read'),
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
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      a.orgId,
      'oidc',
      'oidc:https://idp.example.test',
    ),
    ...person(ORG_ADMIN, S_ORG, 'admin@example.test', 1),
    ...person(P1_MAINTAINER, S_P1, 'm1@example.test', 2),
    grant('01J0GRANT000000000000000A1', 'admin@example.test', ORG_ROLE, null),
    grant('01J0GRANT000000000000000A2', 'm1@example.test', PROJECT_ROLE, P1),
    seedSource(SRC_ORG, 'org-src'),
    seedSource(SRC_P1, 'p1-src', { project_id: P1 }),
    seedSource(SRC_P2, 'p2-src', { project_id: P2 }),
    seedSource(SRC_NPM, 'npm-src', {
      type: 'npm_registry',
      ecosystem: 'npm',
      config_json: '{"scopes":["@acme","@tools"]}',
    }),
    seedSource(SRC_PROXY, 'proxy', { type: 'packagist_proxy', status: 'paused' }),
  ]);
});

afterEach(async () => {
  await database.close();
});

describe('enable', () => {
  it('refuses a composer_repository source without a registered name and enables it with one', async () => {
    const before = await snapshot();
    expect(await names.enable(a, orgFence(), { id: SRC_ORG, providerAnchors: ANCHORS })).toBe(
      'activation_requires_registered_names',
    );
    expect(await snapshot()).toBe(before);

    expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
    const epochBefore = await epoch();
    expect(await names.enable(a, orgFence(), { id: SRC_ORG, providerAnchors: ANCHORS })).toBe(
      'enabled',
    );
    expect(await status(SRC_ORG)).toBe('active');
    expect(await epoch()).not.toBe(epochBefore);
  });

  it('enables an npm_registry source only when every configured scope is registered', async () => {
    expect(await add(orgFence(), NAME_1, SRC_NPM, '@acme/*')).toBe('added');
    expect(await names.enable(a, orgFence(), { id: SRC_NPM, providerAnchors: ANCHORS })).toBe(
      'activation_requires_registered_names',
    );
    expect(await add(orgFence(), NAME_2, SRC_NPM, '@tools/cli')).toBe('added');
    expect(await names.enable(a, orgFence(), { id: SRC_NPM, providerAnchors: ANCHORS })).toBe(
      'activation_requires_registered_names',
    );
    expect(await add(orgFence(), NAME_3, SRC_NPM, '@tools/*')).toBe('added');
    expect(await names.enable(a, orgFence(), { id: SRC_NPM, providerAnchors: ANCHORS })).toBe(
      'enabled',
    );
    expect(await status(SRC_NPM)).toBe('active');
  });

  it('enables a proxy without registered names', async () => {
    expect(await names.enable(a, orgFence(), { id: SRC_PROXY, providerAnchors: ANCHORS })).toBe(
      'enabled',
    );
    expect(await status(SRC_PROXY)).toBe('active');
  });

  it('lets a project administrator enable its own covered source but not another project source', async () => {
    expect(await add(orgFence(), NAME_1, SRC_P1, 'one/*')).toBe('added');
    expect(await add(orgFence(), NAME_2, SRC_P2, 'two/*')).toBe('added');
    expect(await names.enable(a, p1Fence(), { id: SRC_P1, providerAnchors: ANCHORS })).toBe(
      'enabled',
    );
    expect(await names.enable(a, p1Fence(), { id: SRC_P2, providerAnchors: ANCHORS })).toBe(
      'forbidden',
    );
    expect(await names.enable(a, p1Fence(), { id: SRC_MISSING, providerAnchors: ANCHORS })).toBe(
      'forbidden',
    );
    expect(await names.enable(a, orgFence(), { id: SRC_MISSING, providerAnchors: ANCHORS })).toBe(
      'not_found',
    );
    expect(await status(SRC_P2)).toBe('paused');
  });
});

describe('add', () => {
  it('refuses a project-only administrator, even on its own project source', async () => {
    const before = await snapshot();
    expect(await add(p1Fence(), NAME_1, SRC_P1, 'one/*')).toBe('forbidden');
    expect(await add(p1Fence(), NAME_1, SRC_MISSING, 'one/*')).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it.each([
    '*',
    '*/*',
    '@*/*',
    '*-plugin',
    '/*',
    '@',
    'Acme/*',
    'acme/?',
    'acme/[ab]',
    '',
    'a*b*c*d*e*f',
  ])('refuses the pattern %j and writes nothing', async (pattern) => {
    const before = await snapshot();
    expect(await add(orgFence(), NAME_1, SRC_ORG, pattern)).toBe('invalid_pattern');
    expect(await snapshot()).toBe(before);
  });

  it('validates the pattern against the source ecosystem', async () => {
    expect(await add(orgFence(), NAME_1, SRC_ORG, '@acme/*')).toBe('invalid_pattern');
    expect(await add(orgFence(), NAME_1, SRC_NPM, '@acme/*')).toBe('added');
    expect(await add(orgFence(), NAME_2, SRC_NPM, 'left-pad@*')).toBe('invalid_pattern');
    expect(await add(orgFence(), NAME_2, SRC_ORG, 'acme/*')).toBe('added');
    expect(
      await rows('SELECT source_id, ecosystem, pattern FROM registered_name ORDER BY id'),
    ).toEqual([
      { source_id: SRC_NPM, ecosystem: 'npm', pattern: '@acme/*' },
      { source_id: SRC_ORG, ecosystem: 'composer', pattern: 'acme/*' },
    ]);
  });

  it('answers a pattern held by another project source with a conflict naming neither', async () => {
    expect(await add(orgFence(), NAME_1, SRC_P2, 'acme/*')).toBe('added');
    const before = await snapshot();
    const result = await add(orgFence(), NAME_2, SRC_P1, 'acme/*');
    expect(result).toBe('pattern_taken');
    expect(JSON.stringify(result)).not.toContain(SRC_P2);
    expect(JSON.stringify(result)).not.toContain(P2);
    expect(await snapshot()).toBe(before);
  });

  it('answers duplicate for the same pattern on the same source', async () => {
    expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
    expect(await add(orgFence(), NAME_2, SRC_ORG, 'acme/*')).toBe('duplicate');
    expect(await add(orgFence(), NAME_1, SRC_ORG, 'other/*')).toBe('duplicate');
  });

  it('answers not_found for an unknown source and bumps the epoch on success', async () => {
    expect(await add(orgFence(), NAME_1, SRC_MISSING, 'acme/*')).toBe('not_found');
    const before = await epoch();
    expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
    expect(await epoch()).not.toBe(before);
  });
});

describe('remove', () => {
  it('pauses an active npm_registry source when one of two scope patterns is removed', async () => {
    expect(await add(orgFence(), NAME_1, SRC_NPM, '@acme/*')).toBe('added');
    expect(await add(orgFence(), NAME_2, SRC_NPM, '@tools/*')).toBe('added');
    expect(await names.enable(a, orgFence(), { id: SRC_NPM, providerAnchors: ANCHORS })).toBe(
      'enabled',
    );
    const before = await epoch();
    expect(await names.remove(a, orgFence(), { id: NAME_2, providerAnchors: ANCHORS })).toBe(
      'removed_and_paused',
    );
    expect(await status(SRC_NPM)).toBe('paused');
    expect(await epoch()).not.toBe(before);
    expect(await rows('SELECT id FROM registered_name')).toEqual([{ id: NAME_1 }]);
  });

  it('keeps an active source that still satisfies the invariant', async () => {
    expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
    expect(await add(orgFence(), NAME_2, SRC_ORG, 'tools/*')).toBe('added');
    expect(await names.enable(a, orgFence(), { id: SRC_ORG, providerAnchors: ANCHORS })).toBe(
      'enabled',
    );
    expect(await names.remove(a, orgFence(), { id: NAME_2, providerAnchors: ANCHORS })).toBe(
      'removed',
    );
    expect(await status(SRC_ORG)).toBe('active');
    expect(await names.remove(a, orgFence(), { id: NAME_1, providerAnchors: ANCHORS })).toBe(
      'removed_and_paused',
    );
    expect(await status(SRC_ORG)).toBe('paused');
  });

  it('refuses a project-only administrator and answers not_found for an unknown name', async () => {
    expect(await add(orgFence(), NAME_1, SRC_P1, 'one/*')).toBe('added');
    const before = await snapshot();
    expect(await names.remove(a, p1Fence(), { id: NAME_1, providerAnchors: ANCHORS })).toBe(
      'forbidden',
    );
    expect(await names.remove(a, p1Fence(), { id: NAME_3, providerAnchors: ANCHORS })).toBe(
      'forbidden',
    );
    expect(await snapshot()).toBe(before);
    expect(await names.remove(a, orgFence(), { id: NAME_3, providerAnchors: ANCHORS })).toBe(
      'not_found',
    );
  });
});

describe('D1 registered-name coverage', () => {
  beforeEach(async () => {
    await database.close();
    database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    if (database.orgs === null) throw new Error('orgs missing');
    a = database.orgs.a;
    executor = database.executor;
    seedOrg = a;
    await executor.batch([seedSource(SRC_ORG, 'org-src')]);
  });

  async function covered(pattern: string, key: string): Promise<number | undefined> {
    await executor.batch([
      stmt(
        `INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', ?)`,
        NAME_1,
        a.orgId,
        SRC_ORG,
        pattern,
      ),
    ]);
    return (
      await executor.all<{ held: number }>(
        compile(
          db.selectNoFrom(sql<number>`(${coveredByRegisteredNames(a, SRC_ORG, key)})`.as('held')),
        ),
      )
    )[0]?.held;
  }

  it('does not cover a non-matching key with a stored 51-byte pattern without exceeding the D1 limit', async () => {
    await expect(covered(`acme/${'a'.repeat(45)}*`, 'other/lib')).resolves.toBe(0);
  });

  it('covers a matching key with a valid 50-byte pattern', async () => {
    await expect(covered(`acme/${'a'.repeat(44)}*`, `acme/${'a'.repeat(44)}lib`)).resolves.toBe(1);
  });

  it('does not cover a non-matching key with a valid 50-byte pattern', async () => {
    await expect(covered(`acme/${'a'.repeat(44)}*`, 'other/lib')).resolves.toBe(0);
  });
});

describe('SQL conditions', () => {
  async function holds(condition: ReturnType<typeof sourceActivatable>): Promise<number> {
    const [row] = await executor.all<{ held: number }>(
      compile(db.selectNoFrom(sql<number>`(${condition})`.as('held'))),
    );
    return row?.held ?? -1;
  }

  it('sourceActivatable follows the coverage invariant', async () => {
    expect(await holds(sourceActivatable(a, SRC_PROXY))).toBe(1);
    expect(await holds(sourceActivatable(a, SRC_ORG))).toBe(0);
    expect(await holds(sourceActivatable(a, SRC_MISSING))).toBe(0);
    await add(orgFence(), NAME_1, SRC_ORG, 'acme/*');
    expect(await holds(sourceActivatable(a, SRC_ORG))).toBe(1);
  });

  it('coveredByRegisteredNames matches keys of the source own patterns only', async () => {
    await add(orgFence(), NAME_1, SRC_ORG, 'acme/*');
    await add(orgFence(), NAME_2, SRC_P1, 'one/*');
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'acme/lib'))).toBe(1);
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'acme/sub/lib'))).toBe(1);
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'one/lib'))).toBe(0);
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'acmex/lib'))).toBe(0);
  });

  it('coveredByRegisteredNames ignores a row whose pattern is outside the grammar', async () => {
    await executor.batch([
      stmt(
        `INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'acme/[ab]')`,
        NAME_3,
        a.orgId,
        SRC_ORG,
      ),
    ]);
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'acme/a'))).toBe(0);
  });
});

const P_ARCHIVED = '01J0PROJECT00000000000000A3';
const B_ADMIN = '01J0USER000000000000000005';
const S_B = '01J0SESSION000000000000005';
const B_ROLE = '01J0ROLEORGSRC0000000000B1';
const SRC_B = '01J0SOURCE000000000000000B';
const SRC_ARCHIVED = '01J0SOURCE0000000000000006';
const NAME_B = '01J0NAME0000000000000000B1';
const bFence = () => fenceFor(B_ADMIN, S_B);

describe('round 2', () => {
  it('refuses a registered name on a proxy source', async () => {
    const before = await snapshot();
    expect(await add(orgFence(), NAME_1, SRC_PROXY, 'acme/*')).toBe('proxy_source');
    expect(await snapshot()).toBe(before);
  });

  it.each(['acme/', 'acme*', 'acme/*/x/y', 'acme'])(
    'refuses the composer pattern %j that covers no valid key',
    async (pattern) => {
      expect(await add(orgFence(), NAME_1, SRC_ORG, pattern)).toBe('invalid_pattern');
    },
  );

  it.each(['@acme/', '@acme*', '@acme'])(
    'refuses the npm scoped pattern %j without a name part',
    async (pattern) => {
      expect(await add(orgFence(), NAME_1, SRC_NPM, pattern)).toBe('invalid_pattern');
    },
  );

  describe('across organizations', () => {
    beforeEach(async () => {
      seedOrg = b;
      await executor.batch([
        ...role(B_ROLE, 'org_sources', 'organization', 'org:sources:write'),
        stmt(
          'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
          b.orgId,
          'oidc',
          'oidc:https://idp.example.test',
        ),
        ...person(B_ADMIN, S_B, 'admin-b@example.test', 5),
        grant('01J0GRANT000000000000000B1', 'admin-b@example.test', B_ROLE, null),
        seedSource(SRC_B, 'b-src'),
      ]);
      seedOrg = a;
    });

    it('lets organization b register a pattern organization a holds', async () => {
      expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
      expect(
        await names.add(b, bFence(), {
          id: NAME_B,
          sourceId: SRC_B,
          pattern: 'acme/*',
          providerAnchors: ANCHORS,
        }),
      ).toBe('added');
    });

    it('answers forbidden or not_found to organization b on organization a rows', async () => {
      expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
      const before = await snapshot();
      const target = { id: SRC_ORG, providerAnchors: ANCHORS };
      const nameTarget = { id: NAME_1, providerAnchors: ANCHORS };
      const input = { id: NAME_B, sourceId: SRC_ORG, pattern: 'tools/*', providerAnchors: ANCHORS };
      expect(await names.add(b, bFence(), input)).toBe('not_found');
      expect(await names.remove(b, bFence(), nameTarget)).toBe('not_found');
      expect(await names.enable(b, bFence(), target)).toBe('not_found');
      expect(await names.add(a, bFence(), input)).toBe('forbidden');
      expect(await names.remove(a, bFence(), nameTarget)).toBe('forbidden');
      expect(await names.enable(a, bFence(), target)).toBe('forbidden');
      expect(await snapshot()).toBe(before);
    });

    it('keeps coverage and activatability blind to organization b rows', async () => {
      await executor.batch([
        stmt(
          `INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'acme/*')`,
          NAME_B,
          b.orgId,
          SRC_ORG,
        ),
      ]);
      const held = async (condition: ReturnType<typeof sourceActivatable>) =>
        (
          await executor.all<{ held: number }>(
            compile(db.selectNoFrom(sql<number>`(${condition})`.as('held'))),
          )
        )[0]?.held;
      expect(await held(coveredByRegisteredNames(a, SRC_ORG, 'acme/lib'))).toBe(0);
      expect(await held(sourceActivatable(a, SRC_ORG))).toBe(0);
      expect(await held(sourceActivatable(b, SRC_ORG))).toBe(0);
      expect(await names.enable(a, orgFence(), { id: SRC_ORG, providerAnchors: ANCHORS })).toBe(
        'activation_requires_registered_names',
      );
    });
  });

  function racing(sabotage: Statement): SqlExecutor {
    let fired = false;
    return {
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          await executor.batch([sabotage]);
        }
        return executor.batch(statements);
      },
    } as SqlExecutor;
  }

  it('answers not_found when the source is deleted during enable', async () => {
    const racer = createRegisteredNameRepository(
      racing(stmt('DELETE FROM source WHERE id = ?', SRC_ORG)),
    );
    expect(await racer.enable(a, orgFence(), { id: SRC_ORG, providerAnchors: ANCHORS })).toBe(
      'not_found',
    );
  });

  it('answers not_found when the source moves to another project during enable', async () => {
    expect(await add(orgFence(), NAME_1, SRC_P1, 'one/*')).toBe('added');
    const racer = createRegisteredNameRepository(
      racing(stmt('UPDATE source SET project_id = ? WHERE id = ?', P2, SRC_P1)),
    );
    expect(await racer.enable(a, p1Fence(), { id: SRC_P1, providerAnchors: ANCHORS })).toBe(
      'not_found',
    );
    expect(await status(SRC_P1)).toBe('paused');
  });

  it.each(['active', 'degraded', 'failing'])(
    'answers already_enabled on a %s source without bumping the epoch',
    async (current) => {
      expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
      await executor.batch([stmt('UPDATE source SET status = ? WHERE id = ?', current, SRC_ORG)]);
      const before = await snapshot();
      expect(await names.enable(a, orgFence(), { id: SRC_ORG, providerAnchors: ANCHORS })).toBe(
        'already_enabled',
      );
      expect(await snapshot()).toBe(before);
    },
  );

  it.each(['degraded', 'failing'])(
    'pauses a %s source when its last name is removed',
    async (s) => {
      expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
      await executor.batch([stmt('UPDATE source SET status = ? WHERE id = ?', s, SRC_ORG)]);
      expect(await names.remove(a, orgFence(), { id: NAME_1, providerAnchors: ANCHORS })).toBe(
        'removed_and_paused',
      );
      expect(await status(SRC_ORG)).toBe('paused');
    },
  );

  it('never pauses a proxy when a name on it is removed', async () => {
    await executor.batch([
      stmt('UPDATE source SET status = ? WHERE id = ?', 'active', SRC_PROXY),
      stmt(
        `INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'acme/*')`,
        NAME_1,
        a.orgId,
        SRC_PROXY,
      ),
    ]);
    expect(await names.remove(a, orgFence(), { id: NAME_1, providerAnchors: ANCHORS })).toBe(
      'removed',
    );
    expect(await status(SRC_PROXY)).toBe('active');
  });

  it('refuses enable on a source of an archived project', async () => {
    await executor.batch([
      stmt(
        'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
        P_ARCHIVED,
        a.orgId,
        'old',
        'old',
        'archived',
      ),
      grant('01J0GRANT000000000000000A3', 'm1@example.test', PROJECT_ROLE, P_ARCHIVED),
      seedSource(SRC_ARCHIVED, 'old-src', { project_id: P_ARCHIVED }),
    ]);
    expect(await add(orgFence(), NAME_1, SRC_ARCHIVED, 'old/*')).toBe('added');
    expect(await names.enable(a, p1Fence(), { id: SRC_ARCHIVED, providerAnchors: ANCHORS })).toBe(
      'forbidden',
    );
    expect(await status(SRC_ARCHIVED)).toBe('paused');
  });

  it('refuses the second enable after the last name is removed between them', async () => {
    expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
    expect(await names.enable(a, orgFence(), { id: SRC_ORG, providerAnchors: ANCHORS })).toBe(
      'enabled',
    );
    expect(await names.remove(a, orgFence(), { id: NAME_1, providerAnchors: ANCHORS })).toBe(
      'removed_and_paused',
    );
    expect(await names.enable(a, orgFence(), { id: SRC_ORG, providerAnchors: ANCHORS })).toBe(
      'activation_requires_registered_names',
    );
    expect(await status(SRC_ORG)).toBe('paused');
  });

  it('ignores rows beyond the T305 length or wildcard limits in coverage', async () => {
    const long = `acme/${'a'.repeat(424)}`;
    await executor.batch([
      stmt(
        `INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', ?)`,
        NAME_1,
        a.orgId,
        SRC_ORG,
        'a*c*m*e*/*',
      ),
      stmt(
        `INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', ?)`,
        NAME_2,
        a.orgId,
        SRC_ORG,
        long,
      ),
    ]);
    const held = async (key: string) =>
      (
        await executor.all<{ held: number }>(
          compile(
            db.selectNoFrom(sql<number>`(${coveredByRegisteredNames(a, SRC_ORG, key)})`.as('held')),
          ),
        )
      )[0]?.held;
    expect(await held('acme/lib')).toBe(0);
    expect(await held(long)).toBe(0);
  });
});

it('refuses a 51-byte registered name without writing a row', async () => {
  const before = await snapshot();
  expect(await add(orgFence(), NAME_1, SRC_ORG, `acme/${'a'.repeat(45)}*`)).toBe('invalid_pattern');
  expect(await rows('SELECT id FROM registered_name')).toEqual([]);
  expect(await snapshot()).toBe(before);
});
