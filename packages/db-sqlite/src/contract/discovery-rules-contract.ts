import { createKernel } from '@package-broker/core/kernel/kernel';
import { createAuthorizationEngine, patValidationGate } from '@package-broker/core/authz/engine';
import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { discoveryRuleRoutes } from '@package-broker/core/api/routes/discovery-rules';
import { systemClock } from '@package-broker/core/ids';
import { createLocalLoginSetupWriter } from '../repositories/local-login-setup.js';
import { credentialAad } from '@package-broker/core/secrets/cipher';
import { DbError } from '@package-broker/core/db/errors';
import { buildIdempotencyRecord } from '@package-broker/core/api/idempotency';
import { createIdempotencyRepository } from '../repositories/idempotency.js';
import { createBulkDiscovery } from '@package-broker/core/sources/bulk-discovery';
import { createSourceService } from '@package-broker/core/sources/source-service';
import { createCredentialRepository } from '../repositories/credential.js';
import { createRegisteredNameRepository } from '../repositories/registered-name.js';
import { createOrganizationRepository } from '../repositories/organization.js';
import { createDiscoveryRepositoryReader } from '../repositories/discovery.js';
import { apiOptions } from '../testing/api-services-fixture.js';
import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createApiRoutes } from '../repositories/api-services.js';
import type { DiscoveryRuleJobDeps } from '@package-broker/core/runtime/discovery-rule-jobs';
import { createDiscoveryRuleRepository } from '../repositories/discovery-rules.js';
import { discoveryRuleAuthority } from '../repositories/discovery-rule-authority.js';
import { createSourceRepository } from '../repositories/source.js';
import { compile, db } from '../kysely.js';
import { seedTwoOrganizations } from './two-organizations.js';
import {
  RULE_ID,
  CREDENTIAL_ID,
  RULE_OPTIONS,
  seedDiscoveryRule,
  seedDiscoveryLease,
  seedDiscoveryAdministrator,
  ruleAudit,
  ruleFence,
} from '../testing/discovery-rules-fixture.js';
import type { CaseContext } from '../testing/mutation-table/harness.js';

export function describeDiscoveryRulesContract(
  name: string,
  open: () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>,
) {
  async function fixture(
    body: (f: {
      executor: SqlExecutor;
      a: OrgContext;
      b: OrgContext;
      admin: Awaited<ReturnType<typeof seedDiscoveryAdministrator>>;
      repo: ReturnType<typeof createDiscoveryRuleRepository>;
    }) => Promise<void>,
  ) {
    const opened = await open();
    try {
      const orgs = await seedTwoOrganizations(opened.executor);
      const context: CaseContext = {
        executor: opened.executor,
        orgs,
        mutate: (s) => s,
        mutateBatch: (s) => s,
      };
      const admin = await seedDiscoveryAdministrator(context);
      await seedDiscoveryRule(opened.executor, orgs.a);
      await seedDiscoveryLease(opened.executor, orgs.a);
      await body({
        executor: opened.executor,
        ...orgs,
        admin,
        repo: createDiscoveryRuleRepository(opened.executor, admin.anchors),
      });
    } finally {
      await opened.close();
    }
  }
  describe(`discovery rule repository ${name}`, () => {
    function bulk(
      a: OrgContext,
      executor: SqlExecutor,
      anchors: Awaited<ReturnType<typeof seedDiscoveryAdministrator>>['anchors'],
      claimProbe?: 'found',
    ) {
      const api = apiOptions(executor);
      const service = createSourceService({
        sources: createSourceRepository(executor),
        organizations: createOrganizationRepository(executor),
        registeredNames: createRegisteredNameRepository(executor),
        credentialRepository: createCredentialRepository(executor),
        credentials: {} as never,
        catalogue: api.packages.reader,
        policy: api.policy,
        providerAnchors: anchors,
        ids: { ulid },
        log: () => {},
        ...(claimProbe === undefined ? {} : { claimProbe: async () => claimProbe }),
      });
      const reader = createDiscoveryRepositoryReader(executor);
      const discovery = createBulkDiscovery({
        sources: service,
        existingRepository: reader,
        authority: async () => true,
        credentials: {
          resolve: async () => ({
            credentialId: CREDENTIAL_ID,
            installationId: 41,
            upstream: {} as never,
          }),
        },
        discovery: {
          discover: async () => ({ entries: [], nextCursor: null }),
          plan: async (_ctx, _credential, repository, exists) => [
            {
              repository,
              ecosystem: 'npm',
              packageName: '@acme/library',
              action: (await exists({ repository, ecosystem: 'npm', packageName: '@acme/library' }))
                ? 'existing'
                : 'new',
              reason: null,
            },
          ],
        },
      });
      const call = {
        audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
      };
      return {
        service,
        reader,
        call,
        apply: () =>
          discovery.apply(
            a,
            { kind: 'rule', ruleId: RULE_ID },
            ruleFence(),
            { credentialId: CREDENTIAL_ID, installationId: 41, repositories: ['acme/library'] },
            call,
          ),
      };
    }
    it.each(['claim_overlap', 'name_public'] as const)(
      'cleans refused rule sources with the real %s admission',
      (reason) =>
        fixture(async ({ a, executor, admin }) => {
          await executor.all({
            sql: "insert into source(id,org_id,name,ecosystem,type,status,config_json) values('other',?,'other','npm',?,'active','{}')",
            params: [a.orgId, reason === 'name_public' ? 'npmjs_proxy' : 'hosted'],
          });
          if (reason === 'claim_overlap')
            await executor.all({
              sql: "insert into registered_name(id,org_id,source_id,ecosystem,pattern) values('claim',?,'other','npm','@acme/*')",
              params: [a.orgId],
            });
          const f = bulk(
            a,
            executor,
            admin.anchors,
            reason === 'name_public' ? 'found' : undefined,
          );
          expect(await f.apply()).toMatchObject({
            ok: true,
            value: { skipped: 1, results: [{ reason }] },
          });
          expect(
            await executor.all({ sql: 'select id from source where org_id=?', params: [a.orgId] }),
          ).toEqual([{ id: 'other' }]);
          expect(
            await executor.all({
              sql: 'select * from source_discovery_admission where org_id=?',
              params: [a.orgId],
            }),
          ).toEqual([]);
        }),
    );
    it('completes admission on activation and never resumes an administrator pause', () =>
      fixture(async ({ a, executor, admin }) => {
        const f = bulk(a, executor, admin.anchors);
        expect(await f.apply()).toMatchObject({ ok: true, value: { created: 1 } });
        expect(
          await executor.all({
            sql: 'select * from source_discovery_admission where org_id=?',
            params: [a.orgId],
          }),
        ).toEqual([]);
        await executor.all({
          sql: "update source set status='paused' where org_id=?",
          params: [a.orgId],
        });
        expect(await f.apply()).toMatchObject({ ok: true, value: { created: 0, existing: 1 } });
        expect(
          await executor.all({
            sql: 'select status from source where org_id=?',
            params: [a.orgId],
          }),
        ).toEqual([{ status: 'paused' }]);
      }));
    it('resumes unfinished admission from an earlier run and deletes its rule without deleting the source', () =>
      fixture(async ({ a, executor, admin, repo }) => {
        const f = bulk(a, executor, admin.anchors);
        const created = await f.service.create(
          a,
          { kind: 'rule', ruleId: RULE_ID },
          ruleFence(),
          {
            projectId: null,
            credentialId: CREDENTIAL_ID,
            name: '@acme/library',
            ecosystem: 'npm',
            type: 'vcs',
            url: null,
            configJson: JSON.stringify({
              provider: 'github',
              repository: 'acme/library',
              installationId: 41,
              packageName: '@acme/library',
              refs: { tags: true, branches: [] },
            }),
          },
          f.call,
        );
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        await executor.all({
          sql: "update source_discovery_rule set last_run_at='2026-11-04T12:00:00.000Z' where org_id=?",
          params: [a.orgId],
        });
        expect(await f.reader.has(a, 'acme/library', 'npm', ruleFence())).toBe(false);
        expect(await f.reader.pending!(a, ruleFence(), 'acme/library', 'npm')).toMatchObject({
          id: created.value.id,
        });
        expect(await f.apply()).toMatchObject({ ok: true, value: { created: 1 } });
        await executor.all({
          sql: 'insert into source_discovery_admission(org_id,source_id,rule_id) values(?,?,?)',
          params: [a.orgId, created.value.id, RULE_ID],
        });
        expect(
          await repo.delete(a, admin.fence, {
            id: RULE_ID,
            revision: 1,
            audit: ruleAudit(),
            call: f.call,
          }),
        ).toBe('ok');
        expect(
          await executor.all({
            sql: 'select * from source_discovery_admission where org_id=?',
            params: [a.orgId],
          }),
        ).toEqual([]);
        expect(
          await executor.all({ sql: 'select id from source where org_id=?', params: [a.orgId] }),
        ).toEqual([{ id: created.value.id }]);
      }));
    it('creates an independent counted executor for each scheduled invocation including job platform reads', () =>
      fixture(async ({ a, executor }) => {
        let captured: DiscoveryRuleJobDeps | undefined;
        createApiRoutes({
          ...apiOptions(executor),
          onDiscoveryRules: (deps) => {
            captured = deps;
          },
        });
        const first = captured!.forInvocation!();
        const second = captured!.forInvocation!();
        for (let n = 0; n < 319; n++) await first.rules.get(a, RULE_ID);
        const discovery = first.discovery.forInvocation!();
        expect(discovery.budgetSpent!()).toBe(false);
        for (let n = 0; n < 320; n++) await first.jobs!.get(a, 'missing');
        expect(discovery.budgetSpent!()).toBe(true);
        expect(second.discovery.forInvocation!().budgetSpent!()).toBe(false);
      }));
    it('uses both partial job resource indexes when finding due rules', () =>
      fixture(async ({ a, executor, admin }) => {
        let plan: readonly { detail: string }[] = [];
        const measured: SqlExecutor = {
          driver: executor.driver,
          batch: (statements) => executor.batch(statements),
          async all<R>(statement: Statement) {
            if (statement.sql.startsWith('select * from source_discovery_rule dr'))
              plan = await executor.all<{ detail: string }>({
                ...statement,
                sql: 'explain query plan ' + statement.sql,
              });
            return executor.all<R>(statement);
          },
        };
        await createDiscoveryRuleRepository(measured, admin.anchors).due(
          a,
          new Date().toISOString(),
        );
        const details = plan.map((row) => row.detail).join(' ');
        expect(details).toContain('job_one_running_per_resource');
        expect(details).toContain('job_queued_resource');
      }));
    it('preserves completed results and audits credential loss once', () =>
      fixture(async ({ repo, a, executor }) => {
        const completed = {
          lastRunAt: null,
          outcome: 'succeeded',
          created: 7,
          existing: 0,
          skipped: 0,
          failed: 0,
          skips: [],
        };
        await executor.all({
          sql: "update source_discovery_rule set completed_json=?,created_count=99,last_run_outcome='running' where org_id=?",
          params: [JSON.stringify(completed), a.orgId],
        });
        await executor.all({
          sql: "update credential set kind='github_token' where org_id=?",
          params: [a.orgId],
        });
        await executor.batch([
          {
            sql: "UPDATE job SET type='core:discovery-rules:v1' WHERE org_id=? AND id='DRJOB'",
            params: [a.orgId],
          },
        ]);
        await repo.failUnavailableCredentials(
          a,
          { id: 'DRJOB', owner: 'worker', fence: 3 },
          new Date().toISOString(),
        );
        expect((await repo.get(a, RULE_ID))?.completed).toEqual(completed);
        const before = await executor.all({
          sql: "select * from audit_pending where org_id=? and action='discovery_rule.run_finished'",
          params: [a.orgId],
        });
        expect(before).toHaveLength(1);
        await repo.failUnavailableCredentials(
          a,
          { id: 'DRJOB', owner: 'worker', fence: 3 },
          new Date().toISOString(),
        );
        expect(
          await executor.all({
            sql: "select * from audit_pending where org_id=? and action='discovery_rule.run_finished'",
            params: [a.orgId],
          }),
        ).toEqual(before);
      }));
    it('keeps transient backoff and reports disabled run-now specifically', () =>
      fixture(async ({ repo, a, admin, executor }) => {
        const input = {
          id: RULE_ID,
          now: new Date().toISOString(),
          audit: ruleAudit(),
          call: { audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null } },
        };
        await executor.all({
          sql: "update source_discovery_rule set last_run_outcome='running',next_run_at='2999-01-01T00:00:00.000Z' where org_id=?",
          params: [a.orgId],
        });
        expect(await repo.runNow(a, admin.fence, input)).toBe('ok');
        expect((await repo.get(a, RULE_ID))?.nextRunAt).toBe('2999-01-01T00:00:00.000Z');
        await executor.all({
          sql: 'update source_discovery_rule set enabled=0 where org_id=?',
          params: [a.orgId],
        });
        expect(await repo.runNow(a, admin.fence, input)).toBe('discovery_rule_disabled');
      }));
    it('rejects a credential invalidated between update preflight and its fenced batch', () =>
      fixture(async ({ executor, a, admin, repo }) => {
        const racing: SqlExecutor = {
          ...executor,
          driver: executor.driver,
          all: (statement) => executor.all(statement),
          async batch(statements) {
            await executor.all({
              sql: "update credential set kind='github_token' where org_id=?",
              params: [a.orgId],
            });
            return executor.batch(statements);
          },
        };
        expect(
          await createDiscoveryRuleRepository(racing, admin.anchors).update(a, admin.fence, {
            id: RULE_ID,
            revision: 1,
            options: { ...RULE_OPTIONS, name: 'Rejected' },
            credentialChanged: false,
            now: new Date().toISOString(),
            audit: ruleAudit(),
            call: {
              audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
            },
          }),
        ).toBe('not_found');
        expect((await repo.get(a, RULE_ID))?.name).toBe(RULE_OPTIONS.name);
      }));
    it('answers invalid update credentials like create', () =>
      fixture(async ({ repo, a, admin }) => {
        expect(
          await repo.update(a, admin.fence, {
            id: RULE_ID,
            revision: 1,
            options: { ...RULE_OPTIONS, credentialId: ulid() },
            credentialChanged: true,
            now: new Date().toISOString(),
            audit: ruleAudit(),
            call: {
              audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
            },
          }),
        ).toBe('not_found');
      }));
    it('refuses credential deletion with a fixed discovery-rules reason', () =>
      fixture(async ({ a, executor }) => {
        await expect(
          createCredentialRepository(executor).delete(a, CREDENTIAL_ID),
        ).rejects.toMatchObject({
          kind: 'foreign_key',
          message: 'Credential is referenced by discovery rules',
        });
      }));
    it('classifies the local-login pending duplicate index and rolls back on both drivers', () =>
      fixture(async ({ a, admin, executor }) => {
        const now = new Date().toISOString();
        const setupHash = 'ab'.repeat(32);
        for (const id of ['pending-old', 'pending-duplicate'])
          await executor.all({
            sql: "insert into credential(id,org_id,kind,ciphertext,nonce,key_version,aad) values(?,?,'totp',x'00',zeroblob(12),1,?)",
            params: [id, a.orgId, credentialAad({ id, orgId: a.orgId, kind: 'totp' })],
          });
        await executor.all({
          sql: "insert into local_login(org_id,user_id,setup_hash,setup_expires_at,totp_credential_id) values(?,?,?,'2999-01-01T00:00:00.000Z','pending-old')",
          params: [a.orgId, admin.actor.userId, setupHash],
        });
        const input = {
          userId: admin.actor.userId,
          setupHash,
          now,
          credential: {
            id: 'pending-duplicate',
            projectId: null,
            kind: 'totp',
            sealed: { ciphertext: new Uint8Array([0]), nonce: new Uint8Array(12), keyVersion: 1 },
            aad: credentialAad({ id: 'pending-duplicate', orgId: a.orgId, kind: 'totp' }),
            rotatedAt: null,
            now,
          },
        };
        const before = await executor.all({
          sql: 'select * from local_login where org_id=?',
          params: [a.orgId],
        });
        const failure = await createLocalLoginSetupWriter(executor)
          .stagePendingTotp(a, input)
          .catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(DbError);
        expect(failure).toMatchObject({
          kind: 'unique',
          constraint: 'credential.org_id, credential.id',
        });
        expect(
          await executor.all({
            sql: 'select * from local_login where org_id=?',
            params: [a.orgId],
          }),
        ).toEqual(before);
        expect(
          await executor.all({
            sql: "select id from credential where org_id=? and id='pending-old'",
            params: [a.orgId],
          }),
        ).toEqual([{ id: 'pending-old' }]);
      }));
    it('retains completed results through an in-progress checkpoint without checkpoint audits', () =>
      fixture(async ({ a, repo, executor }) => {
        const prior = (await repo.get(a, RULE_ID))!;
        expect(
          await repo.checkpoint(
            a,
            ruleFence(),
            { ...prior, lastRunAt: new Date().toISOString(), outcome: 'succeeded', created: 3 },
            ruleAudit(),
          ),
        ).toBe(true);
        const completed = (await repo.get(a, RULE_ID))!.completed;
        expect(completed).toMatchObject({ outcome: 'succeeded', created: 3 });
        expect(
          await repo.checkpoint(a, ruleFence(), { ...prior, outcome: 'running', created: 1 }),
        ).toBe(true);
        expect((await repo.get(a, RULE_ID))!.completed).toEqual(completed);
        expect(
          await executor.all({
            sql: 'select count(*) as n from audit_pending where org_id=?',
            params: [a.orgId],
          }),
        ).toEqual([{ n: 1 }]);
      }));
    it('refuses rule source writes on a matching but unowned paused source', () =>
      fixture(async ({ a, executor }) => {
        await executor.all({
          sql: "insert into source(id,org_id,name,ecosystem,type,status,credential_id,config_json) values('unowned',?,'unowned','npm','vcs','paused',?,?)",
          params: [
            a.orgId,
            CREDENTIAL_ID,
            JSON.stringify({ provider: 'github', repository: 'acme/unowned', installationId: 41 }),
          ],
        });
        const names = createRegisteredNameRepository(executor);
        expect(
          await Promise.all([
            names.enable(a, ruleFence(), {
              id: 'unowned',
              providerAnchors: [],
              audit: ruleAudit(),
            }),
            names.add(a, ruleFence(), {
              id: ulid(),
              sourceId: 'unowned',
              pattern: 'unowned',
              providerAnchors: [],
              audit: ruleAudit(),
            }),
            createSourceRepository(executor).delete(a, ruleFence(), {
              id: 'unowned',
              providerAnchors: [],
            }),
          ]),
        ).toEqual(['forbidden', 'forbidden', 'forbidden']);
      }));
    it('reports duplicate rename separately from stale revision', () =>
      fixture(async ({ a, repo, admin }) => {
        const call = {
          audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
        };
        const now = new Date().toISOString();
        const id = ulid();
        expect(
          await repo.create(a, admin.fence, {
            id,
            options: { ...RULE_OPTIONS, name: 'Other' },
            now,
            audit: ruleAudit(),
            call,
          }),
        ).toBe('ok');
        expect(
          await repo.update(a, admin.fence, {
            id,
            revision: 1,
            options: RULE_OPTIONS,
            credentialChanged: false,
            now,
            audit: ruleAudit(),
            call,
          }),
        ).toBe('duplicate');
        expect((await repo.get(a, id))?.name).toBe('Other');
      }));
    it('serves real-repository duplicate rename as 409, stale revision as 412 and missing run as 404', () =>
      fixture(async ({ a, repo, admin, executor }) => {
        const csrf = 'B'.repeat(43);
        const origin = 'https://broker.test';
        const userId = admin.actor.userId;
        const sessionId = admin.actor.sessionId;
        const app = await createKernel({
          platform: 'node',
          plugins: [],
          coreRoutes: discoveryRuleRoutes({
            rules: repo,
            idempotency: createIdempotencyRepository(executor),
            ids: { ulid },
            clock: systemClock,
            clientIp: () => null,
            sessions: {
              authenticate: async () => ({ session: { id: sessionId, userId } }),
              isReauthFresh: () => true,
            } as never,
          }),
          ports: { organizations: { get: async () => null }, ids: { ulid }, clock: systemClock },
          resolveOrg: async () => a,
          health: async () => true,
          log: () => {},
          authorization: createAuthorizationEngine({
            access: {
              lookupSession: async () => ({
                session: { id: sessionId, csrfHash: await sha256Hex(csrf) },
                user: { id: userId },
                identity: null,
                protectedHolder: false,
                project: null,
                organizationPermissions: ['org:sources:write', 'org:sources:read'],
                projectPermissions: [],
              }),
              lookupToken: async () => null,
              touchSession: async () => true,
              touchToken: async () => true,
            },
            tokenUse: {
              keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
              nowMs: () => Date.now(),
              dispatch: (run) => {
                void run();
              },
              log: () => {},
            },
            patValidation: patValidationGate,
            publicOrigin: origin,
            providerAnchors: async () => [],
          }),
        });
        const path = '/_pb/sources/discovery/rules';
        const request = (method: string, suffix: string, body?: unknown, revision?: number) =>
          app.fetch(
            new Request(origin + path + suffix, {
              method,
              headers: {
                origin,
                'content-type': 'application/json',
                cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}`,
                'x-csrf-token': csrf,
                ...(revision === undefined ? {} : { 'if-match': `"r${revision}"` }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
        const created = await request('POST', '', { ...RULE_OPTIONS, name: 'Other' });
        expect(created.status).toBe(201);
        const { id } = (await created.json()) as { id: string };
        expect((await request('PATCH', `/${id}`, { name: RULE_OPTIONS.name }, 1)).status).toBe(409);
        expect((await request('PATCH', `/${id}`, { name: 'Fresh' }, 2)).status).toBe(412);
        expect((await request('POST', `/${ulid()}/run`, {})).status).toBe(404);
        expect(
          (await request('POST', '', { ...RULE_OPTIONS, name: 'Missing', credentialId: ulid() }))
            .status,
        ).toBe(404);
        expect((await request('GET', `/${id}/results`)).status).toBe(200);
        expect((await request('GET', `/${id}`)).status).toBe(200);
      }));
    it('does not let ten invalid bindings starve a later valid due rule', () =>
      fixture(async ({ a, executor, repo }) => {
        await executor.all({
          sql: "update credential set kind='github_token' where org_id=?",
          params: [a.orgId],
        });
        for (let n = 0; n < 10; n++)
          await executor.all({
            sql: "insert into source_discovery_rule(org_id,id,name,credential_id,installation_id,ecosystem,repository_pattern,created_at,updated_at) values(?,?,?,?,41,'npm','*',?,?)",
            params: [
              a.orgId,
              `bad-${n}`,
              `Bad ${n}`,
              CREDENTIAL_ID,
              new Date().toISOString(),
              new Date().toISOString(),
            ],
          });
        await executor.all({
          sql: "insert into credential(id,org_id,kind,ciphertext,nonce,key_version,aad) values('valid',?,'github_app',x'00',zeroblob(12),1,'aad')",
          params: [a.orgId],
        });
        await executor.all({
          sql: "insert into source_discovery_rule(org_id,id,name,credential_id,installation_id,ecosystem,repository_pattern,created_at,updated_at) values(?,'zzz','Valid','valid',41,'npm','*',?,?)",
          params: [a.orgId, new Date().toISOString(), new Date().toISOString()],
        });
        expect((await repo.due(a, new Date().toISOString())).map((r) => r.id)).toEqual(['zzz']);
        expect(await repo.get(a, 'bad-0')).toMatchObject({
          outcome: null,
          failureReason: null,
          completed: null,
        });
      }));
    it('lists, reads and selects due rules only in their organization', () =>
      fixture(async ({ repo, a, b }) => {
        expect((await repo.list(a, null, 10)).map((r) => r.id)).toEqual([RULE_ID]);
        expect(await repo.list(b, null, 10)).toEqual([]);
        expect(await repo.get(b, RULE_ID)).toBeNull();
        expect(await repo.due(b, new Date().toISOString())).toEqual([]);
        expect((await repo.due(a, new Date().toISOString())).length).toBe(0);
      }));
    it('excludes invalid bindings and occupied resources before limiting due rules', () =>
      fixture(async ({ repo, a, executor }) => {
        expect(await repo.due(a, new Date().toISOString())).toEqual([]);
        await executor.all({
          sql: "update job set state='succeeded' where org_id=?",
          params: [a.orgId],
        });
        expect(await repo.due(a, new Date().toISOString())).toHaveLength(1);
        await executor.all({
          sql: "update credential set kind='github_token' where org_id=?",
          params: [a.orgId],
        });
        expect(await repo.due(a, new Date().toISOString())).toEqual([]);
        expect(await repo.get(a, RULE_ID)).toMatchObject({ outcome: null });
      }));
    it('rejects invalid credentials on update without discarding the checkpoint', () =>
      fixture(async ({ repo, a, admin, executor }) => {
        await executor.all({
          sql: "update source_discovery_rule set last_run_outcome='running',plan_cursor='3',created_count=4 where org_id=?",
          params: [a.orgId],
        });
        await executor.all({
          sql: "update credential set kind='github_token' where org_id=?",
          params: [a.orgId],
        });
        expect(
          await repo.update(a, admin.fence, {
            id: RULE_ID,
            revision: 1,
            options: { ...RULE_OPTIONS, name: 'Renamed', enabled: false, intervalSeconds: 3600 },
            now: new Date().toISOString(),
            audit: ruleAudit(),
            call: {
              audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
            },
            credentialChanged: false,
          }),
        ).toBe('not_found');
        expect(await repo.get(a, RULE_ID)).toMatchObject({
          cursor: '3',
          created: 4,
          outcome: 'running',
        });
      }));
    it('keeps an active throttle deadline on run-now and reports missing rules', () =>
      fixture(async ({ repo, a, admin, executor }) => {
        await executor.all({
          sql: "update source_discovery_rule set last_run_outcome='rate_limited',next_run_at='2999-01-01T00:00:00.000Z' where org_id=?",
          params: [a.orgId],
        });
        const input = {
          id: RULE_ID,
          now: new Date().toISOString(),
          audit: ruleAudit(),
          call: { audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null } },
        };
        expect(await repo.runNow(a, admin.fence, input)).toBe('ok');
        expect((await repo.get(a, RULE_ID))?.nextRunAt).toBe('2999-01-01T00:00:00.000Z');
        expect(
          await repo.runNow(a, admin.fence, { ...input, id: ulid(), audit: ruleAudit() }),
        ).toBe('not_found');
      }));
    it('distinguishes a duplicate name from a revision conflict', () =>
      fixture(async ({ repo, a, admin }) => {
        const call = {
          audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
        };
        const now = new Date().toISOString();
        expect(
          await repo.create(a, admin.fence, {
            id: ulid(),
            options: RULE_OPTIONS,
            now,
            audit: ruleAudit(),
            call,
          }),
        ).toBe('duplicate');
      }));
    it('creates with fresh authority, updates with CAS, requests a run and deletes without deleting sources', () =>
      fixture(async ({ repo, a, admin, executor }) => {
        const id = ulid();
        const now = new Date().toISOString();
        const audit = ruleAudit();
        const call = {
          audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
        };
        expect(
          await repo.create(a, admin.fence, {
            id,
            options: { ...RULE_OPTIONS, name: 'Other' },
            now,
            audit,
            call,
          }),
        ).toBe('ok');
        expect((await repo.get(a, id))?.revision).toBe(1);
        expect(
          await repo.update(a, admin.fence, {
            id,
            revision: 1,
            options: { ...RULE_OPTIONS, name: 'Changed', includeForks: true },
            now,
            audit: ruleAudit(),
            call,
            credentialChanged: false,
          }),
        ).toBe('ok');
        expect(
          await repo.update(a, admin.fence, {
            id,
            revision: 1,
            options: RULE_OPTIONS,
            now,
            audit: ruleAudit(),
            call,
            credentialChanged: false,
          }),
        ).toBe('conflict');
        expect(await repo.runNow(a, admin.fence, { id, now, audit: ruleAudit(), call })).toBe('ok');
        await executor.all({
          sql: "insert into source(id,org_id,name,ecosystem,type,credential_id) values('kept',?,'kept','npm','vcs',?)",
          params: [a.orgId, CREDENTIAL_ID],
        });
        expect(
          await repo.delete(a, admin.fence, { id, revision: 1, audit: ruleAudit(), call }),
        ).toBe('conflict');
        expect(
          await repo.delete(a, admin.fence, { id, revision: 2, audit: ruleAudit(), call }),
        ).toBe('ok');
        expect(await repo.get(a, id)).toBeNull();
        expect(
          await executor.all({
            sql: "select id from source where org_id=? and id='kept'",
            params: [a.orgId],
          }),
        ).toEqual([{ id: 'kept' }]);
      }));
    it('rejects all cross-organization rule writes without changing either organization', () =>
      fixture(async ({ executor, a, b, repo, admin }) => {
        const now = new Date().toISOString();
        const call = {
          audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
        };
        const before = await repo.get(a, RULE_ID);
        expect(
          await repo.create(b, admin.fence, {
            id: ulid(),
            options: RULE_OPTIONS,
            now,
            audit: ruleAudit(),
            call,
          }),
        ).toBe('forbidden');
        expect(
          await repo.update(b, admin.fence, {
            id: RULE_ID,
            revision: 1,
            options: RULE_OPTIONS,
            now,
            audit: ruleAudit(),
            call,
            credentialChanged: false,
          }),
        ).toBe('forbidden');
        expect(
          await repo.delete(b, admin.fence, { id: RULE_ID, revision: 1, audit: ruleAudit(), call }),
        ).toBe('forbidden');
        expect(
          await repo.runNow(b, admin.fence, { id: RULE_ID, now, audit: ruleAudit(), call }),
        ).toBe('forbidden');
        expect(await repo.checkpoint(b, ruleFence(), before!, ruleAudit())).toBe(false);
        expect(await repo.get(a, RULE_ID)).toEqual(before);
        expect(
          await executor.all({
            sql: 'select id from audit_pending where org_id=?',
            params: [b.orgId],
          }),
        ).toEqual([]);
      }));
    it('commits idempotency with the rule mutation and rolls back a losing duplicate', () =>
      fixture(async ({ executor, a, repo, admin }) => {
        const id = ulid();
        const now = new Date();
        const record = buildIdempotencyRecord({
          principal: { kind: 'user', id: admin.actor.userId },
          key: 'discovery-test',
          route: 'discovery_rule.create',
          hash: 'a'.repeat(64),
          status: 201,
          response: { id },
          now,
        });
        const call = {
          audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
          idempotency: record,
        };
        expect(
          await repo.create(a, admin.fence, {
            id,
            options: { ...RULE_OPTIONS, name: 'First' },
            now: now.toISOString(),
            audit: ruleAudit(),
            call,
          }),
        ).toBe('ok');
        expect(
          await repo.create(a, admin.fence, {
            id: ulid(),
            options: { ...RULE_OPTIONS, name: 'Losing' },
            now: now.toISOString(),
            audit: ruleAudit(),
            call,
          }),
        ).toBe('conflict');
        expect((await repo.list(a, null, 100)).map((r) => r.name).sort()).toEqual([
          'First',
          'Libraries',
        ]);
        expect(
          await createIdempotencyRepository(executor).find(
            a,
            record.principalKey,
            record.key,
            now.toISOString(),
          ),
        ).toEqual(record);
        expect(
          await executor.all({
            sql: 'select count(*) as n from audit_pending where org_id=?',
            params: [a.orgId],
          }),
        ).toEqual([{ n: 1 }]);
      }));
    it('requires fresh credential authority inside the write batch even when the caller claims no credential change', () =>
      fixture(async ({ repo, a, admin, executor }) => {
        await executor.all({
          sql: 'update session set reauth_at=null where org_id=?',
          params: [a.orgId],
        });
        const now = new Date().toISOString();
        const call = {
          audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
        };
        expect(
          await repo.create(a, admin.fence, {
            id: ulid(),
            options: { ...RULE_OPTIONS, name: 'New' },
            now,
            audit: ruleAudit(),
            call,
          }),
        ).toBe('forbidden');
        expect(
          await repo.update(a, admin.fence, {
            id: RULE_ID,
            revision: 1,
            options: { ...RULE_OPTIONS, installationId: 42 },
            credentialChanged: false,
            now,
            audit: ruleAudit(),
            call,
          }),
        ).toBe('forbidden');
        expect(
          await repo.update(a, admin.fence, {
            id: RULE_ID,
            revision: 1,
            options: { ...RULE_OPTIONS, pattern: 'lib-*' },
            credentialChanged: false,
            now,
            audit: ruleAudit(),
            call,
          }),
        ).toBe('ok');
      }));
    it('checkpoints a system rule and keeps its authority after its creator loses access', () =>
      fixture(async ({ repo, a, admin, executor }) => {
        await executor.all({
          sql: "update user_account set status='suspended' where org_id=? and id=?",
          params: [a.orgId, admin.actor.userId],
        });
        const prior = (await repo.get(a, RULE_ID))!;
        expect(
          await repo.checkpoint(
            a,
            ruleFence(),
            {
              ...prior,
              outcome: 'running',
              remaining: ['acme/library'],
              skips: [{ repository: 'acme/fork', reason: 'fork' }],
            },
            ruleAudit(),
          ),
        ).toBe(true);
        expect((await repo.get(a, RULE_ID))?.remaining).toEqual(['acme/library']);
        const rows = await executor.all({
          sql: 'select actor_type,actor_id from audit_pending where org_id=?',
          params: [a.orgId],
        });
        expect(rows).toEqual([{ actor_type: 'system', actor_id: RULE_ID }]);
      }));
    it('runs BulkDiscovery through real source admission with a system rule actor and preserves existing imports', () =>
      fixture(async ({ executor, a, admin }) => {
        let statementCount = 0;
        const measured: SqlExecutor = {
          driver: executor.driver,
          all: (statement) => {
            statementCount += 1;
            return executor.all(statement);
          },
          batch: (statements) => {
            statementCount += statements.length;
            return executor.batch(statements);
          },
        };
        const api = apiOptions(measured);
        const service = createSourceService({
          sources: createSourceRepository(measured),
          organizations: createOrganizationRepository(measured),
          registeredNames: createRegisteredNameRepository(measured),
          credentialRepository: createCredentialRepository(measured),
          credentials: {} as never,
          catalogue: api.packages.reader,
          policy: api.policy,
          providerAnchors: admin.anchors,
          ids: { ulid },
          log: () => {},
        });
        const reader = createDiscoveryRepositoryReader(measured);
        const discovery = createBulkDiscovery({
          repositoriesPerInvocation: 20,
          statementCount: () => statementCount,
          authority: async (ctx, fence) => {
            const [row] = await measured.all<{ held: number }>(
              compile(
                db.selectNoFrom(sql<number>`(${discoveryRuleAuthority(ctx, fence)})`.as('held')),
              ),
            );
            return row?.held === 1;
          },
          sources: service,
          existingRepository: reader,
          credentials: {
            resolve: async () => ({
              credentialId: CREDENTIAL_ID,
              installationId: 41,
              upstream: {} as never,
            }),
          },
          discovery: {
            discover: async () => ({ entries: [], nextCursor: null }),
            plan: async (_ctx, _credential, repository, exists, options) => {
              const entries = [];
              for (const ecosystem of ['composer', 'npm'] as const) {
                if (options?.ecosystem !== undefined && options.ecosystem !== ecosystem) continue;
                entries.push({
                  repository,
                  ecosystem,
                  packageName:
                    ecosystem === 'npm' ? `@acme/${repository.split('/')[1]}` : repository,
                  action: (await exists({
                    repository,
                    ecosystem,
                    packageName:
                      ecosystem === 'npm' ? `@acme/${repository.split('/')[1]}` : repository,
                  }))
                    ? ('existing' as const)
                    : ('new' as const),
                  reason: null,
                });
              }
              return entries;
            },
          },
        });
        await executor.all({
          sql: "update user_account set status='suspended' where org_id=?",
          params: [a.orgId],
        });
        const input = {
          credentialId: CREDENTIAL_ID,
          installationId: 41,
          repositories: ['acme/library'],
        };
        const call = {
          audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
        };
        const add = service.addRegisteredName;
        service.addRegisteredName = async (...args) => {
          await executor.all({
            sql: "update job set lease_until='2000-01-01T00:00:00.000Z' where org_id=?",
            params: [a.orgId],
          });
          return add(...args);
        };
        const interrupted = await discovery.apply(
          a,
          { kind: 'rule', ruleId: RULE_ID },
          ruleFence(),
          input,
          call,
        );
        expect(interrupted).toMatchObject({ ok: true, value: { created: 0, failed: 2 } });
        service.addRegisteredName = add;
        await executor.all({
          sql: "update job set lease_until='2999-01-01T00:00:00.000Z' where org_id=?",
          params: [a.orgId],
        });
        statementCount = 0;
        const first = await discovery.apply(
          a,
          { kind: 'rule', ruleId: RULE_ID },
          ruleFence(),
          input,
          call,
        );
        expect(first).toMatchObject({ ok: true, value: { created: 2, failed: 0, skipped: 0 } });
        expect(statementCount).toBeLessThanOrEqual(100);
        const repeated = await discovery.apply(
          a,
          { kind: 'rule', ruleId: RULE_ID },
          ruleFence(),
          input,
          call,
        );
        expect(repeated).toMatchObject({ ok: true, value: { created: 0, existing: 2, failed: 0 } });
        expect(
          await executor.all({
            sql: 'select status from source where org_id=? order by id',
            params: [a.orgId],
          }),
        ).toEqual([{ status: 'active' }, { status: 'active' }]);
        const audit = await executor.all({
          sql: 'select distinct actor_type,actor_id from audit_pending where org_id=?',
          params: [a.orgId],
        });
        expect(audit).toEqual([{ actor_type: 'system', actor_id: RULE_ID }]);
        statementCount = 0;
        const several = await discovery.apply(
          a,
          { kind: 'rule', ruleId: RULE_ID },
          ruleFence(),
          { ...input, repositories: Array.from({ length: 8 }, (_, n) => `acme/budget-${n}`) },
          call,
        );
        expect(several.ok).toBe(true);
        if (several.ok) {
          expect(several.value.created).toBeGreaterThanOrEqual(6);
          expect(several.value.remainingRepositories.length).toBeGreaterThan(0);
        }
        expect(statementCount).toBeLessThanOrEqual(450);
      }));
    for (const [label, mutation] of [
      ['disabled', 'update source_discovery_rule set enabled=0 where org_id=?'],
      ['revision', 'update source_discovery_rule set revision=2 where org_id=?'],
      ['installation', 'update source_discovery_rule set installation_id=42 where org_id=?'],
      ['credential kind', "update credential set kind='github_token' where org_id=?"],
      ['credential scope', "update credential set project_id='project' where org_id=?"],
      ['lease expiry', "update job set lease_until='2000-01-01T00:00:00.000Z' where org_id=?"],
      ['lease fence', 'update job set fence=4 where org_id=?'],
      ['lease owner', "update job set lease_owner='other' where org_id=?"],
      ['job state', "update job set state='succeeded' where org_id=?"],
      ['job type', "update job set type='core:other:v1' where org_id=?"],
      ['resource key', "update job set resource_key='other' where org_id=?"],
      ['job payload', "update job set payload_json='{}' where org_id=?"],
    ] as const)
      it(`revokes authority on ${label} before checkpoint or source creation`, () =>
        fixture(async ({ executor, repo, a, b }) => {
          await executor.all({
            sql: "insert into project(id,org_id,slug,name) values('project',?,'project','Project')",
            params: [a.orgId],
          });
          const before = (await repo.get(a, RULE_ID))!;
          const held = async (org: OrgContext) =>
            executor.all<{ held: number }>(
              compile(
                db.selectNoFrom(
                  sql<number>`(${discoveryRuleAuthority(org, ruleFence())})`.as('held'),
                ),
              ),
            );
          expect((await held(a))[0]?.held).toBe(1);
          expect((await held(b))[0]?.held).toBe(0);
          await executor.all({ sql: mutation, params: [a.orgId] });
          expect((await held(a))[0]?.held).toBe(0);
          expect(
            await repo.checkpoint(a, ruleFence(), { ...before, created: 10 }, ruleAudit()),
          ).toBe(false);
          expect(
            await createSourceRepository(executor).create(a, ruleFence(), {
              id: ulid(),
              projectId: null,
              name: 'library',
              ecosystem: 'npm',
              type: 'vcs',
              url: null,
              configJson: '{}',
              credential: { id: CREDENTIAL_ID },
              providerAnchors: [],
              audit: ruleAudit(),
            }),
          ).toBe('forbidden');
          expect((await repo.get(a, RULE_ID))?.created).toBe(0);
        }));
  });
}
