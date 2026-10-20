import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orgContext, type ScalarStatement } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { seedCatalogue } from '../testing/catalogue-fixture.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { createScopedAdmission } from './scoped-admission.js';
import { withForeignKeysOff } from '../testing/foreign-keys-off.js';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const PROJECT = 'project-a';
const OTHER_PROJECT = 'project-b';
const SOURCE = 'registry';

describe('scoped npm admission', () => {
  let database: Awaited<ReturnType<typeof openMigratedDatabase>>;
  beforeEach(async () => {
    database = await openMigratedDatabase();
    await seedCatalogue(database.executor, {
      organizations: [ORG, OTHER_ORG].map((id) => ({ id, slug: id, name: id })),
      projects: [PROJECT, OTHER_PROJECT].map((id) => ({
        id,
        orgId: ORG,
        slug: id,
        name: id,
        status: 'active',
      })),
      sources: [
        {
          id: SOURCE,
          orgId: ORG,
          projectId: null,
          name: SOURCE,
          ecosystem: 'npm',
          type: 'npm_registry',
          defaultVisible: 1,
          removalPolicy: 'flag',
        },
      ],
      attachments: [{ orgId: ORG, projectId: PROJECT, sourceId: SOURCE, precedence: 10 }],
      registeredNames: [
        {
          id: 'registration',
          orgId: ORG,
          sourceId: SOURCE,
          ecosystem: 'npm',
          pattern: '@acme/*',
        },
      ],
      patterns: [],
      packages: [],
      explicit: [],
      versions: [],
    });
    await mutate('UPDATE source SET config_json = \'{"scopes":["@acme"]}\'');
  });
  afterEach(async () => {
    await database.close();
  });

  async function mutate(sql: string, params: ScalarStatement['params'] = []) {
    await database.executor.batch([{ sql, params }]);
  }
  const mutateForged = (sql: string, params: ScalarStatement['params'] = []) =>
    withForeignKeysOff(database.executor, () => mutate(sql, params));
  async function admitted(key = '@acme/unseen', projectId = PROJECT, orgId = ORG) {
    const counted = countCalls(database.executor);
    const result = await createScopedAdmission(counted.executor).admitScoped(orgContext(orgId), {
      projectId,
      key,
    });
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    return result;
  }

  it('admits an unseen scoped name despite its registered-name reservation', async () => {
    expect(await admitted()).toEqual([SOURCE]);
    await mutate('UPDATE source SET project_id = ?', [PROJECT]);
    expect(await admitted()).toEqual([SOURCE]);
  });
  it('refuses a forged attachment of another project-owned registry', async () => {
    await mutate('UPDATE source SET project_id = ?', [OTHER_PROJECT]);
    expect(await admitted()).toEqual([]);
  });
  it.each([
    'unscoped',
    '@acme',
    '@acme/',
    '@acme/name/extra',
    '@acme//',
    '@/name',
    '@other/unseen',
    '@acme-extra/unseen',
  ])('refuses an uncovered key %s', async (key) => {
    expect(await admitted(key)).toEqual([]);
  });
  it('requires registration of the entire scope by this source', async () => {
    await mutate("UPDATE registered_name SET pattern = '@acme/unseen'");
    expect(await admitted()).toEqual([]);
    await mutate('DELETE FROM registered_name');
    expect(await admitted()).toEqual([]);
  });
  it.each([0, 1] as const)(
    'refuses existing package rows with visibility %i in any status',
    async (visible) => {
      await mutate(
        `INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects)
      VALUES ('package', ?, ?, 'npm', '@acme/unseen', ?)`,
        [ORG, SOURCE, visible],
      );
      expect(await admitted()).toEqual([]);
      await mutate(
        "UPDATE package SET status = 'removed_upstream', removed_upstream_at = '2020-01-01T00:00:00Z'",
      );
      expect(await admitted()).toEqual([]);
    },
  );
  it.each(['paused', 'degraded', 'failing'])('refuses %s sources', async (status) => {
    await mutate('UPDATE source SET status = ?', [status]);
    expect(await admitted()).toEqual([]);
  });
  it('requires an active project in the caller organization and an attachment', async () => {
    expect(await admitted('@acme/unseen', PROJECT, OTHER_ORG)).toEqual([]);
    expect(await admitted('@acme/unseen', OTHER_PROJECT)).toEqual([]);
    expect(await admitted('@acme/unseen', 'missing')).toEqual([]);
    await mutate("UPDATE project SET status = 'archived' WHERE id = ?", [PROJECT]);
    expect(await admitted()).toEqual([]);
  });
  it('refuses a foreign source and a foreign registration', async () => {
    await mutateForged('UPDATE registered_name SET org_id = ?', [OTHER_ORG]);
    expect(await admitted()).toEqual([]);
    await mutate('UPDATE registered_name SET org_id = ?', [ORG]);
    await mutateForged('UPDATE source SET org_id = ?', [OTHER_ORG]);
    expect(await admitted()).toEqual([]);
  });
  it('refuses an attachment with a forged organization', async () => {
    await mutateForged('UPDATE project_source SET org_id = ?', [OTHER_ORG]);
    expect(await admitted()).toEqual([]);
  });
  it('ignores a package row belonging to another organization', async () => {
    await mutateForged(
      `INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects)
      VALUES ('foreign-package', ?, ?, 'npm', '@acme/unseen', 0)`,
      [OTHER_ORG, SOURCE],
    );
    expect(await admitted()).toEqual([SOURCE]);
  });
  it('requires each attached source to register its configured scope', async () => {
    const second = 'a-registry';
    await mutate(
      `INSERT INTO source (id, org_id, name, ecosystem, type, config_json, default_visible_to_new_projects)
      SELECT ?, org_id, ?, ecosystem, type, config_json, default_visible_to_new_projects
      FROM source WHERE id = ?`,
      [second, second, SOURCE],
    );
    await mutate(
      'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, 20)',
      [ORG, PROJECT, second],
    );
    expect(await admitted()).toEqual([SOURCE]);
  });
  it.each(['npmjs_proxy', 'hosted'])('refuses source type %s', async (type) => {
    await mutate('UPDATE source SET type = ?', [type]);
    expect(await admitted()).toEqual([]);
  });
  it('applies the source default flag and include/exclude rules', async () => {
    await mutate('UPDATE source SET default_visible_to_new_projects = 0');
    expect(await admitted()).toEqual([]);
    await mutate('UPDATE source SET default_visible_to_new_projects = 1');
    await mutate(
      `INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect)
      VALUES ('rule', ?, ?, ?, '@acme/allowed-*', 'include')`,
      [ORG, PROJECT, SOURCE],
    );
    expect(await admitted()).toEqual([]);
    expect(await admitted('@acme/allowed-one')).toEqual([SOURCE]);
    await mutate("UPDATE project_package_pattern SET effect = 'exclude'");
    expect(await admitted('@acme/allowed-one')).toEqual([]);
    expect(await admitted()).toEqual([SOURCE]);
  });
});
