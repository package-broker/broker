import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { catalogueCacheKey } from '@package-broker/core/catalogue/cache-keys';
import type { ResolvedPackage, VersionInput } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  applyChunk,
  type ApplyDeps,
  type ApplyOutcome,
} from '@package-broker/core/ingest/apply-description';
import { extractMembers } from '@package-broker/core/ingest/json-stream';
import { openStagedSnapshot } from '@package-broker/core/ingest/snapshot';
import { parseSha256, type BlobStore } from '@package-broker/core/platform/blob';
import type { Codecs, DigestAlgorithm } from '@package-broker/core/platform/codec';
import { INVOCATION_BUDGET } from '@package-broker/core/ingest/plan-chunk';
import type { IngestSessionHandle } from '@package-broker/core/ingest/session';
import type { JobGuard } from '@package-broker/core/platform/job-repository';
import {
  createPackageDescription,
  snapshotRef,
  type VersionCandidate,
} from '@package-broker/core/sources/provider';
import { registerCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriter } from './catalogue-writer.js';
import { createExistingVersionsReader } from './existing-versions.js';
import { createIngestFinalizer } from './ingest-finalize.js';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
  ingestSessionGuard,
  type IngestSessions,
} from './ingest-session.js';

const SOURCE = '01J0SRC0000000000000000S01';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0A01';
const KEY = 'acme/big';
const SNAPSHOT = '"big-1"';
const VERSIONS = 1200;

let database: MigratedDatabase;
let org: OrgContext;

function counting(executor: SqlExecutor): { executor: SqlExecutor; take(): number } {
  let count = 0;
  return {
    executor: {
      driver: executor.driver,
      all<R>(statement: Statement) {
        count += 1;
        return executor.all<R>(statement);
      },
      batch(statements) {
        expect(statements.length).toBeLessThanOrEqual(200);
        count += statements.length;
        return executor.batch(statements);
      },
    },
    take() {
      const taken = count;
      count = 0;
      return taken;
    },
  };
}

function toVersion(candidate: VersionCandidate): VersionInput {
  const parsed = JSON.parse(candidate.raw) as { version: string };
  return {
    version: parsed.version,
    versionNormalized: `${parsed.version}.0`,
    license: null,
    distType: 'zip',
    sourceRef: null,
    upstreamReleasedAt: null,
    metadata: normalizeVersionMetadata('composer', parsed),
    history: { basis: 'release_date', at: '2026-10-01T00:00:00.000Z' },
  };
}

const upstream = Array.from({ length: VERSIONS }, (_, n) => `1.${Math.floor(n / 100)}.${n % 100}`);

function describeUpstream(snapshot = SNAPSHOT) {
  return createPackageDescription({
    name: KEY,
    snapshot: snapshotRef(snapshot),
    validators: {},
    members: (async function* () {
      for (const [ordinal, version] of upstream.entries()) {
        await Promise.resolve();
        yield {
          ordinal,
          version,
          form: 'composer-p2',
          raw: JSON.stringify({ name: KEY, version, description: `release ${version}` }),
        } satisfies VersionCandidate;
      }
    })(),
    documentsComplete: true,
  });
}

const codecs: Pick<Codecs, 'digestTap'> = {
  digestTap<A extends DigestAlgorithm>(algorithms: readonly A[]) {
    const hashes = algorithms.map((algorithm) => [algorithm, createHash(algorithm)] as const);
    let resolve!: (value: Record<A, Uint8Array>) => void;
    let reject!: (reason: unknown) => void;
    const digests = new Promise<Record<A, Uint8Array>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    digests.catch(() => undefined);
    return {
      digests,
      transform: new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          for (const [, hash] of hashes) hash.update(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          resolve(
            Object.fromEntries(
              hashes.map(([algorithm, hash]) => [algorithm, new Uint8Array(hash.digest())]),
            ) as Record<A, Uint8Array>,
          );
        },
        cancel(reason) {
          reject(reason);
        },
      }),
    };
  },
};

function describeStaged(valid: boolean) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      versions: Object.fromEntries(
        upstream
          .slice(0, 1002)
          .map((version) => [version, { name: KEY, version, description: 'changed' }]),
      ),
    }),
  );
  const digest = parseSha256(
    valid ? createHash('sha256').update(bytes).digest('hex') : '0'.repeat(64),
  );
  const store: BlobStore = {
    put: () => Promise.reject(new Error('unused')),
    head: () => Promise.reject(new Error('unused')),
    get: async () => {
      let offset = 0;
      return {
        info: {
          generation: '',
          sha256: digest,
          size: bytes.length,
          mediaType: 'application/json',
          purgeAfter: null,
        },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === bytes.length) controller.close();
            else {
              controller.enqueue(bytes.subarray(offset, offset + 1024));
              offset = Math.min(offset + 1024, bytes.length);
            }
          },
        }),
      };
    },
  };
  const snapshot = snapshotRef(SNAPSHOT, digest);
  return createPackageDescription({
    name: KEY,
    snapshot,
    validators: {},
    documentsComplete: true,
    members: (async function* () {
      const opened = await openStagedSnapshot(org, store, snapshot, { codecs });
      if (opened.kind !== 'open') throw new Error('snapshot missing');
      let ordinal = 0;
      for await (const member of extractMembers(opened.body, [['versions', '*']])) {
        yield {
          ordinal: ordinal++,
          version: member.path[1]!,
          form: 'composer-p2',
          raw: member.raw,
        } satisfies VersionCandidate;
      }
    })(),
  });
}

interface SyncOptions {
  readonly snapshots?: (invocation: number) => string;
  readonly staged?: boolean;
  readonly after?: (invocation: number, outcome: ApplyOutcome) => Promise<void>;
  /** Runs the apply under this job's lease, as a package-sync job does. */
  readonly job?: JobGuard;
  readonly sessions?: (sessions: IngestSessions) => IngestSessions;
}

async function syncToCompletion(
  executor: SqlExecutor,
  options: SyncOptions = {},
): Promise<{ counts: number[]; last: ApplyOutcome }> {
  const counter = counting(executor);
  const deps: ApplyDeps = {
    writer: createCatalogueWriter(counter.executor),
    sessions: (options.sessions ?? ((s) => s))(createIngestSessions(counter.executor)),
    existing: createExistingVersionsReader(counter.executor),
    finalizer: createIngestFinalizer(counter.executor),
  };
  const acquired = await createIngestSessions(executor).acquire(
    org,
    { scope: 'package', sourceId: SOURCE, packageKey: KEY },
    OWNER,
    600,
  );
  if (acquired === 'held') throw new Error('session held');
  let session: IngestSessionHandle = acquired;
  const guard =
    options.job === undefined
      ? registerCatalogueWriteGuard(org, [
          ...ingestSessionGuard(org, session),
          ...ingestSessionGuard(org, session),
        ])
      : createIngestSessionWriteGuard(org, session, options.job);
  const counts: number[] = [];
  for (let invocation = 0; invocation < 100; invocation++) {
    counter.take();
    const outcome = await applyChunk(org, deps, {
      session,
      guard,
      source: {
        id: SOURCE,
        key: KEY,
        type: 'composer_repository',
        ecosystem: 'composer',
        covered: true,
      },
      description: options.staged
        ? describeStaged(true)
        : describeUpstream(options.snapshots?.(invocation)),
      packageDescription: 'big package',
      toVersion,
      validatorTtlSeconds: 300,
    });
    counts.push(counter.take());
    await options.after?.(invocation, outcome);
    if (outcome.done) return { counts, last: outcome };
    expect(outcome.status).toBe('progress');
    session = outcome.session;
  }
  throw new Error('apply did not finish');
}

const activeRows = (executor: SqlExecutor) =>
  executor.all<Record<string, unknown>>({
    sql: `SELECT version, version_normalized, status, metadata_json FROM version
      WHERE status = 'active' ORDER BY version_normalized`,
    params: [],
  });

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  org = database.orgs!.a;
  await database.executor.batch([
    {
      sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'composer', 'composer_repository')",
      params: [SOURCE, org.orgId],
    },
  ]);
});

afterEach(async () => {
  await database.close();
});

describe('applyChunk against the SQLite catalogue writer', () => {
  it.each([false, true])(
    'refuses a corrupt 1,002-member staged snapshot before any catalogue writes (complete package: %s)',
    async (complete) => {
      if (complete) await syncToCompletion(database.executor);
      const catalogue = async () => ({
        packages: await database.executor.all({
          sql: 'SELECT * FROM package WHERE org_id = ?',
          params: [org.orgId],
        }),
        versions: await database.executor.all({
          sql: 'SELECT * FROM version WHERE org_id = ? ORDER BY id',
          params: [org.orgId],
        }),
      });
      const before = await catalogue();
      const sessions = createIngestSessions(database.executor);
      const session = await sessions.acquire(
        org,
        { scope: 'package', sourceId: SOURCE, packageKey: KEY },
        OWNER,
        600,
      );
      if (session === 'held') throw new Error('session held');
      const counter = counting(database.executor);
      const outcome = await applyChunk(
        org,
        {
          writer: createCatalogueWriter(counter.executor),
          sessions: createIngestSessions(counter.executor),
          existing: createExistingVersionsReader(counter.executor),
          finalizer: createIngestFinalizer(counter.executor),
        },
        {
          session,
          guard: createIngestSessionWriteGuard(org, session),
          source: {
            id: SOURCE,
            key: KEY,
            type: 'composer_repository',
            ecosystem: 'composer',
            covered: true,
          },
          description: describeStaged(false),
          packageDescription: 'changed package',
          toVersion,
          validatorTtlSeconds: 300,
        },
      );
      expect(outcome).toMatchObject({
        done: true,
        status: 'refused',
        refusal: 'snapshot_corrupt',
        planned: 1,
      });
      expect(counter.take()).toBe(1);
      expect(await catalogue()).toEqual(before);
      expect(
        await database.executor.all({
          sql: 'SELECT state, seen_count, pages_so_far, cursor, stamp FROM ingest_session WHERE org_id = ? AND id = ?',
          params: [org.orgId, session.id],
        }),
      ).toEqual([
        { state: 'abandoned', seen_count: 0, pages_so_far: 0, cursor: null, stamp: null },
      ]);
    },
    120_000,
  );

  it('applies 1,200 versions over several invocations of at most 450 statements', async () => {
    const { counts, last } = await syncToCompletion(database.executor);

    expect(last.status).toBe('complete');
    expect(counts.length).toBeGreaterThan(1);
    expect(Math.max(...counts)).toBeLessThanOrEqual(INVOCATION_BUDGET);

    const reference = await openMigratedDatabase({ twoOrganizations: true });
    try {
      const ref = reference.orgs!.a;
      await reference.executor.batch([
        {
          sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'composer', 'composer_repository')",
          params: [SOURCE, ref.orgId],
        },
      ]);
      const writer = createCatalogueWriter(reference.executor);
      const guard = registerCatalogueWriteGuard(ref, [{ sql: 'SELECT 1', params: [] }]);
      const inputs = upstream.map((version, ordinal) =>
        toVersion({
          ordinal,
          version,
          form: 'composer-p2',
          raw: JSON.stringify({ name: KEY, version, description: `release ${version}` }),
        }),
      );
      for (let offset = 0; offset < inputs.length; offset += 50) {
        await writer.syncPackage(ref, guard, {
          sourceId: SOURCE,
          ecosystem: 'composer',
          key: KEY,
          description: 'big package',
          versions: inputs.slice(offset, offset + 50),
        });
      }
      const expected = await activeRows(reference.executor);
      expect(expected).toHaveLength(VERSIONS);
      expect(await activeRows(database.executor)).toEqual(expected);
    } finally {
      await reference.close();
    }

    const [session] = await database.executor.all<{ state: string; seen_count: number }>({
      sql: 'SELECT state, seen_count FROM ingest_session',
      params: [],
    });
    expect(session).toEqual({ state: 'complete', seen_count: VERSIONS });
  }, 120_000);

  it('applies a valid staged snapshot across bounded invocations', async () => {
    const { counts, last } = await syncToCompletion(database.executor, { staged: true });
    expect(last.status).toBe('complete');
    expect(counts.length).toBeGreaterThan(1);
    expect(Math.max(...counts)).toBeLessThanOrEqual(INVOCATION_BUDGET);
    expect(await activeRows(database.executor)).toHaveLength(1002);
  }, 120_000);

  it('removes a version upstream no longer lists only through the finalize', async () => {
    await database.executor.batch([
      {
        sql: `INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('pkg-old', ?, ?, 'composer', ?)`,
        params: [org.orgId, SOURCE, KEY],
      },
      {
        sql: `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
            published_at_basis, metadata_json)
          VALUES ('ver-gone', ?, 'pkg-old', '0.9.0', '0.9.0.0', '2020-01-01T00:00:00.000Z', 'release_date', '{}')`,
        params: [org.orgId],
      },
    ]);
    const status = () =>
      database.executor.all<{ status: string }>({
        sql: "SELECT status FROM version WHERE id = 'ver-gone'",
        params: [],
      });
    let checked = false;
    const { last } = await syncToCompletion(database.executor, {
      after: async (invocation, outcome) => {
        if (invocation !== 0) return;
        expect(outcome.status).toBe('progress');
        expect(await status()).toEqual([{ status: 'active' }]);
        checked = true;
      },
    });
    expect(checked).toBe(true);
    expect(last.status).toBe('complete');
    const [gone] = await database.executor.all<{ status: string }>({
      sql: "SELECT status FROM version WHERE id = 'ver-gone'",
      params: [],
    });
    expect(gone).toEqual({ status: 'removed_upstream' });
  }, 120_000);

  it('refreshes an unchanged package with reads and marks only', async () => {
    await syncToCompletion(database.executor);
    const before = await database.executor.all<{ updated: string }>({
      sql: 'SELECT max(revision) AS updated FROM version',
      params: [],
    });
    const { counts, last } = await syncToCompletion(database.executor);
    expect(last.status).toBe('complete');
    expect(Math.max(...counts)).toBeLessThanOrEqual(INVOCATION_BUDGET);
    expect(counts.length).toBeLessThanOrEqual(2);
    expect(
      await database.executor.all({
        sql: 'SELECT max(revision) AS updated FROM version',
        params: [],
      }),
    ).toEqual(before);
  }, 120_000);

  it('abandons on a snapshot change between chunks and leaves every status unchanged', async () => {
    await database.executor.batch([
      {
        sql: `INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('pkg-old', ?, ?, 'composer', ?)`,
        params: [org.orgId, SOURCE, KEY],
      },
      {
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
          INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
            published_at_basis, metadata_json)
          SELECT 'old-' || i, ?, 'pkg-old', '0.' || i || '.0', '0.' || i || '.0.0',
            '2020-01-01T00:00:00.000Z', 'release_date', '{}' FROM n`,
        params: [org.orgId],
      },
    ]);
    const statuses = () =>
      database.executor.all({
        sql: 'SELECT id, status FROM version ORDER BY id',
        params: [],
      });
    const { counts, last } = await syncToCompletion(database.executor, {
      snapshots: (invocation) => (invocation === 0 ? SNAPSHOT : '"big-2"'),
    });
    expect(counts).toHaveLength(2);
    expect(last.status).toBe('abandoned');
    const rows = (await statuses()) as { id: string; status: string }[];
    expect(rows.filter((row) => row.status !== 'active')).toEqual([]);
    expect(rows.filter((row) => row.id.startsWith('old-'))).toHaveLength(50);
    expect(
      await database.executor.all({ sql: 'SELECT state FROM ingest_session', params: [] }),
    ).toEqual([{ state: 'abandoned' }]);
  }, 120_000);

  it('refuses the finalize when the job lease expires after the last advance', async () => {
    const job: JobGuard = { id: 'job-apply', owner: OWNER, fence: 1 };
    await database.executor.batch([
      {
        sql: `INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('pkg-old', ?, ?, 'composer', ?)`,
        params: [org.orgId, SOURCE, KEY],
      },
      {
        sql: `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
            published_at_basis, metadata_json)
          VALUES ('ver-gone', ?, 'pkg-old', '0.9.0', '0.9.0.0', '2020-01-01T00:00:00.000Z', 'release_date', '{}')`,
        params: [org.orgId],
      },
      {
        sql: `INSERT INTO job (id, org_id, type, state, lease_owner, lease_until, fence)
          VALUES (?, ?, 'core:package-sync:v1', 'running', ?,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'), 1)`,
        params: [job.id, org.orgId, job.owner],
      },
    ]);
    const { last } = await syncToCompletion(database.executor, {
      job,
      sessions: (sessions) => ({
        ...sessions,
        async advance(ctx, held, input) {
          const progress = await sessions.advance(ctx, held, input);
          if (input.cursor?.includes('"tail":"finalize"') === true) {
            await database.executor.batch([
              {
                sql: `UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
                params: [job.id],
              },
            ]);
          }
          return progress;
        },
      }),
    });
    expect(last.status).toBe('superseded');
    expect(
      await database.executor.all({
        sql: "SELECT status FROM version WHERE id = 'ver-gone'",
        params: [],
      }),
    ).toEqual([{ status: 'active' }]);
    expect(
      await database.executor.all({ sql: 'SELECT state FROM ingest_session', params: [] }),
    ).toEqual([{ state: 'running' }]);
  }, 120_000);

  it('does not extend the session lease on an advance whose job lease expired', async () => {
    const job: JobGuard = { id: 'job-apply', owner: OWNER, fence: 1 };
    await database.executor.batch([
      {
        sql: `INSERT INTO job (id, org_id, type, state, lease_owner, lease_until, fence)
          VALUES (?, ?, 'core:package-sync:v1', 'running', ?,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'), 1)`,
        params: [job.id, org.orgId, job.owner],
      },
    ]);
    const lease = async () =>
      (
        await database.executor.all<{ lease_until: string }>({
          sql: 'SELECT lease_until FROM ingest_session',
          params: [],
        })
      )[0]?.lease_until;
    let before: string | undefined;
    const { last } = await syncToCompletion(database.executor, {
      job,
      sessions: (sessions) => ({
        ...sessions,
        async advance(ctx, held, input, writeGuard) {
          if (input.cursor?.includes('"tail":"finalize"') === true) {
            await database.executor.batch([
              {
                sql: `UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
                params: [job.id],
              },
            ]);
            before = await lease();
          }
          return sessions.advance(ctx, held, input, writeGuard);
        },
      }),
    });
    expect(last.status).toBe('superseded');
    expect(before).toBeDefined();
    expect(await lease()).toBe(before);
    expect(
      await database.executor.all({
        sql: "SELECT state, cursor NOT LIKE '%finalize%' AS old FROM ingest_session",
        params: [],
      }),
    ).toEqual([{ state: 'running', old: 1 }]);
  }, 120_000);

  it('splits writer calls by parameter bytes: ten Composer members of 200 KiB each', async () => {
    const big = 'd'.repeat(200 * 1024);
    const versions = Array.from({ length: 10 }, (_, n) => `3.0.${n}`);
    const counter = counting(database.executor);
    const deps: ApplyDeps = {
      writer: createCatalogueWriter(counter.executor),
      sessions: createIngestSessions(counter.executor),
      existing: createExistingVersionsReader(counter.executor),
      finalizer: createIngestFinalizer(counter.executor),
    };
    const acquired = await createIngestSessions(database.executor).acquire(
      org,
      { scope: 'package', sourceId: SOURCE, packageKey: KEY },
      OWNER,
      600,
    );
    if (acquired === 'held') throw new Error('session held');
    let session: IngestSessionHandle = acquired;
    const guard = createIngestSessionWriteGuard(org, session);
    let status = 'progress';
    for (let invocation = 0; invocation < 20 && status === 'progress'; invocation++) {
      const outcome = await applyChunk(org, deps, {
        session,
        guard,
        source: {
          id: SOURCE,
          key: KEY,
          type: 'composer_repository',
          ecosystem: 'composer',
          covered: true,
        },
        description: createPackageDescription({
          name: KEY,
          snapshot: snapshotRef(SNAPSHOT),
          validators: {},
          members: (async function* () {
            for (const [ordinal, version] of versions.entries()) {
              await Promise.resolve();
              yield {
                ordinal,
                version,
                form: 'composer-p2',
                raw: JSON.stringify({ name: KEY, version, description: big }),
              } satisfies VersionCandidate;
            }
          })(),
          documentsComplete: true,
        }),
        packageDescription: null,
        toVersion,
        validatorTtlSeconds: 300,
      });
      expect(counter.take()).toBeLessThanOrEqual(INVOCATION_BUDGET);
      status = outcome.status;
      session = outcome.session;
    }
    expect(status).toBe('complete');
    expect(await activeRows(database.executor)).toHaveLength(10);
  }, 120_000);
});

async function applyDescription(
  describe: () => ReturnType<typeof createPackageDescription>,
  convert: (candidate: VersionCandidate) => VersionInput,
  source: Parameters<typeof applyChunk>[2]['source'] = {
    id: SOURCE,
    key: KEY,
    type: 'composer_repository',
    ecosystem: 'composer',
    covered: true,
  },
  inspect?: (
    query: Parameters<ApplyDeps['existing']['existingVersions']>[1],
    rows: readonly string[],
  ) => void,
) {
  const counter = counting(database.executor);
  const reader = createExistingVersionsReader(counter.executor);
  const deps: ApplyDeps = {
    writer: createCatalogueWriter(counter.executor),
    sessions: createIngestSessions(counter.executor),
    existing: {
      existingVersions: async (ctx, query) => {
        const result = await reader.existingVersions(ctx, query);
        inspect?.(
          query,
          result.rows.map((r) => r.versionNormalized),
        );
        return result;
      },
    },
    finalizer: createIngestFinalizer(counter.executor),
  };
  const acquired = await deps.sessions.acquire(
    org,
    {
      scope: 'package',
      sourceId: source.id,
      packageKey: source.key,
    },
    OWNER,
    600,
  );
  if (acquired === 'held') throw new Error('session held');
  let session = acquired;
  const guard = createIngestSessionWriteGuard(org, session);
  const counts: number[] = [];
  for (let invocation = 0; invocation < 250; invocation++) {
    counter.take();
    const last = await applyChunk(org, deps, {
      session,
      guard,
      source,
      description: describe(),
      packageDescription: null,
      toVersion: convert,
      validatorTtlSeconds: 300,
    });
    const actual = counter.take();
    expect(actual).toBeLessThanOrEqual(INVOCATION_BUDGET);
    expect(actual).toBeLessThanOrEqual(last.planned);
    expect(last.planned).toBeLessThanOrEqual(INVOCATION_BUDGET);
    counts.push(actual);
    if (last.done) return { counts, last };
    expect(last.status).toBe('progress');
    session = last.session;
  }
  throw new Error('apply did not complete');
}

it('refreshes 100k unchanged versions with candidate-only metadata reads and at most 450 statements per invocation', async () => {
  const total = 100_000;
  await database.executor.batch([
    {
      sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('large', ?, ?, 'composer', ?)",
      params: [org.orgId, SOURCE, KEY],
    },
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json)
      SELECT 'large-' || i, ?, 'large', '1.0.' || i, '1.0.' || i || '.0', '2026-01-01T00:00:00.000Z', 'release_date', '{}' FROM n`,
      params: [total - 1, org.orgId],
    },
  ]);
  const metadata = normalizeVersionMetadata('composer', {});
  const describe = () =>
    createPackageDescription({
      name: KEY,
      snapshot: snapshotRef(SNAPSHOT),
      validators: {},
      documentsComplete: true,
      members: (async function* () {
        for (let ordinal = 0; ordinal < total; ordinal++)
          yield {
            ordinal,
            version: `1.0.${ordinal}`,
            form: 'composer-p2',
            raw: '{}',
          } as const;
      })(),
    });
  let metadataRows = 0;
  let metadataReads = 0;
  let keyReads = 0;
  const { counts, last } = await applyDescription(
    describe,
    (candidate) => ({
      version: candidate.version,
      versionNormalized: `${candidate.version}.0`,
      metadata,
      license: null,
      distType: 'zip',
      sourceRef: null,
      upstreamReleasedAt: null,
      history: { basis: 'release_date', at: '2026-01-01T00:00:00.000Z' },
    }),
    undefined,
    (query, rows) => {
      expect(query.keys).toBeDefined();
      const candidates = new Set(query.keys);
      expect(rows.every((key) => candidates.has(key))).toBe(true);
      if (query.withMetadata) {
        metadataReads++;
        metadataRows += rows.length;
      } else keyReads++;
    },
  );
  expect(last.status).toBe('complete');
  expect(last.session.seenCount).toBe(total);
  expect(counts).toHaveLength(100);
  expect(keyReads).toBe(100);
  expect(metadataReads).toBe(500);
  expect(metadataRows).toBe(total);
  expect(
    await database.executor.all({
      sql: 'SELECT max(revision) AS revision, count(*) AS total FROM version WHERE org_id = ?',
      params: [org.orgId],
    }),
  ).toEqual([{ revision: 1, total }]);
}, 120_000);

it('counts a real tombstoned row as present and completes without changing its status', async () => {
  await database.executor.batch([
    {
      sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('tomb', ?, ?, 'composer', ?)",
      params: [org.orgId, SOURCE, KEY],
    },
    {
      sql: `INSERT INTO version (id, org_id, package_id, version, version_normalized, status, tombstoned_at, published_at, published_at_basis, metadata_json)
      VALUES ('tomb-v', ?, 'tomb', '1.0.0', '1.0.0.0', 'tombstoned', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'release_date', '{}')`,
      params: [org.orgId],
    },
  ]);
  const { last } = await applyDescription(
    () =>
      createPackageDescription({
        name: KEY,
        snapshot: snapshotRef(SNAPSHOT),
        validators: {},
        documentsComplete: true,
        members: (async function* () {
          yield {
            ordinal: 0,
            version: '1.0.0',
            form: 'composer-p2',
            raw: '{"version":"1.0.0"}',
          } as const;
        })(),
      }),
    toVersion,
  );
  expect(last).toMatchObject({ status: 'complete', session: { seenCount: 1 } });
  expect(
    await database.executor.all({
      sql: "SELECT status, revision FROM version WHERE id = 'tomb-v'",
      params: [],
    }),
  ).toEqual([{ status: 'tombstoned', revision: 1 }]);
});

it('adds and removes npm deprecation, bumps package revision and changes metadata cache keys', async () => {
  const source = {
    id: 'npm-source',
    key: 'left-pad',
    type: 'npm_registry' as const,
    ecosystem: 'npm' as const,
    covered: true,
  };
  await database.executor.batch([
    {
      sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'npm', 'npm', 'npm_registry')",
      params: [source.id, org.orgId],
    },
  ]);
  const integrity = `sha512-${'A'.repeat(86)}==`;
  const describe =
    (deprecated: string | null, digest = integrity, tags?: Record<string, string>) =>
    () =>
      createPackageDescription({
        name: source.key,
        snapshot: snapshotRef(SNAPSHOT),
        validators: {},
        documentsComplete: true,
        ...(tags === undefined ? {} : { distTags: tags }),
        members: (async function* () {
          yield {
            ordinal: 0,
            version: '1.0.0',
            form: 'npm-full',
            raw: JSON.stringify({
              name: source.key,
              version: '1.0.0',
              ...(deprecated === null ? {} : { deprecated }),
              dist: {
                integrity: digest,
                shasum: 'a'.repeat(40),
                tarball: 'https://registry.example.test/left-pad/-/left-pad-1.0.0.tgz',
              },
            }),
          } as const;
        })(),
      });
  const convert = (candidate: VersionCandidate): VersionInput => ({
    version: candidate.version,
    versionNormalized: candidate.version,
    metadata: normalizeVersionMetadata('npm', JSON.parse(candidate.raw)),
    license: null,
    distType: 'tgz',
    sourceRef: null,
    upstreamReleasedAt: null,
    history: { basis: 'release_date', at: '2026-01-01T00:00:00.000Z' },
  });
  const read = async () =>
    (
      await database.executor.all<{
        packageId: string;
        rev: number;
        modifiedAt: string;
        createdAt: string;
        deprecated: string | null;
        status: string;
      }>({
        sql: `SELECT p.id AS packageId, p.rev, p.modified_at AS modifiedAt, p.created_at AS createdAt,
      v.deprecated_message AS deprecated, v.status FROM package p JOIN version v ON v.package_id = p.id AND v.org_id = p.org_id
      WHERE p.org_id = ? AND p.source_id = ?`,
        params: [org.orgId, source.id],
      })
    )[0]!;
  const cacheKey = (row: Awaited<ReturnType<typeof read>>) =>
    catalogueCacheKey(
      {
        ...row,
        projectId: 'project',
        sourceId: source.id,
        ecosystem: 'npm',
        key: source.key,
        cacheEpoch: 'epoch',
        listingComplete: true,
      } satisfies ResolvedPackage,
      'npm-full',
    );
  expect((await applyDescription(describe(null), convert, source)).last.status).toBe('complete');
  let before = await read();
  for (const deprecated of ['Use version 2', null]) {
    const cached = new Map([[JSON.stringify(cacheKey(before)), 'previous packument']]);
    expect((await applyDescription(describe(deprecated), convert, source)).last.status).toBe(
      'complete',
    );
    const after = await read();
    expect(after.deprecated).toBe(deprecated);
    expect(after.rev).toBe(before.rev + 1);
    expect(cached.get(JSON.stringify(cacheKey(after)))).toBeUndefined();
    // Repeating the same metadata remains a read-and-mark refresh.
    expect((await applyDescription(describe(deprecated), convert, source)).last.status).toBe(
      'complete',
    );
    expect((await read()).rev).toBe(after.rev);
    before = after;
  }
  const conflicting = `sha512-${'B'.repeat(86)}==`;
  expect(
    (await applyDescription(describe('Should not apply', conflicting), convert, source)).last
      .status,
  ).toBe('complete');
  expect(await read()).toMatchObject({ status: 'quarantined', deprecated: null });
});

it('retains all tag slices and removes obsolete tags across budgeted invocations', async () => {
  const source = {
    id: 'npm-source',
    key: 'left-pad',
    type: 'npm_registry' as const,
    ecosystem: 'npm' as const,
    covered: true,
  };
  await database.executor.batch([
    {
      sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'npm', 'npm', 'npm_registry')",
      params: [source.id, org.orgId],
    },
  ]);
  const version: VersionInput = {
    version: '1.0.0',
    versionNormalized: '1.0.0',
    license: null,
    distType: 'tgz',
    sourceRef: null,
    upstreamReleasedAt: null,
    metadata: normalizeVersionMetadata('npm', {
      name: source.key,
      version: '1.0.0',
      dist: {
        integrity: `sha512-${'A'.repeat(86)}==`,
        tarball: 'https://registry.example.test/left-pad/-/left-pad-1.0.0.tgz',
      },
    }),
    history: { basis: 'release_date', at: '2026-01-01T00:00:00.000Z' },
  };
  const describe = (tags: Record<string, string>) => () =>
    createPackageDescription({
      name: source.key,
      snapshot: snapshotRef(SNAPSHOT),
      validators: {},
      documentsComplete: true,
      distTags: tags,
      members: (async function* () {
        yield {
          ordinal: 0,
          version: '1.0.0',
          form: 'npm-full',
          raw: version.metadata.json,
        } as const;
      })(),
    });
  await applyDescription(describe({ obsolete: '1.0.0' }), () => version, source);
  const tags = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`tag${i}`, '1.0.0']));
  const stored = () =>
    database.executor.all({
      sql: 'SELECT t.tag AS tag, v.version_normalized AS version FROM dist_tag t JOIN version v ON v.id = t.version_id WHERE t.org_id = ? ORDER BY t.tag',
      params: [org.orgId],
    });
  const { counts, last } = await applyDescription(describe(tags), () => version, source);
  expect(last).toMatchObject({ status: 'complete', tagsSkipped: false });
  expect(counts.length).toBeGreaterThan(1);
  expect(await stored()).toEqual(
    Object.keys(tags)
      .sort()
      .map((tag) => ({ tag, version: '1.0.0' })),
  );
  const empty = await applyDescription(describe({}), () => version, source);
  expect(empty.last).toMatchObject({ status: 'complete', tagsSkipped: false });
  expect(await stored()).toEqual([]);
});

it('does not publish a tag slice under a stale session guard', async () => {
  const source = {
    id: 'npm-source',
    key: 'left-pad',
    type: 'npm_registry' as const,
    ecosystem: 'npm' as const,
    covered: true,
  };
  await database.executor.batch([
    {
      sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'npm', 'npm', 'npm_registry')",
      params: [source.id, org.orgId],
    },
  ]);
  const sessions = createIngestSessions(database.executor);
  const acquired = await sessions.acquire(
    org,
    { scope: 'package', sourceId: source.id, packageKey: source.key },
    OWNER,
    600,
  );
  if (acquired === 'held') throw new Error('session held');
  const guard = createIngestSessionWriteGuard(org, acquired);
  expect(await sessions.abandon(org, acquired)).toBe(true);
  const writer = createCatalogueWriter(database.executor);
  const version: VersionInput = {
    version: '1.0.0',
    versionNormalized: '1.0.0',
    license: null,
    distType: 'tgz',
    sourceRef: null,
    upstreamReleasedAt: null,
    metadata: normalizeVersionMetadata('npm', {
      name: source.key,
      version: '1.0.0',
      dist: {
        integrity: `sha512-${'A'.repeat(86)}==`,
        tarball: 'https://registry.example.test/left-pad/-/left-pad-1.0.0.tgz',
      },
    }),
    history: { basis: 'release_date', at: '2026-01-01T00:00:00.000Z' },
  };
  const before = await database.executor.all({ sql: 'SELECT * FROM dist_tag', params: [] });
  await writer
    .syncPackage(org, guard, {
      sourceId: source.id,
      ecosystem: 'npm',
      key: source.key,
      description: null,
      versions: [version],
      tags: { latest: '1.0.0' },
      tagNames: ['latest', 'next'],
    })
    .catch(() => undefined);
  expect(await database.executor.all({ sql: 'SELECT * FROM dist_tag', params: [] })).toEqual(
    before,
  );
  expect(
    await database.executor.all({
      sql: 'SELECT id FROM version WHERE org_id = ?',
      params: [org.orgId],
    }),
  ).toEqual([]);
});
