import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import { deriveVisibility } from '@package-broker/core/catalogue/visibility';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { ProtectedHolderProvider } from '../kysely.js';
import {
  seedCatalogue,
  toVisibilityInputs,
  type CatalogueConfig,
  type FixtureAttachment,
  type FixtureExplicit,
  type FixturePackage,
  type FixturePattern,
} from '../testing/catalogue-fixture.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { attachSourceStatements, createVisibilityAttachRepository } from './visibility-attach.js';

const ORG_A = '01J00000000000000000000A0A';
const ORG_B = '01J00000000000000000000B0B';
const PA = '01J0PROJECT00000000000000A1';
const PB = '01J0PROJECT00000000000000B1';
const PX = '01J0PROJECT00000000000000X1';
const PN = '01J0PROJECT00000000000000N1';
const P_FOREIGN = '01J0PROJECT00000000000000F1';
const SO = '01J0SOURCE0000000000000ORG1';
const SP = '01J0SOURCE0000000000000PRX1';
const SB = '01J0SOURCE0000000000000PRB1';
const S_FOREIGN = '01J0SOURCE0000000000000FOR1';
const K1 = '01J0PACKAGE00000000000000K1';
const K2 = '01J0PACKAGE00000000000000K2';
const K3 = '01J0PACKAGE00000000000000K3';
const KP = '01J0PACKAGE00000000000000KP';
const KB = '01J0PACKAGE00000000000000KB';
const OWNER = '01J0USER000000000000000001';
const ADMIN = '01J0USER000000000000000002';
const OWNER_SESSION = '01J0SESSION000000000000001';
const ADMIN_SESSION = '01J0SESSION000000000000002';
const OWNER_ROLE = '01J0ROLEOWNER0000000000000A';
const ADMIN_ROLE = '01J0ROLEADMIN0000000000000A';
const OWNER_GRANTS = ['01J0GRANT000000000000000A1', '01J0GRANT000000000000000A2'];

const ANCHORS: readonly ProtectedHolderProvider[] = [
  { provider: 'oidc', anchor: 'oidc:https://idp.example.test', emailAuthoritative: true },
];

let database: MigratedDatabase;
let executor: SqlExecutor;
let a: OrgContext;
let b: OrgContext;
let config: Mutable;

interface Mutable extends Omit<
  CatalogueConfig,
  'attachments' | 'patterns' | 'explicit' | 'packages' | 'projects'
> {
  attachments: FixtureAttachment[];
  patterns: FixturePattern[];
  explicit: FixtureExplicit[];
  packages: FixturePackage[];
  projects: CatalogueConfig['projects'][number][];
}

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

const pkg = (id: string, sourceId: string, key: string, visible: 0 | 1): FixturePackage => ({
  id,
  orgId: ORG_A,
  sourceId,
  ecosystem: 'composer',
  key,
  visible,
  status: 'active',
});

function baseConfig(): Mutable {
  const project = (id: string, slug: string, status: 'active' | 'archived', orgId = ORG_A) => ({
    id,
    orgId,
    slug,
    name: slug,
    status,
  });
  const source = (
    id: string,
    projectId: string | null,
    type: 'vcs' | 'packagist_proxy',
    orgId = ORG_A,
  ) => ({
    id,
    orgId,
    projectId,
    name: id.toLowerCase(),
    ecosystem: 'composer' as const,
    type,
    defaultVisible: 1 as const,
    removalPolicy: 'flag' as const,
  });
  return {
    organizations: [
      { id: ORG_A, slug: 'org-a', name: 'Organization A' },
      { id: ORG_B, slug: 'org-b', name: 'Organization B' },
    ],
    projects: [
      project(PA, 'pa', 'active'),
      project(PB, 'pb', 'active'),
      project(PX, 'px', 'archived'),
      project(P_FOREIGN, 'pf', 'active', ORG_B),
    ],
    sources: [
      source(SO, null, 'vcs'),
      source(SP, null, 'packagist_proxy'),
      source(SB, PB, 'vcs'),
      source(S_FOREIGN, null, 'vcs', ORG_B),
    ],
    attachments: [{ orgId: ORG_A, projectId: PB, sourceId: SO, precedence: 100 }],
    patterns: [],
    packages: [
      pkg(K1, SO, 'v0/k1', 1),
      pkg(K2, SO, 'v0/k2', 0),
      pkg(K3, SO, 'v1/k3', 1),
      pkg(KP, SP, 'v2/kp', 1),
      pkg(KB, SB, 'v0/kb', 1),
    ],
    explicit: [],
    registeredNames: [],
    versions: [],
  };
}

interface Row {
  readonly projectId: string;
  readonly packageId: string;
  readonly origin: string;
}

const sortRows = (rows: Row[]): Row[] =>
  [...rows].sort((x, y) =>
    `${x.projectId}\0${x.packageId}` < `${y.projectId}\0${y.packageId}` ? -1 : 1,
  );

async function rows(): Promise<Row[]> {
  const result = await executor.all<Row>(
    stmt(
      'SELECT project_id AS projectId, package_id AS packageId, origin FROM project_package WHERE org_id = ?',
      ORG_A,
    ),
  );
  return sortRows(result);
}

function oracle(): Row[] {
  return sortRows(
    deriveVisibility(toVisibilityInputs(config)).map((r) => ({
      projectId: r.projectId,
      packageId: r.packageId,
      origin: r.origin,
    })),
  );
}

async function attachment(projectId: string, sourceId: string): Promise<number | undefined> {
  const [row] = await executor.all<{ precedence: number }>(
    stmt(
      'SELECT precedence FROM project_source WHERE project_id = ? AND source_id = ?',
      projectId,
      sourceId,
    ),
  );
  return row?.precedence;
}

async function patternCount(projectId: string, sourceId: string): Promise<number> {
  const [row] = await executor.all<{ n: number }>(
    stmt(
      'SELECT count(*) AS n FROM project_package_pattern WHERE project_id = ? AND source_id = ?',
      projectId,
      sourceId,
    ),
  );
  return row?.n ?? 0;
}

async function epoch(): Promise<string> {
  const [row] = await executor.all<{ version: string }>(
    stmt('SELECT version FROM cache_epoch WHERE org_id = ?', ORG_A),
  );
  return row?.version ?? '';
}

const fence = (userId: string, sessionId: string): MutationFence =>
  mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
const owner = () => fence(OWNER, OWNER_SESSION);
const admin = () => fence(ADMIN, ADMIN_SESSION);

function seedActors(): Statement[] {
  const now = new Date().toISOString();
  const out: Statement[] = [];
  const role = (id: string, scope: string, permissions: readonly string[]) => {
    out.push(
      stmt(
        'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)',
        id,
        ORG_A,
        id.toLowerCase(),
        id,
        scope,
      ),
      ...permissions.map((p) =>
        stmt(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          ORG_A,
          id,
          p,
        ),
      ),
    );
  };
  role(OWNER_ROLE, 'project', ['project:sources:write', 'project:packages:manage']);
  role(ADMIN_ROLE, 'organization', ['org:sources:write']);
  out.push(
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      ORG_A,
      'oidc',
      'oidc:https://idp.example.test',
    ),
  );
  const users = [
    [OWNER, OWNER_SESSION, 'owner@example.test', '01J0IDENT00000000000000001'],
    [ADMIN, ADMIN_SESSION, 'admin@example.test', '01J0IDENT00000000000000002'],
  ] as const;
  for (const [userId, sessionId, email, identityId] of users) {
    const hash = sessionId
      .toLowerCase()
      .replace(/[^0-9a-f]/g, 'a')
      .padEnd(64, '0');
    out.push(
      stmt(
        'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
        userId,
        ORG_A,
        email,
        'active',
      ),
      stmt(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        identityId,
        ORG_A,
        userId,
        'oidc',
        `subject-${identityId}`,
        email,
        new Date(Date.now() - 60_000).toISOString(),
      ),
      stmt(
        'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        sessionId,
        ORG_A,
        userId,
        hash,
        hash,
        now,
        now,
        '2999-01-01T00:00:00.000Z',
      ),
    );
  }
  const grant = (id: string, email: string, roleId: string, projectId: string | null) =>
    stmt(
      'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
      id,
      ORG_A,
      'email',
      email,
      projectId === null ? 'organization' : 'project',
      projectId,
      roleId,
      now,
      now,
    );
  out.push(
    grant(OWNER_GRANTS[0] as string, 'owner@example.test', OWNER_ROLE, PA),
    grant(OWNER_GRANTS[1] as string, 'owner@example.test', OWNER_ROLE, PX),
    grant('01J0GRANT000000000000000A3', 'owner@example.test', OWNER_ROLE, PB),
    grant('01J0GRANT000000000000000A4', 'admin@example.test', ADMIN_ROLE, null),
  );
  return out;
}

async function seedDerived(): Promise<void> {
  const derived = oracle().filter((r) => r.origin !== 'explicit');
  if (derived.length === 0) return;
  await executor.batch(
    derived.map((r) =>
      stmt(
        'INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, ?)',
        ORG_A,
        r.projectId,
        r.packageId,
        r.origin,
      ),
    ),
  );
}

function repository(on: SqlExecutor = executor) {
  return createVisibilityAttachRepository(on, { providerAnchors: ANCHORS });
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  config = baseConfig();
  await seedCatalogue(executor, config);
  await seedDerived();
  await executor.batch(seedActors());
});

afterEach(async () => {
  await database.close();
});

describe('attachSource', () => {
  it('1: a project owner without org:sources:write cannot attach an organization source', async () => {
    const before = await epoch();
    const outcome = await repository().attachSource(a, owner(), { projectId: PA, sourceId: SO });
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    expect(await attachment(PA, SO)).toBeUndefined();
    expect(await rows()).toEqual(oracle());
    expect(await epoch()).toBe(before);
  });

  it('1: an org admin attaches organization sources with default precedence; rows equal the oracle', async () => {
    const before = await epoch();
    const repo = repository();
    const first = await repo.attachSource(a, admin(), { projectId: PA, sourceId: SO });
    expect(first.ok).toBe(true);
    expect((await repo.attachSource(a, admin(), { projectId: PA, sourceId: SP })).ok).toBe(true);
    config.attachments.push(
      { orgId: ORG_A, projectId: PA, sourceId: SO, precedence: 100 },
      { orgId: ORG_A, projectId: PA, sourceId: SP, precedence: 1000 },
    );
    expect(await attachment(PA, SO)).toBe(100);
    expect(await attachment(PA, SP)).toBe(1000);
    expect(await rows()).toEqual(oracle());
    expect((await rows()).filter((r) => r.projectId === PA).map((r) => r.packageId)).toEqual(
      expect.arrayContaining([K1, K3, KP]),
    );
    expect(await epoch()).not.toBe(before);
  });

  it('re-attaching with a precedence updates it; without one keeps it', async () => {
    const repo = repository();
    expect(
      (await repo.attachSource(a, admin(), { projectId: PA, sourceId: SO, precedence: 7 })).ok,
    ).toBe(true);
    expect(await attachment(PA, SO)).toBe(7);
    expect(
      (await repo.attachSource(a, admin(), { projectId: PA, sourceId: SO, precedence: 40 })).ok,
    ).toBe(true);
    expect(await attachment(PA, SO)).toBe(40);
    expect((await repo.attachSource(a, admin(), { projectId: PA, sourceId: SO })).ok).toBe(true);
    expect(await attachment(PA, SO)).toBe(40);
  });

  it('the owner attaches its own project-level source with project:sources:write', async () => {
    const outcome = await repository().attachSource(a, owner(), { projectId: PB, sourceId: SB });
    expect(outcome.ok).toBe(true);
    config.attachments.push({ orgId: ORG_A, projectId: PB, sourceId: SB, precedence: 100 });
    expect(await rows()).toEqual(oracle());
  });

  it('a foreign project-level source is refused before the batch, even for an org admin', async () => {
    const before = await epoch();
    for (const actor of [owner(), admin()]) {
      const outcome = await repository().attachSource(a, actor, { projectId: PA, sourceId: SB });
      expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    }
    expect(await attachment(PA, SB)).toBeUndefined();
    expect(await epoch()).toBe(before);
  });

  it('a source that becomes foreign between the read and the batch is refused inside the batch', async () => {
    const before = await epoch();
    const racing: SqlExecutor = {
      driver: executor.driver,
      all: (s) => executor.all(s),
      batch: async (statements) => {
        await executor.batch([stmt('UPDATE source SET project_id = ? WHERE id = ?', PB, SO)]);
        return executor.batch(statements);
      },
    };
    const outcome = await repository(racing).attachSource(a, admin(), {
      projectId: PA,
      sourceId: SO,
    });
    expect(outcome.ok).toBe(false);
    expect(await attachment(PA, SO)).toBeUndefined();
    expect(await epoch()).toBe(before);
  });

  it('another organization cannot attach by id in either direction', async () => {
    const repo = repository();
    expect(await repo.attachSource(a, admin(), { projectId: PA, sourceId: S_FOREIGN })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await repo.attachSource(a, admin(), { projectId: P_FOREIGN, sourceId: SO })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await repo.attachSource(b, admin(), { projectId: PA, sourceId: SO })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await attachment(PA, S_FOREIGN)).toBeUndefined();
    expect(await attachment(P_FOREIGN, SO)).toBeUndefined();
  });

  it('3: attach to an archived project is refused', async () => {
    const before = await epoch();
    const outcome = await repository().attachSource(a, admin(), { projectId: PX, sourceId: SO });
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    expect(await attachment(PX, SO)).toBeUndefined();
    expect(await epoch()).toBe(before);
  });

  it('3: a revoked actor rolls back with no row and no epoch change', async () => {
    await executor.batch([
      stmt(
        'UPDATE session SET revoked_at = ? WHERE id = ?',
        new Date().toISOString(),
        ADMIN_SESSION,
      ),
    ]);
    const before = await epoch();
    const outcome = await repository().attachSource(a, admin(), { projectId: PA, sourceId: SO });
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    expect(await attachment(PA, SO)).toBeUndefined();
    expect(await rows()).toEqual(oracle());
    expect(await epoch()).toBe(before);
  });

  it('refuses a precedence that is not a non-negative safe integer', async () => {
    for (const precedence of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        repository().attachSource(a, admin(), { projectId: PA, sourceId: SO, precedence }),
      ).rejects.toThrow(RangeError);
    }
  });
});

describe('detachSource', () => {
  async function narrowedPa(): Promise<void> {
    expect((await repository().attachSource(a, admin(), { projectId: PA, sourceId: SO })).ok).toBe(
      true,
    );
    config.attachments.push({ orgId: ORG_A, projectId: PA, sourceId: SO, precedence: 100 });
    config.patterns.push({
      id: '01J0PATTERN00000000000000I1',
      orgId: ORG_A,
      projectId: PA,
      sourceId: SO,
      pattern: 'v0/*',
      effect: 'include',
    });
    config.explicit.push({ orgId: ORG_A, projectId: PA, packageId: K2 });
    await executor.batch([
      stmt(
        "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, ?, ?, ?, 'include')",
        '01J0PATTERN00000000000000I1',
        ORG_A,
        PA,
        SO,
        'v0/*',
      ),
      stmt(
        "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'explicit')",
        ORG_A,
        PA,
        K2,
      ),
      stmt(
        "UPDATE project_package SET origin = 'pattern' WHERE project_id = ? AND package_id = ?",
        PA,
        K1,
      ),
      stmt('DELETE FROM project_package WHERE project_id = ? AND package_id = ?', PA, K3),
    ]);
    expect(await rows()).toEqual(oracle());
  }

  it('2: detach removes explicit and pattern rows of the source; re-attach starts clean', async () => {
    await narrowedPa();
    const before = await epoch();
    expect((await repository().detachSource(a, owner(), { projectId: PA, sourceId: SO })).ok).toBe(
      true,
    );
    expect(await epoch()).not.toBe(before);
    config.attachments = config.attachments.filter((x) => x.projectId !== PA);
    config.patterns = [];
    config.explicit = [];
    expect(await attachment(PA, SO)).toBeUndefined();
    expect(await patternCount(PA, SO)).toBe(0);
    expect((await rows()).filter((r) => r.projectId === PA)).toEqual([]);
    expect(await rows()).toEqual(oracle());

    expect((await repository().attachSource(a, admin(), { projectId: PA, sourceId: SO })).ok).toBe(
      true,
    );
    config.attachments.push({ orgId: ORG_A, projectId: PA, sourceId: SO, precedence: 100 });
    const pa = (await rows()).filter((r) => r.projectId === PA);
    expect(pa.map((r) => [r.packageId, r.origin])).toEqual([
      [K1, 'subscription'],
      [K3, 'subscription'],
    ]);
    expect(await rows()).toEqual(oracle());
  });

  it('leaves other projects and other sources of the project untouched', async () => {
    await narrowedPa();
    expect((await repository().attachSource(a, admin(), { projectId: PA, sourceId: SP })).ok).toBe(
      true,
    );
    config.attachments.push({ orgId: ORG_A, projectId: PA, sourceId: SP, precedence: 1000 });
    expect((await repository().detachSource(a, owner(), { projectId: PA, sourceId: SO })).ok).toBe(
      true,
    );
    config.attachments = config.attachments.filter(
      (x) => !(x.projectId === PA && x.sourceId === SO),
    );
    config.patterns = [];
    config.explicit = [];
    expect(await rows()).toEqual(oracle());
    expect((await rows()).some((r) => r.projectId === PB && r.packageId === K1)).toBe(true);
    expect((await rows()).some((r) => r.projectId === PA && r.packageId === KP)).toBe(true);
  });

  it('3: detach is allowed on an archived project', async () => {
    await executor.batch([
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, 100)',
        ORG_A,
        PX,
        SO,
      ),
    ]);
    const outcome = await repository().detachSource(a, owner(), { projectId: PX, sourceId: SO });
    expect(outcome.ok).toBe(true);
    expect(await attachment(PX, SO)).toBeUndefined();
  });

  it('3: a revoked actor cannot detach and nothing changes', async () => {
    await narrowedPa();
    await executor.batch(
      OWNER_GRANTS.map((id) => stmt('DELETE FROM access_grant WHERE id = ?', id)),
    );
    const before = await epoch();
    const outcome = await repository().detachSource(a, owner(), { projectId: PA, sourceId: SO });
    expect(outcome).toEqual({ ok: false, reason: 'authority' });
    expect(await attachment(PA, SO)).toBe(100);
    expect(await patternCount(PA, SO)).toBe(1);
    expect(await rows()).toEqual(oracle());
    expect(await epoch()).toBe(before);
  });

  it('a detach raced by another detach is a conflict and does not bump the epoch', async () => {
    await narrowedPa();
    const racing: SqlExecutor = {
      driver: executor.driver,
      all: (s) => executor.all(s),
      batch: async (statements) => {
        await executor.batch([
          stmt('DELETE FROM project_source WHERE project_id = ? AND source_id = ?', PA, SO),
        ]);
        return executor.batch(statements);
      },
    };
    const before = await epoch();
    const outcome = await repository(racing).detachSource(a, owner(), {
      projectId: PA,
      sourceId: SO,
    });
    expect(outcome).toEqual({ ok: false, reason: 'conflict' });
    expect(await patternCount(PA, SO)).toBe(1);
    expect(await epoch()).toBe(before);
  });

  it('a source that is not attached is not_found', async () => {
    expect(await repository().detachSource(a, owner(), { projectId: PA, sourceId: SP })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('setPrecedence', () => {
  it('requires project:sources:write and changes only the precedence', async () => {
    expect(
      (await repository().setPrecedence(a, owner(), { projectId: PB, sourceId: SO, precedence: 5 }))
        .ok,
    ).toBe(true);
    expect(await attachment(PB, SO)).toBe(5);
    expect(await rows()).toEqual(oracle());
    expect(
      await repository().setPrecedence(a, admin(), { projectId: PB, sourceId: SO, precedence: 6 }),
    ).toEqual({
      ok: false,
      reason: 'authority',
    });
    expect(await attachment(PB, SO)).toBe(5);
  });

  it('is refused on an archived project and for a detached source', async () => {
    await executor.batch([
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, 100)',
        ORG_A,
        PX,
        SO,
      ),
    ]);
    expect(
      await repository().setPrecedence(a, owner(), { projectId: PX, sourceId: SO, precedence: 5 }),
    ).toEqual({
      ok: false,
      reason: 'authority',
    });
    expect(await attachment(PX, SO)).toBe(100);
    expect(
      await repository().setPrecedence(a, owner(), { projectId: PA, sourceId: SO, precedence: 5 }),
    ).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('setPackageFlag', () => {
  it('a flip changes only visible_to_new_projects and leaves updated_at alone', async () => {
    const read = async () =>
      (
        await executor.all<{ updated_at: string; rev: number; modified_at: string; v: number }>(
          stmt(
            'SELECT updated_at, rev, modified_at, visible_to_new_projects AS v FROM package WHERE id = ?',
            K1,
          ),
        )
      )[0];
    const before = await read();
    expect(
      (
        await repository().setPackageFlag(a, admin(), {
          packageId: K1,
          visibleToNewProjects: false,
        })
      ).ok,
    ).toBe(true);
    const after = await read();
    expect(after).toEqual({ ...before, v: 0 });
  });

  it('2: flag 1->0 removes subscription and pattern rows but not explicit ones; 0->1 restores', async () => {
    expect((await repository().attachSource(a, admin(), { projectId: PA, sourceId: SO })).ok).toBe(
      true,
    );
    config.attachments.push({ orgId: ORG_A, projectId: PA, sourceId: SO, precedence: 100 });
    await executor.batch([
      stmt(
        "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, ?, ?, ?, 'include')",
        '01J0PATTERN00000000000000I1',
        ORG_A,
        PA,
        SO,
        'v0/*',
      ),
      stmt(
        "UPDATE project_package SET origin = 'explicit' WHERE project_id = ? AND package_id = ?",
        PB,
        K1,
      ),
      stmt(
        "UPDATE project_package SET origin = 'pattern' WHERE project_id = ? AND package_id = ?",
        PA,
        K1,
      ),
      stmt('DELETE FROM project_package WHERE project_id = ? AND package_id = ?', PA, K3),
    ]);
    config.patterns.push({
      id: '01J0PATTERN00000000000000I1',
      orgId: ORG_A,
      projectId: PA,
      sourceId: SO,
      pattern: 'v0/*',
      effect: 'include',
    });
    config.explicit.push({ orgId: ORG_A, projectId: PB, packageId: K1 });
    expect(await rows()).toEqual(oracle());

    const before = await epoch();
    expect(
      (
        await repository().setPackageFlag(a, admin(), {
          packageId: K1,
          visibleToNewProjects: false,
        })
      ).ok,
    ).toBe(true);
    expect(await epoch()).not.toBe(before);
    config.packages = config.packages.map((p) => (p.id === K1 ? { ...p, visible: 0 } : p));
    const k1 = (await rows()).filter((r) => r.packageId === K1);
    expect(k1).toEqual([{ projectId: PB, packageId: K1, origin: 'explicit' }]);
    expect(await rows()).toEqual(oracle());

    expect(
      (await repository().setPackageFlag(a, admin(), { packageId: K1, visibleToNewProjects: true }))
        .ok,
    ).toBe(true);
    config.packages = config.packages.map((p) => (p.id === K1 ? { ...p, visible: 1 } : p));
    expect(await rows()).toEqual(oracle());
  });

  it('a project owner cannot flip an organization source package', async () => {
    const before = await epoch();
    expect(
      await repository().setPackageFlag(a, owner(), { packageId: K1, visibleToNewProjects: false }),
    ).toEqual({
      ok: false,
      reason: 'authority',
    });
    expect(await rows()).toEqual(oracle());
    expect(await epoch()).toBe(before);
  });

  it('the owner flips its own project-level source package; an org admin alone cannot', async () => {
    await executor.batch([
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, 100)',
        ORG_A,
        PB,
        SB,
      ),
      stmt(
        "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'subscription')",
        ORG_A,
        PB,
        KB,
      ),
    ]);
    config.attachments.push({ orgId: ORG_A, projectId: PB, sourceId: SB, precedence: 100 });
    expect(await rows()).toEqual(oracle());
    expect(
      await repository().setPackageFlag(a, admin(), { packageId: KB, visibleToNewProjects: false }),
    ).toEqual({
      ok: false,
      reason: 'authority',
    });
    expect(
      (
        await repository().setPackageFlag(a, owner(), {
          packageId: KB,
          visibleToNewProjects: false,
        })
      ).ok,
    ).toBe(true);
    config.packages = config.packages.map((p) => (p.id === KB ? { ...p, visible: 0 } : p));
    expect(await rows()).toEqual(oracle());
  });

  it('an unknown or foreign package is not_found', async () => {
    expect(
      await repository().setPackageFlag(b, admin(), { packageId: K1, visibleToNewProjects: false }),
    ).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('attachSourceStatements', () => {
  it('writes nothing for a project id of another organization', async () => {
    await executor.batch(attachSourceStatements(a, P_FOREIGN));
    const [row] = await executor.all<{ n: number }>(
      stmt('SELECT count(*) AS n FROM project_source WHERE project_id = ?', P_FOREIGN),
    );
    expect(row?.n).toBe(0);
    const [derived] = await executor.all<{ n: number }>(
      stmt('SELECT count(*) AS n FROM project_package WHERE project_id = ?', P_FOREIGN),
    );
    expect(derived?.n).toBe(0);
  });

  it('attaches every organization source to a new project with default precedence', async () => {
    await executor.batch([
      stmt(
        'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
        PN,
        ORG_A,
        'pn',
        'pn',
        'active',
      ),
    ]);
    const statements = attachSourceStatements(a, PN);
    for (const s of statements) expect(s.params.length).toBeLessThanOrEqual(100);
    await executor.batch(statements);
    config.projects.push({ id: PN, orgId: ORG_A, slug: 'pn', name: 'pn', status: 'active' });
    config.attachments.push(
      { orgId: ORG_A, projectId: PN, sourceId: SO, precedence: 100 },
      { orgId: ORG_A, projectId: PN, sourceId: SP, precedence: 1000 },
    );
    expect(await attachment(PN, SO)).toBe(100);
    expect(await attachment(PN, SP)).toBe(1000);
    expect(await attachment(PN, SB)).toBeUndefined();
    expect(await attachment(PN, S_FOREIGN)).toBeUndefined();
    expect(await rows()).toEqual(oracle());
  });
});

describe('D1 limits', () => {
  const MAX_PROVIDERS = 64;
  const maxAnchors: readonly ProtectedHolderProvider[] = [
    ...ANCHORS,
    ...Array.from({ length: MAX_PROVIDERS - ANCHORS.length }, (_, index) => ({
      provider: `idp${index}`,
      anchor: `oidc:https://idp${index}.example.test`,
      emailAuthoritative: index % 2 === 0,
    })),
  ];

  it.each([
    ['one anchor', ANCHORS],
    ['the maximum configured anchors', maxAnchors],
  ])('binds at most 100 parameters per statement in every write with %s', async (_, anchors) => {
    let largest = 0;
    const counting: SqlExecutor = {
      driver: executor.driver,
      all: (s) => {
        largest = Math.max(largest, s.params.length);
        return executor.all(s);
      },
      batch: (statements) => {
        for (const s of statements) largest = Math.max(largest, s.params.length);
        return executor.batch(statements);
      },
    };
    const repo = createVisibilityAttachRepository(counting, { providerAnchors: anchors });
    expect((await repo.attachSource(a, admin(), { projectId: PA, sourceId: SO })).ok).toBe(true);
    expect(
      (await repo.setPrecedence(a, owner(), { projectId: PA, sourceId: SO, precedence: 3 })).ok,
    ).toBe(true);
    expect(
      (await repo.setPackageFlag(a, admin(), { packageId: K1, visibleToNewProjects: false })).ok,
    ).toBe(true);
    expect((await repo.detachSource(a, owner(), { projectId: PA, sourceId: SO })).ok).toBe(true);
    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThanOrEqual(100);
  });
});
