import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectActor } from '../authz/project-actor.js';
import type { CatalogueWriteGuard, PackageVisibility } from '../db/catalogue.js';
import type { OrgId } from '../db/port.js';
import { systemClock } from '../ids.js';
import { createPackageDescription, snapshotRef } from '../sources/provider.js';
import type { ScopedCache, CacheEnvelope } from '../platform/cache.js';
import { applyChunk } from './apply-description.js';
import { createCoalescer } from './coalesce.js';
import { UpstreamError } from '../sources/policy-fetch.js';
import { catalogueNegativeKey } from '../catalogue/cache-keys.js';
import { createScopedCache, defaultEntry } from '../platform/cache.js';
import type { ApplyDeps, ApplyOutcome } from './apply-description.js';
import type { IngestSessionHandle } from './session.js';
import { createOnDemandFill, type OnDemandDeps } from './on-demand.js';
import { ComposerV2Error } from './composer/v2-package.js';
import { ComposerV1PackageError } from './composer/v1-package.js';
import { parseSha256 } from '../platform/blob.js';
import { NpmPackumentError } from './npm/packument.js';
import { SnapshotCorruptError } from './snapshot.js';
import { createPolicyFetch } from '../sources/policy-fetch.js';
import { createOutboundPolicy } from '../sources/url-policy.js';
import { describeComposerV2 } from './composer/v2-package.js';
import type { ComposerRoot } from './composer/root.js';
import type { CatalogueWriter } from '../db/catalogue.js';
import type { PackageAccess } from '../catalogue/package-access.js';
import { setContextPackageActor } from '../internal/package-actor.js';
import { setResolvedPackage } from '../internal/package-context.js';
import type { RequestContext } from '../plugin.js';
import { composerRoutes } from '../registry/composer/routes.js';
import { PackagistBusyError } from './composer/packagist-proxy.js';
import { SourceUnavailableError } from '../sources/source-unavailable.js';

vi.mock('./apply-description.js', async (original) => ({
  ...(await original<typeof import('./apply-description.js')>()),
  applyChunk: vi.fn(),
}));
vi.mock('./coalesce.js', async (original) => {
  const actual = await original<typeof import('./coalesce.js')>();
  return { ...actual, createCoalescer: vi.fn(actual.createCoalescer) };
});
const actor: ProjectActor = {
  kind: 'project',
  orgId: 'org' as OrgId,
  projectId: 'project',
  userId: 'user',
  permissions: new Set(['project:packages:read']),
};
const admitted: PackageVisibility = {
  kind: 'proxy_admissible',
  projectId: 'project',
  ecosystem: 'npm',
  key: 'name',
  sourceIds: ['A', 'B'],
};
const handle: IngestSessionHandle = {
  id: 'session',
  scopeKey: 'scope',
  owner: 'owner',
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
function visible(complete = true, ecosystem: 'npm' | 'composer' = 'npm'): PackageVisibility {
  return {
    kind: 'visible',
    pkg: {
      projectId: 'project',
      ecosystem,
      key: 'name',
      packageId: 'package',
      sourceId: 'A',
      rev: 1,
      createdAt: '',
      modifiedAt: '',
      listingComplete: complete,
      cacheEpoch: 'epoch',
    },
    cacheKey: () => {
      throw new Error('unused');
    },
    epochReader: { read: async () => 'epoch' },
  };
}
function setup() {
  const events: string[] = [];
  const entries = new Map<string, CacheEnvelope>();
  const cacheKey = (ctx: { orgId: OrgId }, key: object) => JSON.stringify([ctx.orgId, key]);
  const cache: ScopedCache = {
    get: vi.fn(async (ctx, key) => ({
      hit: entries.has(cacheKey(ctx, key))
        ? { entry: entries.get(cacheKey(ctx, key))!, state: 'fresh' as const }
        : null,
      version: 'epoch',
    })),
    set: vi.fn(async (ctx, key, entry) => {
      entries.set(cacheKey(ctx, key), { ...entry, insertedAt: new Date().toISOString() });
      return 'stored' as const;
    }),
    delete: async () => {},
    currentVersion: async () => 'epoch',
  };
  const description = createPackageDescription({
    name: 'name',
    snapshot: snapshotRef('"snapshot"'),
    members: (async function* () {
      for (let ordinal = 0; ordinal < 400; ordinal++)
        yield { ordinal, version: `${ordinal}.0.0`, form: 'npm-full' as const, raw: '{}' };
    })(),
    validators: {},
    documentsComplete: true,
    skippedMembers: [],
  });
  const describePackage = vi.fn<import('./on-demand.js').PackageFillPlan['describe']>(async () => ({
    kind: 'found',
    description,
  }));
  const plan = {
    source: {
      id: 'A',
      key: 'name',
      type: 'npmjs_proxy' as const,
      ecosystem: 'npm' as const,
      covered: false,
    },
    describe: describePackage,
    toVersion: () => null,
    packageDescription: null,
    validatorTtlSeconds: 300,
    publishedValidators: {},
  };
  const sessions = {
    acquire: vi.fn(async (_ctx, _scope, owner: string) => ({ ...handle, owner })),
    latest: vi.fn(async () => ({
      id: 'session',
      state: 'running' as const,
      generation: 1,
      fence: 1,
      seenCount: 0,
      pagesSoFar: 0,
    })),
    start: vi.fn(async () => true),
    advance: vi.fn(async () => null),
    setPendingValidators: vi.fn(async () => true),
    abandon: vi.fn(async () => true),
    discard: vi.fn(async () => true),
    release: vi.fn(async () => {
      events.push('release');
      return true;
    }),
  } satisfies OnDemandDeps['sessions'];
  const outcome: ApplyOutcome = {
    done: false,
    status: 'progress',
    session: { ...handle, pagesSoFar: 1 },
    cursor: 'cursor',
    skipped: [],
    refused: [],
    duplicates: [],
    tagsSkipped: false,
    skippedTags: [],
    planned: 450,
  };
  vi.mocked(applyChunk)
    .mockReset()
    .mockImplementation(async () => {
      events.push('apply');
      return outcome;
    });
  const deps: OnDemandDeps = {
    sessions,
    sourceMetadata: vi.fn(async () => ({ type: 'npmjs_proxy' as const })),
    cache,
    clock: systemClock,
    apply: { sessions } as unknown as ApplyDeps,
    writeGuard: vi.fn(() => [] as unknown as CatalogueWriteGuard),
    visibility: { resolve: vi.fn(async () => admitted) },
    upstreamState: { get: vi.fn(async () => null) },
    planFill: vi.fn(async () => plan),
    enqueueSync: vi.fn(async () => {
      events.push('enqueue');
    }),
  };
  const service = createOnDemandFill(deps);
  const ensure = (
    outcome: PackageVisibility = admitted,
    ecosystem: 'npm' | 'composer' = 'npm',
    who = actor,
  ) => service.ensure(who, { ecosystem, key: 'name', outcome });
  return { deps, sessions, plan, describePackage, events, outcome, ensure, cache, service };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('upstream busy on the request path', () => {
  function request(h: ReturnType<typeof setup>) {
    const outcome = {
      kind: 'proxy_admissible',
      projectId: actor.projectId,
      ecosystem: 'composer',
      key: 'name',
      sourceIds: ['A', 'B'],
    } as const;
    const versions = vi.fn<PackageAccess['versions']>();
    const route = composerRoutes({
      access: { versions } as unknown as PackageAccess,
      fill: h.service,
      dist: { serve: vi.fn() },
      clock: { advance: vi.fn() },
      publicUrl: 'https://broker.test',
    }).find((route) => route.path === '/:project/p2/:vendor/:file')!;
    const ctx: RequestContext = {
      request: new Request('https://broker.test/project/p2/acme/widget.json'),
      requestId: 'request',
      org: { orgId: actor.orgId },
      principal: { kind: 'user', id: actor.userId },
      projectId: actor.projectId,
      params: { project: 'project', vendor: 'acme', file: 'widget.json' },
      ports: {
        organizations: { get: vi.fn() },
        clock: systemClock,
        ids: { ulid: () => 'id' },
      },
    };
    setContextPackageActor(ctx, actor);
    setResolvedPackage(ctx, outcome);
    return { call: () => route.handler(ctx), versions };
  }

  it('answers 502 upstream_refused when an unconditional dev retry is refused', async () => {
    vi.useFakeTimers();
    const h = setup();
    const origin = 'https://repo.example.com';
    const target = 'https://sentinel.invalid/private?token=secret';
    const calls: string[] = [];
    let devCalls = 0;
    const fetch = createPolicyFetch({
      policy: createOutboundPolicy({ runtime: 'node', allowPrivateHosts: [], selfOrigins: [] }),
      userAgent: 'pb-test/1',
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('~dev.json')) {
          if (++devCalls === 1) return new Response(null, { status: 304 });
          return Response.redirect(target, 302);
        }
        return Response.json({ packages: { 'acme/widget': [] } });
      },
    });
    const root: ComposerRoot = {
      mode: 'v2',
      packagesJsonUrl: `${origin}/packages.json`,
      metadataUrl: `${origin}/p2/%package%.json`,
      inlineProviders: false,
      partialPackages: false,
      inlinePackages: false,
      validator: { sha256: 'a'.repeat(64) },
      messages: [],
      mirrors: [],
    };
    h.plan.describe.mockImplementation(async () => {
      const result = await describeComposerV2(fetch, { root, allowedOrigins: [] }, 'acme/widget', {
        path: 'request',
        dev: true,
        validators: { 'composer-p2-dev': { etag: '"d1"' } },
        probe: { secrets: [], queryParams: [] },
        clock: systemClock,
      });
      if (result.kind === 'busy') throw new PackagistBusyError(result.retryAfterSeconds);
      return result;
    });
    const { call, versions } = request(h);

    const pending = call();
    await vi.advanceTimersByTimeAsync(25_001);
    const response = await pending;

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: 'upstream_refused',
        message: 'Upstream request refused',
        requestId: 'request',
      },
    });
    expect(devCalls).toBe(2);
    expect(calls).toHaveLength(3);
    expect(calls).not.toContain(target);
    expect(versions).not.toHaveBeenCalled();
    expect(h.cache.set).not.toHaveBeenCalled();
    expect(applyChunk).not.toHaveBeenCalled();
  });

  it.each([
    [null, 10],
    [Number.NaN, 10],
    [Number.POSITIVE_INFINITY, 10],
    [Number.NEGATIVE_INFINITY, 10],
    [0.4, 1],
    [1.6, 2],
    [-5, 1],
    [0, 1],
    [1, 1],
    [5, 5],
    [60, 60],
    [61, 60],
    [86400, 60],
  ])(
    'answers busy with 503 Retry-After %s → %i and keeps other failures at 502',
    async (upstreamRetry, expectedRetry) => {
      vi.useFakeTimers();
      const h = setup();
      h.describePackage.mockRejectedValue(new PackagistBusyError(upstreamRetry));
      const { call, versions } = request(h);
      const started = Date.now();
      const response = await call();
      expect(Date.now()).toBe(started);
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe(String(expectedRetry));
      expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
      expect(h.describePackage).toHaveBeenCalledTimes(1);
      expect(h.deps.planFill).toHaveBeenCalledExactlyOnceWith({ orgId: actor.orgId }, 'A', 'name');
      expect(applyChunk).not.toHaveBeenCalled();
      expect(h.cache.set).not.toHaveBeenCalled();
      expect(h.deps.enqueueSync).not.toHaveBeenCalled();
      expect(versions).not.toHaveBeenCalled();

      for (const error of [
        ...[401, 403, 429, 500, 503].map((status) => new UpstreamError('http_status', status)),
        new UpstreamError('network'),
        new ComposerV2Error('http_status', 503),
        new ComposerV1PackageError('status', 503),
      ]) {
        const failed = setup();
        failed.describePackage.mockRejectedValue(error);
        const response = await request(failed).call();
        expect(response.status).toBe(502);
        expect(response.headers.get('Retry-After')).toBeNull();
        expect(await response.json()).toMatchObject({ error: { code: 'bad_gateway' } });
        expect(failed.deps.planFill).toHaveBeenCalledExactlyOnceWith(
          { orgId: actor.orgId },
          'A',
          'name',
        );
        expect(applyChunk).not.toHaveBeenCalled();
        expect(failed.cache.set).not.toHaveBeenCalled();
      }
    },
  );

  it('releases the session on busy so the next request can acquire and fill', async () => {
    const h = setup();
    let held = false;
    h.sessions.acquire.mockImplementation(async (_ctx, _scope, owner: string) => {
      if (held) return 'held' as never;
      held = true;
      return { ...handle, owner };
    });
    h.sessions.discard.mockImplementation(async () => {
      held = false;
      return true;
    });
    h.sessions.release.mockImplementation(async () => {
      held = false;
      return true;
    });
    h.describePackage.mockRejectedValueOnce(new PackagistBusyError(5));
    expect(await h.ensure({ ...admitted, ecosystem: 'composer' }, 'composer')).toEqual({
      kind: 'busy',
      retryAfterSeconds: 5,
    });
    expect(held).toBe(false);
    expect(h.sessions.abandon).not.toHaveBeenCalled();
    expect(applyChunk).not.toHaveBeenCalled();
    vi.mocked(applyChunk).mockResolvedValue({ ...h.outcome, done: true, status: 'complete' });
    expect(await h.ensure({ ...admitted, ecosystem: 'composer' }, 'composer')).toEqual({
      kind: 'filled',
    });
    expect(h.describePackage).toHaveBeenCalledTimes(2);
    expect(applyChunk).toHaveBeenCalled();
  });

  it('delivers the upstream Retry-After to every coalesced caller without waiting', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.describePackage.mockRejectedValue(new PackagistBusyError(5));
    expect(
      await Promise.all(
        Array.from({ length: 20 }, () =>
          h.ensure({ ...admitted, ecosystem: 'composer' }, 'composer'),
        ),
      ),
    ).toEqual(Array.from({ length: 20 }, () => ({ kind: 'busy', retryAfterSeconds: 5 })));
    expect(h.describePackage).toHaveBeenCalledTimes(1);
    expect(applyChunk).not.toHaveBeenCalled();
    expect(h.cache.set).not.toHaveBeenCalled();
  });
});
describe('T430n review regressions', () => {
  it.each(['before fill', 'during describe'] as const)(
    'keeps an admitted name busy when its listing becomes incomplete %s',
    async (timing) => {
      const h = setup();
      if (timing === 'before fill')
        vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(false));
      h.describePackage.mockImplementation(async () => {
        vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(false));
        return { kind: 'not_found', definitive: true };
      });
      expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
      expect(h.describePackage).toHaveBeenCalledTimes(1);
      expect(h.cache.set).not.toHaveBeenCalled();
      expect(h.deps.enqueueSync).not.toHaveBeenCalled();
    },
  );

  it('holds Composer when an admitted name becomes incomplete during a definitive 404', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.describePackage.mockImplementation(async () => {
      vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(false, 'composer'));
      return { kind: 'not_found', definitive: true };
    });
    let result: Awaited<ReturnType<typeof h.ensure>> | undefined;
    const pending = h.ensure({ ...admitted, ecosystem: 'composer' }, 'composer').then((value) => {
      result = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBeUndefined();
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(true, 'composer'));
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ kind: 'filled' });
    expect(h.cache.set).not.toHaveBeenCalled();
  });

  it('rechecks a cached 404 against live visibility for an originally admitted name', async () => {
    const h = setup();
    h.describePackage.mockResolvedValueOnce({ kind: 'not_found', definitive: true });
    expect(await h.ensure()).toEqual({ kind: 'not_found' });
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(false));
    expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(applyChunk).toHaveBeenCalledTimes(1);
    expect(h.cache.set).toHaveBeenCalledTimes(1);
  });

  it("maps a shared upstream 404 using each caller's current listing completeness", async () => {
    const h = setup();
    const other = { ...actor, projectId: 'other' };
    h.describePackage.mockImplementation(async () => {
      vi.mocked(h.deps.visibility.resolve).mockImplementation(async (who) =>
        who.projectId === other.projectId ? visible(false) : admitted,
      );
      return { kind: 'not_found', definitive: true };
    });
    expect(
      await Promise.all([
        h.ensure(),
        h.ensure({ ...admitted, projectId: other.projectId }, 'npm', other),
      ]),
    ).toEqual([{ kind: 'not_found' }, { kind: 'busy', retryAfterSeconds: 10 }]);
    expect(h.describePackage).toHaveBeenCalledTimes(1);
    expect(h.cache.set).toHaveBeenCalledTimes(1);
  });

  it.each<PackageVisibility>([{ kind: 'absent' }, { ...admitted, sourceIds: ['B'] }])(
    'does not cache a 404 after the caller loses admission to the source: %j',
    async (current) => {
      const h = setup();
      h.describePackage.mockImplementation(async () => {
        vi.mocked(h.deps.visibility.resolve).mockResolvedValue(current);
        return { kind: 'not_found', definitive: true };
      });
      expect(await h.ensure()).toEqual(
        current.kind === 'absent' ? { kind: 'not_found' } : { kind: 'busy', retryAfterSeconds: 10 },
      );
      expect(h.cache.set).not.toHaveBeenCalled();
    },
  );

  it('does not share a revoked project visibility as upstream absence', async () => {
    const h = setup();
    const other = { ...actor, projectId: 'other' };
    vi.mocked(h.deps.visibility.resolve).mockImplementation(async (who) =>
      who.projectId === actor.projectId ? { kind: 'absent' } : admitted,
    );
    const [revoked, allowed] = await Promise.all([
      h.ensure(),
      h.ensure({ ...admitted, projectId: other.projectId }, 'npm', other),
    ]);
    expect(revoked).toEqual({ kind: 'not_found' });
    expect(allowed).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.describePackage).toHaveBeenCalledTimes(1);
    expect(h.cache.set).not.toHaveBeenCalled();
  });

  it('rechecks each project after a shared fill completes', async () => {
    const h = setup();
    const other = { ...actor, projectId: 'other' };
    let revoked = false;
    vi.mocked(h.deps.visibility.resolve).mockImplementation(async (who) =>
      revoked && who.projectId === actor.projectId ? { kind: 'absent' } : admitted,
    );
    vi.mocked(applyChunk).mockImplementation(async () => {
      revoked = true;
      return { ...h.outcome, done: true, status: 'complete' };
    });
    expect(
      await Promise.all([
        h.ensure(),
        h.ensure({ ...admitted, projectId: other.projectId }, 'npm', other),
      ]),
    ).toEqual([{ kind: 'not_found' }, { kind: 'filled' }]);
    expect(h.describePackage).toHaveBeenCalledTimes(1);
  });

  it.each(['describe', 'apply'] as const)(
    'bounds an uncooperative inline %s by the Composer deadline',
    async (phase) => {
      vi.useFakeTimers();
      const h = setup();
      const described = await h.describePackage({}, new AbortController().signal);
      h.describePackage.mockClear();
      let finish!: () => void;
      const blocked = new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (phase === 'describe')
        h.describePackage.mockImplementation(async () => {
          await blocked;
          return described;
        });
      else
        vi.mocked(applyChunk).mockImplementation(async () => {
          await blocked;
          return { ...h.outcome, done: true, status: 'complete' };
        });
      let result: Awaited<ReturnType<typeof h.ensure>> | undefined;
      const pending = h.ensure({ ...admitted, ecosystem: 'composer' }, 'composer').then((value) => {
        result = value;
        return value;
      });
      await vi.advanceTimersByTimeAsync(24_999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
      expect(h.describePackage.mock.calls[0]![1].aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      finish();
      await pending;
      await vi.advanceTimersByTimeAsync(0);
      expect(h.deps.enqueueSync).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps a shared fill alive for a caller whose Composer deadline is later', async () => {
    vi.useFakeTimers();
    const h = setup();
    const described = await h.describePackage({}, new AbortController().signal);
    h.describePackage.mockClear();
    h.describePackage.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25_500));
      return described;
    });
    vi.mocked(applyChunk).mockResolvedValue({ ...h.outcome, done: true, status: 'complete' });
    let first: Awaited<ReturnType<typeof h.ensure>> | undefined;
    let second: Awaited<ReturnType<typeof h.ensure>> | undefined;
    void h.ensure({ ...admitted, ecosystem: 'composer' }, 'composer').then((value) => {
      first = value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    const pending = h.ensure({ ...admitted, ecosystem: 'composer' }, 'composer').then((value) => {
      second = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(first).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(second).toBeUndefined();
    expect(h.describePackage.mock.calls[0]![1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ kind: 'filled' });
    expect(h.describePackage).toHaveBeenCalledTimes(1);
  });

  it.each(['describe', 'apply'] as const)(
    'abandons a corrupt staged snapshot detected during %s',
    async (phase) => {
      const h = setup();
      h.sessions.acquire.mockImplementation(async (_ctx, _scope, owner) => ({
        ...handle,
        owner,
        stamp: 'stamp',
        snapshotId: '"snapshot"',
        snapshotBlobSha256: 'a'.repeat(64),
      }));
      if (phase === 'describe') h.describePackage.mockRejectedValue(new SnapshotCorruptError());
      else vi.mocked(applyChunk).mockRejectedValue(new SnapshotCorruptError());
      expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
      expect(h.sessions.abandon).toHaveBeenCalledExactlyOnceWith(
        { orgId: actor.orgId },
        await h.sessions.acquire.mock.results[0]!.value,
      );
      expect(h.cache.set).not.toHaveBeenCalled();
      expect(h.deps.enqueueSync).not.toHaveBeenCalled();
    },
  );
});
describe('missing npm snapshots', () => {
  it.each(['describe', 'members'] as const)(
    'abandons the fenced generation when the snapshot disappears during %s',
    async (phase) => {
      const h = setup();
      h.sessions.acquire.mockImplementation(async (_ctx, _scope, owner) => ({
        ...handle,
        owner,
        stamp: 'stamp',
        snapshotId: '"snapshot"',
        snapshotBlobSha256: 'a'.repeat(64),
      }));
      const error = new NpmPackumentError('snapshot_gone');
      if (phase === 'describe') h.describePackage.mockRejectedValue(error);
      else vi.mocked(applyChunk).mockRejectedValue(error);

      expect(await Promise.all(Array.from({ length: 20 }, () => h.ensure()))).toEqual(
        Array.from({ length: 20 }, () => ({ kind: 'busy', retryAfterSeconds: 10 })),
      );
      expect(h.describePackage).toHaveBeenCalledTimes(1);
      expect(h.sessions.abandon).toHaveBeenCalledExactlyOnceWith(
        { orgId: actor.orgId },
        await h.sessions.acquire.mock.results[0]!.value,
      );
      expect(h.cache.set).not.toHaveBeenCalled();
      expect(h.deps.enqueueSync).not.toHaveBeenCalled();
    },
  );
  it.each(['invalid', 'unexpected_status', 'unstable'] as const)(
    'preserves a stamped generation on npm error %s',
    async (code) => {
      const h = setup();
      h.sessions.acquire.mockImplementation(async (_ctx, _scope, owner) => ({
        ...handle,
        owner,
        stamp: 'stamp',
        snapshotId: '"snapshot"',
      }));
      h.describePackage.mockRejectedValue(new NpmPackumentError(code));
      expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
      expect(h.sessions.abandon).not.toHaveBeenCalled();
      expect(h.sessions.release).toHaveBeenCalledTimes(1);
    },
  );
});
describe('on-demand fill', () => {
  it('hands a 400-version fill to the job after one inline chunk, then reports completion', async () => {
    const h = setup();
    expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(applyChunk).toHaveBeenCalledTimes(1);
    expect(h.events.slice(0, 3)).toEqual(['apply', 'release', 'enqueue']);
    expect(h.deps.enqueueSync).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      { sourceId: 'A', key: 'name', sessionId: 'session', generation: 1, step: 1 },
    );
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible());
    expect(await h.ensure()).toEqual({ kind: 'filled' });
  });
  it('holds Composer until the catalogue becomes complete at 10 seconds', async () => {
    vi.useFakeTimers();
    const h = setup();
    setTimeout(() => vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible()), 10_000);
    const pending = h.ensure({ ...admitted, ecosystem: 'composer' }, 'composer');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ kind: 'filled' });
  });
  it('ends a Composer hold at 25 seconds', async () => {
    vi.useFakeTimers();
    const h = setup();
    const pending = h.ensure(visible(false, 'composer'), 'composer');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
  });
  it('serves stale stored data and defers a failing revalidation enqueue', async () => {
    const h = setup();
    h.describePackage.mockRejectedValue(new Error('503'));
    vi.mocked(h.deps.enqueueSync).mockRejectedValue(new Error('503'));
    const result = await h.ensure(visible());
    expect(result).toMatchObject({ kind: 'serve', stale: true });
    expect(h.describePackage).not.toHaveBeenCalled();
    expect(h.deps.enqueueSync).not.toHaveBeenCalled();
    if (result.kind !== 'serve' || !result.background) throw new Error('missing background');
    await expect(result.background()).resolves.toBeUndefined();
    expect(h.deps.enqueueSync).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 500, 503])('does not try another source after %s', async (status) => {
    const h = setup();
    h.describePackage.mockRejectedValue(new UpstreamError('http_status', status));
    expect(await h.ensure()).toEqual({ kind: 'upstream_error' });
    expect(h.deps.planFill).toHaveBeenCalledTimes(1);
    expect(h.deps.planFill).toHaveBeenCalledWith({ orgId: actor.orgId }, 'A', 'name');
    expect(h.describePackage).toHaveBeenCalledTimes(1);
    expect(h.cache.set).not.toHaveBeenCalled();
  });
  it('coalesces twenty definitive 404s and caches the next request for thirty seconds', async () => {
    const h = setup();
    h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true } as never);
    expect(await Promise.all(Array.from({ length: 20 }, () => h.ensure()))).toEqual(
      Array.from({ length: 20 }, () => ({ kind: 'not_found' })),
    );
    expect(h.describePackage).toHaveBeenCalledTimes(1);
    expect(h.cache.set).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.cache.set).mock.calls[0]?.[2]).toMatchObject({
      negative: true,
      staleUntil: null,
    });
    expect(await h.ensure()).toEqual({ kind: 'not_found' });
    expect(h.describePackage).toHaveBeenCalledTimes(1);
    expect(await h.ensure(admitted, 'npm', { ...actor, projectId: 'other' })).toEqual({
      kind: 'not_found',
    });
    expect(h.describePackage).toHaveBeenCalledTimes(2);
  });
  it('never fetches an absent name or an incomplete listing with a live holder', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.sessions.acquire.mockResolvedValue('held' as never);
    expect(await h.ensure({ kind: 'absent' })).toEqual({ kind: 'not_found' });
    const pending = h.ensure(visible(false));
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.describePackage).not.toHaveBeenCalled();
  });
  it('serves a held non-proxy package even when no fill can be planned', async () => {
    const h = setup();
    vi.mocked(h.deps.planFill).mockResolvedValue(null);
    vi.mocked(h.deps.sourceMetadata).mockResolvedValue({ type: 'hosted' });
    expect(await h.ensure(visible())).toEqual({ kind: 'serve', stale: false });
    expect(h.deps.planFill).not.toHaveBeenCalled();
  });
  it.each(['npm-packument', 'composer-p2', 'composer-v1-provider'] as const)(
    'reads freshness from %s',
    async (form) => {
      const h = setup();
      vi.mocked(h.deps.sourceMetadata).mockResolvedValue({
        type: form === 'npm-packument' ? 'npmjs_proxy' : 'packagist_proxy',
        form,
      });
      await h.ensure(visible());
      expect(h.deps.upstreamState.get).toHaveBeenCalledWith(
        { orgId: actor.orgId },
        'package',
        form,
      );
    },
  );
  it('does not trust positive freshness after any 404', async () => {
    const h = setup();
    const row = {
      etag: null,
      lastModified: null,
      contentSha256: null,
      checkedAt: '',
      freshUntil: '2999-01-01',
      firstNotFoundAt: null,
      notFoundCount: 0,
    };
    vi.mocked(h.deps.upstreamState.get).mockResolvedValue(row);
    expect(await h.ensure(visible())).toEqual({ kind: 'serve', stale: false });
    vi.mocked(h.deps.upstreamState.get).mockResolvedValue({ ...row, notFoundCount: 1 });
    expect(await h.ensure(visible())).toMatchObject({ kind: 'serve', stale: true });
  });
  it('releases and enqueues a superseded chunk', async () => {
    const h = setup();
    vi.mocked(applyChunk).mockResolvedValue({ ...h.outcome, status: 'superseded', done: true });
    expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.events.slice(0, 2)).toEqual(['release', 'enqueue']);
  });
  it('fails closed when the session probe loses its lease', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.sessions.latest.mockResolvedValue(null as never);
    h.describePackage.mockImplementation(() => new Promise(() => {}));
    const pending = h.ensure();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(applyChunk).not.toHaveBeenCalled();
  });
  it('keeps organizations separate', async () => {
    const h = setup();
    h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true } as never);
    await Promise.all([
      h.ensure(),
      h.ensure(admitted, 'npm', { ...actor, orgId: 'other' as OrgId }),
    ]);
    expect(h.describePackage).toHaveBeenCalledTimes(2);
  });
  it('fails closed when isDone throws', async () => {
    const h = setup();
    vi.mocked(h.deps.visibility.resolve).mockRejectedValue(new Error('unavailable'));
    expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.describePackage).not.toHaveBeenCalled();
  });
  it.each(['incomplete', 'abandoned', 'refused'] as const)(
    'does not enqueue a %s chunk',
    async (status) => {
      const h = setup();
      vi.mocked(applyChunk).mockResolvedValue({ ...h.outcome, status });
      expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
      expect(h.deps.enqueueSync).not.toHaveBeenCalled();
    },
  );
  it('does not cache a non-definitive absence or a network failure', async () => {
    const h = setup();
    h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: false } as never);
    expect(await h.ensure()).toEqual({ kind: 'upstream_error' });
    expect(h.cache.set).not.toHaveBeenCalled();
  });
});

describe('fix round 1 regressions', () => {
  it('resumes an incomplete visible package with no live holder and enqueues its cursor', async () => {
    const h = setup();
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(false));
    h.sessions.acquire.mockImplementation(async (_ctx, _scope, owner) => ({
      ...handle,
      owner,
      fence: 2,
      stamp: 'stamp',
      snapshotId: '"snapshot"',
      cursor: 'cursor',
    }));
    expect(await h.ensure(visible(false))).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    const acquired = await h.sessions.acquire.mock.results[0]!.value;
    expect(h.deps.writeGuard).toHaveBeenCalledWith({ orgId: actor.orgId }, acquired);
    expect(applyChunk).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      expect.anything(),
      expect.objectContaining({
        session: acquired,
        guard: vi.mocked(h.deps.writeGuard).mock.results[0]!.value,
      }),
    );
    expect(h.describePackage).toHaveBeenCalledWith(
      { snapshot: snapshotRef('"snapshot"') },
      expect.any(AbortSignal),
    );
    expect(h.events.slice(0, 3)).toEqual(['apply', 'release', 'enqueue']);
  });
  it('retries the inline fill after the first continuation enqueue fails', async () => {
    const h = setup();
    vi.mocked(h.deps.enqueueSync).mockRejectedValueOnce(new Error('queue unavailable'));
    await h.ensure();
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(false));
    await h.ensure(visible(false));
    expect(applyChunk).toHaveBeenCalledTimes(2);
    expect(h.deps.enqueueSync).toHaveBeenCalledTimes(2);
  });
  it('uses the authorized canonical key for the session, plan, negative cache and job', async () => {
    const h = setup();
    await h.service.ensure(actor, { ecosystem: 'npm', key: 'NaMe', outcome: admitted });
    expect(h.sessions.acquire).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      { scope: 'package', sourceId: 'A', packageKey: 'name' },
      expect.any(String),
      60,
    );
    expect(h.deps.planFill).toHaveBeenCalledWith({ orgId: actor.orgId }, 'A', 'name');
    expect(h.cache.get).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      catalogueNegativeKey('project', 'A', 'npm', 'name'),
    );
    expect(h.deps.enqueueSync).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      expect.objectContaining({ key: 'name' }),
    );
    h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true } as never);
    await h.service.ensure(actor, { ecosystem: 'npm', key: 'NAME', outcome: admitted });
    expect(h.cache.set).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      catalogueNegativeKey('project', 'A', 'npm', 'name'),
      expect.anything(),
      expect.anything(),
    );
  });
  it.each([
    { type: 'npmjs_proxy', form: 'npm-packument' },
    { type: 'npm_registry', form: 'npm-packument' },
    { type: 'packagist_proxy', form: 'composer-p2' },
    { type: 'composer_repository', form: 'composer-v1-provider' },
  ] as const)('checks freshness and serves stale for $type/$form', async (metadata) => {
    const h = setup();
    vi.mocked(h.deps.sourceMetadata).mockResolvedValue(metadata);
    vi.mocked(h.deps.upstreamState.get).mockResolvedValue({
      etag: null,
      lastModified: null,
      contentSha256: null,
      checkedAt: '',
      freshUntil: '2999-01-01',
      notFoundCount: 0,
      firstNotFoundAt: null,
    });
    expect(await h.ensure(visible())).toEqual({ kind: 'serve', stale: false });
    expect(h.deps.upstreamState.get).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      'package',
      metadata.form,
    );
    vi.mocked(h.deps.upstreamState.get).mockResolvedValue(null);
    expect(await h.ensure(visible())).toMatchObject({ kind: 'serve', stale: true });
  });
  it('does not cache a 404 under an epoch bumped during authorization', async () => {
    const h = setup();
    let epoch = 'old';
    const rawSet = vi.fn(async () => {});
    const cache = createScopedCache(
      { get: async () => null, set: rawSet, delete: async () => {} },
      { read: async () => epoch },
      { deploymentId: 'test' },
    );
    vi.mocked(h.deps.visibility.resolve).mockImplementation(async () => {
      epoch = 'new';
      return admitted;
    });
    h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true } as never);
    expect(
      await createOnDemandFill({ ...h.deps, cache }).ensure(actor, {
        ecosystem: 'npm',
        key: 'name',
        outcome: admitted,
      }),
    ).toEqual({ kind: 'not_found' });
    expect(rawSet).not.toHaveBeenCalled();
  });
  it.each(['not_found', 'filled'] as const)(
    'discards a generation that never starts: %s',
    async (state) => {
      const h = setup();
      if (state === 'not_found')
        h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true } as never);
      else vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible());
      await h.ensure();
      expect(h.sessions.discard).toHaveBeenCalledWith(
        { orgId: actor.orgId },
        await h.sessions.acquire.mock.results[0]!.value,
      );
      expect(h.sessions.abandon).not.toHaveBeenCalled();
      expect(h.sessions.release).not.toHaveBeenCalled();
    },
  );
  it('releases a generation that made progress and never discards it', async () => {
    const h = setup();
    expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.sessions.release).toHaveBeenCalled();
    expect(h.sessions.discard).not.toHaveBeenCalled();
    expect(h.sessions.abandon).not.toHaveBeenCalled();
  });
  it('retries an unseen not_modified once without validators', async () => {
    const h = setup();
    h.plan.publishedValidators = { 'npm-full': { etag: '"old"' } };
    h.describePackage.mockResolvedValueOnce({ kind: 'not_modified' } as never);
    vi.mocked(applyChunk).mockResolvedValue({ ...h.outcome, done: true, status: 'complete' });
    expect(await h.ensure()).toEqual({ kind: 'filled' });
    expect(h.describePackage.mock.calls.map((call) => call[0])).toEqual([
      { validators: { 'npm-full': { etag: '"old"' } } },
      {},
    ]);
  });
  it('returns busy after a second not_modified', async () => {
    const h = setup();
    h.describePackage.mockResolvedValue({ kind: 'not_modified' } as never);
    expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.describePackage).toHaveBeenCalledTimes(2);
    expect(applyChunk).not.toHaveBeenCalled();
  });
  it('ends the unseen Composer hold at exactly 25 seconds', async () => {
    vi.useFakeTimers();
    const h = setup();
    let done = false;
    const pending = h.ensure({ ...admitted, ecosystem: 'composer' }, 'composer').then((result) => {
      done = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
  });
  it('delivers upstream errors to every coalesced joiner', async () => {
    const h = setup();
    h.describePackage.mockRejectedValue(new UpstreamError('network'));
    expect(await Promise.all(Array.from({ length: 20 }, () => h.ensure()))).toEqual(
      Array.from({ length: 20 }, () => ({ kind: 'upstream_error' })),
    );
    expect(h.describePackage).toHaveBeenCalledTimes(1);
  });
  it.each(['owner', 'fence'] as const)(
    'adapter skips release for a mismatched %s',
    async (field) => {
      const h = setup();
      const adapter = vi.mocked(createCoalescer).mock.lastCall![0];
      const key = JSON.stringify(['ingest', 'package', 'A', 'name']);
      const ctx = { orgId: actor.orgId };
      const lease = await adapter.acquire(ctx, key, 'first', 60);
      if (lease === 'held') throw new Error('unexpected holder');
      h.sessions.acquire.mockResolvedValue({
        ...handle,
        owner: field === 'owner' ? 'second' : 'first',
        fence: field === 'fence' ? 2 : 1,
      });
      await adapter.acquire(ctx, key, 'second', 60);
      await adapter.release(ctx, lease);
      expect(h.sessions.release).not.toHaveBeenCalled();
      expect(h.sessions.abandon).not.toHaveBeenCalled();
      expect(h.sessions.discard).not.toHaveBeenCalled();
    },
  );
  it('adapter renew fails when a different session row reuses the generation and fence', async () => {
    const h = setup();
    const adapter = vi.mocked(createCoalescer).mock.lastCall![0];
    const key = JSON.stringify(['ingest', 'package', 'A', 'name']);
    const ctx = { orgId: actor.orgId };
    const lease = await adapter.acquire(ctx, key, 'first', 60);
    if (lease === 'held') throw new Error('unexpected holder');
    expect(await adapter.renew(ctx, lease, 60)).toBe(true);
    vi.mocked(h.sessions.latest).mockResolvedValue({
      id: 'recreated',
      state: 'running',
      generation: 1,
      fence: 1,
      seenCount: 0,
      pagesSoFar: 0,
    });
    expect(await adapter.renew(ctx, lease, 60)).toBe(false);
  });
  it.each(['sourceMetadata', 'upstreamState'] as const)(
    'serves a complete stored listing when %s fails',
    async (dependency) => {
      const h = setup();
      if (dependency === 'sourceMetadata')
        vi.mocked(h.deps.sourceMetadata).mockRejectedValue(new Error('unavailable'));
      else vi.mocked(h.deps.upstreamState.get).mockRejectedValue(new Error('unavailable'));
      expect(await h.ensure(visible())).toMatchObject({ kind: 'serve', stale: true });
    },
  );
  it('maps an upstream error from the members iterator to upstream_error', async () => {
    const h = setup();
    h.describePackage.mockResolvedValue({
      kind: 'found',
      description: createPackageDescription({
        name: 'name',
        snapshot: snapshotRef('"snapshot"'),
        validators: {},
        documentsComplete: true,
        members: {
          async *[Symbol.asyncIterator]() {
            yield await Promise.reject(new UpstreamError('network'));
          },
        },
      }),
    });
    vi.mocked(applyChunk).mockImplementation(async (_ctx, _deps, input) => {
      for await (const candidate of input.description.members) void candidate;
      return h.outcome;
    });
    expect(await Promise.all(Array.from({ length: 20 }, () => h.ensure()))).toEqual(
      Array.from({ length: 20 }, () => ({ kind: 'upstream_error' })),
    );
    expect(applyChunk).toHaveBeenCalledTimes(1);
    expect(h.cache.set).not.toHaveBeenCalled();
  });
  it('keeps unknown apply failures busy', async () => {
    const h = setup();
    vi.mocked(applyChunk).mockRejectedValue(new Error('database failure'));
    expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.sessions.discard).toHaveBeenCalledTimes(1);
    expect(h.sessions.abandon).not.toHaveBeenCalled();
  });
});

it.each(['incomplete', 'abandoned', 'refused'] as const)(
  'recovers an incomplete visible listing after a %s apply',
  async (status) => {
    const h = setup();
    vi.mocked(applyChunk).mockResolvedValueOnce({ ...h.outcome, status, done: true });
    await h.ensure();
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(false));
    await h.ensure(visible(false));
    expect(applyChunk).toHaveBeenCalledTimes(2);
    expect(h.deps.enqueueSync).toHaveBeenCalledTimes(1);
  },
);
it('coalesces encoding variants using the canonical authorized key', async () => {
  const h = setup();
  h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true });
  const outcome = { ...admitted, key: '@scope/name' } as PackageVisibility;
  await Promise.all(
    ['@scope/Name', '@scope%2fName'].map((key) =>
      h.service.ensure(actor, { ecosystem: 'npm', key, outcome }),
    ),
  );
  expect(h.describePackage).toHaveBeenCalledTimes(1);
  expect(h.deps.planFill).toHaveBeenCalledWith({ orgId: actor.orgId }, 'A', '@scope/name');
});
it('uses the canonical held-package key for background work', async () => {
  const h = setup();
  const result = await h.service.ensure(actor, {
    ecosystem: 'npm',
    key: 'NAME',
    outcome: visible(),
  });
  if (result.kind !== 'serve' || !result.background) throw new Error('missing background');
  await result.background();
  expect(h.deps.enqueueSync).toHaveBeenCalledWith(
    { orgId: actor.orgId },
    { sourceId: 'A', key: 'name' },
  );
});
it.each([
  [
    'npmjs_proxy',
    undefined,
    { 'npm-full': { etag: '"npm"' } },
    { 'npm-packument': { etag: '"npm"', lastModified: null, contentSha256: null } },
  ],
  [
    'packagist_proxy',
    undefined,
    { 'composer-p2': { etag: '"stable"' }, 'composer-p2-dev': { etag: '"dev"' } },
    {
      'composer-p2': { etag: '"stable"', lastModified: null, contentSha256: null },
      'composer-p2-dev': { etag: '"dev"', lastModified: null, contentSha256: null },
    },
  ],
  [
    'composer_repository',
    'composer-v1-provider',
    {},
    { 'composer-v1-provider': { etag: null, lastModified: null, contentSha256: null } },
  ],
] as const)(
  'publishes the %s description under upstream forms before finalization',
  async (type, form, validators, expected) => {
    const h = setup();
    vi.mocked(h.deps.sourceMetadata).mockResolvedValue({
      type,
      ...(form === undefined ? {} : { form }),
    });
    h.describePackage.mockResolvedValue({
      kind: 'found',
      description: createPackageDescription({
        name: 'name',
        snapshot: snapshotRef('"snapshot"'),
        validators,
        documentsComplete: true,
        members: (async function* () {
          yield { ordinal: 0, version: '1.0.0', form: 'npm-full', raw: '{}' } as const;
        })(),
      }),
    });
    const finalize = vi.fn(async () => ({
      status: 'complete' as const,
      empty: false,
      validatorsPublished: Object.keys(expected).length,
    }));
    Object.assign(h.deps.apply, { finalizer: { finalize } });
    vi.mocked(applyChunk).mockImplementation(async (ctx, deps, input) => {
      await deps.finalizer.finalize(
        ctx,
        input.session,
        {
          expectedCount: 1,
          attemptedCandidates: 1,
          successfulCandidates: 1,
          definitiveAbsent: 0,
          upstreamComplete: true,
          validatorTtlSeconds: 300,
        },
        input.guard,
      );
      return { ...h.outcome, status: 'complete', done: true };
    });
    expect(await h.ensure()).toEqual({ kind: 'filled' });
    expect(h.sessions.setPendingValidators).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      expect.anything(),
      expected,
    );
    expect(h.sessions.setPendingValidators.mock.invocationCallOrder[0]).toBeLessThan(
      finalize.mock.invocationCallOrder[0]!,
    );
  },
);

describe('fix round 2 regressions', () => {
  it('keeps a definitive 404 for an incomplete visible package busy without a negative entry', async () => {
    const h = setup();
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(false));
    h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true });
    expect(await h.ensure(visible(false))).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.cache.set).not.toHaveBeenCalled();
    expect(h.deps.enqueueSync).not.toHaveBeenCalled();
  });
  it.each(['admitted', 'visible'] as const)(
    'uses the authorized ecosystem for %s',
    async (kind) => {
      const h = setup();
      const outcome = kind === 'admitted' ? admitted : visible(false);
      vi.mocked(h.deps.visibility.resolve).mockResolvedValue(outcome);
      expect(
        await h.service.ensure(actor, { ecosystem: 'composer', key: 'NAME', outcome }),
      ).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
      expect(h.cache.get).toHaveBeenCalledWith(
        { orgId: actor.orgId },
        catalogueNegativeKey('project', 'A', 'npm', 'name'),
      );
      expect(h.deps.visibility.resolve).toHaveBeenCalledWith(actor, 'npm', 'name');
    },
  );
  it.each([
    [new UpstreamError('network'), 'upstream_error'],
    [new DOMException('aborted', 'AbortError'), 'busy'],
    [new Error('snapshot read failed'), 'busy'],
  ] as const)('maps describe failure %s to %s', async (error, kind) => {
    const h = setup();
    h.sessions.acquire.mockImplementation(async (_ctx, _scope, owner) => ({
      ...handle,
      owner,
      stamp: 'stamp',
      snapshotId: '"snapshot"',
    }));
    h.describePackage.mockRejectedValue(error);
    expect(await h.ensure()).toMatchObject({ kind });
    expect(h.cache.set).not.toHaveBeenCalled();
    expect(applyChunk).not.toHaveBeenCalled();
  });
  it.each(['x'.repeat(1025), 'bad\nvalue', 'bad\u0000value', 'bad\u007fvalue'])(
    'drops invalid validators before persistence: %j',
    async (invalid) => {
      const h = setup();
      h.describePackage.mockResolvedValue({
        kind: 'found',
        description: createPackageDescription({
          name: 'name',
          snapshot: snapshotRef('"snapshot"'),
          validators: { 'npm-full': { etag: invalid, lastModified: invalid } },
          documentsComplete: true,
          members: (async function* () {})(),
        }),
      });
      const finalize = vi.fn(async () => ({
        status: 'complete' as const,
        empty: false,
        validatorsPublished: 1,
      }));
      Object.assign(h.deps.apply, { finalizer: { finalize } });
      vi.mocked(applyChunk).mockImplementation(async (ctx, deps, input) => {
        await deps.finalizer.finalize(
          ctx,
          input.session,
          {
            expectedCount: 0,
            attemptedCandidates: 0,
            successfulCandidates: 0,
            definitiveAbsent: 0,
            upstreamComplete: true,
            validatorTtlSeconds: 300,
          },
          input.guard,
        );
        return { ...h.outcome, status: 'complete', done: true };
      });
      expect(await h.ensure()).toEqual({ kind: 'filled' });
      expect(h.sessions.setPendingValidators).toHaveBeenCalledWith(
        { orgId: actor.orgId },
        expect.anything(),
        { 'npm-packument': { etag: null, lastModified: null, contentSha256: null } },
      );
      expect(finalize).toHaveBeenCalledTimes(1);
    },
  );
});

describe('T430n review round 3', () => {
  it('lets each coalesced project cache its own definitive upstream 404', async () => {
    const h = setup();
    const other = { ...actor, projectId: 'other' };
    const otherOutcome = { ...admitted, projectId: other.projectId };
    h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true } as never);
    expect(await Promise.all([h.ensure(), h.ensure(otherOutcome, 'npm', other)])).toEqual([
      { kind: 'not_found' },
      { kind: 'not_found' },
    ]);
    expect(h.cache.set).toHaveBeenCalledTimes(2);
    expect(await h.ensure()).toEqual({ kind: 'not_found' });
    expect(await h.ensure(otherOutcome, 'npm', other)).toEqual({ kind: 'not_found' });
    expect(h.describePackage).toHaveBeenCalledTimes(1);
  });

  it('leaves no flight markers behind after many distinct definitive 404s', async () => {
    const h = setup();
    h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true } as never);
    for (let index = 0; index < 25; index++)
      await h.service.ensure(actor, {
        ecosystem: 'npm',
        key: `name-${index}`,
        outcome: { ...admitted, key: `name-${index}` },
      });
    expect(h.describePackage).toHaveBeenCalledTimes(25);
    expect(markers(h.service)).toBe(0);
  });

  it.each(['credential_unavailable', 'config_invalid', 'provider_unavailable'] as const)(
    'answers an unbindable source (%s) as busy for a minute and caches nothing',
    async (reason) => {
      const h = setup();
      vi.mocked(h.deps.planFill).mockRejectedValue(new SourceUnavailableError(reason));
      expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 60 });
      expect(h.cache.set).not.toHaveBeenCalled();
      expect(markers(h.service)).toBe(0);
    },
  );

  it('never caches a missing plan for a coalesced joiner', async () => {
    const h = setup();
    const other = { ...actor, projectId: 'other' };
    vi.mocked(h.deps.planFill).mockResolvedValue(null);
    expect(
      await Promise.all([
        h.ensure(),
        h.ensure({ ...admitted, projectId: other.projectId }, 'npm', other),
      ]),
    ).toEqual([{ kind: 'not_found' }, { kind: 'not_found' }]);
    expect(h.cache.set).not.toHaveBeenCalled();
  });

  it('does not trust a cached 404 stored for a source the caller is no longer admitted to', async () => {
    const h = setup();
    h.describePackage.mockResolvedValueOnce({ kind: 'not_found', definitive: true });
    expect(await h.ensure()).toEqual({ kind: 'not_found' });
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue({ ...admitted, sourceIds: ['B'] });
    expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
  });

  it('does not store a negative entry once the fill was aborted during revalidation', async () => {
    const h = setup();
    const controller = new AbortController();
    let describing = false;
    h.describePackage.mockImplementation(async () => {
      describing = true;
      return { kind: 'not_found', definitive: true };
    });
    vi.mocked(h.deps.visibility.resolve).mockImplementation(async () => {
      if (describing) controller.abort(new Error('caller gone'));
      return admitted;
    });
    expect(
      await h.service.ensure(actor, {
        ecosystem: 'npm',
        key: 'name',
        outcome: admitted,
        signal: controller.signal,
      }),
    ).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.cache.set).not.toHaveBeenCalled();
  });
});
type Inspectable = ReturnType<typeof setup>['service'] & { pendingFlightMarkers(): number };
const markers = (service: unknown) => (service as Inspectable).pendingFlightMarkers();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};

describe('T430n review round 4', () => {
  it('leaves no marker when the caller aborts during the negative cache write', async () => {
    const h = setup();
    const controller = new AbortController();
    const write = deferred<'stored'>();
    h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true } as never);
    vi.mocked(h.cache.set).mockImplementation(async () => {
      controller.abort(new Error('caller gone'));
      return write.promise;
    });
    expect(
      await h.service.ensure(actor, {
        ecosystem: 'npm',
        key: 'name',
        outcome: admitted,
        signal: controller.signal,
      }),
    ).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    write.resolve('stored');
    await flush();
    expect(markers(h.service)).toBe(0);
  });

  it('does not let a detached earlier fill mark a later flight', async () => {
    const h = setup();
    const other = { ...actor, projectId: 'other' };
    const otherOutcome = { ...admitted, projectId: other.projectId };
    const first = new AbortController();
    const firstDescribe = deferred<{ kind: 'not_found'; definitive: true }>();
    h.describePackage.mockImplementationOnce(() => firstDescribe.promise);
    const firstResult = h.service.ensure(actor, {
      ecosystem: 'npm',
      key: 'name',
      outcome: admitted,
      signal: first.signal,
    });
    await flush();
    first.abort(new Error('caller gone'));
    expect(await firstResult).toEqual({ kind: 'busy', retryAfterSeconds: 10 });

    const plan = deferred<null>();
    vi.mocked(h.deps.planFill).mockImplementationOnce(() => plan.promise);
    const second = h.ensure();
    const joiner = h.ensure(otherOutcome, 'npm', other);
    await flush();
    firstDescribe.resolve({ kind: 'not_found', definitive: true });
    await flush();
    plan.resolve(null);
    expect(await Promise.all([second, joiner])).toEqual([
      { kind: 'not_found' },
      { kind: 'not_found' },
    ]);
    expect(
      vi.mocked(h.cache.set).mock.calls.filter(([, key]) => key.projectId === 'other'),
    ).toHaveLength(0);
    expect(markers(h.service)).toBe(0);
  });

  it.each(['error', 'abort'] as const)('evicts markers when a joiner ends by %s', async (mode) => {
    const h = setup();
    const other = { ...actor, projectId: 'other' };
    const otherOutcome = { ...admitted, projectId: other.projectId };
    const gone = new AbortController();
    if (mode === 'error') h.describePackage.mockRejectedValue(new UpstreamError('network'));
    else h.describePackage.mockResolvedValue({ kind: 'not_found', definitive: true } as never);
    const results = await Promise.all([
      h.ensure(),
      h.service.ensure(other, {
        ecosystem: 'npm',
        key: 'name',
        outcome: otherOutcome,
        signal: gone.signal,
      }),
      Promise.resolve().then(() => gone.abort(new Error('joiner gone'))),
    ]);
    expect(results[0]).toEqual(
      mode === 'error' ? { kind: 'upstream_error' } : { kind: 'not_found' },
    );
    await flush();
    expect(markers(h.service)).toBe(0);
  });

  it('keeps joiner negatives out of the cache after an epoch bump past the upstream observation', async () => {
    const h = setup();
    let epoch = 'old';
    const rawSet = vi.fn(async () => {});
    const cache = createScopedCache(
      { get: async () => null, set: rawSet, delete: async () => {} },
      { read: async () => epoch },
      { deploymentId: 'test' },
    );
    const service = createOnDemandFill({ ...h.deps, cache });
    const coalescer = vi.mocked(createCoalescer).mock.results.at(-1)!.value;
    const run = vi.spyOn(coalescer, 'run');
    const other = { ...actor, projectId: 'other' };
    const describing = deferred<{ kind: 'not_found'; definitive: true }>();
    h.describePackage.mockImplementation(() => describing.promise);
    const leader = service.ensure(actor, { ecosystem: 'npm', key: 'name', outcome: admitted });
    await vi.waitFor(() => expect(h.describePackage).toHaveBeenCalled(), { timeout: 5000 });
    epoch = 'new';
    const joiner = service.ensure(other, {
      ecosystem: 'npm',
      key: 'name',
      outcome: { ...admitted, projectId: other.projectId },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2), { timeout: 5000 });
    describing.resolve({ kind: 'not_found', definitive: true });
    await Promise.all([leader, joiner]);
    expect(h.describePackage).toHaveBeenCalledTimes(1);
    expect(rawSet).not.toHaveBeenCalled();
  });
});

describe('T430n final review hardening', () => {
  const keepRecordAlive = (h: ReturnType<typeof setup>) => {
    const metadata = deferred<{ type: 'npmjs_proxy' }>();
    vi.mocked(h.deps.sourceMetadata).mockImplementationOnce(() => metadata.promise);
    const holder = h.ensure(visible(), 'npm', { ...actor, projectId: 'holder' });
    return { holder, release: () => metadata.resolve({ type: 'npmjs_proxy' }) };
  };

  it('does not let a lease-lost fill mark the record of a later fill', async () => {
    vi.useFakeTimers();
    const h = setup();
    const { holder, release } = keepRecordAlive(h);
    const write = deferred<'stored'>();
    vi.mocked(h.cache.set).mockImplementation(() => write.promise);
    h.describePackage.mockResolvedValueOnce({ kind: 'not_found', definitive: true } as never);
    vi.mocked(h.sessions.latest).mockResolvedValue({
      id: 'session',
      state: 'running',
      generation: 1,
      fence: 2,
      seenCount: 0,
      pagesSoFar: 0,
    });
    const first = h.ensure();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await first).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.cache.set).toHaveBeenCalledTimes(1);

    vi.mocked(h.sessions.latest).mockResolvedValue({
      id: 'session',
      state: 'running',
      generation: 1,
      fence: 1,
      seenCount: 0,
      pagesSoFar: 0,
    });
    vi.mocked(h.deps.planFill).mockResolvedValueOnce(null);
    const second = h.ensure();
    await flush();
    write.resolve('stored');
    await flush();
    expect(await second).toEqual({ kind: 'not_found' });
    expect(h.cache.set).toHaveBeenCalledTimes(1);
    release();
    await holder;
    expect(markers(h.service)).toBe(0);
  });

  it('does not let an aborted fill mark the record while another caller waits on the lease', async () => {
    vi.useFakeTimers();
    const h = setup();
    const { holder, release } = keepRecordAlive(h);
    const write = deferred<'stored'>();
    vi.mocked(h.cache.set).mockImplementation(() => write.promise);
    h.describePackage.mockResolvedValueOnce({ kind: 'not_found', definitive: true } as never);
    const caller = new AbortController();
    const first = h.service.ensure(actor, {
      ecosystem: 'npm',
      key: 'name',
      outcome: admitted,
      signal: caller.signal,
    });
    await flush();
    expect(h.cache.set).toHaveBeenCalledTimes(1);
    caller.abort(new Error('caller gone'));
    expect(await first).toEqual({ kind: 'busy', retryAfterSeconds: 10 });

    h.sessions.acquire.mockResolvedValueOnce('held' as never);
    const negative = {
      hit: {
        entry: {
          ...defaultEntry('negative', new Uint8Array(), new Date()),
          insertedAt: new Date().toISOString(),
        },
        state: 'fresh' as const,
      },
      version: 'epoch',
    };
    const miss = { hit: null, version: 'epoch' };
    vi.mocked(h.cache.get)
      .mockResolvedValueOnce(miss)
      .mockResolvedValueOnce(negative)
      .mockResolvedValueOnce(miss);
    const waiter = h.ensure();
    await vi.advanceTimersByTimeAsync(100);
    write.resolve('stored');
    await vi.advanceTimersByTimeAsync(300);
    expect(await waiter).toEqual({ kind: 'not_found' });
    expect(h.cache.set).toHaveBeenCalledTimes(1);
    release();
    await holder;
    expect(markers(h.service)).toBe(0);
  });

  it('forgets a shared absence when a later fill reuses the record', async () => {
    const h = setup();
    const { holder, release } = keepRecordAlive(h);
    vi.mocked(h.cache.set).mockImplementation(async () => 'stored' as const);
    h.describePackage.mockResolvedValueOnce({ kind: 'not_found', definitive: true } as never);
    expect(await h.ensure()).toEqual({ kind: 'not_found' });
    const writes = vi.mocked(h.cache.set).mock.calls.length;
    expect(writes).toBeGreaterThan(0);

    vi.mocked(h.deps.planFill).mockResolvedValueOnce(null);
    expect(await h.ensure()).toEqual({ kind: 'not_found' });
    expect(h.cache.set).toHaveBeenCalledTimes(writes);
    release();
    await holder;
    expect(markers(h.service)).toBe(0);
  });
});

describe('T430n review round 4 ordering', () => {
  it('writes joiner negatives with the leader observation version, not a later one', async () => {
    const h = setup();
    let epoch = 'old';
    const rawSet = vi.fn(async () => {
      epoch = 'new';
    });
    const cache = createScopedCache(
      { get: async () => null, set: rawSet, delete: async () => {} },
      { read: async () => epoch },
      { deploymentId: 'test' },
    );
    const service = createOnDemandFill({ ...h.deps, cache });
    const coalescer = vi.mocked(createCoalescer).mock.results.at(-1)!.value;
    const run = vi.spyOn(coalescer, 'run');
    const other = { ...actor, projectId: 'other' };
    const describing = deferred<{ kind: 'not_found'; definitive: true }>();
    h.describePackage.mockImplementation(() => describing.promise);
    const leader = service.ensure(actor, { ecosystem: 'npm', key: 'name', outcome: admitted });
    await vi.waitFor(() => expect(h.describePackage).toHaveBeenCalled(), { timeout: 5000 });
    const joiner = service.ensure(other, {
      ecosystem: 'npm',
      key: 'name',
      outcome: { ...admitted, projectId: other.projectId },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2), { timeout: 5000 });
    describing.resolve({ kind: 'not_found', definitive: true });
    expect(await Promise.all([leader, joiner])).toEqual([
      { kind: 'not_found' },
      { kind: 'not_found' },
    ]);
    expect(h.describePackage).toHaveBeenCalledTimes(1);
    expect(rawSet).toHaveBeenCalledTimes(1);
  });
});

describe('fix round 3 regressions', () => {
  it.each([
    new ComposerV2Error('http_status', 401),
    new ComposerV2Error('http_status', 403),
    new ComposerV2Error('http_status', 503),
    new ComposerV2Error('network'),
    new ComposerV1PackageError('status', 503),
  ])(
    'maps native Composer describe failure %s to upstream_error for every joiner',
    async (error) => {
      const h = setup();
      h.describePackage.mockRejectedValue(error);
      expect(await Promise.all(Array.from({ length: 20 }, () => h.ensure()))).toEqual(
        Array.from({ length: 20 }, () => ({ kind: 'upstream_error' })),
      );
      expect(h.describePackage).toHaveBeenCalledTimes(1);
      expect(h.deps.planFill).toHaveBeenCalledExactlyOnceWith({ orgId: actor.orgId }, 'A', 'name');
      expect(h.cache.set).not.toHaveBeenCalled();
    },
  );
  it('maps a native Composer member failure to upstream_error', async () => {
    const h = setup();
    vi.mocked(applyChunk).mockRejectedValue(new ComposerV2Error('network'));
    expect(await h.ensure()).toEqual({ kind: 'upstream_error' });
    expect(h.cache.set).not.toHaveBeenCalled();
  });
  it('ignores a cached 404 when a visible incomplete package can be taken over', async () => {
    const h = setup();
    h.describePackage.mockResolvedValueOnce({ kind: 'not_found', definitive: true });
    expect(await h.ensure()).toEqual({ kind: 'not_found' });
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(false));
    expect(await h.ensure(visible(false))).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(applyChunk).toHaveBeenCalledTimes(1);
    expect(h.deps.enqueueSync).toHaveBeenCalledTimes(1);
    expect(h.cache.set).toHaveBeenCalledTimes(1);
  });
  it('ignores a cached 404 while polling an incomplete listing until it completes', async () => {
    vi.useFakeTimers();
    const h = setup();
    const outcome = { ...admitted, ecosystem: 'composer' } as const;
    h.describePackage.mockResolvedValueOnce({ kind: 'not_found', definitive: true });
    expect(await h.ensure(outcome, 'composer')).toEqual({ kind: 'not_found' });
    h.sessions.acquire.mockResolvedValue('held' as never);
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(false, 'composer'));
    let result: Awaited<ReturnType<typeof h.ensure>> | undefined;
    const pending = h.ensure(visible(false, 'composer'), 'composer').then((value) => {
      result = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBeUndefined();
    vi.mocked(h.deps.visibility.resolve).mockResolvedValue(visible(true, 'composer'));
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ kind: 'filled' });
    expect(h.describePackage).toHaveBeenCalledTimes(1);
  });
  it('includes pre-coalescing cache latency in the Composer deadline', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.sessions.acquire.mockResolvedValue('held' as never);
    vi.mocked(h.cache.get).mockImplementationOnce(
      () =>
        new Promise((resolve) => setTimeout(() => resolve({ hit: null, version: 'epoch' }), 1000)),
    );
    let result: Awaited<ReturnType<typeof h.ensure>> | undefined;
    void h.ensure({ ...admitted, ecosystem: 'composer' }, 'composer').then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.describePackage).not.toHaveBeenCalled();
  });
  it('persists snapshot validators before releasing a progress continuation', async () => {
    const h = setup();
    const validators = {
      'npm-full': { etag: '"first"', lastModified: 'Wed, 01 Oct 2025 00:00:00 GMT' },
    };
    h.describePackage.mockResolvedValue({
      kind: 'found',
      description: createPackageDescription({
        name: 'name',
        snapshot: snapshotRef('"snapshot"'),
        validators,
        documentsComplete: true,
        members: (async function* () {})(),
      }),
    });
    expect(await h.ensure()).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.sessions.setPendingValidators).toHaveBeenCalledExactlyOnceWith(
      { orgId: actor.orgId },
      h.outcome.session,
      { 'npm-packument': { ...validators['npm-full'], contentSha256: null } },
    );
    expect(h.sessions.setPendingValidators.mock.invocationCallOrder[0]).toBeLessThan(
      h.sessions.release.mock.invocationCallOrder[0]!,
    );
  });
  it('carries persisted validators into a resumed staged description and finalization', async () => {
    const h = setup();
    const pendingValidators = {
      'npm-packument': { etag: '"first"', lastModified: null, contentSha256: null },
    };
    h.sessions.acquire.mockImplementation(async (_ctx, _scope, owner) => ({
      ...handle,
      owner,
      stamp: 'stamp',
      snapshotId: '"snapshot"',
      snapshotBlobSha256: 'a'.repeat(64),
      pendingValidators,
    }));
    const finalize = vi.fn(async () => ({
      status: 'complete' as const,
      empty: false,
      validatorsPublished: 1,
    }));
    Object.assign(h.deps.apply, { finalizer: { finalize } });
    vi.mocked(applyChunk).mockImplementation(async (ctx, deps, input) => {
      await deps.finalizer.finalize(
        ctx,
        input.session,
        {
          expectedCount: 0,
          attemptedCandidates: 0,
          successfulCandidates: 0,
          definitiveAbsent: 0,
          upstreamComplete: true,
          validatorTtlSeconds: 300,
        },
        input.guard,
      );
      return { ...h.outcome, status: 'complete', done: true };
    });
    expect(await h.ensure()).toEqual({ kind: 'filled' });
    expect(h.describePackage).toHaveBeenCalledWith(
      {
        snapshot: {
          ...snapshotRef('"snapshot"', parseSha256('a'.repeat(64))),
          validators: { etag: '"first"' },
        },
      },
      expect.any(AbortSignal),
    );
    expect(h.sessions.setPendingValidators).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      expect.anything(),
      pendingValidators,
    );
  });
});

describe('Composer fill that ends incomplete', () => {
  const composer = { ...admitted, ecosystem: 'composer' } as const;

  it('answers busy at once instead of holding the full request budget', async () => {
    vi.useFakeTimers();
    const h = setup();
    vi.mocked(applyChunk).mockResolvedValue({ ...h.outcome, done: true, status: 'incomplete' });
    let result: Awaited<ReturnType<typeof h.ensure>> | undefined;
    const pending = h.ensure(composer, 'composer').then((value) => {
      result = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(result).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fetch upstream again inside the Retry-After window, then fetches once it passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    const h = setup();
    vi.mocked(applyChunk).mockResolvedValue({ ...h.outcome, done: true, status: 'incomplete' });
    expect(await h.ensure(composer, 'composer')).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    await vi.advanceTimersByTimeAsync(9000);
    expect(await h.ensure(composer, 'composer')).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(h.describePackage).toHaveBeenCalledTimes(1);
    expect(applyChunk).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    await h.ensure(composer, 'composer');
    expect(h.describePackage).toHaveBeenCalledTimes(2);
  });

  it('answers every concurrent caller busy at once with one upstream fetch', async () => {
    vi.useFakeTimers();
    const h = setup();
    vi.mocked(applyChunk).mockResolvedValue({ ...h.outcome, done: true, status: 'incomplete' });
    const calls = Promise.all([1, 2, 3].map(() => h.ensure(composer, 'composer')));
    await vi.advanceTimersByTimeAsync(250);
    expect(await calls).toEqual(Array(3).fill({ kind: 'busy', retryAfterSeconds: 10 }));
    expect(h.describePackage).toHaveBeenCalledTimes(1);
  });

  it('does not store the incomplete document as an empty listing or a negative', async () => {
    vi.useFakeTimers();
    const h = setup();
    vi.mocked(applyChunk).mockResolvedValue({ ...h.outcome, done: true, status: 'incomplete' });
    await h.ensure(composer, 'composer');
    expect(h.cache.set).not.toHaveBeenCalled();
    expect(h.deps.enqueueSync).not.toHaveBeenCalled();
  });

  it('keeps a cached negative answering 404 while the incomplete marker is live', async () => {
    vi.useFakeTimers();
    const h = setup();
    vi.mocked(applyChunk).mockResolvedValue({ ...h.outcome, done: true, status: 'incomplete' });
    expect(await h.ensure(composer, 'composer')).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    await h.cache.set(
      { orgId: actor.orgId },
      catalogueNegativeKey('project', 'A', 'composer', 'name'),
      defaultEntry('negative', new Uint8Array(), new Date()),
      { expectedVersion: 'epoch', origin: { status: 404, authenticated: true, authorized: true } },
    );
    expect(await h.ensure(composer, 'composer')).toEqual({ kind: 'not_found' });
    expect(h.describePackage).toHaveBeenCalledTimes(1);
  });

  it('answers a real ~dev.json that omits the package key with an immediate 503 and no refetch', async () => {
    vi.useFakeTimers();
    const h = setup();
    const ORIGIN = 'https://repo.example.com';
    const requested: string[] = [];
    const fetch = createPolicyFetch({
      policy: createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
      userAgent: 'pb-test/1',
      fetchImpl: async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        requested.push(url);
        const body = url.endsWith('~dev.json')
          ? JSON.stringify({ minified: 'composer/2.0', packages: {} })
          : JSON.stringify({
              minified: 'composer/2.0',
              packages: {
                'acme/widget': [
                  {
                    name: 'acme/widget',
                    version: '1.0.0',
                    dist: { type: 'zip', url: 'https://dl.example.com/w.zip', reference: 'abc' },
                  },
                ],
              },
            });
        return new Response(body, {
          status: 200,
          headers: { etag: `"${url}"`, 'content-type': 'application/json' },
        });
      },
    });
    const root: ComposerRoot = {
      mode: 'v2',
      packagesJsonUrl: `${ORIGIN}/packages.json`,
      metadataUrl: `${ORIGIN}/p2/%package%.json`,
      inlineProviders: false,
      partialPackages: false,
      inlinePackages: false,
      validator: { sha256: 'a'.repeat(64) },
      messages: [],
      mirrors: [],
    };
    h.plan.describe.mockImplementation(
      async (_options, signal) =>
        (await describeComposerV2(fetch, { root, allowedOrigins: [] }, 'acme/widget', {
          path: 'request',
          probe: { secrets: [], queryParams: [] },
          clock: systemClock,
          dev: true,
          signal,
        } as never)) as never,
    );
    const actual =
      await vi.importActual<typeof import('./apply-description.js')>('./apply-description.js');
    const writer = {
      async publishVersion() {
        throw new Error('not_implemented');
      },

      statementBudget: {
        publishVersion: 40,
        syncPackage: 500,
        attachDist: 4,
        openListing: 3,
        markListing: 5,
        finalizeListing: 13,
        quarantine: 5,
        markPackageAbsent: 8,
      },
      syncPackageCost: () => 1,
      syncPayloadLimit: 4 * 1024 * 1024,
      syncPayloadBytes: () => 1,
      syncPackage: async () => ({
        packageId: 'pkg',
        inserted: 0,
        updated: 0,
        unchanged: 0,
        conflicts: [],
        refused: [],
        skippedTags: [],
        statements: 1,
      }),
      openListing: async () => ({ stamp: '2026-10-20T10:00:00.000Z' }),
      markListing: async () => ({ changed: true, marked: 0, statements: 1 }),
    } as unknown as CatalogueWriter;
    Object.assign(h.deps.apply, {
      writer,
      existing: { existingVersions: async () => ({ rows: [], next: null }) },
      finalizer: { finalize: vi.fn() },
    });
    (h.sessions.advance as ReturnType<typeof vi.fn>).mockImplementation(
      async (_ctx: unknown, held: { seenCount: number }, input: { addSeen: number }) => ({
        seenCount: held.seenCount + input.addSeen,
        pagesSoFar: 1,
      }),
    );
    vi.mocked(applyChunk).mockImplementation(actual.applyChunk);

    let result: Awaited<ReturnType<typeof h.ensure>> | undefined;
    const pending = h.ensure(composer, 'composer').then((value) => (result = value));
    const startedAt = Date.now();
    await vi.waitFor(() => expect(result).toBeDefined(), { interval: 1 });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    await pending;
    const fetched = requested.length;
    expect(fetched).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await h.ensure(composer, 'composer')).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(requested).toHaveLength(fetched);
    expect(h.cache.set).not.toHaveBeenCalled();
    expect(h.deps.apply.finalizer.finalize).not.toHaveBeenCalled();
  });
});

it.each(['npm', 'composer'] as const)(
  'preserves a refusal for every coalesced %s caller',
  async (ecosystem) => {
    const h = setup();
    h.describePackage.mockRejectedValue(new UpstreamError('refused', undefined, 'destination'));
    const outcome = { ...admitted, ecosystem } as PackageVisibility;
    expect(
      await Promise.all(Array.from({ length: 5 }, () => h.ensure(outcome, ecosystem))),
    ).toEqual(Array.from({ length: 5 }, () => ({ kind: 'upstream_refused' })));
    expect(h.describePackage).toHaveBeenCalledTimes(1);
    expect(h.cache.set).not.toHaveBeenCalled();
  },
);

it('preserves a policy refusal from the Composer member iterator', async () => {
  const h = setup();
  vi.mocked(applyChunk).mockRejectedValue(new UpstreamError('refused', undefined, 'destination'));
  expect(
    await h.ensure({ ...admitted, ecosystem: 'composer' } as PackageVisibility, 'composer'),
  ).toEqual({ kind: 'upstream_refused' });
  expect(h.cache.set).not.toHaveBeenCalled();
});

it('preserves a policy refusal translated by Composer metadata parsing', async () => {
  const h = setup();
  h.describePackage.mockRejectedValue(new ComposerV2Error('refused'));
  expect(
    await h.ensure({ ...admitted, ecosystem: 'composer' } as PackageVisibility, 'composer'),
  ).toEqual({ kind: 'upstream_refused' });
  expect(h.cache.set).not.toHaveBeenCalled();
});
