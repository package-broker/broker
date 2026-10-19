import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  codecOpRunnerSource,
  describeCodecContract,
  type CodecOutcome,
  type CodecSpec,
} from '@package-broker/db-sqlite/contract/codec-contract';

const read = (relative: string): string =>
  stripTypeScriptTypes(readFileSync(new URL(relative, import.meta.url), 'utf8'));

const adapter = read('./workers-codec.ts').replaceAll(
  "'@package-broker/core/platform/codec'",
  "'./codec-core.mjs'",
);
const core = read('../../../core/src/platform/codec.ts');

const WORKER = `
import { workersCodecs } from './workers-codec.mjs';
import { runOp } from './runner.mjs';

export default {
  async fetch(request) {
    return Response.json(await runOp(workersCodecs, await request.json()));
  },
};
`;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      { type: 'ESModule', path: 'worker.mjs', contents: WORKER },
      { type: 'ESModule', path: 'runner.mjs', contents: codecOpRunnerSource },
      { type: 'ESModule', path: 'workers-codec.mjs', contents: adapter },
      { type: 'ESModule', path: 'codec-core.mjs', contents: core },
    ],
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
  } as unknown as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

describeCodecContract('workers', async (spec: CodecSpec) => {
  const response = await mf.dispatchFetch('http://codec.test/', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  return (await response.json()) as CodecOutcome;
});
