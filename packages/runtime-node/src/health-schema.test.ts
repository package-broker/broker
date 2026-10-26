import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import { startNode } from './startup.js';
import type { NodeBroker } from './index.js';

const handlers = vi.hoisted(() => ({
  captured: [] as Array<(request: Request) => Response | Promise<Response>>,
}));
vi.mock('@hono/node-server', async (original) => {
  const actual = await original<typeof import('@hono/node-server')>();
  return {
    ...actual,
    getRequestListener: (...args: Parameters<typeof actual.getRequestListener>) => {
      handlers.captured.push(args[0] as (request: Request) => Response | Promise<Response>);
      return actual.getRequestListener(...args);
    },
  };
});

it('wires the bundled migrations through Node startup and readiness without blocking serving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-health-schema-'));
  const path = join(directory, 'broker.sqlite');
  const migrations = await discoveredMigrations();
  const env = {
    PB_SQLITE_PATH: path,
    PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    PB_PUBLIC_URL: 'http://127.0.0.1',
  };
  const events: unknown[] = [];
  let broker: NodeBroker | undefined;
  let opened: ReturnType<typeof openBetterSqliteExecutor> | undefined;
  try {
    broker = await startNode({
      plugins: [],
      migrations,
      env: { ...env, PB_ORG_SLUG: 'acme', PB_ORG_NAME: 'Acme' },
      log: () => undefined,
    });
    const healthy = await handlers.captured.at(-1)!(
      new Request(`${env.PB_PUBLIC_URL}/health/ready`),
    );
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ status: 'ready' });
    await broker.close();
    broker = undefined;

    opened = openBetterSqliteExecutor(path);
    await opened.executor.all({
      sql: 'UPDATE schema_migration SET checksum = ? WHERE id = ?',
      params: ['0'.repeat(64), migrations[0]!.id],
    });
    broker = await startNode({
      plugins: [],
      migrations,
      env: { ...env, PB_MIGRATE: 'off' },
      log: (event) => {
        events.push(event);
      },
    });
    const handler = handlers.captured.at(-1)!;
    const request = (pathname: string, method = 'GET') =>
      handler(new Request(`${env.PB_PUBLIC_URL}${pathname}`, { method }));
    const drift = await request('/health/ready');
    expect(drift.status).toBe(503);
    expect(await drift.json()).toEqual({ status: 'not_ready', reason: 'schema_drift' });
    const head = await request('/health/ready', 'HEAD');
    expect(head.status).toBe(503);
    expect(await head.text()).toBe('');
    const live = await request('/health/live');
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'live' });
    expect((await request('/_pb/openapi.json')).status).toBe(200);

    await opened.executor.all({ sql: 'DROP TABLE schema_migration', params: [] });
    const missing = await request('/health/ready');
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ status: 'not_ready', reason: 'schema_drift' });
    await opened.executor.all({
      sql: 'CREATE TABLE schema_migration (id TEXT PRIMARY KEY)',
      params: [],
    });
    const readFailure = await request('/health/ready');
    expect(readFailure.status).toBe(503);
    expect(await readFailure.json()).toHaveProperty('error.code', 'not_ready');
    expect(events).toContainEqual(expect.objectContaining({ event: 'http.error' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'health.schema_drift' }));
    await opened.executor.all({ sql: 'DROP TABLE schema_migration', params: [] });
    await opened.executor.batch([
      { sql: 'CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT)', params: [] },
      {
        sql: 'INSERT INTO schema_migration (id, checksum) VALUES (?, ?)',
        params: ['future:0001_init', 'future-checksum'],
      },
      ...migrations.map(({ id, checksum }) => ({
        sql: 'INSERT INTO schema_migration (id, checksum) VALUES (?, ?)',
        params: [id, checksum],
      })),
    ]);
    const recovered = await request('/health/ready');
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ status: 'ready' });
    expect(JSON.stringify(events)).not.toContain('0'.repeat(64));
    for (const { id, checksum } of migrations) {
      expect(JSON.stringify(events)).not.toContain(id);
      expect(JSON.stringify(events)).not.toContain(checksum);
    }
  } finally {
    await broker?.close();
    await opened?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
