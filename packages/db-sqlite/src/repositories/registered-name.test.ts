import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  settleIdempotent,
  replayResponse,
  type IdempotencyRecord,
} from '@package-broker/core/api/idempotency';
import { createIdempotencyRepository, idempotencyInsertStatement } from './idempotency.js';
import type { AuditEvent } from '@package-broker/core/audit/actions';
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
import { withForeignKeysOff } from '../testing/foreign-keys-off.js';

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

const batchForged = (statements: readonly Statement[]) =>
  withForeignKeysOff(executor, () => executor.batch(statements));

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

let auditSequence = 0;

function audit(action: AuditEvent['action'], targetId: string, pattern?: string): AuditEvent {
  return {
    id: `01ARZ3NDEKTSV4RRFFQ6${String(++auditSequence).padStart(6, '0')}`,
    occurredAt: NOW,
    action,
    actor: { type: 'user', id: ORG_ADMIN },
    tokenSelector: null,
    sourceIp: null,
    target: { type: action.startsWith('source.') ? 'source' : 'registered_name', id: targetId },
    projectId: null,
    payloadJson: JSON.stringify(
      pattern === undefined ? {} : { changes: { pattern: { new: pattern } } },
    ),
  };
}

const add = (fence: MutationFence, id: string, sourceId: string, pattern: string) =>
  names.add(a, fence, {
    id,
    sourceId,
    pattern,
    providerAnchors: ANCHORS,
    audit: audit('registered_name.add', id, pattern),
  });

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

describe('registered-name ownership', () => {
  it.each([
    [SRC_ORG, null],
    [SRC_P1, P1],
  ] as const)('reads the owner of %s', async (sourceId, projectId) => {
    expect(await add(orgFence(), NAME_1, sourceId, 'acme/*')).toBe('added');
    expect(await names.owner(a, NAME_1)).toEqual({ sourceId, projectId });
  });

  it('answers null for a foreign organization name', async () => {
    expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
    expect(await names.owner(b, NAME_1)).toBeNull();
  });

  it('answers null for an absent name', async () => {
    expect(await names.owner(a, NAME_1)).toBeNull();
  });

  it.each([
    ['source', SRC_P1],
    ['registered_name', SRC_ORG],
  ])('refuses a mismatched pause target %s:%s without writes', async (type, id) => {
    expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
    await rows("UPDATE source SET status = 'active' WHERE org_id = ? AND id = ?", a.orgId, SRC_ORG);
    const before = await snapshot();
    const pending = await rows('SELECT * FROM audit_pending WHERE org_id = ? ORDER BY id', a.orgId);
    expect(
      await names.remove(a, orgFence(), {
        id: NAME_1,
        providerAnchors: ANCHORS,
        audit: audit('registered_name.remove', NAME_1),
        pauseAudit: { ...audit('source.pause', SRC_ORG), target: { type, id } },
      }),
    ).toBe('conflict');
    expect(await snapshot()).toBe(before);
    expect(await rows('SELECT * FROM audit_pending WHERE org_id = ? ORDER BY id', a.orgId)).toEqual(
      pending,
    );
  });
});

describe('enable', () => {
  it('refuses a composer_repository source without a registered name and enables it with one', async () => {
    const before = await snapshot();
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_ORG),
      }),
    ).toBe('activation_requires_registered_names');
    expect(await snapshot()).toBe(before);

    expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
    const epochBefore = await epoch();
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_ORG),
      }),
    ).toBe('enabled');
    expect(await status(SRC_ORG)).toBe('active');
    expect(await epoch()).not.toBe(epochBefore);
  });

  it('enables an npm_registry source only when every configured scope is registered', async () => {
    expect(await add(orgFence(), NAME_1, SRC_NPM, '@acme/*')).toBe('added');
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_NPM,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_NPM),
      }),
    ).toBe('activation_requires_registered_names');
    expect(await add(orgFence(), NAME_2, SRC_NPM, '@tools/cli')).toBe('added');
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_NPM,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_NPM),
      }),
    ).toBe('activation_requires_registered_names');
    expect(await add(orgFence(), NAME_3, SRC_NPM, '@tools/*')).toBe('added');
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_NPM,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_NPM),
      }),
    ).toBe('enabled');
    expect(await status(SRC_NPM)).toBe('active');
  });

  it('enables a proxy without registered names', async () => {
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_PROXY,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_PROXY),
      }),
    ).toBe('enabled');
    expect(await status(SRC_PROXY)).toBe('active');
  });

  it('lets a project administrator enable its own covered source but not another project source', async () => {
    expect(await add(orgFence(), NAME_1, SRC_P1, 'one/*')).toBe('added');
    expect(await add(orgFence(), NAME_2, SRC_P2, 'two/*')).toBe('added');
    expect(
      await names.enable(a, p1Fence(), {
        id: SRC_P1,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_P1),
      }),
    ).toBe('enabled');
    expect(
      await names.enable(a, p1Fence(), {
        id: SRC_P2,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_P2),
      }),
    ).toBe('forbidden');
    expect(
      await names.enable(a, p1Fence(), {
        id: SRC_MISSING,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_MISSING),
      }),
    ).toBe('forbidden');
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_MISSING,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_MISSING),
      }),
    ).toBe('not_found');
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
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_NPM,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_NPM),
      }),
    ).toBe('enabled');
    const before = await epoch();
    expect(
      await names.remove(a, orgFence(), {
        id: NAME_2,
        providerAnchors: ANCHORS,
        audit: audit('registered_name.remove', NAME_2),
        pauseAudit: audit('source.pause', SRC_NPM),
      }),
    ).toBe('removed_and_paused');
    expect(await status(SRC_NPM)).toBe('paused');
    expect(await epoch()).not.toBe(before);
    expect(await rows('SELECT id FROM registered_name')).toEqual([{ id: NAME_1 }]);
  });

  it('keeps an active source that still satisfies the invariant', async () => {
    expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
    expect(await add(orgFence(), NAME_2, SRC_ORG, 'tools/*')).toBe('added');
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_ORG),
      }),
    ).toBe('enabled');
    expect(
      await names.remove(a, orgFence(), {
        id: NAME_2,
        providerAnchors: ANCHORS,
        audit: audit('registered_name.remove', NAME_2),
        pauseAudit: audit('source.pause', SRC_ORG),
      }),
    ).toBe('removed');
    expect(await status(SRC_ORG)).toBe('active');
    expect(
      await names.remove(a, orgFence(), {
        id: NAME_1,
        providerAnchors: ANCHORS,
        audit: audit('registered_name.remove', NAME_1),
        pauseAudit: audit('source.pause', SRC_ORG),
      }),
    ).toBe('removed_and_paused');
    expect(await status(SRC_ORG)).toBe('paused');
  });

  it('refuses a project-only administrator and answers not_found for an unknown name', async () => {
    expect(await add(orgFence(), NAME_1, SRC_P1, 'one/*')).toBe('added');
    const before = await snapshot();
    expect(
      await names.remove(a, p1Fence(), {
        id: NAME_1,
        providerAnchors: ANCHORS,
        audit: audit('registered_name.remove', NAME_1),
        pauseAudit: audit('source.pause', SRC_ORG),
      }),
    ).toBe('forbidden');
    expect(
      await names.remove(a, p1Fence(), {
        id: NAME_3,
        providerAnchors: ANCHORS,
        audit: audit('registered_name.remove', NAME_3),
        pauseAudit: audit('source.pause', SRC_ORG),
      }),
    ).toBe('forbidden');
    expect(await snapshot()).toBe(before);
    expect(
      await names.remove(a, orgFence(), {
        id: NAME_3,
        providerAnchors: ANCHORS,
        audit: audit('registered_name.remove', NAME_3),
        pauseAudit: audit('source.pause', SRC_ORG),
      }),
    ).toBe('not_found');
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
          db.selectNoFrom(
            sql<number>`(${coveredByRegisteredNames(a, SRC_ORG, 'composer', key)})`.as('held'),
          ),
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
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'composer', 'acme/lib'))).toBe(1);
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'composer', 'acme/sub/lib'))).toBe(1);
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'composer', 'one/lib'))).toBe(0);
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'composer', 'acmex/lib'))).toBe(0);
  });

  it('coveredByRegisteredNames ignores a pattern registered for another ecosystem', async () => {
    await add(orgFence(), NAME_1, SRC_ORG, 'acme/*');
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'composer', 'acme/lib'))).toBe(1);
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'npm', 'acme/lib'))).toBe(0);
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
    expect(await holds(coveredByRegisteredNames(a, SRC_ORG, 'composer', 'acme/a'))).toBe(0);
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
          audit: audit('registered_name.add', NAME_B, 'acme/*'),
        }),
      ).toBe('added');
    });

    it('answers forbidden or not_found to organization b on organization a rows', async () => {
      expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
      const before = await snapshot();
      const target = {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_ORG),
      };
      const nameTarget = {
        id: NAME_1,
        providerAnchors: ANCHORS,
        audit: audit('registered_name.remove', NAME_1, 'acme/*'),
        pauseAudit: audit('source.pause', SRC_ORG),
      };
      const input = {
        id: NAME_B,
        sourceId: SRC_ORG,
        pattern: 'tools/*',
        providerAnchors: ANCHORS,
        audit: audit('registered_name.add', NAME_B, 'tools/*'),
      };
      expect(await names.add(b, bFence(), input)).toBe('not_found');
      expect(await names.remove(b, bFence(), nameTarget)).toBe('not_found');
      expect(await names.enable(b, bFence(), target)).toBe('not_found');
      expect(await names.add(a, bFence(), input)).toBe('forbidden');
      expect(await names.remove(a, bFence(), nameTarget)).toBe('forbidden');
      expect(await names.enable(a, bFence(), target)).toBe('forbidden');
      expect(await snapshot()).toBe(before);
    });

    it('keeps coverage and activatability blind to organization b rows', async () => {
      await batchForged([
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
      expect(await held(coveredByRegisteredNames(a, SRC_ORG, 'composer', 'acme/lib'))).toBe(0);
      expect(await held(sourceActivatable(a, SRC_ORG))).toBe(0);
      expect(await held(sourceActivatable(b, SRC_ORG))).toBe(0);
      expect(
        await names.enable(a, orgFence(), {
          id: SRC_ORG,
          providerAnchors: ANCHORS,
          audit: audit('source.resume', SRC_ORG),
        }),
      ).toBe('activation_requires_registered_names');
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
    expect(
      await racer.enable(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_ORG),
      }),
    ).toBe('not_found');
  });

  it('answers not_found when the source moves to another project during enable', async () => {
    expect(await add(orgFence(), NAME_1, SRC_P1, 'one/*')).toBe('added');
    const racer = createRegisteredNameRepository(
      racing(stmt('UPDATE source SET project_id = ? WHERE id = ?', P2, SRC_P1)),
    );
    expect(
      await racer.enable(a, p1Fence(), {
        id: SRC_P1,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_P1),
      }),
    ).toBe('not_found');
    expect(await status(SRC_P1)).toBe('paused');
  });

  it.each(['active', 'degraded', 'failing'])(
    'answers already_enabled on a %s source without bumping the epoch',
    async (current) => {
      expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
      await executor.batch([stmt('UPDATE source SET status = ? WHERE id = ?', current, SRC_ORG)]);
      const before = await snapshot();
      expect(
        await names.enable(a, orgFence(), {
          id: SRC_ORG,
          providerAnchors: ANCHORS,
          audit: audit('source.resume', SRC_ORG),
        }),
      ).toBe('already_enabled');
      expect(await snapshot()).toBe(before);
    },
  );

  it.each(['degraded', 'failing'])(
    'pauses a %s source when its last name is removed',
    async (s) => {
      expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
      await executor.batch([stmt('UPDATE source SET status = ? WHERE id = ?', s, SRC_ORG)]);
      expect(
        await names.remove(a, orgFence(), {
          id: NAME_1,
          providerAnchors: ANCHORS,
          audit: audit('registered_name.remove', NAME_1),
          pauseAudit: audit('source.pause', SRC_ORG),
        }),
      ).toBe('removed_and_paused');
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
    expect(
      await names.remove(a, orgFence(), {
        id: NAME_1,
        providerAnchors: ANCHORS,
        audit: audit('registered_name.remove', NAME_1),
        pauseAudit: audit('source.pause', SRC_PROXY),
      }),
    ).toBe('removed');
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
    expect(
      await names.enable(a, p1Fence(), {
        id: SRC_ARCHIVED,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_ARCHIVED),
      }),
    ).toBe('forbidden');
    expect(await status(SRC_ARCHIVED)).toBe('paused');
  });

  it('refuses the second enable after the last name is removed between them', async () => {
    expect(await add(orgFence(), NAME_1, SRC_ORG, 'acme/*')).toBe('added');
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_ORG),
      }),
    ).toBe('enabled');
    expect(
      await names.remove(a, orgFence(), {
        id: NAME_1,
        providerAnchors: ANCHORS,
        audit: audit('registered_name.remove', NAME_1),
        pauseAudit: audit('source.pause', SRC_ORG),
      }),
    ).toBe('removed_and_paused');
    expect(
      await names.enable(a, orgFence(), {
        id: SRC_ORG,
        providerAnchors: ANCHORS,
        audit: audit('source.resume', SRC_ORG),
      }),
    ).toBe('activation_requires_registered_names');
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
            db.selectNoFrom(
              sql<number>`(${coveredByRegisteredNames(a, SRC_ORG, 'composer', key)})`.as('held'),
            ),
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

describe('registered-name audit', () => {
  const pattern = 'acme/*';
  const target = () => ({
    id: NAME_1,
    providerAnchors: ANCHORS,
    audit: audit('registered_name.remove', NAME_1, pattern),
    pauseAudit: audit('source.pause', SRC_ORG),
  });
  const resume = () => ({
    id: SRC_ORG,
    providerAnchors: ANCHORS,
    audit: audit('source.resume', SRC_ORG),
  });
  const auditRows = () => rows('SELECT * FROM audit_pending ORDER BY id');

  beforeEach(async () => {
    await executor.batch([
      stmt(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', ?)",
        NAME_1,
        a.orgId,
        SRC_ORG,
        pattern,
      ),
      stmt('UPDATE source SET status = ? WHERE org_id = ? AND id = ?', 'active', a.orgId, SRC_ORG),
    ]);
  });

  it('stages one add event with the name target and pattern', async () => {
    const event = audit('registered_name.add', NAME_2, 'tools/*');
    expect(
      await names.add(a, orgFence(), {
        id: NAME_2,
        sourceId: SRC_ORG,
        pattern: 'tools/*',
        providerAnchors: ANCHORS,
        audit: event,
      }),
    ).toBe('added');
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        id: event.id,
        org_id: a.orgId,
        action: 'registered_name.add',
        target_type: 'registered_name',
        target_id: NAME_2,
        payload_json: event.payloadJson,
      }),
    ]);
  });

  it('stages exactly one remove event while the source remains covered, without a pause event', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'tools/*')",
        NAME_2,
        a.orgId,
        SRC_ORG,
      ),
    ]);
    const input = target();
    expect(await names.remove(a, orgFence(), input)).toBe('removed');
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        id: input.audit.id,
        action: 'registered_name.remove',
        target_id: NAME_1,
        payload_json: input.audit.payloadJson,
        org_id: a.orgId,
      }),
    ]);
    expect(await status(SRC_ORG)).toBe('active');
  });

  it('stages exactly the remove and pause events when removal pauses the source', async () => {
    const input = target();
    expect(await names.remove(a, orgFence(), input)).toBe('removed_and_paused');
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        id: input.audit.id,
        action: 'registered_name.remove',
        target_id: NAME_1,
        org_id: a.orgId,
      }),
      expect.objectContaining({
        id: input.pauseAudit.id,
        action: 'source.pause',
        target_type: 'source',
        target_id: SRC_ORG,
        org_id: a.orgId,
      }),
    ]);
    expect(await status(SRC_ORG)).toBe('paused');
  });

  it('does not stage a pause event for a source that was already paused', async () => {
    await executor.batch([
      stmt('UPDATE source SET status = ? WHERE org_id = ? AND id = ?', 'paused', a.orgId, SRC_ORG),
    ]);
    expect(await names.remove(a, orgFence(), target())).toBe('removed');
    expect(await auditRows()).toEqual([
      expect.objectContaining({ action: 'registered_name.remove' }),
    ]);
  });

  it('stages one resume event when enabling a source', async () => {
    await executor.batch([
      stmt('UPDATE source SET status = ? WHERE org_id = ? AND id = ?', 'paused', a.orgId, SRC_ORG),
    ]);
    const input = resume();
    expect(await names.enable(a, orgFence(), input)).toBe('enabled');
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        id: input.audit.id,
        action: 'source.resume',
        target_type: 'source',
        target_id: SRC_ORG,
        org_id: a.orgId,
      }),
    ]);
  });

  it('does not stage an event for already_enabled', async () => {
    expect(await names.enable(a, orgFence(), resume())).toBe('already_enabled');
    expect(await auditRows()).toEqual([]);
  });

  it.each(['add', 'remove', 'enable'] as const)(
    'does not stage events for forbidden %s before existence',
    async (operation) => {
      const traced: SqlExecutor = {
        driver: executor.driver,
        all: (statement) => {
          expect(statement.sql).not.toMatch(/from "(?:source|registered_name)"/);
          return executor.all(statement);
        },
        batch: () => {
          throw new Error('forbidden mutation reached a batch');
        },
      };
      const repository = createRegisteredNameRepository(traced);
      if (operation === 'add') {
        expect(
          await repository.add(a, p1Fence(), {
            id: NAME_2,
            sourceId: SRC_MISSING,
            pattern,
            providerAnchors: ANCHORS,
            audit: audit('registered_name.add', NAME_2, pattern),
          }),
        ).toBe('forbidden');
      } else if (operation === 'remove') {
        expect(await repository.remove(a, p1Fence(), { ...target(), id: NAME_3 })).toBe(
          'forbidden',
        );
      } else {
        // Enable reads the source to determine the scope of its authority check.
        expect(await names.enable(a, p1Fence(), { ...resume(), id: SRC_MISSING })).toBe(
          'forbidden',
        );
      }
      expect(await auditRows()).toEqual([]);
    },
  );

  it('does not stage events for pattern_taken', async () => {
    expect(await add(orgFence(), NAME_2, SRC_P1, pattern)).toBe('pattern_taken');
    expect(await auditRows()).toEqual([]);
  });

  it('does not stage events for invalid_pattern', async () => {
    expect(await add(orgFence(), NAME_2, SRC_ORG, '*')).toBe('invalid_pattern');
    expect(await auditRows()).toEqual([]);
  });

  it.each(['add', 'remove', 'enable'] as const)(
    'does not stage events for not_found %s',
    async (operation) => {
      if (operation === 'add')
        expect(await add(orgFence(), NAME_2, SRC_MISSING, pattern)).toBe('not_found');
      if (operation === 'remove')
        expect(await names.remove(a, orgFence(), { ...target(), id: NAME_3 })).toBe('not_found');
      if (operation === 'enable')
        expect(await names.enable(a, orgFence(), { ...resume(), id: SRC_MISSING })).toBe(
          'not_found',
        );
      expect(await auditRows()).toEqual([]);
    },
  );

  it('does not stage events for a conflict in the fenced add', async () => {
    const racer = createRegisteredNameRepository({
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        await executor.batch([
          stmt(
            'UPDATE source SET ecosystem = ? WHERE org_id = ? AND id = ?',
            'npm',
            a.orgId,
            SRC_ORG,
          ),
        ]);
        return executor.batch(statements);
      },
    });
    expect(
      await racer.add(a, orgFence(), {
        id: NAME_2,
        sourceId: SRC_ORG,
        pattern: 'tools/*',
        providerAnchors: ANCHORS,
        audit: audit('registered_name.add', NAME_2, 'tools/*'),
      }),
    ).toBe('conflict');
    expect(await auditRows()).toEqual([]);
    expect(await rows('SELECT id FROM registered_name WHERE id = ?', NAME_2)).toEqual([]);
  });

  it('does not stage events in either organization for a foreign source', async () => {
    seedOrg = b;
    await executor.batch([seedSource(SRC_B, 'foreign')]);
    seedOrg = a;
    expect(await add(orgFence(), NAME_2, SRC_B, 'tools/*')).toBe('not_found');
    expect(await rows('SELECT id FROM audit_pending WHERE org_id = ?', a.orgId)).toEqual([]);
    expect(await rows('SELECT id FROM audit_pending WHERE org_id = ?', b.orgId)).toEqual([]);
  });

  it('rolls back removal, pause and both events when the audit insert fails', async () => {
    const input = target();
    input.pauseAudit.id = input.audit.id;
    expect(await names.remove(a, orgFence(), input)).toBe('conflict');
    expect(await auditRows()).toEqual([]);
    expect(await status(SRC_ORG)).toBe('active');
    expect(await rows('SELECT id FROM registered_name WHERE id = ?', NAME_1)).toEqual([
      { id: NAME_1 },
    ]);
  });
});

describe('registered-name idempotency', () => {
  const cases = [
    ['add', 'added'],
    ['remove', 'removed_and_paused'],
    ['remove-covered', 'removed'],
    ['enable', 'enabled'],
  ] as const;
  type Operation = (typeof cases)[number][0];

  function record(result: string, requestHash = 'a'.repeat(64)): IdempotencyRecord {
    return {
      principalKey: `user:${ORG_ADMIN}`,
      key: 'registered-name-request',
      route: '/sources/registered-names',
      requestHash,
      status: 200,
      responseJson: JSON.stringify({ result }),
      createdAt: NOW,
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
  }

  async function state() {
    return Promise.all(
      ['source', 'registered_name', 'cache_epoch', 'audit_pending', 'api_idempotency'].map(
        (table) => rows(`SELECT * FROM ${table} WHERE org_id = ? ORDER BY 1, 2`, a.orgId),
      ),
    );
  }

  async function fixture(operation: Operation, target = executor) {
    if (operation !== 'add') {
      await executor.batch([
        stmt(
          "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'acme/*')",
          NAME_1,
          a.orgId,
          SRC_ORG,
        ),
      ]);
    }
    if (operation.startsWith('remove')) {
      await executor.batch([
        stmt("UPDATE source SET status = 'active' WHERE org_id = ? AND id = ?", a.orgId, SRC_ORG),
      ]);
    }
    if (operation === 'remove-covered') {
      await executor.batch([
        stmt(
          "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'tools/*')",
          NAME_2,
          a.orgId,
          SRC_ORG,
        ),
      ]);
    }
    const repository = createRegisteredNameRepository(target);
    return (idempotency: IdempotencyRecord) => {
      const common = { providerAnchors: ANCHORS, idempotency };
      if (operation === 'add')
        return repository.add(a, orgFence(), {
          ...common,
          id: NAME_2,
          sourceId: SRC_ORG,
          pattern: 'tools/*',
          audit: audit('registered_name.add', NAME_2, 'tools/*'),
        });
      if (operation === 'enable')
        return repository.enable(a, orgFence(), {
          ...common,
          id: SRC_ORG,
          audit: audit('source.resume', SRC_ORG),
        });
      return repository.remove(a, orgFence(), {
        ...common,
        id: NAME_1,
        audit: audit('registered_name.remove', NAME_1),
        pauseAudit: audit('source.pause', SRC_ORG),
      });
    };
  }

  it.each(cases)(
    '%s persists the response and replays the original success',
    async (operation, success) => {
      const invoke = await fixture(operation);
      const saved = record(success);
      expect(await invoke(saved)).toBe(success);
      const find = () =>
        createIdempotencyRepository(executor).find(a, saved.principalKey, saved.key, NOW);
      expect(await find()).toEqual(saved);
      const before = await state();
      const replay = await settleIdempotent({
        record: saved,
        hash: saved.requestHash,
        now: new Date(NOW),
        find,
        run: () => invoke(saved),
        failed: (result) => result !== success,
      });
      expect(replay).toEqual({ kind: 'replay', record: saved });
      if (replay.kind !== 'replay') throw new Error('expected replay');
      const response = replayResponse(replay.record, 'retry');
      expect(response.status).toBe(200);
      expect(response.headers.get('Idempotent-Replayed')).toBe('true');
      expect(await response.json()).toEqual({ result: success });
      expect(await state()).toEqual(before);
      const changed = record(success, 'b'.repeat(64));
      expect(
        await settleIdempotent({
          record: changed,
          hash: changed.requestHash,
          now: new Date(NOW),
          find,
          run: () => invoke(changed),
          failed: (result) => result !== success,
        }),
      ).toEqual({ kind: 'mismatch' });
      expect(await state()).toEqual(before);
    },
  );

  it.each(cases)('%s rejects a direct retry with a different body', async (operation, success) => {
    const invoke = await fixture(operation);
    const saved = record(success);
    expect(await invoke(saved)).toBe(success);
    const before = await state();
    expect(await invoke(record(success, 'b'.repeat(64)))).toBe('conflict');
    expect(await state()).toEqual(before);
    expect(
      await createIdempotencyRepository(executor).find(a, saved.principalKey, saved.key, NOW),
    ).toEqual(saved);
  });

  it.each(cases)(
    '%s preserves the original response after a direct retry with the same body',
    async (operation, success) => {
      const invoke = await fixture(operation);
      const saved = record(success);
      expect(await invoke(saved)).toBe(success);
      const before = await state();
      expect(await invoke(saved)).toBe('conflict');
      const winner = await createIdempotencyRepository(executor).find(
        a,
        saved.principalKey,
        saved.key,
        NOW,
      );
      expect(winner).toEqual(saved);
      if (winner === null) throw new Error('expected original response');
      const response = replayResponse(winner, 'direct-retry');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: success });
      expect(await state()).toEqual(before);
    },
  );

  it.each(cases)('%s checks authorization before a reused key', async (operation, success) => {
    const invoke = await fixture(operation);
    const saved = record(success);
    expect(await invoke(saved)).toBe(success);
    await executor.batch([
      stmt('DELETE FROM access_grant WHERE org_id = ? AND role_id = ?', a.orgId, ORG_ROLE),
    ]);
    const before = await state();
    expect(await invoke(record(success, 'b'.repeat(64)))).toBe('forbidden');
    expect(await state()).toEqual(before);
  });

  for (const hash of ['a'.repeat(64), 'b'.repeat(64)]) {
    it.each(cases)(
      `%s fences a concurrent key winner (hash ${hash[0]})`,
      async (operation, success) => {
        const winner = record(success);
        const racer: SqlExecutor = {
          driver: executor.driver,
          all: (statement) => executor.all(statement),
          batch: async (statements) => {
            await executor.batch([idempotencyInsertStatement(a, winner)]);
            return executor.batch(statements);
          },
        };
        const invoke = await fixture(operation, racer);
        const before = await state();
        expect(await invoke(record(success, hash))).toBe('conflict');
        const after = await state();
        expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
        expect(
          await createIdempotencyRepository(executor).find(a, winner.principalKey, winner.key, NOW),
        ).toEqual(winner);
      },
    );
  }

  for (const failure of ['audit', 'after-record'] as const) {
    it.each(cases)(
      `%s rolls back all effects on ${failure} failure`,
      async (operation, success) => {
        const failing: SqlExecutor = {
          driver: executor.driver,
          all: (statement) => executor.all(statement),
          batch: (statements) =>
            executor.batch([
              ...statements,
              stmt("INSERT INTO access_mutation_guard (key) VALUES ('injected'), ('injected')"),
            ]),
        };
        const invoke = await fixture(operation, failure === 'audit' ? executor : failing);
        if (failure === 'audit')
          await executor.batch([
            stmt(
              "CREATE TRIGGER fail_registered_name_audit BEFORE INSERT ON audit_pending BEGIN SELECT RAISE(ABORT, 'injected'); END",
            ),
          ]);
        const before = await state();
        expect(await invoke(record(success))).toBe(
          failure === 'audit' ? 'indeterminate' : 'conflict',
        );
        expect(await state()).toEqual(before);
      },
    );
  }

  it.each(cases)(
    '%s succeeds over an expired record with the same key',
    async (operation, success) => {
      const saved = record(success);
      await executor.batch([
        idempotencyInsertStatement(a, {
          ...saved,
          requestHash: 'c'.repeat(64),
          createdAt: '2026-10-13T12:00:00.000Z',
          expiresAt: '2026-10-14T12:00:00.000Z',
        }),
      ]);
      const invoke = await fixture(operation);
      expect(await invoke(saved)).toBe(success);
      expect(
        await createIdempotencyRepository(executor).find(a, saved.principalKey, saved.key, NOW),
      ).toEqual(saved);
    },
  );

  it.each(['organization', 'principal'] as const)(
    'allows the same key for another %s',
    async (scope) => {
      const saved = record('added');
      await executor.batch([
        idempotencyInsertStatement(scope === 'organization' ? b : a, {
          ...saved,
          principalKey: scope === 'principal' ? 'user:other' : saved.principalKey,
        }),
      ]);
      const invoke = await fixture('add');
      expect(await invoke(saved)).toBe('added');
      expect(
        await createIdempotencyRepository(executor).find(a, saved.principalKey, saved.key, NOW),
      ).toEqual(saved);
    },
  );
});
