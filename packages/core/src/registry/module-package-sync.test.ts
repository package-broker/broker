import * as composerRepository from '../ingest/composer/composer-repository.js';
import { jobSourceError } from '../platform/job-source-error.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogueWriteGuard } from '../db/catalogue.js';
import { orgContext, type OrgContext } from '../db/port.js';
import type { SourceRecord } from '../db/source.js';
import type { UpstreamForm, UpstreamState } from '../db/upstream-state.js';
import { fixedClock } from '../ids.js';
import { applyChunk, type ApplyDeps } from '../ingest/apply-description.js';
import type { IngestSessionHandle } from '../ingest/session.js';
import { jobFences } from '../platform/job-fences.js';
import type { JobContext } from '../platform/jobs.js';
import { createPolicyFetch } from '../sources/policy-fetch.js';
import { createRegistryModule, type RegistryModuleDeps } from './module.js';
import { resolveRegistryConfig } from './registry-config.js';

vi.mock('../ingest/apply-description.js', async (original) => ({
  ...(await original<typeof import('../ingest/apply-description.js')>()),
  applyChunk: vi.fn(),
}));

const org = orgContext('org-1');
const lease = { id: 'job-1', owner: 'worker-1', fence: 7 };
const guard = [{ sql: 'guard', params: [] }] as unknown as CatalogueWriteGuard;
const session: IngestSessionHandle = {
  id: 'session-1',
  scopeKey: 'scope',
  owner: lease.owner,
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
const modified = 'Mon, 19 Oct 2026 10:00:00 GMT';
const state = (etag: string | null, lastModified: string | null = modified): UpstreamState => ({
  etag,
  lastModified,
  contentSha256: null,
  checkedAt: '2026-10-19T10:00:00.000Z',
  freshUntil: '2026-10-19T10:05:00.000Z',
  notFoundCount: 0,
  firstNotFoundAt: null,
});

type Reply = { status: number; body?: string };

function harness(ecosystem: 'npm' | 'composer' = 'npm') {
  const key = ecosystem === 'npm' ? 'widget' : 'acme/widget';
  const source: SourceRecord = {
    id: 'src-1',
    projectId: null,
    name: 'upstream',
    ecosystem,
    type: ecosystem === 'npm' ? 'npmjs_proxy' : 'packagist_proxy',
    url: ecosystem === 'npm' ? 'https://registry.npmjs.org' : 'https://repo.packagist.org',
    credentialId: null,
    configJson: '{}',
    userAgent: null,
    status: 'active',
    defaultVisibleToNewProjects: true,
    removalPolicy: 'flag',
    retentionDaysOverride: null,
    pollIntervalSeconds: 300,
    nextPollAt: null,
    lastPolledAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    rootHash: null,
    listingHash: null,
    pollEtag: null,
    pollLastModified: null,
    removalRefusal: null,
    removalAccepted: false,
  };
  const stored: Partial<Record<UpstreamForm, UpstreamState>> = {};
  const replies: Record<string, Reply | Reply[]> = {};
  const calls: { url: string; headers: Headers }[] = [];
  const transport = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const route = replies[new URL(url).pathname];
    const reply = Array.isArray(route) ? route.shift() : route;
    if (reply === undefined) throw new Error('unexpected transport call');
    return new Response(reply.body ?? null, { status: reply.status, headers: { etag: '"new"' } });
  });
  const upstreamState = {
    get: vi.fn(async (_ctx: OrgContext, _id: string, form: UpstreamForm) => stored[form] ?? null),
    touchStatements: vi.fn((_ctx: OrgContext, _id: string, form: UpstreamForm) => [
      { sql: `touch:${form}`, params: [] },
    ]),
    notFoundStatements: vi.fn(() => [{ sql: 'not-found', params: [] }]),
    resetNotFoundStatements: vi.fn(() => [{ sql: 'reset-not-found', params: [] }]),
  };
  const sessions = {
    acquire: vi.fn(async () => session),
    start: vi.fn(async () => true),
    advance: vi.fn(async () => null),
    setPendingValidators: vi.fn(async () => true),
    latest: vi.fn(async () => null),
    abandon: vi.fn(async () => true),
    release: vi.fn(async () => true),
    discard: vi.fn(async () => true),
  };
  const jobs = { enqueue: vi.fn(), get: vi.fn() };
  const markPackageAbsent = vi.fn();
  const packageId = vi.fn(async (): Promise<string | null> => 'pkg-1');
  const batch = vi.fn(async () => []);
  const writeGuard = vi.fn(() => guard);
  const sourceGet = vi.fn(async (_ctx: OrgContext, id: string): Promise<SourceRecord | null> =>
    id === source.id ? source : null,
  );
  const policy = { allowPrivateHosts: [], runtime: 'node' as const, selfOrigins: [] };
  const deps: RegistryModuleDeps = {
    runtime: 'node',
    ports: {
      blob: {},
      cache: {},
      observability: { log: vi.fn() },
      jobs,
    } as unknown as RegistryModuleDeps['ports'],
    clock: fixedClock('2026-10-20T10:00:00.000Z'),
    codecs: {} as RegistryModuleDeps['codecs'],
    publicUrl: 'https://broker.test',
    registry: resolveRegistryConfig(
      { timers: { metadataTtlSeconds: 900 } },
      'node',
      'https://broker.test',
    ),
    outboundPolicy: policy,
    policyFetch: (userAgent) => createPolicyFetch({ policy, userAgent, fetchImpl: transport }),
    deploymentId: 'dep-1',
    catalogue: {
      reader: {} as RegistryModuleDeps['catalogue']['reader'],
      scopedAdmission: { admitScoped: vi.fn() },
      epoch: { read: vi.fn() },
      representationClock: {} as RegistryModuleDeps['catalogue']['representationClock'],
      upstreamState,
      sources: { get: sourceGet },
      covers: vi.fn(async () => false),
      versionById: vi.fn(async () => null),
    },
    ingest: {
      sessions,
      apply: { sessions, writer: { markPackageAbsent }, finalizer: {} } as unknown as ApplyDeps,
      writeGuard: () => guard,
      credential: vi.fn(async () => null),
    },
    sync: { packageId, upstreamState, executor: { batch }, writeGuard },
    dist: {} as RegistryModuleDeps['dist'],
  };
  const context = {
    org,
    jobId: lease.id,
    signal: new AbortController().signal,
    fences: jobFences(lease),
  } as JobContext;
  const run = async (sourceId = source.id) => {
    const job = createRegistryModule(deps).packageSyncJob;
    expect(job).toBeDefined();
    await job!.handler(job!.validate({ sourceId, key }), context);
  };
  return {
    deps,
    stored,
    replies,
    calls,
    transport,
    upstreamState,
    sessions,
    packageId,
    batch,
    writeGuard,
    markPackageAbsent,
    sourceGet,
    context,
    key,
    run,
  };
}

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.mocked(applyChunk).mockReset().mockResolvedValue({
    status: 'complete',
    done: true,
    session,
    cursor: null,
    skipped: [],
    refused: [],
    duplicates: [],
    tagsSkipped: false,
    skippedTags: [],
    planned: 0,
  });
});

describe('registry package-sync job', () => {
  it('exposes a frozen module with the bound definition only when sync and jobs are present', () => {
    const h = harness();
    const module = createRegistryModule(h.deps);
    expect(Object.isFrozen(module)).toBe(true);
    expect(module.packageSyncJob).toMatchObject({ name: 'package-sync', version: 1 });
    const withoutSync = { ...h.deps };
    delete withoutSync.sync;
    expect(createRegistryModule(withoutSync).packageSyncJob).toBeUndefined();
    const withoutJobs = { ...h.deps.ports };
    delete withoutJobs.jobs;
    expect(createRegistryModule({ ...h.deps, ports: withoutJobs }).packageSyncJob).toBeUndefined();
  });

  it('sends stored npm validators and only touches state on 304 using the configured TTL', async () => {
    const h = harness();
    h.stored['npm-packument'] = state('"npm-old"');
    h.replies['/widget'] = { status: 304 };
    await h.run();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.headers.get('if-none-match')).toBe('"npm-old"');
    expect(h.calls[0]!.headers.get('if-modified-since')).toBe(modified);
    expect(h.packageId).toHaveBeenCalledWith(h.context.org, 'src-1', h.key);
    expect(h.upstreamState.get).toHaveBeenCalledExactlyOnceWith(
      h.context.org,
      'pkg-1',
      'npm-packument',
    );
    expect(h.upstreamState.touchStatements).toHaveBeenCalledExactlyOnceWith(
      org,
      'pkg-1',
      'npm-packument',
      900,
    );
    expect(h.batch).toHaveBeenCalledExactlyOnceWith([
      ...guard,
      { sql: 'touch:npm-packument', params: [] },
    ]);
    expect(h.writeGuard).toHaveBeenCalledWith(org, session, lease);
    expect(applyChunk).not.toHaveBeenCalled();
    expect(h.markPackageAbsent).not.toHaveBeenCalled();
    expect(h.upstreamState.notFoundStatements).not.toHaveBeenCalled();
    expect(h.upstreamState.resetNotFoundStatements).not.toHaveBeenCalled();
  });

  it('sends each Composer form its own validators and touches both on 304', async () => {
    const h = harness('composer');
    h.stored['composer-p2'] = state('"stable"');
    h.stored['composer-p2-dev'] = state('"dev"', 'Tue, 20 Oct 2026 09:00:00 GMT');
    h.replies['/p2/acme/widget.json'] = { status: 304 };
    h.replies['/p2/acme/widget~dev.json'] = { status: 304 };
    await h.run();
    expect(h.calls).toHaveLength(2);
    for (const [path, etag, lastModified] of [
      ['/p2/acme/widget.json', '"stable"', modified],
      ['/p2/acme/widget~dev.json', '"dev"', 'Tue, 20 Oct 2026 09:00:00 GMT'],
    ]) {
      const headers = h.calls.find((call) => new URL(call.url).pathname === path)!.headers;
      expect(headers.get('if-none-match')).toBe(etag);
      expect(headers.get('if-modified-since')).toBe(lastModified);
    }
    expect(h.upstreamState.get.mock.calls).toEqual([
      [org, 'pkg-1', 'composer-p2'],
      [org, 'pkg-1', 'composer-p2-dev'],
    ]);
    expect(h.upstreamState.touchStatements.mock.calls).toEqual([
      [org, 'pkg-1', 'composer-p2', 900],
      [org, 'pkg-1', 'composer-p2-dev', 900],
    ]);
    expect(h.batch).toHaveBeenCalledExactlyOnceWith([
      ...guard,
      { sql: 'touch:composer-p2', params: [] },
      { sql: 'touch:composer-p2-dev', params: [] },
    ]);
    expect(applyChunk).not.toHaveBeenCalled();
    expect(h.markPackageAbsent).not.toHaveBeenCalled();
    expect(h.upstreamState.notFoundStatements).not.toHaveBeenCalled();
    expect(h.upstreamState.resetNotFoundStatements).not.toHaveBeenCalled();
  });

  it('applies Composer metadata when p2 is 304 and dev is 200', async () => {
    const h = harness('composer');
    h.stored['composer-p2'] = state('"stable"');
    h.stored['composer-p2-dev'] = state('"dev"');
    h.replies['/p2/acme/widget.json'] = [
      { status: 304 },
      {
        status: 200,
        body: JSON.stringify({
          packages: {
            'acme/widget': [
              {
                name: 'acme/widget',
                version: '1.0.0',
                dist: { type: 'zip', url: 'https://example.com/stable.zip' },
              },
            ],
          },
        }),
      },
    ];
    h.replies['/p2/acme/widget~dev.json'] = {
      status: 200,
      body: JSON.stringify({
        packages: {
          'acme/widget': [
            {
              name: 'acme/widget',
              version: 'dev-main',
              dist: { type: 'zip', url: 'https://example.com/dev.zip' },
            },
          ],
        },
      }),
    };
    await h.run();
    expect(h.calls).toHaveLength(3);
    const stableCalls = h.calls.filter(
      (call) => new URL(call.url).pathname === '/p2/acme/widget.json',
    );
    expect(stableCalls[0]!.headers.get('if-none-match')).toBe('"stable"');
    expect(stableCalls[1]!.headers.get('if-none-match')).toBeNull();
    expect(h.upstreamState.touchStatements).not.toHaveBeenCalled();
    expect(applyChunk).toHaveBeenCalledExactlyOnceWith(
      org,
      expect.anything(),
      expect.objectContaining({
        source: expect.objectContaining({ id: 'src-1', ecosystem: 'composer' }),
        validatorTtlSeconds: 900,
        guard,
      }),
    );
    const description = vi.mocked(applyChunk).mock.calls[0]![2].description;
    const versions = [];
    for await (const candidate of description.members) versions.push(candidate.version);
    expect(versions).toEqual(['1.0.0', 'dev-main']);
  });

  it.each(['missing state', 'missing package', 'unsafe validators', 'null validators'] as const)(
    'sends no conditional headers with %s and applies a 200',
    async (mode) => {
      const h = harness();
      if (mode === 'missing package') h.packageId.mockResolvedValue(null);
      if (mode === 'unsafe validators')
        h.stored['npm-packument'] = state('bad\r\nvalue', 'bad\nvalue');
      if (mode === 'null validators') h.stored['npm-packument'] = state(null, null);
      h.replies['/widget'] = {
        status: 200,
        body: JSON.stringify({
          name: 'widget',
          versions: { '1.0.0': { name: 'widget', version: '1.0.0' } },
        }),
      };
      await h.run();
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]!.headers.get('if-none-match')).toBeNull();
      expect(h.calls[0]!.headers.get('if-modified-since')).toBeNull();
      if (mode === 'missing package') expect(h.upstreamState.get).not.toHaveBeenCalled();
      expect(applyChunk).toHaveBeenCalledExactlyOnceWith(
        org,
        expect.anything(),
        expect.objectContaining({
          source: expect.objectContaining({ id: 'src-1', ecosystem: 'npm' }),
          validatorTtlSeconds: 900,
        }),
      );
      expect(h.upstreamState.touchStatements).not.toHaveBeenCalled();
      expect(h.markPackageAbsent).not.toHaveBeenCalled();
    },
  );

  it('does nothing for a source belonging to another org', async () => {
    const h = harness();
    const foreignOrg = orgContext('org-2');
    h.sourceGet.mockImplementation(async (ctx, id) =>
      ctx.orgId === foreignOrg.orgId && id === 'foreign-source'
        ? ({ id, type: 'npmjs_proxy' } as SourceRecord)
        : null,
    );
    await h.run('foreign-source');
    expect(h.sourceGet).toHaveBeenCalledExactlyOnceWith(org, 'foreign-source');
    expect(h.packageId).not.toHaveBeenCalled();
    expect(h.upstreamState.get).not.toHaveBeenCalled();
    expect(h.sessions.acquire).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.batch).not.toHaveBeenCalled();
    expect(applyChunk).not.toHaveBeenCalled();
  });
});

it('stops a queued package refresh outside current npm scopes before acquiring a session', async () => {
  const h = harness();
  const record = await h.sourceGet(org, 'src-1');
  h.sourceGet.mockResolvedValue({
    ...record!,
    type: 'npm_registry',
    url: 'https://registry.test',
    configJson: '{"scopes":["@acme"]}',
  });
  await h.run();
  expect(h.calls).toEqual([]);
  expect(h.sessions.acquire).not.toHaveBeenCalled();
  expect(h.markPackageAbsent).not.toHaveBeenCalled();
});

it('skips queued refreshes after registered names or the package list narrow and resumes when widened', async () => {
  const h = harness('composer');
  const original = await h.sourceGet(org, 'src-1');
  const record = {
    ...original!,
    type: 'composer_repository' as const,
    url: 'https://registry.test',
    configJson: JSON.stringify({ selection: { packages: [h.key] } }),
  };
  h.sourceGet.mockResolvedValue(record);
  const describe = vi.fn(async () => ({ kind: 'not_found' as const, definitive: true }));
  vi.spyOn(composerRepository, 'createComposerRepositoryProvider').mockReturnValue({
    id: 'composer-repository',
    sourceTypes: ['composer_repository'],
    ecosystems: ['composer'],
    describe,
    openDist: async () => {
      throw new Error('unused');
    },
  });
  const run = async () => {
    const job = createRegistryModule(h.deps).packageSyncJob!;
    await job.handler(job.validate({ sourceId: 'src-1', key: h.key }), h.context);
  };
  await run();
  expect(h.sessions.acquire).not.toHaveBeenCalled();
  expect(describe).not.toHaveBeenCalled();
  expect(h.markPackageAbsent).not.toHaveBeenCalled();
  vi.mocked(h.deps.catalogue.covers).mockResolvedValue(true);
  await run();
  expect(describe).toHaveBeenCalledTimes(1);
  expect(h.markPackageAbsent).toHaveBeenCalledTimes(1);
  h.sourceGet.mockResolvedValue({ ...record, configJson: '{"selection":{"packages":[]}}' });
  await run();
  expect(describe).toHaveBeenCalledTimes(1);
  expect(h.markPackageAbsent).toHaveBeenCalledTimes(1);
  h.sourceGet.mockResolvedValue(record);
  await run();
  expect(describe).toHaveBeenCalledTimes(2);
});

it('uses a plugin claiming composer_repository before the built-in default', async () => {
  const h = harness('composer');
  const original = await h.sourceGet(org, 'src-1');
  h.sourceGet.mockResolvedValue({
    ...original!,
    type: 'composer_repository',
    url: 'https://registry.test',
    configJson: JSON.stringify({ selection: { packages: [h.key] } }),
  });
  vi.mocked(h.deps.catalogue.covers).mockResolvedValue(true);
  const describe = vi.fn(async () => ({ kind: 'not_found' as const, definitive: true }));
  Object.assign(h.deps, {
    providers: [
      {
        id: 'custom-composer',
        sourceTypes: ['composer_repository'],
        ecosystems: ['composer'],
        describe,
        openDist: async () => {
          throw new Error('unused');
        },
      },
    ],
  });
  await h.run();
  expect(describe).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({ type: 'composer_repository', providerId: 'custom-composer' }),
    h.key,
    { validators: {} },
  );
  expect(h.transport).not.toHaveBeenCalled();
});

it('passes a stable child error from registry package jobs to settlement', async () => {
  const h = harness();
  h.transport.mockRejectedValue(new Error('private upstream failure'));
  const definition = createRegistryModule(h.deps).packageSyncJob!;
  const error = await definition
    .handler(
      definition.validate({ sourceId: 'src-1', key: h.key, syncGeneration: 'a'.repeat(64) }),
      h.context,
    )
    .catch((error: unknown) => error);
  expect(jobSourceError(error)).toBe('network');
  expect(h.batch).not.toHaveBeenCalledWith([{ sql: 'record-source-error', params: [] }]);
});
