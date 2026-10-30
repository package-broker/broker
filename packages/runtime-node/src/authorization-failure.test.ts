import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
import { ulid } from '@package-broker/core/ids';
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '@package-broker/core/plugin';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createNodeServer } from './index.js';

it('records real kernel permission refusals through the shared runtime recorder', async () => {
  const database = await openMigratedDatabase();
  const now = new Date().toISOString();
  const org = await createOrganizationBootstrap(database.executor).bootstrap({
    id: ulid(),
    slug: 'test',
    name: 'Test',
    now,
  });
  const userId = ulid();
  const secret = 'A'.repeat(43);
  await database.executor.batch([
    {
      sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      params: [userId, org.id, 'member@example.test'],
    },
    {
      sql: 'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [
        ulid(),
        org.id,
        userId,
        createHash('sha256').update(secret).digest('hex'),
        '0'.repeat(64),
        now,
        new Date(Date.now() + 60_000).toISOString(),
      ],
    },
  ]);
  const template = '/probe/denied/:name';
  const plugin: PluginDefinition = {
    id: 'probe',
    package: '@test/probe',
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['node'],
    register(registry) {
      registry.route({
        method: 'GET',
        path: template,
        permission: 'org:settings:write',
        boundary: 'organization',
        handler: () => {
          throw new Error('denied handler reached');
        },
      });
    },
  };
  const broker = createNodeServer([plugin], {
    executor: database.executor,
    auth: {
      keyring: createKeyring([
        parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
      ]),
      publicOrigin: 'https://broker.test',
      env: {},
    },
    log: () => undefined,
  });
  try {
    const kernel = await broker.ready();
    for (let i = 0; i < 2; i++) {
      const response = await kernel.fetch(
        new Request('https://broker.test/probe/denied/private-name?secret=private', {
          headers: { cookie: `${SESSION_COOKIE}=${secret}` },
        }),
      );
      expect(response.status).toBe(403);
    }
    await broker.close();
    const rows = await database.executor.all<{
      actor_type: string;
      actor_id: string;
      target_id: string;
      payload_json: string;
    }>({
      sql: "SELECT actor_type, actor_id, target_id, payload_json FROM audit_pending WHERE org_id = ? AND action = 'access.denied'",
      params: [org.id],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'user', actor_id: userId, target_id: template });
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      changes: {
        permission: { new: 'org:settings:write' },
        boundary: { new: 'organization' },
        count: { new: 1 },
      },
    });
    expect(JSON.stringify(rows)).not.toMatch(/private-name|secret|member@example/);
  } finally {
    await broker.close();
    await database.close();
  }
});
