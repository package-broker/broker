import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orgContext, type OrgContext, type ScalarStatement } from '@package-broker/core/db/port';
import type { VersionStatus } from '@package-broker/core/catalogue/version-rules';
import {
  discoveredMigrations,
  openMigratedDatabase,
  type MigratedDatabase,
} from '../testing/migrated-database.js';
import {
  randomCatalogueConfig,
  seedCatalogue,
  seedDerivedRows,
} from '../testing/catalogue-fixture.js';
import { createCatalogueList } from './catalogue-list.js';
import { createPackageAdminReader } from './package-admin-read.js';

const id = (n: number) => String(n).padStart(26, '0');
const time = '2026-01-01T00:00:00Z';
let database: MigratedDatabase;
let ctx: OrgContext;
let reader: ReturnType<typeof createPackageAdminReader>;
async function run(sql: string, ...params: (string | number | null)[]) {
  await database.executor.batch([{ sql, params }]);
}
async function source(n: number, project: string | null = null, org = 'O') {
  await run(
    "INSERT INTO source (id, org_id, project_id, name, ecosystem, type) VALUES (?, ?, ?, ?, 'npm', 'npm_registry')",
    id(n),
    org,
    project,
    `source-${n}`,
  );
}
async function pkg(n: number, name: string, src = 1, org = 'O') {
  await run(
    "INSERT INTO package (id, org_id, source_id, ecosystem, name, last_synced_at) VALUES (?, ?, ?, 'npm', ?, ?)",
    id(n),
    org,
    id(src),
    name,
    time,
  );
}
async function version(
  n: number,
  parent: number,
  status: VersionStatus = 'active',
  published = time,
  org = 'O',
) {
  await run(
    "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, status, removed_upstream_at, tombstoned_at) VALUES (?, ?, ?, ?, ?, ?, 'import_time', '{}', ?, ?, ?)",
    id(n),
    org,
    id(parent),
    `${n}.0.0`,
    `${n}.0.0`,
    published,
    status,
    status === 'removed_upstream' ? time : null,
    status === 'tombstoned' ? time : null,
  );
}
async function attach(src: number, project = 'P', precedence = 0) {
  await run(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
    'O',
    project,
    id(src),
    precedence,
  );
}
async function member(n: number, project = 'P') {
  await run(
    "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT 'O' AS org_id, ? AS project_id, ? AS package_id, 'explicit' AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1",
    project,
    id(n),
  );
}
async function ownLoser() {
  await source(2, 'P');
  await source(3, 'P');
  await attach(2, 'P', 2);
  await attach(3, 'P', 1);
  await pkg(20, 'shared', 2);
  await pkg(30, 'shared', 3);
  await member(20);
  await member(30);
  await version(200, 20);
}
beforeEach(async () => {
  database = await openMigratedDatabase();
  ctx = orgContext('O');
  reader = createPackageAdminReader(database.executor);
  await run('DROP INDEX organization_singleton');
  await run(
    "INSERT INTO organization (id, slug, name) VALUES ('O', 'own', 'Own'), ('F', 'foreign', 'Foreign')",
  );
  await run(
    "INSERT INTO project (id, org_id, slug, name) VALUES ('P', 'O', 'p', 'P'), ('Q', 'O', 'q', 'Q')",
  );
  await source(1);
});
afterEach(() => database.close());

describe('package admin reader', () => {
  it('uses the latest version-targeted publish audit without matching version text', async () => {
    await pkg(10, 'widget');
    await version(100, 10);
    await run(
      "INSERT INTO user_account (id,org_id,email,display_name) VALUES ('old','O','old@example.test','Old publisher'),('new','O','new@example.test','New publisher')",
    );
    for (const [auditId, actor, targetType, targetId] of [
      [id(1), 'old', 'version', id(100)],
      [id(2), 'new', 'version', id(100)],
      [id(3), 'old', 'package', id(100)],
      [id(4), 'old', 'version', id(101)],
      [id(5), 'old', 'package', id(10)],
    ]) {
      await run(
        "INSERT INTO audit_pending (id,org_id,created_at,actor_type,actor_id,action,target_type,target_id,payload_json) VALUES (?,'O',?,'user',?,'package.publish',?,?,?)",
        auditId!,
        time,
        actor!,
        targetType!,
        targetId!,
        JSON.stringify({ changes: { version: { new: 'unrelated-version-text' } } }),
      );
    }
    const result = await reader.listVersions(ctx, {
      packageId: id(10),
      projectId: null,
      limit: 10,
    });
    expect(result!.items[0]!.publishedBy).toEqual({ kind: 'user', displayName: 'New publisher' });
  });

  it('matches catalogue winners over a fixed seeded catalogue', async () => {
    const config = randomCatalogueConfig(685, 8);
    await seedCatalogue(database.executor, config);
    await seedDerivedRows(database.executor, config);
    for (const project of config.projects) {
      const context = orgContext(project.orgId);
      const actual = await reader.listProject(context, project.id, { limit: 100 });
      const expected = [];
      for (const ecosystem of ['composer', 'npm'] as const) {
        const page = await createCatalogueList(database.executor).listVisible(context, {
          projectId: project.id,
          ecosystem,
          limit: 200,
        });
        expected.push(...page.items.map((item) => item.packageId));
      }
      expect(actual.items.map((item) => item.id)).toEqual(expected);
    }
  });
  it('excludes a package whose source is unattached', async () => {
    await pkg(10, 'unattached');
    await member(10);
    expect((await reader.listProject(ctx, 'P', { limit: 10 })).items).toEqual([]);
  });
  it('excludes a package denied by an admission pattern', async () => {
    await attach(1);
    await pkg(10, 'excluded');
    await run(
      "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('PAT', 'O', 'P', ?, 'excluded', 'exclude')",
      id(1),
    );
    await seedDerivedRows(database.executor, {
      organizations: [],
      projects: [{ id: 'P', orgId: 'O', slug: 'p', name: 'P', status: 'active' }],
      sources: [
        {
          id: id(1),
          orgId: 'O',
          projectId: null,
          name: 's',
          ecosystem: 'npm',
          type: 'npm_registry',
          defaultVisible: 1,
          removalPolicy: 'flag',
        },
      ],
      attachments: [{ orgId: 'O', projectId: 'P', sourceId: id(1), precedence: 0 }],
      patterns: [
        {
          id: 'PAT',
          orgId: 'O',
          projectId: 'P',
          sourceId: id(1),
          pattern: 'excluded',
          effect: 'exclude',
        },
      ],
      packages: [
        {
          id: id(10),
          orgId: 'O',
          sourceId: id(1),
          ecosystem: 'npm',
          key: 'excluded',
          visible: 1,
          status: 'active',
        },
      ],
      versions: [],
      explicit: [],
      registeredNames: [],
    });
    expect((await reader.listProject(ctx, 'P', { limit: 10 })).items).toEqual([]);
  });
  it('excludes a proxy package by a read-time pattern even with direct membership', async () => {
    await attach(1);
    await run("UPDATE source SET type = 'npmjs_proxy' WHERE id = ?", id(1));
    await pkg(10, 'excluded');
    await member(10);
    expect(
      (await reader.listProject(ctx, 'P', { limit: 10 })).items.map((item) => item.id),
    ).toEqual([id(10)]);
    await run(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('PAT', 'O', ?, 'npm', 'excluded')",
      id(1),
    );
    expect((await reader.listProject(ctx, 'P', { limit: 10 })).items).toEqual([]);
    const membership = await database.executor.all<{ package_id: string }>({
      sql: "SELECT package_id FROM project_package WHERE org_id = 'O' AND project_id = 'P'",
      params: [],
    });
    expect(membership).toEqual([{ package_id: id(10) }]);
  });
  it('excludes the lower precedence package from the project list', async () => {
    await ownLoser();
    expect(
      (await reader.listProject(ctx, 'P', { limit: 10 })).items.map((item) => item.id),
    ).toEqual([id(30)]);
  });
  it('includes project-level sources and filters by attachment', async () => {
    await source(2, 'P');
    await pkg(20, 'owned', 2);
    await pkg(10, 'org');
    await attach(2);
    expect((await reader.listOrganization(ctx, { limit: 10 })).items).toHaveLength(2);
    expect(
      (await reader.listOrganization(ctx, { limit: 10, projectId: 'P' })).items.map(
        (item) => item.id,
      ),
    ).toEqual([id(20)]);
  });
  it('never lists another organization package', async () => {
    await source(2, null, 'F');
    await pkg(20, 'foreign', 2, 'F');
    expect((await reader.listOrganization(ctx, { limit: 10 })).items).toEqual([]);
  });
  it('derives columns and filters each status using the status index', async () => {
    const statuses = ['active', 'quarantined', 'tombstoned', 'removed_upstream'] as const;
    for (const [i, status] of statuses.entries()) {
      await pkg(10 + i, status);
      await version(100 + i, 10 + i, status);
    }
    await run("UPDATE package SET status = 'removed_upstream' WHERE id = ?", id(13));
    await version(110, 11, 'tombstoned');
    await version(111, 13, 'quarantined');
    await pkg(14, 'empty');
    await version(112, 10, 'removed_upstream');
    await version(113, 10, 'quarantined', '2027-01-01');
    for (const status of statuses) {
      const page = await reader.listOrganization(ctx, { limit: 10, status });
      const expected =
        status === 'active'
          ? [id(14)]
          : status === 'quarantined'
            ? [id(10), id(11)]
            : [id(status === 'tombstoned' ? 12 : 13)];
      expect(page.items.map((item) => item.id)).toEqual(expected);
    }
    const all = (await reader.listOrganization(ctx, { limit: 10 })).items;
    expect(all.find((item) => item.id === id(10))).toMatchObject({
      latestVersion: '112.0.0',
      versionCount: 3,
      lastSyncedAt: time,
      source: { id: id(1), name: 'source-1', type: 'npm_registry', projectId: null },
    });
    expect(all.find((item) => item.id === id(12))?.latestVersion).toBeNull();
  });
  it('keeps mixed active and tombstoned versions active', async () => {
    await pkg(10, 'mixed');
    await version(100, 10);
    await version(101, 10, 'tombstoned');
    const page = await reader.listOrganization(ctx, { limit: 10, status: 'active' });
    expect(page.items.map((item) => [item.id, item.status])).toEqual([[id(10), 'active']]);
    expect((await reader.listOrganization(ctx, { limit: 10, status: 'tombstoned' })).items).toEqual(
      [],
    );
  });
  it('keeps an all-active package active', async () => {
    await pkg(10, 'all-active');
    await version(100, 10);
    await version(101, 10);
    expect((await reader.listOrganization(ctx, { limit: 10 })).items[0]).toMatchObject({
      id: id(10),
      status: 'active',
      versionCount: 2,
    });
  });
  for (const project of [false, true])
    it(`ends ${project ? 'project' : 'organization'} prefix paging at the last match`, async () => {
      await attach(1);
      for (const [i, name] of [
        'match-a',
        'match-b',
        ...Array.from({ length: 501 }, (_, i) => `z${i}`),
      ].entries()) {
        await pkg(1000 + i, name);
        await member(1000 + i);
      }
      const list = (after?: string) =>
        project
          ? reader.listProject(ctx, 'P', {
              q: 'match-',
              limit: 1,
              ...(after === undefined ? {} : { after }),
            })
          : reader.listOrganization(ctx, {
              q: 'match-',
              limit: 1,
              ...(after === undefined ? {} : { after }),
            });
      const first = await list();
      expect(first.items.map((item) => item.name)).toEqual(['match-a']);
      expect(first.next).not.toBeNull();
      const last = await list(first.next!);
      expect(last.items.map((item) => item.name)).toEqual(['match-b']);
      expect(last.next).toBeNull();
    });
  it('ranges each ecosystem by prefix and never reads names below q', async () => {
    const statements: ScalarStatement[] = [];
    const checked = createPackageAdminReader({
      driver: database.executor.driver,
      batch: (statements) => database.executor.batch(statements),
      all: async (statement) => {
        statements.push(statement);
        return [];
      },
    });
    await checked.listOrganization(ctx, { q: 'm', limit: 100 });
    const statement = statements[0]!;
    const plan = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
      params: statement.params,
    });
    expect(
      plan.filter((row) =>
        /package_by_name \(org_id=\? AND ecosystem=\? AND name>\? AND name<\?\)/.test(row.detail),
      ),
    ).toHaveLength(2);
    const raw = new DatabaseSync(':memory:');
    try {
      raw.exec(`
        CREATE TABLE package (id TEXT PRIMARY KEY, org_id TEXT, ecosystem TEXT, name TEXT, status TEXT, last_synced_at TEXT, source_id TEXT, held_until_active INTEGER DEFAULT 0, visible_to_new_projects INTEGER DEFAULT 1, new_project_access_mode TEXT DEFAULT 'none', rev INTEGER DEFAULT 1);
        CREATE INDEX package_by_name ON package (org_id, ecosystem, name);
        CREATE TABLE source (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, type TEXT, project_id TEXT);
        CREATE TABLE publish_approval (org_id TEXT, version_id TEXT, approval_state TEXT, scan_state TEXT);
        CREATE TABLE version (id TEXT, org_id TEXT, package_id TEXT, status TEXT, version TEXT, published_at TEXT);
        CREATE INDEX version_package_status ON version (package_id, status);
        INSERT INTO source VALUES ('S', 'O', 'source', 'npm_registry', NULL);
      `);
      const insert = raw.prepare(
        "INSERT INTO package (id, org_id, ecosystem, name, status, last_synced_at, source_id, held_until_active) VALUES (?, 'O', ?, ?, 'active', NULL, 'S', 0)",
      );
      for (const eco of ['composer', 'npm']) {
        for (let i = 0; i < 600; i++)
          insert.run(`${eco}-a-${i}`, eco, `a${String(i).padStart(4, '0')}`);
        for (let i = 0; i < 300; i++)
          insert.run(`${eco}-m-${i}`, eco, `m${String(i).padStart(4, '0')}`);
        insert.run(`${eco}-z`, eco, 'z');
      }
      const read: string[] = [];
      raw.function('count_candidate', (name) => {
        read.push(String(name));
        expect(String(name).startsWith('m')).toBe(true);
        return 1;
      });
      const countedSql = statement.sql.replaceAll(
        'where pkg.org_id',
        'where count_candidate(pkg.name) and pkg.org_id',
      );
      const rows = raw.prepare(countedSql).all(...statement.params);
      expect(rows).toHaveLength(500);
      expect(read.length).toBeGreaterThanOrEqual(500);
      expect(rows.every((row) => row.scanned === 500)).toBe(true);
      expect(rows.filter((row) => row.ecosystem === 'composer')).toHaveLength(300);
      expect(rows.filter((row) => row.ecosystem === 'npm')).toHaveLength(200);
    } finally {
      raw.close();
    }
  });
  for (const ecosystem of [undefined, 'npm'] as const)
    it(`seeks a prefix continuation within the candidate budget (${ecosystem ?? 'all ecosystems'})`, async () => {
      const statements: ScalarStatement[] = [];
      const checked = createPackageAdminReader({
        driver: database.executor.driver,
        batch: (statements) => database.executor.batch(statements),
        all: async (statement) => {
          statements.push(statement);
          return [];
        },
      });
      await checked.listOrganization(ctx, {
        q: 'm',
        after: `npm:m0499:${id(1499)}`,
        limit: 100,
        ...(ecosystem === undefined ? {} : { ecosystem }),
      });
      const statement = statements[0]!;
      const raw = new DatabaseSync(':memory:');
      try {
        raw.exec(`
          CREATE TABLE package (id TEXT PRIMARY KEY, org_id TEXT, ecosystem TEXT, name TEXT, status TEXT, last_synced_at TEXT, source_id TEXT, held_until_active INTEGER DEFAULT 0, visible_to_new_projects INTEGER DEFAULT 1, new_project_access_mode TEXT DEFAULT 'none', rev INTEGER DEFAULT 1);
          CREATE INDEX package_by_name ON package (org_id, ecosystem, name);
          CREATE TABLE source (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, type TEXT, project_id TEXT);
          CREATE TABLE publish_approval (org_id TEXT, version_id TEXT, approval_state TEXT, scan_state TEXT);
        CREATE TABLE version (id TEXT, org_id TEXT, package_id TEXT, status TEXT, version TEXT, published_at TEXT);
          CREATE INDEX version_package_status ON version (package_id, status);
          INSERT INTO source VALUES ('S', 'O', 'source', 'npm_registry', NULL);
        `);
        const insert = raw.prepare(
          "INSERT INTO package (id, org_id, ecosystem, name, status, last_synced_at, source_id, held_until_active) VALUES (?, 'O', ?, ?, 'active', NULL, 'S', 0)",
        );
        for (const eco of ['composer', 'npm'])
          for (let i = 0; i < 1000; i++)
            insert.run(id((eco === 'npm' ? 1000 : 0) + i), eco, `m${String(i).padStart(4, '0')}`);
        const read: { ecosystem: string; name: string }[] = [];
        raw.function('count_candidate', (eco, name) => {
          read.push({ ecosystem: String(eco), name: String(name) });
          return 1;
        });
        const countedSql = statement.sql.replaceAll(
          'where pkg.org_id',
          'where count_candidate(pkg.ecosystem, pkg.name) and pkg.org_id',
        );
        const rows = raw.prepare(countedSql).all(...statement.params);
        expect(rows).toHaveLength(500);
        expect(rows.every((row) => row.scanned === 500)).toBe(true);
        expect(rows.map((row) => row.name)).toEqual(
          Array.from({ length: 500 }, (_, i) => `m${String(500 + i).padStart(4, '0')}`),
        );
        expect(read.length).toBeGreaterThanOrEqual(500);
        expect(read.length).toBeLessThanOrEqual(501);
        expect(read.every((row) => row.ecosystem === 'npm' && row.name >= 'm0499')).toBe(true);
      } finally {
        raw.close();
      }
    });
  for (const project of [false, true])
    for (const ecosystem of [undefined, 'npm'] as const)
      for (const q of [undefined, 'm'])
        it(`seeks every ${project ? 'project' : 'organization'} continuation within the candidate budget (${ecosystem ?? 'all ecosystems'}, ${q === undefined ? 'no prefix' : 'prefix'})`, async () => {
          const statements: ScalarStatement[] = [];
          const checked = createPackageAdminReader({
            driver: database.executor.driver,
            batch: (statements) => database.executor.batch(statements),
            all: async (statement) => {
              statements.push(statement);
              return [];
            },
          });
          const query = {
            after: `npm:m1499${project ? '' : `:${id(3499)}`}`,
            limit: 100,
            ...(ecosystem === undefined ? {} : { ecosystem }),
            ...(q === undefined ? {} : { q }),
          };
          if (project) await checked.listProject(ctx, 'P', query);
          else await checked.listOrganization(ctx, query);
          const statement = statements[0]!;
          const raw = new DatabaseSync(':memory:');
          try {
            for (const migration of await discoveredMigrations()) raw.exec(migration.sql);
            raw.exec(`
              INSERT INTO organization (id, slug, name) VALUES ('O', 'own', 'Own');
              INSERT INTO project (id, org_id, slug, name) VALUES ('P', 'O', 'p', 'P');
            `);
            const insertSource = raw.prepare(
              "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, 'O', ?, ?, ?)",
            );
            const insertAttachment = raw.prepare(
              "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES ('O', 'P', ?, 0)",
            );
            const insertPackage = raw.prepare(
              "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, 'O', ?, ?, ?)",
            );
            const insertMembership = raw.prepare(
              "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT 'O' AS org_id, 'P' AS project_id, ? AS package_id, 'explicit' AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1",
            );
            for (const eco of ['composer', 'npm']) {
              insertSource.run(eco, eco, eco, eco === 'npm' ? 'npm_registry' : 'hosted');
              insertAttachment.run(eco);
              for (let i = 0; i < 2000; i++) {
                const packageId = id((eco === 'npm' ? 2000 : 0) + i);
                insertPackage.run(packageId, eco, eco, `m${String(i).padStart(4, '0')}`);
                insertMembership.run(packageId);
              }
            }
            const read: { ecosystem: string; name: string }[] = [];
            raw.function('count_candidate', (eco, name) => {
              read.push({ ecosystem: String(eco), name: String(name) });
              return 1;
            });
            const countedSql = statement.sql.replaceAll(
              'where pkg.org_id',
              'where count_candidate(pkg.ecosystem, pkg.name) and pkg.org_id',
            );
            const rows = raw.prepare(countedSql).all(...statement.params);
            expect(rows).toHaveLength(500);
            expect(rows.every((row) => row.scanned === 500 && row.qualifies === 1)).toBe(true);
            expect(rows.map((row) => row.id)).toEqual(
              Array.from({ length: 500 }, (_, i) => id(3500 + i)),
            );
            expect(read.length).toBeGreaterThanOrEqual(500);
            expect(read.length).toBeLessThanOrEqual(501);
            expect(read.every((row) => row.ecosystem === 'npm' && row.name >= 'm1499')).toBe(true);
          } finally {
            raw.close();
          }
        });
  for (const char of ['%', '_', '\\'])
    it(`matches ${char} literally without widening the prefix`, async () => {
      await pkg(10, `a${char}b`);
      await pkg(11, 'axb');
      expect(
        (await reader.listOrganization(ctx, { limit: 10, q: `a${char}` })).items.map(
          (item) => item.id,
        ),
      ).toEqual([id(10)]);
    });
  it('accepts a 100-character prefix', async () => {
    await pkg(10, 'a'.repeat(100));
    expect(
      (await reader.listOrganization(ctx, { limit: 10, q: 'a'.repeat(100) })).items,
    ).toHaveLength(1);
  });
  for (const project of [false, true])
    it(`pages ${project ? 'project' : 'organization'} names containing colons without repeats`, async () => {
      await attach(1);
      for (const [i, name] of ['a:b', 'a:c', 'z'].entries()) {
        await pkg(10 + i, name);
        await member(10 + i);
      }
      if (!project) {
        await source(2);
        await pkg(20, 'a:b', 2);
      }
      const seen: string[] = [];
      let after: string | undefined;
      do {
        const page = project
          ? await reader.listProject(ctx, 'P', {
              limit: 1,
              ...(after === undefined ? {} : { after }),
            })
          : await reader.listOrganization(ctx, {
              limit: 1,
              ...(after === undefined ? {} : { after }),
            });
        seen.push(...page.items.map((item) => item.id));
        after = page.next ?? undefined;
      } while (after !== undefined);
      expect(seen).toEqual(project ? [id(10), id(11), id(12)] : [id(10), id(20), id(11), id(12)]);
    });
  it('returns a short page and the last examined cursor at the 500 candidate budget', async () => {
    for (let i = 0; i < 505; i++) await pkg(1000 + i, `p${String(i).padStart(4, '0')}`);
    await version(3000, 1504, 'quarantined');
    const first = await reader.listOrganization(ctx, { limit: 10, status: 'quarantined' });
    expect(first).toEqual({ items: [], next: `npm:p0499:${id(1499)}` });
    const second = await reader.listOrganization(ctx, {
      limit: 10,
      status: 'quarantined',
      after: first.next!,
    });
    expect(second.items.map((item) => item.id)).toEqual([id(1504)]);
    expect(second.next).toBeNull();
  });
  it('bounds organization candidates before filtering project attachments', async () => {
    for (let i = 0; i < 500; i++) await pkg(1000 + i, `a${String(i).padStart(4, '0')}`);
    await source(2);
    await attach(2);
    await pkg(2000, 'z', 2);
    expect(await reader.listOrganization(ctx, { projectId: 'P', limit: 10 })).toEqual({
      items: [],
      next: `npm:a0499:${id(1499)}`,
    });
  });
  it('bounds project candidates before visibility checks', async () => {
    for (let i = 0; i < 505; i++) await pkg(1000 + i, `p${String(i).padStart(4, '0')}`);
    await attach(1);
    await member(1504);
    const first = await reader.listProject(ctx, 'P', { limit: 10 });
    expect(first).toEqual({ items: [], next: 'npm:p0499' });
    const second = await reader.listProject(ctx, 'P', { limit: 10, after: first.next! });
    expect(second.items.map((item) => item.id)).toEqual([id(1504)]);
    expect(second.next).toBeNull();
  });
  it('resolves a boundary name even when its winner falls outside the candidate scan', async () => {
    for (let i = 0; i < 499; i++) await pkg(1000 + i, `a${String(i).padStart(4, '0')}`);
    await source(2);
    await source(3);
    await attach(2, 'P', 2);
    await attach(3, 'P', 1);
    await pkg(2000, 'z', 2);
    await pkg(2001, 'z', 3);
    await member(2000);
    await member(2001);
    const first = await reader.listProject(ctx, 'P', { limit: 10 });
    expect(first.items.map((item) => item.id)).toEqual([id(2001)]);
    expect(first.next).toBe('npm:z');
    expect(await reader.listProject(ctx, 'P', { limit: 10, after: first.next! })).toEqual({
      items: [],
      next: null,
    });
  });
  it('lists own losing package versions', async () => {
    await ownLoser();
    expect(
      (await reader.listVersions(ctx, { packageId: id(20), projectId: 'P', limit: 10 }))?.items.map(
        (item) => item.id,
      ),
    ).toEqual([id(200)]);
  });
  it('answers null for another project losing package, identical to absent', async () => {
    await source(2, 'Q');
    await pkg(20, 'shared', 2);
    await version(200, 20);
    const query = { projectId: 'P', limit: 10 };
    expect(await reader.listVersions(ctx, { ...query, packageId: id(20) })).toBeNull();
    expect(await reader.listVersions(ctx, { ...query, packageId: id(999) })).toBeNull();
  });
  it('reads an organization source winner and every version status in id order', async () => {
    await attach(1);
    await pkg(10, 'winner');
    await member(10);
    for (const [i, status] of (
      ['active', 'quarantined', 'tombstoned', 'removed_upstream', 'yanked'] as const
    ).entries())
      await version(100 + i, 10, status);
    const first = await reader.listVersions(ctx, { packageId: id(10), projectId: 'P', limit: 2 });
    expect(first?.items.map((item) => item.status)).toEqual(['active', 'quarantined']);
    expect(first?.next).toBe(id(101));
    const rest = await reader.listVersions(ctx, {
      packageId: id(10),
      projectId: 'P',
      limit: 10,
      after: first!.next!,
    });
    expect(rest?.items.map((item) => item.status)).toEqual([
      'tombstoned',
      'removed_upstream',
      'yanked',
    ]);
  });
  it('answers null for versions of a foreign package', async () => {
    await source(2, null, 'F');
    await pkg(20, 'foreign', 2, 'F');
    await version(200, 20, 'active', time, 'F');
    expect(
      await reader.listVersions(ctx, { packageId: id(20), projectId: null, limit: 10 }),
    ).toBeNull();
  });
  it('does not manage an organization-level source as a project', async () => {
    await pkg(10, 'org');
    await version(100, 10);
    expect(
      await reader.findManagedVersion(ctx, {
        packageId: id(10),
        versionId: id(100),
        projectId: 'P',
      }),
    ).toBeNull();
  });
  it('does not manage another project source', async () => {
    await source(2, 'Q');
    await pkg(20, 'other', 2);
    await version(200, 20);
    expect(
      await reader.findManagedVersion(ctx, {
        packageId: id(20),
        versionId: id(200),
        projectId: 'P',
      }),
    ).toBeNull();
  });
  it('manages an own-source losing package', async () => {
    await ownLoser();
    expect(
      await reader.findManagedVersion(ctx, {
        packageId: id(20),
        versionId: id(200),
        projectId: 'P',
      }),
    ).toEqual({
      packageId: id(20),
      versionId: id(200),
      ecosystem: 'npm',
      packageName: 'shared',
      version: '200.0.0',
      status: 'active',
      sourceId: id(2),
      sourceProjectId: 'P',
    });
  });
  it('rejects a version belonging to another package', async () => {
    await pkg(10, 'one');
    await pkg(11, 'two');
    await version(100, 11);
    expect(
      await reader.findManagedVersion(ctx, {
        packageId: id(10),
        versionId: id(100),
        projectId: null,
      }),
    ).toBeNull();
  });
  it('rejects a managed version in another organization', async () => {
    await source(2, null, 'F');
    await pkg(20, 'foreign', 2, 'F');
    await version(200, 20, 'active', time, 'F');
    expect(
      await reader.findManagedVersion(ctx, {
        packageId: id(20),
        versionId: id(200),
        projectId: null,
      }),
    ).toBeNull();
  });
  it('returns only the specified public keys', async () => {
    await pkg(10, 'safe');
    await version(100, 10);
    const item = (await reader.listOrganization(ctx, { limit: 10 })).items[0]!;
    expect(Object.keys(item).sort()).toEqual([
      'ecosystem',
      'id',
      'lastSyncedAt',
      'latestVersion',
      'name',
      'newProjectAccessMode',
      'revision',
      'source',
      'status',
      'versionCount',
      'visibleToNewProjects',
    ]);
    expect(Object.keys(item.source).sort()).toEqual(['id', 'name', 'projectId', 'type']);
    const versions = await reader.listVersions(ctx, {
      packageId: id(10),
      projectId: null,
      limit: 10,
    });
    expect(Object.keys(versions!.items[0]!).sort()).toEqual([
      'approvedBy',
      'distTags',
      'id',
      'integrity',
      'publishedAt',
      'publishedBy',
      'removedUpstreamAt',
      'revision',
      'stability',
      'status',
      'tombstonedAt',
      'version',
    ]);
  });
  for (const after of ['', 'maven:abc', 'npm:', 'npm:abc:bad'])
    it(`rejects malformed organization cursor ${after}`, async () => {
      await expect(reader.listOrganization(ctx, { limit: 10, after })).rejects.toThrow(TypeError);
    });
  for (const after of ['npm:', 'npmx'])
    it(`rejects malformed project cursor ${after}`, async () => {
      await expect(reader.listProject(ctx, 'P', { limit: 10, after })).rejects.toThrow(TypeError);
    });
  it('uses the T684 status index and binds at most 100 parameters per read', async () => {
    await attach(1);
    await pkg(10, 'safe');
    await member(10);
    await version(100, 10);
    const statements: ScalarStatement[] = [];
    const checked = createPackageAdminReader({
      driver: database.executor.driver,
      batch: (statements) => database.executor.batch(statements),
      all: (statement) => {
        statements.push(statement);
        return database.executor.all(statement);
      },
    });
    const query = {
      limit: 10,
      ecosystem: 'npm',
      status: 'active',
      sourceId: id(1),
      q: 's',
    } as const;
    await checked.listProject(ctx, 'P', { ...query, after: 'npm:r' });
    await checked.listOrganization(ctx, { ...query, projectId: 'P', after: `npm:r:${id(1)}` });
    await checked.listVersions(ctx, {
      packageId: id(10),
      projectId: 'P',
      after: id(99),
      limit: 10,
    });
    await checked.findManagedVersion(ctx, {
      packageId: id(10),
      versionId: id(100),
      projectId: 'P',
    });
    expect(statements).toHaveLength(4);
    const versionsPlan = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${statements[2]!.sql}`,
      params: statements[2]!.params,
    });
    expect(versionsPlan.some((row) => row.detail.includes('audit_event_target'))).toBe(true);
    expect(versionsPlan.filter((row) => /SCAN audit_(event|pending)\b/.test(row.detail))).toEqual(
      [],
    );

    for (const statement of statements) expect(statement.params.length).toBeLessThanOrEqual(100);
    const plan = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${statements[0]!.sql}`,
      params: statements[0]!.params,
    });
    expect(
      plan.filter(
        (row) => row.detail.includes('version_package_status') && /\bvs\b/.test(row.detail),
      ),
    ).toHaveLength(3);
    expect(plan.some((row) => row.detail.includes('version_by_published'))).toBe(true);
  });
  it('does not read versions through an archived owner project', async () => {
    await ownLoser();
    await run("UPDATE project SET status = 'archived' WHERE id = 'P'");
    expect(
      await reader.listVersions(ctx, { packageId: id(20), projectId: 'P', limit: 10 }),
    ).toBeNull();
  });
  it('does not manage versions through an archived owner project', async () => {
    await ownLoser();
    await run("UPDATE project SET status = 'archived' WHERE id = 'P'");
    expect(
      await reader.findManagedVersion(ctx, {
        packageId: id(20),
        versionId: id(200),
        projectId: 'P',
      }),
    ).toBeNull();
  });
  it('distinguishes an empty or exhausted version page from an absent package', async () => {
    await pkg(10, 'empty');
    expect(
      await reader.listVersions(ctx, { packageId: id(10), projectId: null, limit: 10 }),
    ).toEqual({ items: [], next: null });
    await version(100, 10);
    expect(
      await reader.listVersions(ctx, {
        packageId: id(10),
        projectId: null,
        limit: 10,
        after: id(100),
      }),
    ).toEqual({ items: [], next: null });
  });
  it('validates limits and lowercase nonempty prefixes', async () => {
    for (const limit of [0, 101, 1.5])
      await expect(reader.listOrganization(ctx, { limit })).rejects.toThrow(TypeError);
    for (const q of ['', 'A', 'a'.repeat(101)])
      await expect(reader.listOrganization(ctx, { limit: 10, q })).rejects.toThrow(TypeError);
  });
});
