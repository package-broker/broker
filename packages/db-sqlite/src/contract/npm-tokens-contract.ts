import { describe, expect, it } from 'vitest';
import { orgContext, type SqlExecutor } from '@package-broker/core/db/port';
import { createNpmTokenAdapters } from '../repositories/npm-tokens.js';

export const anchors = [
  {
    provider: 'oidc',
    anchor: 'https://idp.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
export const input = {
  tokenId: 'caller',
  selector: 'abcdefghijkl',
  userId: 'owner',
  targetId: 'target',
  projectId: 'project',
  projectSlug: 'demo',
  requestId: '01JA0000000000000000000000',
};
export async function seedNpmTokens(executor: SqlExecutor) {
  const run = (sql: string, ...params: (string | number | null)[]) => executor.all({ sql, params });
  await run('DROP INDEX IF EXISTS organization_singleton');
  for (const org of ['org', 'foreign'])
    await run('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', org, org, org);
  for (const [user, org] of [
    ['owner', 'org'],
    ['other', 'org'],
    ['foreign-user', 'foreign'],
  ])
    await run(
      'INSERT INTO user_account (id,org_id,email) VALUES (?,?,?)',
      user!,
      org!,
      `${user}@example.test`,
    );
  await run("INSERT INTO project (id,org_id,slug,name) VALUES ('project','org','demo','Demo')");
  await run(
    "INSERT INTO identity_provider_binding (org_id,provider,anchor) VALUES ('org','oidc','https://idp.test')",
  );
  await run(
    "INSERT INTO identity (id,org_id,user_id,provider,subject,email,email_verified,validated_at) VALUES ('identity','org','owner','oidc','subject','owner@example.test',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  );
  await run(
    "INSERT INTO role (id,org_id,key,name,scope) VALUES ('role','org','reader','Reader','organization')",
  );
  await run(
    "INSERT INTO role_permission (org_id,role_id,permission) VALUES ('org','role','project:read')",
  );
  await run(
    "INSERT INTO access_grant (id,org_id,subject_type,subject_value,scope,role_id) VALUES ('grant','org','email','owner@example.test','organization','role')",
  );
  await run(
    "INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES ('service','org','Service','owner')",
  );
  for (const [id, org, user, scope] of [
    ['caller', 'org', 'owner', 'read'],
    ['target', 'org', 'owner', 'write'],
    ['other-token', 'org', 'other', 'read'],
    ['foreign-token', 'foreign', 'foreign-user', 'read'],
  ]) {
    await run(
      `INSERT INTO token (id,org_id,kind,selector,hash,pepper_version,name,scopes_json,read_only,user_id,expires_at,project_mode,validation_kind,validation_identity_id) VALUES (?,?,'pat',?,?,1,'secret name',?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'),'all',?,?)`,
      id!,
      org!,
      id === 'caller' ? input.selector : id!.padEnd(12, 'a').slice(0, 12),
      'f'.repeat(64),
      JSON.stringify([scope]),
      scope === 'read' ? 1 : 0,
      user!,
      id === 'caller' ? 'sso' : null,
      id === 'caller' ? 'identity' : null,
    );
  }
}
export function describeNpmTokensContract(
  name: string,
  open: () => Promise<{ executor: SqlExecutor; close(): void | Promise<void> }>,
) {
  describe(`npm tokens ${name}`, () => {
    async function run(body: (executor: SqlExecutor) => Promise<void>) {
      const db = await open();
      try {
        await seedNpmTokens(db.executor);
        await body(db.executor);
      } finally {
        await db.close();
      }
    }
    it('lists only active own PAT metadata and revokes once with one audit', () =>
      run(async (executor) => {
        const adapters = createNpmTokenAdapters(executor, async () => anchors);
        const page = await adapters.reader.listOwn(orgContext('org'), 'owner', {
          after: null,
          limit: 100,
          status: 'active',
          now: new Date().toISOString(),
        });
        expect(page.items.map((t) => [t.id, t.readOnly])).toEqual([
          ['caller', true],
          ['target', false],
        ]);
        expect(JSON.stringify(page)).not.toContain('f'.repeat(64));
        expect(await adapters.revokeOwn(orgContext('org'), input)).toBe(true);
        expect(await adapters.revokeOwn(orgContext('org'), input)).toBe(false);
        expect(
          await executor.all({
            sql: "SELECT action,actor_id,target_id FROM audit_pending WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ action: 'token.revoke', actor_id: 'owner', target_id: 'target' }]);
      }));
    for (const targetId of ['other-token', 'foreign-token', 'missing'])
      it(`refuses target ${targetId}`, () =>
        run(async (executor) => {
          expect(
            await createNpmTokenAdapters(executor, async () => anchors).revokeOwn(
              orgContext('org'),
              { ...input, targetId },
            ),
          ).toBe(false);
          expect(await executor.all({ sql: 'SELECT id FROM audit_pending', params: [] })).toEqual(
            [],
          );
        }));
    const guards = [
      "UPDATE token SET kind='svc',user_id=NULL,service_principal_id='service' WHERE id='target'",
      "UPDATE token SET revoked_at = '2020-01-01' WHERE id='caller'",
      "UPDATE token SET expires_at = '2020-01-01' WHERE id='caller'",
      "UPDATE user_account SET status='suspended' WHERE id='owner'",
      "UPDATE user_account SET pat_invalid_before='2099-01-01' WHERE id='owner'",
      "UPDATE identity SET validated_at='2020-01-01' WHERE id='identity'",
      "DELETE FROM access_grant WHERE id='grant'",
      "UPDATE token SET project_mode='selected' WHERE id='caller'",
      "UPDATE token SET user_id='other' WHERE id='target'",
    ];
    for (const change of guards)
      it(`rechecks at write time: ${change}`, () =>
        run(async (executor) => {
          let changed = false;
          const wrapped: SqlExecutor = {
            ...executor,
            all: executor.all.bind(executor),
            async batch(statements) {
              if (!changed) {
                changed = true;
                await executor.all({ sql: change, params: [] });
              }
              return executor.batch(statements);
            },
          };
          expect(
            await createNpmTokenAdapters(wrapped, async () => anchors).revokeOwn(
              orgContext('org'),
              input,
            ),
          ).toBe(false);
          expect(changed).toBe(true);
          expect(
            await executor.all({
              sql: "SELECT revoked_at FROM token WHERE id='target'",
              params: [],
            }),
          ).toEqual([{ revoked_at: null }]);
          expect(await executor.all({ sql: 'SELECT id FROM audit_pending', params: [] })).toEqual(
            [],
          );
        }));
    it('rolls back revocation when audit storage fails', () =>
      run(async (executor) => {
        await executor.all({
          sql: "CREATE TRIGGER reject_token_audit BEFORE INSERT ON audit_pending BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
          params: [],
        });
        await expect(
          createNpmTokenAdapters(executor, async () => anchors).revokeOwn(orgContext('org'), input),
        ).rejects.toThrow();
        expect(
          await executor.all({ sql: "SELECT revoked_at FROM token WHERE id='target'", params: [] }),
        ).toEqual([{ revoked_at: null }]);
      }));
    it('returns missing for malformed keys without auditing request data', () =>
      run(async (executor) => {
        expect(
          await createNpmTokenAdapters(executor, async () => anchors).revokeOwn(orgContext('org'), {
            ...input,
            targetId: 'secret@example.test',
          }),
        ).toBe(false);
        expect(await executor.all({ sql: 'SELECT id FROM audit_pending', params: [] })).toEqual([]);
      }));
    it('allows self revocation with the audit in the same batch', () =>
      run(async (executor) => {
        expect(
          await createNpmTokenAdapters(executor, async () => anchors).revokeOwn(orgContext('org'), {
            ...input,
            targetId: 'caller',
          }),
        ).toBe(true);
        expect(
          await executor.all({ sql: 'SELECT target_id FROM audit_pending', params: [] }),
        ).toEqual([{ target_id: 'caller' }]);
      }));
  });
}
