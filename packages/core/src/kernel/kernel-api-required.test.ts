import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { RouteDefinition } from '../plugin.js';
import { createKernel } from './kernel.js';
import type { KernelOptions } from './kernel.js';
import { KernelConfigError } from './registry.js';
import { createSetupUiRoutes, createUiRoutes } from './ui-routes.js';

function options(
  coreRoutes: readonly RouteDefinition[],
  ecosystemRoutes: readonly RouteDefinition[] = [],
): KernelOptions {
  return {
    platform: 'node',
    plugins: [],
    ports: {
      organizations: { get: () => Promise.resolve(null) },
      clock: fixedClock('2026-10-20T00:00:00.000Z'),
      ids: { ulid: () => '01JA0000000000000000000000' },
    },
    resolveOrg: () => Promise.resolve(orgContext('org-1')),
    health: () => Promise.resolve(true),
    log: () => undefined,
    coreRoutes,
    ecosystemRoutes,
  };
}

function route(
  path: string,
  method: RouteDefinition['method'] = 'GET',
  extra: Partial<RouteDefinition> = {},
): RouteDefinition {
  return { method, path, permission: null, handler: () => new Response('ok'), ...extra };
}

async function problemsOf(kernelOptions: KernelOptions): Promise<readonly string[]> {
  const error: unknown = await createKernel(kernelOptions).then(
    () => null,
    (caught: unknown) => caught,
  );
  return error instanceof KernelConfigError ? error.problems : [];
}

describe('createKernel api requirement for core routes', () => {
  it('rejects an undocumented core route under /_pb/', async () => {
    expect(await problemsOf(options([route('/_pb/undocumented')]))).toEqual([
      'core route GET /_pb/undocumented: api is required under /_pb/',
    ]);
  });

  it('accepts a documented core route under /_pb/', async () => {
    const documented = route('/_pb/documented', 'GET', {
      api: {
        operationId: 'documented',
        summary: 'Documented',
        tags: ['fixture'],
        responses: { 200: null },
      },
    });
    expect(await problemsOf(options([documented]))).toEqual([]);
  });

  it.each([
    ['GET', '/_pb/ui'],
    ['GET', '/_pb/ui/'],
    ['GET', '/_pb/ui/:file'],
    ['POST', '/_pb/hooks/github/:credentialId'],
    ['GET', '/_pb/mcp'],
    ['POST', '/_pb/mcp'],
    ['GET', '/_pb/openapi.json'],
  ] as const)('accepts the exempt core route %s %s without an api slot', async (method, path) => {
    expect(await problemsOf(options([route(path, method)]))).toEqual([]);
  });

  it('requires API documentation for the obsolete UI asset route', async () => {
    expect(await problemsOf(options([route('/_pb/ui/assets/:file')]))).toEqual([
      'core route GET /_pb/ui/assets/:file: api is required under /_pb/',
    ]);
  });

  it('rejects an undocumented route next to an exempt path', async () => {
    expect(await problemsOf(options([route('/_pb/ui/assets/:file/raw')]))).toEqual([
      'core route GET /_pb/ui/assets/:file/raw: api is required under /_pb/',
    ]);
  });

  it('mounts the kernel UI routes without runtime remapping', async () => {
    const ui = createUiRoutes(
      { manifest: async () => null, read: async () => null },
      { publicOrigin: 'https://broker.test' },
    );
    await expect(createKernel(options(ui))).resolves.toMatchObject({ coreRoutes: ui });
  });

  it('leaves undocumented ecosystem routes to their own validation', async () => {
    expect(await problemsOf(options([], [route('/:project/packages.json')]))).toEqual([]);
  });
});

describe('setup UI routes and the api requirement', () => {
  it('accepts the setup routes as built, without an api slot', async () => {
    const setup = createSetupUiRoutes(
      { manifest: async () => null, read: async () => null },
      { publicOrigin: 'https://broker.test' },
    );
    expect(setup.map((definition) => definition.path)).toEqual([
      '/_pb/ui/setup/document',
      '/_pb/ui/setup/assets/:file',
    ]);
    expect(await problemsOf(options(setup))).toEqual([]);
  });

  it('rejects a sibling of the setup paths that is not on the exempt list', async () => {
    expect(await problemsOf(options([route('/_pb/ui/setup/assets/:file/raw')]))).toEqual([
      'core route GET /_pb/ui/setup/assets/:file/raw: api is required under /_pb/',
    ]);
    expect(await problemsOf(options([route('/_pb/ui/setup/other')]))).toEqual([
      'core route GET /_pb/ui/setup/other: api is required under /_pb/',
    ]);
  });
});
