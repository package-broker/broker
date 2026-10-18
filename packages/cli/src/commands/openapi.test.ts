import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { generateOpenApi } from '@package-broker/core/api/openapi';
import { openApiRoute } from '@package-broker/core/api/openapi-route';
import type { ApiRouteSpec } from '@package-broker/core/api/route';
import type { RequestContext } from '@package-broker/core/plugin';
import { run } from '../cli.js';
import { openapiCommand } from './openapi.js';

const specs: readonly ApiRouteSpec[] = [
  {
    method: 'GET',
    path: '/_pb/widgets',
    permission: 'org:read',
    boundary: 'organization',
    api: {
      operationId: 'listWidgets',
      summary: 'List widgets',
      tags: ['widgets'],
      responses: { 204: null },
    },
  },
  {
    method: 'GET',
    path: '/_pb/ping',
    permission: null,
    api: { operationId: 'ping', summary: 'Ping', tags: ['health'], responses: { 204: null } },
  },
];
const info = { title: 'Fixture broker', version: '1.2.3' };
const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'pb-openapi-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('writes exactly the served body for two route specs without a trailing newline', async () => {
  const out = join(await directory(), 'openapi.json');
  const write = vi.fn(async (path: string, bytes: string) => {
    await writeFile(path, bytes);
  });
  const provider = vi.fn(() => specs);
  expect(await openapiCommand({ specs: provider, info, write })(out)).toBe(0);
  const response = await openApiRoute(generateOpenApi(specs, info)).handler({} as RequestContext);
  const body = await response.text();
  expect(await readFile(out, 'utf8')).toBe(body);
  expect(write).toHaveBeenCalledExactlyOnceWith(out, body);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(body.endsWith('\n')).toBe(false);
});

it('rejects a missing --out with a fixed message and writes nothing', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const write = vi.fn();
  expect(await openapiCommand({ specs: () => specs, info, write })(undefined)).toBe(2);
  expect(write).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledExactlyOnceWith('openapi_out_required');
  expect(await run(['openapi'])).toBe(2);
});

it('rejects an existing directory with a fixed message and writes nothing', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const out = await directory();
  const write = vi.fn();
  expect(await openapiCommand({ specs: () => specs, info, write })(out)).toBe(2);
  expect(write).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledExactlyOnceWith('openapi_out_is_directory');
  expect(await readdir(out)).toEqual([]);
});

it('registers the default provider and exits 1 with no_api_specs without creating a file', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const dir = await directory();
  expect(await run(['openapi', '--out', join(dir, 'openapi.json')])).toBe(1);
  expect(error).toHaveBeenCalledExactlyOnceWith('no_api_specs');
  expect(await readdir(dir)).toEqual([]);
});

it('reports write failures with a fixed message', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const write = vi.fn().mockRejectedValue(new Error('private request data'));
  expect(
    await openapiCommand({ specs: () => specs, info, write })(join(await directory(), 'out')),
  ).toBe(1);
  expect(error).toHaveBeenCalledExactlyOnceWith('openapi_failed');
});
