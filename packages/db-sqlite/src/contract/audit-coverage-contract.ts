import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditEvent,
} from '@package-broker/core/audit/actions';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { describe, expect, it } from 'vitest';
import { createRegisteredNameRepository } from '../repositories/registered-name.js';
import {
  ANCHORS,
  seedBindings,
  seedSubject,
  seedSource,
  fenceOf,
} from '../testing/mutation-table/fixtures.js';
import { seeder, type CaseContext } from '../testing/mutation-table/harness.js';
import { createSessionRepository } from '../repositories/session.js';
import { createVisibilityAttachRepository } from '../repositories/visibility-attach.js';
import { createVisibilitySubsetRepository } from '../repositories/visibility-subset.js';

interface CoverageEntry {
  readonly actions: readonly AuditAction[];
  /** Paths are relative to packages/. Multiple callers share the same staging path. */
  readonly callers: readonly string[];
  readonly repository: string;
  readonly batchGuard: string;
  readonly cardinality: string;
  readonly stagingCalls: number;
  readonly stagingBuilder?: 'visibilityAuditStatements';
  readonly callerBuilders?: readonly {
    readonly caller: string;
    readonly call: string;
    readonly builderFile: string;
    readonly bridge?: { readonly file: string; readonly call: string; readonly builder: string };
    readonly actions: readonly AuditAction[];
  }[];
}

export const AUDIT_COVERAGE: readonly CoverageEntry[] = [
  {
    actions: ['audit.sink_admin'],
    callers: ['core/src/audit/fork.ts'],
    repository: 'audit-fork',
    batchGuard:
      'executor.batch; full chain and sink-set CAS, observed journal hashes and organization build-generation fence',
    cardinality:
      '1 per new fork detection or restore confirmation; tooling-marked restores stage zero on detection',
    stagingCalls: 1,
  },
  {
    actions: ['audit.mode_change'],
    callers: ['core/src/audit/none.ts'],
    repository: 'audit-none',
    batchGuard:
      'executor.batch; complete snapshot CAS, restore and required-policy refusal, highest sink generation fence',
    cardinality:
      '1 per accepted transition to none; refused, stale and unchanged transitions stage zero',
    stagingCalls: 1,
  },
  {
    actions: ['session.login_failed', 'access.denied'],
    callers: ['core/src/audit/failure-events.ts'],
    repository: 'audit-failure',
    batchGuard: 'executor.batch; single auditPendingStatement without a business mutation',
    cardinality:
      '0 or 1 per attempt: thresholds 1/10/100/1000 per key per minute, capped at 600 per organization; auth wiring belongs to G43/G44',
    stagingCalls: 1,
  },
  {
    actions: ['audit.sink_admin'],
    callers: ['core/src/audit/sinks/registry.ts'],
    repository: 'audit-sink',
    batchGuard:
      'executor.batch; chain identity, incarnation, mode generation, boundary, restore state and sink snapshot compare-and-swap',
    cardinality:
      '1 per receiver configuration change; retired reuse, stale and unchanged registrations stage zero',
    stagingCalls: 1,
  },
  {
    actions: ['session.login'],
    callers: ['core/src/auth/identity-login.ts'],
    repository: 'login',
    batchGuard: 'executor.batch; provider anchor, invitation, identity and created-session guards',
    cardinality: '0 or 1: only the session created by this operation',
    stagingCalls: 1,
  },
  {
    actions: ['session.login', 'session.reauth'],
    callers: ['core/src/auth/local-login.ts'],
    repository: 'local-login-success',
    batchGuard: 'executor.batch; local_login opGuard and successful credential/session effect',
    cardinality: '0 or 1: login session created or reauth performed',
    stagingCalls: 1,
  },
  {
    actions: ['setup.complete'],
    callers: ['core/src/auth/local-setup.ts'],
    repository: 'local-login-setup',
    batchGuard: 'executor.batch; local_login opGuard and completed setup/session effect',
    cardinality: '0 or 1: successful setup only',
    stagingCalls: 1,
  },
  {
    actions: ['session.logout', 'session.reauth'],
    callers: ['core/src/auth/session.ts', 'core/src/auth/identity-reauth.ts'],
    repository: 'session',
    batchGuard:
      'executor.batch; EXISTS eligible unrevoked session, reauth freshness/identity guard',
    cardinality:
      '0 or 1; no active session stages zero; active-session logout stages one, including sanitizer fallback, unless fallback construction fails',
    stagingCalls: 2,
  },
  {
    actions: ['role.create', 'role.rename', 'role.permissions_set', 'role.delete'],
    callers: ['core/src/authz/administration.ts'],
    repository: 'role',
    batchGuard: 'runOrgFenced; live authority, revision, protected holder and idempotency guards',
    cardinality: '1 per changed role; no-op/replay/refusal stages zero',
    stagingCalls: 4,
  },
  {
    actions: [
      'grant.create',
      'grant.revoke',
      'grant.role_change',
      'user.suspend',
      'user.reactivate',
    ],
    callers: ['core/src/authz/administration.ts'],
    repository: 'grant',
    batchGuard: 'runOrgFenced; live authority, revision, protected holder and idempotency guards',
    cardinality: '1 per changed grant/user; no-op/replay/refusal stages zero',
    stagingCalls: 5,
  },
  {
    actions: ['project.create', 'project.update', 'project.archive', 'project.restore'],
    callers: ['core/src/authz/project-service.ts'],
    repository: 'project',
    batchGuard: 'runOrgFenced; live authority, revision, target and idempotency guards',
    cardinality: '1 per changed project; no-op/replay/refusal stages zero',
    stagingCalls: 3,
  },
  {
    actions: ['project_grant.create', 'project_grant.revoke', 'project_grant.role_change'],
    callers: ['core/src/authz/project-administration.ts'],
    repository: 'project-grant',
    batchGuard:
      'runOrgFenced; project authority, revision, protected holder and idempotency guards',
    cardinality: '1 per changed grant; no-op/replay/refusal stages zero',
    stagingCalls: 3,
  },
  {
    actions: ['identity.unblock'],
    callers: ['core/src/authz/unlink-service.ts'],
    repository: 'identity-block',
    batchGuard: 'runOrgFenced; authority and performed operation guard',
    cardinality: '0 or 1: unblock performed',
    stagingCalls: 1,
  },
  {
    actions: ['identity.unlink', 'identity.block'],
    callers: ['core/src/authz/unlink-service.ts'],
    repository: 'unlink',
    batchGuard: 'runOrgFenced; live authority, identity ownership and remaining sign-in method',
    cardinality: '1 unlink plus 0 or 1 block, conditional on changes() = 1',
    stagingCalls: 2,
  },
  {
    actions: ['token.issue', 'token.revoke', 'token.rotate'],
    callers: [
      'core/src/authz/pat-service.ts',
      'core/src/authz/service-token-service.ts',
      'core/src/authz/token-revoke.ts',
    ],
    repository: 'token',
    batchGuard:
      'runOrgFenced; live actor/service principal, revision and performed operation guards',
    cardinality:
      '1 issue/revoke; rotation: issue plus 0 or 1 rotate; stored payload patched with json_set',
    stagingCalls: 5,
  },
  {
    actions: ['token.revoke'],
    callers: ['core/src/authz/pat-offboarding.ts'],
    repository: 'pat-offboarding',
    batchGuard: 'executor.batch; system fence, pending invalidation and performed token guards',
    cardinality: '0 or 1 per selected token actually revoked',
    stagingCalls: 1,
  },
  {
    actions: [
      'service_principal.create',
      'service_principal.permissions_set',
      'service_principal.suspend',
      'service_principal.restore',
    ],
    callers: ['core/src/authz/service-principal-service.ts'],
    repository: 'service-principal',
    batchGuard:
      'runOrgFenced; live authority, revision, performed operation and idempotency guards',
    cardinality: '0 or 1: performed service-principal mutation',
    stagingCalls: 1,
  },
  {
    actions: [
      'source.create',
      'source.update',
      'source.pause',
      'source.resume',
      'source.credential_set',
      'source.sync_requested',
      'source.removal_accepted',
    ],
    callers: ['core/src/sources/source-service.ts'],
    repository: 'source',
    batchGuard: 'runOrgFenced; source authority/revision, target and idempotency guards',
    cardinality: '1 per mutation; conditional paths use changes() > 0 or operation guard',
    stagingCalls: 6,
  },
  {
    actions: ['source.package_requested'],
    callers: ['core/src/api/routes/source-packages.ts'],
    repository: 'source-package-request',
    batchGuard:
      'runOrgFenced; project source authority, active attachment/source; job in same batch',
    cardinality: '0 for probe without audit/job; 1 per accepted audited request',
    stagingCalls: 1,
  },
  {
    actions: ['registered_name.add', 'registered_name.remove', 'source.pause', 'source.resume'],
    callers: ['core/src/sources/source-service.ts'],
    repository: 'registered-name',
    batchGuard:
      'runOrgFenced; source/name authority, visibility, activatability and idempotency guards',
    cardinality: '1 add/resume; removal: 1 remove plus 0 or 1 pause if changes() = 1',
    stagingCalls: 4,
  },
  {
    actions: ['source.attach', 'source.detach', 'source.reorder', 'source.update'],
    callers: ['core/src/catalogue/visibility-service.ts'],
    repository: 'visibility-audit',
    batchGuard: 'visibility repository fenced batch; immediately follows domain mutation',
    cardinality: '0 or 1 per changed operation using changes() > 0',
    stagingCalls: 1,
  },
  {
    actions: ['source.attach', 'source.detach', 'source.reorder'],
    callers: ['core/src/catalogue/visibility-service.ts'],
    repository: 'visibility-attach',
    stagingBuilder: 'visibilityAuditStatements',
    batchGuard: 'runOrgFenced; source authority, project and attachment guards',
    cardinality: '0 or 1 per changed attachment/order using changes() > 0',
    stagingCalls: 4,
  },
  {
    actions: ['source.update'],
    callers: ['core/src/catalogue/visibility-service.ts'],
    repository: 'visibility-subset',
    stagingBuilder: 'visibilityAuditStatements',
    batchGuard: 'runOrgFenced; package management authority and attachment guards',
    cardinality: '0 or 1 per changed pattern using changes() > 0',
    stagingCalls: 2,
  },
  {
    actions: ['version.state_change'],
    callers: ['core/src/catalogue/package-manage-service.ts'],
    repository: 'catalogue-writer',
    batchGuard: 'runOrgFenced; version authority/revision, blob lease and idempotency guards',
    cardinality: '1 per accepted version state transition',
    stagingCalls: 1,
  },
  {
    actions: [
      'role.create',
      'project.create',
      'source.create',
      'registered_name.add',
      'source.attach',
      'grant.create',
      'project_grant.create',
      'version.published_at_set',
      'import_run.apply',
      'import_run.fail',
      'import_run.verify',
    ],
    callers: [
      'core/src/import/apply.ts',
      'core/src/import/verification.ts',
      'db-sqlite/src/repositories/import-journal.ts',
    ],
    repository: 'import-journal',
    callerBuilders: [
      {
        caller: 'core/src/import/verification.ts',
        call: 'deps.store.verify(',
        bridge: {
          file: 'db-sqlite/src/repositories/import-verification.ts',
          call: 'journal.markVerified(',
          builder: 'markVerified(',
        },
        builderFile: 'db-sqlite/src/repositories/import-journal.ts',
        actions: ['import_run.verify'],
      },
    ],
    batchGuard:
      'runFenced; delegated approver authority, run state, job lease, journal key and blob guards',
    cardinality:
      '1 per newly applied item, zero for duplicate journal keys; 1 terminal state event; stored target resolved in batch',
    stagingCalls: 2,
  },
  {
    actions: ['import_run.rollback'],
    callers: ['core/src/import/rollback.ts'],
    repository: 'import-rollback',
    batchGuard:
      'runFenced; delegated authority, job lease, run state and entity revision/image guards',
    cardinality: '0 or 1 per restored item using done guard; supplied summary audits at finish',
    stagingCalls: 2,
  },
  {
    actions: ['import_run.fail'],
    callers: [
      'core/src/import/verification.ts',
      'db-sqlite/src/repositories/import-verification.ts',
    ],
    repository: 'import-verification',
    callerBuilders: [
      {
        caller: 'core/src/import/verification.ts',
        call: 'deps.store.fail(',
        builderFile: 'db-sqlite/src/repositories/import-verification.ts',
        actions: ['import_run.fail'],
      },
    ],
    batchGuard: 'system fence and job lease in state-change batch',
    cardinality: '1 when verification failure transitions the run; refusal stages zero',
    stagingCalls: 1,
  },
  {
    actions: ['source.removal_applied'],
    callers: [
      'core/src/ingest/apply-description.ts',
      'core/src/ingest/source-sync-job.ts',
      'core/src/ingest/on-demand.ts',
      'core/src/ingest/package-sync-job.ts',
      'db-sqlite/src/repositories/ingest-finalize.ts',
    ],
    callerBuilders: [
      ...['apply-description', 'source-sync-job'].map((caller) => ({
        caller: `core/src/ingest/${caller}.ts`,
        call: 'deps.finalizer.finalize(',
        builderFile: 'db-sqlite/src/repositories/ingest-finalize.ts',
        actions: ['source.removal_applied'] as const,
      })),
      ...['on-demand', 'package-sync-job'].map((caller) => ({
        caller: `core/src/ingest/${caller}.ts`,
        call: 'deps.apply.finalizer.finalize(',
        builderFile: 'db-sqlite/src/repositories/ingest-finalize.ts',
        actions: ['source.removal_applied'] as const,
      })),
    ],
    repository: 'ingest-finalize',
    batchGuard: 'executor.batch; catalogue/session/job guard and finalized listing predicate',
    cardinality:
      '0 or 1 removal event; changes drives outcome; counts patched with json_set in batch',
    stagingCalls: 1,
  },
];

export const AUDIT_INJECTED_STATEMENTS = [
  {
    actions: [
      'import_run.create',
      'import_run.approve',
      'import_run.apply',
      'import_run.rollback',
      'import_run.cancel',
      'import_run.accept',
      'import_run.verify',
    ] satisfies readonly AuditAction[],
    caller: 'core/src/api/routes/import.ts',
    service: 'core/src/import/run-service.ts',
    wiring: 'db-sqlite/src/repositories/api-services.ts',
    repository: 'db-sqlite/src/repositories/import-run.ts',
    batchGuard: 'runFenced; run state/revision, authority, blob and idempotency guards',
    cardinality: '1 per successful run transition; no replay or refused transition event',
  },
  {
    actions: ['import_run.credential_set'] satisfies readonly AuditAction[],
    caller: 'core/src/import/credentials.ts',
    service: 'core/src/import/credentials.ts',
    wiring: 'db-sqlite/src/repositories/api-services.ts',
    repository: 'db-sqlite/src/repositories/import-credential.ts',
    batchGuard:
      'runOrgFenced; import write authority, run credential window and source revision; injected auditStatement in same batch',
    cardinality: '1 per accepted credential set',
  },
] as const;

const LATER_PACKET_ACTIONS: ReadonlySet<string> = new Set(['audit.export']);

export const AUDIT_UNCAPTURED: readonly {
  readonly action: AuditAction;
  readonly reason: string;
}[] = [
  ...AUDIT_ACTIONS.filter((action) => LATER_PACKET_ACTIONS.has(action)).map((action) => ({
    action,
    reason: 'declared; producers in later packets',
  })),
  {
    action: 'version.rebuilt',
    reason: 'Declared action; no production event producer or staging caller today.',
  },
  {
    action: 'purge.batch',
    reason: 'Declared action; no production event producer or staging caller today.',
  },
  {
    action: 'sync_session.finalize',
    reason: 'Declared action; no production event producer or staging caller today.',
  },
];

export const AUDIT_SECURITY_ATTEMPTS = [
  {
    attempt: 'failed login',
    captured: false,
    reason:
      'Login events require a successful session/reauth effect; credential/throttle failures stage nothing.',
  },
  {
    attempt: 'authorization denial',
    captured: false,
    reason:
      'Denied requests return before mutation or abort the authority fence; no denial action exists.',
  },
  {
    attempt: 'failed reauthentication',
    captured: false,
    reason: 'Only a successful fresh reauthentication stages session.reauth.',
  },
  {
    attempt: 'logout without active session',
    captured: false,
    reason: 'Revokes without audit; not a failed authentication.',
  },
] as const;

export const AUDIT_SANITIZER_FALLBACKS = [
  {
    attempt: 'logout sanitizer refusal',
    captured: true,
    reason: 'A safe fallback session.logout is staged atomically with revocation.',
  },
] as const;

interface AuditCoverageDatabase {
  readonly executor: SqlExecutor;
  readonly ctx: OrgContext;
  readonly foreign: OrgContext;
  close(): Promise<void>;
}

const statement = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const NOW = '2026-10-28T00:00:00.000Z';
const HASH = 'a'.repeat(64);
function event(action: AuditAction = 'session.logout'): AuditEvent {
  return {
    id: '01K7R5V0000000000000000001',
    occurredAt: NOW,
    action,
    actor: { type: 'system', id: null },
    tokenSelector: null,
    sourceIp: null,
    target: { type: 'session', id: null },
    projectId: null,
    payloadJson: '{}',
  };
}

export function describeAuditCoverageContract(open: () => Promise<AuditCoverageDatabase>): void {
  describe('audit coverage atomicity and cardinality', () => {
    async function fixture(body: (database: AuditCoverageDatabase) => Promise<void>) {
      const database = await open();
      try {
        await body(database);
      } finally {
        await database.close();
      }
    }
    const pending = ({ executor, ctx }: AuditCoverageDatabase) =>
      executor.all(
        statement('SELECT id, action FROM audit_pending WHERE org_id = ? ORDER BY id', ctx.orgId),
      );
    async function seedSession({ executor, ctx }: AuditCoverageDatabase) {
      await executor.batch([
        statement(
          "INSERT INTO user_account (id, org_id, email) VALUES ('actor', ?, 'fixture@example.test')",
          ctx.orgId,
        ),
        statement(
          "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES ('session', ?, 'actor', ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
          ctx.orgId,
          HASH,
          HASH,
          NOW,
          NOW,
        ),
      ]);
    }
    it('audit failure rolls back revocation, then the same operation succeeds once storage recovers', async () => {
      await fixture(async (database) => {
        const { executor, ctx } = database;
        await seedSession(database);
        const sessions = createSessionRepository(executor);
        await executor.batch([
          statement(
            "CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_pending BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
          ),
        ]);
        await expect(sessions.revokeBySecretHash(ctx, HASH, NOW, event())).rejects.toBeDefined();
        expect(
          await executor.all(
            statement('SELECT revoked_at FROM session WHERE org_id = ?', ctx.orgId),
          ),
        ).toEqual([{ revoked_at: null }]);
        expect(await pending(database)).toEqual([]);
        await executor.batch([statement('DROP TRIGGER refuse_audit')]);
        expect(await sessions.revokeBySecretHash(ctx, HASH, NOW, event())).toBe(true);
        expect(await pending(database)).toEqual([{ id: event().id, action: 'session.logout' }]);
      });
    });
    it('a failed change rolls back an already staged event', async () => {
      await fixture(async (database) => {
        const { executor, ctx } = database;
        await seedSession(database);
        await executor.batch([
          statement(
            "CREATE TRIGGER refuse_revoke BEFORE UPDATE ON session BEGIN SELECT RAISE(ABORT, 'change unavailable'); END",
          ),
        ]);
        await expect(
          createSessionRepository(executor).revokeBySecretHash(ctx, HASH, NOW, event()),
        ).rejects.toBeDefined();
        expect(await pending(database)).toEqual([]);
        expect(
          await executor.all(
            statement('SELECT revoked_at FROM session WHERE org_id = ?', ctx.orgId),
          ),
        ).toEqual([{ revoked_at: null }]);
      });
    });
    it('replay, unknown session and foreign organization stage zero additional events', async () => {
      await fixture(async (database) => {
        const { executor, ctx } = database;
        await seedSession(database);
        const sessions = createSessionRepository(executor);
        expect(await sessions.revokeBySecretHash(ctx, 'b'.repeat(64), NOW, event())).toBe(false);
        expect(await sessions.revokeBySecretHash(database.foreign, HASH, NOW, event())).toBe(false);
        expect(
          await executor.all(
            statement('SELECT id FROM audit_pending WHERE org_id = ?', database.foreign.orgId),
          ),
        ).toEqual([]);
        expect(await pending(database)).toEqual([]);
        expect(await sessions.revokeBySecretHash(ctx, HASH, NOW, event())).toBe(true);
        const original = await pending(database);
        expect(original).toHaveLength(1);
        expect(
          await sessions.revokeBySecretHash(ctx, HASH, NOW, {
            ...event(),
            id: '01K7R5V0000000000000000002',
          }),
        ).toBe(false);
        expect(await pending(database)).toEqual(original);
      });
    });
    it.each(['attach', 'subset'] as const)(
      'conditional visibility audit follows real %s repository changes and no-ops',
      async (path) => {
        await fixture(async (database) => {
          const { executor, ctx, foreign } = database;
          const context: CaseContext = {
            executor,
            orgs: { a: ctx, b: foreign },
            mutate: (s) => s,
            mutateBatch: (s) => s,
          };
          const seed = seeder(executor);
          await seedBindings(context);
          await seed(
            "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'project', 'project')",
            ctx.orgId,
          );
          const actor = await seedSubject(context, 'visibility', { projectId: 'project' });
          await seed(
            "UPDATE role_permission SET permission = ? WHERE org_id = ? AND role_id = 'R-visibility'",
            path === 'attach' ? 'project:sources:write' : 'project:packages:manage',
            ctx.orgId,
          );
          await seedSource(seed, 'source', ctx.orgId, 'vcs');
          await seed(
            "UPDATE source SET project_id = 'project' WHERE org_id = ? AND id = 'source'",
            ctx.orgId,
          );
          const action = path === 'attach' ? 'source.attach' : 'source.update';
          const attach = createVisibilityAttachRepository(executor, { providerAnchors: ANCHORS });
          const subset = createVisibilitySubsetRepository(executor);
          if (path === 'subset')
            await seed(
              "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'project', 'source', 100)",
              ctx.orgId,
            );
          for (const changed of [true, false]) {
            const audit = {
              ...event(action),
              id: changed ? event().id : '01K7R5V0000000000000000002',
            };
            const input = { projectId: 'project', sourceId: 'source', audit };
            if (path === 'attach') {
              expect(await attach.attachSource(ctx, fenceOf(actor), input)).toMatchObject({
                ok: true,
              });
            } else {
              expect(
                await subset.addPattern(ctx, fenceOf(actor), {
                  ...input,
                  pattern: 'acme/*',
                  effect: 'include',
                  providerAnchors: ANCHORS,
                }),
              ).toBe(changed ? 'added' : 'unchanged');
            }
            expect(await pending(database)).toEqual([{ id: event().id, action }]);
          }
          const table = path === 'attach' ? 'project_source' : 'project_package_pattern';
          expect(
            await executor.all(
              statement(
                `SELECT source_id FROM ${table} WHERE org_id = ? AND project_id = 'project'`,
                ctx.orgId,
              ),
            ),
          ).toEqual([{ source_id: 'source' }]);
        });
      },
    );
    it.each([false, true])(
      'name removal stages one event plus a conditional pause (still covered: %s)',
      async (covered) => {
        await fixture(async (database) => {
          const { executor, ctx, foreign } = database;
          const context: CaseContext = {
            executor,
            orgs: { a: ctx, b: foreign },
            mutate: (s) => s,
            mutateBatch: (s) => s,
          };
          const seed = seeder(executor);
          await seedBindings(context);
          const actor = await seedSubject(context, 'coverage');
          await seed(
            "UPDATE role_permission SET permission = 'org:sources:write' WHERE org_id = ? AND role_id = ?",
            ctx.orgId,
            'R-coverage',
          );
          await seedSource(seed, 'source', ctx.orgId, 'vcs');
          await seed(
            "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('name', ?, 'source', 'composer', 'acme/*')",
            ctx.orgId,
          );
          if (covered)
            await seed(
              "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('other', ?, 'source', 'composer', 'tools/*')",
              ctx.orgId,
            );
          const removeAudit = {
            ...event('registered_name.remove'),
            target: { type: 'registered_name', id: 'name' },
          };
          const pauseAudit = {
            ...event('source.pause'),
            id: '01K7R5V0000000000000000002',
            target: { type: 'source', id: 'source' },
          };
          const names = createRegisteredNameRepository(executor);
          const input = { id: 'name', audit: removeAudit, pauseAudit, providerAnchors: ANCHORS };
          expect(await names.remove(ctx, fenceOf(actor), input)).toBe(
            covered ? 'removed' : 'removed_and_paused',
          );
          const expected = [
            { id: removeAudit.id, action: 'registered_name.remove' },
            ...(!covered ? [{ id: pauseAudit.id, action: 'source.pause' }] : []),
          ];
          expect(await pending(database)).toEqual(expected);
          expect(
            await executor.all(statement('SELECT status FROM source WHERE org_id = ?', ctx.orgId)),
          ).toEqual([{ status: covered ? 'active' : 'paused' }]);
          expect(await names.remove(ctx, fenceOf(actor), input)).toBe('not_found');
          expect(await pending(database)).toEqual(expected);
        });
      },
    );
  });
}
