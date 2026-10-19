import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { entries as finalizeEntries } from './ingest-finalize.js';
import { expect } from 'vitest';
import { ingestSessionGuard, sweepStatements } from '../../repositories/ingest-session.js';
import {
  HASH,
  OWNER,
  FUTURE,
  seedSource,
  guardPasses,
  ref,
  NOT_NULL,
  WRITE_ORG,
  ALWAYS,
} from './fixtures.js';

async function seedIngest(
  context: CaseContext,
  id: string,
  orgId: string,
  generation: number,
): Promise<void> {
  await seeder(context.executor)(
    `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, started_at, updated_at)
      VALUES (?, ?, 'source', ?, 'S-INGEST', ?, ?, 3, ?, 'complete', ?, ?)`,
    id,
    orgId,
    HASH,
    generation,
    OWNER,
    FUTURE,
    FUTURE,
    FUTURE,
  );
}

const ingestHandle = {
  id: 'I-FOREIGN',
  owner: OWNER,
  fence: 3,
  scopeKey: HASH,
  leaseSeconds: 60,
  generation: 1,
  stamp: null,
  snapshotId: null,
  snapshotBlobSha256: null,
  cursor: null,
  seenCount: 0,
  pagesSoFar: 0,
  pendingValidators: null,
};

const ingestForeignGuard: ContractCase = {
  name: 'a live ingest holder of another organization cannot pass the guard',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedSource(seeder(context.executor), 'S-INGEST', foreign.orgId, 'npm_registry', 'npm');
    await seedIngest(context, ingestHandle.id, foreign.orgId, 1);
    await seeder(context.executor)(
      "UPDATE ingest_session SET state = 'running' WHERE id = ?",
      ingestHandle.id,
    );
    expect(await guardPasses(context, ingestSessionGuard(foreign, ingestHandle), false)).toBe(true);
    expect(await guardPasses(context, ingestSessionGuard(own, ingestHandle), true)).toBe(false);
  },
};

const sweepForeignGeneration: ContractCase = {
  name: 'a newer foreign ingest generation does not delete the latest own generation',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedSource(seeder(context.executor), 'S-INGEST', own.orgId, 'npm_registry', 'npm');
    await seedIngest(context, 'I-OWN', own.orgId, 1);
    await seedIngest(context, 'I-FOREIGN', foreign.orgId, 2);
    await context.executor.batch(
      sweepStatements(10, '2000-01-01T00:00:00.000Z', FUTURE).map(context.mutate),
    );
    expect(
      await context.executor.all({ sql: 'SELECT id FROM ingest_session ORDER BY id', params: [] }),
    ).toEqual([{ id: 'I-FOREIGN' }, { id: 'I-OWN' }]);
  },
};

const ingestGuardEntry: MutationEntry = {
  builder: 'ingestSessionGuard',
  file: 'repositories/ingest-session.ts',
  cases: [ingestForeignGuard],
  predicates: [
    {
      name: 'holder organization',
      locate: ref('ingest_session', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: ingestForeignGuard.name,
      copies: 1,
    },
  ],
  decisions: [
    {
      name: 'the holder guard reads the lease clock once',
      pattern: /strftime\('[^']*',\s*'now'\)/,
      expected: 1,
      build: () => ingestSessionGuard(WRITE_ORG, ingestHandle),
    },
  ],
};

const sweepEntry: MutationEntry = {
  builder: 'sweepStatements',
  file: 'repositories/ingest-session.ts',
  cases: [sweepForeignGeneration],
  predicates: [
    {
      name: 'newer generation belongs to the old organization',
      locate: /newer\.org_id = old\.org_id/,
      neutral: ALWAYS,
      caseName: sweepForeignGeneration.name,
      copies: 1,
    },
  ],
  decisions: [
    {
      name: 'both sweep decisions are bounded',
      pattern: /limit \?/,
      expected: 2,
      build: () => sweepStatements(10, '2000-01-01T00:00:00.000Z', FUTURE),
    },
  ],
};

export const entries: readonly MutationEntry[] = [ingestGuardEntry, sweepEntry, ...finalizeEntries];
