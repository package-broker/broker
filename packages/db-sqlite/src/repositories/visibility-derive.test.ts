import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orgContext, type OrgContext } from '@package-broker/core/db/port';
import { deriveVisibility } from '@package-broker/core/catalogue/visibility';
import { compile, db } from '../kysely.js';
import {
  randomCatalogueConfig,
  seedCatalogue,
  toVisibilityInputs,
  type CatalogueConfig,
} from '../testing/catalogue-fixture.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { admissionCondition, col } from './catalogue-predicates.js';
import { rederiveStatements, type DeriveScope } from './visibility-derive.js';
import { withForeignKeysOff } from '../testing/foreign-keys-off.js';

interface Row {
  readonly orgId: string;
  readonly projectId: string;
  readonly packageId: string;
  readonly origin: string;
}

const byKey = (a: Row, b: Row): number => {
  const x = `${a.projectId}\0${a.packageId}`;
  const y = `${b.projectId}\0${b.packageId}`;
  return x < y ? -1 : x > y ? 1 : 0;
};

async function rows(database: MigratedDatabase, where = '1 = 1'): Promise<Row[]> {
  const result = await database.executor.all<Row>({
    sql: `SELECT org_id AS orgId, project_id AS projectId, package_id AS packageId, origin
          FROM project_package WHERE ${where}`,
    params: [],
  });
  return result.sort(byKey);
}

async function rederive(
  database: MigratedDatabase,
  ctx: OrgContext,
  scope: DeriveScope,
): Promise<number> {
  const statements = rederiveStatements(ctx, scope);
  for (const s of statements) expect(s.params.length).toBeLessThanOrEqual(100);
  const results = await database.executor.batch(statements);
  return results.reduce((sum, r) => sum + r.changes, 0);
}

function scopesOf(config: CatalogueConfig, kind: DeriveScope['kind']): [OrgContext, DeriveScope][] {
  if (kind === 'project') {
    return config.projects.map((p) => [orgContext(p.orgId), { kind, projectId: p.id }]);
  }
  if (kind === 'package') {
    return config.packages.map((p) => [orgContext(p.orgId), { kind, packageId: p.id }]);
  }
  return config.projects.flatMap((p) =>
    config.sources
      .filter((s) => s.orgId === p.orgId)
      .map((s): [OrgContext, DeriveScope] => [
        orgContext(p.orgId),
        { kind, projectId: p.id, sourceId: s.id },
      ]),
  );
}

function expectedRows(config: CatalogueConfig): Row[] {
  const orgOf = new Map(config.packages.map((p) => [p.id, p.orgId]));
  return deriveVisibility(toVisibilityInputs(config))
    .filter((r) => r.origin !== 'explicit')
    .map((r) => ({
      orgId: orgOf.get(r.packageId) as string,
      projectId: r.projectId,
      packageId: r.packageId,
      origin: r.origin,
    }))
    .sort(byKey);
}

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedNoise(database: MigratedDatabase, config: CatalogueConfig, seed: number) {
  const next = mulberry(seed * 7919);
  const expected = expectedRows(config);
  const statements = [];
  for (const r of expected) {
    const roll = next();
    if (roll < 0.3) continue;
    const origin = roll < 0.55 ? (r.origin === 'pattern' ? 'subscription' : 'pattern') : r.origin;
    statements.push({
      sql: 'INSERT OR IGNORE INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, ?)',
      params: [r.orgId, r.projectId, r.packageId, origin],
    });
  }
  const derived = new Set(expected.map((r) => `${r.projectId}\0${r.packageId}`));
  for (const p of config.projects) {
    for (const k of config.packages) {
      if (k.orgId !== p.orgId || derived.has(`${p.id}\0${k.id}`) || next() > 0.2) continue;
      statements.push({
        sql: 'INSERT OR IGNORE INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, ?)',
        params: [p.orgId, p.id, k.id, next() < 0.5 ? 'pattern' : 'subscription'],
      });
    }
  }
  for (let at = 0; at < statements.length; at += 100) {
    await database.executor.batch(statements.slice(at, at + 100));
  }
}

describe('rederiveStatements against the oracle', () => {
  it.each(['project', 'projectSource', 'package'] as const)(
    '1-2: %s scopes over 200 random configurations equal deriveVisibility, the second pass changes nothing',
    async (kind) => {
      let touched = 0;
      for (let seed = 1; seed <= 200; seed += 1) {
        const database = await openMigratedDatabase();
        try {
          const config = randomCatalogueConfig(seed, 6, { forged: seed % 4 === 0 });
          await seedCatalogue(database.executor, config);
          await seedNoise(database, config, seed);
          const explicitBefore = await rows(database, "origin = 'explicit'");
          for (const [ctx, scope] of scopesOf(config, kind)) {
            touched += await rederive(database, ctx, scope);
          }
          const held = new Set(explicitBefore.map((r) => `${r.projectId}\0${r.packageId}`));
          expect(await rows(database, "origin <> 'explicit'")).toEqual(
            expectedRows(config).filter((r) => !held.has(`${r.projectId}\0${r.packageId}`)),
          );
          expect(await rows(database, "origin = 'explicit'")).toEqual(explicitBefore);
          let second = 0;
          for (const [ctx, scope] of scopesOf(config, kind)) {
            second += await rederive(database, ctx, scope);
          }
          expect(second).toBe(0);
        } finally {
          await database.close();
        }
      }
      expect(touched).toBeGreaterThan(0);
    },
    120_000,
  );

  it('a single scope touches only its own rows', async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const database = await openMigratedDatabase();
      try {
        const config = randomCatalogueConfig(seed, 6);
        await seedCatalogue(database.executor, config);
        await seedNoise(database, config, seed);
        const project = config.projects[seed % config.projects.length];
        if (!project) continue;
        const outside = `project_id <> '${project.id}'`;
        const before = await rows(database, outside);
        await rederive(database, orgContext(project.orgId), {
          kind: 'project',
          projectId: project.id,
        });
        expect(await rows(database, outside)).toEqual(before);
        expect(
          await rows(database, `project_id = '${project.id}' AND origin <> 'explicit'`),
        ).toEqual(expectedRows(config).filter((r) => r.projectId === project.id));
      } finally {
        await database.close();
      }
    }
  });
});

describe('rederiveStatements invariants', () => {
  let database: MigratedDatabase;
  let ctx: OrgContext;
  let other: OrgContext;

  async function exec(text: string, params: (string | number | null)[] = []): Promise<void> {
    await database.executor.batch([{ sql: text, params }]);
  }
  const execForged = (text: string, params: (string | number | null)[] = []) =>
    withForeignKeysOff(database.executor, () => exec(text, params));

  async function setup(orgId: string, suffix: string, status = 'active'): Promise<void> {
    await exec('INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)', [
      `P${suffix}`,
      orgId,
      `p${suffix.toLowerCase()}`,
      `P${suffix}`,
      status,
    ]);
    await exec(
      "INSERT INTO source (id, org_id, name, ecosystem, type, removal_policy) VALUES (?, ?, ?, 'composer', 'vcs', 'flag')",
      [`S${suffix}`, orgId, `S${suffix}`],
    );
    await exec(
      'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, 100)',
      [orgId, `P${suffix}`, `S${suffix}`],
    );
    for (const [n, flag] of [
      ['a', 1],
      ['b', 0],
    ] as const) {
      await exec(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects) VALUES (?, ?, ?, 'composer', ?, ?)",
        [`K${suffix}-${n}`, orgId, `S${suffix}`, `acme/${n}`, flag],
      );
    }
  }

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    if (database.orgs === null) throw new Error('orgs missing');
    ctx = orgContext(database.orgs.a.orgId);
    other = orgContext(database.orgs.b.orgId);
  });

  afterEach(async () => {
    await database.close();
  });

  it('3: explicit rows survive an exclude and a flag flip; another organization is untouched; archived projects keep derived rows', async () => {
    await setup(ctx.orgId, '1');
    await setup(ctx.orgId, '2', 'archived');
    await setup(other.orgId, '9');
    await exec(
      "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, 'P1', 'K1-b', 'explicit')",
      [ctx.orgId],
    );
    await exec(
      "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, 'P9', 'K9-b', 'subscription')",
      [other.orgId],
    );
    await rederive(database, ctx, { kind: 'project', projectId: 'P1' });
    await rederive(database, ctx, { kind: 'project', projectId: 'P2' });
    expect(await rows(database)).toEqual([
      { orgId: ctx.orgId, projectId: 'P1', packageId: 'K1-a', origin: 'subscription' },
      { orgId: ctx.orgId, projectId: 'P1', packageId: 'K1-b', origin: 'explicit' },
      { orgId: ctx.orgId, projectId: 'P2', packageId: 'K2-a', origin: 'subscription' },
      { orgId: other.orgId, projectId: 'P9', packageId: 'K9-b', origin: 'subscription' },
    ]);

    await exec(
      "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('X1', ?, 'P1', 'S1', 'acme/*', 'exclude')",
      [ctx.orgId],
    );
    await exec("UPDATE package SET visible_to_new_projects = 0 WHERE id = 'K1-a'");
    await rederive(database, ctx, { kind: 'projectSource', projectId: 'P1', sourceId: 'S1' });
    expect(await rows(database, "project_id = 'P1'")).toEqual([
      { orgId: ctx.orgId, projectId: 'P1', packageId: 'K1-b', origin: 'explicit' },
    ]);

    for (const scope of [
      { kind: 'project', projectId: 'P9' },
      { kind: 'package', packageId: 'K9-b' },
      { kind: 'projectSource', projectId: 'P9', sourceId: 'S9' },
    ] as const) {
      expect(await rederive(database, ctx, scope)).toBe(0);
    }
    expect(await rows(database, "project_id = 'P9'")).toEqual([
      { orgId: other.orgId, projectId: 'P9', packageId: 'K9-b', origin: 'subscription' },
    ]);
  });

  it('switches origin between subscription and pattern when the first include appears or goes', async () => {
    await setup(ctx.orgId, '1');
    await rederive(database, ctx, { kind: 'package', packageId: 'K1-a' });
    expect((await rows(database))[0]?.origin).toBe('subscription');
    await exec(
      "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('I1', ?, 'P1', 'S1', 'acme/*', 'include')",
      [ctx.orgId],
    );
    expect(await rederive(database, ctx, { kind: 'package', packageId: 'K1-a' })).toBe(1);
    expect((await rows(database))[0]?.origin).toBe('pattern');
    await exec("DELETE FROM project_package_pattern WHERE id = 'I1'");
    expect(await rederive(database, ctx, { kind: 'project', projectId: 'P1' })).toBe(1);
    expect((await rows(database))[0]?.origin).toBe('subscription');
  });

  it('refuses rows when a stored pattern is invalid or a rule has more than 64 patterns', async () => {
    await setup(ctx.orgId, '1');
    await exec(
      "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('BAD', ?, 'P1', 'S1', 'acme/[a]', 'exclude')",
      [ctx.orgId],
    );
    await rederive(database, ctx, { kind: 'project', projectId: 'P1' });
    expect(await rows(database)).toEqual([]);
    await exec("DELETE FROM project_package_pattern WHERE id = 'BAD'");
    for (let n = 0; n < 65; n += 1) {
      await exec(
        "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, 'P1', 'S1', ?, 'exclude')",
        [`X${n}`, ctx.orgId, `zzz/${n}`],
      );
    }
    await rederive(database, ctx, { kind: 'project', projectId: 'P1' });
    expect(await rows(database)).toEqual([]);
  });

  it('a project-level source of another project yields no rows even when attached', async () => {
    await setup(ctx.orgId, '1');
    await setup(ctx.orgId, '2');
    await exec("UPDATE source SET project_id = 'P2' WHERE id = 'S2'");
    await exec(
      "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'P1', 'S2', 0)",
      [ctx.orgId],
    );
    await rederive(database, ctx, { kind: 'project', projectId: 'P1' });
    expect((await rows(database)).map((r) => r.packageId)).toEqual(['K1-a']);
  });

  it('admission alias collision: P1 with only a non-matching exclude admits K-1 under outer aliases guard_i and guard_x', async () => {
    await exec("INSERT INTO project (id, org_id, slug, name) VALUES ('P1', ?, 'p1', 'P1')", [
      ctx.orgId,
    ]);
    await exec("INSERT INTO project (id, org_id, slug, name) VALUES ('P2', ?, 'p2', 'P2')", [
      ctx.orgId,
    ]);
    await exec(
      "INSERT INTO source (id, org_id, name, ecosystem, type, removal_policy) VALUES ('S1', ?, 'S1', 'composer', 'vcs', 'flag')",
      [ctx.orgId],
    );
    await exec(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('K-1', ?, 'S1', 'composer', 'acme/a')",
      [ctx.orgId],
    );
    for (const p of ['P1', 'P2']) {
      await exec(
        "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, 'S1', 100)",
        [ctx.orgId, p],
      );
    }
    await exec(
      "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('X', ?, 'P1', 'S1', 'zzz/*', 'exclude'), ('I', ?, 'P2', 'S1', 'beta/*', 'include')",
      [ctx.orgId, ctx.orgId],
    );
    const admitted = db
      .selectFrom('package as guard_x')
      .innerJoin('project_package_pattern as guard_i', 'guard_i.source_id', 'guard_x.source_id')
      .select('guard_x.id')
      .where('guard_i.project_id', '=', 'P1')
      .where(
        admissionCondition(
          ctx,
          col('guard_i.project_id'),
          col('guard_x.source_id'),
          col('guard_x.name'),
          col('guard_x.visible_to_new_projects'),
        ),
      );
    const ids = await database.executor.all<{ id: string }>(compile(admitted));
    expect(ids.map((r) => r.id)).toEqual(['K-1']);
    await rederive(database, ctx, { kind: 'package', packageId: 'K-1' });
    expect(await rows(database)).toEqual([
      { orgId: ctx.orgId, projectId: 'P1', packageId: 'K-1', origin: 'subscription' },
    ]);
  });

  it('a mismatched-org include pattern does not turn a subscription into a pattern origin', async () => {
    if (database.orgs === null) throw new Error('organizations were not seeded');
    await exec("INSERT INTO project (id, org_id, slug, name) VALUES ('P1', ?, 'p1', 'P1')", [
      ctx.orgId,
    ]);
    await exec(
      "INSERT INTO source (id, org_id, name, ecosystem, type, removal_policy) VALUES ('S1', ?, 'S1', 'composer', 'vcs', 'flag')",
      [ctx.orgId],
    );
    await exec(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('K-1', ?, 'S1', 'composer', 'acme/a')",
      [ctx.orgId],
    );
    await exec(
      "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'P1', 'S1', 100)",
      [ctx.orgId],
    );
    const foreignOrgId = database.orgs.b.orgId;
    await execForged(
      "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('M', ?, 'P1', 'S1', 'acme/*', 'include')",
      [foreignOrgId],
    );
    await rederive(database, ctx, { kind: 'package', packageId: 'K-1' });
    expect(await rows(database)).toEqual([
      { orgId: ctx.orgId, projectId: 'P1', packageId: 'K-1', origin: 'subscription' },
    ]);
  });

  it('compiles to statements within the D1 parameter budget and without unbounded patterns', () => {
    for (const scope of [
      { kind: 'project', projectId: 'P1' },
      { kind: 'package', packageId: 'K1' },
      { kind: 'projectSource', projectId: 'P1', sourceId: 'S1' },
    ] as const) {
      const statements = rederiveStatements(ctx, scope);
      expect(statements).toHaveLength(3);
      expect(statements[0]?.sql).toMatch(/^delete from "project_package"/);
      expect(statements[1]?.sql).toMatch(/^update "project_package"/);
      expect(statements[2]?.sql).toMatch(/^insert or ignore into "project_package"/);
      for (const s of statements) {
        expect(s.params.length).toBeLessThanOrEqual(100);
        expect(s.sql).not.toMatch(/\blike\b/i);
      }
    }
  });
});
