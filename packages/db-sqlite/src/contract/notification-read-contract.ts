import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createNotificationReadRepository } from '../repositories/notification-read.js';
import { seedNotificationRows } from '../testing/mutation-table/notification-read.js';
import type { TwoOrganizations } from './two-organizations.js';

export interface OpenedNotificationOrgs {
  readonly executor: SqlExecutor;
  readonly orgs: TwoOrganizations;
  close(): Promise<void>;
}

const SUMMARY_KEYS = [
  'createdAt',
  'destinationConfigured',
  'disabledReason',
  'events',
  'failureStreak',
  'headersConfigured',
  'id',
  'method',
  'name',
  'packagePattern',
  'projectId',
  'revision',
  'signingConfigured',
  'state',
  'templateConfigured',
  'updatedAt',
];

export function describeNotificationReadContract(
  name: string,
  open: () => Promise<OpenedNotificationOrgs>,
): void {
  async function withRows(body: (opened: OpenedNotificationOrgs) => Promise<void>): Promise<void> {
    const opened = await open();
    try {
      await seedNotificationRows(opened.executor, opened.orgs.a.orgId, '');
      await seedNotificationRows(opened.executor, opened.orgs.b.orgId, 'B');
      await body(opened);
    } finally {
      await opened.close();
    }
  }

  async function run(executor: SqlExecutor, sql: string, ...params: (string | number | null)[]) {
    await executor.all({ sql, params });
  }

  describe(`notification reads: ${name}`, () => {
    it('reads only the owning organization and project when notification ids collide', async () => {
      await withRows(async ({ executor, orgs }) => {
        const repo = createNotificationReadRepository(executor);
        expect(
          (await repo.listEndpoints(orgs.a, 'P1', { limit: 50 })).items.map((e) => e.name),
        ).toEqual(['E1', 'E3']);
        expect(
          (await repo.listEndpoints(orgs.b, 'P1B', { limit: 50 })).items.map((e) => e.name),
        ).toEqual(['E1B', 'E3B']);
        expect((await repo.listEndpoints(orgs.b, 'P1', { limit: 50 })).items).toEqual([]);
        expect((await repo.listEndpoints(orgs.a, 'P1B', { limit: 50 })).items).toEqual([]);
        expect(await repo.getEndpoint(orgs.a, 'P2', 'E1')).toBeNull();
        expect((await repo.getEndpoint(orgs.b, 'P1B', 'E1'))?.name).toBe('E1B');
        expect(await repo.getDelivery(orgs.b, 'P1', 'E1', 'D1')).toBeNull();
        expect(await repo.getDelivery(orgs.a, 'P2', 'E1', 'D1')).toBeNull();
        expect(await repo.getDelivery(orgs.a, 'P1', 'E2', 'D1')).toBeNull();
        await expect(repo.listDeliveries(orgs.a, 'P1', 'E2', { limit: 50 })).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(repo.listDeliveries(orgs.a, 'P2', 'E1', { limit: 50 })).rejects.toMatchObject({
          code: 'not_found',
        });
      });
    });

    it('returns only the safe configuration summary', async () => {
      await withRows(async ({ executor, orgs }) => {
        await run(
          executor,
          "UPDATE notification_endpoint SET state = 'enabled', headers_configured = 1, events_json = ? WHERE org_id = ? AND id = 'E1'",
          '["npm.package.dist_tag_changed","npm.package.published"]',
          orgs.a.orgId,
        );
        const summary = await createNotificationReadRepository(executor).getEndpoint(
          orgs.a,
          'P1',
          'E1',
        );
        expect(Object.keys(summary ?? {}).sort()).toEqual(SUMMARY_KEYS);
        expect(summary).toMatchObject({
          state: 'enabled',
          events: ['npm.package.published', 'npm.package.dist_tag_changed'],
          headersConfigured: true,
          templateConfigured: false,
          destinationConfigured: true,
          signingConfigured: true,
        });
        expect(JSON.stringify(summary)).not.toContain('C-P1');
      });
    });

    it('hides deleted endpoints but keeps their delivery history readable', async () => {
      await withRows(async ({ executor, orgs }) => {
        await run(
          executor,
          "UPDATE notification_endpoint SET state = 'deleted', disabled_reason = 'manual' WHERE org_id = ? AND id = 'E1'",
          orgs.a.orgId,
        );
        const repo = createNotificationReadRepository(executor);
        expect(await repo.getEndpoint(orgs.a, 'P1', 'E1')).toBeNull();
        expect(
          (await repo.listEndpoints(orgs.a, 'P1', { limit: 50 })).items.map((e) => e.id),
        ).toEqual(['E3']);
        expect(
          (await repo.listDeliveries(orgs.a, 'P1', 'E1', { limit: 50 })).items.map((d) => d.id),
        ).toEqual(['D1']);
      });
    });

    it('refuses missing and foreign-scope history while retaining deleted endpoint history', async () => {
      await withRows(async ({ executor, orgs }) => {
        const repo = createNotificationReadRepository(executor);
        await run(
          executor,
          "UPDATE notification_endpoint SET state = 'deleted' WHERE org_id = ? AND id = 'E1'",
          orgs.a.orgId,
        );
        for (const [ctx, project, endpoint] of [
          [orgs.a, 'P2', 'E1'],
          [orgs.b, 'P1', 'E1'],
          [orgs.a, 'P1', 'missing'],
        ] as const)
          await expect(
            repo.listDeliveries(ctx, project, endpoint, { limit: 50 }),
          ).rejects.toMatchObject({ code: 'not_found' });
        expect((await repo.listDeliveries(orgs.a, 'P1', 'E1', { limit: 50 })).items).toHaveLength(
          1,
        );
      });
    });

    it('pages endpoints with stable cursors that never cross scope', async () => {
      await withRows(async ({ executor, orgs }) => {
        const repo = createNotificationReadRepository(executor);
        const first = await repo.listEndpoints(orgs.a, 'P1', { limit: 1 });
        expect(first.items.map((e) => e.id)).toEqual(['E1']);
        expect(first.next).toBe('E1');
        const second = await repo.listEndpoints(orgs.a, 'P1', { limit: 1, cursor: first.next! });
        expect(second).toMatchObject({ next: null });
        expect(second.items.map((e) => e.id)).toEqual(['E3']);
        expect((await repo.listEndpoints(orgs.b, 'P1', { limit: 1, cursor: 'E0' })).items).toEqual(
          [],
        );
        expect(
          (await repo.listEndpoints(orgs.a, 'P2', { limit: 50, cursor: 'E1' })).items.map(
            (e) => e.id,
          ),
        ).toEqual(['E2']);
      });
    });

    it('pages delivery history newest first, filters by state and keeps foreign cursors inert', async () => {
      await withRows(async ({ executor, orgs }) => {
        for (const [id, at, state] of [
          ['D3', '2026-11-01T13:00:00.000Z', 'pending'],
          ['D4', '2026-11-01T13:00:00.000Z', 'pending'],
          ['D5', '2026-11-01T14:00:00.000Z', 'delivered'],
        ] as const) {
          await run(
            executor,
            "INSERT INTO notification_event (org_id, project_id, id, operation_id, event_type, source_id, package_key, payload_json, occurred_at) VALUES (?, 'P1', ?, ?, 'npm.package.released', 'S', 'widget', '{}', ?)",
            orgs.a.orgId,
            `V${id}`,
            `O${id}`,
            at,
          );
          await run(
            executor,
            "INSERT INTO notification_delivery (org_id, project_id, id, event_id, endpoint_id, endpoint_revision, configuration_credential_id, state, next_attempt_at, expires_at, created_at, finished_at, last_status, outcome_code) VALUES (?, 'P1', ?, ?, 'E1', 1, 'C-P1', ?, ?, '2026-11-02T14:00:00.000Z', ?, ?, ?, ?)",
            orgs.a.orgId,
            id,
            `V${id}`,
            state,
            at,
            at,
            state === 'delivered' ? at : null,
            state === 'delivered' ? 204 : null,
            state === 'delivered' ? 'ok' : null,
          );
        }
        const repo = createNotificationReadRepository(executor);
        const first = await repo.listDeliveries(orgs.a, 'P1', 'E1', { limit: 2 });
        expect(first.items.map((d) => d.id)).toEqual(['D5', 'D4']);
        expect(first.items[0]).toMatchObject({
          eventType: 'npm.package.released',
          nextAttemptAt: null,
          lastStatus: 204,
          outcomeCode: 'ok',
        });
        expect(first.next).toBe('2026-11-01T13:00:00.000Z~D4');
        const second = await repo.listDeliveries(orgs.a, 'P1', 'E1', {
          limit: 2,
          cursor: first.next!,
        });
        expect(second.items.map((d) => d.id)).toEqual(['D3', 'D1']);
        expect(second.next).toBeNull();
        expect(
          (
            await repo.listDeliveries(orgs.a, 'P1', 'E1', { limit: 50, state: 'delivered' })
          ).items.map((d) => d.id),
        ).toEqual(['D5']);
        const foreign = await repo.listDeliveries(orgs.b, 'P1B', 'E1', { limit: 1 });
        expect(foreign.items.map((d) => d.id)).toEqual(['D1']);
        expect(
          (
            await repo.listDeliveries(orgs.b, 'P1B', 'E1', { limit: 50, cursor: first.next! })
          ).items.map((d) => d.id),
        ).toEqual(['D1']);
        await expect(
          repo.listDeliveries(orgs.b, 'P1', 'E1', {
            limit: 50,
            cursor: '2099-01-01T00:00:00.000Z~ZZ',
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
      });
    });

    it('returns bounded attempt history for one delivery', async () => {
      await withRows(async ({ executor, orgs }) => {
        await run(
          executor,
          "UPDATE notification_attempt SET outcome = 'retry', outcome_code = 'http_retry', status = 503, duration_ms = 12, finished_at = '2026-11-01T12:00:01.000Z' WHERE org_id = ?",
          orgs.a.orgId,
        );
        await run(
          executor,
          "INSERT INTO notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, started_at) VALUES (?, 'P1', 'D1', 2, 'J', 2, 'started', '2026-11-01T12:05:00.000Z')",
          orgs.a.orgId,
        );
        const detail = await createNotificationReadRepository(executor).getDelivery(
          orgs.a,
          'P1',
          'E1',
          'D1',
        );
        expect(detail?.history).toEqual([
          {
            attempt: 1,
            outcome: 'retry',
            outcomeCode: 'http_retry',
            status: 503,
            durationMs: 12,
            startedAt: '2026-11-01T12:00:00.000Z',
            finishedAt: '2026-11-01T12:00:01.000Z',
          },
          {
            attempt: 2,
            outcome: 'started',
            outcomeCode: null,
            status: null,
            durationMs: null,
            startedAt: '2026-11-01T12:05:00.000Z',
            finishedAt: null,
          },
        ]);
        expect(detail).toMatchObject({
          state: 'pending',
          nextAttemptAt: '2026-11-01T12:00:00.000Z',
          eventType: 'npm.package.published',
        });
      });
    });

    it.each([
      ['a zero limit', { limit: 0 }],
      ['a limit over 50', { limit: 51 }],
      ['a malformed delivery cursor', { limit: 1, cursor: 'D1' }],
      ['a cursor with an extra part', { limit: 1, cursor: '2026-11-01T13:00:00.000Z~D4~x' }],
      ['an unknown state', { limit: 1, state: 'queued' }],
    ])('refuses %s', async (_label, query) => {
      await withRows(async ({ executor, orgs }) => {
        await expect(
          createNotificationReadRepository(executor).listDeliveries(
            orgs.a,
            'P1',
            'E1',
            query as never,
          ),
        ).rejects.toMatchObject({ name: 'NotificationRepositoryError', code: 'invalid_request' });
      });
    });
  });
}
