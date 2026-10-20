import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createWorkersAssets } from './assets.js';

const manifest = {
  version: 1,
  entry: 'index.html',
  files: { 'index.html': { contentType: 'text/html', bytes: 3 } },
};
function fake(body: unknown = manifest, response: () => Response = () => new Response('abc')) {
  const fetch = vi.fn(async (input: Request | string) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    return url.pathname === '/manifest.json' ? new Response(JSON.stringify(body)) : response();
  });
  return { fetch };
}

describe('Workers assets', () => {
  it('uses the fixed internal host and manual redirects for every binding call', async () => {
    const binding = fake();
    const assets = await createWorkersAssets(binding);
    expect(await assets.read('index.html')).toEqual({
      body: new TextEncoder().encode('abc'),
      contentType: 'text/html',
      bytes: 3,
    });
    expect(binding.fetch).toHaveBeenCalledTimes(2);
    for (const [input] of binding.fetch.mock.calls) {
      expect(input).toBeInstanceOf(Request);
      const request = input as Request;
      expect(new URL(request.url).host).toBe('assets.internal');
      expect(request.redirect).toBe('manual');
    }
  });
  it.each(['..', '__proto__'])('refuses manifest name %s at startup', async (name) => {
    const body = {
      ...manifest,
      files: { ...manifest.files, [name]: { contentType: 'text/html', bytes: 3 } },
    };
    await expect(createWorkersAssets(fake(body))).rejects.toThrow('UI manifest is invalid');
  });
  it('refuses an unlisted manifest entry at startup', async () => {
    await expect(createWorkersAssets(fake({ ...manifest, entry: 'missing.html' }))).rejects.toThrow(
      'UI manifest is invalid',
    );
  });
  it.each(['missing.html', '//evil.example/', 'toString'])(
    'never requests unlisted name %s',
    async (name) => {
      const binding = fake();
      const assets = await createWorkersAssets(binding);
      binding.fetch.mockClear();
      expect(await assets.read(name)).toBeNull();
      expect(binding.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([201, 202, 204, 206, 299, 300, 301, 302, 303, 304, 307, 308, 399])(
    'refuses status %s',
    async (status) => {
      const empty = {
        ...manifest,
        files: { 'index.html': { contentType: 'text/html', bytes: 0 } },
      };
      const assets = await createWorkersAssets(fake(empty, () => new Response(null, { status })));
      expect(await assets.read('index.html')).toBeNull();
    },
  );
  it('refuses unsuccessful responses', async () => {
    const assets = await createWorkersAssets(
      fake(manifest, () => new Response('abc', { status: 404 })),
    );
    expect(await assets.read('index.html')).toBeNull();
  });
  it('refuses a body length mismatch despite a matching content-length header', async () => {
    const assets = await createWorkersAssets(
      fake(manifest, () => new Response('abcd', { headers: { 'content-length': '3' } })),
    );
    expect(await assets.read('index.html')).toBeNull();
  });
  it('refuses a disagreeing content-length before reading', async () => {
    const response = new Response('abc', { headers: { 'content-length': '4' } });
    const getReader = vi.spyOn(response.body!, 'getReader');
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    const assets = await createWorkersAssets(fake(manifest, () => response));
    expect(await assets.read('index.html')).toBeNull();
    expect(getReader).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it('caps streamed reads at manifest bytes plus one and cancels overflow', async () => {
    let produced = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          produced++;
          if (produced <= 10) controller.enqueue(Uint8Array.of(97));
          else controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const assets = await createWorkersAssets(fake(manifest, () => new Response(stream)));
    expect(await assets.read('index.html')).toBeNull();
    expect(produced).toBe(4);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('refuses a redirected manifest at startup', async () => {
    await expect(
      createWorkersAssets({ fetch: async () => new Response(null, { status: 302 }) }),
    ).rejects.toThrow('UI manifest is invalid');
  });
  it('documents assets after the Worker in the operator template', async () => {
    const text = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
    expect(text).toContain(
      '# [assets]\n# binding = "ASSETS"\n# directory = "../../.pb/cloudflare/assets"\n# run_worker_first = true\n# html_handling = "none"\n# not_found_handling = "none"',
    );
  });
});

async function runMiniflare(assetConfig: Record<string, string>, workerBody: string) {
  const adapter = stripTypeScriptTypes(
    await readFile(new URL('./assets.ts', import.meta.url), 'utf8'),
  ).replaceAll('@package-broker/core/platform/ui-manifest', './ui-manifest.mjs');
  const parser = stripTypeScriptTypes(
    await readFile(new URL('../../core/src/platform/ui-manifest.ts', import.meta.url), 'utf8'),
  );
  const directory = await mkdtemp(join(tmpdir(), 't535-workers-'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'index.html'), 'abc');
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'broker',
          compatibilityDate: '2026-10-01',
          modules: [
            {
              type: 'ESModule',
              path: 'worker.mjs',
              contents: `import { createWorkersAssets } from './assets.mjs'; export default { async fetch(request, env) { ${workerBody} } };`,
            },
            { type: 'ESModule', path: 'assets.mjs', contents: adapter },
            { type: 'ESModule', path: 'ui-manifest.mjs', contents: parser },
          ],
          assets: {
            directory,
            binding: 'ASSETS',
            run_worker_first: true,
            routerConfig: { has_user_worker: true },
            assetConfig,
          },
        },
      ],
    } as unknown as Parameters<typeof convertV4MiniflareOptions>[0]),
  );
  try {
    const response = await mf.dispatchFetch('https://broker.example/index.html', {
      redirect: 'manual',
    });
    return { response, text: await response.text() };
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

const readIndex =
  "const assets = await createWorkersAssets(env.ASSETS); const asset = await assets.read('index.html'); if (asset === null) return new Response('refused', { status: 502 }); return new Response(asset.body, { headers: { 'content-type': asset.contentType } });";

it('Miniflare integration: serves index.html bytes through the assets binding without redirects', async () => {
  const { response, text } = await runMiniflare(
    { html_handling: 'none', not_found_handling: 'none' },
    readIndex,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('location')).toBeNull();
  expect(text).toBe('abc');
  expect(response.headers.get('content-type')).toBe('text/html');
});

it('Miniflare integration: refuses index.html under the default html_handling, which redirects', async () => {
  const { response, text } = await runMiniflare({ not_found_handling: 'none' }, readIndex);
  expect(response.status).toBe(502);
  expect(text).toBe('refused');
});

it('Miniflare integration: the default html_handling answers index.html with a redirect', async () => {
  const { response } = await runMiniflare(
    { not_found_handling: 'none' },
    "const r = await env.ASSETS.fetch(new Request('https://assets.internal/index.html', { redirect: 'manual' })); return new Response(null, { status: 200, headers: { 'x-status': String(r.status), 'x-length': String(r.headers.get('content-length')) } });",
  );
  expect(Number(response.headers.get('x-status'))).toBeGreaterThanOrEqual(300);
  expect(Number(response.headers.get('x-status'))).toBeLessThan(400);
});
