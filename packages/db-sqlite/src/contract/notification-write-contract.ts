import { describe, expect, it } from 'vitest';
import type { NotificationEndpointTransition } from '@package-broker/core/db/notifications';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createNotificationReadRepository } from '../repositories/notification-read.js';
import type { CaseContext } from '../testing/mutation-table/harness.js';
import {
  OPTIONS,
  notificationWriter,
  transition,
  type NotificationWriter,
} from '../testing/mutation-table/notification-write.js';
import type { TwoOrganizations } from './two-organizations.js';

export interface OpenedNotificationWriter {
  readonly executor: SqlExecutor;
  readonly orgs: TwoOrganizations;
  close(): Promise<void>;
}

export function describeNotificationWriteContract(
  name: string,
  open: () => Promise<OpenedNotificationWriter>,
): void {
  async function withWriter(
    body: (
      writer: NotificationWriter,
      executor: SqlExecutor,
      orgs: TwoOrganizations,
    ) => Promise<void>,
  ): Promise<void> {
    const opened = await open();
    try {
      const context: CaseContext = {
        executor: opened.executor,
        orgs: opened.orgs,
        mutate: (statement) => statement,
        mutateBatch: (statements) => statements,
      };
      await body(await notificationWriter(context, opened.executor), opened.executor, opened.orgs);
    } finally {
      await opened.close();
    }
  }

  function step(
    writer: NotificationWriter,
    kind: 'enable' | 'disable' | 'delete',
    expectedRevision: number,
    overrides: Partial<NotificationEndpointTransition> = {},
  ) {
    const input = {
      id: 'E1',
      projectId: 'P1',
      expectedRevision,
      now: new Date().toISOString(),
      event: writer.event(
        `notification.${kind}`,
        overrides.id ?? 'E1',
        overrides.projectId ?? 'P1',
      ),
      ...overrides,
    };
    return transition(writer.repo, kind, writer, input);
  }

  async function audits(executor: SqlExecutor, orgId: string): Promise<string[]> {
    return (
      await executor.all<{ action: string }>({
        sql: 'SELECT action FROM audit_pending WHERE org_id = ? ORDER BY created_at, id',
        params: [orgId],
      })
    ).map((row) => row.action);
  }

  async function count(executor: SqlExecutor, sql: string, ...params: string[]): Promise<number> {
    const [row] = await executor.all<{ n: number }>({ sql, params });
    return row?.n ?? -1;
  }

  describe(`notification writes: ${name}`, () => {
    it('creates disabled, enables, disables and deletes with one audit record per change', async () => {
      await withWriter(async (writer, executor) => {
        expect(await writer.create('E1', 'P1', 'repo')).toEqual({ changed: true, revision: 1 });
        expect(await writer.row(writer.org.orgId, 'E1')).toMatchObject({
          state: 'disabled',
          revision: 1,
          disabled_reason: null,
        });
        expect(await step(writer, 'enable', 1)).toEqual({ changed: true, revision: 2 });
        expect(await step(writer, 'disable', 2)).toEqual({ changed: true, revision: 3 });
        expect(await writer.row(writer.org.orgId, 'E1')).toMatchObject({
          state: 'disabled',
          disabled_reason: 'manual',
        });
        expect(await step(writer, 'delete', 3)).toEqual({ changed: true, revision: 4 });
        expect(await writer.row(writer.org.orgId, 'E1')).toMatchObject({
          state: 'deleted',
          revision: 4,
        });
        expect(await audits(executor, writer.org.orgId)).toEqual([
          'notification.create',
          'notification.enable',
          'notification.disable',
          'notification.delete',
        ]);
        await expect(step(writer, 'enable', 4)).rejects.toMatchObject({ code: 'not_found' });
      });
    });

    it('treats a stale revision as a no-op without audit', async () => {
      await withWriter(async (writer, executor) => {
        await writer.create('E1', 'P1', 'repo');
        await step(writer, 'enable', 1);
        expect(await step(writer, 'disable', 1)).toEqual({ changed: false, revision: 2 });
        expect(await step(writer, 'enable', 2)).toEqual({ changed: false, revision: 2 });
        expect(await writer.row(writer.org.orgId, 'E1')).toMatchObject({
          state: 'enabled',
          revision: 2,
        });
        expect(await audits(executor, writer.org.orgId)).toEqual([
          'notification.create',
          'notification.enable',
        ]);
      });
    });

    it('refuses revoked authority and a missing reauthentication without changing anything', async () => {
      await withWriter(async (writer, executor) => {
        await writer.create('E1', 'P1', 'repo');
        await executor.all({
          sql: 'UPDATE session SET reauth_at = NULL WHERE org_id = ?',
          params: [writer.org.orgId],
        });
        await expect(writer.create('E2', 'P1', 'repo')).rejects.toMatchObject({
          code: 'forbidden',
        });
        await expect(step(writer, 'delete', 1)).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
          writer.repo.update(writer.org, writer.fence, {
            id: 'E1',
            projectId: 'P1',
            expectedRevision: 1,
            now: new Date().toISOString(),
            configuration: writer.sealed(),
            event: writer.event('notification.credential_set', 'E1'),
          }),
        ).rejects.toMatchObject({ code: 'forbidden' });
        expect(await step(writer, 'enable', 1)).toEqual({ changed: true, revision: 2 });
        await executor.all({
          sql: "UPDATE role_permission SET permission = 'project:packages:write' WHERE org_id = ? AND role_id = 'R-owner'",
          params: [writer.org.orgId],
        });
        await expect(step(writer, 'disable', 2)).rejects.toMatchObject({ code: 'forbidden' });
        expect(await writer.row(writer.org.orgId, 'E1')).toMatchObject({
          state: 'enabled',
          revision: 2,
        });
        expect(
          await count(
            executor,
            'SELECT count(*) AS n FROM notification_endpoint WHERE org_id = ?',
            writer.org.orgId,
          ),
        ).toBe(1);
        expect(await audits(executor, writer.org.orgId)).toEqual([
          'notification.create',
          'notification.enable',
        ]);
      });
    });

    it('rolls configuration back together with a refused audit record', async () => {
      await withWriter(async (writer, executor) => {
        await writer.create('E1', 'P1', 'repo');
        const event = writer.event('notification.enable', 'E1');
        await executor.all({
          sql: 'INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, action, target_type, target_id, project_id, payload_json) SELECT ?, org_id, created_at, actor_type, actor_id, action, target_type, target_id, project_id, payload_json FROM audit_pending WHERE org_id = ?',
          params: [event.id, writer.org.orgId],
        });
        await expect(step(writer, 'enable', 1, { event })).rejects.toMatchObject({
          code: 'unavailable',
        });
        expect(await writer.row(writer.org.orgId, 'E1')).toMatchObject({
          state: 'disabled',
          revision: 1,
        });
        const sealed = writer.sealed();
        const reused = writer.event('notification.create', 'E2');
        await executor.all({
          sql: 'INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, action, target_type, target_id, project_id, payload_json) SELECT ?, org_id, created_at, actor_type, actor_id, action, target_type, target_id, project_id, payload_json FROM audit_pending WHERE org_id = ? LIMIT 1',
          params: [reused.id, writer.org.orgId],
        });
        await expect(
          writer.repo.create(writer.org, writer.fence, {
            id: 'E2',
            projectId: 'P1',
            now: new Date().toISOString(),
            options: OPTIONS,
            configuration: sealed,
            event: reused,
          }),
        ).rejects.toMatchObject({ code: 'unavailable' });
        expect(await writer.row(writer.org.orgId, 'E2')).toBeUndefined();
        expect(
          await count(
            executor,
            'SELECT count(*) AS n FROM credential WHERE id = ?',
            sealed.credentialId,
          ),
        ).toBe(0);
      });
    });

    it('keeps concurrent creation within twenty live endpoints per project', async () => {
      await withWriter(async (writer, executor) => {
        const results = await Promise.all(
          Array.from({ length: 24 }, (_, index) =>
            writer.create(`E${String(index).padStart(2, '0')}`, 'P1', 'repo').then(
              (result) => result.changed,
              (error: { code?: string }) => error.code,
            ),
          ),
        );
        expect(results.filter((result) => result === true)).toHaveLength(20);
        expect(results.filter((result) => result === 'endpoint_limit')).toHaveLength(4);
        expect(
          await count(
            executor,
            "SELECT count(*) AS n FROM notification_endpoint WHERE org_id = ? AND project_id = 'P1'",
            writer.org.orgId,
          ),
        ).toBe(20);
        await step(writer, 'delete', 1, {
          id: 'E00',
          event: writer.event('notification.delete', 'E00'),
        });
        expect(await writer.create('E99', 'P1', 'repo')).toEqual({ changed: true, revision: 1 });
        await expect(writer.create('E00', 'P1', 'repo')).rejects.toMatchObject({
          code: 'conflict',
        });
      });
    });

    it('cannot reach another project or organization', async () => {
      await withWriter(async (writer, executor, orgs) => {
        await writer.create('E1', 'P1', 'repo');
        await expect(writer.create('E2', 'P2', 'repo')).rejects.toMatchObject({
          code: 'forbidden',
        });
        await expect(
          step(writer, 'enable', 1, {
            projectId: 'P2',
            event: writer.event('notification.enable', 'E1', 'P2'),
          }),
        ).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
          writer.repo.enable(orgs.b, writer.fence, {
            id: 'E1',
            projectId: 'P1',
            expectedRevision: 1,
            now: new Date().toISOString(),
            event: writer.event('notification.enable', 'E1'),
          }),
        ).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
          writer.repo.create(writer.org, writer.fence, {
            id: 'E3',
            projectId: 'P1',
            now: new Date().toISOString(),
            options: OPTIONS,
            configuration: writer.sealed('P2'),
            event: writer.event('notification.create', 'E3'),
          }),
        ).rejects.toMatchObject({ code: 'unavailable' });
        expect(await writer.row(writer.org.orgId, 'E1')).toMatchObject({
          state: 'disabled',
          revision: 1,
        });
        expect(
          await count(
            executor,
            'SELECT count(*) AS n FROM notification_endpoint WHERE org_id = ?',
            orgs.b.orgId,
          ),
        ).toBe(0);
      });
    });

    it('refuses an archived project', async () => {
      await withWriter(async (writer, executor) => {
        await writer.create('E1', 'P1', 'repo');
        await executor.all({
          sql: "UPDATE project SET status = 'archived' WHERE org_id = ? AND id = 'P1'",
          params: [writer.org.orgId],
        });
        await expect(step(writer, 'enable', 1)).rejects.toMatchObject({ code: 'forbidden' });
        await expect(writer.create('E2', 'P1', 'repo')).rejects.toMatchObject({
          code: 'forbidden',
        });
      });
    });

    it('disables on configuration replacement, keeps state on option edits and cancels pending work on delete', async () => {
      await withWriter(async (writer, executor) => {
        await writer.create('E1', 'P1', 'repo');
        await step(writer, 'enable', 1);
        expect(
          await writer.repo.update(writer.org, writer.fence, {
            id: 'E1',
            projectId: 'P1',
            expectedRevision: 2,
            now: new Date().toISOString(),
            options: {
              ...OPTIONS,
              name: 'Renamed',
              method: 'PUT',
              events: ['npm.package.released', 'npm.package.published'],
            },
            event: writer.event('notification.update', 'E1'),
          }),
        ).toEqual({ changed: true, revision: 3 });
        expect(
          await createNotificationReadRepository(executor).getEndpoint(writer.org, 'P1', 'E1'),
        ).toMatchObject({
          state: 'enabled',
          name: 'Renamed',
          method: 'PUT',
          events: ['npm.package.published', 'npm.package.released'],
        });
        const replacement = {
          ...writer.sealed(),
          headersConfigured: true,
          templateConfigured: true,
        };
        expect(
          await writer.repo.update(writer.org, writer.fence, {
            id: 'E1',
            projectId: 'P1',
            expectedRevision: 3,
            now: new Date().toISOString(),
            configuration: replacement,
            event: writer.event('notification.credential_set', 'E1'),
          }),
        ).toEqual({ changed: true, revision: 4 });
        expect(
          await createNotificationReadRepository(executor).getEndpoint(writer.org, 'P1', 'E1'),
        ).toMatchObject({
          state: 'disabled',
          disabledReason: 'configuration_changed',
          headersConfigured: true,
          templateConfigured: true,
        });
        expect(
          await count(
            executor,
            'SELECT count(*) AS n FROM notification_endpoint WHERE org_id = ? AND credential_id = ?',
            writer.org.orgId,
            replacement.credentialId,
          ),
        ).toBe(1);
        for (const [delivery, state, finished] of [
          ['D1', 'pending', null],
          ['D2', 'sending', null],
          ['D3', 'delivered', '2026-11-01T00:00:01.000Z'],
        ] as const) {
          await executor.all({
            sql: "INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at) VALUES (?, 'P1', ?, ?, 'npm.package.published', 'S', 'widget', '{}', '2026-11-01T00:00:00.000Z')",
            params: [writer.org.orgId, `V${delivery}`, `O${delivery}`],
          });
          await executor.all({
            sql: `INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision, configuration_credential_id, state, active_job_id, active_fence, next_attempt_at, expires_at, created_at, finished_at)
                  VALUES (?, 'P1', ?, ?, 'E1', 1, ?, ?, ?, ?, '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', '2026-11-01T00:00:00.000Z', ?)`,
            params: [
              writer.org.orgId,
              delivery,
              `V${delivery}`,
              replacement.credentialId,
              state,
              state === 'sending' ? 'J' : null,
              state === 'sending' ? 1 : null,
              finished,
            ],
          });
        }
        await step(writer, 'delete', 4);
        expect(
          await executor.all({
            sql: 'SELECT id, state, outcome_code FROM notification_delivery WHERE org_id = ? ORDER BY id',
            params: [writer.org.orgId],
          }),
        ).toEqual([
          { id: 'D1', state: 'cancelled', outcome_code: 'deleted' },
          { id: 'D2', state: 'sending', outcome_code: null },
          { id: 'D3', state: 'delivered', outcome_code: null },
        ]);
      });
    });

    it.each([
      ['an empty name', { name: '' }],
      ['a control character in the name', { name: 'a\u0007b' }],
      ['a bidi override in the name', { name: 'pay\u202Elpd' }],
      ['a zero-width space in the name', { name: 'zero\u200Bwidth' }],
      ['a line separator in the name', { name: 'line\u2028break' }],
      ['a lone surrogate in the name', { name: 'lone\uD800half' }],
      ['a regular expression pattern', { packagePattern: '^@acme/.*$' }],
      ['a GET method', { method: 'GET' }],
      ['no events', { events: [] }],
    ])('refuses %s before any write', async (_label, change) => {
      await withWriter(async (writer, executor) => {
        await expect(
          writer.repo.create(writer.org, writer.fence, {
            id: 'E1',
            projectId: 'P1',
            now: new Date().toISOString(),
            options: { ...OPTIONS, ...change } as never,
            configuration: writer.sealed(),
            event: writer.event('notification.create', 'E1'),
          }),
        ).rejects.toMatchObject({ code: 'invalid_request' });
        expect(
          await count(
            executor,
            'SELECT count(*) AS n FROM credential WHERE org_id = ?',
            writer.org.orgId,
          ),
        ).toBe(0);
      });
    });

    it('refuses an audit event for another action, endpoint or project', async () => {
      await withWriter(async (writer) => {
        await writer.create('E1', 'P1', 'repo');
        for (const event of [
          writer.event('notification.disable', 'E1'),
          writer.event('notification.enable', 'E2'),
          writer.event('notification.enable', 'E1', 'P2'),
        ])
          await expect(step(writer, 'enable', 1, { event })).rejects.toMatchObject({
            code: 'invalid_request',
          });
      });
    });
  });
}
