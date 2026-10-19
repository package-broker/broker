import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  delegatedMutationFence,
  mutationFence,
  systemMutationFence,
  tokenMutationFence,
  type AuthenticatedActor,
  type AuthenticatedTokenActor,
  type MutationFence,
  type TokenMutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase } from '../testing/migrated-database.js';

import { compile, db } from '../kysely.js';
import { importWriteAuthority } from './import-authority.js';

interface FixturePrepared {
  bind(...params: unknown[]): FixturePrepared;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}
interface FixtureBinding {
  prepare(sql: string): FixturePrepared;
  batch(statements: FixturePrepared[]): Promise<
    {
      results: Record<string, unknown>[];
      meta: { changes: number };
    }[]
  >;
}

const sha = 'a'.repeat(64);
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const anchors = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];

describe.each(['sqlite', 'd1'])('import write authority (%s)', (driver) => {
  let executor: SqlExecutor;
  let ctx: OrgContext;
  let foreign: OrgContext;
  let fence: MutationFence;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const database = await openMigratedDatabase({
      twoOrganizations: true,
      d1PatternLimit: driver === 'd1',
    });
    if (database.orgs === null) throw new Error('missing organizations');
    ({ a: ctx, b: foreign } = database.orgs);
    close = database.close;
    executor = database.executor;
    if (driver === 'd1') {
      // A computed test import avoids a TypeScript build dependency back to the runtime.
      const runtimeModule = '@package-broker/runtime-cloudflare/db/d1-executor';
      const { createD1Executor } = (await import(runtimeModule)) as {
        createD1Executor(binding: FixtureBinding): SqlExecutor;
      };
      // Exercise the production D1 executor without a localhost listener in the sandbox.
      // Deliberately inflate meta.changes: only RETURNING rows establish mutation counts.
      const statements = new WeakMap<FixturePrepared, Statement>();
      const binding: FixtureBinding = {
        prepare(sql) {
          const prepared: FixturePrepared = {
            bind(...params) {
              statements.set(prepared, { sql, params: params as Statement['params'] });
              return prepared;
            },
            async all() {
              const statement = statements.get(prepared);
              if (statement === undefined) throw new Error('unbound fixture statement');
              return { results: await database.executor.all(statement) };
            },
          };
          return prepared;
        },
        async batch(prepared) {
          const results = await database.executor.batch(
            prepared.map((item) => {
              const statement = statements.get(item);
              if (statement === undefined) throw new Error('unbound fixture statement');
              return statement;
            }),
          );
          return results.map((result) => ({ results: result.rows, meta: { changes: 999 } }));
        },
      };
      executor = createD1Executor(binding);
    }
    await executor.batch([
      stmt(
        "INSERT INTO user_account (id, org_id, email) VALUES ('actor', ?, 'actor@example.test')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'actor', 'oidc', 'subject', 'actor@example.test', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO role (id, org_id, key, name, scope) VALUES ('importer', ?, 'importer', 'Importer', 'organization')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:write')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:approve')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', 'actor@example.test', 'organization', 'importer')",
        ctx.orgId,
      ),
      stmt(
        `INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, last_seen_at, reauth_at)
        VALUES ('session', ?, 'actor', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        ctx.orgId,
        sha,
        'b'.repeat(64),
      ),
    ]);
    fence = mutationFence({ userId: 'actor', sessionId: 'session' } as AuthenticatedActor, {});
  });
  afterEach(async () => {
    await close?.();
  });
  async function seedPatToken() {
    await executor.batch([
      stmt(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, user_id, project_mode, validation_kind, validation_identity_id, expires_at)
        VALUES ('pat-token', ?, 'pat', 'patselector1', ?, 1, 'pat', '["full"]', 0, 'actor', 'all', 'sso', 'identity', strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))`,
        ctx.orgId,
        'c'.repeat(64),
      ),
    ]);
    return tokenMutationFence(
      { tokenId: 'pat-token', tokenKind: 'pat', principalId: 'actor' } as AuthenticatedTokenActor,
      'org:import:write',
      {},
    );
  }
  async function seedServiceToken(org = ctx, createdByUserId = 'actor') {
    await executor.batch([
      stmt(
        "INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES ('principal', ?, 'importer', ?)",
        org.orgId,
        createdByUserId,
      ),
      stmt(
        "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, 'principal', 'org:import:write')",
        org.orgId,
      ),
      stmt(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, service_principal_id, project_mode, expires_at)
        VALUES ('svc-token', ?, 'svc', 'svcselector1', ?, 1, 'svc', '["full"]', 0, 'principal', 'all', strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))`,
        org.orgId,
        'd'.repeat(64),
      ),
    ]);
    return tokenMutationFence(
      {
        tokenId: 'svc-token',
        tokenKind: 'svc',
        principalId: 'principal',
      } as AuthenticatedTokenActor,
      'org:import:write',
      {},
    );
  }

  async function allowed(actor: MutationFence | TokenMutationFence = fence, org = ctx) {
    const statement = compile(
      db.selectNoFrom(
        sql<number>`case when ${importWriteAuthority(org, actor, anchors)} then 1 else 0 end`.as(
          'allowed',
        ),
      ),
    );
    expect(statement.params.length).toBeLessThanOrEqual(100);
    expect(statement.sql).not.toMatch(/before_image_json|select\s+(distinct\s+)?\*|\.\*/i);
    const [row] = await executor.all<{ allowed: number }>(statement);
    return row?.allowed === 1;
  }
  it('accepts a session with live import write permission', async () => {
    expect(await allowed()).toBe(true);
  });
  it('refuses a session without permission', async () => {
    await executor.all(stmt("DELETE FROM role_permission WHERE permission = 'org:import:write'"));
    expect(await allowed()).toBe(false);
  });
  it('refuses a session from another organization', async () => {
    expect(await allowed(fence, foreign)).toBe(false);
  });
  it('accepts an active full-scope PAT with permission and fresh evidence', async () => {
    expect(await allowed(await seedPatToken())).toBe(true);
  });
  it.each([
    ['revoked', "UPDATE token SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"],
    ['expired', "UPDATE token SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')"],
    ['read only', 'UPDATE token SET read_only = 1'],
    ['project id set', "UPDATE token SET project_id = 'project'"],
    ['selected project mode', "UPDATE token SET project_mode = 'selected'"],
    ['non-full scope', `UPDATE token SET scopes_json = '["read"]'`],
    ['multiple scopes', `UPDATE token SET scopes_json = '["full","read"]'`],
    ['inactive user', "UPDATE user_account SET status = 'suspended' WHERE id = 'actor'"],
    ['missing permission', "DELETE FROM role_permission WHERE permission = 'org:import:write'"],
    [
      'stale evidence',
      "UPDATE identity SET validated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')",
    ],
    [
      'future evidence',
      "UPDATE identity SET validated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day')",
    ],
  ])('refuses a PAT with %s', async (_label, mutation) => {
    const token = await seedPatToken();
    await executor.all(
      stmt(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'p', 'P')",
        ctx.orgId,
      ),
    );
    await executor.all(stmt(mutation));
    expect(await allowed(token)).toBe(false);
  });
  async function seedLocalPatToken() {
    const token = await seedPatToken();
    await executor.batch([
      stmt("UPDATE token SET validation_kind = 'local', validation_identity_id = NULL"),
      stmt("UPDATE role SET protects_last_holder = 1 WHERE id = 'importer'"),
      stmt(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('totp', ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
        ctx.orgId,
      ),
      stmt(
        `INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at)
        VALUES ('actor', ?, 'pbkdf2-sha256$test', 'totp', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        ctx.orgId,
      ),
      stmt("UPDATE identity SET validated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')"),
    ]);
    return token;
  }
  it('accepts a local-login PAT with fresh evidence and no validation identity', async () => {
    expect(await allowed(await seedLocalPatToken())).toBe(true);
  });
  it('refuses a local-login PAT with stale login evidence', async () => {
    const token = await seedLocalPatToken();
    expect(await allowed(token)).toBe(true);
    await executor.all(
      stmt("UPDATE local_login SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')"),
    );
    expect(await allowed(token)).toBe(false);
  });
  it('refuses a local-login PAT with a validation identity', async () => {
    const token = await seedLocalPatToken();
    expect(await allowed(token)).toBe(true);
    // Seed an invalid persisted state to exercise the authority guard beyond the schema check.
    await executor.all(stmt('PRAGMA ignore_check_constraints = ON'));
    try {
      await executor.all(stmt("UPDATE token SET validation_identity_id = 'identity'"));
    } finally {
      await executor.all(stmt('PRAGMA ignore_check_constraints = OFF'));
    }
    expect(await allowed(token)).toBe(false);
  });
  it.each([
    ['revoked', "UPDATE token SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"],
    ['expired', "UPDATE token SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')"],
    ['suspended principal', "UPDATE service_principal SET status = 'suspended'"],
  ])('refuses a service token with %s', async (_label, mutation) => {
    const token = await seedServiceToken();
    expect(await allowed(token)).toBe(true);
    await executor.all(stmt(mutation));
    expect(await allowed(token)).toBe(false);
  });
  it('accepts a service token with the permission', async () => {
    expect(await allowed(await seedServiceToken())).toBe(true);
  });
  it('refuses a service token without the permission row', async () => {
    const token = await seedServiceToken();
    await executor.all(stmt('DELETE FROM service_principal_permission'));
    expect(await allowed(token)).toBe(false);
  });
  it('refuses a project-scoped service principal', async () => {
    const token = await seedServiceToken();
    await executor.all(
      stmt(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'p', 'P')",
        ctx.orgId,
      ),
    );
    await executor.all(stmt("UPDATE service_principal SET project_id = 'project'"));
    expect(await allowed(token)).toBe(false);
  });
  it('refuses a foreign token even when the principal matches', async () => {
    const token = await seedPatToken();
    await executor.all(stmt('UPDATE token SET org_id = ?', foreign.orgId));
    expect(await allowed(token)).toBe(false);
    expect(await allowed(token, foreign)).toBe(false);
  });
  it('refuses a foreign service token with the same principal', async () => {
    const token = await seedServiceToken();
    await executor.all(stmt('UPDATE token SET org_id = ?', foreign.orgId));
    expect(await allowed(token)).toBe(false);
    expect(await allowed(token, foreign)).toBe(false);
  });
  it('refuses a valid foreign service token that is authorized in its own organization', async () => {
    await executor.all(
      stmt(
        "INSERT INTO user_account (id, org_id, email) VALUES ('foreign-actor', ?, 'foreign-actor@example.test')",
        foreign.orgId,
      ),
    );
    const token = await seedServiceToken(foreign, 'foreign-actor');
    expect(await allowed(token, foreign)).toBe(true);
    expect(await allowed(token, ctx)).toBe(false);
  });
  it('rejects a token fence for another permission', async () => {
    const token = await seedPatToken();
    const other = tokenMutationFence(
      token as unknown as AuthenticatedTokenActor,
      'project:packages:write',
      {},
    );
    expect(() => importWriteAuthority(ctx, other, anchors)).toThrow(TypeError);
  });
  it('rejects system and delegated fences', () => {
    const job = { id: 'job', owner: 'owner', fence: 1 };
    for (const actor of [
      systemMutationFence('purge', job, {}),
      delegatedMutationFence('actor', 'run', job, {}),
    ]) {
      expect(() => importWriteAuthority(ctx, actor as unknown as MutationFence, anchors)).toThrow(
        TypeError,
      );
    }
  });
});
