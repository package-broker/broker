import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../db/port.js';
import { forwardNpmAudit } from './audit.js';

const MIB = 1024 * 1024;
const ctx = orgContext('org-a');

function setup(attached = true) {
  const classifyWinners = vi.fn(async (_ctx: typeof ctx, query: { keys: readonly string[] }) =>
    query.keys.map((key) => ({
      key,
      winner:
        key === 'public'
          ? { sourceId: 'proxy', sourceType: 'npmjs_proxy' as const }
          : key === '@private/name'
            ? { sourceId: 'private-source', sourceType: 'npm_registry' as const }
            : null,
    })),
  );
  const hasAttachedProxy = vi.fn(async () => attached);
  const policyFetch = vi.fn(async () => ({
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new Response('{"public":[]}').body,
  }));
  const gunzip = vi.fn((max: number) => {
    expect(max).toBe(MIB);
    return new DecompressionStream('gzip');
  });
  const dependencies = {
    catalogue: { classifyWinners },
    sources: { hasAttachedProxy },
    policyFetch,
    codecs: { gunzip },
  };
  const send = (body: string | Uint8Array, encoding?: string) =>
    forwardNpmAudit(
      new Request('https://broker.test/project/npm/-/npm/v1/security/advisories/bulk', {
        method: 'POST',
        body,
        headers: {
          authorization: 'Bearer inbound-test',
          cookie: 'session=inbound-test',
          ...(encoding ? { 'content-encoding': encoding } : {}),
        },
      }),
      ctx,
      'project',
      'request',
      dependencies,
    );
  return { send, classifyWinners, hasAttachedProxy, policyFetch, gunzip };
}

describe('npm audit', () => {
  it('classifies once and forwards only public winners, without inbound credentials', async () => {
    const s = setup();
    const response = await s.send('{"public":["1.0.0"],"@private/name":["2.0.0"]}');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"public":[]}');
    expect(s.classifyWinners).toHaveBeenCalledExactlyOnceWith(ctx, {
      projectId: 'project',
      ecosystem: 'npm',
      keys: ['public', '@private/name'],
    });
    expect(s.hasAttachedProxy).toHaveBeenCalledExactlyOnceWith(ctx, 'project', 'npm');
    expect(s.policyFetch).toHaveBeenCalledOnce();
    const [request] = s.policyFetch.mock.calls[0]! as unknown as [
      {
        body: Uint8Array;
        credential?: unknown;
        headers?: Record<string, string>;
        destinations: string[];
      },
    ];
    expect(new TextDecoder().decode(request.body)).toBe('{"public":["1.0.0"]}');
    expect(request.credential).toBeUndefined();
    expect(request.headers).toEqual({ 'content-type': 'application/json' });
    expect(request.destinations).toEqual(['https://registry.npmjs.org']);
  });

  it.each([204, 205])('passes through upstream status %i without a body', async (status) => {
    const s = setup();
    s.policyFetch.mockResolvedValueOnce({
      status,
      headers: new Headers(),
      body: null,
    });
    const response = await s.send('{}');
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
  });

  it('returns 404 without an attached proxy and performs no classification or fetch', async () => {
    const s = setup(false);
    expect((await s.send('{}')).status).toBe(404);
    expect(s.classifyWinners).not.toHaveBeenCalled();
    expect(s.policyFetch).not.toHaveBeenCalled();
  });

  it('forwards an empty object when an attached proxy has no public winners', async () => {
    const s = setup();
    expect((await s.send('{"private":["1"]}')).status).toBe(200);
    expect(
      new TextDecoder().decode(
        (s.policyFetch.mock.calls[0] as unknown as [{ body: Uint8Array }])[0].body,
      ),
    ).toBe('{}');
  });

  it('rejects 201 names before classification', async () => {
    const s = setup();
    expect(
      (
        await s.send(
          JSON.stringify(
            Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`p${i}`, ['1']])),
          ),
        )
      ).status,
    ).toBe(413);
    expect(s.classifyWinners).not.toHaveBeenCalled();
    expect(s.policyFetch).not.toHaveBeenCalled();
  });

  it('accepts 200 names', async () => {
    const s = setup();
    expect(
      (
        await s.send(
          JSON.stringify(
            Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, ['1']])),
          ),
        )
      ).status,
    ).toBe(200);
  });

  it('rejects a gzip bomb at the decompressed cap', async () => {
    const s = setup();
    expect((await s.send(gzipSync(' '.repeat(MIB + 1)), 'gzip')).status).toBe(413);
    expect(s.gunzip).toHaveBeenCalledWith(MIB);
    expect(s.policyFetch).not.toHaveBeenCalled();
  });

  it('accepts gzip JSON', async () => {
    expect((await setup().send(gzipSync('{"public":["1"]}'), 'gzip')).status).toBe(200);
  });

  it('rejects oversized uncompressed input', async () => {
    const s = setup();
    expect((await s.send(' '.repeat(MIB + 1))).status).toBe(413);
    expect(s.policyFetch).not.toHaveBeenCalled();
  });

  it.each(['null', '[]', '{', '{"public":"1"}', '{"public":[1]}'])(
    'rejects invalid bulk JSON: %s',
    async (input) => {
      const s = setup();
      expect((await s.send(input)).status).toBe(400);
      expect(s.policyFetch).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed gzip and unsupported encoding', async () => {
    expect((await setup().send('bad', 'gzip')).status).toBe(400);
    expect((await setup().send('{}', 'br')).status).toBe(415);
  });

  it.each(['network', 'status', 'size', 'stream'])(
    'maps upstream %s failure to a fixed 502 envelope',
    async (failure) => {
      const s = setup();
      s.policyFetch.mockImplementationOnce(async () => {
        if (failure === 'network') throw new Error('upstream detail');
        return {
          status: failure === 'status' ? 500 : 200,
          headers: new Headers(),
          body:
            failure === 'stream'
              ? new ReadableStream({
                  start(controller) {
                    controller.error(new Error('stream detail'));
                  },
                })
              : new Response(' '.repeat(failure === 'size' ? 4 * MIB + 1 : 1)).body,
        };
      });
      const response = await s.send('{}');
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: { code: 'upstream_error', message: 'Upstream request failed', requestId: 'request' },
      });
    },
  );
});
