import { describe, expect, it, vi } from 'vitest';
import {
  UpstreamError,
  type PolicyFetch,
  type UpstreamCredential,
} from '@package-broker/core/plugin';
import { RateLimited } from './rate-limited.js';
import { tokenRest } from './token-rest.js';

const credential: UpstreamCredential = {
  origins: ['https://api.github.com'],
  queryParams: [],
  apply(headers, url) {
    headers.set('authorization', 'Bearer ghp_test-private-token');
    return { headers, url };
  },
};
const resetAt = (epochSeconds: number | undefined) => epochSeconds ?? 1234;
const sha = 'a'.repeat(40);
describe('token REST reads', () => {
  it.each([
    '{"name":"ghp_test-private-token","name":"fixture"}',
    '{"name":"fixture","x":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}',
    '{"name":"fixture","x":[' + '0,'.repeat(10000) + '0]}',
    '{"name":"fixture","x":"' + 'a'.repeat(262144) + '"}',
  ])('bounds npm manifest parsing before credential and name checks (%#)', async (text) => {
    const fetch: PolicyFetch = async () => ({
      status: 200,
      headers: new Headers(),
      body: Response.json({ data: { repository: { a0: { byteSize: text.length, text } } } }).body,
    });
    const rest = tokenRest(fetch, credential, 'owner/repo', resetAt, undefined, 'package.json');
    expect((await rest.files([{ name: 'refs/tags/v1.0.0', oid: sha }]))[0]?.text).toBeNull();
    const rootFetch: PolicyFetch = async () => ({
      status: 200,
      headers: new Headers(),
      body: new Response(text).body,
    });
    await expect(
      tokenRest(rootFetch, credential, 'owner/repo', resetAt, undefined, 'package.json').manifest(),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      tokenRest(rootFetch, credential, 'owner/repo', resetAt).manifest('package.json'),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('pages tags until the final short page', async () => {
    const fetch = vi.fn<PolicyFetch>(async (request) => ({
      status: 200,
      headers: new Headers(),
      body: Response.json(
        Array.from({ length: request.url.endsWith('page=1') ? 100 : 1 }, (_, index) => ({
          name: `v1.0.${index}`,
          commit: { sha },
        })),
      ).body,
    }));
    const refs = await tokenRest(fetch, credential, 'owner/repo', resetAt).refs('tags');
    expect(refs).toHaveLength(101);
    expect(fetch.mock.calls.map(([request]) => request.url)).toEqual([
      'https://api.github.com/repos/owner/repo/tags?per_page=100&page=1',
      'https://api.github.com/repos/owner/repo/tags?per_page=100&page=2',
    ]);
  });
  it.each([{}, [{ name: 'v1.0.0', commit: { sha: 'invalid' } }]])(
    'rejects malformed refs without including response data (%#)',
    async (value) => {
      const fetch: PolicyFetch = async () => ({
        status: 200,
        headers: new Headers(),
        body: Response.json(value).body,
      });
      await expect(
        tokenRest(fetch, credential, 'owner/repo', resetAt).refs('tags'),
      ).rejects.toMatchObject({
        code: 'invalid_response',
        message: 'GitHub provider invalid_response',
      });
    },
  );
  it('batches sizes and text for 250 tag manifests into six same-origin requests', async () => {
    const fetch = vi.fn<PolicyFetch>(async (request) => {
      expect(request.url).toBe('https://api.github.com/graphql');
      expect(request.method).toBe('POST');
      expect(request.credential).toBe(credential);
      expect(request.destinations).toEqual(['https://api.github.com']);
      const { query } = JSON.parse(new TextDecoder().decode(request.body)) as { query: string };
      const aliases = [...query.matchAll(/(a[0-9]+): object/g)];
      expect(aliases.length).toBeLessThanOrEqual(100);
      return {
        status: 200,
        headers: new Headers(),
        body: Response.json({
          data: {
            repository: Object.fromEntries(
              aliases.map((match) => [
                match[1],
                { byteSize: 64, text: '{"name":"vendor/package"}' },
              ]),
            ),
          },
        }).body,
      };
    });
    const refs = Array.from({ length: 250 }, (_, index) => ({
      name: `refs/tags/v1.0.${index}`,
      oid: index.toString(16).padStart(40, '0'),
    }));
    const files = await tokenRest(fetch, credential, 'owner/repo', resetAt).files(refs);
    expect(files).toHaveLength(250);
    expect(files.map((file) => file.ref)).toEqual(refs.map((ref) => ref.name));
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('preserves missing, malformed and valid per-ref outcomes', async () => {
    const fetch: PolicyFetch = async () => ({
      status: 200,
      headers: new Headers(),
      body: Response.json({
        data: {
          repository: {
            a0: null,
            a1: { byteSize: 64, text: '{bad' },
            a2: { byteSize: 64, text: '{"name":"vendor/package"}' },
          },
        },
      }).body,
    });
    const files = await tokenRest(fetch, credential, 'owner/repo', resetAt).files(
      ['missing', 'malformed', 'ok'].map((name) => ({ name, oid: sha })),
    );
    expect(files.map((file) => file.text)).toEqual([null, '{bad', '{"name":"vendor/package"}']);
  });
  it.each([new UpstreamError('http_status', 401), new UpstreamError('network')])(
    'propagates authentication and transport failures (%#)',
    async (error) => {
      const fetch: PolicyFetch = () => Promise.reject(error);
      await expect(
        tokenRest(fetch, credential, 'owner/repo', resetAt).files([{ name: 'ref', oid: sha }]),
      ).rejects.toBe(error);
    },
  );
  it('rejects a credential without a bearer header with a classifiable error', () => {
    expect(() =>
      tokenRest(
        vi.fn(),
        { ...credential, apply: (headers, url) => ({ headers, url }) },
        'owner/repo',
        resetAt,
      ),
    ).toThrow(expect.objectContaining({ name: 'UpstreamError', code: 'http_status', status: 401 }));
  });
  it('looks up a named branch directly and skips a branch that no longer exists', async () => {
    const fetch = vi
      .fn<PolicyFetch>()
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        body: Response.json({ name: 'release/1.x', commit: { sha } }).body,
      })
      .mockRejectedValueOnce(new UpstreamError('http_status', 404));
    const rest = tokenRest(fetch, credential, 'owner/repo', resetAt);
    expect(await rest.branch('release/1.x')).toEqual({ name: 'refs/heads/release/1.x', oid: sha });
    expect(await rest.branch('removed')).toBeNull();
    expect(fetch.mock.calls.map(([request]) => request.url)).toEqual([
      'https://api.github.com/repos/owner/repo/branches/release%2F1.x',
      'https://api.github.com/repos/owner/repo/branches/removed',
    ]);
  });
  it.each([{ byteSize: 64, text: null }, {}])(
    'keeps unreadable blobs local to a ref (%#)',
    async (unreadable) => {
      const fetch: PolicyFetch = async () => ({
        status: 200,
        headers: new Headers(),
        body: Response.json({
          data: {
            repository: {
              a0: unreadable,
              a1: { byteSize: 2, text: '{}' },
            },
          },
        }).body,
      });
      const files = await tokenRest(fetch, credential, 'owner/repo', resetAt).files([
        { name: 'bad', oid: sha },
        { name: 'ok', oid: sha },
      ]);
      expect(files.map((file) => file.text)).toEqual([null, '{}']);
    },
  );
  it('never fetches text above 1 MiB and bounds escaped aggregate responses to 8 MiB', async () => {
    const calls: string[] = [];
    const fetch: PolicyFetch = async (request) => {
      expect(request.maxBytes).toBe(8 * 1024 * 1024);
      const { query } = JSON.parse(new TextDecoder().decode(request.body)) as { query: string };
      calls.push(query);
      const text = query.includes('byteSize text');
      const aliases = [
        ...query.matchAll(/(a[0-9]+): object\(expression: "([a-f0-9]+):composer.json"/g),
      ];
      if (text) {
        expect(aliases.length).toBe(1);
        expect(query).not.toContain(`${sha}:composer.json`);
      }
      return {
        status: 200,
        headers: new Headers(),
        body: Response.json({
          data: {
            repository: Object.fromEntries(
              aliases.map((match) => [
                match[1],
                {
                  byteSize: match[2] === sha ? 1024 * 1024 + 1 : 1024 * 1024,
                  ...(text ? { text: ' '.repeat(1024 * 1024) } : {}),
                },
              ]),
            ),
          },
        }).body,
      };
    };
    const files = await tokenRest(fetch, credential, 'owner/repo', resetAt).files([
      { name: 'oversize', oid: sha },
      { name: 'one', oid: 'b'.repeat(40) },
      { name: 'two', oid: 'c'.repeat(40) },
    ]);
    expect(calls).toHaveLength(3);
    expect(files.map((file) => file.text?.length ?? null)).toEqual([
      null,
      1024 * 1024,
      1024 * 1024,
    ]);
  });
  it.each([
    ['RATE_LIMITED', { name: 'RateLimited', code: 'rate_limited', resetEpochSeconds: 2000000000 }],
    ['FORBIDDEN', { name: 'UpstreamError', code: 'http_status', status: 403 }],
    ['OTHER', { code: 'invalid_response' }],
  ])('classifies global GraphQL %s without exposing errors', async (type, expected) => {
    const fetch: PolicyFetch = async () => ({
      status: 200,
      headers: new Headers({
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '2000000000',
      }),
      body: Response.json({ errors: [{ type, message: 'secret' }] }).body,
    });
    await expect(
      tokenRest(fetch, credential, 'owner/repo', resetAt).files([{ name: 'ref', oid: sha }]),
    ).rejects.toMatchObject(expected);
  });
  it.each(['OTHER', 'FORBIDDEN'])(
    'keeps an alias %s error local when other data is present',
    async (type) => {
      const fetch: PolicyFetch = async (request) => {
        const { query } = JSON.parse(new TextDecoder().decode(request.body)) as { query: string };
        return {
          status: 200,
          headers: new Headers(),
          body: Response.json({
            ...(query.includes('byteSize text')
              ? {}
              : { errors: [{ type, path: ['repository', 'a0'], message: 'secret' }] }),
            data: { repository: { a0: null, a1: { byteSize: 2, text: '{}' } } },
          }).body,
        };
      };
      const files = await tokenRest(fetch, credential, 'owner/repo', resetAt).files([
        { name: 'bad', oid: sha },
        { name: 'ok', oid: sha },
      ]);
      expect(files.map((file) => file.text)).toEqual([null, '{}']);
    },
  );
  it('uses the existing RateLimited error for GraphQL rate exhaustion', async () => {
    const fetch: PolicyFetch = async () => ({
      status: 200,
      headers: new Headers(),
      body: Response.json({ errors: [{ type: 'RATE_LIMITED' }] }).body,
    });
    await expect(
      tokenRest(fetch, credential, 'owner/repo', resetAt).files([{ name: 'ref', oid: sha }]),
    ).rejects.toBeInstanceOf(RateLimited);
  });
  it.each(['OTHER', 'FORBIDDEN'])(
    'keeps alias %s errors local when another alias is explicitly null',
    async (type) => {
      const fetch = vi.fn<PolicyFetch>(async () => ({
        status: 200,
        headers: new Headers(),
        body: Response.json({
          errors: [{ type, path: ['repository', 'a0'] }],
          data: { repository: { a0: null, a1: null } },
        }).body,
      }));
      const files = await tokenRest(fetch, credential, 'owner/repo', resetAt).files([
        { name: 'bad', oid: sha },
        { name: 'missing', oid: sha },
      ]);
      expect(files.map((file) => file.text)).toEqual([null, null]);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps a non-rate-limit alias error partial during text reads', async () => {
    const fetch: PolicyFetch = async (request) => {
      const { query } = JSON.parse(new TextDecoder().decode(request.body)) as { query: string };
      return {
        status: 200,
        headers: new Headers(),
        body: Response.json({
          ...(query.includes('byteSize text')
            ? { errors: [{ type: 'OTHER', path: ['repository', 'a0'] }] }
            : {}),
          data: {
            repository: { a0: { byteSize: 2, text: '{}' }, a1: { byteSize: 2, text: '{}' } },
          },
        }).body,
      };
    };
    const files = await tokenRest(fetch, credential, 'owner/repo', resetAt).files([
      { name: 'bad', oid: sha },
      { name: 'ok', oid: sha },
    ]);
    expect(files.map((file) => file.text)).toEqual([null, '{}']);
  });
  it.each([null, { byteSize: 2, text: '{}' }])(
    'pauses on an alias rate limit even when another alias is present (%j)',
    async (other) => {
      const fetch: PolicyFetch = async () => ({
        status: 200,
        headers: new Headers({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '9999',
        }),
        body: Response.json({
          errors: [{ type: 'RATE_LIMITED', path: ['repository', 'a0'] }],
          data: { repository: { a0: null, a1: other } },
        }).body,
      });
      const boundedReset = vi.fn(() => 1300);
      await expect(
        tokenRest(fetch, credential, 'owner/repo', boundedReset).files([
          { name: 'bad', oid: sha },
          { name: 'other', oid: sha },
        ]),
      ).rejects.toEqual(new RateLimited(1300));
      expect(boundedReset).toHaveBeenCalledWith(9999);
    },
  );
  it('does not treat an absent other alias as a partial response', async () => {
    const fetch: PolicyFetch = async () => ({
      status: 200,
      headers: new Headers(),
      body: Response.json({
        errors: [{ type: 'FORBIDDEN', path: ['repository', 'a0'] }],
        data: { repository: { a0: null } },
      }).body,
    });
    await expect(
      tokenRest(fetch, credential, 'owner/repo', resetAt).files([
        { name: 'bad', oid: sha },
        { name: 'absent', oid: sha },
      ]),
    ).rejects.toMatchObject({ code: 'http_status', status: 403 });
  });
});

it('reports the full final tag page with tag_limit_exceeded and no upstream data', async () => {
  const fetch = vi.fn<PolicyFetch>(async () => ({
    status: 200,
    headers: new Headers(),
    body: Response.json(
      Array.from({ length: 100 }, () => ({ name: 'private-tag', commit: { sha } })),
    ).body,
  }));
  await expect(
    tokenRest(fetch, credential, 'owner/repo', resetAt).refs('tags'),
  ).rejects.toMatchObject({
    code: 'tag_limit_exceeded',
    message: 'GitHub provider tag_limit_exceeded',
  });
  expect(fetch).toHaveBeenCalledTimes(500);
});
