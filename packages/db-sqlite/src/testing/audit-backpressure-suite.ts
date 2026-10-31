import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditAction, AuditEvent } from '@package-broker/core/audit/actions';
import { createFailureEvents } from '@package-broker/core/audit/failure-events';
import { errorResponse, responseReason } from '@package-broker/core/kernel/errors';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { noopObservability } from '@package-broker/core/platform/observability';
import { sql } from 'kysely';
import { assertGuard, runOrgFenced } from '../kysely.js';
import { auditPendingStatement, auditReserveStatements } from '../repositories/audit-pending.js';
import { ulid } from '@package-broker/core/ids';
import { createUnlinkRepository } from '../repositories/unlink.js';
import { createAuditPruneRepository } from '../repositories/audit-prune.js';
import { seedAuditFork } from './audit-fork-suite.js';
import { createAuditSealRepository } from '../repositories/audit-seal.js';
import { createAuditFailureRepository } from '../repositories/audit-failure.js';
import type { MigratedDatabase } from './migrated-database.js';

const event: AuditEvent = {
  id: '01K7R5V0000000000000000001',
  occurredAt: '2026-10-30T10:00:00.000Z',
  actor: { type: 'system', id: null },
  tokenSelector: null,
  sourceIp: null,
  action: 'project.update',
  target: { type: 'project', id: null },
  projectId: null,
  payloadJson: '{}',
};
const reserve: readonly AuditAction[] = [
  'session.login',
  'session.logout',
  'session.reauth',
  'identity.block',
  'user.suspend',
  'token.revoke',
  'token.rotate',
  'grant.revoke',
  'project_grant.revoke',
  'service_principal.suspend',
  'source.pause',
  'audit.sink_admin',
  'audit.export',
  'audit.mode_change',
];

export function auditBackpressureSuite(open: () => Promise<MigratedDatabase>): void {
  describe('required audit backpressure', () => {
    let database: MigratedDatabase;
    beforeEach(async () => {
      database = await open();
      await database.executor.batch([
        {
          sql: "UPDATE audit_chain SET policy = 'required', capacity_state = 'refusing' WHERE org_id = ?",
          params: [database.orgs!.a.orgId],
        },
      ]);
    });
    afterEach(async () => database?.close());
    const pending = () =>
      database.executor.all({
        sql: 'SELECT action FROM audit_pending WHERE org_id = ?',
        params: [database.orgs!.a.orgId],
      });
    const stage = (action: AuditAction = event.action) =>
      auditPendingStatement(database.orgs!.a, { ...event, action });
    const business = () => ({
      sql: "INSERT INTO project (id, org_id, slug, name) VALUES ('business', ?, 'business', 'Business')",
      params: [database.orgs!.a.orgId],
    });

    it.each([
      'project.update',
      'token.issue',
      'grant.create',
      'source.create',
      'session.login_failed',
      'access.denied',
    ] as const)('atomically refuses %s and returns the fixed 503 envelope', async (action) => {
      let failure: unknown;
      try {
        await database.executor.batch([business(), stage(action)]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ kind: 'backlog_full', message: 'Audit backlog is full' });
      const log = vi.fn();
      const response = errorResponse(failure, 'request', log);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'audit_backlog_full', message: 'Audit backlog is full' },
      });
      expect(responseReason(response)).toBe('error.audit_backlog_full');
      expect(log.mock.calls).toEqual([
        [
          {
            level: 'error',
            event: 'http.error',
            request_id: 'request',
            error_name: 'DbError',
            reason_code: 'db.backlog_full',
          },
        ],
      ]);
      expect(await pending()).toEqual([]);
      expect(
        await database.executor.all({
          sql: 'SELECT id FROM project WHERE org_id = ?',
          params: [database.orgs!.a.orgId],
        }),
      ).toEqual([]);
    });
    it.each(reserve)('keeps %s in the reserve', async (action) => {
      await database.executor.batch([business(), stage(action)]);
      expect(await pending()).toEqual([{ action }]);
    });
    it('propagates refusal through an organization fence and rolls back its cache epoch', async () => {
      const ctx = database.orgs!.a;
      const epoch = () =>
        database.executor.all({
          sql: 'SELECT version FROM cache_epoch WHERE org_id = ?',
          params: [ctx.orgId],
        });
      const before = await epoch();
      await expect(
        runOrgFenced(
          database.executor,
          ctx,
          mutationFence(
            { userId: 'operator', sessionId: 'session' } as unknown as AuthenticatedActor,
            {},
          ),
          assertGuard(sql.lit(true), ctx),
          [business(), stage()],
          {},
        ),
      ).rejects.toMatchObject({ constraint: 'audit_pending.created_at' });
      expect(await epoch()).toEqual(before);
      expect(await pending()).toEqual([]);
    });
    it('checks capacity at execution and restores writes when refusal is lifted', async () => {
      const statement = stage();
      await expect(database.executor.batch([statement])).rejects.toMatchObject({
        kind: 'backlog_full',
      });
      await database.executor.batch([
        {
          sql: "UPDATE audit_chain SET capacity_state = 'warning' WHERE org_id = ?",
          params: [database.orgs!.a.orgId],
        },
        statement,
      ]);
      expect(await pending()).toEqual([{ action: event.action }]);
    });
    it('sees a refusal introduced earlier in the same batch and rolls everything back', async () => {
      const ctx = database.orgs!.a;
      await database.executor.batch([
        {
          sql: "UPDATE audit_chain SET capacity_state = 'ok' WHERE org_id = ?",
          params: [ctx.orgId],
        },
      ]);
      const statement = auditPendingStatement(ctx, event, { sql: '1', params: [] });
      await expect(
        database.executor.batch([
          {
            sql: "UPDATE audit_chain SET capacity_state = 'refusing' WHERE org_id = ?",
            params: [ctx.orgId],
          },
          business(),
          statement,
        ]),
      ).rejects.toMatchObject({ kind: 'backlog_full' });
      expect(
        await database.executor.all({
          sql: 'SELECT capacity_state FROM audit_chain WHERE org_id = ?',
          params: [ctx.orgId],
        }),
      ).toEqual([{ capacity_state: 'ok' }]);
      expect(
        await database.executor.all({
          sql: 'SELECT id FROM project WHERE org_id = ?',
          params: [ctx.orgId],
        }),
      ).toEqual([]);
      expect(await pending()).toEqual([]);
    });
    it('stays within 100 bound parameters with an 88-parameter condition', async () => {
      const statement = auditPendingStatement(
        database.orgs!.a,
        { ...event, action: 'session.logout' },
        {
          sql: Array.from({ length: 88 }, () => '? = 1').join(' AND '),
          params: Array.from({ length: 88 }, () => 1),
        },
      );
      expect(statement.params).toHaveLength(100);
      await database.executor.batch([statement]);
      expect(await pending()).toEqual([{ action: 'session.logout' }]);
    });
    it('does not refuse an unselected conditional event', async () => {
      await database.executor.batch([
        business(),
        auditPendingStatement(database.orgs!.a, event, { sql: '0', params: [] }),
      ]);
      expect(await pending()).toEqual([]);
      expect(
        await database.executor.all({
          sql: 'SELECT id FROM project WHERE org_id = ?',
          params: [database.orgs!.a.orgId],
        }),
      ).toEqual([{ id: 'business' }]);
    });
    it('keeps refusal scoped to the context organization', async () => {
      await database.executor.batch([auditPendingStatement(database.orgs!.b, event)]);
      expect(await pending()).toEqual([]);
      expect(
        await database.executor.all({
          sql: 'SELECT action FROM audit_pending WHERE org_id = ?',
          params: [database.orgs!.b.orgId],
        }),
      ).toEqual([{ action: event.action }]);
    });
    it('keeps availability writes accepting while its state says refusing', async () => {
      await database.executor.batch([
        {
          sql: "UPDATE audit_chain SET policy = 'availability' WHERE org_id = ?",
          params: [database.orgs!.a.orgId],
        },
        business(),
        stage(),
      ]);
      expect(await pending()).toEqual([{ action: event.action }]);
    });
    it.each(['required', 'availability'] as const)(
      'sealing crosses capacity only under %s',
      async (policy) => {
        const ctx = database.orgs!.a;
        await database.executor.batch([
          {
            sql: "UPDATE audit_chain SET policy = ?, capacity_state = 'ok' WHERE org_id = ?",
            params: [policy, ctx.orgId],
          },
          stage(),
        ]);
        expect(
          await createAuditSealRepository(database.executor, { maxJournalBytes: 1 }).seal(ctx),
        ).toMatchObject({ outcome: 'sealed' });
        expect(
          await database.executor.all({
            sql: 'SELECT org_id, capacity_state FROM audit_chain ORDER BY org_id',
            params: [],
          }),
        ).toEqual([
          { org_id: ctx.orgId, capacity_state: policy === 'required' ? 'refusing' : 'ok' },
          { org_id: database.orgs!.b.orgId, capacity_state: 'ok' },
        ]);
      },
    );
    it('re-evaluates refusal on an empty seal after the budget is raised', async () => {
      const ctx = database.orgs!.a;
      await database.executor.batch([stage('token.revoke')]);
      await createAuditSealRepository(database.executor, { maxJournalBytes: 1 }).seal(ctx);
      const [chain] = await database.executor.all<{ journal_bytes: number }>({
        sql: 'SELECT journal_bytes FROM audit_chain WHERE org_id = ?',
        params: [ctx.orgId],
      });
      await expect(
        createAuditSealRepository(database.executor, {
          maxJournalBytes: chain!.journal_bytes * 2,
        }).seal(ctx),
      ).resolves.toEqual({ outcome: 'empty' });
      expect(
        await database.executor.all({
          sql: 'SELECT capacity_state FROM audit_chain WHERE org_id = ?',
          params: [ctx.orgId],
        }),
      ).toEqual([{ capacity_state: 'ok' }]);
      await database.executor.batch([stage()]);
      expect(await pending()).toEqual([{ action: event.action }]);
    });

    it('retention pruning keeps refusal above low water and clears it at low water', async () => {
      const ctx = database.orgs!.a;
      await seedAuditFork(database.executor, ctx);
      const at = new Date(event.occurredAt);
      await database.executor.batch([
        auditPendingStatement(ctx, { ...event, id: ulid(at.getTime()), action: 'session.logout' }),
        auditPendingStatement(ctx, {
          ...event,
          id: ulid(at.getTime() + 1),
          action: 'session.logout',
          payloadJson: JSON.stringify('x'.repeat(4000)),
        }),
        auditPendingStatement(ctx, {
          ...event,
          id: ulid(at.getTime() + 2),
          action: 'session.logout',
          payloadJson: JSON.stringify('x'.repeat(4000)),
        }),
      ]);
      await createAuditSealRepository(database.executor).seal(ctx);
      const [chain] = await database.executor.all<{ journal_bytes: number }>({
        sql: 'SELECT journal_bytes FROM audit_chain WHERE org_id = ?',
        params: [ctx.orgId],
      });
      await database.executor.batch([
        { sql: "UPDATE audit_chain SET mode = 'export' WHERE org_id = ?", params: [ctx.orgId] },
        {
          sql: 'UPDATE audit_sink SET progress_seq = 3, custody_seq = 3 WHERE org_id = ?',
          params: [ctx.orgId],
        },
      ]);
      const prune = createAuditPruneRepository(database.executor, undefined, {
        maxJournalBytes: chain!.journal_bytes,
      });
      const options = {
        generation: 2,
        configuredSinkIds: ['archive'],
        trailActive: false,
        limit: 1,
      };
      expect(await prune.prune(ctx, options)).toMatchObject({ outcome: 'pruned' });
      await expect(database.executor.batch([stage()])).rejects.toMatchObject({
        kind: 'backlog_full',
      });
      expect(await prune.prune(ctx, options)).toMatchObject({ outcome: 'pruned' });
      await expect(database.executor.batch([stage()])).resolves.toBeDefined();
      expect(
        await database.executor.all({
          sql: 'SELECT capacity_state FROM audit_chain WHERE org_id = ?',
          params: [database.orgs!.b.orgId],
        }),
      ).toEqual([{ capacity_state: 'ok' }]);
    });
    it.each([false, true])(
      'unlink reserves only a newly staged block (existing=%s)',
      async (existing) => {
        const ctx = database.orgs!.a;
        const now = event.occurredAt;
        const expires = '2030-01-01T00:00:00.000Z';
        await database.executor.batch([
          {
            sql: "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
            params: [ctx.orgId],
          },
          {
            sql: "INSERT INTO user_account (id, org_id, email) VALUES ('actor', ?, 'actor@example.test'), ('target', ?, 'target@example.test')",
            params: [ctx.orgId, ctx.orgId],
          },
          {
            sql: "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('target-identity', ?, 'target', 'oidc', 'subject', 'target@example.test', 1, ?)",
            params: [ctx.orgId, now],
          },
          {
            sql: "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('actor-identity', ?, 'actor', 'oidc', 'actor-subject', 'actor@example.test', 1, ?)",
            params: [ctx.orgId, new Date().toISOString()],
          },
          {
            sql: "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES ('session', ?, 'actor', ?, ?, ?, ?)",
            params: [ctx.orgId, 'a'.repeat(64), 'b'.repeat(64), new Date().toISOString(), expires],
          },
          {
            sql: "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('admin', ?, 'admin', 'Admin', 'organization', 1)",
            params: [ctx.orgId],
          },
          {
            sql: "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'admin', 'org:users:write')",
            params: [ctx.orgId],
          },
          {
            sql: "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', 'actor@example.test', 'organization', 'admin')",
            params: [ctx.orgId],
          },
          ...(existing
            ? [
                {
                  sql: "INSERT INTO identity_block (org_id, provider, issuer, subject, blocked_at, blocked_by_user_id) VALUES (?, 'oidc', 'oidc:https://idp.example.test', 'subject', ?, 'actor')",
                  params: [ctx.orgId, now],
                },
              ]
            : []),
        ]);
        const result = createUnlinkRepository(database.executor, {
          holderInput: async () => ({
            kind: 'fresh',
            now: new Date().toISOString(),
            providers: [
              {
                provider: 'oidc',
                anchor: 'oidc:https://idp.example.test',
                emailAuthoritative: true,
                emailAuthoritativeDomains: ['example.test'],
              },
            ],
          }),
        }).unlinkIdentity(
          ctx,
          mutationFence(
            { userId: 'actor', sessionId: 'session' } as unknown as AuthenticatedActor,
            {},
          ),
          {
            identityId: 'target-identity',
            userId: 'target',
            provider: 'oidc',
            subject: 'subject',
            anchor: 'oidc:https://idp.example.test',
            now,
          },
          {
            unlink: { ...event, action: 'identity.unlink' },
            block: { ...event, id: ulid(), action: 'identity.block' },
          },
        );
        if (existing) {
          await expect(result).rejects.toMatchObject({ kind: 'backlog_full' });
          expect(await pending()).toEqual([]);
        } else {
          await expect(result).resolves.toBe('unlinked');
          expect((await pending()).map((row) => row.action).sort()).toEqual([
            'identity.block',
            'identity.unlink',
          ]);
        }
      },
    );
    it('does not expose input column names to a caller condition', async () => {
      await expect(
        database.executor.batch([
          auditPendingStatement(database.orgs!.a, event, {
            sql: 'id = ?',
            params: [event.id],
          }),
        ]),
      ).rejects.toThrow('no such column: id');
      expect(await pending()).toEqual([]);
    });
    it.each(['token.issue', 'identity.unlink'] as const)(
      'reserves only the companion operation for %s',
      async (action) => {
        const ctx = database.orgs!.a;
        const companion = action === 'token.issue' ? 'token.rotate' : 'identity.block';
        await expect(
          database.executor.batch([auditPendingStatement(ctx, { ...event, action })]),
        ).rejects.toMatchObject({ kind: 'backlog_full' });
        await database.executor.batch([
          ...auditReserveStatements(
            ctx,
            { ...event, action: companion },
            { ...event, id: '01K7R5V0000000000000000003', action },
          ),
        ]);
        expect((await pending()).map((row) => row.action).sort()).toEqual(
          [action, companion].sort(),
        );
      },
    );
    it.each([
      ['token.rotate', 'token.issue'],
      ['identity.block', 'identity.unlink'],
    ] as const)(
      'refuses %s companion when its reserve insert selects nothing',
      async (reserve, companion) => {
        const ctx = database.orgs!.a;
        await expect(
          database.executor.batch([
            ...auditReserveStatements(
              ctx,
              { ...event, action: reserve },
              { ...event, action: companion },
              { sql: '0', params: [] },
            ),
          ]),
        ).rejects.toMatchObject({ kind: 'backlog_full' });
        expect(await pending()).toEqual([]);
      },
    );
    it('does not allow a legacy builder option to exempt plain issuance', async () => {
      const ctx = database.orgs!.a;
      const statement = Reflect.apply(auditPendingStatement, undefined, [
        ctx,
        { ...event, action: 'token.issue' },
        undefined,
        { companionReserve: 'token.rotate' },
      ]);
      await expect(database.executor.batch([business(), statement])).rejects.toMatchObject({
        kind: 'backlog_full',
      });
      expect(await pending()).toEqual([]);
    });
    it('rejects ordinary events as reserve companions', () => {
      expect(() =>
        auditReserveStatements(
          database.orgs!.a,
          { ...event, action: 'project.update' },
          { ...event, action: 'token.issue' },
        ),
      ).toThrow('Invalid audit reserve companion');
    });
    it.each([
      ['session.login_failed', true],
      ['access.denied', true],
      ['session.login_failed', false],
      ['access.denied', false],
    ] as const)(
      'records %s with refusal=%s without changing the auth outcome',
      async (action, refusing) => {
        if (!refusing)
          await database.executor.batch([
            {
              sql: "UPDATE audit_chain SET capacity_state = 'ok' WHERE org_id = ?",
              params: [database.orgs!.a.orgId],
            },
          ]);
        const counter = vi.fn();
        const log = vi.fn();
        const recorder = createFailureEvents({
          staging: createAuditFailureRepository(database.executor),
          observability: { ...noopObservability, counter, log },
          deploymentId: 'deployment',
          routeTemplates: new Set(['/_pb/projects']),
          now: () => new Date(event.occurredAt),
        });
        const attempt =
          action === 'session.login_failed'
            ? {
                action,
                userId: null,
                method: 'local' as const,
                reason: 'unknown_account' as const,
                context: { sourceIp: null },
              }
            : {
                action,
                actor: { type: 'user' as const, id: '01K7R5V0000000000000000002' },
                routeTemplate: '/_pb/projects',
                permission: null,
                boundary: 'organization' as const,
                context: { sourceIp: null },
              };
        await recorder.record(database.orgs!.a, attempt);
        await recorder.drain(database.orgs!.a);
        if (!refusing) {
          expect(await pending()).toEqual([{ action }]);
          expect(counter).not.toHaveBeenCalled();
          expect(log).not.toHaveBeenCalled();
          return;
        }
        expect(await pending()).toEqual([]);
        expect(counter).toHaveBeenCalledExactlyOnceWith('pb.audit.failure_events_suppressed');
        expect(log).toHaveBeenCalledExactlyOnceWith({
          level: 'error',
          event: 'audit.failure_event_refused',
        });
      },
    );
  });
}
