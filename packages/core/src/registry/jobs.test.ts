import { describe, expect, it, vi } from 'vitest';
import { catalogueWriteGuard } from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import type { SourceRecord } from '../db/source.js';
import { fixedClock } from '../ids.js';
import type { IngestSessionHandle } from '../ingest/session.js';
import type { SourceSyncDeps } from '../ingest/source-sync-job.js';
import type { Codecs } from '../platform/codec.js';
import type { JobContext, Jobs } from '../platform/jobs.js';
import type { Observability } from '../platform/observability.js';
import type { PlatformPorts, PluginPorts, RequestContext } from '../plugin.js';
import { isRegisteredCoreJob } from '../runtime/core-jobs.js';
import { parseCredentialMaterial } from '../sources/credentials.js';
import { snapshotRef, type ProviderContext, type SourceProvider } from '../sources/provider.js';
import { createRegistryJobs, type RegistryJobsDeps } from './jobs.js';

const org = orgContext('org-1');
const stamp = '2026-10-20T00:00:00.000Z';
const session: IngestSessionHandle = {
  id: 'session-1',
  scopeKey: 'source:src',
  owner: 'owner',
  fence: 1,
  leaseSeconds: 300,
  generation: 1,
  stamp: null,
  snapshotId: null,
  snapshotBlobSha256: null,
  cursor: null,
  seenCount: 0,
  pagesSoFar: 0,
  pendingValidators: null,
};

function setup() {
  const source: SourceRecord = {
    id: 'src',
    projectId: null,
    name: 'source',
    url: 'https://repo.test',
    type: 'composer_repository',
    ecosystem: 'composer',
    status: 'active',
    credentialId: null,
    configJson: '{}',
    userAgent: null,
    defaultVisibleToNewProjects: false,
    removalPolicy: 'flag',
    retentionDaysOverride: null,
    pollIntervalSeconds: 3600,
    nextPollAt: stamp,
    lastPolledAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    rootHash: null,
    listingHash: null,
    pollEtag: null,
    pollLastModified: null,
  };
  const jobs = {
    enqueue: vi.fn<Jobs['enqueue']>().mockResolvedValue({ id: 'job', created: true }),
    get: vi.fn<Jobs['get']>(),
  };
  const observability: Observability = {
    log: vi.fn<Observability['log']>(),
    counter: vi.fn<Observability['counter']>(),
    histogram: vi.fn<Observability['histogram']>(),
  };
  const ports: PluginPorts = {
    organizations: { get: vi.fn<PluginPorts['organizations']['get']>().mockResolvedValue(null) },
    clock: fixedClock(stamp),
    ids: { ulid: () => '01JA0000000000000000000000' },
    platform: {
      jobs,
      observability,
      blob: {
        put: vi.fn<PlatformPorts['blob']['put']>(),
        get: vi.fn<PlatformPorts['blob']['get']>(),
        head: vi.fn<PlatformPorts['blob']['head']>(),
      },
      cache: {
        get: vi.fn<PlatformPorts['cache']['get']>(),
        set: vi.fn<PlatformPorts['cache']['set']>(),
        delete: vi.fn<PlatformPorts['cache']['delete']>(),
      },
    },
  };
  const codecs: Codecs = {
    digestTap: vi.fn<Codecs['digestTap']>(),
    inflateConsumed: vi.fn<Codecs['inflateConsumed']>(),
    gunzip: vi.fn<Codecs['gunzip']>(),
    deflateRaw: vi.fn<Codecs['deflateRaw']>(),
  };
  const provider: SourceProvider = {
    id: 'composer',
    sourceTypes: ['composer_repository'],
    ecosystems: ['composer'],
    describe: vi.fn<SourceProvider['describe']>(),
    openDist: vi.fn<SourceProvider['openDist']>(),
    listPackages: vi.fn<NonNullable<SourceProvider['listPackages']>>().mockResolvedValue({
      names: ['acme/held', 'acme/new'],
      next: null,
      last: true,
      snapshot: snapshotRef('"listing"'),
    }),
  };
  const sourceSync: SourceSyncDeps = {
    sources: {
      get: vi.fn<SourceSyncDeps['sources']['get']>().mockResolvedValue(source),
      pollState: vi.fn<SourceSyncDeps['sources']['pollState']>().mockResolvedValue('written'),
    },
    providers: {
      forSource: vi.fn<SourceSyncDeps['providers']['forSource']>().mockReturnValue(provider),
    },
    toProviderSource: vi.fn<SourceSyncDeps['toProviderSource']>().mockReturnValue({
      id: 'src',
      type: 'composer_repository',
      ecosystem: 'composer',
      providerId: 'composer',
      url: 'https://repo.test',
      config: {
        distHosts: [],
        mirrorsFallback: false,
        selection: { packages: [], patterns: [], expandPatterns: false },
      },
    }),
    loadCredential: vi.fn<SourceSyncDeps['loadCredential']>().mockResolvedValue(null),
    providerContext: vi.fn<SourceSyncDeps['providerContext']>((job, credential) => ({
      org: job.org,
      signal: job.signal,
      credential,
      clock: ports.clock,
      observability,
      codecs,
      fetch: vi.fn<ProviderContext['fetch']>(),
    })),
    sessions: {
      acquire: vi.fn<SourceSyncDeps['sessions']['acquire']>().mockResolvedValue(session),
      start: vi.fn<SourceSyncDeps['sessions']['start']>().mockResolvedValue(true),
      advance: vi
        .fn<SourceSyncDeps['sessions']['advance']>()
        .mockResolvedValue({ seenCount: 1, pagesSoFar: 1 }),
      abandon: vi.fn<SourceSyncDeps['sessions']['abandon']>().mockResolvedValue(true),
      release: vi.fn<SourceSyncDeps['sessions']['release']>().mockResolvedValue(true),
    },
    writer: {
      openListing: vi.fn<SourceSyncDeps['writer']['openListing']>().mockResolvedValue({ stamp }),
      markListing: vi
        .fn<SourceSyncDeps['writer']['markListing']>()
        .mockResolvedValue({ changed: true, marked: 1, statements: 1 }),
    },
    finalizer: {
      finalize: vi.fn<SourceSyncDeps['finalizer']['finalize']>().mockResolvedValue({
        status: 'complete',
        empty: false,
        validatorsPublished: 0,
        leaseHeldBack: 0,
      }),
    },
    writeGuard: vi.fn<SourceSyncDeps['writeGuard']>().mockReturnValue(catalogueWriteGuard([])),
    jobGuard: vi
      .fn<SourceSyncDeps['jobGuard']>()
      .mockReturnValue({ id: 'job', owner: 'owner', fence: 1 }),
    markedCount: vi.fn<SourceSyncDeps['markedCount']>().mockResolvedValue(7),
    unseenExistingCount: vi.fn<SourceSyncDeps['unseenExistingCount']>().mockResolvedValue(2),
    existingKeys: vi.fn<SourceSyncDeps['existingKeys']>().mockResolvedValue(new Set(['acme/held'])),
    staleHeldKeys: vi
      .fn<SourceSyncDeps['staleHeldKeys']>()
      .mockResolvedValue({ keys: ['acme/held'], next: null }),
  };
  const sourcePoll = {
    sources: {
      listDue: vi
        .fn<RegistryJobsDeps['sourcePoll']['sources']['listDue']>()
        .mockResolvedValue([source]),
      deferPoll: vi
        .fn<RegistryJobsDeps['sourcePoll']['sources']['deferPoll']>()
        .mockResolvedValue(true),
    },
  };
  const webhook = {
    loadCredential: vi.fn<RegistryJobsDeps['webhook']['loadCredential']>().mockResolvedValue(
      parseCredentialMaterial(
        'github_app',
        JSON.stringify({
          appId: '1',
          privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
          webhookSecret: 'test-webhook-secret',
        }),
      ),
    ),
    verifier: {
      verify: vi.fn<RegistryJobsDeps['webhook']['verifier']['verify']>().mockResolvedValue(true),
    },
    deliveries: {
      record: vi
        .fn<RegistryJobsDeps['webhook']['deliveries']['record']>()
        .mockResolvedValue({ state: 'new' }),
      sourcesFor: vi
        .fn<RegistryJobsDeps['webhook']['deliveries']['sourcesFor']>()
        .mockResolvedValue(['src']),
      settle: vi
        .fn<RegistryJobsDeps['webhook']['deliveries']['settle']>()
        .mockResolvedValue(undefined),
    },
  };
  const result = createRegistryJobs({ sourceSync, sourcePoll, webhook }, jobs);
  const job: JobContext = {
    org,
    jobId: 'job',
    idempotencyKey: 'run',
    attempt: 1,
    fence: 1,
    signal: new AbortController().signal,
    ports,
    observability,
  };
  const run = (name: string, payload: unknown) => {
    const definition = result.coreJobs.find(
      ({ qualifiedName }) => qualifiedName === name,
    )!.definition;
    return definition.handler(definition.validate(payload), job);
  };
  const callWebhook = (body: string, organization: typeof org | null = org) => {
    const ctx: RequestContext = {
      org: organization,
      params: { credentialId: 'cred-1' },
      requestId: 'request-1',
      principal: null,
      projectId: null,
      ports,
      request: new Request('https://broker.test/_pb/hooks/github/cred-1', {
        method: 'POST',
        headers: { 'x-github-event': 'push' },
        body,
      }),
    };
    return result.coreRoutes[0]!.handler(ctx);
  };
  return { ...result, jobs, job, run, source, sourceSync, sourcePoll, webhook, callWebhook };
}

describe('registry jobs', () => {
  it('issues exactly the source jobs through core registration with a 60 second poll', () => {
    const f = setup();
    expect(f.coreJobs.map(({ qualifiedName }) => qualifiedName)).toEqual([
      'core:source-sync:v1',
      'core:source-poll:v1',
    ]);
    expect(f.coreJobs.every(isRegisteredCoreJob)).toBe(true);
    expect(f.coreJobs[1]?.definition.schedule).toEqual({ everySeconds: 60 });
    expect(f.coreRoutes.map(({ method, path, permission }) => [method, path, permission])).toEqual([
      ['POST', '/_pb/hooks/github/:credentialId', null],
    ]);
  });

  it('validates unknown payloads before the registered source-sync handler reads a source', async () => {
    const f = setup();
    const definition = f.coreJobs[0]!.definition;
    await expect(definition.handler({ sourceId: 'src', reason: 'invalid' }, f.job)).rejects.toThrow(
      'invalid_payload',
    );
    expect(f.sourceSync.sources.get).not.toHaveBeenCalled();
  });

  it('uses existing-key reads and database counts when finalizing a listing', async () => {
    const f = setup();
    await f.run('core:source-sync:v1', { sourceId: 'src', reason: 'admin' });
    expect(f.sourceSync.sessions.start).toHaveBeenCalledWith(org, session, {
      snapshot: snapshotRef('"listing"'),
      stamp,
    });
    expect(f.sourceSync.sessions.advance).toHaveBeenCalledWith(
      org,
      expect.objectContaining({ stamp, snapshotId: '"listing"' }),
      { cursor: JSON.stringify({ c: null, o: 0, d: 1 }), addSeen: 1 },
      [],
    );
    expect(f.sourceSync.existingKeys).toHaveBeenCalledWith(org, 'src', ['acme/held', 'acme/new']);
    expect(f.sourceSync.markedCount).toHaveBeenCalledWith(org, 'src', stamp);
    expect(f.sourceSync.unseenExistingCount).toHaveBeenCalledWith(org, 'src', stamp);
    expect(f.sourceSync.writer.markListing).toHaveBeenCalledWith(org, [], {
      scope: { kind: 'source', sourceId: 'src' },
      stamp,
      present: ['acme/held'],
    });
    expect(f.sourceSync.finalizer.finalize).toHaveBeenCalledWith(
      org,
      expect.anything(),
      expect.objectContaining({
        expectedCount: 7,
        attemptedCandidates: 9,
        successfulCandidates: 7,
        definitiveAbsent: 2,
      }),
      [],
    );
    expect(f.jobs.enqueue).toHaveBeenCalledTimes(2);
  });

  it('refreshes proxy packages through stale-held reads without opening a listing', async () => {
    const f = setup();
    vi.mocked(f.sourceSync.sources.get).mockResolvedValue({ ...f.source, type: 'packagist_proxy' });
    await f.run('core:source-sync:v1', { sourceId: 'src', reason: 'poll' });
    expect(f.sourceSync.staleHeldKeys).toHaveBeenCalledWith(org, 'src', {
      after: null,
      limit: 100,
    });
    expect(f.sourceSync.sessions.acquire).not.toHaveBeenCalled();
    expect(f.sourceSync.finalizer.finalize).not.toHaveBeenCalled();
    expect(f.jobs.enqueue).toHaveBeenCalledWith(
      org,
      'core:package-sync:v1',
      {
        sourceId: 'src',
        key: 'acme/held',
      },
      expect.objectContaining({ resourceKey: expect.stringMatching(/^package:[a-f0-9]{64}$/) }),
    );
  });

  it('does not finalize when count evidence cannot be read', async () => {
    const f = setup();
    vi.mocked(f.sourceSync.markedCount).mockRejectedValue(new Error('unavailable'));
    await expect(
      f.run('core:source-sync:v1', { sourceId: 'src', reason: 'admin' }),
    ).rejects.toThrow('handler_error');
    expect(f.sourceSync.markedCount).toHaveBeenCalledWith(org, 'src', stamp);
    expect(f.sourceSync.finalizer.finalize).not.toHaveBeenCalled();
    expect(f.sourceSync.sessions.release).toHaveBeenCalled();
  });

  it('enqueues due sources in the job organization and defers their next poll', async () => {
    const f = setup();
    await f.run('core:source-poll:v1', {});
    expect(f.sourcePoll.sources.listDue).toHaveBeenCalledWith(org, 50);
    expect(f.jobs.enqueue).toHaveBeenCalledWith(
      org,
      'core:source-sync:v1',
      {
        sourceId: 'src',
        reason: 'poll',
      },
      expect.objectContaining({ resourceKey: 'source:src' }),
    );
    expect(f.sourcePoll.sources.deferPoll).toHaveBeenCalledWith(org, 'src', stamp);
  });

  it.each([null, 'paused'] as const)(
    'does not sync a missing or paused source (%s)',
    async (state) => {
      const f = setup();
      vi.mocked(f.sourceSync.sources.get).mockResolvedValue(
        state === null ? null : { ...f.source, status: state },
      );
      await f.run('core:source-sync:v1', { sourceId: 'src', reason: 'admin' });
      expect(f.jobs.enqueue).not.toHaveBeenCalled();
      expect(f.sourceSync.sessions.acquire).not.toHaveBeenCalled();
    },
  );

  it('rejects unverified webhook bodies before recording or enqueueing', async () => {
    const f = setup();
    f.webhook.verifier.verify.mockResolvedValue(false);
    expect((await f.callWebhook('{}')).status).toBe(401);
    expect(f.webhook.deliveries.record).not.toHaveBeenCalled();
    expect(f.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('requires an organization for webhook intake', async () => {
    const f = setup();
    expect((await f.callWebhook('{}', null)).status).toBe(401);
    expect(f.webhook.loadCredential).not.toHaveBeenCalled();
  });

  it('passes verified webhook deliveries to source sync in the credential organization', async () => {
    const f = setup();
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/pkg' },
      installation: { id: 1 },
    });
    expect((await f.callWebhook(body)).status).toBe(202);
    expect(f.webhook.loadCredential).toHaveBeenCalledWith(org, 'cred-1');
    expect(f.webhook.verifier.verify).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Headers),
      new TextEncoder().encode(body),
    );
    expect(f.jobs.enqueue).toHaveBeenCalledWith(
      org,
      'core:source-sync:v1',
      {
        sourceId: 'src',
        reason: 'webhook',
      },
      expect.objectContaining({ resourceKey: 'source:src' }),
    );
  });
});
