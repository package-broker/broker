import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../ids.js';
import { ExpansionLimitError } from '../../registry/composer/minify.js';
import type { DocumentValidators, PackageDescription } from '../../sources/provider.js';
import {
  createPolicyFetch,
  UpstreamError,
  type UpstreamCredential,
} from '../../sources/policy-fetch.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import { JsonExtractError } from '../json-stream.js';
import type { ComposerRoot } from './root.js';
import {
  ComposerV2Error,
  describeComposerV2,
  type ComposerV2Candidate,
  type ComposerV2Options,
  type ComposerV2Source,
} from './v2-package.js';

const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const NAME = 'acme/widget';
const ORIGIN = 'https://repo.example.com';
const P2 = `${ORIGIN}/p2/${NAME}.json`;
const DEV = `${ORIGIN}/p2/${NAME}~dev.json`;
const NOW = '2026-10-17T10:00:00.000Z';
const SECRET = 'supersecret-token-123';

type Reply = { status: number; body?: string; headers?: Record<string, string> };

interface Call {
  url: string;
  ifNoneMatch: string | null;
  ifModifiedSince: string | null;
}

function setup(routes: Record<string, Reply[]>): {
  calls: Call[];
  fetch: ReturnType<typeof createPolicyFetch>;
} {
  const calls: Call[] = [];
  const fetch = createPolicyFetch({
    policy,
    userAgent: 'pb-test/1',
    fetchImpl: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      calls.push({
        url,
        ifNoneMatch: headers.get('if-none-match'),
        ifModifiedSince: headers.get('if-modified-since'),
      });
      const queue = routes[url];
      if (queue === undefined || queue.length === 0) throw new Error('unexpected request');
      const reply = (queue.length > 1 ? queue.shift() : queue[0]) as Reply;
      return new Response(reply.status === 304 ? null : (reply.body ?? ''), {
        status: reply.status,
        headers: reply.headers ?? {},
      });
    },
  });
  return { calls, fetch };
}

function root(extra: Partial<ComposerRoot> = {}): ComposerRoot {
  return {
    mode: 'v2',
    packagesJsonUrl: `${ORIGIN}/packages.json`,
    metadataUrl: `${ORIGIN}/p2/%package%.json`,
    inlineProviders: false,
    partialPackages: false,
    inlinePackages: false,
    validator: { sha256: 'a'.repeat(64) },
    messages: [],
    mirrors: [],
    ...extra,
  };
}

function source(extra: Partial<ComposerV2Source> = {}): ComposerV2Source {
  return { root: root(), allowedOrigins: [], ...extra };
}

function opts(extra: Partial<ComposerV2Options> = {}): ComposerV2Options {
  return {
    path: 'job',
    probe: { secrets: [SECRET], queryParams: ['token'] },
    clock: fixedClock(NOW),
    ...extra,
  };
}

const dist = (version: string): Record<string, unknown> => ({
  type: 'zip',
  url: `https://dl.example.com/${NAME}/${version}.zip`,
  reference: 'abc',
});

function p2Body(versions: Record<string, unknown>[], minified = true, key = NAME): string {
  return JSON.stringify({
    ...(minified ? { minified: 'composer/2.0' } : {}),
    packages: { [key]: versions },
  });
}

const stable = p2Body([
  { name: NAME, version: '1.1.0', time: '2026-01-02T00:00:00+00:00', dist: dist('1.1.0') },
  { version: '1.0.0', time: '2026-01-01T00:00:00+00:00', dist: dist('1.0.0') },
]);
const dev = p2Body([{ name: NAME, version: 'dev-main', dist: dist('dev-main') }]);

const ok = (body: string, etag: string): Reply => ({
  status: 200,
  body,
  headers: { etag, 'content-type': 'application/json' },
});

const validators: DocumentValidators = {
  'composer-p2': { etag: '"s1"' },
  'composer-p2-dev': { etag: '"d1"' },
};

async function drain(description: PackageDescription): Promise<ComposerV2Candidate[]> {
  const out: ComposerV2Candidate[] = [];
  for await (const member of description.members) out.push(member as ComposerV2Candidate);
  return out;
}

function noSleep(): NonNullable<ComposerV2Options['sleep']> {
  return () => {
    throw new Error('slept on the request path');
  };
}

function recorder(): { slept: number[]; sleep: (ms: number) => Promise<void> } {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
}

async function found(
  result: Awaited<ReturnType<typeof describeComposerV2>>,
): Promise<PackageDescription> {
  if (result.kind !== 'found') throw new Error(result.kind);
  return result.description;
}

describe('describeComposerV2 forms', () => {
  it('refetches p2 unconditionally when p2 is 304 and ~dev is 200, carrying both forms', async () => {
    const { fetch, calls } = setup({
      [P2]: [{ status: 304 }, ok(stable, '"s1"')],
      [DEV]: [ok(dev, '"d2"')],
    });
    const description = await found(
      await describeComposerV2(fetch, source(), NAME, opts({ dev: true, validators })),
    );
    const members = await drain(description);
    expect(members.map((m) => [m.form, m.version])).toEqual([
      ['composer-p2', '1.1.0'],
      ['composer-p2', '1.0.0'],
      ['composer-p2-dev', 'dev-main'],
    ]);
    expect(members[1]?.input.versionNormalized).toBe('1.0.0.0');
    expect(JSON.parse(members[1]?.raw ?? '')).toMatchObject({ name: NAME, version: '1.0.0' });
    expect(members[0]?.upstreamTime).toBe('2026-01-02T00:00:00.000Z');
    expect(description.forms?.map((f) => [f.form, f.status])).toEqual([
      ['composer-p2', 'present'],
      ['composer-p2-dev', 'present'],
    ]);
    expect(description.validators).toEqual({
      'composer-p2': { etag: '"s1"' },
      'composer-p2-dev': { etag: '"d2"' },
    });
    expect(description.upstreamComplete).toBe(true);
    expect(calls.filter((c) => c.url === P2).map((c) => c.ifNoneMatch)).toEqual(['"s1"', null]);
  });

  it('refetches ~dev unconditionally when p2 is 200 and ~dev is 304', async () => {
    const { fetch, calls } = setup({
      [P2]: [ok(stable, '"s2"')],
      [DEV]: [{ status: 304 }, ok(dev, '"d1"')],
    });
    const description = await found(
      await describeComposerV2(fetch, source(), NAME, opts({ dev: true, validators })),
    );
    expect((await drain(description)).map((m) => m.version)).toEqual([
      '1.1.0',
      '1.0.0',
      'dev-main',
    ]);
    expect(calls.filter((c) => c.url === DEV).map((c) => c.ifNoneMatch)).toEqual(['"d1"', null]);
  });

  it.each(['request', 'job'] as const)(
    'propagates a refused unconditional dev retry on the %s path',
    async (path) => {
      const target = `https://sentinel.invalid/private?token=${SECRET}`;
      const { fetch, calls } = setup({
        [P2]: [ok(stable, '"s2"')],
        [DEV]: [{ status: 304 }, { status: 302, headers: { location: target } }],
      });
      const pending = describeComposerV2(
        fetch,
        source(),
        NAME,
        opts({ path, dev: true, validators, sleep: noSleep() }),
      );

      await expect(pending).rejects.toMatchObject({ name: 'ComposerV2Error', code: 'refused' });
      expect(calls.filter((call) => call.url === DEV).map((call) => call.ifNoneMatch)).toEqual([
        '"d1"',
        null,
      ]);
      expect(calls).toHaveLength(3);
      expect(calls.some((call) => call.url === target)).toBe(false);
    },
  );

  it('treats a 304 for a form sent without validators as an error, never not_modified', async () => {
    const { fetch } = setup({ [P2]: [{ status: 304 }] });
    await expect(describeComposerV2(fetch, source(), NAME, opts())).rejects.toMatchObject({
      code: 'http_status',
      status: 304,
    });
    const devOnly = setup({ [P2]: [ok(stable, '"s2"')], [DEV]: [{ status: 304 }] });
    const description = await found(
      await describeComposerV2(devOnly.fetch, source(), NAME, opts({ dev: true })),
    );
    await drain(description);
    expect(description.upstreamComplete).toBe(false);
  });

  it('answers not_modified when both forms are 304', async () => {
    const { fetch, calls } = setup({ [P2]: [{ status: 304 }], [DEV]: [{ status: 304 }] });
    const result = await describeComposerV2(
      fetch,
      source(),
      NAME,
      opts({ dev: true, validators, path: 'request', sleep: noSleep() }),
    );
    expect(result).toEqual({ kind: 'not_modified' });
    expect(calls.map((c) => c.ifNoneMatch)).toEqual(['"s1"', '"d1"']);
  });

  it('sends if-modified-since from stored lastModified validators', async () => {
    const { fetch, calls } = setup({ [P2]: [{ status: 304 }] });
    const lastModified = 'Wed, 14 Oct 2026 10:00:00 GMT';
    const result = await describeComposerV2(
      fetch,
      source(),
      NAME,
      opts({ validators: { 'composer-p2': { lastModified } } }),
    );
    expect(result).toEqual({ kind: 'not_modified' });
    expect(calls[0]?.ifModifiedSince).toBe(lastModified);
  });

  it('treats a ~dev 404 with p2 200 as an empty dev form that stores no validators', async () => {
    const { fetch } = setup({
      [P2]: [ok(stable, '"s2"')],
      [DEV]: [{ status: 404, body: '{"packages":[]}' }],
    });
    const description = await found(
      await describeComposerV2(fetch, source(), NAME, opts({ dev: true })),
    );
    expect((await drain(description)).map((m) => m.form)).toEqual(['composer-p2', 'composer-p2']);
    expect(description.forms?.map((f) => [f.form, f.status])).toEqual([
      ['composer-p2', 'present'],
      ['composer-p2-dev', 'absent'],
    ]);
    expect(description.validators).toEqual({ 'composer-p2': { etag: '"s2"' } });
    expect(description.upstreamComplete).toBe(true);
  });

  it('answers not_modified when the persisted dev-404 description is asked again', async () => {
    const first = setup({
      [P2]: [ok(stable, '"s2"')],
      [DEV]: [{ status: 404, body: '{"packages":[]}' }],
    });
    const description = await found(
      await describeComposerV2(first.fetch, source(), NAME, opts({ dev: true })),
    );
    await drain(description);
    const again = setup({
      [P2]: [{ status: 304 }],
      [DEV]: [{ status: 404, body: '{"packages":[]}' }],
    });
    const result = await describeComposerV2(
      again.fetch,
      source(),
      NAME,
      opts({ dev: true, validators: description.validators }),
    );
    expect(result).toEqual({ kind: 'not_modified' });
  });

  it('refetches p2 when ~dev turns 404 after stored dev validators', async () => {
    const { fetch, calls } = setup({
      [P2]: [{ status: 304 }, ok(stable, '"s1"')],
      [DEV]: [{ status: 404, body: '{"packages":[]}' }],
    });
    const description = await found(
      await describeComposerV2(fetch, source(), NAME, opts({ dev: true, validators })),
    );
    expect(description.forms?.map((f) => f.status)).toEqual(['present', 'absent']);
    expect(calls.filter((c) => c.url === P2)).toHaveLength(2);
  });

  it('treats a p2 404 on the unconditional refetch as an error', async () => {
    const { fetch } = setup({
      [P2]: [{ status: 304 }, { status: 404, body: '{}' }],
      [DEV]: [ok(dev, '"d2"')],
    });
    await expect(
      describeComposerV2(fetch, source(), NAME, opts({ dev: true, validators })),
    ).rejects.toMatchObject({ name: 'ComposerV2Error', code: 'http_status', status: 404 });
  });

  it('uses a constant snapshot for absent forms', async () => {
    const run = async (body: string): Promise<string | undefined> => {
      const { fetch } = setup({ [P2]: [ok(stable, '"s1"')], [DEV]: [{ status: 404, body }] });
      const description = await found(
        await describeComposerV2(fetch, source(), NAME, opts({ dev: true })),
      );
      return description.forms?.[1]?.snapshot.id;
    };
    expect(await run('{"packages":[]}')).toMatch(/^sha256:/);
    expect(await run('{"packages":[]}')).toBe(await run(' { "packages": [] } '));
  });

  it('marks the description incomplete when ~dev answers 500', async () => {
    const { fetch } = setup({ [P2]: [ok(stable, '"s2"')], [DEV]: [{ status: 500 }] });
    const description = await found(
      await describeComposerV2(fetch, source(), NAME, opts({ dev: true })),
    );
    await drain(description);
    expect(description.upstreamComplete).toBe(false);
    expect(description.forms?.map((f) => f.form)).toEqual(['composer-p2']);
  });

  it('marks a p2 200 without the package key incomplete', async () => {
    const { fetch } = setup({ [P2]: [ok(p2Body([], true, 'acme/other'), '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    expect(await drain(description)).toEqual([]);
    expect(description.upstreamComplete).toBe(false);
  });

  it('accepts the package key in a different case', async () => {
    const body = p2Body(
      [{ name: 'Acme/Widget', version: '1.0.0', dist: dist('1.0.0') }],
      true,
      'Acme/Widget',
    );
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    expect((await drain(description)).map((m) => m.version)).toEqual(['1.0.0']);
    expect(description.upstreamComplete).toBe(true);
  });
});

describe('describeComposerV2 versions', () => {
  it('passes every version through the canonical version object and strips credential echo', async () => {
    const skipped: string[] = [];
    const body = p2Body(
      [
        {
          name: NAME,
          version: '1.0.0',
          'notification-url': 'https://repo.example.com/notify',
          support: { issues: `https://issues.example.com/?token=${SECRET}` },
          dist: dist('1.0.0'),
        },
        { name: 'evil/other', version: '2.0.0', dist: dist('2.0.0') },
      ],
      false,
    );
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(
      await describeComposerV2(
        fetch,
        source(),
        NAME,
        opts({ onSkip: (reason) => skipped.push(reason) }),
      ),
    );
    const members = await drain(description);
    expect(members.map((m) => m.version)).toEqual(['1.0.0']);
    expect(members[0]?.raw).not.toContain(SECRET);
    expect(members[0]?.raw).not.toContain('notification-url');
    expect(members[0]?.stripped).toBeGreaterThan(0);
    expect(members[0]?.input.history).toEqual({ basis: 'import_time', at: NOW, noOtherDate: true });
    expect(skipped).toEqual(['foreign_name']);
  });

  it('does not expand a document without the minified marker', async () => {
    const body = p2Body(
      [
        { name: NAME, version: '1.1.0', license: ['MIT'], dist: dist('1.1.0') },
        { name: NAME, version: '1.0.0', dist: dist('1.0.0') },
      ],
      false,
    );
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    const members = await drain(description);
    expect(members[1]?.input.license).toBeNull();
  });

  it('fails the members and leaves the description incomplete on an expansion bomb', async () => {
    const big = 'x'.repeat(300 * 1024);
    const { fetch } = setup({
      [P2]: [ok(p2Body([{ name: NAME, version: '1.0.0', description: big }]), '"s1"')],
    });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    await expect(drain(description)).rejects.toThrow(/expansion limit/);
    expect(description.upstreamComplete).toBe(false);
  });

  it('uses the strong ETags of both forms as the snapshot identity', async () => {
    const run = async (p2Etag: string): Promise<string> => {
      const { fetch } = setup({ [P2]: [ok(stable, p2Etag)], [DEV]: [ok(dev, '"d1"')] });
      const description = await found(
        await describeComposerV2(fetch, source(), NAME, opts({ dev: true })),
      );
      return description.snapshot.id;
    };
    const first = await run('"s1"');
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await run('"s1"')).toBe(first);
    expect(await run('"s2"')).not.toBe(first);
  });
});

describe('describeComposerV2 names and listings', () => {
  it.each([
    ['../../admin/secret'],
    ['acme/widget?token=x'],
    ['acme/widget#x'],
    ['acme/$&'],
    [`acme/${'a'.repeat(430)}`],
  ])('refuses the invalid name %j without a request', async (name) => {
    const { fetch, calls } = setup({});
    expect(await describeComposerV2(fetch, source(), name, opts())).toEqual({
      kind: 'not_found',
      definitive: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('substitutes every %package% literally', async () => {
    const twice = `${ORIGIN}/p2/%package%.json?for=%package%`;
    const url = `${ORIGIN}/p2/${NAME}.json?for=${NAME}`;
    const { fetch, calls } = setup({ [url]: [ok(stable, '"s1"')] });
    await describeComposerV2(fetch, source({ root: root({ metadataUrl: twice }) }), NAME, opts());
    expect(calls.map((c) => c.url)).toEqual([url]);
  });

  it('answers non-definitive not_found without a request for unlisted names', async () => {
    const { fetch, calls } = setup({});
    const scoped = source({
      root: root({ availablePackages: ['acme/other'], availablePatterns: ['corp/*'] }),
    });
    expect(await describeComposerV2(fetch, scoped, NAME, opts({ path: 'request' }))).toEqual({
      kind: 'not_found',
      definitive: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('uses a 200-byte available pattern to match its package and reject an unlisted package', async () => {
    const name = `acme/${'a'.repeat(194)}z`;
    const pattern = `acme/${'a'.repeat(194)}*`;
    expect(pattern).toHaveLength(200);
    const url = `${ORIGIN}/p2/${name}.json`;
    const body = p2Body([{ name, version: '1.0.0' }], false, name);
    const { fetch, calls } = setup({ [url]: [ok(body, '"s1"')] });
    const scoped = source({ root: root({ availablePatterns: [pattern] }) });
    expect((await describeComposerV2(fetch, scoped, name, opts())).kind).toBe('found');
    expect(await describeComposerV2(fetch, scoped, NAME, opts())).toEqual({
      kind: 'not_found',
      definitive: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('matches available-package-patterns case-insensitively', async () => {
    const { fetch } = setup({ [P2]: [ok(stable, '"s1"')] });
    const scoped = source({ root: root({ availablePackages: [], availablePatterns: ['ACME/*'] }) });
    expect((await describeComposerV2(fetch, scoped, NAME, opts())).kind).toBe('found');
  });

  it('ignores an unusable pattern listing and asks upstream', async () => {
    for (const patterns of [
      Array.from({ length: 1001 }, (_, i) => `v${i}/*`),
      [`${'a'.repeat(256)}/*`],
      ['(.*)+/x'],
    ]) {
      const { fetch, calls } = setup({ [P2]: [ok(stable, '"s1"')] });
      const scoped = source({ root: root({ availablePatterns: patterns }) });
      expect((await describeComposerV2(fetch, scoped, NAME, opts())).kind).toBe('found');
      expect(calls).toHaveLength(1);
    }
  });

  it('answers a p2 404 as not_found, definitive only with recognised evidence', async () => {
    const json = setup({ [P2]: [{ status: 404, body: '{"packages":[]}' }] });
    expect(await describeComposerV2(json.fetch, source(), NAME, opts())).toEqual({
      kind: 'not_found',
      definitive: true,
    });
    const html = setup({ [P2]: [{ status: 404, body: '<html>nope</html>' }] });
    expect(await describeComposerV2(html.fetch, source(), NAME, opts())).toEqual({
      kind: 'not_found',
      definitive: false,
    });
  });
});

describe('describeComposerV2 retries and failures', () => {
  const credential: UpstreamCredential = {
    origins: [ORIGIN],
    queryParams: [],
    apply: (headers, url) => ({ headers, url }),
  };

  it('throws a typed error when p2 answers 503', async () => {
    const { fetch } = setup({ [P2]: [{ status: 503 }] });
    await expect(
      describeComposerV2(fetch, source(), NAME, opts({ path: 'request', sleep: noSleep() })),
    ).rejects.toMatchObject({ name: 'ComposerV2Error', code: 'http_status', status: 503 });
  });

  it('returns busy on the request path without sleeping on Retry-After', async () => {
    const { fetch, calls } = setup({
      [P2]: [{ status: 429, headers: { 'retry-after': '5' } }],
      [DEV]: [ok(dev, '"d1"')],
    });
    const result = await describeComposerV2(
      fetch,
      source(),
      NAME,
      opts({ dev: true, path: 'request', sleep: noSleep() }),
    );
    expect(result).toEqual({ kind: 'busy', retryAfterSeconds: 5 });
    expect(calls.filter((c) => c.url === P2)).toHaveLength(1);
  });

  it('honours Retry-After up to 60 seconds in jobs and returns busy beyond it', async () => {
    const { slept, sleep } = recorder();
    const short = setup({
      [P2]: [{ status: 429, headers: { 'retry-after': '2' } }, ok(stable, '"s1"')],
    });
    expect((await describeComposerV2(short.fetch, source(), NAME, opts({ sleep }))).kind).toBe(
      'found',
    );
    expect(slept).toEqual([2000]);

    const long = setup({ [P2]: [{ status: 429, headers: { 'retry-after': '61' } }] });
    expect(await describeComposerV2(long.fetch, source(), NAME, opts({ sleep }))).toEqual({
      kind: 'busy',
      retryAfterSeconds: 61,
    });
    expect(slept).toEqual([2000]);
  });

  it('reads an HTTP-date Retry-After against the injected clock', async () => {
    const { slept, sleep } = recorder();
    const { fetch } = setup({
      [P2]: [
        { status: 429, headers: { 'retry-after': 'Sat, 17 Oct 2026 10:00:30 GMT' } },
        ok(stable, '"s1"'),
      ],
    });
    expect((await describeComposerV2(fetch, source(), NAME, opts({ sleep }))).kind).toBe('found');
    expect(slept).toEqual([30_000]);
  });

  it.each([
    ['86401', 86400],
    ['-5', null],
    ['1.5', null],
    ['12 apples', null],
    ['', null],
  ])('carries bounded Retry-After without waiting for %j', async (header, seconds) => {
    const { slept, sleep } = recorder();
    const { fetch, calls } = setup({
      [P2]: [{ status: 429, headers: { 'retry-after': header } }],
    });
    expect(await describeComposerV2(fetch, source(), NAME, opts({ sleep }))).toEqual({
      kind: 'busy',
      retryAfterSeconds: seconds,
    });
    expect(slept).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('keeps the 429 retry and the 404 recheck on separate counters', async () => {
    const { slept, sleep } = recorder();
    const listed = source({ root: root({ availablePackages: [NAME] }), credential });
    const { fetch, calls } = setup({
      [P2]: [
        { status: 429, headers: { 'retry-after': '1' } },
        { status: 404, body: '{}' },
        ok(stable, '"s1"'),
      ],
    });
    expect((await describeComposerV2(fetch, listed, NAME, opts({ sleep }))).kind).toBe('found');
    expect(slept).toEqual([1000, 1500]);
    expect(calls).toHaveLength(3);
  });

  it('rechecks a 404 for a listed name once after 1.5 s on authenticated sources in jobs only', async () => {
    const { slept, sleep } = recorder();
    const listed = source({ root: root({ availablePackages: [NAME] }), credential });
    const job = setup({ [P2]: [{ status: 404, body: '{}' }, ok(stable, '"s1"')] });
    expect((await describeComposerV2(job.fetch, listed, NAME, opts({ sleep }))).kind).toBe('found');
    expect(slept).toEqual([1500]);

    const request = setup({ [P2]: [{ status: 404, body: '{}' }] });
    expect(
      await describeComposerV2(
        request.fetch,
        listed,
        NAME,
        opts({ path: 'request', sleep: noSleep() }),
      ),
    ).toEqual({ kind: 'not_found', definitive: false });
    expect(request.calls).toHaveLength(1);
  });

  it('aborts a sleep when the signal aborts', async () => {
    const controller = new AbortController();
    const { fetch } = setup({ [P2]: [{ status: 429, headers: { 'retry-after': '10' } }] });
    const pending = describeComposerV2(
      fetch,
      source(),
      NAME,
      opts({
        signal: controller.signal,
        sleep: () => {
          controller.abort(new Error('stopped'));
          return new Promise(() => undefined);
        },
      }),
    );
    await expect(pending).rejects.toThrow('stopped');
  });

  it('refuses a redirect outside the destinations without leaking the URL', async () => {
    const target = `https://elsewhere.example.net/steal?token=${SECRET}`;
    const { fetch } = setup({ [P2]: [{ status: 302, headers: { location: target } }] });
    const error = await describeComposerV2(fetch, source(), NAME, opts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComposerV2Error);
    expect(error).toMatchObject({ code: 'refused' });
    expect(String(error)).not.toContain('elsewhere.example.net');
    expect(String(error)).not.toContain(SECRET);
  });

  it('passes too_large through as a typed error', async () => {
    const { fetch } = setup({ [P2]: [ok(stable, '"s1"')] });
    await expect(
      describeComposerV2(fetch, source({ maxBytes: 64 }), NAME, opts()),
    ).rejects.toMatchObject({ name: 'ComposerV2Error', code: 'too_large' });
  });
});

describe('describeComposerV2 version elements', () => {
  const versionsOf = (count: number, pad: number): Record<string, unknown>[] =>
    Array.from({ length: count }, (_, index) => ({
      name: NAME,
      version: `1.0.${index}`,
      description: 'd'.repeat(pad),
      dist: dist(`1.0.${index}`),
    }));

  it('expands a p2 document whose minified marker follows packages', async () => {
    const body = JSON.stringify({
      packages: {
        [NAME]: [
          { name: NAME, version: '1.1.0', license: ['MIT'], dist: dist('1.1.0') },
          { version: '1.0.0', dist: dist('1.0.0') },
        ],
      },
      minified: 'composer/2.0',
    });
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    const members = await drain(description);
    expect(members.map((m) => m.version)).toEqual(['1.1.0', '1.0.0']);
    expect(members[1]?.input.license).not.toBeNull();
    expect(description.upstreamComplete).toBe(true);
  });

  it('finds an empty version array with zero candidates', async () => {
    const { fetch } = setup({ [P2]: [ok(p2Body([]), '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    expect(await drain(description)).toEqual([]);
    expect(description.upstreamComplete).toBe(true);
  });

  it('keeps keyMissing for two arrays whose keys differ only by case', async () => {
    const list = JSON.stringify([{ name: NAME, version: '1.0.0', dist: dist('1.0.0') }]);
    const body = `{"packages":{"${NAME}":${list},"Acme/Widget":${list}}}`;
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    expect(await drain(description)).toEqual([]);
    expect(description.upstreamComplete).toBe(false);
  });

  it('fails a version array longer than maxVersions before the document ends', async () => {
    const list = JSON.stringify(versionsOf(2000, 50));
    expect(list.length).toBeGreaterThan(2 * 64 * 1024);
    const body = `{"packages":{"${NAME}":${list},"broken":}`;
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(
      await describeComposerV2(fetch, source({ expansion: { maxVersions: 3 } }), NAME, opts()),
    );
    const error = await drain(description).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ExpansionLimitError);
    expect((error as ExpansionLimitError).reason).toBe('versions');
    expect(description.upstreamComplete).toBe(false);
  });

  it('fails a single version over the 1 MiB per-version cap', async () => {
    const body = p2Body(versionsOf(1, 1024 * 1024 + 16), false);
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    const error = await drain(description).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(JsonExtractError);
    expect((error as JsonExtractError).code).toBe('member_too_large');
  });

  it('answers unsupported for a non-array version value', async () => {
    const body = JSON.stringify({ packages: { [NAME]: { '1.0.0': { version: '1.0.0' } } } });
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    const error = await drain(description).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ComposerV2Error);
    expect((error as ComposerV2Error).code).toBe('unsupported');
  });

  it('streams a 2,000-version document larger than the per-version cap', async () => {
    const body = p2Body(versionsOf(2000, 600), false);
    expect(body.length).toBeGreaterThan(1024 * 1024);
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    const members = await drain(description);
    expect(members).toHaveLength(2000);
    expect(members.map((m) => m.ordinal)).toEqual(Array.from({ length: 2000 }, (_, i) => i));
    expect(description.upstreamComplete).toBe(true);
  });
});

describe('describeComposerV2 non-array package values', () => {
  const list = JSON.stringify([{ name: NAME, version: '1.0.0', dist: dist('1.0.0') }]);

  it('skips a non-array sibling package value', async () => {
    for (const body of [
      `{"packages":{"acme/other":{"1.0.0":{}},"${NAME}":${list}}}`,
      `{"packages":{"${NAME}":${list},"acme/other":"x"}}`,
    ]) {
      const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
      const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
      expect((await drain(description)).map((m) => m.version)).toEqual(['1.0.0']);
      expect(description.upstreamComplete).toBe(true);
    }
  });

  it('keeps keyMissing for a case twin whose value is not an array', async () => {
    for (const body of [
      `{"packages":{"${NAME}":${list},"Acme/Widget":{"1.0.0":{}}}}`,
      `{"packages":{"Acme/Widget":null,"${NAME}":${list}}}`,
    ]) {
      const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
      const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
      expect(await drain(description)).toEqual([]);
      expect(description.upstreamComplete).toBe(false);
    }
  });

  it('caps a version at expansion.maxVersionBytes when it is set', async () => {
    const body = p2Body(
      [{ name: NAME, version: '1.0.0', description: 'd'.repeat(5000), dist: dist('1.0.0') }],
      false,
    );
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(
      await describeComposerV2(
        fetch,
        source({ expansion: { maxVersions: 10, maxVersionBytes: 4096 } }),
        NAME,
        opts(),
      ),
    );
    const error = await drain(description).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((error as JsonExtractError).code).toBe('member_too_large');
  });

  it('rejects an invalid maxVersions before reading versions', async () => {
    const { fetch } = setup({ [P2]: [ok(stable, '"s1"')] });
    const description = await found(
      await describeComposerV2(fetch, source({ expansion: { maxVersions: 0 } }), NAME, opts()),
    );
    await expect(drain(description)).rejects.toThrow(RangeError);
  });
});

describe('describeComposerV2 large non-array package values', () => {
  it('answers unsupported for a 2 MiB string at the package key', async () => {
    const body = `{"packages":{"${NAME}":"${'x'.repeat(2 * 1024 * 1024)}"}}`;
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    const error = await drain(description).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ComposerV2Error);
    expect((error as ComposerV2Error).code).toBe('unsupported');
  });

  it('skips a 2 MiB non-array sibling', async () => {
    const list = JSON.stringify([{ name: NAME, version: '1.0.0', dist: dist('1.0.0') }]);
    const body = `{"packages":{"acme/other":{"k":"${'x'.repeat(2 * 1024 * 1024)}"},"${NAME}":${list}}}`;
    const { fetch } = setup({ [P2]: [ok(body, '"s1"')] });
    const description = await found(await describeComposerV2(fetch, source(), NAME, opts()));
    expect((await drain(description)).map((m) => m.version)).toEqual(['1.0.0']);
    expect(description.upstreamComplete).toBe(true);
  });
});

describe('Composer v2 404 absence evidence', () => {
  const credential: UpstreamCredential = {
    origins: [ORIGIN],
    queryParams: [],
    apply: (headers, url) => ({ headers, url }),
  };

  it.each([
    ['null', 'null'],
    ['HTML', '<html>not found</html>'],
    ['empty body', ''],
    ['array', '[]'],
    ['number', '404'],
    ['boolean', 'false'],
    ['string', '"not found"'],
    ['empty object', '{}'],
    ['gateway error', '{"status":"error","message":"unauthorized"}'],
    ['nonempty packages', '{"packages":["acme/widget"]}'],
    ['extra error field', '{"packages":[],"error":"unauthorized"}'],
    ['malformed JSON', '{'],
  ])('stable 404 rejects %s as absence evidence', async (_label, body) => {
    const { fetch } = setup({ [P2]: [{ status: 404, body }] });
    expect(await describeComposerV2(fetch, source(), NAME, opts())).toEqual({
      kind: 'not_found',
      definitive: false,
    });
  });

  it('stable 404 accepts Packagist empty packages without credentials', async () => {
    const { fetch } = setup({ [P2]: [{ status: 404, body: '{"packages":[]}' }] });
    expect(await describeComposerV2(fetch, source(), NAME, opts())).toEqual({
      kind: 'not_found',
      definitive: true,
    });
  });

  it('stable 404 rejects recognised evidence with configured credentials', async () => {
    const { fetch } = setup({ [P2]: [{ status: 404, body: '{"packages":[]}' }] });
    expect(await describeComposerV2(fetch, source({ credential }), NAME, opts())).toEqual({
      kind: 'not_found',
      definitive: false,
    });
  });

  it.each([
    ['HTML', '<html>not found</html>'],
    ['null', 'null'],
    ['empty body', ''],
    ['array', '[]'],
    ['gateway error', '{"status":"error"}'],
  ])('dev 404 rejects %s and leaves the package incomplete', async (_label, body) => {
    const { fetch } = setup({ [P2]: [ok(stable, '"s1"')], [DEV]: [{ status: 404, body }] });
    const description = await found(
      await describeComposerV2(fetch, source(), NAME, opts({ dev: true })),
    );
    await drain(description);
    expect(description.upstreamComplete).toBe(false);
    expect(description.forms?.map((form) => form.status)).toEqual(['present']);
  });

  it('dev 404 rejects recognised evidence with configured credentials', async () => {
    const { fetch } = setup({
      [P2]: [ok(stable, '"s1"')],
      [DEV]: [{ status: 404, body: '{"packages":[]}' }],
    });
    const description = await found(
      await describeComposerV2(fetch, source({ credential }), NAME, opts({ dev: true })),
    );
    await drain(description);
    expect(description.upstreamComplete).toBe(false);
    expect(description.forms?.map((form) => form.status)).toEqual(['present']);
  });

  it('reports newly confirmed dev absence after an incomplete refresh with unchanged stable metadata', async () => {
    const first = setup({
      [P2]: [ok(stable, '"s1"')],
      [DEV]: [{ status: 404, body: '<html>not found</html>' }],
    });
    const incomplete = await found(
      await describeComposerV2(first.fetch, source(), NAME, opts({ dev: true })),
    );
    await drain(incomplete);
    expect(incomplete.upstreamComplete).toBe(false);
    expect(incomplete.forms?.map((form) => form.status)).toEqual(['present']);

    const stableConditions: (string | null)[] = [];
    const fetch = createPolicyFetch({
      policy,
      userAgent: 'pb-test/1',
      fetchImpl: async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === DEV) return new Response('{"packages":[]}', { status: 404 });
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        const condition = headers.get('if-none-match');
        stableConditions.push(condition);
        return condition === '"s1"'
          ? new Response(null, { status: 304 })
          : new Response(stable, { status: 200, headers: { etag: '"s1"' } });
      },
    });
    const complete = await found(
      await describeComposerV2(
        fetch,
        source(),
        NAME,
        opts({ dev: true, validators: incomplete.validators }),
      ),
    );
    expect((await drain(complete)).map((member) => member.version)).toEqual(['1.1.0', '1.0.0']);
    expect(complete.upstreamComplete).toBe(true);
    expect(complete.forms?.map((form) => [form.form, form.status])).toEqual([
      ['composer-p2', 'present'],
      ['composer-p2-dev', 'absent'],
    ]);
    expect(complete.snapshot.id).not.toBe(incomplete.snapshot.id);
    expect(stableConditions).toEqual([null]);
  });

  it('dev HTML 404 with stable 304 refetches stable and stays incomplete', async () => {
    const { fetch, calls } = setup({
      [P2]: [{ status: 304 }, ok(stable, '"s1"')],
      [DEV]: [{ status: 404, body: '<html>not found</html>' }],
    });
    const description = await found(
      await describeComposerV2(
        fetch,
        source(),
        NAME,
        opts({ dev: true, validators: { 'composer-p2': { etag: '"s1"' } } }),
      ),
    );
    await drain(description);
    expect(description.upstreamComplete).toBe(false);
    expect(calls.filter((call) => call.url === P2)).toHaveLength(2);
  });
});

describe('Composer v2 unreadable 404 evidence', () => {
  it('leaves an unreadable dev 404 incomplete without recording absence', async () => {
    const { fetch } = setup({ [P2]: [ok(stable, '"s1"')], [DEV]: [{ status: 404 }] });
    const description = await found(
      await describeComposerV2(
        async (request) => {
          const response = await fetch(request);
          if (request.url !== DEV) return response;
          return {
            ...response,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new UpstreamError('network'));
              },
            }),
          };
        },
        source(),
        NAME,
        opts({ dev: true }),
      ),
    );
    await drain(description);
    expect(description.upstreamComplete).toBe(false);
    expect(description.forms?.map((form) => form.status)).toEqual(['present']);
  });
});
