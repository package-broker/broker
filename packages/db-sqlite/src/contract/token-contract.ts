import { describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { createAuthorizationEngine, patValidationGate } from '@package-broker/core/authz/engine';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { formatToken } from '@package-broker/core/secrets/token-format';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { createAccessRepository } from '../repositories/access.js';
import { createGrantRepository } from '../repositories/grant.js';
import { createProjectGrantRepository, projectGrantKey } from '../repositories/project-grant.js';
import { createTokenRepository } from '../repositories/token.js';
import { seedTwoOrganizations } from './two-organizations.js';

export interface OpenedTokenDatabase {
  readonly executor: SqlExecutor;
  close(): Promise<void>;
}
type Open = () => Promise<OpenedTokenDatabase>;
type Wrap = (executor: SqlExecutor) => SqlExecutor;
type Case = (open: Open, wrap?: Wrap) => Promise<void>;
const USER = 'contract-user';
const SERVICE = 'contract-service';
const SESSION = 'contract-session';
const IDENTITY = 'contract-identity';
const SELECTOR = 'abcdefghijkl';
const PERMISSIONS = ['project:packages:read', 'project:packages:write', 'project:read'];
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const anchors = Array.from({ length: 3 }, (_, i) => ({
  provider: `idp${i}`,
  anchor: `https://idp${i}.example.test`,
  emailAuthoritative: true,
}));
function st(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}
function iso(offset: number): string {
  return new Date(Date.now() + offset).toISOString();
}

async function fixture(
  open: Open,
  run: (executor: SqlExecutor, ctx: OrgContext, other: OrgContext) => Promise<void>,
  wrap: Wrap = (e) => e,
) {
  const db = await open();
  try {
    const executor = wrap(db.executor);
    const { a, b } = await seedTwoOrganizations(executor);
    await executor.batch([
      st(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        USER,
        a.orgId,
        'contract@example.test',
      ),
      st(
        "INSERT INTO role (id, org_id, key, name, scope) VALUES ('contract-role', ?, 'contract', 'Contract', 'organization')",
        a.orgId,
      ),
      ...PERMISSIONS.map((permission) =>
        st(
          "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'contract-role', ?)",
          a.orgId,
          permission,
        ),
      ),
      st(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('contract-grant', ?, 'email', ?, 'organization', 'contract-role')",
        a.orgId,
        'contract@example.test',
      ),
      ...['alpha', 'beta'].map((slug) =>
        st(
          'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
          slug,
          a.orgId,
          slug,
          slug,
        ),
      ),
      ...anchors.map(({ provider, anchor }) =>
        st(
          'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
          a.orgId,
          provider,
          anchor,
        ),
      ),
      st(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        IDENTITY,
        a.orgId,
        USER,
        'idp0',
        'contract-subject',
        'contract@example.test',
        iso(-60_000),
      ),
      st(
        'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        SESSION,
        a.orgId,
        USER,
        IDENTITY,
        'a'.repeat(64),
        'b'.repeat(64),
        iso(3_600_000),
        iso(-60_000),
      ),
      st(
        'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
        SERVICE,
        a.orgId,
        'Contract',
        USER,
      ),
      ...PERMISSIONS.map((permission) =>
        st(
          'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
          a.orgId,
          SERVICE,
          permission,
        ),
      ),
    ]);
    await run(executor, a, b);
  } finally {
    await db.close();
  }
}

async function insertToken(
  executor: SqlExecutor,
  ctx: OrgContext,
  kind: 'pat' | 'svc',
  mode = 'all',
) {
  const plaintext = formatToken(kind, SELECTOR, new Uint8Array(32).fill(9));
  const hash = await hashToken(keyring, 1, plaintext);
  await executor.batch([
    st(
      'INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, service_principal_id, project_mode, validation_kind, validation_identity_id, expires_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
      'contract-token',
      ctx.orgId,
      kind,
      SELECTOR,
      hash,
      'Contract',
      '["full"]',
      kind === 'pat' ? USER : null,
      kind === 'svc' ? SERVICE : null,
      mode,
      kind === 'pat' ? 'sso' : null,
      kind === 'pat' ? IDENTITY : null,
      iso(3_600_000),
    ),
  ]);
  return plaintext;
}

function lookup(
  executor: SqlExecutor,
  ctx: OrgContext,
  projectSlug: string | null,
  providerAnchors = anchors,
) {
  return createAccessRepository(executor).lookupToken(ctx, {
    selector: SELECTOR,
    boundary: 'project',
    projectSlug,
    providerAnchors,
  });
}
function decision(
  executor: SqlExecutor,
  ctx: OrgContext,
  plaintext: string,
  slug: string | null,
  permission = 'project:packages:read',
) {
  const engine = createAuthorizationEngine({
    access: createAccessRepository(executor),
    tokenUse: { keyring, nowMs: Date.now, dispatch: () => {}, log: () => {} },
    patValidation: patValidationGate,
    providerAnchors: async () => anchors,
    publicOrigin: 'https://broker.example.test',
  });
  return engine.authorize({
    org: ctx,
    request: new Request('https://broker.example.test/packages', {
      headers: { authorization: `Bearer ${plaintext}` },
    }),
    route: {
      plugin: 'contract',
      method: 'GET',
      path: '/packages',
      permission,
      boundary: 'project',
    },
    params: slug === null ? {} : { project: slug },
  });
}

const nullSlug: Case = (open, wrap) =>
  fixture(
    open,
    async (executor, ctx) => {
      const plaintext = await insertToken(executor, ctx, 'svc');
      const found = await lookup(executor, ctx, null);
      expect(found).not.toBeNull();
      expect(found?.project).toBeNull();
      expect(found?.projectPermissions).toEqual([]);
      expect(found?.organizationPermissions).toEqual([]);
      expect(await decision(executor, ctx, plaintext, null)).toEqual({ allow: false, status: 404 });
    },
    wrap,
  );

const projectCap: Case = (open, wrap) =>
  fixture(
    open,
    async (executor, ctx) => {
      const plaintext = await insertToken(executor, ctx, 'svc');
      expect((await lookup(executor, ctx, 'alpha'))?.projectPermissions).toEqual(PERMISSIONS);
      await executor.batch([st("UPDATE project SET token_max_scope = 'read' WHERE id = 'alpha'")]);
      expect((await lookup(executor, ctx, 'alpha'))?.projectPermissions).toEqual([
        'project:packages:read',
        'project:read',
      ]);
      expect(await decision(executor, ctx, plaintext, 'alpha')).toMatchObject({
        allow: true,
        projectId: 'alpha',
      });
      expect(await decision(executor, ctx, plaintext, 'alpha', 'project:packages:write')).toEqual({
        allow: false,
        status: 403,
      });
    },
    wrap,
  );

const creatorRemoved: Case = (open, wrap) =>
  fixture(
    open,
    async (executor, ctx) => {
      const plaintext = await insertToken(executor, ctx, 'svc');
      const before = await lookup(executor, ctx, 'alpha');
      expect(before?.projectPermissions).toEqual(PERMISSIONS);
      const beforeDecision = await decision(executor, ctx, plaintext, 'alpha');
      expect(beforeDecision).toMatchObject({
        allow: true,
        principal: { kind: 'service', id: SERVICE },
      });
      await executor.batch([
        st(
          "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'contract-role', 'org:grants:write')",
          ctx.orgId,
        ),
      ]);
      const grants = createGrantRepository(executor, {
        holderInput: () => ({ kind: 'fresh', now: iso(0), providers: anchors }),
        providerAnchors: anchors,
      });
      const [grant] = await grants.listOrganization(ctx);
      expect(grant).toBeDefined();
      expect(
        await grants.deleteOrganization(
          ctx,
          mutationFence({ userId: USER, sessionId: SESSION } as unknown as AuthenticatedActor, {
            grant: grant!.revision,
          }),
          grant!.id,
          'contract-remove-creator',
        ),
      ).toBe('deleted');
      expect(
        await executor.all(st('SELECT id FROM access_grant WHERE org_id = ?', ctx.orgId)),
      ).toEqual([]);
      expect(await executor.all(st('SELECT status FROM user_account WHERE id = ?', USER))).toEqual([
        { status: 'active' },
      ]);
      expect(await lookup(executor, ctx, 'alpha')).toEqual(before);
      expect(await decision(executor, ctx, plaintext, 'alpha')).toEqual(beforeDecision);
    },
    wrap,
  );

const emptySelected: Case = (open, wrap) =>
  fixture(
    open,
    async (executor, ctx) => {
      const plaintext = await insertToken(executor, ctx, 'pat', 'selected');
      const expected = { alpha: 403, beta: 403, missing: 404 } as const;
      for (const slug of ['alpha', 'beta', 'missing'] as const) {
        const found = await lookup(executor, ctx, slug);
        expect(found).not.toBeNull();
        expect(found?.validation?.fresh).toBe(true);
        expect(found?.project).toBeNull();
        expect(found?.projectPermissions).toEqual([]);
        expect(await decision(executor, ctx, plaintext, slug)).toEqual({
          allow: false,
          status: expected[slug],
        });
      }
    },
    wrap,
  );

function ssoAnchors(count: number): Case {
  return (open, wrap) =>
    fixture(
      open,
      async (executor, ctx) => {
        const providerAnchors = anchors.slice(0, count);
        const lengths: number[] = [];
        const record = (statement: Statement) => {
          lengths.push(statement.params.length);
          return statement;
        };
        const measured: SqlExecutor = {
          driver: executor.driver,
          all: (statement) => executor.all(record(statement)),
          batch: (statements) => executor.batch(statements.map(record)),
        };
        const plaintext = formatToken('pat', SELECTOR, new Uint8Array(32).fill(9));
        const hash = await hashToken(keyring, 1, plaintext);
        const result = await createTokenRepository(measured).issuePersonal(
          ctx,
          mutationFence({ userId: USER, sessionId: SESSION } as unknown as AuthenticatedActor, {}),
          {
            id: 'issued-token',
            name: 'Contract',
            scope: 'full',
            projectMode: 'all',
            projectIds: [],
            validation: { kind: 'sso', identityId: IDENTITY },
            providerAnchors,
            now: iso(0),
            expiresAt: iso(3_600_000),
          },
          () => ({ selector: SELECTOR, hash, pepperVersion: 1, plaintext }),
        );
        expect(result.status).toBe('issued');
        for (const slug of ['alpha', 'beta']) {
          const found = await lookup(measured, ctx, slug, providerAnchors);
          expect(found?.token).toMatchObject({
            id: 'issued-token',
            kind: 'pat',
            projectMode: 'all',
            scope: { level: 'full', readOnly: false },
          });
          expect(found?.validation).toMatchObject({
            kind: 'sso',
            identityId: IDENTITY,
            fresh: true,
          });
          expect(found?.projectPermissions).toEqual(PERMISSIONS);
          expect(found?.organizationPermissions).toEqual([]);
          expect(await decision(measured, ctx, plaintext, slug)).toMatchObject({ allow: true });
        }
        expect(
          await executor.all(
            st('SELECT project_id FROM token_project WHERE token_id = ?', 'issued-token'),
          ),
        ).toEqual([]);
        expect(lengths.length).toBeGreaterThan(0);
        expect(Math.max(...lengths)).toBeLessThanOrEqual(100);
      },
      wrap,
    );
}

function inactiveToken(field: 'revoked_at' | 'expires_at'): Case {
  return (open, wrap) =>
    fixture(
      open,
      async (executor, ctx) => {
        const plaintext = await insertToken(executor, ctx, 'svc');
        expect((await lookup(executor, ctx, 'alpha'))?.projectPermissions).toEqual(PERMISSIONS);
        await executor.batch([
          st(`UPDATE token SET ${field} = ? WHERE org_id = ?`, iso(-60_000), ctx.orgId),
        ]);
        const found = await lookup(executor, ctx, 'alpha');
        expect(found !== null).toBe(true);
        expect(found?.token[field === 'revoked_at' ? 'revoked' : 'expired']).toBe(true);
        expect(found?.projectPermissions).toEqual([]);
        expect(found?.organizationPermissions).toEqual([]);
        expect(await decision(executor, ctx, plaintext, 'alpha')).toEqual({
          allow: false,
          status: 401,
        });
      },
      wrap,
    );
}

const crossOrg: Case = (open, wrap) =>
  fixture(
    open,
    async (executor, ctx, other) => {
      const plaintext = await insertToken(executor, ctx, 'svc');
      expect((await lookup(executor, ctx, 'alpha'))?.projectPermissions).toEqual(PERMISSIONS);
      expect((await lookup(executor, other, 'alpha')) === null).toBe(true);
      expect(await decision(executor, other, plaintext, 'alpha')).toEqual({
        allow: false,
        status: 401,
      });
    },
    wrap,
  );

const wrongSelector: Case = (open, wrap) =>
  fixture(
    open,
    async (executor, ctx) => {
      await insertToken(executor, ctx, 'svc');
      expect((await lookup(executor, ctx, 'alpha'))?.projectPermissions).toEqual(PERMISSIONS);
      const found = await createAccessRepository(executor).lookupToken(ctx, {
        selector: 'mnopqrstuvwx',
        boundary: 'project',
        projectSlug: 'alpha',
        providerAnchors: anchors,
      });
      expect(found === null).toBe(true);
    },
    wrap,
  );

const projectBinding: Case = (open, wrap) =>
  fixture(
    open,
    async (executor, ctx) => {
      const plaintext = await insertToken(executor, ctx, 'pat', 'selected');
      await executor.batch([
        st(
          'INSERT INTO token_project (org_id, token_id, project_id) VALUES (?, ?, ?)',
          ctx.orgId,
          'contract-token',
          'alpha',
        ),
      ]);
      expect((await lookup(executor, ctx, 'alpha'))?.projectPermissions).toEqual(PERMISSIONS);
      const found = await lookup(executor, ctx, 'beta');
      expect(found !== null).toBe(true);
      expect(found?.project === null).toBe(true);
      expect(found?.projectPermissions).toEqual([]);
      expect(found?.projectVisible).toBe(true);
      expect(await decision(executor, ctx, plaintext, 'beta')).toEqual({
        allow: false,
        status: 403,
      });
    },
    wrap,
  );

const projectGrantDeleted: Case = (open, wrap) =>
  fixture(
    open,
    async (executor, ctx) => {
      const plaintext = await insertToken(executor, ctx, 'pat');
      await executor.batch([
        st(
          "DELETE FROM role_permission WHERE org_id = ? AND role_id = 'contract-role' AND permission = 'project:packages:write'",
          ctx.orgId,
        ),
        st(
          "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'contract-role', 'project:grants:write')",
          ctx.orgId,
        ),
        st(
          "INSERT INTO role (id, org_id, key, name, scope) VALUES ('project-role', ?, 'project', 'Project', 'project')",
          ctx.orgId,
        ),
        st(
          "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'project-role', 'project:packages:write')",
          ctx.orgId,
        ),
        st(
          "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES ('project-grant', ?, 'email', ?, 'project', 'alpha', 'project-role')",
          ctx.orgId,
          'contract@example.test',
        ),
      ]);
      expect((await lookup(executor, ctx, 'alpha'))?.projectPermissions).toEqual([...PERMISSIONS]);
      expect((await lookup(executor, ctx, 'beta'))?.projectPermissions).toEqual([
        'project:packages:read',
        'project:read',
      ]);
      expect(
        await decision(executor, ctx, plaintext, 'alpha', 'project:packages:write'),
      ).toMatchObject({ allow: true });
      expect(
        await createProjectGrantRepository(executor).delete(
          ctx,
          mutationFence({ userId: USER, sessionId: SESSION } as unknown as AuthenticatedActor, {
            [projectGrantKey('project-grant')]: 1,
          }),
          { id: 'project-grant', projectId: 'alpha', providerAnchors: anchors },
        ),
      ).toEqual({ status: 'deleted', offboardedUserId: null });
      const found = await lookup(executor, ctx, 'alpha');
      expect(found !== null).toBe(true);
      expect(found?.principalStatus).toBe('active');
      expect(found?.projectPermissions).toEqual(['project:packages:read', 'project:read']);
      expect(await decision(executor, ctx, plaintext, 'alpha', 'project:packages:write')).toEqual({
        allow: false,
        status: 403,
      });
    },
    wrap,
  );

export const tokenContractCases = {
  revoked: inactiveToken('revoked_at'),
  expired: inactiveToken('expires_at'),
  crossOrg,
  wrongSelector,
  projectBinding,
  projectGrantDeleted,
  nullSlug,
  projectCap,
  creatorRemoved,
  emptySelected,
  twoAnchors: ssoAnchors(2),
  threeAnchors: ssoAnchors(3),
};
const predicateMutants = [
  ['org', 'crossOrg', '"t"."org_id" = ?', '? is not null'],
  ['selector', 'wrongSelector', '"t"."selector" = ?', '? is not null'],
  ['revoked', 'revoked', '"t"."revoked_at" as "revoked_at"', 'null as "revoked_at"'],
  ['expiry', 'expired', "unixepoch(t.expires_at, 'subsec') > unixepoch('now', 'subsec')", '1 = 1'],
  ['project binding', 'projectBinding', 'tp.project_id = p.id', '1 = 1'],
] as const;

export function describeTokenContract(label: string, open: Open) {
  describe(`token lookup contract (${label})`, () => {
    for (const [predicate, name, before, after] of predicateMutants) {
      it(`catches the ${predicate} SQL mutant with ${name}`, async () => {
        let mutations = 0;
        await expect(
          tokenContractCases[name](open, (executor) => ({
            driver: executor.driver,
            batch: executor.batch.bind(executor),
            all: (statement) => {
              if (!statement.sql.includes('"t"."id" as "token_id"')) return executor.all(statement);
              const sql = statement.sql.replace(before, after);
              if (sql !== statement.sql) mutations += 1;
              return executor.all({ ...statement, sql });
            },
          })),
        ).rejects.toThrow(/expected/);
        expect(mutations).toBeGreaterThan(0);
      }, 120_000);
    }
    it('catches a project grant delete that leaves the grant intact', async () => {
      let mutations = 0;
      await expect(
        projectGrantDeleted(open, (executor) => ({
          driver: executor.driver,
          all: executor.all.bind(executor),
          batch: (statements) =>
            executor.batch(
              statements.map((statement) => {
                if (!statement.sql.startsWith('delete from "access_grant"')) return statement;
                mutations += 1;
                return {
                  ...statement,
                  sql: statement.sql.replace(
                    'delete from "access_grant"',
                    'update "access_grant" set "last_op_id" = "last_op_id"',
                  ),
                };
              }),
            ),
        })),
      ).rejects.toThrow(/expected/);
      expect(mutations).toBeGreaterThan(0);
    }, 120_000);
    for (const [name, run] of Object.entries(tokenContractCases)) {
      it(name, () => run(open), 120_000);
    }
  });
}
