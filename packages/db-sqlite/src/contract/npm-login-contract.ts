import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { auditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import type { JobContext } from '@package-broker/core/platform/jobs';
import {
  createNpmLoginExpiryJob,
  createNpmLoginExpiryRepository,
} from '../repositories/npm-login-expire.js';
import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { orgContext } from '@package-broker/core/db/port';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { base64urlEncode } from '@package-broker/core/auth/primitives';
import { createNpmLoginRepository } from '../repositories/npm-login.js';
import { createJobRepository, JOB_UNREGISTERED_GRACE_SECONDS } from '../repositories/job.js';
import { createJobScheduleRepository } from '../repositories/job-schedule.js';
const keys = () => createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]);
export function describeNpmLoginContract(
  name: string,
  open: () => Promise<{ executor: SqlExecutor; close(): void | Promise<void> }>,
) {
  describe(`npm login ${name}`, () => {
    async function run(body: (executor: SqlExecutor) => Promise<void>) {
      const pair = await open();
      try {
        await pair.executor.batch([
          { sql: 'DROP INDEX organization_singleton', params: [] },
          {
            sql: "INSERT INTO organization (id,slug,name) VALUES ('org','test','Test')",
            params: [],
          },
          {
            sql: "INSERT INTO organization (id,slug,name) VALUES ('other','other','Other')",
            params: [],
          },
          {
            sql: "INSERT INTO project (id,org_id,slug,name) VALUES ('project','org','test','Test')",
            params: [],
          },
        ]);
        await body(pair.executor);
      } finally {
        await pair.close();
      }
    }
    it('atomically caps pending sessions and scopes confirmation and polling', () =>
      run(async (executor) => {
        const repo = createNpmLoginRepository(executor, keys());
        const ctx = orgContext('org');
        for (let n = 0; n < 20; n++)
          expect(
            await repo.start(ctx, {
              id: String(n),
              projectId: 'project',
              selectorHash: n.toString(16).padStart(64, '0'),
              doneHash: (n + 100).toString(16).padStart(64, '0'),
              hostname: 'cli',
              sourceIp: null,
            }),
          ).toBe(true);
        expect(
          await repo.start(ctx, {
            id: 'overflow',
            projectId: 'project',
            selectorHash: 'e'.repeat(64),
            doneHash: 'f'.repeat(64),
            hostname: null,
            sourceIp: null,
          }),
        ).toBe(false);
        expect((await repo.confirmation(ctx, '0'.repeat(64)))?.cliHostname).toBe('cli');
        expect(await repo.confirmation(orgContext('other'), '0'.repeat(64))).toBeNull();
        expect(
          await repo.start(orgContext('other'), {
            id: 'foreign',
            projectId: 'project',
            selectorHash: 'e'.repeat(64),
            doneHash: 'f'.repeat(64),
            hostname: null,
            sourceIp: null,
          }),
        ).toBe(false);
        expect(
          await repo.poll(
            orgContext('other'),
            'project',
            (100).toString(16).padStart(64, '0'),
            () => {},
          ),
        ).toEqual({ status: 'not_found' });
        expect(
          await repo.poll(ctx, 'wrong', (100).toString(16).padStart(64, '0'), () => {}),
        ).toEqual({
          status: 'not_found',
        });
      }));
    it('caps the organization at 200 pending sessions across projects', () =>
      run(async (executor) => {
        const repo = createNpmLoginRepository(executor, keys());
        const ctx = orgContext('org');
        for (let project = 0; project < 11; project++) {
          await executor.all({
            sql: 'INSERT INTO project (id,org_id,slug,name) VALUES (?, ?, ?, ?)',
            params: [`p${project}`, 'org', `p${project}`, 'Project'],
          });
          for (let n = 0; n < 20; n++) {
            const id = project * 20 + n;
            expect(
              await repo.start(ctx, {
                id: `s${id}`,
                projectId: `p${project}`,
                selectorHash: id.toString(16).padStart(64, '0'),
                doneHash: (id + 1000).toString(16).padStart(64, '0'),
                hostname: null,
                sourceIp: null,
              }),
            ).toBe(project < 10);
            if (project === 10) break;
          }
        }
      }));
    it('upgrades the hourly expiry schedule to v2 every minute and disables v1', () =>
      run(async (executor) => {
        const ctx = orgContext('org');
        const schedules = createJobScheduleRepository(executor);
        await schedules.sync(ctx, [{ name: 'core:npm-login-expire:v1', everySeconds: 3600 }]);
        const job = createNpmLoginExpiryJob(executor, { enqueue: vi.fn() });
        expect(job.definition.schedule).toEqual({ everySeconds: 60 });
        await schedules.sync(ctx, [{ name: job.qualifiedName, everySeconds: 60 }]);
        expect(
          await executor.all({
            sql: 'SELECT name, every_seconds, enabled FROM job_schedule WHERE org_id = ? ORDER BY name',
            params: [ctx.orgId],
          }),
        ).toEqual([
          { name: 'core:npm-login-expire:v1', every_seconds: 3600, enabled: 0 },
          { name: 'core:npm-login-expire:v2', every_seconds: 60, enabled: 1 },
        ]);
      }));
    it('buries orphaned v1 expiry rows without retries and keeps the v2 schedule claimable', () =>
      run(async (executor) => {
        const ctx = orgContext('org');
        const repository = createJobRepository(executor);
        const schedules = createJobScheduleRepository(executor);
        await schedules.sync(ctx, [{ name: 'core:npm-login-expire:v1', everySeconds: 3600 }]);
        await schedules.tick(ctx);
        await executor.batch([
          {
            sql: "INSERT INTO job (id, org_id, type, payload_json, idempotency_key, run_at, max_attempts) VALUES ('orphan', ?, 'core:npm-login-expire:v1', '{}', 'orphan', '2000-01-01T00:00:00.000Z', 5)",
            params: [ctx.orgId],
          },
        ]);
        const job = createNpmLoginExpiryJob(executor, { enqueue: vi.fn() });
        await schedules.sync(ctx, [{ name: job.qualifiedName, everySeconds: 60 }]);
        await executor.batch([
          {
            sql: 'UPDATE job_schedule SET next_run_at = ? WHERE org_id = ? AND name = ?',
            params: ['2000-01-01T00:00:00.000Z', ctx.orgId, job.qualifiedName],
          },
        ]);
        const fired = await schedules.tick(ctx);
        expect(fired).toHaveLength(1);
        expect(fired[0]!.name).toBe(job.qualifiedName);
        const cleanup = () =>
          repository.buryUnregistered(ctx, {
            types: [job.qualifiedName],
            graceSeconds: JOB_UNREGISTERED_GRACE_SECONDS,
            limit: 50,
          });
        expect(await cleanup()).toBe(1);
        expect(await cleanup()).toBe(0);
        expect(await repository.status(ctx, 'orphan')).toMatchObject({
          state: 'dead',
          attempts: 0,
          lastErrorCode: 'unknown_job_type',
          history: [],
        });
        expect(await repository.listDue(ctx, { types: [job.qualifiedName], limit: 50 })).toEqual([
          fired[0]!.jobId,
        ]);
        expect(await repository.status(orgContext('other'), 'orphan')).toBeNull();
      }));
    it('bounds each expiry pass to 50 sessions for the D1 invocation budget', () =>
      run(async (executor) => {
        for (let n = 0; n < 51; n++)
          await executor.all({
            sql: "INSERT INTO npm_login_session (id,org_id,project_id,selector_hash,done_hash,expires_at) VALUES (?,'org','project',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))",
            params: [
              `expired${n}`,
              n.toString(16).padStart(64, '0'),
              (n + 1000).toString(16).padStart(64, '0'),
            ],
          });
        const store = createNpmLoginExpiryRepository(executor);
        const enqueue = vi.fn(async () => ({ id: 'next', created: true }));
        const job = createNpmLoginExpiryJob(executor, { enqueue });
        await job.definition.handler({}, {
          org: orgContext('org'),
          jobId: 'expiry-job',
          signal: new AbortController().signal,
        } as JobContext);
        expect(enqueue).toHaveBeenCalledWith(
          orgContext('org'),
          'core:npm-login-expire:v2',
          {},
          { idempotencyKey: 'npm-login-expire:expiry-job' },
        );
        expect(
          await executor.all({
            sql: "SELECT count(*) AS count FROM npm_login_session WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ count: 1 }]);
        expect(await store.expire(orgContext('org'))).toBe(1);
        expect(await store.expire(orgContext('org'))).toBe(0);
      }));
    it.each([false, true])(
      'deletes expired pre-revoked sessions even with owner mismatch: %s',
      (mismatch) =>
        run(async (executor) => {
          await executor.batch([
            {
              sql: "INSERT INTO user_account (id,org_id,email) VALUES ('user','org','test@example.test'),('other-user','org','other@example.test')",
              params: [],
            },
            {
              sql: "INSERT INTO token (id,org_id,kind,selector,hash,pepper_version,name,scopes_json,user_id,expires_at,revoked_at) VALUES ('token','org','pat','abcdefghijkl',?,1,'test','[]','user','2099-01-01T00:00:00.000Z',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
              params: ['c'.repeat(64)],
            },
            {
              sql: "INSERT INTO npm_login_session (id,org_id,project_id,selector_hash,done_hash,expires_at,state,user_id,token_id,token_ciphertext,token_nonce,token_key_version) VALUES ('expired','org','project',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),'approved',?,'token','ciphertext','nonce',1)",
              params: ['a'.repeat(64), 'b'.repeat(64), mismatch ? 'other-user' : 'user'],
            },
          ]);
          const store = createNpmLoginExpiryRepository(executor);
          expect(await store.expire(orgContext('org'))).toBe(1);
          expect(
            await executor.all({
              sql: "SELECT id FROM npm_login_session WHERE org_id='org'",
              params: [],
            }),
          ).toEqual([]);
          expect(
            await executor.all({
              sql: "SELECT action FROM audit_pending WHERE org_id='org'",
              params: [],
            }),
          ).toEqual([]);
          expect(await store.expire(orgContext('org'))).toBe(0);
        }),
    );
    it('does not re-enqueue for, or starve newer sessions behind, 51 expired sessions linked to a live token with a different owner', () =>
      run(async (executor) => {
        await executor.batch([
          {
            sql: "INSERT INTO user_account (id,org_id,email) VALUES ('user','org','test@example.test'),('other-user','org','other@example.test')",
            params: [],
          },
          {
            sql: "INSERT INTO token (id,org_id,kind,selector,hash,pepper_version,name,scopes_json,user_id,expires_at) VALUES ('token','org','pat','abcdefghijkl',?,1,'test','[]','user','2099-01-01T00:00:00.000Z')",
            params: ['c'.repeat(64)],
          },
        ]);
        for (let n = 0; n < 51; n++)
          await executor.all({
            sql: "INSERT INTO npm_login_session (id,org_id,project_id,selector_hash,done_hash,expires_at,state,user_id,token_id,token_ciphertext,token_nonce,token_key_version) VALUES (?,'org','project',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),'approved','other-user','token','ciphertext','nonce',1)",
            params: [
              `expired${n}`,
              n.toString(16).padStart(64, '0'),
              (n + 1000).toString(16).padStart(64, '0'),
            ],
          });
        const enqueue = vi.fn(async () => ({ id: 'next', created: true }));
        await createNpmLoginExpiryJob(executor, { enqueue }).definition.handler({}, {
          org: orgContext('org'),
          jobId: 'expiry-job',
          signal: new AbortController().signal,
        } as JobContext);
        expect(enqueue).not.toHaveBeenCalled();
        expect(await createNpmLoginExpiryRepository(executor).expire(orgContext('org'))).toBe(0);
        expect(
          await executor.all({
            sql: "SELECT count(*) AS count FROM npm_login_session WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ count: 51 }]);
        expect(
          await executor.all({
            sql: "SELECT revoked_at FROM token WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ revoked_at: null }]);
        await executor.all({
          sql: "INSERT INTO npm_login_session (id,org_id,project_id,selector_hash,done_hash,expires_at) VALUES ('newer','org','project',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds'))",
          params: ['e'.repeat(64), 'f'.repeat(64)],
        });
        expect(await createNpmLoginExpiryRepository(executor).expire(orgContext('org'))).toBe(1);
        expect(
          await executor.all({
            sql: "SELECT id FROM npm_login_session WHERE org_id='org' AND id='newer'",
            params: [],
          }),
        ).toEqual([]);
      }));
    it('approves and mints once under concurrent confirmation, and revokes only uncollected tokens', () =>
      run(async (executor) => {
        const ctx = orgContext('org');
        const repo = createNpmLoginRepository(executor, keys());
        await executor.batch([
          { sql: "INSERT INTO cache_epoch (org_id,version) VALUES ('org','initial')", params: [] },
          {
            sql: "INSERT INTO user_account (id,org_id,email) VALUES ('user','org','test@example.test')",
            params: [],
          },
          {
            sql: "INSERT INTO identity_provider_binding (org_id,provider,anchor) VALUES ('org','test','https://idp.example.test')",
            params: [],
          },
          {
            sql: "INSERT INTO identity (id,org_id,user_id,provider,subject,email,email_verified,validated_at) VALUES ('identity','org','user','test','subject','test@example.test',1,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))",
            params: [],
          },
          {
            sql: "INSERT INTO session (id,org_id,user_id,identity_id,secret_hash,csrf_hash,expires_at,reauth_at) VALUES ('session','org','user','identity',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))",
            params: ['a'.repeat(64), 'b'.repeat(64)],
          },
          {
            sql: "INSERT INTO role (id,org_id,key,name,scope) VALUES ('role','org','reader','Reader','organization')",
            params: [],
          },
          {
            sql: "INSERT INTO role_permission (org_id,role_id,permission) VALUES ('org','role','project:packages:read')",
            params: [],
          },
          {
            sql: "INSERT INTO access_grant (id,org_id,subject_type,subject_value,scope,role_id) VALUES ('grant','org','email','test@example.test','organization','role')",
            params: [],
          },
        ]);
        await repo.start(ctx, {
          id: 'login',
          projectId: 'project',
          selectorHash: 'a'.repeat(64),
          doneHash: 'b'.repeat(64),
          hostname: null,
          sourceIp: null,
        });
        const providerAnchors = [
          {
            provider: 'test',
            anchor: 'https://idp.example.test',
            emailAuthoritative: true,
            emailAuthoritativeDomains: ['example.test'],
          },
        ];
        const fence = mutationFence(
          { userId: 'user', sessionId: 'session' } as AuthenticatedActor,
          {},
        );
        const issue = (
          selectorHash = 'a'.repeat(64),
          issuingRepo = repo,
          tokenSelector = 'abcdefghijkl',
          issuingContext = ctx,
        ) => {
          const id = ulid();
          const now = new Date().toISOString();
          const audit = auditEvent({
            id: ulid(),
            now,
            action: 'token.issue',
            actor: { type: 'user', id: 'user' },
            context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
            target: { type: 'token', id },
            projectId: null,
          });
          if (!audit.ok) throw new Error('fixture audit');
          return issuingRepo.approveNpmLogin(
            issuingContext,
            fence,
            {
              id,
              name: 'npm login',
              scope: 'read',
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
              maxLifetimeDays: 365,
              now,
              validation: { kind: 'sso', identityId: 'identity' },
              projectMode: 'selected',
              projectIds: ['project'],
              providerAnchors,
              audit: audit.event,
            },
            () => ({
              selector: tokenSelector,
              hash: 'c'.repeat(64),
              pepperVersion: 1,
              plaintext: `pb_pat_${tokenSelector}_` + 'A'.repeat(43),
            }),
            selectorHash,
          );
        };
        expect(await issue('a'.repeat(64), repo, 'abcdefghijkl', orgContext('other'))).toEqual({
          status: 'refused',
          reason: 'id_conflict',
        });
        const results = await Promise.all([issue(), issue()]);
        expect(results.filter((result) => result.status === 'issued')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'refused')).toHaveLength(1);
        expect(
          await executor.all({
            sql: "SELECT t.user_id = l.user_id AS same_user, t.project_mode FROM token t JOIN npm_login_session l ON l.token_id=t.id AND l.org_id=t.org_id WHERE l.org_id='org'",
            params: [],
          }),
        ).toEqual([{ same_user: 1, project_mode: 'selected' }]);
        expect(
          await executor.all({
            sql: "SELECT action FROM audit_pending WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ action: 'token.issue' }]);
        await repo.start(ctx, {
          id: 'second',
          projectId: 'project',
          selectorHash: 'd'.repeat(64),
          doneHash: 'e'.repeat(64),
          hostname: null,
          sourceIp: null,
        });
        await repo.start(ctx, {
          id: 'expired',
          projectId: 'project',
          selectorHash: 'f'.repeat(64),
          doneHash: '1'.repeat(64),
          hostname: null,
          sourceIp: null,
        });
        await executor.all({
          sql: "UPDATE npm_login_session SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE org_id='org' AND id='expired'",
          params: [],
        });
        expect((await issue('f'.repeat(64), repo, 'mnopqrstuvwx')).status).toBe('refused');
        expect(await repo.confirmation(ctx, 'f'.repeat(64))).toBeNull();
        expect(await repo.poll(ctx, 'project', '1'.repeat(64), () => {})).toEqual({
          status: 'not_found',
        });
        await executor.all({
          sql: "INSERT INTO user_account (id,org_id,email) VALUES ('other','org','other@example.test')",
          params: [],
        });
        const changedOwner: SqlExecutor = {
          driver: executor.driver,
          all: (statement) => executor.all(statement),
          batch: (statements) =>
            executor.batch(
              statements.flatMap((statement) =>
                statement.sql.includes("SET state = 'approved'")
                  ? [
                      {
                        sql: "UPDATE token SET user_id='other', validation_identity_id=NULL WHERE org_id=? AND id=?",
                        params: [ctx.orgId, statement.params[1]!],
                      },
                      statement,
                    ]
                  : [statement],
              ),
            ),
        };
        const mismatched = await issue(
          'd'.repeat(64),
          createNpmLoginRepository(changedOwner, keys()),
          'mnopqrstuvwx',
        );
        expect(mismatched).toEqual({ status: 'refused', reason: 'authority' });
        expect((await repo.confirmation(ctx, 'd'.repeat(64)))?.projectId).toBe('project');
        expect(
          await executor.all({
            sql: "SELECT count(*) AS count FROM token WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ count: 1 }]);
        await executor.all({
          sql: "UPDATE session SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id='org'",
          params: [],
        });
        expect((await issue('d'.repeat(64))).status).toBe('refused');
        expect(
          await executor.all({
            sql: "SELECT count(*) AS count FROM token WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ count: 1 }]);
        await executor.all({
          sql: "UPDATE npm_login_session SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE org_id='org'",
          params: [],
        });
        await executor.all({
          sql: "UPDATE token SET user_id='other', validation_identity_id=NULL WHERE org_id='org'",
          params: [],
        });
        await createNpmLoginExpiryRepository(executor).expire(ctx);
        expect(
          await executor.all({
            sql: "SELECT state FROM npm_login_session WHERE org_id='org' AND id='login'",
            params: [],
          }),
        ).toEqual([{ state: 'approved' }]);
        await executor.all({
          sql: "UPDATE token SET user_id='user' WHERE org_id='org'",
          params: [],
        });
        await createNpmLoginExpiryRepository(executor).expire(ctx);
        expect(
          await executor.all({
            sql: "SELECT revoked_at IS NOT NULL AS revoked FROM token WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ revoked: 1 }]);
        expect(
          await executor.all({
            sql: "SELECT action FROM audit_pending WHERE org_id='org' ORDER BY action",
            params: [],
          }),
        ).toEqual([{ action: 'token.issue' }, { action: 'token.revoke' }]);
        expect(await repo.confirmation(ctx, 'a'.repeat(64))).toBeNull();
      }));
    it('delivers once to concurrent pollers and erases the sealed token', () =>
      run(async (executor) => {
        const keyring = keys();
        const ctx = orgContext('org');
        const built = vi.fn();
        const repo = createNpmLoginRepository(
          {
            driver: executor.driver,
            all: (statement) => executor.all(statement),
            async batch(statements) {
              if (
                statements.some((statement) => statement.sql.includes("SET state = 'consumed'"))
              ) {
                expect(built).toHaveBeenCalledTimes(1);
              }
              return executor.batch(statements);
            },
          },
          keyring,
        );
        await repo.start(ctx, {
          id: 'login',
          projectId: 'project',
          selectorHash: 'a'.repeat(64),
          doneHash: 'b'.repeat(64),
          hostname: null,
          sourceIp: null,
        });
        await executor.batch([
          {
            sql: "INSERT INTO user_account (id,org_id,email) VALUES ('user','org','test@example.test')",
            params: [],
          },
          {
            sql: "INSERT INTO token (id,org_id,kind,selector,hash,pepper_version,name,scopes_json,user_id,expires_at) VALUES ('token','org','pat','abcdefghijkl',?,1,'test','[]','user',strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))",
            params: ['c'.repeat(64)],
          },
        ]);
        const box = await createSecretCipher(keyring, 'npm-login').seal(
          new TextEncoder().encode('synthetic-token'),
          `npm-login/org/${'a'.repeat(64)}`,
        );
        await executor.all({
          sql: "UPDATE npm_login_session SET state='approved', user_id='user', token_id='token', token_ciphertext=?,token_nonce=?,token_key_version=? WHERE org_id='org'",
          params: [base64urlEncode(box.ciphertext), base64urlEncode(box.nonce), box.keyVersion],
        });
        expect(await repo.poll(orgContext('other'), 'project', 'b'.repeat(64), () => {})).toEqual({
          status: 'not_found',
        });
        const results = await Promise.all(
          Array.from({ length: 8 }, () => repo.poll(ctx, 'project', 'b'.repeat(64), built)),
        );
        expect(built).toHaveBeenCalledTimes(1);
        expect(results.filter((r) => r.status === 'token')).toEqual([
          { status: 'token', token: 'synthetic-token' },
        ]);
        expect(results.filter((r) => r.status === 'not_found')).toHaveLength(7);
        expect(
          await executor.all({
            sql: "SELECT state, token_ciphertext, token_nonce, token_key_version FROM npm_login_session WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([
          { state: 'consumed', token_ciphertext: null, token_nonce: null, token_key_version: null },
        ]);
        await executor.all({
          sql: "UPDATE npm_login_session SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE org_id='org'",
          params: [],
        });
        await createNpmLoginExpiryRepository(executor).expire(ctx);
        expect(
          await executor.all({
            sql: "SELECT revoked_at FROM token WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ revoked_at: null }]);
      }));
    it('recovers a process stop after claiming a token, with an org-scoped audited sweep', () =>
      run(async (executor) => {
        const ctx = orgContext('org');
        await executor.batch([
          {
            sql: "INSERT INTO user_account (id,org_id,email) VALUES ('user','org','test@example.test')",
            params: [],
          },
          {
            sql: "INSERT INTO token (id,org_id,kind,selector,hash,pepper_version,name,scopes_json,user_id,expires_at) VALUES ('token','org','pat','abcdefghijkl',?,1,'test','[]','user','2099-01-01T00:00:00.000Z')",
            params: ['c'.repeat(64)],
          },
          {
            sql: "INSERT INTO npm_login_session (id,org_id,project_id,selector_hash,done_hash,expires_at,state,user_id,token_id,token_ciphertext,token_nonce,token_key_version) VALUES ('login','org','project',?,?,'2099-01-01T00:00:00.000Z','approved','user','token','invalid','invalid',1)",
            params: ['a'.repeat(64), 'b'.repeat(64)],
          },
        ]);
        const stopped: SqlExecutor = {
          driver: executor.driver,
          all: (statement) => executor.all(statement),
          async batch(statements) {
            if (statements.some((s) => s.sql.includes('UPDATE token SET revoked_at')))
              throw new Error('Injected process stop');
            return executor.batch(statements);
          },
        };
        await expect(
          createNpmLoginRepository(stopped, keys()).poll(ctx, 'project', 'b'.repeat(64), () => {}),
        ).rejects.toThrow('Injected process stop');
        expect(
          await executor.all({
            sql: "SELECT state FROM npm_login_session WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ state: 'delivering' }]);
        const sweep = createNpmLoginExpiryRepository(executor);
        const freshBatch = vi.fn(executor.batch);
        expect(
          await createNpmLoginExpiryRepository({ ...executor, batch: freshBatch }).expire(ctx),
        ).toBe(0);
        expect(freshBatch).not.toHaveBeenCalled();
        await executor.all({
          sql: "UPDATE npm_login_session SET delivering_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 minutes') WHERE org_id='org'",
          params: [],
        });
        const foreignBatch = vi.fn(executor.batch);
        expect(
          await createNpmLoginExpiryRepository({ ...executor, batch: foreignBatch }).expire(
            orgContext('other'),
          ),
        ).toBe(0);
        expect(foreignBatch).not.toHaveBeenCalled();
        expect(await sweep.expire(ctx)).toBe(1);
        expect(await sweep.expire(ctx)).toBe(0);
        expect(
          await executor.all({
            sql: "SELECT revoked_at IS NOT NULL AS revoked FROM token WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ revoked: 1 }]);
        expect(
          await executor.all({
            sql: "SELECT action, json_extract(payload_json, '$.changes.cause.new') AS cause FROM audit_pending WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ action: 'token.revoke', cause: 'login_delivery_unconfirmed' }]);
      }));
    it('recovers a stop on the consumed write after building a valid token response', () =>
      run(async (executor) => {
        const ctx = orgContext('org');
        const keyring = keys();
        const built = vi.fn();
        await executor.batch([
          {
            sql: "INSERT INTO user_account (id,org_id,email) VALUES ('user','org','test@example.test')",
            params: [],
          },
          {
            sql: "INSERT INTO token (id,org_id,kind,selector,hash,pepper_version,name,scopes_json,user_id,expires_at) VALUES ('token','org','pat','abcdefghijkl',?,1,'test','[]','user','2099-01-01T00:00:00.000Z')",
            params: ['c'.repeat(64)],
          },
          {
            sql: "INSERT INTO npm_login_session (id,org_id,project_id,selector_hash,done_hash,expires_at,state,user_id,token_id,token_ciphertext,token_nonce,token_key_version) VALUES ('login','org','project',?,?,'2099-01-01T00:00:00.000Z','approved','user','token','invalid','invalid',1)",
            params: ['a'.repeat(64), 'b'.repeat(64)],
          },
        ]);
        const box = await createSecretCipher(keyring, 'npm-login').seal(
          new TextEncoder().encode('synthetic-token'),
          `npm-login/org/${'a'.repeat(64)}`,
        );
        await executor.all({
          sql: "UPDATE npm_login_session SET token_ciphertext=?, token_nonce=?, token_key_version=? WHERE org_id='org' AND id='login'",
          params: [base64urlEncode(box.ciphertext), base64urlEncode(box.nonce), box.keyVersion],
        });
        const stopped: SqlExecutor = {
          driver: executor.driver,
          all: (statement) => executor.all(statement),
          async batch(statements) {
            if (statements.some((s) => s.sql.includes("SET state = 'consumed'")))
              throw new Error('Injected process stop');
            return executor.batch(statements);
          },
        };
        await expect(
          createNpmLoginRepository(stopped, keyring).poll(ctx, 'project', 'b'.repeat(64), built),
        ).rejects.toThrow('Injected process stop');
        expect(
          await executor.all({
            sql: "SELECT state FROM npm_login_session WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ state: 'delivering' }]);
        expect(built).toHaveBeenCalledExactlyOnceWith('synthetic-token');
        expect(
          await executor.all({
            sql: "SELECT revoked_at FROM token WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ revoked_at: null }]);
        const sweep = createNpmLoginExpiryRepository(executor);
        const freshBatch = vi.fn(executor.batch);
        expect(
          await createNpmLoginExpiryRepository({ ...executor, batch: freshBatch }).expire(ctx),
        ).toBe(0);
        expect(freshBatch).not.toHaveBeenCalled();
        expect(
          await executor.all({
            sql: "SELECT revoked_at FROM token WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ revoked_at: null }]);
        expect(
          await executor.all({
            sql: "SELECT action FROM audit_pending WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([]);

        await executor.all({
          sql: "UPDATE npm_login_session SET delivering_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 minutes') WHERE org_id='org'",
          params: [],
        });
        const foreignBatch = vi.fn(executor.batch);
        expect(
          await createNpmLoginExpiryRepository({ ...executor, batch: foreignBatch }).expire(
            orgContext('other'),
          ),
        ).toBe(0);
        expect(foreignBatch).not.toHaveBeenCalled();
        expect(await sweep.expire(ctx)).toBe(1);
        expect(await sweep.expire(ctx)).toBe(0);
        expect(
          await executor.all({
            sql: "SELECT revoked_at IS NOT NULL AS revoked FROM token WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ revoked: 1 }]);
        expect(
          await executor.all({
            sql: "SELECT action, json_extract(payload_json, '$.changes.cause.new') AS cause FROM audit_pending WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ action: 'token.revoke', cause: 'login_delivery_unconfirmed' }]);
      }));
    it('revokes an undeliverable PAT with an audit in the same batch and returns not_found', () =>
      run(async (executor) => {
        const keyring = keys();
        const ctx = orgContext('org');
        const repo = createNpmLoginRepository(executor, keyring);
        await repo.start(ctx, {
          id: 'login',
          projectId: 'project',
          selectorHash: 'a'.repeat(64),
          doneHash: 'b'.repeat(64),
          hostname: null,
          sourceIp: null,
        });
        await executor.batch([
          {
            sql: "INSERT INTO user_account (id,org_id,email) VALUES ('user','org','test@example.test')",
            params: [],
          },
          {
            sql: "INSERT INTO token (id,org_id,kind,selector,hash,pepper_version,name,scopes_json,user_id,expires_at) VALUES ('token','org','pat','abcdefghijkl',?,1,'test','[]','user',strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))",
            params: ['c'.repeat(64)],
          },
        ]);
        const box = await createSecretCipher(keyring, 'npm-login').seal(
          new TextEncoder().encode('synthetic-token'),
          `npm-login/org/${'a'.repeat(64)}`,
        );
        await executor.all({
          sql: "UPDATE npm_login_session SET state='approved', user_id='user', token_id='token', token_ciphertext=?,token_nonce=?,token_key_version=? WHERE org_id='org'",
          params: [
            base64urlEncode(new Uint8Array(box.ciphertext.length)),
            base64urlEncode(box.nonce),
            box.keyVersion,
          ],
        });
        const results = await Promise.all(
          Array.from({ length: 8 }, () => repo.poll(ctx, 'project', 'b'.repeat(64), () => {})),
        );
        expect(results).toEqual(Array.from({ length: 8 }, () => ({ status: 'not_found' })));
        expect(
          await executor.all({
            sql: "SELECT action, json_extract(payload_json, '$.changes.cause.new') AS cause FROM audit_pending WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ action: 'token.revoke', cause: 'login_delivery_failed' }]);
        expect(
          await executor.all({
            sql: "SELECT state, token_ciphertext, token_nonce, token_key_version FROM npm_login_session WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([
          {
            state: 'delivering',
            token_ciphertext: null,
            token_nonce: null,
            token_key_version: null,
          },
        ]);
        await executor.all({
          sql: "UPDATE npm_login_session SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE org_id='org'",
          params: [],
        });
        await createNpmLoginExpiryRepository(executor).expire(ctx);
        expect(
          await executor.all({
            sql: "SELECT revoked_at IS NOT NULL AS revoked FROM token WHERE org_id='org'",
            params: [],
          }),
        ).toEqual([{ revoked: 1 }]);
      }));
  });
}
