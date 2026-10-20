import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { PendingValidators } from '@package-broker/core/ingest/validators';
import { createUpstreamStateRepository } from './upstream-state.js';
import type { IngestSessionHandle } from '@package-broker/core/ingest/session';
import { describeComposerV2 } from '@package-broker/core/ingest/composer/v2-package';
import { fixedClock } from '@package-broker/core/ids';
import { createPolicyFetch } from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueReconciler } from './catalogue-reconcile.js';
import { createIngestFinalizer, type IngestFinalizeInput } from './ingest-finalize.js';
import { createIngestSessionWriteGuard, createIngestSessions } from './ingest-session.js';

const SOURCE = '01J0SRC0000000000000000S01';
const PACKAGE = '01J0PKG0000000000000000K01';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0A01';
const OLD = '2020-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const NAME = 'acme/one';
const TTL = 600;
const dist = (version: string) => ({
  type: 'zip',
  url: `https://dl.example.com/${NAME}/${version}.zip`,
  reference: 'abc',
});
const VALIDATORS = {
  'composer-p2': { etag: '"v1"', lastModified: null, contentSha256: 'c'.repeat(64) },
};

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;

function stmt(sql: string, ...params: (string | number | null)[]): Statement {
  return { sql, params };
}

const run = (...statements: Statement[]) => database.executor.batch(statements);
const all = <R>(sql: string, ...params: (string | number | null)[]) =>
  database.executor.all<R>(stmt(sql, ...params));

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
  other = database.orgs.b;
  await run(
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'composer', 'composer_repository')",
      SOURCE,
      org.orgId,
    ),
    stmt(
      `INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
        VALUES (?, ?, ?, 'composer', ?, ?)`,
      PACKAGE,
      org.orgId,
      SOURCE,
      NAME,
      OLD,
    ),
  );
});

afterEach(async () => {
  await database.close();
});

async function seedVersions(...names: string[]): Promise<void> {
  for (const name of names) {
    await run(
      stmt(
        `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key)
          VALUES (?, ?, ?, 1, ?)`,
        `B-${name}`,
        org.orgId,
        name.padEnd(64, '0'),
        `k/${name}`,
      ),
      stmt(
        `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
            published_at_basis, metadata_json, updated_at, blob_id)
          VALUES (?, ?, ?, ?, ?, ?, 'release_date', '{}', ?, ?)`,
        `V-${name}`,
        org.orgId,
        PACKAGE,
        name,
        name,
        OLD,
        OLD,
        `B-${name}`,
      ),
    );
  }
}

interface Begun {
  session: IngestSessionHandle;
  stamp: string;
  mark(present: readonly string[]): Promise<void>;
}

async function begin(scope: 'package' | 'source', executor: SqlExecutor = database.executor) {
  const sessions = createIngestSessions(database.executor);
  const handle = await sessions.acquire(
    org,
    scope === 'package'
      ? { scope, sourceId: SOURCE, packageKey: NAME }
      : { scope, sourceId: SOURCE },
    OWNER,
    60,
  );
  if (handle === 'held') throw new Error('session held');
  const reconciler = createCatalogueReconciler(executor);
  const guard = createIngestSessionWriteGuard(org, handle);
  const listing =
    scope === 'package'
      ? ({ kind: 'package', packageId: PACKAGE } as const)
      : ({ kind: 'source', sourceId: SOURCE } as const);
  const { stamp } = await reconciler.openListing(org, guard, listing);
  await sessions.start(org, handle, { snapshot: { id: 'snap' }, stamp });
  const begun: Begun = {
    session: handle,
    stamp,
    mark: async (present) => {
      await reconciler.markListing(org, guard, { scope: listing, stamp, present });
    },
  };
  return begun;
}

const input = (expectedCount: number, extra: Partial<IngestFinalizeInput> = {}) => ({
  expectedCount,
  attemptedCandidates: expectedCount,
  successfulCandidates: expectedCount,
  definitiveAbsent: 0,
  upstreamComplete: true,
  validatorTtlSeconds: TTL,
  ...extra,
});

async function setValidators(session: IngestSessionHandle): Promise<void> {
  await createIngestSessions(database.executor).setPendingValidators(org, session, VALIDATORS);
}

const versionStatuses = () =>
  all<{ id: string; status: string }>('SELECT id, status FROM version ORDER BY id');
const refetchable = () =>
  all<{ id: string; refetchable: number }>('SELECT id, refetchable FROM blob ORDER BY id');
const upstreamRows = () => all<{ form: string }>('SELECT form FROM upstream_state');
const sessionState = async () =>
  (await all<{ state: string }>('SELECT state FROM ingest_session'))[0]?.state;

async function expectUntouched(): Promise<void> {
  expect((await versionStatuses()).every((v) => v.status === 'active')).toBe(true);
  expect((await refetchable()).every((b) => b.refetchable === 1)).toBe(true);
  expect(await upstreamRows()).toEqual([]);
  expect(await sessionState()).toBe('running');
}

function expiring(executor: SqlExecutor, sessionId: string): SqlExecutor {
  return {
    ...executor,
    all: executor.all.bind(executor),
    batch: async (statements) => {
      await executor.batch([
        stmt('UPDATE ingest_session SET lease_until = ? WHERE id = ?', PAST, sessionId),
      ]);
      return executor.batch(statements);
    },
  };
}

describe('ingest session finalize', () => {
  it('1: upstreamComplete false or a mismatching count cannot finalize and changes nothing', async () => {
    await seedVersions('1.0.0', '1.1.0', '2.0.0');
    const { session, mark } = await begin('package');
    await mark(['1.0.0', '1.1.0']);
    await setValidators(session);
    const finalizer = createIngestFinalizer(database.executor);

    expect(await finalizer.finalize(org, session, input(2, { upstreamComplete: false }))).toEqual({
      status: 'refused',
      reason: 'incomplete',
    });
    expect(
      await finalizer.finalize(
        org,
        session,
        input(3, { attemptedCandidates: 2, successfulCandidates: 2 }),
      ),
    ).toEqual({
      status: 'refused',
      reason: 'count_mismatch',
    });
    expect(
      await finalizer.finalize(
        org,
        session,
        input(1, { attemptedCandidates: 2, successfulCandidates: 2 }),
      ),
    ).toEqual({
      status: 'refused',
      reason: 'count_mismatch',
    });
    await expectUntouched();
  });

  it('2: an empty complete listing removes nothing and completes the session', async () => {
    await seedVersions('1.0.0', '1.1.0');
    const { session } = await begin('package');
    await setValidators(session);
    const result = await createIngestFinalizer(database.executor).finalize(org, session, input(0));
    expect(result).toEqual({ status: 'complete', empty: true, validatorsPublished: 1 });
    expect((await versionStatuses()).map((v) => v.status)).toEqual(['active', 'active']);
    expect((await refetchable()).map((b) => b.refetchable)).toEqual([1, 1]);
    expect(await sessionState()).toBe('complete');
    expect(
      await all<{ v: unknown }>('SELECT last_synced_at AS v FROM package WHERE id = ?', PACKAGE),
    ).toEqual([{ v: null }]);
  });

  it('3: removal makes the removed blobs non-refetchable and validators appear only after finalize', async () => {
    await seedVersions('1.0.0', '1.1.0', '2.0.0');
    const { session, mark } = await begin('package');
    await mark(['1.0.0', '1.1.0']);
    await setValidators(session);
    expect(await upstreamRows()).toEqual([]);

    const result = await createIngestFinalizer(database.executor, {
      maxAbsenceShare: 0.5,
    }).finalize(org, session, input(2));
    expect(result).toEqual({ status: 'complete', empty: false, validatorsPublished: 1 });
    expect(await versionStatuses()).toEqual([
      { id: 'V-1.0.0', status: 'active' },
      { id: 'V-1.1.0', status: 'active' },
      { id: 'V-2.0.0', status: 'removed_upstream' },
    ]);
    expect(await refetchable()).toEqual([
      { id: 'B-1.0.0', refetchable: 1 },
      { id: 'B-1.1.0', refetchable: 1 },
      { id: 'B-2.0.0', refetchable: 0 },
    ]);
    expect(
      await all<{ form: string; etag: string }>('SELECT form, etag FROM upstream_state'),
    ).toEqual([{ form: 'composer-p2', etag: '"v1"' }]);
    expect(await sessionState()).toBe('complete');
  });

  it('4: a source listing finalizes the same way across its packages', async () => {
    await seedVersions('1.0.0');
    await run(
      stmt(
        `INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
          VALUES ('P2', ?, ?, 'composer', 'acme/two', ?)`,
        org.orgId,
        SOURCE,
        OLD,
      ),
    );
    const { session, mark } = await begin('source');
    await mark(['acme/two']);
    const result = await createIngestFinalizer(database.executor, {
      maxAbsenceShare: 0.5,
    }).finalize(org, session, input(1));
    expect(result).toMatchObject({ status: 'complete', empty: false });
    expect(await refetchable()).toEqual([{ id: 'B-1.0.0', refetchable: 0 }]);
    expect(await all<{ status: string }>('SELECT status FROM package ORDER BY name')).toEqual([
      { status: 'removed_upstream' },
      { status: 'active' },
    ]);
  });

  it('5: a session that lost its lease before the batch writes nothing, with or without removals', async () => {
    for (const count of [2, 0]) {
      await seedVersions('1.0.0', '1.1.0', '2.0.0');
      const { session, mark } = await begin('package');
      if (count > 0) await mark(['1.0.0', '1.1.0']);
      await setValidators(session);
      const finalizer = createIngestFinalizer(expiring(database.executor, session.id));
      expect(await finalizer.finalize(org, session, input(count))).toEqual({
        status: 'refused',
        reason: 'superseded',
      });
      await expectUntouched();
      await run(
        stmt('DELETE FROM ingest_session'),
        stmt('UPDATE package SET listing_seen_stamp = NULL'),
        stmt('DELETE FROM version'),
        stmt('DELETE FROM blob'),
      );
    }
  });

  it('6: another organization, a replaced fence or a finished session cannot finalize', async () => {
    await seedVersions('1.0.0');
    const { session, mark } = await begin('package');
    await mark(['1.0.0']);
    const finalizer = createIngestFinalizer(database.executor);
    expect(await finalizer.finalize(other, session, input(1))).toEqual({
      status: 'refused',
      reason: 'session_unavailable',
    });
    expect(
      await finalizer.finalize(org, { ...session, fence: session.fence + 1 }, input(1)),
    ).toEqual({ status: 'refused', reason: 'session_unavailable' });
    expect(await finalizer.finalize(org, session, input(1))).toMatchObject({ status: 'complete' });
    expect(await finalizer.finalize(org, session, input(1))).toEqual({
      status: 'refused',
      reason: 'session_unavailable',
    });
  });

  it('publishes exactly the normalised validators stored at write', async () => {
    const { session } = await begin('package');
    const value = { 'composer-p2': { etag: '"normalised"' } };
    await createIngestSessions(database.executor).setPendingValidators(
      org,
      session,
      value as PendingValidators,
    );
    const [stored] = await all<{ pending_validators: string }>(
      'SELECT pending_validators FROM ingest_session WHERE org_id = ? AND id = ?',
      org.orgId,
      session.id,
    );
    const normalised = { etag: '"normalised"', lastModified: null, contentSha256: null };
    expect(stored?.pending_validators).toBe(JSON.stringify({ 'composer-p2': normalised }));
    expect(await createIngestFinalizer(database.executor).finalize(org, session, input(0))).toEqual(
      { status: 'complete', empty: true, validatorsPublished: 1 },
    );
    expect(
      await createUpstreamStateRepository(database.executor).get(org, PACKAGE, 'composer-p2'),
    ).toMatchObject(normalised);
  });

  it('7: an unknown validator form stored by an older build fails before any write', async () => {
    await seedVersions('1.0.0', '2.0.0');
    const { session, mark } = await begin('package');
    await mark(['1.0.0']);
    await run(
      stmt(
        'UPDATE ingest_session SET pending_validators = ? WHERE org_id = ? AND id = ?',
        JSON.stringify({ bogus: { etag: '"x"', lastModified: null, contentSha256: null } }),
        org.orgId,
        session.id,
      ),
    );
    await expect(
      createIngestFinalizer(database.executor).finalize(org, session, input(1)),
    ).rejects.toThrow(RangeError);
    await expectUntouched();
  });

  it.each(['package', 'source'] as const)(
    'empty %s listing with a superseded stamp writes nothing',
    async (scope) => {
      await seedVersions('1.0.0');
      const { session } = await begin(scope);
      if (scope === 'package') await setValidators(session);
      await run(stmt(`UPDATE ${scope} SET listing_open_stamp = ?`, 'newer-stamp'));
      expect(
        await createIngestFinalizer(database.executor).finalize(org, session, input(0)),
      ).toEqual({
        status: 'refused',
        reason: 'superseded',
      });
      await expectUntouched();
    },
  );

  it.each([NaN, -1, 0.5, Infinity, 366 * 86400 + 1])(
    'rejects invalid validator TTL %s before reading, without pending validators',
    async (validatorTtlSeconds) => {
      const { session } = await begin('package');
      let reads = 0;
      const executor: SqlExecutor = {
        ...database.executor,
        all: (statement) => {
          reads += 1;
          return database.executor.all(statement);
        },
        batch: database.executor.batch.bind(database.executor),
      };
      await expect(
        createIngestFinalizer(executor).finalize(org, session, input(0, { validatorTtlSeconds })),
      ).rejects.toThrow(RangeError);
      expect(reads).toBe(0);
      await expectUntouched();
    },
  );

  it('rejects pending validators on a source session', async () => {
    const { session } = await begin('source');
    await setValidators(session);
    await expect(
      createIngestFinalizer(database.executor).finalize(org, session, input(0)),
    ).rejects.toThrow(TypeError);
    await expectUntouched();
  });

  it('preserves flags on deleted, scheduled and live purge-leased blobs', async () => {
    await seedVersions('1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0');
    await run(
      stmt('UPDATE blob SET deleted_at = ? WHERE id = ?', OLD, 'B-2.0.0'),
      stmt('UPDATE blob SET purge_after = ? WHERE id = ?', OLD, 'B-3.0.0'),
      stmt(
        'UPDATE blob SET purge_lease_until = ? WHERE id = ?',
        '2099-01-01T00:00:00.000Z',
        'B-4.0.0',
      ),
      stmt('UPDATE blob SET purge_lease_until = ? WHERE id = ?', PAST, 'B-5.0.0'),
    );
    const { session, mark } = await begin('package');
    await mark(['1.0.0']);
    expect(
      await createIngestFinalizer(database.executor, { maxAbsenceShare: 1 }).finalize(
        org,
        session,
        input(1),
      ),
    ).toMatchObject({ status: 'complete' });
    expect((await refetchable()).map((b) => b.refetchable)).toEqual([1, 1, 1, 1, 0]);
  });

  it('counts only validator rows actually written', async () => {
    const { session } = await begin('package');
    await setValidators(session);
    const executor: SqlExecutor = {
      ...database.executor,
      all: database.executor.all.bind(database.executor),
      batch: (statements) =>
        database.executor.batch(
          statements.map((statement) =>
            statement.sql.startsWith('insert into "upstream_state"')
              ? {
                  ...statement,
                  params: statement.params.map((value) =>
                    value === PACKAGE ? 'missing-package' : value,
                  ),
                }
              : statement,
          ),
        ),
    };
    expect(await createIngestFinalizer(executor).finalize(org, session, input(0))).toEqual({
      status: 'complete',
      empty: true,
      validatorsPublished: 0,
    });
    expect(await upstreamRows()).toEqual([]);
  });

  it('8: a stable 200 with a dev HTML 404 keeps every seeded version through finalization', async () => {
    await seedVersions('1.0.0.0', '1.1.0.0', 'dev-main');
    const body = JSON.stringify({
      minified: 'composer/2.0',
      packages: {
        [NAME]: [
          { name: NAME, version: '1.1.0', time: '2026-01-02T00:00:00+00:00', dist: dist('1.1.0') },
          { version: '1.0.0', time: '2026-01-01T00:00:00+00:00', dist: dist('1.0.0') },
        ],
      },
    });
    const origin = 'https://repo.example.com';
    const routes: Record<
      string,
      { status: number; body: string; headers: Record<string, string> }
    > = {
      [`${origin}/p2/${NAME}.json`]: {
        status: 200,
        body,
        headers: { etag: '"s1"', 'content-type': 'application/json' },
      },
      [`${origin}/p2/${NAME}~dev.json`]: { status: 404, body: '<html>nope</html>', headers: {} },
    };
    const fetch = createPolicyFetch({
      policy: createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
      userAgent: 'pb-test/1',
      fetchImpl: async (request, init) => {
        const url = String(request instanceof Request ? request.url : request);
        const reply = routes[url];
        if (reply === undefined) throw new Error('unexpected request');
        void init;
        return new Response(reply.body, { status: reply.status, headers: reply.headers });
      },
    });
    const result = await describeComposerV2(
      fetch,
      {
        root: {
          mode: 'v2',
          packagesJsonUrl: `${origin}/packages.json`,
          metadataUrl: `${origin}/p2/%package%.json`,
          inlineProviders: false,
          partialPackages: false,
          inlinePackages: false,
          validator: { sha256: 'a'.repeat(64) },
          messages: [],
          mirrors: [],
        },
        allowedOrigins: [],
      },
      NAME,
      {
        path: 'job',
        dev: true,
        probe: { secrets: [], queryParams: [] },
        clock: fixedClock('2026-10-17T10:00:00.000Z'),
      },
    );
    if (result.kind !== 'found') throw new Error(result.kind);
    const present: string[] = [];
    for await (const member of result.description.members) {
      present.push(
        (member as unknown as { input: { versionNormalized: string } }).input.versionNormalized,
      );
    }
    expect(present).toEqual(['1.1.0.0', '1.0.0.0']);
    expect(result.description.upstreamComplete).toBe(false);
    expect(result.description.forms?.map(({ form, status }) => ({ form, status }))).toEqual([
      { form: 'composer-p2', status: 'present' },
    ]);

    const { session, mark } = await begin('package');
    await mark(present);
    await setValidators(session);
    const outcome = await createIngestFinalizer(database.executor).finalize(
      org,
      session,
      input(present.length, { upstreamComplete: result.description.upstreamComplete }),
    );
    expect(outcome).toEqual({ status: 'refused', reason: 'incomplete' });
    expect(await versionStatuses()).toEqual([
      { id: 'V-1.0.0.0', status: 'active' },
      { id: 'V-1.1.0.0', status: 'active' },
      { id: 'V-dev-main', status: 'active' },
    ]);
    expect((await refetchable()).map((b) => b.refetchable)).toEqual([1, 1, 1]);
    await expectUntouched();
  });
});

describe('ingest session finalize with a caller guard', () => {
  const JOB = { id: 'job-finalize', owner: OWNER, fence: 1 };

  async function runningJob(): Promise<void> {
    await run(
      stmt(
        `INSERT INTO job (id, org_id, type, state, lease_owner, lease_until, fence)
          VALUES (?, ?, 'core:package-sync:v1', 'running', ?,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'), 1)`,
        JOB.id,
        org.orgId,
        JOB.owner,
      ),
    );
  }

  function recording(): { executor: SqlExecutor; batches: Statement[][]; reads: number } {
    const seen = { batches: [] as Statement[][], reads: 0 };
    return {
      get batches() {
        return seen.batches;
      },
      get reads() {
        return seen.reads;
      },
      executor: {
        ...database.executor,
        all: (statement) => {
          seen.reads += 1;
          return database.executor.all(statement);
        },
        batch: (statements) => {
          seen.batches.push([...statements]);
          return database.executor.batch(statements);
        },
      },
    };
  }

  const jobChecks = (batch: readonly Statement[]) =>
    batch.filter((s) => s.sql.includes('FROM job') && s.params.includes(JOB.id)).length;

  it.each([2, 0])('runs the caller guard once in the finalize batch (count %i)', async (count) => {
    await seedVersions('1.0.0', '1.1.0');
    await runningJob();
    const { session, mark } = await begin('package');
    if (count > 0) await mark(['1.0.0', '1.1.0']);
    const guard = createIngestSessionWriteGuard(org, session, JOB);
    const recorder = recording();
    const result = await createIngestFinalizer(recorder.executor).finalize(
      org,
      session,
      input(count),
      guard,
    );
    expect(result).toMatchObject({ status: 'complete' });
    expect(recorder.batches).toHaveLength(1);
    expect(jobChecks(recorder.batches[0]!)).toBe(1);
  });

  it('rejects a caller guard registered for another organization before any read', async () => {
    await seedVersions('1.0.0');
    const { session } = await begin('package');
    const foreign = createIngestSessionWriteGuard(other, session);
    const recorder = recording();
    await expect(
      createIngestFinalizer(recorder.executor).finalize(org, session, input(1), foreign),
    ).rejects.toThrow(TypeError);
    expect(recorder.reads).toBe(0);
    expect(recorder.batches).toEqual([]);
    await expectUntouched();
  });
});
