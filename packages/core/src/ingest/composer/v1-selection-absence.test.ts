import { expect, it, vi } from 'vitest';
import { catalogueWriteGuard } from '../../db/catalogue.js';
import type { OrgId } from '../../db/port.js';
import { JobError, type JobContext } from '../../platform/jobs.js';
import type { PolicyFetch } from '../../sources/policy-fetch.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import type { PackageFillPlan } from '../on-demand.js';
import { jobFences } from '../../platform/job-fences.js';
import { createPackageSyncJob, type PackageSyncDeps } from '../package-sync-job.js';
import type { IngestSessionHandle } from '../session.js';
import { describeComposerV1, type V1PackageOptions } from './v1-package.js';

it('retries an unselected Composer v1 name without recording upstream absence', async () => {
  const org = { orgId: 'org' as OrgId };
  const key = 'acme/unselected';
  const fetch = vi.fn<PolicyFetch>(async () => ({
    status: 404,
    headers: new Headers(),
    body: null,
  }));
  const options: V1PackageOptions = {
    source: {
      url: 'https://repo.example.com',
      policy: createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
      allowedOrigins: [],
    },
    root: {
      mode: 'v1-lazy',
      packagesJsonUrl: 'https://repo.example.com/packages.json',
      providersLazyUrl: 'https://repo.example.com/lazy/%package%.json',
      inlineProviders: false,
      inlinePackages: false,
      partialPackages: false,
      validator: { sha256: '0'.repeat(64) },
      messages: [],
      mirrors: [],
    },
    selection: { packages: ['acme/selected'], patterns: [], expandPatterns: false },
    origin: {
      probe: { secrets: [], queryParams: [] },
      importedAt: '2026-10-20T08:00:00.000Z',
    },
    codecs: {
      digestTap: vi.fn(() => {
        throw new Error('unexpected digest');
      }),
    },
  };
  const session: IngestSessionHandle = {
    id: 'session',
    scopeKey: 'scope',
    owner: 'job',
    fence: 1,
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
  const describe = vi.fn<PackageFillPlan['describe']>((_input, signal) =>
    describeComposerV1(fetch, key, { ...options, signal }),
  );
  const plan: PackageFillPlan = {
    source: {
      id: 'source',
      key,
      type: 'composer_repository',
      ecosystem: 'composer',
      covered: false,
    },
    describe,
    toVersion: () => null,
    packageDescription: null,
    validatorTtlSeconds: 300,
    publishedValidators: {},
  };
  const notFoundStatements = vi.fn(() => [
    { sql: 'notfound:pkg:composer-v1-provider', params: [] },
  ]);
  const batch = vi.fn(async () => []);
  const markPackageAbsent = vi.fn(async () => ({ changed: false, statements: 1 }));
  const deps = {
    sessions: {
      acquire: vi.fn(async () => session),
      abandon: vi.fn(async () => true),
      release: vi.fn(async () => true),
    },
    apply: { writer: { markPackageAbsent } },
    executor: { batch },
    upstreamState: { notFoundStatements },
    sourceMetadata: vi.fn(async () => ({
      type: 'composer_repository',
      form: 'composer-v1-provider',
    })),
    findPackageId: vi.fn(async () => 'pkg'),
    planFill: vi.fn(async () => plan),
    writeGuard: vi.fn(() => catalogueWriteGuard([{ sql: 'guard', params: [] }])),
    clock: { now: () => new Date('2026-10-20T10:00:00.000Z') },
  } as unknown as PackageSyncDeps;
  const job = createPackageSyncJob(deps);
  const context = {
    org,
    jobId: 'job',
    signal: new AbortController().signal,
    fences: jobFences({ id: 'job', owner: 'owner', fence: 1 }),
  } as JobContext;

  await expect(
    job.handler(job.validate({ sourceId: 'source', key }), context),
  ).rejects.toMatchObject({
    name: 'JobError',
    code: 'handler_error',
  } satisfies Pick<JobError, 'name' | 'code'>);
  expect(describe).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(notFoundStatements).not.toHaveBeenCalled();
  expect(batch).not.toHaveBeenCalled();
  expect(markPackageAbsent).not.toHaveBeenCalled();
});
