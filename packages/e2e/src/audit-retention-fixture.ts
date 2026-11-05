import assert from 'node:assert/strict';
import { auditRaceBundle, staleSealRace } from './audit-race-fixture.js';

export interface StaleSealOutcome {
  outcome: string;
  attempted: number;
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
  return auditRaceBundle(bundle, '/__fixture/stale-seal', staleSealRace);
}
