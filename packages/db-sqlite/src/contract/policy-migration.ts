import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import { migrate } from '../migrations/runner.js';
import { splitStatements } from '../migrations/split.js';
import { scanSql } from '../sql/scan.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import type { OpenedExecutor } from './executor-contract.js';

const ORG = '01J0P0L1CY0000000000000000';
const OTHER = '01J0P0L1CY0000000000000001';
const NOW = '2026-11-01T00:00:00.000Z';
const LATER = '2026-12-01T00:00:00.000Z';

/** The frozen core migrations before 0008; a change here rewrites applied history. */
const FROZEN: Readonly<Record<string, string>> = {
  '0001_init.sql': 'a1005fb24893ffe9174ae1f1642b3f1270d853476183a47ce2b5e4d32471e2fb',
  '0002_npm_publish.sql': '1beaf4be82bc086b014d5999d85e37b2ead8b04acc5db98d6720d08d5d5368cb',
  '0003_npm_identity.sql': '1b7ee8616cdbf062cea7fd10458b8df9739cb19323ce765f2f2b3068552288fa',
  '0004_source_revision.sql': '9971e927c07c1b2e1ff7da3f73b4673b19c80be48329a35fc23def5a95aee6ed',
  '0005_package_settings_revision.sql':
    'ed867ced9882400ec2e51bd9cdd1100426470d130091b4a8e95ff0bdd025c2cb',
  '0006_npm_login_handoff.sql': 'e1140895bb8b68e2b05054dc814d50e71ab1cf745638739310266a43dbe26117',
  '0007_npm_vcs_build_outcomes.sql':
    'f8434d0e092809b35c472a2f1ba1b317836415694e909f929df3e6559f2e7891',
};

type Row = Record<string, string | number | null>;

const RULE: Row = {
  id: 'rule-1',
  org_id: ORG,
  project_id: null,
  ecosystem: 'npm',
  package_key: 'left-pad',
  kind: 'block',
  min_age_seconds: null,
  client_family: null,
  client_min_version: null,
  reason_code: 'security_review',
  incident_id: null,
  expires_at: null,
  disabled_at: null,
  disabled_reason: null,
  created_at: NOW,
  updated_at: NOW,
};

async function seed(executor: ScalarSqlExecutor) {
  await executor.batch([
    {
      sql: 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?), (?, ?, ?)',
      params: [ORG, 'policy', 'Policy', OTHER, 'other', 'Other'],
    },
    {
      sql: "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'p', 'P'), ('foreign-project', ?, 'f', 'F')",
      params: [ORG, OTHER],
    },
  ]);
}

async function insertRule(executor: ScalarSqlExecutor, overrides: Row = {}) {
  const row = { ...RULE, ...overrides };
  const columns = Object.keys(row);
  await executor.all({
    sql: `INSERT INTO registry_policy_rule (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    params: columns.map((column) => row[column] ?? null),
  });
}

async function kind(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    return 'accepted';
  } catch (error) {
    return error instanceof DbError ? error.kind : 'thrown';
  }
}

async function dropDuplicateOrganizationGuard(executor: ScalarSqlExecutor) {
  await executor.all({ sql: 'DROP INDEX organization_singleton', params: [] });
}

export function describePolicyMigrationContract(
  name: string,
  open: () => Promise<OpenedExecutor>,
): void {
  async function withDatabase(body: (executor: ScalarSqlExecutor) => Promise<void>) {
    const opened = await open();
    try {
      await opened.executor.all({ sql: 'PRAGMA foreign_keys = ON', params: [] });
      await migrate(opened.executor, await discoveredMigrations(), { holder: 'policy-migration' });
      await dropDuplicateOrganizationGuard(opened.executor);
      await seed(opened.executor);
      await body(opened.executor);
    } finally {
      await opened.close();
    }
  }

  describe(`registry policy migration: ${name}`, () => {
    it('a fresh schema has both tables and no automatic rules or members', async () => {
      await withDatabase(async (executor) => {
        expect(
          await executor.all({
            sql: "SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 16) = 'registry_policy_' ORDER BY name",
            params: [],
          }),
        ).toEqual([{ name: 'registry_policy_rule' }, { name: 'registry_policy_version' }]);
        expect(
          await executor.all({
            sql: 'SELECT (SELECT count(*) FROM registry_policy_rule) AS rules, (SELECT count(*) FROM registry_policy_version) AS members',
            params: [],
          }),
        ).toEqual([{ rules: 0, members: 0 }]);
      });
    });

    it('accepts a zero-member block and defaults deny_unknown and revision', async () => {
      await withDatabase(async (executor) => {
        await insertRule(executor);
        expect(
          await executor.all({
            sql: 'SELECT deny_unknown, revision, expiry_audited_at FROM registry_policy_rule WHERE org_id = ?',
            params: [ORG],
          }),
        ).toEqual([{ deny_unknown: 0, revision: 1, expiry_audited_at: null }]);
        expect(
          await executor.all({
            sql: 'SELECT count(*) AS n FROM registry_policy_version WHERE org_id = ?',
            params: [ORG],
          }),
        ).toEqual([{ n: 0 }]);
      });
    });

    it('accepts each rule kind in its own shape', async () => {
      await withDatabase(async (executor) => {
        await insertRule(executor, {
          id: 'age',
          kind: 'min_age',
          min_age_seconds: 86400,
          package_key: null,
          project_id: 'project',
        });
        await insertRule(executor, { id: 'allow', kind: 'allowlist', expires_at: LATER });
        await insertRule(executor, {
          id: 'quarantine',
          kind: 'quarantine',
          reason_code: 'malware',
        });
        await insertRule(executor, {
          id: 'floor',
          kind: 'client_floor',
          package_key: null,
          client_family: 'pnpm',
          client_min_version: '9.0.0',
          deny_unknown: 1,
          reason_code: 'compatibility',
        });
        await insertRule(executor, {
          id: 'disabled',
          disabled_at: LATER,
          disabled_reason: 'false_positive',
        });
        await executor.all({
          sql: "INSERT INTO registry_policy_version (org_id, rule_id, version_normalized) VALUES (?, 'quarantine', '1.0.0')",
          params: [ORG],
        });
        expect(
          await executor.all({
            sql: 'SELECT count(*) AS n FROM registry_policy_rule WHERE org_id = ?',
            params: [ORG],
          }),
        ).toEqual([{ n: 5 }]);
      });
    });

    it.each<[string, Row]>([
      ['an unknown kind', { kind: 'exception' }],
      ['an unknown ecosystem', { ecosystem: 'pypi' }],
      ['a free-text reason', { reason_code: 'because' }],
      ['a block without a package', { package_key: null }],
      ['a min_age without seconds', { kind: 'min_age', package_key: null }],
      ['seconds on a block', { min_age_seconds: 10 }],
      ['a negative age', { kind: 'min_age', min_age_seconds: -1 }],
      ['an age above ten years', { kind: 'min_age', min_age_seconds: 315360001 }],
      ['deny_unknown on a block', { deny_unknown: 1 }],
      [
        'deny_unknown outside 0 and 1',
        {
          kind: 'client_floor',
          package_key: null,
          client_family: 'npm',
          client_min_version: '9.0.0',
          deny_unknown: 2,
        },
      ],
      [
        'a client floor on a package',
        { kind: 'client_floor', client_family: 'npm', client_min_version: '9.0.0' },
      ],
      [
        'a client floor without a version',
        { kind: 'client_floor', package_key: null, client_family: 'npm' },
      ],
      [
        'an unknown client family',
        {
          kind: 'client_floor',
          package_key: null,
          client_family: 'bun',
          client_min_version: '1.0.0',
        },
      ],
      [
        'a composer family on npm',
        {
          kind: 'client_floor',
          package_key: null,
          client_family: 'composer',
          client_min_version: '2.0.0',
        },
      ],
      [
        'an npm family on composer',
        {
          kind: 'client_floor',
          ecosystem: 'composer',
          package_key: null,
          client_family: 'yarn',
          client_min_version: '4.0.0',
        },
      ],
      [
        'a short client version',
        { kind: 'client_floor', package_key: null, client_family: 'npm', client_min_version: '9' },
      ],
      ['client fields on a block', { client_family: 'npm', client_min_version: '9.0.0' }],
      [
        'a project quarantine',
        { kind: 'quarantine', reason_code: 'malware', project_id: 'project' },
      ],
      ['an expiring quarantine', { kind: 'quarantine', reason_code: 'malware', expires_at: LATER }],
      ['a quarantine without the malware reason', { kind: 'quarantine' }],
      ['an expiry before creation', { expires_at: '2026-10-01T00:00:00.000Z' }],
      ['a malformed expiry', { expires_at: '2026-12-01 00:00:00' }],
      [
        'a malformed creation time',
        { created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' },
      ],
      ['an update before creation', { updated_at: '2026-10-01T00:00:00.000Z' }],
      ['a disable without a reason', { disabled_at: LATER }],
      ['a disable reason without a disable', { disabled_reason: 'other' }],
      ['an unknown disable reason', { disabled_at: LATER, disabled_reason: 'because' }],
      ['an empty package key', { package_key: '' }],
      ['an oversized package key', { package_key: 'a'.repeat(513) }],
      ['a malformed incident id', { incident_id: 'incident' }],
      ['revision zero', { revision: 0 }],
    ])('rejects %s with a check', async (_label, overrides) => {
      await withDatabase(async (executor) => {
        expect(await kind(insertRule(executor, overrides))).toBe('check');
      });
    });

    it('rejects a project of another organization, a missing organization and foreign members', async () => {
      await withDatabase(async (executor) => {
        expect(await kind(insertRule(executor, { project_id: 'foreign-project' }))).toBe(
          'foreign_key',
        );
        expect(await kind(insertRule(executor, { project_id: 'missing' }))).toBe('foreign_key');
        expect(await kind(insertRule(executor, { org_id: '01J0P0L1CY0000000000000009' }))).toBe(
          'foreign_key',
        );
        await insertRule(executor);
        await insertRule(executor, { id: 'rule-2', org_id: OTHER });
        expect(
          await kind(
            executor.all({
              sql: "INSERT INTO registry_policy_version (org_id, rule_id, version_normalized) VALUES (?, 'rule-1', '1.0.0')",
              params: [OTHER],
            }),
          ),
        ).toBe('foreign_key');
        expect(
          await kind(
            executor.all({
              sql: "INSERT INTO registry_policy_version (org_id, rule_id, version_normalized) VALUES (?, 'missing', '1.0.0')",
              params: [ORG],
            }),
          ),
        ).toBe('foreign_key');
        expect(
          await kind(
            executor.all({
              sql: "INSERT INTO registry_policy_version (org_id, rule_id, version_normalized) VALUES (?, 'rule-1', '')",
              params: [ORG],
            }),
          ),
        ).toBe('check');
        await executor.all({
          sql: "INSERT INTO registry_policy_version (org_id, rule_id, version_normalized) VALUES (?, 'rule-1', '1.0.0')",
          params: [ORG],
        });
        expect(
          await kind(
            executor.all({
              sql: "INSERT INTO registry_policy_version (org_id, rule_id, version_normalized) VALUES (?, 'rule-1', '1.0.0')",
              params: [ORG],
            }),
          ),
        ).toBe('unique');
        expect(
          await kind(
            executor.all({
              sql: 'DELETE FROM registry_policy_rule WHERE id = ?',
              params: ['rule-1'],
            }),
          ),
        ).toBe('foreign_key');
      });
    });

    it('upgrades a populated 0007 database and a rerun applies nothing', async () => {
      const opened = await open();
      try {
        const sources = await discoveredMigrations();
        const index = sources.findIndex(({ id }) => id === 'core:0008_registry_policy');
        expect(index).toBeGreaterThan(0);
        const throughPolicy = sources.slice(0, index + 1);
        await migrate(opened.executor, sources.slice(0, index), { holder: 'policy-baseline' });
        await dropDuplicateOrganizationGuard(opened.executor);
        await seed(opened.executor);
        const before = await opened.executor.all({
          sql: 'SELECT id, org_id FROM project ORDER BY id',
          params: [],
        });
        expect(
          (await migrate(opened.executor, throughPolicy, { holder: 'policy-upgrade' })).applied,
        ).toEqual(['core:0008_registry_policy']);
        expect(
          await opened.executor.all({
            sql: 'SELECT id, org_id FROM project ORDER BY id',
            params: [],
          }),
        ).toEqual(before);
        expect(
          await opened.executor.all({
            sql: 'SELECT count(*) AS n FROM registry_policy_rule',
            params: [],
          }),
        ).toEqual([{ n: 0 }]);
        expect(
          (await migrate(opened.executor, throughPolicy, { holder: 'policy-rerun' })).applied,
        ).toEqual([]);
      } finally {
        await opened.close();
      }
    });
  });
}

/** Statement limits and frozen history; independent of the database adapter. */
export function describePolicyMigrationSource(): void {
  describe('registry policy migration source', () => {
    it('is an expand migration within D1 statement and parameter limits', async () => {
      const source = (await discoveredMigrations()).find(
        ({ id }) => id === 'core:0008_registry_policy',
      );
      expect(source?.phase).toBe('expand');
      const statements = splitStatements(source!.sql);
      expect(statements.filter((sql) => sql.startsWith('CREATE TABLE '))).toHaveLength(2);
      expect(statements.filter((sql) => sql.startsWith('CREATE INDEX '))).toHaveLength(2);
      expect(statements).toHaveLength(4);
      expect(statements.every((sql) => Buffer.byteLength(sql) <= 100_000)).toBe(true);
      expect(
        statements.every((sql) =>
          scanSql(sql)
            .filter((segment) => segment.kind === 'code')
            .every((segment) => !/[?:@$]/.test(segment.text)),
        ),
      ).toBe(true);
    });

    it('leaves the frozen migrations byte for byte unchanged', () => {
      for (const [file, digest] of Object.entries(FROZEN)) {
        const bytes = readFileSync(new URL(`../../migrations/${file}`, import.meta.url));
        expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(digest);
      }
    });
  });
}
