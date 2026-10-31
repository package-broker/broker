import { describe, expect, it } from 'vitest';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import { migrate } from '../migrations/runner.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import type { OpenedPair } from './migration-contract.js';

const EXPIRES = '2026-11-01T00:00:00.000Z';

async function seed(executor: ScalarSqlExecutor) {
  await executor.batch([
    { sql: "INSERT INTO organization (id, slug, name) VALUES ('org', 'test', 'Test')", params: [] },
    {
      sql: "INSERT INTO user_account (id, org_id, email) VALUES ('user', 'org', 'test@example.test')",
      params: [],
    },
    {
      sql: "INSERT INTO project (id, org_id, slug, name) VALUES ('project', 'org', 'test', 'Test')",
      params: [],
    },
    {
      sql: "INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES ('principal', 'org', 'test', 'user')",
      params: [],
    },
    {
      sql: "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at) VALUES ('token', 'org', 'pat', 'abcdefghijkl', ?, 1, 'test', '[]', 'user', '2026-11-01T00:00:00.000Z')",
      params: ['a'.repeat(64)],
    },
  ]);
}

async function publisher(
  executor: ScalarSqlExecutor,
  id = 'publisher',
  org = 'org',
  environment = '',
) {
  await executor.all({
    sql: `INSERT INTO trusted_publisher (id, org_id, package_name, repository_id, repository_owner_id, repository, workflow, environment, service_principal_id, created_by_user_id)
          VALUES (?, ?, 'test', '123', '456', 'owner/repo', 'publish.yml', ?, 'principal', 'user')`,
    params: [id, org, environment],
  });
}

async function login(
  executor: ScalarSqlExecutor,
  id = 'login',
  selector = 'a'.repeat(64),
  done = 'b'.repeat(64),
) {
  await executor.all({
    sql: 'INSERT INTO npm_login_session (id, org_id, project_id, selector_hash, done_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    params: [id, 'org', 'project', selector, done, EXPIRES],
  });
}

export function describeNpmIdentityMigrationContract(
  name: string,
  open: () => Promise<OpenedPair>,
): void {
  async function withDatabase(body: (executor: ScalarSqlExecutor) => Promise<void>) {
    const opened = await open();
    try {
      await migrate(opened.executor, await discoveredMigrations(), { holder: 'npm-identity' });
      await seed(opened.executor);
      await body(opened.executor);
    } finally {
      await opened.close();
    }
  }

  describe(`npm identity migration: ${name}`, () => {
    for (const baseline of [1, 2]) {
      it(`upgrades baseline ${baseline} preserving existing token rows and migration checksums; rerun skips`, async () => {
        const opened = await open();
        try {
          const sources = await discoveredMigrations();
          expect(sources.map((source) => source.id)).toEqual([
            'core:0001_init',
            'core:0002_npm_publish',
            'core:0003_npm_identity',
          ]);
          await migrate(opened.executor, sources.slice(0, baseline), { holder: 'baseline' });
          await seed(opened.executor);
          const before = await opened.executor.all({
            sql: 'SELECT * FROM token WHERE org_id = ?',
            params: ['org'],
          });
          const ledger = await opened.executor.all({
            sql: 'SELECT * FROM schema_migration ORDER BY id',
            params: [],
          });
          expect((await migrate(opened.executor, sources, { holder: 'upgrade' })).applied).toEqual(
            sources.slice(baseline).map((source) => source.id),
          );
          expect(
            await opened.executor.all({
              sql: 'SELECT token.* FROM token WHERE org_id = ?',
              params: ['org'],
            }),
          ).toEqual(
            before.map((row) => ({ ...row, trusted_publisher_id: null, package_name: null })),
          );
          expect(
            (
              await opened.executor.all({
                sql: 'SELECT * FROM schema_migration ORDER BY id',
                params: [],
              })
            ).slice(0, baseline),
          ).toEqual(ledger);
          expect((await migrate(opened.executor, sources, { holder: 'rerun' })).applied).toEqual(
            [],
          );
          expect(
            await opened.executor.all({ sql: 'PRAGMA foreign_key_check', params: [] }),
          ).toEqual([]);
        } finally {
          await opened.close();
        }
      });
    }
    it('round trips login, publisher, replay and package-bound token fields', async () => {
      await withDatabase(async (executor) => {
        await publisher(executor);
        await login(executor);
        expect(
          await executor.all({
            sql: 'SELECT state, user_id, token_id, token_ciphertext, token_nonce, token_key_version, consumed_at FROM npm_login_session WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([
          {
            state: 'pending',
            user_id: null,
            token_id: null,
            token_ciphertext: null,
            token_nonce: null,
            token_key_version: null,
            consumed_at: null,
          },
        ]);
        await executor.all({
          sql: "UPDATE npm_login_session SET state = 'approved', user_id = 'user', token_id = 'token', token_ciphertext = ?, token_nonce = ?, token_key_version = ? WHERE org_id = ?",
          params: ['sealed', 'nonce', 1, 'org'],
        });
        expect(
          await executor.all({
            sql: 'SELECT state, token_ciphertext, token_nonce, token_key_version FROM npm_login_session WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([
          {
            state: 'approved',
            token_ciphertext: 'sealed',
            token_nonce: 'nonce',
            token_key_version: 1,
          },
        ]);
        await executor.all({
          sql: "UPDATE npm_login_session SET state = 'consumed', token_ciphertext = NULL, token_nonce = NULL, token_key_version = NULL, consumed_at = ? WHERE org_id = ?",
          params: [EXPIRES, 'org'],
        });
        expect(
          await executor.all({
            sql: 'SELECT state, token_ciphertext, token_nonce, token_key_version, consumed_at FROM npm_login_session WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([
          {
            state: 'consumed',
            token_ciphertext: null,
            token_nonce: null,
            token_key_version: null,
            consumed_at: EXPIRES,
          },
        ]);
        expect(
          await executor.all({
            sql: 'SELECT environment, revision, disabled_at, last_used_at FROM trusted_publisher WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([{ environment: '', revision: 1, disabled_at: null, last_used_at: null }]);
        await executor.all({
          sql: 'UPDATE token SET trusted_publisher_id = ?, package_name = ? WHERE id = ? AND org_id = ?',
          params: ['publisher', 'test', 'token', 'org'],
        });
        expect(
          await executor.all({
            sql: 'SELECT trusted_publisher_id, package_name FROM token WHERE id = ? AND org_id = ?',
            params: ['token', 'org'],
          }),
        ).toEqual([{ trusted_publisher_id: 'publisher', package_name: 'test' }]);
        await executor.all({
          sql: 'INSERT INTO oidc_replay (issuer, jti, org_id, trusted_publisher_id, expires_at) VALUES (?, ?, ?, ?, ?)',
          params: ['issuer', 'jti', 'org', 'publisher', EXPIRES],
        });
        expect(
          await executor.all({
            sql: 'SELECT issuer, jti, expires_at FROM oidc_replay WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([{ issuer: 'issuer', jti: 'jti', expires_at: EXPIRES }]);
      });
    });
    it('stores the sealed token in three nullable columns without an envelope', async () => {
      await withDatabase(async (executor) => {
        const rows = await executor.all<{ name: string; type: string; notnull: number }>({
          sql: "SELECT name, type, \"notnull\" FROM pragma_table_info('npm_login_session') WHERE name IN ('sealed_token', 'token_ciphertext', 'token_nonce', 'token_key_version') ORDER BY cid",
          params: [],
        });
        expect(rows).toEqual([
          { name: 'token_ciphertext', type: 'TEXT', notnull: 0 },
          { name: 'token_nonce', type: 'TEXT', notnull: 0 },
          { name: 'token_key_version', type: 'INTEGER', notnull: 0 },
        ]);
      });
    });
    it('deletes a publisher with issued tokens and replay rows', async () => {
      await withDatabase(async (executor) => {
        await publisher(executor);
        await executor.all({
          sql: "UPDATE token SET trusted_publisher_id = 'publisher', package_name = 'test', revoked_at = ? WHERE org_id = 'org'",
          params: [EXPIRES],
        });
        await executor.all({
          sql: "INSERT INTO oidc_replay (issuer, jti, org_id, trusted_publisher_id, expires_at) VALUES ('issuer', 'jti', 'org', 'publisher', ?)",
          params: [EXPIRES],
        });
        await executor.all({
          sql: "DELETE FROM trusted_publisher WHERE id = 'publisher' AND org_id = 'org'",
          params: [],
        });
        expect(
          await executor.all({
            sql: "SELECT trusted_publisher_id, package_name, revoked_at FROM token WHERE org_id = 'org'",
            params: [],
          }),
        ).toEqual([{ trusted_publisher_id: null, package_name: 'test', revoked_at: EXPIRES }]);
        expect(
          await executor.all({ sql: "SELECT * FROM oidc_replay WHERE org_id = 'org'", params: [] }),
        ).toEqual([]);
        expect(await executor.all({ sql: 'PRAGMA foreign_key_check', params: [] })).toEqual([]);
      });
    });
    for (const column of ['selector_hash', 'done_hash']) {
      it(`refuses malformed ${column}`, async () => {
        await withDatabase(async (executor) => {
          await login(executor);
          for (const value of [
            '',
            'a'.repeat(63),
            'a'.repeat(65),
            'A'.repeat(64),
            'g'.repeat(64),
            'a'.repeat(63) + '\0',
            'é'.repeat(64),
          ]) {
            await expect(
              executor.all({
                sql: `UPDATE npm_login_session SET ${column} = ? WHERE org_id = 'org'`,
                params: [value],
              }),
            ).rejects.toMatchObject({ kind: 'check' });
          }
          await executor.all({
            sql: `UPDATE npm_login_session SET ${column} = ? WHERE org_id = 'org'`,
            params: ['0123456789abcdef'.repeat(4)],
          });
        });
      });
    }
    for (const [label, assignment] of [
      ['pending user', "user_id = 'user'"],
      ['pending token', "token_id = 'token'"],
      ['pending consumed_at', `consumed_at = '${EXPIRES}'`],
      [
        'approved missing user',
        "state = 'approved', token_id = 'token', token_ciphertext = 'cipher', token_nonce = 'nonce', token_key_version = 1",
      ],
      [
        'approved missing token',
        "state = 'approved', user_id = 'user', token_ciphertext = 'cipher', token_nonce = 'nonce', token_key_version = 1",
      ],
      ['approved missing seal', "state = 'approved', user_id = 'user', token_id = 'token'"],
      [
        'approved consumed_at',
        `state = 'approved', user_id = 'user', token_id = 'token', token_ciphertext = 'cipher', token_nonce = 'nonce', token_key_version = 1, consumed_at = '${EXPIRES}'`,
      ],
      ['consumed missing time', "state = 'consumed'"],
      [
        'consumed sealed token',
        `state = 'consumed', token_ciphertext = 'cipher', token_nonce = 'nonce', token_key_version = 1, consumed_at = '${EXPIRES}'`,
      ],
      [
        'pending sealed token',
        "token_ciphertext = 'cipher', token_nonce = 'nonce', token_key_version = 1",
      ],
    ]) {
      it(`refuses inconsistent login state: ${label}`, async () => {
        await withDatabase(async (executor) => {
          await login(executor);
          await expect(
            executor.all({
              sql: `UPDATE npm_login_session SET ${assignment} WHERE org_id = 'org'`,
              params: [],
            }),
          ).rejects.toMatchObject({ kind: 'check' });
        });
      });
    }
    for (const mask of [1, 2, 3, 4, 5, 6]) {
      it(`refuses partial sealed token ${mask}`, async () => {
        await withDatabase(async (executor) => {
          await login(executor);
          // Consumed rows otherwise permit NULL user/token links; isolate the seal shape guard.
          await expect(
            executor.all({
              sql: "UPDATE npm_login_session SET state = 'consumed', consumed_at = ?, token_ciphertext = ?, token_nonce = ?, token_key_version = ? WHERE org_id = 'org'",
              params: [
                EXPIRES,
                mask & 1 ? 'cipher' : null,
                mask & 2 ? 'nonce' : null,
                mask & 4 ? 1 : null,
              ],
            }),
          ).rejects.toMatchObject({ kind: 'check' });
        });
      });
    }
    for (const [table, column, cap] of [
      ['npm_login_session', 'cli_hostname', 253],
      ['npm_login_session', 'source_ip', 45],
      ['trusted_publisher', 'package_name', 214],
      ['token', 'package_name', 214],
      ['trusted_publisher', 'repository', 140],
      ['trusted_publisher', 'workflow', 255],
      ['trusted_publisher', 'environment', 255],
      ['trusted_publisher', 'ref_pattern', 255],
    ] as const) {
      it(`enforces byte cap on ${table}.${column}`, async () => {
        await withDatabase(async (executor) => {
          await publisher(executor);
          await login(executor);
          const update = (value: string) =>
            executor.all({
              sql: `UPDATE ${table} SET ${column} = ? WHERE org_id = 'org'`,
              params: [value],
            });
          await update('a'.repeat(cap));
          await update('é'.repeat(Math.floor(cap / 2)) + 'a'.repeat(cap % 2));
          await expect(update('a'.repeat(cap + 1))).rejects.toMatchObject({ kind: 'check' });
          await expect(update('é'.repeat(Math.floor(cap / 2) + 1))).rejects.toMatchObject({
            kind: 'check',
          });
        });
      });
      it(`enforces control rule on ${table}.${column}`, async () => {
        await withDatabase(async (executor) => {
          await publisher(executor);
          await login(executor);
          const update = (value: string) =>
            executor.all({
              sql: `UPDATE ${table} SET ${column} = ? WHERE org_id = 'org'`,
              params: [value],
            });
          await update('a\t\n\rb');
          for (const code of [
            0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
            27, 28, 29, 30, 31, 127,
          ]) {
            await expect(update('a' + String.fromCharCode(code) + 'b')).rejects.toMatchObject({
              kind: 'check',
            });
          }
        });
      });
    }
    for (const column of ['repository_id', 'repository_owner_id']) {
      it(`requires decimal digits in ${column}`, async () => {
        await withDatabase(async (executor) => {
          await publisher(executor);
          const update = (value: string) =>
            executor.all({
              sql: `UPDATE trusted_publisher SET ${column} = ? WHERE org_id = 'org'`,
              params: [value],
            });
          await update('012345678901234567890123456789');
          for (const value of ['', '123a', '-1', '+1', '1.0', '1e2', '１２３', '12\0', '12\n']) {
            await expect(update(value)).rejects.toMatchObject({ kind: 'check' });
          }
        });
      });
    }
    it('refuses duplicate browser and poll hashes independently', async () => {
      await withDatabase(async (executor) => {
        await login(executor);
        await expect(
          login(executor, 'duplicate', 'a'.repeat(64), 'c'.repeat(64)),
        ).rejects.toMatchObject({ kind: 'unique' });
        await expect(
          login(executor, 'duplicate', 'c'.repeat(64), 'b'.repeat(64)),
        ).rejects.toMatchObject({ kind: 'unique' });
        await login(executor, 'different', 'c'.repeat(64), 'd'.repeat(64));
      });
    });
    it('refuses duplicate publisher bindings but distinguishes environments', async () => {
      await withDatabase(async (executor) => {
        await publisher(executor);
        await expect(publisher(executor, 'duplicate')).rejects.toMatchObject({ kind: 'unique' });
        await publisher(executor, 'different', 'org', 'release');
      });
    });
    it('refuses replay of issuer and jti atomically while distinguishing issuers', async () => {
      await withDatabase(async (executor) => {
        await publisher(executor);
        const replay = {
          sql: 'INSERT INTO oidc_replay (issuer, jti, org_id, trusted_publisher_id, expires_at) VALUES (?, ?, ?, ?, ?)',
          params: ['issuer', 'jti', 'org', 'publisher', EXPIRES],
        };
        await executor.batch([replay]);
        await expect(
          executor.batch([
            {
              sql: "UPDATE token SET package_name = 'changed' WHERE id = 'token' AND org_id = 'org'",
              params: [],
            },
            replay,
          ]),
        ).rejects.toMatchObject({ kind: 'unique' });
        expect(
          await executor.all({
            sql: 'SELECT package_name FROM token WHERE org_id = ?',
            params: ['org'],
          }),
        ).toEqual([{ package_name: null }]);
        await executor.all({
          ...replay,
          params: ['other-issuer', 'jti', 'org', 'publisher', EXPIRES],
        });
      });
    });
    it('refuses cross-organization token publisher on insert', async () => {
      await withDatabase(async (executor) => {
        await publisher(executor);
        await executor.all({ sql: 'DROP INDEX organization_singleton', params: [] });
        await executor.all({
          sql: "INSERT INTO organization (id, slug, name) VALUES ('other', 'other', 'Other')",
          params: [],
        });
        await expect(
          executor.all({
            sql: "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at, trusted_publisher_id) VALUES ('cross', 'other', 'pat', 'mnopqrstuvwx', ?, 1, 'test', '[]', 'user', ?, 'publisher')",
            params: ['c'.repeat(64), EXPIRES],
          }),
        ).rejects.toMatchObject({ kind: 'foreign_key' });
      });
    });
    it('refuses moving a publisher organization while tokens reference it', async () => {
      await withDatabase(async (executor) => {
        await publisher(executor);
        await executor.all({
          sql: "UPDATE token SET trusted_publisher_id = 'publisher' WHERE org_id = 'org'",
          params: [],
        });
        await executor.all({ sql: 'DROP INDEX organization_singleton', params: [] });
        await executor.batch([
          {
            sql: "INSERT INTO organization (id, slug, name) VALUES ('other', 'other', 'Other')",
            params: [],
          },
          {
            sql: "INSERT INTO user_account (id, org_id, email) VALUES ('other-user', 'other', 'other@example.test')",
            params: [],
          },
          {
            sql: "INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES ('other-principal', 'other', 'other', 'other-user')",
            params: [],
          },
        ]);
        await expect(
          executor.all({
            sql: "UPDATE trusted_publisher SET org_id = 'other', service_principal_id = 'other-principal', created_by_user_id = 'other-user' WHERE id = 'publisher' AND org_id = 'org'",
            params: [],
          }),
        ).rejects.toMatchObject({ kind: 'foreign_key' });
      });
    });
    for (const [guard, sql] of [
      ['login_state', "UPDATE npm_login_session SET state = 'invalid' WHERE org_id = 'org'"],
      ['publisher_revision', "UPDATE trusted_publisher SET revision = 0 WHERE org_id = 'org'"],
    ]) {
      it(`refuses ${guard}`, async () => {
        await withDatabase(async (executor) => {
          await publisher(executor);
          await login(executor);
          await expect(executor.all({ sql: sql!, params: [] })).rejects.toMatchObject({
            kind: 'check',
          });
        });
      });
    }
    for (const [table, column, target] of [
      ['npm_login_session', 'project_id', 'other-project'],
      ['npm_login_session', 'user_id', 'other-user'],
      ['npm_login_session', 'token_id', 'other-token'],
      ['trusted_publisher', 'service_principal_id', 'other-principal'],
      ['trusted_publisher', 'created_by_user_id', 'other-user'],
      ['oidc_replay', 'trusted_publisher_id', 'other-publisher'],
      ['token', 'trusted_publisher_id', 'other-publisher'],
    ]) {
      it(`refuses cross-organization ${table}.${column} on update`, async () => {
        await withDatabase(async (executor) => {
          await executor.all({ sql: 'DROP INDEX organization_singleton', params: [] });
          await executor.batch([
            {
              sql: "INSERT INTO organization (id, slug, name) VALUES ('other', 'other', 'Other')",
              params: [],
            },
            {
              sql: "INSERT INTO user_account (id, org_id, email) VALUES ('other-user', 'other', 'other@example.test')",
              params: [],
            },
            {
              sql: "INSERT INTO project (id, org_id, slug, name) VALUES ('other-project', 'other', 'other', 'Other')",
              params: [],
            },
            {
              sql: "INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES ('other-principal', 'other', 'other', 'other-user')",
              params: [],
            },
            {
              sql: "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at) VALUES ('other-token', 'other', 'pat', 'mnopqrstuvwx', ?, 1, 'other', '[]', 'other-user', '2026-11-01T00:00:00.000Z')",
              params: ['b'.repeat(64)],
            },
            {
              sql: "INSERT INTO trusted_publisher (id, org_id, package_name, repository_id, repository_owner_id, repository, workflow, service_principal_id, created_by_user_id) VALUES ('other-publisher', 'other', 'test', '123', '456', 'owner/repo', 'publish.yml', 'other-principal', 'other-user')",
              params: [],
            },
          ]);
          await publisher(executor);
          await login(executor);
          await executor.all({
            sql: "INSERT INTO oidc_replay (issuer, jti, org_id, trusted_publisher_id, expires_at) VALUES ('issuer', 'jti', 'org', 'publisher', ?)",
            params: [EXPIRES],
          });
          await executor.all({
            sql: "UPDATE npm_login_session SET state = 'approved', user_id = 'user', token_id = 'token', token_ciphertext = 'sealed', token_nonce = 'nonce', token_key_version = 1 WHERE org_id = 'org'",
            params: [],
          });
          await expect(
            executor.all({
              sql: `UPDATE ${table} SET ${column} = ? WHERE org_id = ?`,
              params: [target!, 'org'],
            }),
          ).rejects.toMatchObject({ kind: 'foreign_key' });
        });
      });
    }
  });
}
