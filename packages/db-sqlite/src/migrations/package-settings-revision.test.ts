import { expect, it } from 'vitest';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { migrate } from './runner.js';

it('upgrades existing package settings to revision 1 while preserving catalogue revisions', async () => {
  const database = openNodeSqliteExecutor();
  try {
    const migrations = await discoveredMigrations();
    await migrate(
      database.executor,
      migrations.filter((migration) => migration.name !== '0005_package_settings_revision.sql'),
      { holder: 'settings-upgrade' },
    );
    await database.executor.batch([
      { sql: "INSERT INTO organization (id, slug, name) VALUES ('O', 'demo', 'Demo')", params: [] },
      {
        sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', 'O', 'Releases', 'npm', 'hosted')",
        params: [],
      },
      {
        sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name, rev, visible_to_new_projects, new_project_access_mode) VALUES ('K', 'O', 'S', 'npm', 'widget', 42, 0, 'request')",
        params: [],
      },
    ]);
    await migrate(database.executor, migrations, { holder: 'settings-upgrade' });
    expect(
      await database.executor.all({
        sql: "SELECT rev, settings_revision, visible_to_new_projects, new_project_access_mode FROM package WHERE org_id = 'O'",
        params: [],
      }),
    ).toEqual([
      {
        rev: 42,
        settings_revision: 1,
        visible_to_new_projects: 0,
        new_project_access_mode: 'request',
      },
    ]);
  } finally {
    await database.close();
  }
});
