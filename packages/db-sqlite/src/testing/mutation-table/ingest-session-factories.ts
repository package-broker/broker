import { expect } from 'vitest';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
  createIngestSessionMaintenance,
} from '../../repositories/ingest-session.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { FUTURE, HASH, OWNER, seedSource, guardPasses, ref, ALWAYS } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
import { selectionOrgWaivers } from './source-selection.js';

const handle = {
  id: 'I',
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
async function seedSession(context: Parameters<ContractCase['run']>[0]): Promise<void> {
  const { own, foreign } = orgOf(context);
  const seed = seeder(context.executor);
  await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
  await seed(
    `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, started_at, updated_at) VALUES ('I', ?, 'source', ?, 'S', 1, ?, 3, ?, 'running', ?, ?)`,
    foreign.orgId,
    HASH,
    OWNER,
    FUTURE,
    FUTURE,
    FUTURE,
  );
}
const start: ContractCase = {
  name: 'starting an ingest session rejects a foreign child of an own source',
  async run(context) {
    await seedSession(context);
    const sessions = createIngestSessions(executing(context));
    expect(
      await sessions.start(orgOf(context).own, handle, {
        stamp: 'stamp',
        snapshot: { id: 'snapshot' },
      }),
    ).toBe(false);
    expect(
      await context.executor.all({
        sql: "SELECT stamp FROM ingest_session WHERE id = 'I'",
        params: [],
      }),
    ).toEqual([{ stamp: null }]);
  },
};
const guard: ContractCase = {
  name: 'the ingest write guard rejects a foreign child of an own source',
  async run(context) {
    await seedSession(context);
    expect(
      await guardPasses(context, createIngestSessionWriteGuard(orgOf(context).own, handle), true),
    ).toBe(false);
  },
};
const sweep: ContractCase = {
  name: 'maintenance does not collect an own session because of a newer foreign child',
  async run(context) {
    await seedSession(context);
    const { own } = orgOf(context);
    const seed = seeder(context.executor);
    await seed("UPDATE ingest_session SET state = 'complete', generation = 2 WHERE id = 'I'");
    await seed(
      `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, started_at, updated_at) VALUES ('I-OWN', ?, 'source', ?, 'S', 1, ?, 3, ?, 'complete', ?, ?)`,
      own.orgId,
      HASH,
      OWNER,
      FUTURE,
      FUTURE,
      FUTURE,
    );
    expect(await createIngestSessionMaintenance(executing(context)).sweep(10)).toEqual({
      abandoned: 0,
      deleted: 0,
    });
    expect(
      await context.executor.all({ sql: 'SELECT id FROM ingest_session ORDER BY id', params: [] }),
    ).toEqual([{ id: 'I' }, { id: 'I-OWN' }]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry(
    'ingest-session',
    'createIngestSessions',
    start,
    ref('ingest_session', 'org_id', '\\?'),
  ),
  factoryEntry(
    'ingest-session',
    'createIngestSessionWriteGuard',
    guard,
    ref('ingest_session', 'org_id', '\\?'),
    [
      ...selectionOrgWaivers,
      {
        locate: /source\.org_id = \?/,
        reason:
          'The composed selection_source organization guard independently scopes the same source; sourceSelectionCondition tests that guard in isolation.',
      },
    ],
  ),
  factoryEntry(
    'ingest-session',
    'createIngestSessionMaintenance',
    sweep,
    /newer\.org_id = old\.org_id/,
    [],
    ALWAYS,
  ),
];
