import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { afterAll, expect, it } from 'vitest';
import type { Codecs } from '../../platform/codec.js';
import { archive, entry, stream } from '../../test-support/npm-publish.js';
import { packTarball } from './tarball-pack.js';

const read = (path: string) =>
  stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'), { mode: 'strip' });
const requireRuntime = createRequire(
  new URL('../../../../runtime-cloudflare/package.json', import.meta.url),
);
const { Miniflare, convertV4MiniflareOptions } = requireRuntime('miniflare') as {
  Miniflare: new (options: object) => {
    dispatchFetch(url: string, options: RequestInit): Promise<Response>;
    dispose(): Promise<void>;
  };
  convertV4MiniflareOptions(options: object): object;
};
const moduleCode = (file: string) =>
  read('./' + file + '.ts').replaceAll(/from '(\.\/[a-z-]+)\.js'/g, "from '$1.mjs'");
const codecCore = read('../../platform/codec.ts');
const codecURL = 'data:text/javascript;base64,' + Buffer.from(codecCore).toString('base64');
const nodeCode = read('../../../../runtime-node/src/codec/node-codec.ts').replaceAll(
  '@package-broker/core/platform/codec',
  codecURL,
);
const nodeModule = (await import(
  /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(nodeCode).toString('base64')
)) as { nodeCodecs: Codecs };
const workerOptions = convertV4MiniflareOptions({
  modules: [
    {
      type: 'ESModule',
      path: 'worker.mjs',
      contents: `
      import { packTarball } from './tarball-pack.mjs';
      import { workersCodecs } from './workers-codec.mjs';
      export default { async fetch(request) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const open = async () => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
        try {
          const packed = await packTarball({ open, codecs: workersCodecs });
          const bytes = new Uint8Array(await new Response(packed.body).arrayBuffer());
          return Response.json({ files: packed.files, body: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) });
        } catch (error) { return Response.json({ code: error.code, detail: error.detail }, { status: 400 }); }
      } };
    `,
    },
    ...['tarball-pack', 'tarball-walk', 'packlist-rules', 'gzip-frame'].map((file) => ({
      type: 'ESModule',
      path: file + '.mjs',
      contents: moduleCode(file),
    })),
    { type: 'ESModule', path: 'codec-core.mjs', contents: codecCore },
    {
      type: 'ESModule',
      path: 'workers-codec.mjs',
      contents: read('../../../../runtime-cloudflare/src/codec/workers-codec.ts').replaceAll(
        '@package-broker/core/platform/codec',
        './codec-core.mjs',
      ),
    },
  ],
  compatibilityDate: '2026-10-01',
  compatibilityFlags: ['nodejs_compat'],
});
let mf: InstanceType<typeof Miniflare> | undefined;
const worker = () => (mf ??= new Miniflare(workerOptions));
afterAll(async () => {
  await mf?.dispose();
});

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../../../fixtures/npm-repack/repositories.json', import.meta.url),
    'utf8',
  ),
) as {
  id: string;
  manifest: Record<string, unknown>;
  files: Record<string, string>;
  expected: string[];
  refusal?: string;
}[];
it.each(fixtures)(
  'packs repository identically with the Node and Workers codec ports: $id',
  async (fixture) => {
    const files = {
      ...fixture.files,
      'package.json': JSON.stringify({
        name: 'fixture-package',
        version: '1.0.0',
        ...fixture.manifest,
      }),
    };
    const bytes = archive(
      ...Object.entries(files).map(([path, body]) => entry('repo/' + path, body)),
    );
    if (fixture.refusal) {
      await expect(
        packTarball({ open: async () => stream(bytes), codecs: nodeModule.nodeCodecs }),
      ).rejects.toMatchObject({ code: 'candidate_skipped', detail: fixture.refusal });
      const response = await worker().dispatchFetch('http://localhost/pack', {
        method: 'POST',
        body: bytes,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: 'candidate_skipped', detail: fixture.refusal });
      return;
    }
    const node = await packTarball({
      open: async () => stream(bytes),
      codecs: nodeModule.nodeCodecs,
    });
    const response = await worker().dispatchFetch('http://localhost/pack', {
      method: 'POST',
      body: bytes,
    });
    expect(response.status, fixture.id).toBe(200);
    const result = (await response.json()) as { files: string[]; body: string };
    expect(node.files, fixture.id).toEqual(fixture.expected);
    expect(result.files, fixture.id).toEqual(fixture.expected);
    expect(gunzipSync(Buffer.from(result.body, 'base64')), fixture.id).toEqual(
      gunzipSync(Buffer.from(await new Response(node.body).arrayBuffer())),
    );
  },
  30000,
);
it('refuses the same unsafe archive on Node and Workers', async () => {
  const bytes = archive(entry('repo/package.json', '{}'), entry('repo/../escape'));
  await expect(
    packTarball({ open: async () => stream(bytes), codecs: nodeModule.nodeCodecs }),
  ).rejects.toMatchObject({ code: 'invalid_tarball', detail: 'path_segments' });
  const response = await worker().dispatchFetch('http://localhost/pack', {
    method: 'POST',
    body: bytes,
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ code: 'invalid_tarball', detail: 'path_segments' });
});

it('uses both actual codec ports without host networking', async () => {
  const workerCode = read('../../../../runtime-cloudflare/src/codec/workers-codec.ts').replaceAll(
    '@package-broker/core/platform/codec',
    codecURL,
  );
  const workerModule = (await import(
    /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(workerCode).toString('base64')
  )) as { workersCodecs: Codecs };
  const bytes = archive(
    entry('repo/package.json', '{"name":"fixture-package","version":"1.0.0"}'),
    entry('repo/.npmignore', 'excluded'),
    entry('repo/kept', 'yes'),
    entry('repo/excluded', 'no'),
  );
  const node = await packTarball({
    open: async () => stream(bytes),
    codecs: nodeModule.nodeCodecs,
  });
  const workerResult = await packTarball({
    open: async () => stream(bytes),
    codecs: workerModule.workersCodecs,
  });
  expect(node.files).toEqual(['kept', 'package.json']);
  expect(workerResult.files).toEqual(node.files);
  expect(gunzipSync(Buffer.from(await new Response(node.body).arrayBuffer()))).toEqual(
    gunzipSync(Buffer.from(await new Response(workerResult.body).arrayBuffer())),
  );
});
