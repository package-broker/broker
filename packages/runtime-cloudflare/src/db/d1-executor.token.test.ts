import { auditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import {
  describeTokenContract,
  tokenContractCases,
} from '@package-broker/db-sqlite/contract/token-contract';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as scope from '@package-broker/core/authz/scope';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import {
  createTokenRepository,
  type MintedToken,
} from '@package-broker/db-sqlite/repositories/token';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const USER = '01J0USER000000000000000001';
const SESSION = '01J0SESSION0000000000000001';
const SELECTOR = 'abcdefghijkl';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['TOKEN_A', 'TOKEN_B'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function loadSources(): Promise<MigrationSource[]> {
  return Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
}

function st(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function mint(): MintedToken {
  return {
    selector: SELECTOR,
    hash: 'a'.repeat(64),
    pepperVersion: 1,
    plaintext: `pb_pat_${SELECTOR}_${'x'.repeat(43)}`,
  };
}

async function seeded(binding: string, projectCount: number) {
  const executor = createD1Executor((await mf.getD1Database(binding)) as unknown as D1DatabaseLike);
  await migrate(executor, await loadSources(), { holder: 'token-test' });
  const { a } = await seedTwoOrganizations(executor);
  const ids = Array.from(
    { length: projectCount },
    (_, index) => `01J0PROJECT${String(index + 1).padStart(15, '0')}`,
  );
  await executor.batch([
    st(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      USER,
      a.orgId,
      'user@example.test',
    ),
    st(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      SESSION,
      a.orgId,
      USER,
      'a'.repeat(64),
      'b'.repeat(64),
      iso(3_600_000),
      iso(-60_000),
    ),
    st(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 1)',
      '01J0ROLE000000000000000001',
      a.orgId,
      'organization_admin',
      'Admin',
      'organization',
    ),
    st(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, 'email', ?, NULL, 'organization', NULL, ?)",
      '01J0GRANT000000000000000001',
      a.orgId,
      'user@example.test',
      '01J0ROLE000000000000000001',
    ),
    st(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'project:packages:read')",
      a.orgId,
      '01J0ROLE000000000000000001',
    ),
    st(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDENTIAL000000000001', ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
      a.orgId,
    ),
    st(
      "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, 'pbkdf2-sha256$i=1$v=1$c2FsdA$aGFzaA', '01J0CREDENTIAL000000000001', ?, ?)",
      USER,
      a.orgId,
      iso(-60_000),
      iso(-60_000),
    ),
  ]);
  for (let offset = 0; offset < ids.length; offset += 50) {
    await executor.batch(
      ids
        .slice(offset, offset + 50)
        .map((id, index) =>
          st(
            'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
            id,
            a.orgId,
            `p-${offset + index}`,
            'Project',
          ),
        ),
    );
  }
  return { executor, a, ids };
}

function input(ids: string[]) {
  return {
    audit: mutationAudit(),
    id: '01J0TOKEN0000000000000000A',
    name: 'laptop',
    scope: 'read' as const,
    expiresAt: iso(86_400_000),
    now: iso(0),
    validation: { kind: 'local' as const },
    projectMode: 'selected' as const,
    projectIds: ids,
    providerAnchors: [],
  };
}

function fence() {
  return mutationFence({ userId: USER, sessionId: SESSION } as unknown as AuthenticatedActor, {});
}

async function count(executor: SqlExecutor, table: string): Promise<number> {
  return (
    (
      await executor.all<{ n: number }>({ sql: `SELECT count(*) AS n FROM ${table}`, params: [] })
    )[0]?.n ?? -1
  );
}

describe('d1 token issuance', () => {
  it('binds exactly 200 selected projects through one JSON parameter', async () => {
    const { executor, a, ids } = await seeded('TOKEN_A', 200);
    const result = await createTokenRepository(executor).issuePersonal(
      a,
      fence(),
      input(ids),
      mint,
    );

    expect(result.status).toBe('issued');
    expect(await count(executor, 'token')).toBe(1);
    expect(await count(executor, 'token_project')).toBe(200);
  }, 120_000);

  it('rolls back the token when the binding insert is truncated', async () => {
    const { executor, a, ids } = await seeded('TOKEN_B', 5);
    const truncating: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: executor.all.bind(executor),
      batch: (statements) =>
        executor.batch(
          statements.map((statement) =>
            /insert into "token_project"/i.test(statement.sql)
              ? {
                  sql: statement.sql,
                  params: statement.params.map((param) =>
                    typeof param === 'string' && param.startsWith('[')
                      ? JSON.stringify((JSON.parse(param) as string[]).slice(0, 3))
                      : param,
                  ),
                }
              : statement,
          ),
        ),
    };
    const result = await createTokenRepository(truncating).issuePersonal(
      a,
      fence(),
      input(ids),
      mint,
    );

    expect(result).toEqual({ status: 'refused', reason: 'unclassified' });
    expect(await count(executor, 'token')).toBe(0);
    expect(await count(executor, 'token_project')).toBe(0);
  }, 120_000);
});

async function openTokenContractDatabase() {
  const isolated = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['CONTRACT'],
    } as Parameters<typeof convertV4MiniflareOptions>[0]),
  );
  const executor = createD1Executor(
    (await isolated.getD1Database('CONTRACT')) as unknown as D1DatabaseLike,
  );
  await migrate(executor, await loadSources(), { holder: 'token-contract' });
  return { executor, close: () => isolated.dispose() };
}

describeTokenContract('Miniflare D1', openTokenContractDatabase);

describe('D1 token lookup scope mutation', () => {
  it('catches removal of the project cap intersection', async () => {
    const effective = scope.tokenEffectivePermissions;
    const spy = vi
      .spyOn(scope, 'tokenEffectivePermissions')
      .mockImplementation((input) =>
        effective(input.boundary === 'project' ? { ...input, tokenMaxScope: 'full' } : input),
      );
    try {
      await expect(tokenContractCases.projectCap(openTokenContractDatabase)).rejects.toThrow(
        /to deeply equal/,
      );
    } finally {
      spy.mockRestore();
    }
  }, 120_000);
});

describe('D1 token lookup SQL mutation', () => {
  it('catches a null project_token_max_scope selected by lookupToken', async () => {
    let mutations = 0;
    await expect(
      tokenContractCases.projectCap(openTokenContractDatabase, (executor): SqlExecutor => ({
        driver: executor.driver,
        batch: executor.batch.bind(executor),
        all: (statement) => {
          if (statement.sql.includes('"p"."token_max_scope" as "project_token_max_scope"')) {
            mutations += 1;
          }
          return executor.all({
            ...statement,
            sql: statement.sql.replace(
              '"p"."token_max_scope" as "project_token_max_scope"',
              'null as "project_token_max_scope"',
            ),
          });
        },
      })),
    ).rejects.toThrow(/to deeply equal/);
    expect(mutations).toBeGreaterThan(0);
  }, 120_000);
});

function mutationAudit() {
  const id = ulid();
  const result = auditEvent({
    id,
    now: iso(0),
    action: 'token.issue',
    actor: { type: 'system', id: null },
    target: { type: 'token', id: null },
    context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
  });
  if (!result.ok) throw new Error('Invalid test audit event');
  return result.event;
}
