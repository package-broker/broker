import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import type { VersionInput } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import {
  createPackageSyncJob,
  PACKAGE_SYNC_JOB_TYPE,
} from '@package-broker/core/ingest/package-sync-job';
import type { IngestScopeRef } from '@package-broker/core/ingest/session';
import { jobFences } from '@package-broker/core/platform/job-fences';
import type { JobClaim } from '@package-broker/core/platform/job-repository';
import type { JobContext } from '@package-broker/core/platform/jobs';
import {
  createPackageDescription,
  snapshotRef,
  type DescribeResult,
  type VersionCandidate,
} from '@package-broker/core/sources/provider';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriter } from './catalogue-writer.js';
import { createExistingVersionsReader } from './existing-versions.js';
import { createIngestFinalizer } from './ingest-finalize.js';
import { createIngestSessions, createIngestSessionWriteGuard } from './ingest-session.js';
import { createJobRepository } from './job.js';
import { createPackageIdReads } from './package-id.js';
import { createUpstreamStateRepository } from './upstream-state.js';

const SOURCE = '01J0SRC0000000000000000S01';
const KEY = 'acme/big';
const SNAPSHOT = '"big-1"';
const VERSIONS = 700;
const PAST = '2020-01-01T00:00:00.000Z';
const SCOPE: IngestScopeRef = { scope: 'package', sourceId: SOURCE, packageKey: KEY };

const upstream = Array.from({ length: VERSIONS }, (_, n) => `1.${Math.floor(n / 100)}.${n % 100}`);

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

function describeUpstream(onMember?: () => Promise<void>) {
  return createPackageDescription({
    name: KEY,
    snapshot: snapshotRef(SNAPSHOT),
    validators: {},
    members: (async function* () {
      await onMember?.();
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

let database: MigratedDatabase;
let org: OrgContext;
let executor: SqlExecutor;

const run = (sql: string, ...params: (string | number)[]) => executor.batch([{ sql, params }]);
const all = <R>(sql: string, ...params: (string | number)[]) => executor.all<R>({ sql, params });

interface Hooks {
  onDescribe?: () => Promise<void>;
  afterBatch?: (index: number) => Promise<void>;
}

function build(hooks: Hooks, result: () => DescribeResult, guards?: unknown[]) {
  const jobs = createJobRepository(executor);
  const sessions = createIngestSessions(executor);
  let batches = 0;
  const watched: SqlExecutor = {
    driver: executor.driver,
    all: (statement) => executor.all(statement),
    async batch(statements) {
      const results = await executor.batch(statements);
      await hooks.afterBatch?.((batches += 1));
      return results;
    },
  };
  return createPackageSyncJob({
    sessions,
    apply: {
      writer: createCatalogueWriter(watched),
      sessions,
      existing: createExistingVersionsReader(executor),
      finalizer: createIngestFinalizer(executor),
    },
    jobs: {
      enqueue: (ctx, type, payload, input) =>
        jobs.enqueue(ctx, {
          id: ulid(),
          type,
          payloadJson: JSON.stringify(payload),
          idempotencyKey: input.idempotencyKey,
          resourceKey: input.resourceKey ?? null,
          runAt: input.runAt ?? null,
          maxAttempts: 25,
          projectId: null,
          initiatorTokenId: null,
        }),
    },
    upstreamState: createUpstreamStateRepository(executor),
    executor: watched,
    sourceMetadata: async () => ({ type: 'composer_repository' as const }),
    findPackageId: (ctx, sourceId, key) =>
      createPackageIdReads(executor).packageId(ctx, sourceId, key),
    planFill: async () => ({
      source: {
        id: SOURCE,
        key: KEY,
        type: 'composer_repository' as const,
        ecosystem: 'composer' as const,
        covered: true,
      },
      describe: async () => {
        await hooks.onDescribe?.();
        return result();
      },
      toVersion,
      packageDescription: 'big package',
      validatorTtlSeconds: 300,
      publishedValidators: {},
    }),
    writeGuard: (ctx, session, lease) => {
      guards?.push(lease);
      return createIngestSessionWriteGuard(ctx, session, lease);
    },
    clock: { now: () => new Date() },
  });
}

async function enqueueAndClaim(payload: object = { sourceId: SOURCE, key: KEY }) {
  const jobs = createJobRepository(executor);
  const id = ulid();
  await jobs.enqueue(org, {
    id,
    type: PACKAGE_SYNC_JOB_TYPE,
    payloadJson: JSON.stringify(payload),
    idempotencyKey: id,
    resourceKey: null,
    runAt: null,
    maxAttempts: 25,
    projectId: null,
    initiatorTokenId: null,
  });
  return claimNext(id);
}

async function claimNext(id?: string): Promise<JobClaim> {
  const claim = await createJobRepository(executor).claim(org, ulid(), {
    ...(id === undefined ? {} : { id }),
    types: [PACKAGE_SYNC_JOB_TYPE],
    leaseSeconds: 60,
    maxRunning: 5,
  });
  if (claim === null) throw new Error('nothing to claim');
  return claim;
}

function handle(job: ReturnType<typeof build>, claim: JobClaim) {
  const context = {
    org,
    jobId: claim.id,
    idempotencyKey: claim.idempotencyKey,
    attempt: claim.attempt,
    fence: claim.fence,
    signal: new AbortController().signal,
    fences: jobFences(claim),
    observability: { log: () => {}, counter: () => {}, histogram: () => {} },
  } as unknown as JobContext;
  return job.handler(job.validate(JSON.parse(claim.payloadJson)), context);
}

async function reclaim(claim: JobClaim): Promise<JobClaim> {
  const jobs = createJobRepository(executor);
  await run('UPDATE job SET lease_until = ? WHERE id = ?', PAST, claim.id);
  expect(await jobs.reap(org, 10)).toBe(1);
  await run('UPDATE job SET run_at = ? WHERE id = ?', PAST, claim.id);
  const next = await claimNext(claim.id);
  expect(next.fence).toBe(claim.fence + 1);
  expect(next.owner).not.toBe(claim.owner);
  return next;
}

const expireSession = () =>
  run("UPDATE ingest_session SET lease_until = ? WHERE state = 'running'", PAST);

async function reacquireSession() {
  const taken = await createIngestSessions(executor).acquire(org, SCOPE, ulid(), 240);
  expect(taken).not.toBe('held');
}

const OLD_STATE = { checked_at: PAST, fresh_until: PAST };

async function seedPackage() {
  await run(
    "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES ('P', ?, ?, 'composer', ?, ?)",
    org.orgId,
    SOURCE,
    KEY,
    PAST,
  );
  await run(
    "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at) VALUES ('V', ?, 'P', '0.9.0', '0.9.0.0', ?, 'release_date', '{}', ?)",
    org.orgId,
    PAST,
    PAST,
  );
  for (const form of ['composer-p2', 'composer-p2-dev']) {
    await run(
      'INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until) VALUES (?, ?, ?, ?, ?)',
      org.orgId,
      'P',
      form,
      PAST,
      PAST,
    );
  }
}

const upstreamState = () =>
  all<Record<string, unknown>>(
    'SELECT form, checked_at, fresh_until, first_not_found_at FROM upstream_state ORDER BY form',
  );
const packageRows = () => all<Record<string, unknown>>('SELECT id, status, rev FROM package');
const versionCount = async () =>
  (await all<{ n: number }>('SELECT count(*) AS n FROM version'))[0]!.n;
const rev = async () =>
  (await all<{ rev: number }>('SELECT rev FROM package WHERE source_id = ?', SOURCE))[0]?.rev ?? 0;

async function beforeEachBody() {
  database = await openMigratedDatabase({ twoOrganizations: true });
  org = database.orgs!.a;
  executor = database.executor;
  await run(
    "INSERT INTO source (id, org_id, name, ecosystem, type, removal_policy) VALUES (?, ?, 'main', 'composer', 'composer_repository', 'exclude')",
    SOURCE,
    org.orgId,
  );
}

beforeEach(beforeEachBody);

afterEach(async () => {
  await database.close();
});

type Takeover = 'job' | 'session';

const takeovers: Record<Takeover, (claim: JobClaim) => Promise<void>> = {
  job: async (claim) => {
    await reclaim(claim);
  },
  session: async () => {
    await expireSession();
    await reacquireSession();
  },
};

describe.each(['job', 'session'] as const)('a write after the %s fence advanced', (kind) => {
  it('does not touch upstream state and fails lease_lost', async () => {
    await seedPackage();
    const claim = await enqueueAndClaim();
    const job = build({ onDescribe: () => takeovers[kind](claim) }, () => ({
      kind: 'not_modified',
    }));
    await expect(handle(job, claim)).rejects.toMatchObject({ code: 'lease_lost' });
    expect(await upstreamState()).toEqual([
      { form: 'composer-p2', ...OLD_STATE, first_not_found_at: null },
      { form: 'composer-p2-dev', ...OLD_STATE, first_not_found_at: null },
    ]);
  });

  it('applies no chunk and fails lease_lost', async () => {
    const claim = await enqueueAndClaim();
    const job = build({}, () => ({
      kind: 'found',
      description: describeUpstream(() => takeovers[kind](claim)),
    }));
    await expect(handle(job, claim)).rejects.toMatchObject({ code: 'lease_lost' });
    expect(await packageRows()).toEqual([]);
    expect(await versionCount()).toBe(0);
  });

  it('does not mark the package absent and fails lease_lost', async () => {
    await seedPackage();
    const first = await enqueueAndClaim();
    const evidence = build({}, () => ({ kind: 'not_found', definitive: true }));
    await handle(evidence, first);
    await run('UPDATE upstream_state SET first_not_found_at = ?', PAST);
    expect(await packageRows()).toEqual([{ id: 'P', status: 'active', rev: 1 }]);

    const claim = await enqueueAndClaim();
    const job = build(
      {
        afterBatch: (index) => (index === 1 ? takeovers[kind](claim) : Promise.resolve()),
      },
      () => ({ kind: 'not_found', definitive: true }),
    );
    await expect(handle(job, claim)).rejects.toMatchObject({ code: 'lease_lost' });
    expect(await packageRows()).toEqual([{ id: 'P', status: 'active', rev: 1 }]);
  });
});

it('marks the package absent when no fence moved', async () => {
  await seedPackage();
  const first = await enqueueAndClaim();
  await handle(
    build({}, () => ({ kind: 'not_found', definitive: true })),
    first,
  );
  await run('UPDATE upstream_state SET first_not_found_at = ?', PAST);
  const claim = await enqueueAndClaim();
  await handle(
    build({}, () => ({ kind: 'not_found', definitive: true })),
    claim,
  );
  expect(await packageRows()).toMatchObject([{ id: 'P', status: 'removed_upstream' }]);
});

it('hands the claimed lease to every guard of a multi-chunk fill', async () => {
  const guards: unknown[] = [];
  const job = build({}, () => ({ kind: 'found', description: describeUpstream() }), guards);
  const claim = await enqueueAndClaim();
  await handle(job, claim);
  expect(guards.length).toBeGreaterThan(0);
  for (const lease of guards) expect(lease).toEqual({ id: claim.id, owner: claim.owner, fence: 1 });
});

async function openFresh() {
  await database.close();
  await beforeEachBody();
}

type TakeoverPhase = 'describe' | 'apply';

async function fill(takeover?: TakeoverPhase) {
  const jobs = createJobRepository(executor);
  const job = build({}, () => ({ kind: 'found', description: describeUpstream() }));
  const settleRun = async (claim: JobClaim) => {
    await handle(job, claim);
    await jobs.settle(org, claim, { outcome: 'succeeded' });
  };
  const next = () =>
    jobs.claim(org, ulid(), { types: [PACKAGE_SYNC_JOB_TYPE], leaseSeconds: 60, maxRunning: 5 });

  await settleRun(await enqueueAndClaim());
  const afterFirst = await rev();
  if (takeover) {
    const stale = (await next())!;
    const beforeCount = await versionCount();
    const progress = () =>
      all(
        'SELECT cursor, seen_count, pages_so_far FROM ingest_session WHERE org_id = ?',
        org.orgId,
      );
    const beforeProgress = await progress();
    let taken: JobClaim | undefined;
    let stagedCount = 0;
    let stagedRev = afterFirst;
    const take = async () => {
      taken = await reclaim(stale);
      await expireSession();
    };
    const staleJob = build(
      {
        ...(takeover === 'describe'
          ? { onDescribe: take }
          : {
              afterBatch: async () => {
                if (taken !== undefined) return;
                const count = await versionCount();
                if (count <= beforeCount) return;
                stagedCount = count;
                stagedRev = await rev();
                await take();
              },
            }),
      },
      () => ({ kind: 'found', description: describeUpstream() }),
    );
    await expect(handle(staleJob, stale)).rejects.toMatchObject({ code: 'lease_lost' });
    expect(taken).toBeDefined();
    if (takeover === 'apply') {
      expect(stagedCount).toBeGreaterThan(beforeCount);
      expect(stagedCount).toBeLessThan(VERSIONS);
      expect(await versionCount()).toBe(stagedCount);
    } else {
      expect(await versionCount()).toBe(beforeCount);
    }
    expect(await rev()).toBe(stagedRev);
    expect(await progress()).toEqual(beforeProgress);
    await settleRun(taken!);
  }
  let runs = takeover ? 2 : 1;
  for (let guard = 0; guard < 20; guard++) {
    const claim = await next();
    if (claim === null) break;
    await settleRun(claim);
    runs += 1;
  }
  const versions = await all<{ version: string }>(
    "SELECT version FROM version WHERE status = 'active' ORDER BY version_normalized",
  );
  return {
    runs,
    rev: await rev(),
    versions: versions.map((row) => row.version),
    catalogue: {
      packages: await all(
        'SELECT ecosystem, name, description, status, last_synced_at IS NOT NULL AS listing_complete FROM package WHERE org_id = ?',
        org.orgId,
      ),
      versions: await all(
        'SELECT version, version_normalized, metadata_json, status, revision, published_at, published_at_basis FROM version WHERE org_id = ? ORDER BY version_normalized',
        org.orgId,
      ),
    },
    sessions: await all(
      'SELECT state, generation, seen_count FROM ingest_session ORDER BY generation',
    ),
  };
}

describe('takeover of a continuation', () => {
  it('lets the second claim finish one complete generation', async () => {
    const reference = await fill();
    expect(reference.runs).toBeGreaterThan(2);
    await openFresh();
    const taken = await fill('describe');
    expect(taken.versions).toEqual(reference.versions);
    expect([...taken.versions].sort()).toEqual([...upstream].sort());
    expect(taken.rev).toBe(reference.rev);
    expect(taken.runs).toBe(reference.runs);
    expect(taken.sessions).toEqual([{ state: 'complete', generation: 1, seen_count: VERSIONS }]);
  }, 120_000);

  it('rejects a partially written chunk and lets the new owner finish the same catalogue', async () => {
    const reference = await fill();
    await openFresh();
    const taken = await fill('apply');
    expect(taken.catalogue).toEqual(reference.catalogue);
    expect(taken.versions).toEqual(reference.versions);
    expect([...taken.versions].sort()).toEqual([...upstream].sort());
    expect(taken.sessions).toEqual(reference.sessions);
    expect(taken.sessions).toEqual([{ state: 'complete', generation: 1, seen_count: VERSIONS }]);
  }, 120_000);
});
