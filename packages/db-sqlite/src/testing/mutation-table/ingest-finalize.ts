import { expect } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createIngestFinalizer } from '../../repositories/ingest-finalize.js';
import { createIngestSessions } from '../../repositories/ingest-session.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { HASH, OWNER, NOT_NULL, seedSource, seedPackage, seedVersion } from './fixtures.js';

const STAMP = 'finalize-stamp';
const INPUT = {
  expectedCount: 0,
  upstreamComplete: true,
  validatorTtlSeconds: 60,
  attemptedCandidates: 0,
  successfulCandidates: 0,
  definitiveAbsent: 0,
};

function executorOf(context: CaseContext): SqlExecutor {
  return {
    ...context.executor,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  };
}

async function fixture(context: CaseContext, foreignTable?: 'blob' | 'version' | 'package') {
  const { own, foreign } = orgOf(context);
  const seed = seeder(context.executor);
  await seedSource(seed, 'S-FINAL', own.orgId, 'composer_repository');
  await seedPackage(
    seed.forged,
    'P-FINAL',
    foreignTable === 'package' ? foreign.orgId : own.orgId,
    'S-FINAL',
    'acme/one',
  );
  await seedVersion(
    seed.forged,
    'V-FINAL',
    foreignTable === 'version' ? foreign.orgId : own.orgId,
    'P-FINAL',
    '1.0.0',
  );
  await seed(
    'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
    'B-FINAL',
    foreignTable === 'blob' ? foreign.orgId : own.orgId,
    HASH,
    'blob-key',
  );
  await seed(
    "UPDATE version SET status = 'removed_upstream', removed_upstream_at = '2020-01-01T00:00:00.000Z', blob_id = 'B-FINAL'",
  );
  await seed('UPDATE source SET listing_open_stamp = ?', STAMP);
  await seed('UPDATE package SET listing_open_stamp = ?', STAMP);
  const sessions = createIngestSessions(context.executor);
  const session = await sessions.acquire(own, { scope: 'source', sourceId: 'S-FINAL' }, OWNER, 60);
  if (session === 'held') throw new Error('session held');
  await sessions.start(own, session, { stamp: STAMP, snapshot: { id: 'snapshot' } });
  return { session, seed };
}

const foreignSession: ContractCase = {
  name: 'finalize refuses a foreign organization session',
  async run(context) {
    const { session } = await fixture(context);
    expect(
      await createIngestFinalizer(executorOf(context)).finalize(
        orgOf(context).foreign,
        session,
        INPUT,
      ),
    ).toEqual({ status: 'refused', reason: 'session_unavailable' });
  },
};

const foreignPackage: ContractCase = {
  name: 'finalize package lookup refuses a foreign organization package',
  async run(context) {
    const { session, seed } = await fixture(context, 'package');
    await seed("UPDATE ingest_session SET scope = 'package', package_key = 'acme/one'");
    expect(
      await createIngestFinalizer(executorOf(context)).finalize(orgOf(context).own, session, INPUT),
    ).toEqual({ status: 'refused', reason: 'no_package' });
  },
};

function foreignBlobScope(table: 'blob' | 'version' | 'package'): ContractCase {
  return {
    name: `finalize blob update excludes a foreign ${table}`,
    async run(context) {
      const { session, seed } = await fixture(context, table);
      if (table === 'package') await seed('UPDATE package SET listing_seen_stamp = ?', STAMP);
      expect(
        await createIngestFinalizer(executorOf(context)).finalize(
          orgOf(context).own,
          session,
          INPUT,
        ),
      ).toEqual({ status: 'complete', empty: true, validatorsPublished: 0 });
      expect(
        await context.executor.all({
          sql: "SELECT refetchable FROM blob WHERE id = 'B-FINAL'",
          params: [],
        }),
      ).toEqual([{ refetchable: 1 }]);
    },
  };
}

const blobCases = (['blob', 'version', 'package'] as const).map(foreignBlobScope);

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createIngestFinalizer',
    file: 'repositories/ingest-finalize.ts',
    cases: [foreignSession, foreignPackage, ...blobCases],
    predicates: [
      {
        name: 'session read organization',
        locate: /"org_id" = \?/,
        neutral: NOT_NULL,
        caseName: foreignSession.name,
        copies: 1,
      },
      {
        name: 'package lookup organization',
        locate: /"org_id" = \?/,
        neutral: NOT_NULL,
        caseName: foreignPackage.name,
        copies: 2,
        waivedCopies: { 0: 'Session read is exercised by the foreign-session case.' },
      },
      ...(['blob', 'version', 'package'] as const).map((table, index) => ({
        name: `removed blob ${table} organization`,
        locate:
          table === 'package'
            ? /package\.org_id = \?/
            : new RegExp(`(?<=UPDATE blob[\\s\\S]*)${table}\\.org_id = \\?`),
        neutral: NOT_NULL,
        caseName: blobCases[index]!.name,
        copies: table === 'package' ? 3 : 1,
      })),
    ],
    waivers: [
      {
        locate: /ingest_session\.org_id = \?/,
        reason:
          'The session holder guard is registered by ingestSessionGuard; completion requires the same globally unique session id and holder validated by that guard.',
      },
      {
        locate: /(?<![\w.])org_id = \?/,
        reason:
          'The empty-listing open-stamp assertion uses the same source id as the guarded session; source ids are PRIMARY KEY. Completion uses that same guarded session id.',
      },
    ],
  },
];
