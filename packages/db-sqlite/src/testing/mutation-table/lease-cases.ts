import { expect } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import { fetchLeaseGuard, createFetchLeaseWriteGuard } from '../../repositories/fetch-lease.js';
import { jobLeaseGuard } from '../../repositories/job-lease-guard.js';
import { createCatalogueWriteGuard } from '../../repositories/catalogue-write-package.js';
import { orgOf, seeder, type ContractCase } from './harness.js';

const FUTURE = '2099-01-01T00:00:00.000Z';
const hash = 'a'.repeat(64);
const handle = { key: hash, owner: 'worker', fence: 3 };
const job = { id: 'J', owner: 'worker', fence: 3 };

export function leaseCase(kind: 'fetch' | 'job', factory: boolean): ContractCase {
  return {
    name: `${factory ? 'factory' : 'guard'} refuses a live ${kind} lease of another organization`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      if (kind === 'fetch') {
        await seed(
          'INSERT INTO fetch_lease (lease_key, org_id, owner, fence, lease_until, acquired_at) VALUES (?, ?, ?, 3, ?, ?)',
          hash,
          foreign.orgId,
          'worker',
          FUTURE,
          '2026-01-01T00:00:00.000Z',
        );
      } else {
        await seed(
          "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('J', ?, 'sync:v1', 'J', 'running', 'worker', ?, 3)",
          foreign.orgId,
          FUTURE,
        );
      }
      const build = (ctx: OrgContext): readonly Statement[] =>
        kind === 'fetch'
          ? factory
            ? createFetchLeaseWriteGuard(ctx, handle)
            : fetchLeaseGuard(ctx, handle)
          : factory
            ? createCatalogueWriteGuard(ctx, job)
            : jobLeaseGuard(ctx, job);
      // The same live lease is accepted by its owning organization.
      await context.executor.batch(build(foreign));
      await expect(context.executor.batch(context.mutateBatch(build(own)))).rejects.toThrow(
        ACCESS_MUTATION_GUARD_CONSTRAINT,
      );
    },
  };
}
