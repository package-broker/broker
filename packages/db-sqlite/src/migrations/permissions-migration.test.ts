import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlValue } from '@package-broker/core/db/port';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { migrate } from './runner.js';
import { loadMigrationSource } from './source.js';
import { splitStatements } from './split.js';

const migrationsUrl = new URL('../../migrations/', import.meta.url);
const additions = ['org:packages:manage', 'org:import:write', 'org:import:approve'];
let opened: OpenedExecutor;

async function rows<R>(sql: string, params: readonly SqlValue[] = []): Promise<R[]> {
  return opened.executor.all<R>({ sql, params });
}

async function sources(limit: string) {
  return Promise.all(
    readdirSync(migrationsUrl)
      .filter((name) => name.endsWith('.sql') && name < limit)
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(new URL(name, migrationsUrl), 'utf8')),
      ),
  );
}

async function seedRole(org: string, key = 'organization_admin', system = 1, protects = 1) {
  await rows('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [org, org, org]);
  await rows('INSERT INTO cache_epoch (org_id, version) VALUES (?, ?)', [org, 'before']);
  await rows(
    "INSERT INTO role (id, org_id, key, name, scope, is_system, protects_last_holder, revision) VALUES (?, ?, ?, 'Admin', 'organization', ?, ?, 7)",
    [org, org, key, system, protects],
  );
  await rows('INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)', [
    org,
    org,
    'org:read',
  ]);
}

async function snapshot(org: string) {
  return {
    role: await rows('SELECT * FROM role WHERE org_id = ?', [org]),
    permissions: await rows('SELECT * FROM role_permission WHERE org_id = ? ORDER BY permission', [
      org,
    ]),
    epoch: await rows('SELECT version FROM cache_epoch WHERE org_id = ?', [org]),
  };
}

async function upgrade() {
  return migrate(opened.executor, await sources('0014_'), { holder: 'permissions-test' });
}

beforeEach(async () => {
  opened = openNodeSqliteExecutor();
  await migrate(opened.executor, await sources('0013_'), { holder: 'permissions-test' });
  await rows('DROP INDEX organization_singleton');
});

afterEach(async () => {
  await opened.close();
});

describe('migration 0013', () => {
  it('tops up every legacy protected admin and invalidates its cached permissions once', async () => {
    for (const org of ['org-a', 'org-b']) await seedRole(org);
    const result = await upgrade();
    expect(result.applied).toEqual(['core:0013_permissions']);
    for (const org of ['org-a', 'org-b']) {
      expect(
        await rows('SELECT permission FROM role_permission WHERE org_id = ? ORDER BY permission', [
          org,
        ]),
      ).toEqual([...additions, 'org:read'].sort().map((permission) => ({ permission })));
      expect(await rows('SELECT revision FROM role WHERE org_id = ?', [org])).toEqual([
        { revision: 8 },
      ]);
      expect((await snapshot(org)).epoch).not.toEqual([{ version: 'before' }]);
    }
    const source = await loadMigrationSource(
      'core',
      '0013_permissions.sql',
      readFileSync(new URL('0013_permissions.sql', migrationsUrl), 'utf8'),
    );
    expect(source.phase).toBe('expand');
  });

  it.each(additions)('tops up when only %s is missing', async (missing) => {
    await seedRole('org-a');
    for (const permission of additions.filter((name) => name !== missing)) {
      await rows('INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)', [
        'org-a',
        'org-a',
        permission,
      ]);
    }
    await upgrade();
    expect(await rows('SELECT revision FROM role WHERE org_id = ?', ['org-a'])).toEqual([
      { revision: 8 },
    ]);
    expect((await snapshot('org-a')).epoch).not.toEqual([{ version: 'before' }]);
    expect(
      await rows('SELECT permission FROM role_permission WHERE org_id = ? AND permission = ?', [
        'org-a',
        missing,
      ]),
    ).toEqual([{ permission: missing }]);
  });

  it.each([
    ['editable role', 'editor', 0, 0],
    ['different key', 'other_admin', 1, 1],
    ['non-system admin', 'organization_admin', 0, 1],
    ['unprotected admin', 'organization_admin', 1, 0],
  ] as const)('leaves the %s untouched', async (_, key, system, protects) => {
    await seedRole('org-a');
    await seedRole('org-b', key, system, protects);
    // The editable role shares the upgraded organization.
    await rows(
      "INSERT INTO role (id, org_id, key, name, scope, revision) VALUES ('editor', 'org-a', 'editor', 'Editor', 'organization', 4)",
    );
    await rows(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES ('org-a', 'editor', 'org:read')",
    );
    const before = await snapshot('org-b');
    const editor = await rows("SELECT * FROM role WHERE org_id = 'org-a' AND id = 'editor'");
    await upgrade();
    expect(await snapshot('org-b')).toEqual(before);
    expect(await rows("SELECT * FROM role WHERE org_id = 'org-a' AND id = 'editor'")).toEqual(
      editor,
    );
    expect(
      await rows(
        "SELECT permission FROM role_permission WHERE org_id = 'org-a' AND role_id = 'editor'",
      ),
    ).toEqual([{ permission: 'org:read' }]);
  });

  it('does not change an already complete admin or its epoch', async () => {
    await seedRole('org-a');
    for (const permission of additions) {
      await rows('INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)', [
        'org-a',
        'org-a',
        permission,
      ]);
    }
    const before = await snapshot('org-a');
    await upgrade();
    expect(await snapshot('org-a')).toEqual(before);
  });

  it('replaying the SQL adds no duplicates and does not bump revision or epoch', async () => {
    await seedRole('org-a');
    await upgrade();
    const before = await snapshot('org-a');
    const sql = readFileSync(new URL('0013_permissions.sql', migrationsUrl), 'utf8');
    await opened.executor.batch(
      splitStatements(sql).map((statement) => ({ sql: statement, params: [] })),
    );
    expect(await snapshot('org-a')).toEqual(before);
  });
});
