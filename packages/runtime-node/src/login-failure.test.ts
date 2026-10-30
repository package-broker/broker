import { expect, it, vi } from 'vitest';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { ulid } from '@package-broker/core/ids';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createNodeServer, type NodeServerOptions } from './index.js';
import { SEAMS_KEY } from './internal/seams-key.js';

const ORIGIN = 'https://broker.test';

it.each([false, true])(
  'drains background login staging before database close (timeout: %s)',
  async (timeout) => {
    const database = await openMigratedDatabase();
    const org = await createOrganizationBootstrap(database.executor).bootstrap({
      id: ulid(),
      slug: 'test',
      name: 'Test',
      now: new Date().toISOString(),
    });
    let release!: () => void;
    let started!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stagingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished!: () => void;
    const stagingFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const order: string[] = [];
    const log = vi.fn();
    const closeDatabase = vi.fn(async () => {
      order.push('close');
    });
    const options: NodeServerOptions & { [SEAMS_KEY]: { shutdownDeadlineMs: number } } = {
      [SEAMS_KEY]: { shutdownDeadlineMs: timeout ? 150 : 10_000 },
      executor: {
        ...database.executor,
        async batch(statements) {
          if (statements.some((statement) => statement.sql.includes('audit_pending'))) {
            started();
            await hold;
          }
          const result = await database.executor.batch(statements);
          if (statements.some((statement) => statement.sql.includes('audit_pending'))) {
            order.push('batch');
            finished();
          }
          return result;
        },
      },
      auth: {
        keyring: createKeyring([
          parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
        ]),
        publicOrigin: ORIGIN,
        env: {},
      },
      log,
      closeDatabase,
    };
    const broker = createNodeServer([], options);
    try {
      const kernel = await broker.ready();
      const request = () =>
        new Request(`${ORIGIN}/_pb/auth/local/login`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'unknown@example.test',
            password: 'private password',
            code: '123456',
          }),
        });
      const first = await kernel.fetch(request());
      expect(first.status).toBe(401);
      await stagingStarted;
      expect((await kernel.fetch(request())).status).toBe(401);
      const closing = broker.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeDatabase).not.toHaveBeenCalled();
      if (timeout) {
        await closing;
        expect(log).toHaveBeenCalledWith({
          level: 'warn',
          event: 'shutdown.failure_events_drain_timeout',
        });
        expect(order).toEqual(['close']);
      }
      release();
      await closing;
      if (!timeout) expect(order).toEqual(['batch', 'close']);
      // The timeout deliberately allows shutdown to proceed; finish the held write for cleanup.
      await stagingFinished;
      expect(closeDatabase).toHaveBeenCalledExactlyOnceWith();
      const rows = await database.executor.all<{
        actor_type: string;
        actor_id: string | null;
        payload_json: string;
      }>({
        sql: "SELECT actor_type, actor_id, payload_json FROM audit_pending WHERE org_id = ? AND action = 'session.login_failed'",
        params: [org.id],
      });
      // Repeated requests share the recorder's limiter.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_type: 'system', actor_id: null });
      for (const secret of ['unknown@example.test', 'private password', '123456'])
        expect(JSON.stringify(rows)).not.toContain(secret);
    } finally {
      release();
      await broker.close();
      await database.close();
    }
  },
);
