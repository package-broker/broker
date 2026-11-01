import { createOidcVerifier } from '@package-broker/core/registry/npm/oidc/verify';
import {
  claims,
  jwk,
  token,
} from '@package-broker/core/registry/npm/oidc/test-support/signed-fixture';
import { createTokenRepository } from '../repositories/token.js';
import { createOidcExchangeRoute } from '@package-broker/core/registry/npm/oidc/exchange';
import { createWorkloadTokenService } from '@package-broker/core/authz/service-token-service';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { fixedClock } from '@package-broker/core/ids';
import { auditPendingStatement } from '../repositories/audit-pending.js';
import { describe, expect, it } from 'vitest';
import { orgContext, type SqlExecutor, type Statement } from '@package-broker/core/db/port';
import { createOidcReplayExpiryJob } from '@package-broker/core/registry/npm/oidc/expiry';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { createOidcRepository } from '../repositories/oidc.js';
import {
  createWorkloadTokenStore,
  workloadTokenStatements,
  disableTrustedPublisherStatements,
} from '../repositories/workload-token.js';
import { ulid } from '@package-broker/core/ids';
import { auditEvent } from '@package-broker/core/audit/actions';
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
    async function workload() {
      const database = await setup();
      const stamp = new Date().toISOString();
      await database.executor.batch([
        statement(
          "INSERT INTO project (id,org_id,slug,name) VALUES ('workload-project','a','workload','Project')",
        ),
        statement(
          "INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES ('principal-alt','a','Alternate','user-a')",
        ),
        statement(
          "INSERT INTO service_principal_permission VALUES ('a', 'principal-a', 'org:packages:publish')",
        ),
        statement(
          "INSERT INTO source (id,org_id,name,ecosystem,type) VALUES ('hosted','a','Hosted','npm','hosted')",
        ),
        statement(
          "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('claim','a','hosted','npm','test')",
        ),
      ]);
      const binding = (await database.repo.find(orgContext('a'), match))[0]!;
      const event = auditEvent({
        id: ulid(),
        now: stamp,
        action: 'token.workload_issue',
        actor: { type: 'service_principal', id: 'principal-a' },
        context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
        target: { type: 'token', id: 'workload' },
      });
      if (!event.ok) throw new Error('fixture');
      const fence = {
        publisher: binding,
        replay: database.repo.reserveStatements(orgContext('a'), {
          issuer,
          jti: 'workload-jti',
          trustedPublisherId: binding.id,
          expectedRevision: binding.revision,
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          now: stamp,
        }),
      };
      const input = {
        id: 'workload',
        now: stamp,
        expiresAt: new Date(Date.parse(stamp) + 900000).toISOString(),
        audit: event.event,
      };
      const mint = () => ({
        selector: 'abcdefghijkl',
        hash: 'a'.repeat(64),
        pepperVersion: 1,
        plaintext: 'pb_svc_abcdefghijkl_' + 'a'.repeat(43),
      });
      return {
        ...database,
        fence,
        input,
        mint,
        store: createWorkloadTokenStore(database.executor),
      };
    }
    it('issues a package-bound 15-minute workload token without a session and appends replay atomically', async () => {
      const db = await workload();
      try {
        expect(await db.store.issueWorkload(orgContext('a'), db.fence, db.input, db.mint)).toEqual({
          status: 'issued',
          id: 'workload',
          plaintext: db.mint().plaintext,
        });
        expect(
          await db.executor.all(
            statement(
              "SELECT kind, scopes_json, read_only, project_mode, project_id, created_by_user_id, trusted_publisher_id, package_name, expires_at FROM token WHERE id='workload'",
            ),
          ),
        ).toEqual([
          {
            kind: 'svc',
            scopes_json: '["write"]',
            read_only: 0,
            project_mode: 'all',
            project_id: null,
            created_by_user_id: null,
            trusted_publisher_id: 'publisher-a',
            package_name: 'test',
            expires_at: db.input.expiresAt,
          },
        ]);
        expect(
          await createTokenRepository(db.executor).getService(orgContext('a'), 'workload'),
        ).toBeNull();
        expect(
          await db.executor.all(
            statement("SELECT last_used_at FROM trusted_publisher WHERE id='publisher-a'"),
          ),
        ).toEqual([{ last_used_at: db.input.now }]);
        expect(
          await db.executor.all(statement("SELECT action FROM audit_pending WHERE org_id='a'")),
        ).toEqual([{ action: 'token.workload_issue' }]);
        expect(
          await db.store.issueWorkload(
            orgContext('a'),
            db.fence,
            { ...db.input, id: 'second', audit: { ...db.input.audit, id: ulid() } },
            () => ({
              ...db.mint(),
              selector: 'bcdefghijklm',
              plaintext: 'pb_svc_bcdefghijklm_' + 'a'.repeat(43),
            }),
          ),
        ).not.toHaveProperty('status', 'issued');
        expect(await db.executor.all(statement('SELECT id FROM token'))).toHaveLength(1);
      } finally {
        await db.close();
      }
    });
    it.each([
      'disabled',
      'revision',
      'principal',
      'permission',
      'extra_permission',
      'claim',
      'source',
      'organization',
      'expiry',
      'principal_binding',
      'claim_binding',
      'package_binding',
      'source_type',
      'source_ecosystem',
      'claim_ecosystem',
      'source_project',
      'principal_project',
      'duration',
      'expired',
      'future_clock',
    ])('workload issuance fails closed for %s and consumes no replay or audit', async (guard) => {
      const db = await workload();
      try {
        const sql = (() => {
          switch (guard) {
            case 'disabled':
              return "UPDATE trusted_publisher SET disabled_at='2026-01-01' WHERE id='publisher-a'";
            case 'revision':
              return "UPDATE trusted_publisher SET revision=2 WHERE id='publisher-a'";
            case 'principal':
              return "UPDATE service_principal SET status='suspended' WHERE id='principal-a'";
            case 'permission':
              return "DELETE FROM service_principal_permission WHERE org_id='a'";
            case 'extra_permission':
              return "INSERT INTO service_principal_permission VALUES ('a','principal-a','org:read')";
            case 'claim':
              return "DELETE FROM registered_name WHERE org_id='a'";
            case 'source':
              return "UPDATE source SET status='paused' WHERE org_id='a'";
            case 'claim_binding':
              return "UPDATE registered_name SET pattern='other' WHERE org_id='a'";
            case 'source_ecosystem':
              return "UPDATE source SET ecosystem='composer' WHERE org_id='a'";
            case 'claim_ecosystem':
              return "UPDATE registered_name SET ecosystem='composer' WHERE org_id='a'";
            case 'source_type':
              return "UPDATE source SET type='npmjs_proxy' WHERE org_id='a'";
            case 'source_project':
              return "UPDATE source SET project_id='workload-project' WHERE org_id='a'";
            case 'principal_project':
              return "UPDATE service_principal SET project_id='workload-project' WHERE id='principal-a'";
          }
        })();
        if (sql) await db.executor.all(statement(sql));
        if (guard === 'package_binding')
          await db.executor.all(
            statement(
              "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('other-claim','a','hosted','npm','other')",
            ),
          );
        const result = await db.store.issueWorkload(
          orgContext(guard === 'organization' ? 'b' : 'a'),
          guard === 'principal_binding'
            ? {
                ...db.fence,
                publisher: { ...db.fence.publisher, servicePrincipalId: 'principal-alt' },
              }
            : guard === 'package_binding'
              ? { ...db.fence, publisher: { ...db.fence.publisher, packageName: 'other' } }
              : db.fence,
          guard === 'expiry'
            ? { ...db.input, expiresAt: new Date(Date.parse(db.input.now) + 900001).toISOString() }
            : guard === 'duration'
              ? {
                  ...db.input,
                  expiresAt: new Date(Date.parse(db.input.now) + 899000).toISOString(),
                }
              : guard === 'expired'
                ? {
                    ...db.input,
                    now: new Date(Date.parse(db.input.now) - 901000).toISOString(),
                    expiresAt: new Date(Date.parse(db.input.now) - 1000).toISOString(),
                  }
                : guard === 'future_clock'
                  ? {
                      ...db.input,
                      now: new Date(Date.parse(db.input.now) + 60000).toISOString(),
                      expiresAt: new Date(Date.parse(db.input.now) + 960000).toISOString(),
                    }
                  : db.input,
          db.mint,
        );
        expect(result.status).not.toBe('issued');
        expect(await db.executor.all(statement('SELECT id FROM token'))).toEqual([]);
        expect(await db.executor.all(statement('SELECT id FROM audit_pending'))).toEqual([]);
        expect(await db.executor.all(statement('SELECT jti FROM oidc_replay'))).toEqual([]);
        expect(
          await db.executor.all(
            statement("SELECT last_used_at FROM trusted_publisher WHERE id='publisher-a'"),
          ),
        ).toEqual([{ last_used_at: null }]);
      } finally {
        await db.close();
      }
    });
    it('disabling a publisher revokes its live tokens atomically and preserves other publishers', async () => {
      const db = await workload();
      try {
        expect(
          (await db.store.issueWorkload(orgContext('a'), db.fence, db.input, db.mint)).status,
        ).toBe('issued');
        const disabled = auditEvent({
          id: ulid(),
          now: db.input.now,
          action: 'trusted_publisher.disable',
          actor: { type: 'user', id: 'user-a' },
          context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
          target: { type: 'trusted_publisher', id: 'publisher-a' },
        });
        if (!disabled.ok) throw new Error('fixture');
        const batch = disableTrustedPublisherStatements(orgContext('a'), {
          id: 'publisher-a',
          expectedRevision: 1,
          now: db.input.now,
          audit: disabled.event,
        });
        await db.executor.batch(batch);
        expect(
          await db.executor.all(statement("SELECT revoked_at FROM token WHERE id='workload'")),
        ).toEqual([{ revoked_at: db.input.now }]);
        expect(
          await db.executor.all(
            statement("SELECT disabled_at,revision FROM trusted_publisher WHERE id='publisher-a'"),
          ),
        ).toEqual([{ disabled_at: db.input.now, revision: 2 }]);
        expect(
          await db.executor.all(
            statement("SELECT disabled_at FROM trusted_publisher WHERE id='publisher-b'"),
          ),
        ).toEqual([{ disabled_at: null }]);
        await expect(db.executor.batch(batch)).rejects.toThrow();
        expect(
          await db.executor.all(
            statement("SELECT id FROM audit_pending WHERE action='trusted_publisher.disable'"),
          ),
        ).toHaveLength(1);
      } finally {
        await db.close();
      }
    });
    it('concurrent exchanges consume one jti and issue exactly one secret and audit', async () => {
      const db = await workload();
      try {
        const result = await Promise.all(
          ['abcdefghijkl', 'bcdefghijklm'].map((selector, index) =>
            db.store.issueWorkload(
              orgContext('a'),
              db.fence,
              { ...db.input, id: 'concurrent-' + index, audit: { ...db.input.audit, id: ulid() } },
              () => ({
                ...db.mint(),
                selector,
                plaintext: 'pb_svc_' + selector + '_' + 'a'.repeat(43),
              }),
            ),
          ),
        );
        expect(result.filter((r) => r.status === 'issued')).toHaveLength(1);
        for (const table of ['token', 'oidc_replay', 'audit_pending'])
          expect(await db.executor.all(statement('SELECT * FROM ' + table))).toHaveLength(1);
      } finally {
        await db.close();
      }
    });
    it('retries selector collisions with a hard three-attempt cap without consuming replay', async () => {
      const db = await workload();
      try {
        await db.executor.all(
          statement(
            "INSERT INTO token (id,org_id,kind,selector,hash,pepper_version,name,scopes_json,service_principal_id,expires_at,project_mode) VALUES ('existing','a','svc','abcdefghijkl',?,1,'existing','[\"write\"]','principal-a','2099-01-01T00:00:00.000Z','all')",
            'b'.repeat(64),
          ),
        );
        let calls = 0;
        expect(
          await db.store.issueWorkload(orgContext('a'), db.fence, db.input, () => {
            calls++;
            return db.mint();
          }),
        ).toEqual({ status: 'refused', reason: 'selector_collision' });
        expect(calls).toBe(3);
        expect(await db.executor.all(statement('SELECT jti FROM oidc_replay'))).toEqual([]);
        calls = 0;
        expect(
          (
            await db.store.issueWorkload(orgContext('a'), db.fence, db.input, () => {
              calls++;
              return calls === 1
                ? db.mint()
                : {
                    ...db.mint(),
                    selector: 'bcdefghijklm',
                    plaintext: 'pb_svc_bcdefghijklm_' + 'a'.repeat(43),
                  };
            })
          ).status,
        ).toBe('issued');
        expect(calls).toBe(2);
      } finally {
        await db.close();
      }
    });
    it('a failing audit insert rolls back issuance, last use and replay and permits a retry', async () => {
      const db = await workload();
      try {
        await db.executor.batch([auditPendingStatement(orgContext('a'), db.input.audit)]);
        expect(
          (await db.store.issueWorkload(orgContext('a'), db.fence, db.input, db.mint)).status,
        ).not.toBe('issued');
        expect(await db.executor.all(statement('SELECT id FROM token'))).toEqual([]);
        expect(await db.executor.all(statement('SELECT jti FROM oidc_replay'))).toEqual([]);
        expect(
          await db.executor.all(
            statement("SELECT last_used_at FROM trusted_publisher WHERE id='publisher-a'"),
          ),
        ).toEqual([{ last_used_at: null }]);
        expect(
          (
            await db.store.issueWorkload(
              orgContext('a'),
              db.fence,
              { ...db.input, audit: { ...db.input.audit, id: ulid() } },
              db.mint,
            )
          ).status,
        ).toBe('issued');
      } finally {
        await db.close();
      }
    });
    it('a failed disable audit rolls back publisher state and token revocation', async () => {
      const db = await workload();
      try {
        expect(
          (await db.store.issueWorkload(orgContext('a'), db.fence, db.input, db.mint)).status,
        ).toBe('issued');
        const audit = { ...db.input.audit, action: 'trusted_publisher.disable' as const };
        await expect(
          db.executor.batch(
            disableTrustedPublisherStatements(orgContext('a'), {
              id: 'publisher-a',
              expectedRevision: 1,
              now: db.input.now,
              audit,
            }),
          ),
        ).rejects.toThrow();
        expect(
          await db.executor.all(
            statement("SELECT disabled_at,revision FROM trusted_publisher WHERE id='publisher-a'"),
          ),
        ).toEqual([{ disabled_at: null, revision: 1 }]);
        expect(
          await db.executor.all(statement("SELECT revoked_at FROM token WHERE id='workload'")),
        ).toEqual([{ revoked_at: null }]);
      } finally {
        await db.close();
      }
    });
    it.each([false, true])(
      'serves signed host-root exchange with real verification, issuance, replay and disable (long claims: %s)',
      async (long) => {
        const db = await workload();
        try {
          const workflow = long ? 'w'.repeat(251) + '.yml' : 'publish.yml';
          const environment = long ? 'e'.repeat(255) : '';
          const uuidRef = 'refs/heads/release-123e4567-e89b-12d3-a456-426614174000';
          const ref = long ? uuidRef + 'r'.repeat(1024 - uuidRef.length) : uuidRef;
          await db.executor.all(
            statement(
              "UPDATE trusted_publisher SET workflow=?, environment=? WHERE id='publisher-a'",
              workflow,
              environment,
            ),
          );
          const signedClaims = {
            ...claims,
            aud: 'npm:broker.test',
            iat: Math.floor(Date.parse(db.input.now) / 1000),
            nbf: Math.floor(Date.parse(db.input.now) / 1000),
            exp: Math.floor(Date.parse(db.input.now) / 1000) + 300,
            workflow_ref: `owner/repo/.github/workflows/${workflow}@refs/tags/v1`,
            environment,
            ref,
          };
          const jwt = await token(signedClaims);
          const clock = fixedClock(db.input.now);
          const tokens = createWorkloadTokenService({
            tokens: db.store,
            keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
            clock,
            ids: { ulid },
          });
          const route = createOidcExchangeRoute({
            repository: db.repo,
            tokens,
            clock,
            organization: async () => orgContext('a'),
            verify: createOidcVerifier({
              publicUrl: 'https://broker.test',
              policyFetch: async () => ({
                status: 200,
                headers: new Headers(),
                body: new Response(JSON.stringify({ keys: [jwk] })).body,
              }),
            }),
          });
          const kernel = await createKernel({
            platform: backend === 'D1' ? 'cloudflare' : 'node',
            plugins: [],
            ports: { organizations: { get: async () => null }, clock, ids: { ulid } },
            resolveOrg: async () => orgContext('a'),
            health: async () => true,
            log: () => undefined,
            ecosystemRoutes: [route],
          });
          const call = (bearer = jwt) =>
            kernel.fetch(
              new Request('https://broker.test/-/npm/v1/oidc/token/exchange/package/test', {
                method: 'POST',
                headers: { authorization: `Bearer ${bearer}` },
              }),
            );
          for (const patch of [{ exp: signedClaims.iat - 61 }, { aud: 'npm:other.test' }]) {
            const invalid = await call(await token({ ...signedClaims, ...patch }));
            expect(invalid.status).toBe(401);
            expect(await invalid.json()).toMatchObject({ code: 'invalid_oidc_token' });
            for (const table of ['token', 'oidc_replay', 'audit_pending'])
              expect(await db.executor.all(statement('SELECT * FROM ' + table))).toEqual([]);
          }
          const first = await call();
          expect(first.status).toBe(201);
          expect(first.headers.get('cache-control')).toBe('no-store');
          const body = (await first.json()) as {
            token: string;
            token_type: string;
            created: string;
            expires: string;
          };
          expect(body).toEqual({
            token_type: 'oidc',
            token: expect.stringMatching(/^pb_svc_/),
            created: db.input.now,
            expires: db.input.expiresAt,
          });
          expect((await call()).status).toBe(403);
          for (const table of ['token', 'oidc_replay', 'audit_pending'])
            expect(await db.executor.all(statement('SELECT * FROM ' + table))).toHaveLength(1);
          const audits = await db.executor.all<{ payload_json: string }>(
            statement("SELECT payload_json FROM audit_pending WHERE action='token.workload_issue'"),
          );
          expect(JSON.parse(audits[0]!.payload_json)).toMatchObject({
            changes: {
              workflow: { new: workflow },
              environment: { new: environment },
              ref: { new: ref },
            },
          });
          const disabled = {
            ...db.input.audit,
            id: ulid(),
            action: 'trusted_publisher.disable' as const,
          };
          await db.executor.batch(
            disableTrustedPublisherStatements(orgContext('a'), {
              id: 'publisher-a',
              expectedRevision: 1,
              now: db.input.now,
              audit: disabled,
            }),
          );
          expect((await call()).status).toBe(403);
          expect(
            await db.executor.all(
              statement("SELECT package_name, revoked_at FROM token WHERE org_id='a'"),
            ),
          ).toEqual([{ package_name: 'test', revoked_at: db.input.now }]);
        } finally {
          await db.close();
        }
      },
    );
    it('orders disable and concurrent issuance so no live token survives a disabled publisher', async () => {
      const db = await workload();
      try {
        await Promise.allSettled([
          db.store.issueWorkload(orgContext('a'), db.fence, db.input, db.mint),
          db.executor.batch(
            disableTrustedPublisherStatements(orgContext('a'), {
              id: 'publisher-a',
              expectedRevision: 1,
              now: db.input.now,
              audit: { ...db.input.audit, id: ulid(), action: 'trusted_publisher.disable' },
            }),
          ),
        ]);
        expect(
          await db.executor.all(
            statement("SELECT disabled_at FROM trusted_publisher WHERE id='publisher-a'"),
          ),
        ).toEqual([{ disabled_at: db.input.now }]);
        expect(
          await db.executor.all(
            statement("SELECT id FROM token WHERE org_id='a' AND revoked_at IS NULL"),
          ),
        ).toEqual([]);
      } finally {
        await db.close();
      }
    });
    it('disable compare-and-set rejects stale revisions and already-disabled rows without extra audits', async () => {
      const db = await workload();
      try {
        const input = {
          id: 'publisher-a',
          expectedRevision: 99,
          now: db.input.now,
          audit: { ...db.input.audit, id: ulid(), action: 'trusted_publisher.disable' as const },
        };
        await expect(
          db.executor.batch(disableTrustedPublisherStatements(orgContext('a'), input)),
        ).rejects.toThrow();
        expect(
          await db.executor.all(
            statement("SELECT disabled_at FROM trusted_publisher WHERE id='publisher-a'"),
          ),
        ).toEqual([{ disabled_at: null }]);
        await db.executor.batch(
          disableTrustedPublisherStatements(orgContext('a'), { ...input, expectedRevision: 1 }),
        );
        await expect(
          db.executor.batch(
            disableTrustedPublisherStatements(orgContext('a'), {
              ...input,
              expectedRevision: 2,
              audit: { ...input.audit, id: ulid() },
            }),
          ),
        ).rejects.toThrow();
        expect(await db.executor.all(statement('SELECT id FROM audit_pending'))).toHaveLength(1);
      } finally {
        await db.close();
      }
    });
    it('disable revokes only its live tokens and retains prior revocation and expired history', async () => {
      const db = await workload();
      try {
        await db.store.issueWorkload(orgContext('a'), db.fence, db.input, db.mint);
        for (const [id, selector, publisher, principal, expiry, revoked] of [
          [
            'expired',
            'bcdefghijklm',
            'publisher-a',
            'principal-a',
            '2020-01-01T00:00:00.000Z',
            null,
          ],
          [
            'revoked',
            'cdefghijklmn',
            'publisher-a',
            'principal-a',
            '2099-01-01T00:00:00.000Z',
            '2020-01-01T00:00:00.000Z',
          ],
          [
            'foreign',
            'defghijklmno',
            'publisher-b',
            'principal-b',
            '2099-01-01T00:00:00.000Z',
            null,
          ],
        ])
          await db.executor.all(
            statement(
              "INSERT INTO token (id,org_id,kind,selector,hash,pepper_version,name,scopes_json,service_principal_id,expires_at,revoked_at,project_mode,trusted_publisher_id,package_name) VALUES (?,?,'svc',?,?,1,'workload','[\"write\"]',?,?,?,'all',?,'test')",
              id!,
              id === 'foreign' ? 'b' : 'a',
              selector!,
              'a'.repeat(64),
              principal!,
              expiry!,
              revoked!,
              publisher!,
            ),
          );
        await db.executor.batch(
          disableTrustedPublisherStatements(orgContext('a'), {
            id: 'publisher-a',
            expectedRevision: 1,
            now: db.input.now,
            audit: { ...db.input.audit, id: ulid(), action: 'trusted_publisher.disable' },
          }),
        );
        expect(
          await db.executor.all(statement('SELECT id,revoked_at FROM token ORDER BY id')),
        ).toEqual([
          { id: 'expired', revoked_at: null },
          { id: 'foreign', revoked_at: null },
          { id: 'revoked', revoked_at: '2020-01-01T00:00:00.000Z' },
          { id: 'workload', revoked_at: db.input.now },
        ]);
      } finally {
        await db.close();
      }
    });
    it('issues an exact package binding through a hosted scope wildcard', async () => {
      const db = await workload();
      try {
        await db.executor.batch([
          statement(
            "UPDATE trusted_publisher SET package_name='@scope/test' WHERE id='publisher-a'",
          ),
          statement("UPDATE registered_name SET pattern='@scope/*' WHERE org_id='a'"),
        ]);
        const fence = {
          ...db.fence,
          publisher: { ...db.fence.publisher, packageName: '@scope/test' },
        };
        expect(
          (await db.store.issueWorkload(orgContext('a'), fence, db.input, db.mint)).status,
        ).toBe('issued');
        expect(
          await db.executor.all(statement("SELECT package_name FROM token WHERE id='workload'")),
        ).toEqual([{ package_name: '@scope/test' }]);
      } finally {
        await db.close();
      }
    });
    it('rejects malformed timestamps and minted credentials before executing SQL', async () => {
      const db = await workload();
      try {
        for (const minted of [
          { ...db.mint(), selector: 'bad' },
          { ...db.mint(), hash: 'bad' },
          { ...db.mint(), pepperVersion: 0 },
          { ...db.mint(), pepperVersion: 1.5 },
          { ...db.mint(), plaintext: 'secret@example.test' },
          { ...db.mint(), plaintext: 'pb_svc_bcdefghijklm_' + 'a'.repeat(43) },
        ])
          expect(() =>
            workloadTokenStatements(orgContext('a'), db.fence, db.input, minted),
          ).toThrow('invalid_workload_input');
        for (const stamp of [
          '2026-10-31',
          '2026-99-99T00:00:00.000Z',
          '2026-02-30T00:00:00.000Z',
        ]) {
          expect(() =>
            workloadTokenStatements(
              orgContext('a'),
              db.fence,
              { ...db.input, now: stamp },
              db.mint(),
            ),
          ).toThrow('invalid_workload_input');
          expect(() =>
            workloadTokenStatements(
              orgContext('a'),
              db.fence,
              { ...db.input, expiresAt: stamp },
              db.mint(),
            ),
          ).toThrow('invalid_workload_input');
        }
        expect(await db.executor.all(statement('SELECT id FROM token'))).toEqual([]);
      } finally {
        await db.close();
      }
    });
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
