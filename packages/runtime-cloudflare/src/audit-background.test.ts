import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_AUDIT_JOURNAL_BYTES } from '@package-broker/core/audit/config';
import { resolveAuditJournalBudget } from '@package-broker/core/audit/effective';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { AuditBatchV1, AuditDelivery, PluginDefinition } from '@package-broker/core/plugin';
import { noopObservability } from '@package-broker/core/platform/observability';
import { jobFences } from '@package-broker/core/platform/job-fences';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { systemClock, ulid } from '@package-broker/core/ids';
import { auditEvent } from '@package-broker/core/audit/actions';
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import { auditPendingStatement } from '@package-broker/db-sqlite/repositories/audit-pending';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createWorkerAudit } from './audit.js';

const capacity = { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES };
const trail: PluginDefinition = {
  id: 'trail',
  package: '@test/trail',
  apiVersion: 4,
  platforms: ['cloudflare'],
  binds: ['audit-trail'],
  auditTrail: { create: () => ({ handle: async () => ({ items: [], next: null }) }) },
};
const ack = (batch: AuditBatchV1): AuditDelivery => ({
  outcome: 'accepted',
  chainId: batch.chainId,
  epoch: batch.epoch,
  throughSeq: batch.throughSeq,
  throughHash: batch.throughHash,
});
const env = (name: string) =>
  ({ ARCHIVE_URL: 'https://archive.example.test', ARCHIVE_HEADERS: 'Authorization=fixture' })[name];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('cloudflare audit background cutover recovery', () => {
  it.each(['availability', 'required'] as const)(
    'exports and prunes stored history through a conflicting pending cutover under %s',
    async (policy) => {
      const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
      const org = database.orgs!.a;
      const foreign = database.orgs!.b;
      const frontier = vi.fn(async () => null);
      const deliver = vi.fn(async (batch: AuditBatchV1) => ack(batch));
      const sink: PluginDefinition = {
        id: 'archive',
        package: '@test/archive',
        apiVersion: 4,
        platforms: ['cloudflare'],
        auditSinks: [
          {
            id: 'archive',
            kind: 'custom',
            activation: 'env',
            custody: 'durable',
            sourceIp: 'omit',
            destination: {
              protocol: 'https-json',
              urlEnv: 'ARCHIVE_URL',
              headersEnv: 'ARCHIVE_HEADERS',
            },
            create: () => ({ deliver, frontier }),
          },
        ],
      };
      const registration = collectRegistrations([trail, sink]);
      const audit = await createWorkerAudit({
        config: { platform: 'cloudflare', plugins: [trail, sink], audit: { capacity } },
        env,
        executor: database.executor,
        observability: noopObservability,
        generation: 0,
        maxJournalBytes: resolveAuditJournalBudget({ capacity }, 'cloudflare'),
        deploymentId: 'test',
        telemetryActive: true,
        registration: () => registration,
      });
      const event = auditEvent({
        id: ulid(),
        now: systemClock.now().toISOString(),
        action: 'project.update',
        actor: { type: 'system', id: null },
        context: { sourceIp: null, tokenSelector: null, requestId: null, opId: null },
        target: { type: 'project', id: null },
      });
      if (!event.ok) throw new Error('Invalid fixture');
      const jobs = createJobRepository(database.executor);
      const run = async (name: string) => {
        const job = audit.jobs.find((job) => job.name === name)!;
        const queued = await jobs.enqueue(org, {
          id: ulid(),
          type: `core:${name}:v1`,
          payloadJson: '{}',
          idempotencyKey: ulid(),
          maxAttempts: 3,
          resourceKey: job.schedule?.resourceKey ?? null,
          projectId: null,
          initiatorTokenId: null,
          runAt: systemClock.now().toISOString(),
        });
        const owner = ulid();
        const lease = await jobs.claim(org, owner, {
          id: queued.id,
          types: [`core:${name}:v1`],
          leaseSeconds: 120,
          maxRunning: 2,
        });
        if (lease === null) throw new Error('Missing lease');
        const context = {
          org,
          jobId: queued.id,
          idempotencyKey: queued.id,
          attempt: 1,
          fence: lease.fence,
          signal: AbortSignal.timeout(10_000),
          ports: { organizations: { get: async () => null }, clock: systemClock, ids: { ulid } },
          observability: noopObservability,
          fences: jobFences({ id: queued.id, owner, fence: lease.fence }),
        } satisfies JobContext;
        await job.handler(job.validate({}), context);
        await jobs.settle(
          org,
          { id: queued.id, owner, fence: lease.fence },
          { outcome: 'succeeded' },
        );
      };
      try {
        await audit.effective(org);
        await database.executor.batch([auditPendingStatement(org, event.event)]);
        await createAuditSealRepository(database.executor, {
          maxJournalBytes: capacity.maxJournalBytes,
        }).seal(org);
        await database.executor.batch([
          {
            sql: "UPDATE audit_chain SET policy = ?, pending_mode = 'export', cutover_seq = head_seq WHERE org_id = ?",
            params: [policy, org.orgId],
          },
        ]);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
        await expect(audit.effective(org)).rejects.toMatchObject({ code: 'audit_cutover_refused' });
        await run('audit-frontier');
        expect(frontier).toHaveBeenCalledOnce();
        await run('audit-export-archive');
        expect(deliver).toHaveBeenCalled();
        expect(deliver.mock.calls.every(([batch]) => batch.orgId === org.orgId)).toBe(true);
        expect(
          await database.executor.all({
            sql: 'SELECT progress_seq, custody_seq FROM audit_sink WHERE org_id = ?',
            params: [org.orgId],
          }),
        ).toEqual([{ progress_seq: 1, custody_seq: 1 }]);
        await run('audit-maintain');
        expect(
          await database.executor.all({
            sql: 'SELECT mode, pending_mode, boundary_seq, journal_rows FROM audit_chain WHERE org_id = ?',
            params: [org.orgId],
          }),
        ).toEqual([{ mode: 'export', pending_mode: null, boundary_seq: 2, journal_rows: 0 }]);
        expect(
          await database.executor.all({
            sql: 'SELECT head_seq, boundary_seq FROM audit_chain WHERE org_id = ?',
            params: [foreign.orgId],
          }),
        ).toEqual([{ head_seq: 0, boundary_seq: 1 }]);
      } finally {
        await database.close();
      }
    },
  );
  it('evicts to the shared budget during a conflicting pending cutover under availability', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const org = database.orgs!.a;
    const audit = await createWorkerAudit({
      config: { platform: 'cloudflare', plugins: [trail], audit: { capacity } },
      env,
      executor: database.executor,
      observability: noopObservability,
      generation: 0,
      maxJournalBytes: capacity.maxJournalBytes,
      telemetryActive: true,
      registration: () => collectRegistrations([trail]),
    });
    try {
      await audit.effective(org);
      const event = auditEvent({
        id: ulid(),
        now: systemClock.now().toISOString(),
        action: 'project.update',
        actor: { type: 'system', id: null },
        context: { sourceIp: null, tokenSelector: null, requestId: null, opId: null },
        target: { type: 'project', id: null },
      });
      if (!event.ok) throw new Error('Invalid fixture');
      await database.executor.batch([auditPendingStatement(org, event.event)]);
      await createAuditSealRepository(database.executor).seal(org);
      await database.executor.batch([
        {
          sql: "UPDATE audit_chain SET pending_mode = 'none', cutover_seq = head_seq, journal_bytes = ? WHERE org_id = ?",
          params: [capacity.maxJournalBytes, org.orgId],
        },
      ]);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      await expect(audit.effective(org)).rejects.toMatchObject({ code: 'audit_cutover_refused' });
      const job = audit.jobs.find((job) => job.name === 'audit-maintain')!;
      const id = ulid();
      await database.executor.batch([
        {
          sql: "INSERT INTO job (id, org_id, type, state, lease_owner, lease_until, fence) VALUES (?, ?, 'core:audit-maintain:v1', 'running', 'test', '2099-01-01T00:00:00.000Z', 1)",
          params: [id, org.orgId],
        },
      ]);
      await job.handler({}, {
        org,
        jobId: id,
        signal: new AbortController().signal,
        observability: noopObservability,
        fences: jobFences({ id, owner: 'test', fence: 1 }),
      } as JobContext);
      expect(
        await database.executor.all({
          sql: "SELECT kind, reason_code FROM audit_ledger WHERE org_id = ? AND kind = 'gap'",
          params: [org.orgId],
        }),
      ).toEqual([{ kind: 'gap', reason_code: 'capacity' }]);
      expect(
        await database.executor.all({
          sql: 'SELECT journal_rows, pending_mode FROM audit_chain WHERE org_id = ?',
          params: [org.orgId],
        }),
      ).toEqual([{ journal_rows: 0, pending_mode: 'none' }]);
    } finally {
      await database.close();
    }
  });
});
