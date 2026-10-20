import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { applyChunk, type ApplyDeps } from '@package-broker/core/ingest/apply-description';
import type { IngestSessionHandle } from '@package-broker/core/ingest/session';
import {
  createPackageDescription,
  snapshotRef,
  type VersionCandidate,
} from '@package-broker/core/sources/provider';
import { createCatalogueWriter } from '@package-broker/db-sqlite/repositories/catalogue-writer';
import { createExistingVersionsReader } from '@package-broker/db-sqlite/repositories/existing-versions';
import { createIngestFinalizer } from '@package-broker/db-sqlite/repositories/ingest-finalize';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '@package-broker/db-sqlite/repositories/ingest-session';
import {
  createD1Executor,
  type D1DatabaseLike,
} from '../packages/runtime-cloudflare/src/db/d1-executor.js';

const SOURCE = '01J0SRC0000000000000000S01';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0A01';
const KEY = 'acme/big';
const upstream = Array.from({ length: 200 }, (_, n) => `2.${Math.floor(n / 100)}.${n % 100}`);

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

function toVersion(candidate: VersionCandidate) {
  const parsed = JSON.parse(candidate.raw) as { version: string };
  return {
    version: parsed.version,
    versionNormalized: `${parsed.version}.0`,
    license: null,
    distType: 'zip' as const,
    sourceRef: null,
    upstreamReleasedAt: null,
    metadata: normalizeVersionMetadata('composer', parsed),
    history: { basis: 'release_date' as const, at: '2026-10-01T00:00:00.000Z' },
  };
}

export default {
  async fetch(request: Request, env: { APPLY: D1DatabaseLike }) {
    const { org, session: resumed } = (await request.json()) as {
      org: import('@package-broker/core/db/port').OrgContext;
      session?: IngestSessionHandle;
    };
    const executor = createD1Executor(env.APPLY);
    const counter = counting(executor);
    const deps: ApplyDeps = {
      writer: createCatalogueWriter(counter.executor),
      sessions: createIngestSessions(counter.executor),
      existing: createExistingVersionsReader(counter.executor),
      finalizer: createIngestFinalizer(counter.executor, { maxAbsenceShare: 1 }),
    };
    const acquired =
      resumed ??
      (await createIngestSessions(executor).acquire(
        org,
        { scope: 'package', sourceId: SOURCE, packageKey: KEY },
        OWNER,
        600,
      ));
    if (acquired === 'held') throw new Error('session held');
    const session: IngestSessionHandle = acquired;
    const guard = createIngestSessionWriteGuard(org, session, {
      id: 'job-apply',
      owner: OWNER,
      fence: 1,
    });

    if (resumed === undefined) return Response.json({ session, guardLength: guard.length });
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
        snapshot: snapshotRef('"d1-1"'),
        validators: {},
        members: (async function* () {
          for (const [ordinal, version] of upstream.entries()) {
            await Promise.resolve();
            yield {
              ordinal,
              version,
              form: 'composer-p2',
              raw: JSON.stringify({ name: KEY, version }),
            } satisfies VersionCandidate;
          }
        })(),
        documentsComplete: true,
      }),
      packageDescription: null,
      toVersion,
      validatorTtlSeconds: 300,
    });
    return Response.json({ outcome, statements: counter.take(), guardLength: guard.length });
  },
};
