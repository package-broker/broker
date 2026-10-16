import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWinner, type VisibilityConfig } from '@package-broker/core/catalogue/visibility';
import { searchableName, type NameEcosystem } from '@package-broker/core/catalogue/names';
import type { ListedPackage } from '@package-broker/core/db/catalogue';
import {
  orgContext,
  type OrgContext,
  type ScalarStatement,
  type SqlExecutor,
} from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import {
  randomCatalogueConfig,
  seedCatalogue,
  seedDerivedRows,
  toVisibilityInputs,
  type CatalogueConfig,
} from '../testing/catalogue-fixture.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueList } from './catalogue-list.js';

const PROXY = new Set(['packagist_proxy', 'npmjs_proxy']);
const ECOSYSTEMS: readonly NameEcosystem[] = ['composer', 'npm'];

function expectedWinners(
  config: CatalogueConfig,
  inputs: VisibilityConfig,
  projectId: string,
  ecosystem: NameEcosystem,
): { key: string; packageId: string; sourceId: string }[] {
  const keys = [
    ...new Set(config.packages.filter((p) => p.ecosystem === ecosystem).map((p) => p.key)),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keys.flatMap((key) => {
    const winner = resolveWinner(inputs, projectId, ecosystem, key);
    return winner === null ? [] : [{ key, ...winner }];
  });
}

function expectedOpen(inputs: VisibilityConfig, projectId: string, ecosystem: NameEcosystem) {
  const project = inputs.projects.find((p) => p.id === projectId);
  if (!project?.active) return false;
  return inputs.attachments.some((a) => {
    const source = inputs.sources.find((s) => s.id === a.sourceId);
    return (
      a.projectId === projectId &&
      source !== undefined &&
      source.orgId === project.orgId &&
      source.ecosystem === ecosystem &&
      PROXY.has(source.type) &&
      (source.ownerProjectId === null || source.ownerProjectId === projectId)
    );
  });
}

async function listAll(
  executor: SqlExecutor,
  ctx: OrgContext,
  projectId: string,
  ecosystem: NameEcosystem,
  limit: number,
): Promise<{ items: ListedPackage[]; openNamespace: boolean[] }> {
  const counted = countCalls(executor);
  const list = createCatalogueList(counted.executor);
  const items: ListedPackage[] = [];
  const openNamespace: boolean[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const page = await list.listVisible(ctx, {
      projectId,
      ecosystem,
      limit,
      ...(after === undefined ? {} : { after }),
    });
    pages += 1;
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    openNamespace.push(page.openNamespace);
    after = page.next ?? undefined;
  } while (after !== undefined);
  expect(counted.counts()).toEqual({ all: pages, batch: 0 });
  return { items, openNamespace };
}

describe('listVisible and search against the oracle', () => {
  it('1, 3: pages cover each winner once and openNamespace follows the attached proxies', async () => {
    let listed = 0;
    let searched = 0;
    let open = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const config = randomCatalogueConfig(seed, 6);
      const database = await openMigratedDatabase();
      try {
        await seedCatalogue(database.executor, config, { maxStatements: Infinity });
        await seedDerivedRows(database.executor, config);
        const inputs = toVisibilityInputs(config);
        const list = createCatalogueList(database.executor);
        for (const project of config.projects) {
          const ctx = orgContext(project.orgId);
          for (const ecosystem of ECOSYSTEMS) {
            const expected = expectedWinners(config, inputs, project.id, ecosystem);
            const namespace = expectedOpen(inputs, project.id, ecosystem);
            for (const limit of [1 + (seed % 3), 200]) {
              const actual = await listAll(database.executor, ctx, project.id, ecosystem, limit);
              expect(
                actual.items.map(({ key, packageId, sourceId }) => ({ key, packageId, sourceId })),
                `${seed} ${project.id} ${ecosystem} ${limit}`,
              ).toEqual(expected);
              expect(new Set(actual.openNamespace)).toEqual(new Set([namespace]));
            }
            listed += expected.length;
            for (const text of ['p1', '/P', 's2/', 'v0', 'zz']) {
              const found = await list.search(ctx, {
                projectId: project.id,
                ecosystem,
                text,
                limit: 50,
              });
              const needle = text.toLowerCase();
              const want = expected.filter((w) => searchableName(w.key).includes(needle));
              expect(
                found.map(({ key, packageId, sourceId }) => ({ key, packageId, sourceId })),
                `${seed} ${project.id} ${ecosystem} ${text}`,
              ).toEqual(want.slice(0, 50));
              searched += want.length;
            }
          }
        }
        open += config.projects.filter((p) =>
          ECOSYSTEMS.some((e) => expectedOpen(inputs, p.id, e)),
        ).length;
      } finally {
        await database.close();
      }
    }
    expect(listed).toBeGreaterThan(300);
    expect(searched).toBeGreaterThan(100);
    expect(open).toBeGreaterThan(20);
  }, 180_000);
});

let database: MigratedDatabase;
let ctx: OrgContext;
let other: OrgContext;

async function exec(sql: string, params: (string | number | null)[] = []): Promise<void> {
  await database.executor.batch([{ sql, params }]);
}

async function project(id: string, orgId = ctx.orgId, status = 'active'): Promise<void> {
  await exec('INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)', [
    id,
    orgId,
    id.toLowerCase(),
    id,
    status,
  ]);
}

async function source(
  id: string,
  type: string,
  options: { project?: string; ecosystem?: string; orgId?: string } = {},
): Promise<void> {
  await exec(
    'INSERT INTO source (id, org_id, project_id, name, ecosystem, type, removal_policy) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      options.orgId ?? ctx.orgId,
      options.project ?? null,
      id,
      options.ecosystem ?? 'composer',
      type,
      'flag',
    ],
  );
}

async function pkg(
  id: string,
  sourceId: string,
  name: string,
  options: { ecosystem?: string; orgId?: string; description?: string } = {},
): Promise<void> {
  await exec(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name, description) VALUES (?, ?, ?, ?, ?, ?)',
    [
      id,
      options.orgId ?? ctx.orgId,
      sourceId,
      options.ecosystem ?? 'composer',
      name,
      options.description ?? null,
    ],
  );
}

async function attach(
  projectId: string,
  sourceId: string,
  precedence = 100,
  orgId = ctx.orgId,
): Promise<void> {
  await exec(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
    [orgId, projectId, sourceId, precedence],
  );
}

async function admit(projectId: string, packageId: string, orgId = ctx.orgId): Promise<void> {
  await exec(
    "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'subscription')",
    [orgId, projectId, packageId],
  );
}

function list() {
  return createCatalogueList(database.executor);
}

async function keys(projectId = 'P1', ecosystem: NameEcosystem = 'composer'): Promise<string[]> {
  const page = await list().listVisible(ctx, { projectId, ecosystem, limit: 200 });
  return page.items.map((item) => `${item.key}@${item.sourceId}`);
}

async function find(
  text: string,
  ecosystem: NameEcosystem = 'composer',
  projectId = 'P1',
): Promise<string[]> {
  const found = await list().search(ctx, { projectId, ecosystem, text, limit: 50 });
  return found.map((item) => `${item.key}@${item.sourceId}`);
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('orgs missing');
  ctx = database.orgs.a;
  other = database.orgs.b;
  await project('P1');
  await project('P2');
});

afterEach(async () => {
  await database.close();
});

describe('winner rule', () => {
  it('1: a key from two sources appears once, with the winner and its description', async () => {
    await source('S-ORG', 'vcs');
    await source('S-OWN', 'composer_repository', { project: 'P1' });
    await source('S-PROXY', 'packagist_proxy');
    for (const s of ['S-ORG', 'S-OWN', 'S-PROXY']) await attach('P1', s, s === 'S-ORG' ? 1 : 100);
    await pkg('K1', 'S-ORG', 'acme/both', { description: 'org copy' });
    await pkg('K2', 'S-OWN', 'acme/both', { description: 'own copy' });
    await pkg('K3', 'S-PROXY', 'acme/both');
    await pkg('K4', 'S-PROXY', 'vendor/only-proxy', { description: 'proxied' });
    for (const k of ['K1', 'K2', 'K3', 'K4']) await admit('P1', k);
    const page = await list().listVisible(ctx, {
      projectId: 'P1',
      ecosystem: 'composer',
      limit: 200,
    });
    expect(page).toEqual({
      items: [
        { key: 'acme/both', packageId: 'K2', sourceId: 'S-OWN', description: 'own copy' },
        {
          key: 'vendor/only-proxy',
          packageId: 'K4',
          sourceId: 'S-PROXY',
          description: 'proxied',
        },
      ],
      next: null,
      openNamespace: true,
    });
  });

  it('a non-proxy source outranks a proxy at equal precedence, and precedence then source id decide', async () => {
    await source('S-A', 'vcs');
    await source('S-B', 'vcs');
    await source('S-PROXY', 'packagist_proxy');
    await attach('P1', 'S-PROXY', 0);
    await attach('P1', 'S-A', 50);
    await attach('P1', 'S-B', 50);
    await pkg('K1', 'S-PROXY', 'acme/x');
    await pkg('K2', 'S-B', 'acme/x');
    await pkg('K3', 'S-A', 'acme/x');
    for (const k of ['K1', 'K2', 'K3']) await admit('P1', k);
    expect(await keys()).toEqual(['acme/x@S-A']);
    await exec("UPDATE project_source SET precedence = 10 WHERE source_id = 'S-B'");
    expect(await keys()).toEqual(['acme/x@S-B']);
  });

  it('a proxy row whose key exists in any non-proxy source is never listed, even when that row is invisible', async () => {
    await source('S-HIDDEN', 'vcs');
    await source('S-PROXY', 'packagist_proxy');
    await attach('P1', 'S-PROXY');
    await pkg('K1', 'S-HIDDEN', 'acme/private');
    await pkg('K2', 'S-PROXY', 'acme/private');
    await admit('P1', 'K2');
    expect(await keys()).toEqual([]);
    expect(await find('private')).toEqual([]);
  });

  it('falls back to the next eligible row when the better one is removed and the policy excludes it', async () => {
    await source('S-A', 'vcs');
    await source('S-B', 'vcs');
    await exec("UPDATE source SET removal_policy = 'exclude' WHERE id = 'S-A'");
    await attach('P1', 'S-A', 1);
    await attach('P1', 'S-B', 2);
    await pkg('K1', 'S-A', 'acme/x');
    await pkg('K2', 'S-B', 'acme/x');
    await admit('P1', 'K1');
    await admit('P1', 'K2');
    expect(await keys()).toEqual(['acme/x@S-A']);
    await exec(
      "UPDATE package SET status = 'removed_upstream', removed_upstream_at = '2020-01-01T00:00:00.000Z' WHERE id = 'K1'",
    );
    expect(await keys()).toEqual(['acme/x@S-B']);
  });
});

describe('isolation', () => {
  beforeEach(async () => {
    await source('S-ORG', 'vcs');
    await source('S-P2', 'vcs', { project: 'P2' });
    await source('S-LOOSE', 'vcs');
    await attach('P1', 'S-ORG');
    await attach('P2', 'S-P2');
    await pkg('K1', 'S-ORG', 'acme/shared');
    await pkg('K2', 'S-P2', 'acme/secret');
    await pkg('K3', 'S-LOOSE', 'acme/loose');
    await admit('P1', 'K1');
    await admit('P2', 'K2');
  });

  it('2: names only in another project-level source or an unattached source are never returned', async () => {
    expect(await keys()).toEqual(['acme/shared@S-ORG']);
    expect(await find('acme')).toEqual(['acme/shared@S-ORG']);
    expect(await find('secret')).toEqual([]);
    expect(await find('loose')).toEqual([]);
  });

  it('forged project_package and project_source rows do not leak another project-level package', async () => {
    await attach('P1', 'S-P2');
    await admit('P1', 'K2');
    await admit('P1', 'K3');
    expect(await keys()).toEqual(['acme/shared@S-ORG']);
    expect(await find('secret')).toEqual([]);
    expect(await find('loose')).toEqual([]);
  });

  it('another organization context sees nothing and ids of another organization stay invisible', async () => {
    const page = await list().listVisible(other, {
      projectId: 'P1',
      ecosystem: 'composer',
      limit: 200,
    });
    expect(page).toEqual({ items: [], next: null, openNamespace: false });
    expect(
      await list().search(other, {
        projectId: 'P1',
        ecosystem: 'composer',
        text: 'acme',
        limit: 5,
      }),
    ).toEqual([]);
  });

  it('an archived project lists nothing and reports no open namespace', async () => {
    await source('S-PROXY', 'packagist_proxy');
    await attach('P1', 'S-PROXY');
    await exec("UPDATE project SET status = 'archived' WHERE id = 'P1'");
    const page = await list().listVisible(ctx, {
      projectId: 'P1',
      ecosystem: 'composer',
      limit: 200,
    });
    expect(page).toEqual({ items: [], next: null, openNamespace: false });
    expect(await find('acme')).toEqual([]);
  });
});

describe('openNamespace', () => {
  it('3: true iff a proxy of the ecosystem is attached to the project', async () => {
    const open = async (ecosystem: NameEcosystem) =>
      (await list().listVisible(ctx, { projectId: 'P1', ecosystem, limit: 1 })).openNamespace;
    expect(await open('composer')).toBe(false);
    await source('S-NPM-PROXY', 'npmjs_proxy', { ecosystem: 'npm' });
    await attach('P1', 'S-NPM-PROXY');
    expect(await open('composer')).toBe(false);
    expect(await open('npm')).toBe(true);
    await source('S-P2-PROXY', 'packagist_proxy', { project: 'P2' });
    await attach('P1', 'S-P2-PROXY');
    expect(await open('composer')).toBe(false);
    await source('S-PROXY', 'packagist_proxy');
    await attach('P2', 'S-PROXY');
    expect(await open('composer')).toBe(false);
    await attach('P1', 'S-PROXY');
    expect(await open('composer')).toBe(true);
  });
});

describe('keyset paging', () => {
  it('3: pages cover each key once in name order and the last page has no continuation', async () => {
    await source('S1', 'vcs');
    await source('S2', 'vcs');
    await attach('P1', 'S1');
    await attach('P1', 'S2');
    const names: string[] = [];
    for (let n = 0; n < 25; n += 1) {
      const name = `acme/p${String(n).padStart(2, '0')}`;
      names.push(name);
      await pkg(`A${n}`, 'S1', name);
      await admit('P1', `A${n}`);
      if (n % 2 === 0) {
        await pkg(`B${n}`, 'S2', name);
        await admit('P1', `B${n}`);
      }
    }
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await list().listVisible(ctx, {
        projectId: 'P1',
        ecosystem: 'composer',
        limit: 7,
        ...(after === undefined ? {} : { after }),
      });
      seen.push(...page.items.map((i) => i.key));
      after = page.next ?? undefined;
      pages += 1;
    } while (after !== undefined);
    expect(seen).toEqual(names);
    expect(pages).toBe(4);
    const exact = await list().listVisible(ctx, {
      projectId: 'P1',
      ecosystem: 'composer',
      limit: 25,
    });
    expect(exact.items).toHaveLength(25);
    expect(exact.next).toBeNull();
  });
});

describe('search', () => {
  beforeEach(async () => {
    await source('S-NPM', 'npm_registry', { ecosystem: 'npm' });
    await source('S1', 'vcs');
    await attach('P1', 'S-NPM');
    await attach('P1', 'S1');
    await pkg('N1', 'S-NPM', '!j!s!o!n!stream', { ecosystem: 'npm' });
    await pkg('N2', 'S-NPM', 'jsonfile', { ecosystem: 'npm' });
    await pkg('C1', 'S1', 'acme/a_b');
    await pkg('C2', 'S1', 'acme/axb');
    await pkg('C3', 'S1', 'acme/a-b');
    for (const k of ['N1', 'N2', 'C1', 'C2', 'C3']) await admit('P1', k);
  });

  it('2: jsonstream finds JSONStream through the searchable name', async () => {
    expect(await find('jsonstream', 'npm')).toEqual(['!j!s!o!n!stream@S-NPM']);
    expect(await find('  JSONStream ', 'npm')).toEqual(['!j!s!o!n!stream@S-NPM']);
    expect(await find('json', 'npm')).toEqual(['!j!s!o!n!stream@S-NPM', 'jsonfile@S-NPM']);
    expect(await find('json', 'composer')).toEqual([]);
  });

  it('escapes LIKE wildcards and the escape character', async () => {
    expect(await find('a_b')).toEqual(['acme/a_b@S1']);
    expect(await find('%')).toEqual([]);
    expect(await find('a%b')).toEqual([]);
    expect(await find('\\')).toEqual([]);
    expect(await find('a-b')).toEqual(['acme/a-b@S1']);
  });

  it('refuses !, NUL, an empty or blank query and a query over 100 characters', async () => {
    for (const text of ['!j', '\u0000', 'a\u0000', '\u0000json', '', '   ', 'x'.repeat(101)]) {
      await expect(find(text)).rejects.toThrow(TypeError);
    }
    expect(await find('x'.repeat(100))).toEqual([]);
  });

  it('caps the result at the limit in name order', async () => {
    const found = await list().search(ctx, {
      projectId: 'P1',
      ecosystem: 'composer',
      text: 'acme',
      limit: 2,
    });
    expect(found.map((f) => f.key)).toEqual(['acme/a-b', 'acme/a_b']);
  });
});

describe('limits', () => {
  it('validates limits with the catalogue maxima', async () => {
    const reader = list();
    for (const limit of [0, 201, 1.5, Number.NaN]) {
      await expect(
        reader.listVisible(ctx, { projectId: 'P1', ecosystem: 'composer', limit }),
      ).rejects.toThrow(TypeError);
    }
    for (const limit of [0, 51]) {
      await expect(
        reader.search(ctx, { projectId: 'P1', ecosystem: 'composer', text: 'a', limit }),
      ).rejects.toThrow(TypeError);
    }
    await expect(
      reader.listVisible(ctx, { projectId: 'P1', ecosystem: 'composer', limit: 200 }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      reader.search(ctx, { projectId: 'P1', ecosystem: 'composer', text: 'a', limit: 50 }),
    ).resolves.toEqual([]);
  });
});

describe('statements', () => {
  it('3: one executor.all per call, at most 100 parameters, LIKE patterns of at most 50 bytes, no SCAN of package', async () => {
    await source('S1', 'vcs');
    await source('S-PROXY', 'packagist_proxy');
    await attach('P1', 'S1');
    await attach('P1', 'S-PROXY');
    for (let n = 0; n < 30; n += 1) {
      await project(`PX${n}`);
      await attach(`PX${n}`, 'S1');
    }
    for (let n = 0; n < 40; n += 1) {
      await pkg(`K${n}`, 'S1', `acme/p${n}`);
      await admit('P1', `K${n}`);
      await pkg(`KP${n}`, 'S-PROXY', `vendor/p${n}`);
      await admit('P1', `KP${n}`);
    }
    await database.analyze();
    const captured: ScalarStatement[] = [];
    const counted = countCalls(database.executor);
    const capturing = new Proxy(counted.executor, {
      get(target, property, receiver) {
        if (property === 'all') {
          return async (statement: ScalarStatement) => {
            captured.push(statement);
            return target.all(statement);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const reader = createCatalogueList(capturing);
    const first = await reader.listVisible(ctx, {
      projectId: 'P1',
      ecosystem: 'composer',
      limit: 3,
    });
    await reader.listVisible(ctx, {
      projectId: 'P1',
      ecosystem: 'composer',
      limit: 3,
      after: first.next as string,
    });
    await reader.search(ctx, { projectId: 'P1', ecosystem: 'composer', text: 'p1', limit: 50 });
    const long = await reader.search(ctx, {
      projectId: 'P1',
      ecosystem: 'composer',
      text: `acme/p1${'%'.repeat(30)}`,
      limit: 50,
    });
    expect(long).toEqual([]);
    expect(counted.counts()).toEqual({ all: 4, batch: 0 });
    for (const statement of captured) {
      expect(statement.params.length).toBeLessThanOrEqual(100);
      for (const param of statement.params) {
        if (typeof param === 'string' && param.startsWith('%')) {
          expect(new TextEncoder().encode(param).length).toBeLessThanOrEqual(50);
        }
      }
      const plan = await database.executor.all<{ detail: string }>({
        sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
        params: statement.params,
      });
      const details = plan.map((row) => row.detail);
      const text = details.join('\n');
      expect(
        details.filter((d) => /^SCAN (pkg|bp|q|package)\b/.test(d)),
        text,
      ).toEqual([]);
      expect(text).toMatch(/USING INDEX package_by_name/);
      expect(text).toMatch(/SEARCH pp USING PRIMARY KEY/);
    }
  });
});
