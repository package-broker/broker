/* eslint-disable no-restricted-syntax -- Test infrastructure reads fixed SQL scoped to the pinned organization; no production SQL is added. */
import assert from 'node:assert/strict';
import { auditRaceBundle, staleSealRace } from './audit-race-fixture.js';
import { until, type LocalBroker } from './local.js';

export interface StaleSealOutcome {
  outcome: string;
  repaired: boolean;
  attempted: number;
  leaseAttempted: number;
  leaseRefused: boolean;
  winner: string;
  delivered: string;
  deliveries: number;
  sealed: Record<string, unknown> & { head_seq: number };
  ack: { progress_seq: number; custody_seq: number };
  prune: string;
  pruned: Record<string, unknown> & { head_seq: number; boundary_seq: number };
  afterStale: Record<string, unknown> & { head_seq: number };
}

export function retentionBundle(bundle: string): string {
  assert(!bundle.includes('let fixtureAuditExecutor;'), 'RetentionSealerAlreadyPatched');
  // Cold starts and restarts must not dispatch audit work at a minute boundary.
  const schedule = /function createJobScheduleRepository\((\w+)\) \{/g;
  assert.equal([...bundle.matchAll(schedule)].length, 1, 'RetentionSchedulePatchTargetMissing');
  bundle = bundle.replace(schedule, 'function fixtureCreateJobScheduleRepository($1) {');
  bundle = `function createJobScheduleRepository(executor) {
    const repository = fixtureCreateJobScheduleRepository(executor);
    return { ...repository, sync(org, definitions) {
      return repository.sync(org, definitions.map(definition => definition.name.startsWith('core:audit-')
        ? { ...definition, nextRunAt: '2099-01-01T00:00:00.000Z' } : definition));
    } };
  }\n${bundle}`;
  return auditRaceBundle(bundle, '/__fixture/stale-seal', staleSealRace);
}

const retentionSchedules = [
  'seal',
  'verify',
  'maintain',
  'head',
  'health-observe',
  'frontier',
  'export-webhook',
].map((kind) => `core:audit-${kind}:v1`);

export async function prepareRetentionRace(
  broker: Pick<LocalBroker, 'tick' | 'read'>,
  orgId: string,
): Promise<void> {
  await until(async () => {
    await broker.tick();
    const schedules = await broker.read<{ name: string; next_run_at: string }>(
      "SELECT name, next_run_at FROM job_schedule WHERE org_id = ? AND name LIKE 'core:audit-%'",
      [orgId],
    );
    if (!retentionSchedules.every((name) => schedules.some((row) => row.name === name)))
      return false;
    assert(
      schedules.every((row) => row.next_run_at === '2099-01-01T00:00:00.000Z'),
      'RetentionSchedulesNotPostponed',
    );
    const [row] = await broker.read<{ count: number }>(
      "SELECT count(*) AS count FROM job WHERE org_id = ? AND type LIKE 'core:audit-%' AND state IN ('queued', 'running')",
      [orgId],
    );
    return row?.count === 0;
  }, 'retention-race-ready');
}
