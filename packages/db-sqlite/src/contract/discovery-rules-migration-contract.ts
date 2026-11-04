import { describe, expect, it } from 'vitest';
import type { ScalarSqlExecutor, ScalarSqlValue } from '@package-broker/core/db/port';
import { migrate } from '../migrations/runner.js';
import { discoveredMigrations } from '../testing/migrated-database.js';

interface OpenedDatabase {
  readonly executor: ScalarSqlExecutor;
  close(): Promise<void>;
}

const MIGRATION = 'core:0010_source_discovery_rules';
const RULE = {
  org_id: 'org',
  id: 'rule',
  name: 'Libraries',
  credential_id: 'credential',
  installation_id: 123,
  ecosystem: 'both',
  repository_pattern: '*',
  created_at: '2026-11-01T12:00:00.000Z',
  updated_at: '2026-11-01T12:00:00.000Z',
};
const FROZEN = {
  'core:0001_init': 'a1005fb24893ffe9174ae1f1642b3f1270d853476183a47ce2b5e4d32471e2fb',
  'core:0002_npm_publish': '1beaf4be82bc086b014d5999d85e37b2ead8b04acc5db98d6720d08d5d5368cb',
  'core:0003_npm_identity': '1b7ee8616cdbf062cea7fd10458b8df9739cb19323ce765f2f2b3068552288fa',
  'core:0004_source_revision': '9971e927c07c1b2e1ff7da3f73b4673b19c80be48329a35fc23def5a95aee6ed',
  'core:0005_package_settings_revision':
    'ed867ced9882400ec2e51bd9cdd1100426470d130091b4a8e95ff0bdd025c2cb',
  'core:0006_npm_login_handoff': 'e1140895bb8b68e2b05054dc814d50e71ab1cf745638739310266a43dbe26117',
  'core:0007_npm_vcs_build_outcomes':
    'f8434d0e092809b35c472a2f1ba1b317836415694e909f929df3e6559f2e7891',
  'core:0008_registry_policy': '9ba4c9df12b3b17decaea7a7c3ed41222dbb6ffba0af1b53a054e3a6b48d72cc',
  'core:0009_npm_notifications': '454ba1748f98b35909db6003b73cad587de21ffb34e37d1991d62a8373ae4f09',
};

async function insert(executor: ScalarSqlExecutor, values: Record<string, ScalarSqlValue>) {
  const columns = Object.keys(values);
  return executor.all({
    sql: `INSERT INTO source_discovery_rule (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    params: Object.values(values),
  });
}

export function describeDiscoveryRulesMigrationContract(
  name: string,
  open: () => Promise<OpenedDatabase>,
) {
  async function database(body: (executor: ScalarSqlExecutor) => Promise<void>) {
    const opened = await open();
    try {
      await migrate(opened.executor, await discoveredMigrations(), { holder: 'discovery-rules' });
      await opened.executor.all({
        sql: "INSERT INTO organization(id,slug,name) VALUES('org','org','Org')",
        params: [],
      });
      await opened.executor.all({
        sql: "INSERT INTO credential(id,org_id,kind,ciphertext,nonce,key_version,aad) VALUES('credential','org','github_app',x'00',zeroblob(12),1,'aad')",
        params: [],
      });
      await body(opened.executor);
    } finally {
      await opened.close();
    }
  }

  describe(`discovery rules migration: ${name}`, () => {
    it('adds an expand migration after the frozen baseline', async () => {
      const sources = await discoveredMigrations();
      expect(sources.at(-1)?.id).toBe(MIGRATION);
      expect(sources.at(-1)?.phase).toBe('expand');
      expect(
        Object.fromEntries(sources.slice(0, -1).map((source) => [source.id, source.checksum])),
      ).toEqual(FROZEN);
    });

    it('defaults to daily scans with bounded empty last-run and checkpoint state', async () =>
      database(async (executor) => {
        await insert(executor, RULE);
        expect(
          await executor.all({
            sql: 'SELECT revision,include_forks,enabled,rescan_interval_seconds,last_run_outcome,created_count,existing_count,skipped_count,failed_count,skip_details_json,remaining_repositories_json,plan_cursor FROM source_discovery_rule WHERE org_id=?',
            params: ['org'],
          }),
        ).toEqual([
          {
            revision: 1,
            include_forks: 0,
            enabled: 1,
            rescan_interval_seconds: 86400,
            last_run_outcome: null,
            created_count: 0,
            existing_count: 0,
            skipped_count: 0,
            failed_count: 0,
            skip_details_json: '[]',
            remaining_repositories_json: '[]',
            plan_cursor: null,
          },
        ]);
      }));

    it.each(
      [
        { revision: 0 },
        { name: ' padded' },
        { name: 'padded ' },
        { name: '' },
        { name: 'bad\nname' },
        { name: 'bad\u0000name' },
        { name: 'bad\u007fname' },
        { name: 'x'.repeat(81) },
        { ecosystem: 'ruby' },
        { include_forks: 2 },
        { enabled: -1 },
        { installation_id: 0 },
        { rescan_interval_seconds: 3599 },
        { rescan_interval_seconds: 2592001 },
        { repository_pattern: '' },
        { repository_pattern: 'x'.repeat(101) },
        { repository_pattern: 'owner/repo' },
        { plan_cursor: '' },
        { plan_cursor: '0' },
        { plan_cursor: '0001' },
        { plan_cursor: '1000000' },
        { plan_cursor: 'cursor' },
        { created_count: -1 },
        { existing_count: -1 },
        { skipped_count: -1 },
        { failed_count: -1 },
        { last_run_outcome: 'unknown' },
        { skip_details_json: '{}' },
        { skip_details_json: '[' },
        { skip_details_json: JSON.stringify(['x'.repeat(16384)]) },
        { skip_details_json: JSON.stringify(Array.from({ length: 51 }, () => ({}))) },
        { remaining_repositories_json: '{}' },
        { remaining_repositories_json: '[' },
        { remaining_repositories_json: JSON.stringify(['x'.repeat(8192)]) },
        {
          remaining_repositories_json: JSON.stringify(
            Array.from({ length: 50 }, () => 'owner/repo'),
          ),
        },
      ].map((overrides, index) => ({
        name: `${Object.keys(overrides)[0]} (${index + 1})`,
        overrides,
      })),
    )('rejects invalid bounded state $name', async ({ overrides }) =>
      database(async (executor) => {
        await expect(insert(executor, { ...RULE, ...overrides })).rejects.toMatchObject({
          kind: 'check',
        });
        expect(
          await executor.all({
            sql: 'SELECT id FROM source_discovery_rule WHERE org_id=?',
            params: ['org'],
          }),
        ).toEqual([]);
      }),
    );

    it('rejects an installation id outside JavaScript safe integers at the SQL boundary', async () =>
      database(async (executor) => {
        await insert(executor, RULE);
        await expect(
          executor.all({
            sql: 'UPDATE source_discovery_rule SET installation_id=9007199254740992 WHERE org_id=? AND id=?',
            params: ['org', 'rule'],
          }),
        ).rejects.toMatchObject({ kind: 'check' });
        expect(
          await executor.all({
            sql: 'SELECT installation_id FROM source_discovery_rule WHERE org_id=? AND id=?',
            params: ['org', 'rule'],
          }),
        ).toEqual([{ installation_id: 123 }]);
      }));

    it('rejects a credential owned by another organization', async () =>
      database(async (executor) => {
        await executor.all({ sql: 'DROP INDEX organization_singleton', params: [] });
        await executor.all({
          sql: "INSERT INTO organization(id,slug,name) VALUES('other','other','Other')",
          params: [],
        });
        await expect(insert(executor, { ...RULE, org_id: 'other' })).rejects.toMatchObject({
          kind: 'foreign_key',
        });
      }));

    it('allows both interval bounds and a full checkpoint and capped skip list', async () =>
      database(async (executor) => {
        for (const interval of [3600, 2592000]) {
          await insert(executor, {
            ...RULE,
            id: `rule-${interval}`,
            name: `Rule ${interval}`,
            rescan_interval_seconds: interval,
            include_forks: 1,
            enabled: 0,
            plan_cursor: '999999',
            remaining_repositories_json: JSON.stringify(
              Array.from({ length: 49 }, (_, i) => `owner/repo-${i}`),
            ),
            skip_details_json: JSON.stringify(
              Array.from({ length: 50 }, (_, i) => ({
                repository: `owner/repo-${i}`,
                reason: 'fork',
              })),
            ),
          });
        }
        expect(
          await executor.all({
            sql: 'SELECT rescan_interval_seconds FROM source_discovery_rule WHERE org_id=? ORDER BY rescan_interval_seconds',
            params: ['org'],
          }),
        ).toEqual([{ rescan_interval_seconds: 3600 }, { rescan_interval_seconds: 2592000 }]);
      }));

    it('uses strict storage and an organization-first due index', async () =>
      database(async (executor) => {
        expect(
          await executor.all({
            sql: "SELECT strict FROM pragma_table_list WHERE name='source_discovery_rule'",
            params: [],
          }),
        ).toEqual([{ strict: 1 }]);
        expect(
          await executor.all({
            sql: "SELECT name FROM pragma_index_info('source_discovery_rule_due') ORDER BY seqno",
            params: [],
          }),
        ).toEqual(['org_id', 'enabled', 'next_run_at', 'id'].map((name) => ({ name })));
      }));

    it('keeps rule names unique within an organization', async () =>
      database(async (executor) => {
        await insert(executor, RULE);
        await expect(insert(executor, { ...RULE, id: 'second' })).rejects.toMatchObject({
          kind: 'unique',
        });
        expect(
          await executor.all({
            sql: 'SELECT id FROM source_discovery_rule WHERE org_id=?',
            params: ['org'],
          }),
        ).toEqual([{ id: 'rule' }]);
      }));

    it('deleting a rule preserves sources and its credential', async () =>
      database(async (executor) => {
        await insert(executor, RULE);
        await executor.all({
          sql: "INSERT INTO source(id,org_id,name,type,ecosystem,credential_id,config_json) VALUES('source','org','library','vcs','npm','credential','{}')",
          params: [],
        });
        const before = await executor.all({
          sql: 'SELECT * FROM source WHERE org_id=?',
          params: ['org'],
        });
        await executor.all({
          sql: 'DELETE FROM source_discovery_rule WHERE org_id=? AND id=?',
          params: ['org', 'rule'],
        });
        expect(
          await executor.all({ sql: 'SELECT * FROM source WHERE org_id=?', params: ['org'] }),
        ).toEqual(before);
        expect(
          await executor.all({ sql: 'SELECT id FROM credential WHERE org_id=?', params: ['org'] }),
        ).toEqual([{ id: 'credential' }]);
        expect(
          await executor.all({
            sql: 'SELECT id FROM source_discovery_rule WHERE org_id=?',
            params: ['org'],
          }),
        ).toEqual([]);
      }));

    it('upgrades a populated database without changing old rows and skips on rerun', async () => {
      const opened = await open();
      try {
        const sources = await discoveredMigrations();
        await migrate(
          opened.executor,
          sources.filter((source) => source.id !== MIGRATION),
          { holder: 'baseline' },
        );
        await opened.executor.all({
          sql: "INSERT INTO organization(id,slug,name) VALUES('org','org','Org')",
          params: [],
        });
        const before = await opened.executor.all({ sql: 'SELECT * FROM organization', params: [] });
        expect((await migrate(opened.executor, sources, { holder: 'upgrade' })).applied).toEqual([
          MIGRATION,
        ]);
        expect(
          await opened.executor.all({ sql: 'SELECT * FROM organization', params: [] }),
        ).toEqual(before);
        expect((await migrate(opened.executor, sources, { holder: 'rerun' })).applied).toEqual([]);
      } finally {
        await opened.close();
      }
    });
  });
}
