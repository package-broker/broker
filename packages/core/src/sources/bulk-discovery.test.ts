import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ActorContext } from '../authz/administration.js';
import { mutationFence, type AuthenticatedActor } from '../authz/fence.js';
import { DbError } from '../db/errors.js';
import { orgContext, type OrgContext } from '../db/port.js';
import type { DiscoveryCandidate, PlanEntry, SkipReason } from '../plugin.js';
import {
  createBulkDiscovery,
  type BulkDiscoveryDeps,
  type DiscoveryCredential,
} from './bulk-discovery.js';
import { UpstreamError } from './policy-fetch.js';
import type { SourceService, SourceServiceResult } from './source-service.js';

const ctx = orgContext('org-a');
const fence = mutationFence({ userId: 'user', sessionId: 'session' } as AuthenticatedActor, {});
const admin: ActorContext = {
  kind: 'organization',
  userId: 'user',
  isOrganizationAdmin: true,
  permissions: new Set(['org:sources:write']),
} as ActorContext;
const reader: ActorContext = {
  ...admin,
  isOrganizationAdmin: false,
  permissions: new Set(['org:sources:read']),
} as ActorContext;

const ok = <T>(value: T): SourceServiceResult<T> => ({ ok: true, value });

function setup(options: { names?: string[]; sourceNames?: string[]; failEnable?: boolean } = {}) {
  const calls: string[] = [];
  const sources = new Map<
    string,
    { id: string; credentialId: string; repository: string; status: string; names: string[] }
  >();
  const takenNames = new Set(options.names ?? []);
  const service: Pick<SourceService, 'create' | 'addRegisteredName' | 'enable' | 'delete'> = {
    create: vi.fn(async (_c, _a, _f, input) => {
      if (input.credentialId == null) return { ok: false, error: 'invalid_config' } as const;
      const config = JSON.parse(input.configJson) as { repository: string };
      const id = `src-${sources.size + 1}`;
      calls.push(`create:${config.repository}`);
      sources.set(id, {
        id,
        credentialId: input.credentialId,
        repository: config.repository,
        status: 'paused',
        names: [],
      });
      return ok({ id });
    }),
    addRegisteredName: vi.fn(async (_c, _a, _f, input) => {
      calls.push(`name:${input.pattern}`);
      if (takenNames.has(input.pattern)) return { ok: false, error: 'pattern_taken' } as const;
      takenNames.add(input.pattern);
      sources.get(input.sourceId)?.names.push(input.pattern);
      return ok({ id: `name-${input.pattern}` });
    }),
    enable: vi.fn(async (_c, _a, _f, id) => {
      calls.push(`enable:${id}`);
      if (options.failEnable === true) return { ok: false, error: 'conflict' } as const;
      const source = sources.get(id);
      if (source === undefined || source.names.length === 0) {
        return { ok: false, error: 'activation_requires_registered_names' } as const;
      }
      source.status = 'active';
      return ok(null);
    }),
    delete: vi.fn(async (_c, _a, _f, id) => {
      calls.push(`delete:${id}`);
      sources.delete(id);
      return ok(null);
    }),
  };
  const planFor = (candidate: DiscoveryCandidate): PlanEntry => ({
    repository: candidate.repository,
    ecosystem: 'composer',
    packageName: candidate.packageName,
    action: 'new',
    reason: null,
  });
  const exists = async (repository: string) =>
    [...sources.values()].some((source) => source.repository === repository);
  const resolve = vi.fn(async (): Promise<DiscoveryCredential | null> => ({
    credentialId: 'app-credential',
    installationId: 7,
    upstream: {} as never,
  }));
  const discover = vi.fn(async (_c, _cred, request) => {
    const entries: PlanEntry[] = [];
    for (const repository of ['acme/one', 'acme/two']) {
      const candidate = {
        repository,
        ecosystem: 'composer' as const,
        packageName: repository,
      };
      entries.push({
        ...planFor(candidate),
        action: (await request.exists(candidate)) ? 'existing' : 'new',
      });
    }
    return { entries, nextCursor: '2' };
  });
  const plan = vi.fn(async (_c, _cred, repository: string, existing) => {
    const candidate = { repository, ecosystem: 'composer' as const, packageName: repository };
    const entry = planFor(candidate);
    return (await existing(candidate)) ? { ...entry, action: 'existing' as const } : entry;
  });
  const hasSourceName = vi.fn(async (_ctx: OrgContext, name: string) =>
    (options.sourceNames ?? []).includes(name),
  );
  const deps: BulkDiscoveryDeps = {
    credentials: { resolve },
    discovery: { discover, plan },
    sources: service,
    existingRepository: { has: (_c, repository) => exists(repository), hasSourceName },
  };
  return {
    bulk: createBulkDiscovery(deps),
    calls,
    sources,
    resolve,
    discover,
    plan,
    service,
    hasSourceName,
  };
}

describe('bulk discovery', () => {
  it('links every created source to the resolved App credential', async () => {
    const { bulk, sources, resolve, service } = setup();
    expect(
      await bulk.apply(ctx, admin, fence, {
        credentialId: 'requested-credential',
        repositories: ['acme/one', 'acme/two'],
      }),
    ).toMatchObject({ ok: true, value: { created: 2, failed: 0 } });
    expect(resolve).toHaveBeenCalledWith(ctx, 'requested-credential');
    expect([...sources.values()].map((source) => source.credentialId)).toEqual([
      'app-credential',
      'app-credential',
    ]);
    for (const call of vi.mocked(service.create).mock.calls) {
      expect(call[3].credentialId).toBe('app-credential');
    }
  });

  it('refuses the whole apply before planning or creating when no credential resolves', async () => {
    const { bulk, resolve, plan, service, sources } = setup();
    resolve.mockResolvedValueOnce(null);
    expect(
      await bulk.apply(ctx, admin, fence, {
        credentialId: 'missing',
        repositories: ['acme/one', 'acme/two'],
      }),
    ).toEqual({ ok: false, error: 'credential_not_found' });
    expect(plan).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
    expect(sources.size).toBe(0);
  });

  it('refuses a non-admin before resolving the credential or calling the provider', async () => {
    const { bulk, resolve, discover, plan } = setup();
    expect(
      await bulk.dryRun(ctx, reader, { credentialId: 'c', pattern: 'acme-*', cursor: null }),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(
      await bulk.apply(ctx, reader, fence, { credentialId: 'c', repositories: ['acme/one'] }),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(resolve).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
  });

  it('dry run marks repositories that already back a source as existing', async () => {
    const { bulk } = setup();
    await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: ['acme/one'] });
    const result = await bulk.dryRun(ctx, admin, { credentialId: 'c', pattern: '*', cursor: null });
    expect(result).toMatchObject({
      ok: true,
      value: {
        nextCursor: '2',
        entries: [
          { repository: 'acme/one', action: 'existing' },
          { repository: 'acme/two', action: 'new' },
        ],
      },
    });
  });

  it('creates each source once when the same set is applied twice', async () => {
    const { bulk, sources } = setup();
    const input = { credentialId: 'c', repositories: ['acme/one', 'acme/two'] };
    const first = await bulk.apply(ctx, admin, fence, input);
    const second = await bulk.apply(ctx, admin, fence, input);
    expect(first).toMatchObject({
      ok: true,
      value: { created: 2, existing: 0, skipped: 0, failed: 0 },
    });
    expect(second).toMatchObject({
      ok: true,
      value: { created: 0, existing: 2, skipped: 0, failed: 0 },
    });
    expect(sources.size).toBe(2);
    expect([...sources.values()].every((source) => source.status === 'active')).toBe(true);
  });

  it('registers the exact package name between create and enable', async () => {
    const { bulk, calls } = setup();
    await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: ['acme/one'] });
    expect(calls).toEqual(['create:acme/one', 'name:acme/one', 'enable:src-1']);
  });

  it('treats a package name collision as existing and removes the paused source', async () => {
    const { bulk, calls, sources } = setup({ names: ['acme/one'] });
    const result = await bulk.apply(ctx, admin, fence, {
      credentialId: 'c',
      repositories: ['acme/one'],
    });
    expect(result).toMatchObject({ ok: true, value: { created: 0, existing: 1, failed: 0 } });
    expect(calls).not.toContain('enable:src-1');
    expect(calls).toContain('delete:src-1');
    expect(sources.size).toBe(0);
  });

  it('counts a failed enable and leaves the source paused', async () => {
    const { bulk, sources } = setup({ failEnable: true });
    const result = await bulk.apply(ctx, admin, fence, {
      credentialId: 'c',
      repositories: ['acme/one'],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        created: 0,
        failed: 1,
        results: [{ repository: 'acme/one', outcome: 'failed', error: 'conflict' }],
      },
    });
    expect([...sources.values()][0]?.status).toBe('paused');
  });

  it('skips entries the recomputed plan does not mark as new', async () => {
    const { bulk, plan, calls } = setup();
    plan.mockResolvedValueOnce({
      repository: 'acme/one',
      ecosystem: 'npm',
      packageName: 'one',
      action: 'skipped',
      reason: 'npm_from_vcs_unsupported',
    });
    const result = await bulk.apply(ctx, admin, fence, {
      credentialId: 'c',
      repositories: ['acme/one'],
    });
    expect(result).toMatchObject({ ok: true, value: { created: 0, skipped: 1 } });
    expect(calls).toEqual([]);
  });

  it('skips a new npm entry with its reason and performs no writes', async () => {
    const { bulk, plan, service } = setup();
    plan.mockResolvedValueOnce({
      repository: 'acme/one',
      ecosystem: 'npm',
      packageName: 'one',
      action: 'new',
      reason: 'npm_from_vcs_unsupported',
    });
    expect(
      await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: ['acme/one'] }),
    ).toMatchObject({
      ok: true,
      value: {
        created: 0,
        skipped: 1,
        results: [
          { repository: 'acme/one', outcome: 'skipped', reason: 'npm_from_vcs_unsupported' },
        ],
      },
    });
    expect(service.create).not.toHaveBeenCalled();
  });

  it('reports an orphaned paused source when cleanup fails after a name collision', async () => {
    const { bulk, service, sources } = setup({ names: ['acme/one'] });
    vi.mocked(service.delete).mockResolvedValueOnce({ ok: false, error: 'conflict' });
    expect(
      await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: ['acme/one'] }),
    ).toMatchObject({
      ok: true,
      value: {
        existing: 0,
        failed: 1,
        results: [{ outcome: 'failed', error: 'orphaned_paused_source' }],
      },
    });
    expect([...sources.values()][0]?.status).toBe('paused');
    expect(service.enable).not.toHaveBeenCalled();
  });

  it.each(['duplicate', 'invalid_config', 'forbidden'] as const)(
    'counts create failure %s as failed',
    async (error) => {
      const { bulk, service } = setup();
      vi.mocked(service.create).mockResolvedValueOnce({ ok: false, error });
      expect(
        await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: ['acme/one'] }),
      ).toMatchObject({
        ok: true,
        value: { created: 0, existing: 0, failed: 1, results: [{ outcome: 'failed', error }] },
      });
      expect(service.addRegisteredName).not.toHaveBeenCalled();
      expect(service.enable).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'classifies a create duplicate with source-name collision %s',
    async (collision) => {
      const { bulk, service, hasSourceName } = setup({
        sourceNames: collision ? ['acme/one'] : [],
      });
      vi.mocked(service.create).mockResolvedValueOnce({ ok: false, error: 'duplicate' });
      const result = await bulk.apply(ctx, admin, fence, {
        credentialId: 'c',
        repositories: ['acme/one'],
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          created: 0,
          existing: collision ? 1 : 0,
          failed: collision ? 0 : 1,
          results: [
            collision
              ? { repository: 'acme/one', outcome: 'existing' }
              : { repository: 'acme/one', outcome: 'failed', error: 'duplicate' },
          ],
        },
      });
      expect(hasSourceName).toHaveBeenCalledWith(ctx, 'acme/one');
      expect(service.addRegisteredName).not.toHaveBeenCalled();
      expect(service.enable).not.toHaveBeenCalled();
      expect(service.delete).not.toHaveBeenCalled();
    },
  );

  it('normalizes the real provider error types for dry run and apply', async () => {
    const discoveryPath = new URL('../../../plugin-github/src/discovery.ts', import.meta.url).href;
    const tokenPath = new URL('../../../plugin-github/src/installation-token.ts', import.meta.url)
      .href;
    const { DiscoveryError } = await import(discoveryPath);
    const { InstallationTokenError } = await import(tokenPath);
    const errors = [
      ...['invalid_request', 'rate_limited', 'upstream_status', 'invalid_response'].map(
        (code) => new DiscoveryError(code),
      ),
      ...[
        'invalid_request',
        'unauthorized',
        'forbidden',
        'not_found',
        'unprocessable',
        'rate_limited',
        'upstream_status',
        'invalid_response',
      ].map((code) => new InstallationTokenError(code)),
      ...(['refused', 'timeout', 'too_large', 'http_status', 'network'] as const).map(
        (code) => new UpstreamError(code, undefined, 'private fetch detail'),
      ),
    ];
    for (const error of errors) {
      error.message = 'private provider detail';
      const { bulk, discover, plan } = setup();
      discover.mockRejectedValueOnce(error);
      expect(
        await bulk.dryRun(ctx, admin, { credentialId: 'c', pattern: '*', cursor: null }),
      ).toEqual({ ok: false, error: error.code });
      plan.mockRejectedValueOnce(error);
      const result = await bulk.apply(ctx, admin, fence, {
        credentialId: 'c',
        repositories: ['acme/one', 'acme/two'],
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          created: error.code === 'rate_limited' ? 0 : 1,
          failed: 1,
          results: expect.arrayContaining([
            { repository: 'acme/one', outcome: 'failed', error: error.code },
          ]),
        },
      });
      expect(JSON.stringify(result)).not.toContain('private');
      expect(plan).toHaveBeenCalledTimes(error.code === 'rate_limited' ? 1 : 2);
    }
  });

  it('resumes a rate-limited batch in order without repeating completed repositories', async () => {
    const { bulk, plan, service } = setup();
    const defaultPlan = plan.getMockImplementation()!;
    plan.mockImplementationOnce(defaultPlan).mockRejectedValueOnce(
      Object.assign(new Error('private detail'), {
        name: 'InstallationTokenError',
        code: 'rate_limited',
      }),
    );
    const first = await bulk.apply(ctx, admin, fence, {
      credentialId: 'c',
      repositories: ['acme/one', 'acme/two', 'acme/three'],
      nextCursor: 'next',
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        created: 1,
        failed: 1,
        remainingRepositories: ['acme/two', 'acme/three'],
        nextCursor: 'next',
      },
    });
    if (!first.ok) throw new Error('apply failed');
    const second = await bulk.apply(ctx, admin, fence, {
      credentialId: 'c',
      repositories: first.value.remainingRepositories,
      nextCursor: first.value.nextCursor,
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        created: 2,
        failed: 0,
        remainingRepositories: [],
        nextCursor: 'next',
      },
    });
    expect(plan.mock.calls.map((call) => call[2])).toEqual([
      'acme/one',
      'acme/two',
      'acme/two',
      'acme/three',
    ]);
    expect(
      vi.mocked(service.create).mock.calls.map((call) => JSON.parse(call[3].configJson).repository),
    ).toEqual(['acme/one', 'acme/two', 'acme/three']);
  });

  it('deletes the paused source and reports a non-collision name failure', async () => {
    const { bulk, service, sources } = setup();
    vi.mocked(service.addRegisteredName).mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    expect(
      await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: ['acme/one'] }),
    ).toMatchObject({
      ok: true,
      value: { existing: 0, failed: 1, results: [{ error: 'forbidden' }] },
    });
    expect(sources.size).toBe(0);
    expect(service.delete).toHaveBeenCalledWith(ctx, { kind: 'org', actor: admin }, fence, 'src-1');
    expect(service.enable).not.toHaveBeenCalled();
  });

  it('refuses a mismatched repository before writing', async () => {
    const { bulk, plan, service } = setup();
    plan.mockResolvedValueOnce({
      repository: 'other/repo',
      ecosystem: 'composer',
      packageName: 'acme/one',
      action: 'existing',
      reason: null,
    });
    expect(
      await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: ['acme/one'] }),
    ).toMatchObject({
      ok: true,
      value: {
        failed: 1,
        existing: 0,
        results: [{ repository: 'acme/one', error: 'repository_mismatch' }],
      },
    });
    expect(service.create).not.toHaveBeenCalled();
  });

  it('accepts repository case differences and writes the requested name', async () => {
    const { bulk, plan, service } = setup();
    plan.mockResolvedValueOnce({
      repository: 'ACME/ONE',
      ecosystem: 'composer',
      packageName: 'acme/one',
      action: 'new',
      reason: null,
    });
    expect(
      await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: ['acme/one'] }),
    ).toMatchObject({ ok: true, value: { created: 1, results: [{ repository: 'acme/one' }] } });
    expect(
      JSON.parse(vi.mocked(service.create).mock.calls[0]?.[3].configJson ?? '{}'),
    ).toMatchObject({ repository: 'acme/one' });
  });

  it.each([
    [
      Object.assign(new Error('private provider detail'), {
        name: 'DiscoveryError',
        code: 'upstream_status',
      }),
      'upstream_status',
    ],
    [new DbError('busy', 'private database detail'), 'busy'],
  ] as const)('records a thrown error code and continues: %s', async (error, code) => {
    const { bulk, plan, service } = setup();
    if (error instanceof DbError) vi.mocked(service.create).mockRejectedValueOnce(error);
    else plan.mockRejectedValueOnce(error);
    expect(
      await bulk.apply(ctx, admin, fence, {
        credentialId: 'c',
        repositories: ['acme/one', 'acme/two'],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        created: 1,
        failed: 1,
        results: [
          { repository: 'acme/one', outcome: 'failed', error: code },
          { repository: 'acme/two', outcome: 'created' },
        ],
      },
    });
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('stops on rate_limited and returns partial counters and cursor', async () => {
    const { bulk, plan } = setup();
    plan.mockImplementationOnce(async (_c, _cred, repository) => ({
      repository,
      ecosystem: 'composer',
      packageName: repository,
      action: 'new',
      reason: null,
    }));
    plan.mockRejectedValueOnce(
      Object.assign(new Error('private provider detail'), {
        name: 'DiscoveryError',
        code: 'rate_limited',
      }),
    );
    expect(
      await bulk.apply(ctx, admin, fence, {
        credentialId: 'c',
        repositories: ['acme/one', 'acme/two', 'acme/three'],
        nextCursor: 'next',
      }),
    ).toEqual({
      ok: true,
      value: {
        created: 1,
        existing: 0,
        skipped: 0,
        failed: 1,
        results: [
          { repository: 'acme/one', outcome: 'created' },
          { repository: 'acme/two', outcome: 'failed', error: 'rate_limited' },
        ],
        nextCursor: 'next',
        remainingRepositories: ['acme/two', 'acme/three'],
      },
    });
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('returns a discovery error code for an invalid dry-run pattern', async () => {
    const { bulk, discover } = setup();
    discover.mockRejectedValueOnce(
      Object.assign(new Error('private pattern detail'), {
        name: 'DiscoveryError',
        code: 'invalid_request',
      }),
    );
    expect(
      await bulk.dryRun(ctx, admin, { credentialId: 'c', pattern: '[', cursor: null }),
    ).toEqual({ ok: false, error: 'invalid_request' });
  });

  it('returns zero counters for an empty repositories list', async () => {
    const { bulk, plan, service } = setup();
    expect(await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: [] })).toEqual({
      ok: true,
      value: {
        created: 0,
        existing: 0,
        skipped: 0,
        failed: 0,
        results: [],
        nextCursor: null,
        remainingRepositories: [],
      },
    });
    expect(plan).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
  });

  it('refuses more than 20 repositories, duplicates and an unknown credential', async () => {
    const { bulk, resolve, plan } = setup();
    const many = Array.from({ length: 21 }, (_, index) => `acme/r${index}`);
    expect(await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: many })).toEqual({
      ok: false,
      error: 'too_many_repositories',
    });
    expect(
      await bulk.apply(ctx, admin, fence, {
        credentialId: 'c',
        repositories: ['acme/one', 'acme/one'],
      }),
    ).toEqual({ ok: false, error: 'invalid_repositories' });
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockResolvedValueOnce(null as never);
    expect(
      await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: ['acme/one'] }),
    ).toEqual({ ok: false, error: 'credential_not_found' });
    expect(plan).not.toHaveBeenCalled();
  });

  it('refuses a fence that belongs to another user', async () => {
    const { bulk } = setup();
    const other = mutationFence({ userId: 'someone', sessionId: 's' } as AuthenticatedActor, {});
    await expect(
      bulk.apply(ctx, admin, other, { credentialId: 'c', repositories: ['acme/one'] }),
    ).rejects.toThrow(TypeError);
  });

  it('writes the vcs source for the discovered repository with the installation id', async () => {
    const { bulk, service } = setup();
    await bulk.apply(ctx, admin, fence, { credentialId: 'c', repositories: ['acme/one'] });
    expect(service.create).toHaveBeenCalledWith(
      ctx,
      { kind: 'org', actor: admin },
      fence,
      expect.objectContaining({
        projectId: null,
        name: 'acme/one',
        ecosystem: 'composer',
        type: 'vcs',
        url: null,
      }),
    );
    const input = vi.mocked(service.create).mock.calls[0]?.[3];
    expect(JSON.parse(input?.configJson ?? '{}')).toEqual({
      provider: 'github',
      repository: 'acme/one',
      installationId: 7,
      packageName: 'acme/one',
      refs: { tags: true, branches: [] },
    });
  });
});

it('pins the public discovery plan contract', () => {
  expectTypeOf<SkipReason>().toEqualTypeOf<
    | 'archived'
    | 'no_manifest'
    | 'invalid_name'
    | 'npm_from_vcs_unsupported'
    | 'filtered_out'
    | 'error_451'
    | 'error_404'
  >();
  expectTypeOf<PlanEntry>().toEqualTypeOf<{
    readonly repository: string;
    readonly ecosystem: 'composer' | 'npm' | null;
    readonly packageName: string | null;
    readonly action: 'new' | 'existing' | 'skipped';
    readonly reason:
      | 'archived'
      | 'no_manifest'
      | 'invalid_name'
      | 'npm_from_vcs_unsupported'
      | 'filtered_out'
      | 'error_451'
      | 'error_404'
      | null;
  }>();
  expectTypeOf<DiscoveryCandidate>().toEqualTypeOf<{
    readonly repository: string;
    readonly ecosystem: 'composer' | 'npm';
    readonly packageName: string;
  }>();
});
