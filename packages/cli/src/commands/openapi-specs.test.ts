import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { generateOpenApi } from '@package-broker/core/api/openapi';
import { openApiRoute } from '@package-broker/core/api/openapi-route';
import type { RequestContext } from '@package-broker/core/plugin';
import { run } from '../cli.js';
import { servedApiSpecs } from './openapi-specs.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('lists the management API and the auth specs with unique operation ids', () => {
  const specs = servedApiSpecs();
  const ids = specs.map((spec) => spec.api.operationId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(
    expect.arrayContaining(['getMyPermissions', 'getSession', 'listAuthProviders']),
  );
});

it('keeps the If-Match concurrency and service error family of the declared specs', () => {
  const update = servedApiSpecs().find((spec) => spec.api.operationId === 'updateProject');
  expect(update?.concurrency).toBe('if-match');
  expect(update?.service).toBe('ProjectError');
});

it('excludes exempt routes from the specs', () => {
  expect(servedApiSpecs().some((spec) => spec.path === '/_pb/openapi.json')).toBe(false);
});

it('writes exactly the body the openapi route serves for the same specs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-openapi-served-'));
  dirs.push(dir);
  const out = join(dir, 'openapi.json');
  expect(await run(['openapi', '--out', out])).toBe(0);
  const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
  const served = await openApiRoute(
    generateOpenApi(servedApiSpecs(), { title: 'Package Broker', version }),
  ).handler({} as RequestContext);
  const written = await readFile(out, 'utf8');
  expect(written).toBe(await served.text());
  const document = JSON.parse(written) as { paths: Record<string, unknown> };
  expect(Object.keys(document.paths)).toEqual(
    expect.arrayContaining(['/_pb/session', '/_pb/me/permissions']),
  );
});

it('serves the committed UI openapi.json byte for byte', async () => {
  const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
  const served = await openApiRoute(
    generateOpenApi(servedApiSpecs(), { title: 'Package Broker', version }),
  ).handler({} as RequestContext);
  const committed = await readFile(new URL('../../../ui/openapi.json', import.meta.url), 'utf8');
  expect(committed).toBe(await served.text());
});
