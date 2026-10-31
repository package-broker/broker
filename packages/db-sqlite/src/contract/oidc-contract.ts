import { describe, expect, it } from 'vitest';
import { orgContext, type SqlExecutor, type Statement } from '@package-broker/core/db/port';
import { createOidcReplayExpiryJob } from '@package-broker/core/registry/npm/oidc/expiry';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { createOidcRepository } from '../repositories/oidc.js';
const issuer = 'https://token.actions.githubusercontent.com';
const match = {
  packageName: 'test',
  repositoryId: '123',
  repositoryOwnerId: '456',
  workflow: 'publish.yml',
  environment: '',
};
const now = '2026-10-31T00:00:00.000Z';
const exp = Date.parse(now) / 1000 + 300;
const statement = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });

export function describeOidcContract(
  backend: string,
  open: () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>,
) {
  describe(`OIDC repository: ${backend}`, () => {
    async function setup() {
      const database = await open();
      const { executor } = database;
      await executor.all(statement('DROP INDEX organization_singleton'));
      for (const org of ['a', 'b']) {
        await executor.batch([
          statement('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', org, org, org),
          statement(
            'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
            `user-${org}`,
            org,
            `${org}@example.test`,
          ),
          statement(
            'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
            `principal-${org}`,
            org,
            'publisher',
            `user-${org}`,
          ),
          statement(
            "INSERT INTO trusted_publisher (id, org_id, package_name, repository_id, repository_owner_id, repository, workflow, environment, service_principal_id, created_by_user_id) VALUES (?, ?, 'test', '123', '456', 'owner/repo', 'publish.yml', '', ?, ?)",
            `publisher-${org}`,
            org,
            `principal-${org}`,
            `user-${org}`,
          ),
        ]);
      }
      const repo = createOidcRepository(executor);
      const reservation = (jti = 'unique') =>
        repo
          .reserveStatements(orgContext('a'), {
            issuer,
            jti,
            trustedPublisherId: 'publisher-a',
            expectedRevision: 1,
            expiresAt: exp,
            now,
          })
          .appendTo([]);
      return { ...database, repo, reservation };
    }
    it('selects only the enabled exact organization and claim binding, capped at two safe rows', async () => {
      const db = await setup();
      try {
        expect(await db.repo.find(orgContext('a'), match)).toEqual([
          {
            ...match,
            id: 'publisher-a',
            servicePrincipalId: 'principal-a',
            refPattern: null,
            revision: 1,
          },
        ]);
        for (const patch of [
          { packageName: 'other' },
          { repositoryId: '999' },
          { repositoryOwnerId: '999' },
          { workflow: 'other.yml' },
          { environment: 'production' },
        ])
          expect(await db.repo.find(orgContext('a'), { ...match, ...patch })).toEqual([]);
        await db.executor.all(
          statement("UPDATE trusted_publisher SET disabled_at = ? WHERE org_id = 'a'", now),
        );
        expect(await db.repo.find(orgContext('a'), match)).toEqual([]);
      } finally {
        await db.close();
      }
    });
    it('caps ambiguous candidate rows at two even with a corrupted uniqueness index', async () => {
      const db = await setup();
      try {
        await db.executor.all(statement('DROP INDEX trusted_publisher_binding'));
        for (const id of ['second', 'third'])
          await db.executor.all(
            statement(
              "INSERT INTO trusted_publisher (id, org_id, package_name, repository_id, repository_owner_id, repository, workflow, environment, service_principal_id, created_by_user_id) VALUES (?, 'a', 'test', '123', '456', 'owner/repo', 'publish.yml', '', 'principal-a', 'user-a')",
              id,
            ),
          );
        expect(await db.repo.find(orgContext('a'), match)).toHaveLength(2);
      } finally {
        await db.close();
      }
    });
    it('allows exactly one concurrent replay reservation and rolls back losing token and audit writes', async () => {
      const db = await setup();
      try {
        const batches = ['first', 'second'].map((id, i) => [
          statement(
            "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, service_principal_id, expires_at, project_mode, trusted_publisher_id, package_name) VALUES (?, 'a', 'svc', ?, ?, 1, 'workload', '[\"write\"]', 'principal-a', '2026-10-31T00:15:00.000Z', 'all', 'publisher-a', 'test')",
            id,
            String(i).repeat(12),
            'a'.repeat(64),
          ),
          statement(
            "INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, action, target_type, target_id, payload_json) VALUES (?, 'a', ?, 'service_principal', 'principal-a', 'token.workload_issue', 'token', ?, '{}')",
            id,
            now,
            id,
          ),
          ...db.reservation(),
        ]);
        const results = await Promise.allSettled(batches.map((batch) => db.executor.batch(batch)));
        expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(
          await db.executor.all(statement("SELECT id FROM token WHERE org_id = 'a'")),
        ).toHaveLength(1);
        expect(
          await db.executor.all(statement("SELECT id FROM audit_pending WHERE org_id = 'a'")),
        ).toHaveLength(1);
        expect(
          await db.executor.all(statement("SELECT jti FROM oidc_replay WHERE org_id = 'a'")),
        ).toEqual([{ jti: 'unique' }]);
      } finally {
        await db.close();
      }
    });
    it('reserves replay for exp plus one hour and rolls back on a failed issuance batch', async () => {
      const db = await setup();
      try {
        await expect(
          db.executor.batch([
            ...db.reservation(),
            statement('INSERT INTO no_such_table VALUES (1)'),
          ]),
        ).rejects.toThrow();
        expect(await db.executor.all(statement('SELECT * FROM oidc_replay'))).toEqual([]);
        await db.executor.batch(db.reservation());
        expect(
          await db.executor.all(
            statement('SELECT org_id, trusted_publisher_id, expires_at FROM oidc_replay'),
          ),
        ).toEqual([
          {
            org_id: 'a',
            trusted_publisher_id: 'publisher-a',
            expires_at: new Date((exp + 3600) * 1000).toISOString(),
          },
        ]);
        await expect(db.executor.batch(db.reservation())).rejects.toThrow();
        await expect(
          db.executor.batch(
            db.repo
              .reserveStatements(orgContext('b'), {
                issuer,
                jti: 'unique',
                trustedPublisherId: 'publisher-b',
                expectedRevision: 1,
                expiresAt: exp,
                now,
              })
              .appendTo([]),
          ),
        ).rejects.toThrow();
      } finally {
        await db.close();
      }
    });
    it.each(['organization', 'disabled', 'revision', 'principal'])(
      'refuses a stale %s fence atomically',
      async (guard) => {
        const db = await setup();
        try {
          const batch =
            guard === 'organization'
              ? db.repo
                  .reserveStatements(orgContext('b'), {
                    issuer,
                    jti: 'unique',
                    trustedPublisherId: 'publisher-a',
                    expectedRevision: 1,
                    expiresAt: exp,
                    now,
                  })
                  .appendTo([])
              : db.reservation();
          if (guard === 'disabled')
            await db.executor.all(
              statement("UPDATE trusted_publisher SET disabled_at = ? WHERE org_id = 'a'", now),
            );
          if (guard === 'revision')
            await db.executor.all(
              statement("UPDATE trusted_publisher SET revision = 2 WHERE org_id = 'a'"),
            );
          if (guard === 'principal')
            await db.executor.all(
              statement("UPDATE service_principal SET status = 'suspended' WHERE org_id = 'a'"),
            );
          await expect(db.executor.batch(batch)).rejects.toThrow();
          expect(await db.executor.all(statement('SELECT * FROM oidc_replay'))).toEqual([]);
        } finally {
          await db.close();
        }
      },
    );
    it('purges at most 100 expired rows of its organization, including equality', async () => {
      const db = await setup();
      try {
        const rows = Array.from({ length: 101 }, (_, i) =>
          statement(
            'INSERT INTO oidc_replay VALUES (?, ?, ?, ?, ?)',
            issuer,
            `expired-${i}`,
            'a',
            'publisher-a',
            now,
          ),
        );
        await db.executor.batch([
          ...rows,
          statement(
            'INSERT INTO oidc_replay VALUES (?, ?, ?, ?, ?)',
            issuer,
            'foreign',
            'b',
            'publisher-b',
            now,
          ),
          statement(
            'INSERT INTO oidc_replay VALUES (?, ?, ?, ?, ?)',
            issuer,
            'live',
            'a',
            'publisher-a',
            '2099-01-01T00:00:00.000Z',
          ),
        ]);
        expect(await db.repo.purge(orgContext('a'), now)).toBe(100);
        expect(
          await db.executor.all(statement('SELECT jti FROM oidc_replay ORDER BY jti')),
        ).toHaveLength(3);
        await db.repo.purge(orgContext('a'), now);
        expect(
          await db.executor.all(statement('SELECT jti FROM oidc_replay ORDER BY jti')),
        ).toEqual([{ jti: 'foreign' }, { jti: 'live' }]);
      } finally {
        await db.close();
      }
    });
    it('drains 201 expired rows in one job and preserves foreign and live rows', async () => {
      const db = await setup();
      try {
        for (let i = 0; i < 201; i++)
          await db.executor.all(
            statement(
              'INSERT INTO oidc_replay VALUES (?, ?, ?, ?, ?)',
              issuer,
              `expired-${i}`,
              'a',
              'publisher-a',
              now,
            ),
          );
        await db.executor.all(
          statement(
            'INSERT INTO oidc_replay VALUES (?, ?, ?, ?, ?)',
            issuer,
            'foreign',
            'b',
            'publisher-b',
            now,
          ),
        );
        await db.executor.all(
          statement(
            'INSERT INTO oidc_replay VALUES (?, ?, ?, ?, ?)',
            issuer,
            'live',
            'a',
            'publisher-a',
            '2099-01-01T00:00:00.000Z',
          ),
        );
        await createOidcReplayExpiryJob(db.repo).handler({}, {
          org: orgContext('a'),
          signal: new AbortController().signal,
          ports: { clock: { now: () => new Date(now) } },
        } as JobContext);
        expect(
          await db.executor.all(statement('SELECT jti FROM oidc_replay ORDER BY jti')),
        ).toEqual([{ jti: 'foreign' }, { jti: 'live' }]);
      } finally {
        await db.close();
      }
    });
    it('matches environment with ASCII case folding', async () => {
      const db = await setup();
      try {
        await db.executor.all(
          statement("UPDATE trusted_publisher SET environment = 'PrOD-Ä' WHERE org_id = 'a'"),
        );
        expect(
          await db.repo.find(orgContext('a'), { ...match, environment: 'PROD-Ä' }),
        ).toHaveLength(1);
        expect(await db.repo.find(orgContext('a'), { ...match, environment: 'prod-ä' })).toEqual(
          [],
        );
      } finally {
        await db.close();
      }
    });
  });
}
