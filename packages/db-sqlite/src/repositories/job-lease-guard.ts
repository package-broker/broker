import { sql } from 'kysely';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type { JobGuard } from '@package-broker/core/platform/job-repository';
import { assertCheck } from '../kysely.js';

const MAX_TEXT = 512;

function text(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) {
    throw new RangeError(
      `${field} must be a non-empty string of at most ${String(MAX_TEXT)} characters`,
    );
  }
  return value;
}

function fenceOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('fence must be a positive integer');
  }
  return value;
}

export function jobLeaseGuard(ctx: OrgContext, guard: JobGuard): readonly Statement[] {
  const id = text('id', guard.id);
  const owner = text('owner', guard.owner);
  const fence = fenceOf(guard.fence);
  return assertCheck(
    sql<boolean>`EXISTS (SELECT 1 FROM job
      WHERE job.id = ${id} AND job.org_id = ${ctx.orgId}
        AND job.lease_owner = ${owner} AND job.fence = ${fence}
        AND job.state = 'running'
        AND job.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  );
}
