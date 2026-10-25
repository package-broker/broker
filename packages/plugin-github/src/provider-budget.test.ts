import { describe, expect, it, vi } from 'vitest';
import { isUpstreamFailure } from '@package-broker/core/ingest/fill-shared';
import {
  createPackageSyncJob,
  type PackageSyncDeps,
} from '@package-broker/core/ingest/package-sync-job';
import type { IngestSessionHandle } from '@package-broker/core/ingest/session';
import { jobFences } from '@package-broker/core/platform/job-fences';
import { JobError, type JobContext } from '@package-broker/core/platform/jobs';
import { UpstreamError, type PolicyFetch } from '@package-broker/core/sources/policy-fetch';
import type { ProviderContext, ProviderSource } from '@package-broker/core/sources/provider';
import { createGithubProvider, TOKEN_DESCRIBE_BUDGET } from './provider.js';
import type { TokenRestBudget } from './token-rest.js';

const MIB = 1024 * 1024;
const source = {
  id: 'source',
  type: 'vcs',
  ecosystem: 'composer',
  url: null,
  config: { provider: 'github', repository: 'owner/repo', refs: { tags: true, branches: [] } },
} satisfies ProviderSource;

function manifest(index: number, bytes: number): string {
  const head = `{"name":"vendor/package","description":"${index}`;
  return `${head}${'x'.repeat(bytes - head.length - 2)}"}`;
}

function fakeGithub(tags: number, bytes: number, failText?: number) {
  const log: string[] = [];
  const commit = (index: number) => index.toString(16).padStart(40, '0');
  const fetch: PolicyFetch = async (request) => {
    let value: unknown;
    if (request.url.endsWith('/graphql')) {
      const { query } = JSON.parse(new TextDecoder().decode(request.body)) as { query: string };
      const text = query.includes('byteSize text');
      log.push(text ? 'text' : 'size');
      if (text && log.filter((entry) => entry === 'text').length === failText)
        throw new UpstreamError('network');
      const repository: Record<string, unknown> = {};
      for (const [, alias, oid] of query.matchAll(/(a\d+): object\(expression: "([0-9a-f]{40})/g))
        repository[alias!] = {
          byteSize: bytes,
          ...(text ? { text: manifest(Number.parseInt(oid!, 16), bytes) } : {}),
        };
      value = { data: { repository } };
    } else if (request.url.includes('/tags?')) {
      log.push('tags');
      const page = Number(new URL(request.url).searchParams.get('page'));
      value = Array.from(
        { length: Math.max(0, Math.min(100, tags - (page - 1) * 100)) },
        (_, n) => ({
          name: `v1.0.${(page - 1) * 100 + n}`,
          commit: { sha: commit((page - 1) * 100 + n) },
        }),
      );
    } else {
      log.push('repository');
      value = { archived: false, default_branch: 'main', full_name: 'owner/repo' };
    }
    return { status: 200, headers: new Headers(), body: Response.json(value).body };
  };
  const ctx = {
    fetch,
    signal: new AbortController().signal,
    clock: { now: () => new Date(1_700_000_000_000) },
    credential: {
      origins: ['https://api.github.com'],
      queryParams: [],
      apply(headers: Headers, url: URL) {
        headers.set('authorization', 'Bearer fixture-not-a-token');
        return { headers, url };
      },
    },
  } as unknown as ProviderContext;
  return { ctx, log };
}

async function describeWith(
  tags: number,
  bytes: number,
  budget?: TokenRestBudget,
  runtime: 'cloudflare' | 'docker' = 'cloudflare',
) {
  const github = fakeGithub(tags, bytes);
  const provider = createGithubProvider({
    runtime,
    tokensFor: () => null,
    ...(budget === undefined ? {} : { budget }),
  });
  return { ...github, result: provider.describe(github.ctx, source, 'vendor/package', {}) };
}

async function drain(result: Awaited<ReturnType<typeof describeWith>>['result']) {
  const described = await result;
  if (described.kind !== 'found') throw new Error('missing description');
  const raws: string[] = [];
  for await (const member of described.description.members) raws.push(member.raw);
  return { raws, complete: described.description.upstreamComplete };
}

describe('token describe budget', () => {
  it('reads manifest texts batch by batch as members are consumed', async () => {
    const { ctx, log } = fakeGithub(3, MIB);
    const provider = createGithubProvider({ runtime: 'cloudflare', tokensFor: () => null });
    const described = await provider.describe(ctx, source, 'vendor/package', {});
    if (described.kind !== 'found') throw new Error('missing description');
    expect(log.filter((entry) => entry === 'text')).toHaveLength(0);
    const members = described.description.members[Symbol.asyncIterator]();
    await members.next();
    expect(log.filter((entry) => entry === 'text')).toHaveLength(1);
    await members.next();
    await members.next();
    expect((await members.next()).done).toBe(true);
    expect(log.filter((entry) => entry === 'text')).toHaveLength(3);
    expect(described.description.upstreamComplete).toBe(true);
  });

  it('keeps a describe below the ceiling identical to an unbounded one', async () => {
    const total = 120 * 4096;
    const bounded = await drain(
      (await describeWith(120, 4096, { textBytes: total, requests: 7 })).result,
    );
    const unbounded = await drain(
      (await describeWith(120, 4096, { textBytes: Infinity, requests: Infinity })).result,
    );
    expect(bounded.raws).toHaveLength(120);
    expect(bounded).toEqual(unbounded);
    expect(bounded.complete).toBe(true);
  });

  it('ends a describe above the byte ceiling with too_large before reading any text', async () => {
    const { result, log } = await describeWith(120, 4096, {
      textBytes: 120 * 4096 - 1,
      requests: Infinity,
    });
    const error = await result.then(
      () => null,
      (rejected: unknown) => rejected,
    );
    expect(error).toMatchObject({
      name: 'UpstreamError',
      code: 'too_large',
      reason: 'manifest_bytes',
    });
    expect(isUpstreamFailure(error)).toBe(true);
    expect(log).not.toContain('text');
  });

  it('ends a describe above the request ceiling with too_large before reading any text', async () => {
    const { result, log } = await describeWith(120, 4096, { textBytes: Infinity, requests: 6 });
    await expect(result).rejects.toMatchObject({ code: 'too_large', reason: 'request_count' });
    expect(log).toEqual(['repository', 'tags', 'tags', 'size', 'size']);
  });

  it('refuses tag requests beyond the request ceiling', async () => {
    const { result, log } = await describeWith(450, 64, { textBytes: Infinity, requests: 3 });
    await expect(result).rejects.toMatchObject({ code: 'too_large', reason: 'request_count' });
    expect(log).toEqual(['repository', 'tags', 'tags']);
  });

  it('applies the Workers manifest byte ceiling by default', async () => {
    const limit = TOKEN_DESCRIBE_BUDGET.cloudflare.textBytes / MIB;
    const within = await describeWith(limit, MIB);
    await expect(within.result).resolves.toMatchObject({ kind: 'found' });
    expect(within.log).not.toContain('text');
    const over = await describeWith(limit + 1, MIB);
    await expect(over.result).rejects.toMatchObject({
      code: 'too_large',
      reason: 'manifest_bytes',
    });
  });

  it('counts the repository request, so a ceiling of N permits exactly N requests', async () => {
    const exact = await describeWith(50, 64, { textBytes: Infinity, requests: 4 });
    await expect(drain(exact.result)).resolves.toMatchObject({ complete: true });
    expect(exact.log).toEqual(['repository', 'tags', 'size', 'text']);
    const short = await describeWith(50, 64, { textBytes: Infinity, requests: 3 });
    await expect(short.result).rejects.toMatchObject({
      code: 'too_large',
      reason: 'request_count',
    });
    expect(short.log).toEqual(['repository', 'tags', 'size']);
  });

  it('applies the Node manifest byte ceiling on the docker runtime', async () => {
    const within = await describeWith(65, MIB, undefined, 'docker');
    await expect(within.result).resolves.toMatchObject({ kind: 'found' });
    expect(within.log).toEqual(['repository', 'tags', 'size']);
    expect(TOKEN_DESCRIBE_BUDGET.docker.textBytes).toBe(256 * MIB);
  });

  it('freezes the default budget', () => {
    expect(Object.isFrozen(TOKEN_DESCRIBE_BUDGET)).toBe(true);
    expect(Object.isFrozen(TOKEN_DESCRIBE_BUDGET.cloudflare)).toBe(true);
    expect(Object.isFrozen(TOKEN_DESCRIBE_BUDGET.docker)).toBe(true);
  });

  it('propagates a text batch failing mid-drain and leaves the description incomplete', async () => {
    const { ctx, log } = fakeGithub(3, MIB, 2);
    const provider = createGithubProvider({ runtime: 'cloudflare', tokensFor: () => null });
    const described = await provider.describe(ctx, source, 'vendor/package', {});
    if (described.kind !== 'found') throw new Error('missing description');
    const raws: string[] = [];
    const drained = (async () => {
      for await (const member of described.description.members) raws.push(member.raw);
    })();
    await expect(drained).rejects.toMatchObject({ name: 'UpstreamError', code: 'network' });
    expect(raws).toHaveLength(1);
    expect(log.filter((entry) => entry === 'text')).toHaveLength(2);
    expect(described.description.upstreamComplete).toBe(false);
  });

  it('ends an over-ceiling package sync with a retry and no catalogue or session writes', async () => {
    const github = fakeGithub(65, MIB);
    const provider = createGithubProvider({ runtime: 'cloudflare', tokensFor: () => null });
    const session = {
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
    } satisfies IngestSessionHandle;
    const sessions = {
      acquire: vi.fn(async () => session),
      setPendingValidators: vi.fn(async () => true),
      abandon: vi.fn(async () => true),
      release: vi.fn(async () => true),
    };
    const batch = vi.fn(async () => []);
    const enqueue = vi.fn();
    const markPackageAbsent = vi.fn();
    const describePackage = vi.fn((options: object, signal: AbortSignal) =>
      provider.describe({ ...github.ctx, signal }, source, 'vendor/package', options),
    );
    const job = createPackageSyncJob({
      sessions,
      apply: { writer: { markPackageAbsent }, sessions, finalizer: {} },
      jobs: { enqueue },
      upstreamState: {
        touchStatements: vi.fn(() => []),
        notFoundStatements: vi.fn(() => []),
        resetNotFoundStatements: vi.fn(() => []),
      },
      executor: { batch },
      sourceMetadata: vi.fn(async () => ({ type: 'vcs' as const })),
      findPackageId: vi.fn(async () => null),
      planFill: vi.fn(async () => ({
        source: {
          id: 'source',
          key: 'vendor/package',
          type: 'vcs' as const,
          ecosystem: 'composer' as const,
          covered: true,
        },
        describe: describePackage,
        toVersion: () => null,
        packageDescription: null,
        validatorTtlSeconds: 300,
        publishedValidators: {},
      })),
      writeGuard: vi.fn(() => []),
      clock: { now: () => new Date(1_700_000_000_000) },
    } as unknown as PackageSyncDeps);
    const context = {
      org: { orgId: 'org' },
      jobId: 'job-1',
      signal: new AbortController().signal,
      fences: jobFences({ id: 'job-1', owner: 'claim-owner', fence: 1 }),
      observability: { log: () => {}, counter: () => {}, histogram: () => {} },
    } as unknown as JobContext;
    const error = await job
      .handler(job.validate({ sourceId: 'source', key: 'vendor/package' }), context)
      .catch((rejected: unknown) => rejected);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('handler_error');
    expect(describePackage).toHaveBeenCalledTimes(1);
    expect(github.log).not.toContain('text');
    expect(batch).not.toHaveBeenCalled();
    expect(markPackageAbsent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(sessions.setPendingValidators).not.toHaveBeenCalled();
    expect(sessions.release).not.toHaveBeenCalled();
    expect(sessions.abandon).toHaveBeenCalledTimes(1);
  });
});
