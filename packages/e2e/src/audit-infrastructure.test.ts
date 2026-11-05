import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { deliveryInfrastructure } from './audit-delivery-fixture.js';
import { repository } from './local.js';
import type { LocalBroker, SqlPort } from './local.js';

it('uses exact launcher controls with restored.sqlite and concurrent empty-token brokers present', async () => {
  const directory = await mkdtemp(join(repository, '.pb/audit-control-'));
  const backup = new DatabaseSync(join(directory, 'restored.sqlite'));
  const first = new DatabaseSync(join(directory, 'first.sqlite'));
  const second = new DatabaseSync(join(directory, 'second.sqlite'));
  const broker = (db: DatabaseSync, path: string) => {
    const sql: SqlPort = {
      async run(statement, params) {
        db.prepare(statement).run(...params);
      },
      async all<T extends Record<string, unknown>>(
        statement: string,
        params: (string | number | null)[],
      ) {
        return db.prepare(statement).all(...params) as T[];
      },
    };
    return {
      setupToken: '',
      databaseControl: { path, orgId: 'org', sql },
      async tick() {},
      async read<T extends Record<string, unknown>>(
        statement: string,
        params: (string | number)[] = [],
      ) {
        return db.prepare(statement).all(...params) as T[];
      },
    } satisfies Pick<LocalBroker, 'setupToken' | 'databaseControl' | 'tick' | 'read'>;
  };
  try {
    for (const db of [backup, first, second]) {
      db.exec(`CREATE TABLE job_schedule (org_id TEXT, next_run_at TEXT);
        INSERT INTO job_schedule VALUES ('org', 'before'), ('foreign', 'before');
        CREATE TABLE job (id TEXT, org_id TEXT, type TEXT, resource_key TEXT, state TEXT);
        CREATE TABLE audit_sink (org_id TEXT, sink_id TEXT, next_attempt_at TEXT);
        INSERT INTO audit_sink VALUES ('org', 'webhook', 'before'), ('foreign', 'webhook', 'before');`);
    }
    const [a, b] = await Promise.all([
      deliveryInfrastructure(broker(first, join(directory, 'first.sqlite')), 'org'),
      deliveryInfrastructure(broker(second, join(directory, 'second.sqlite')), 'org'),
    ]);
    await a.due('webhook');
    await b.enqueue('export-otlp');
    expect(first.prepare('SELECT * FROM audit_sink ORDER BY org_id').all()).toEqual([
      { org_id: 'foreign', sink_id: 'webhook', next_attempt_at: 'before' },
      { org_id: 'org', sink_id: 'webhook', next_attempt_at: null },
    ]);
    expect(
      second.prepare("SELECT next_attempt_at FROM audit_sink WHERE org_id = 'org'").get(),
    ).toEqual({ next_attempt_at: 'before' });
    expect(first.prepare('SELECT id FROM job').all()).toEqual([]);
    expect(second.prepare('SELECT org_id, type, resource_key FROM job').all()).toEqual([
      { org_id: 'org', type: 'core:audit-export-otlp:v1', resource_key: 'audit-export:otlp' },
    ]);
    expect(backup.prepare('SELECT next_run_at FROM job_schedule').all()).toEqual([
      { next_run_at: 'before' },
      { next_run_at: 'before' },
    ]);
    await expect(deliveryInfrastructure(broker(first, 'unused'), 'foreign')).rejects.toThrow(
      'ForeignDeliveryOrganization',
    );
  } finally {
    for (const db of [backup, first, second]) db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
