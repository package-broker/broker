import { expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import { createAuthorizationEngine, patValidationGate } from '../../authz/engine.js';
import { orgContext } from '../../db/port.js';
import type { SourceRecord } from '../../db/source.js';
import { fixedClock } from '../../ids.js';
import { collectRegistrations } from '../../kernel/registry.js';
import { registerCoreJob } from '../../runtime/core-jobs.js';
import type { BlobStore } from '../../platform/blob.js';
import type { Cache } from '../../platform/cache.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { defineApi } from '../route.js';
import { generateOpenApi } from '../openapi.js';
import { SOURCE_PACKAGE_API_SPEC } from './sources-schemas.js';
import type { SourcePackageProbe } from '../../ingest/source-package.js';
import type { SourcePackageStore } from './source-packages.js';
import { packageSyncEnqueueInput, PACKAGE_SYNC_JOB_TYPE } from '../../ingest/package-sync-job.js';
import { sourcePackageRoutes } from './source-packages.js';

const ORIGIN = 'https://broker.test';
const PROJECT = '01JA0000000000000000000001';
const OTHER_PROJECT = '01JA0000000000000000000002';
const SOURCE = '01JA0000000000000000000003';
const SESSION = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const clock = fixedClock('2026-10-22T00:00:00.000Z');
const path = `/_pb/projects/demo/sources/${SOURCE}/packages`;

async function fixture(
  options: {
    permissions?: readonly string[];
    ecosystem?: 'composer' | 'npm';
    type?: SourceRecord['type'];
    present?: boolean;
    probeResult?: Awaited<ReturnType<SourcePackageProbe>>;
    requestResult?: Awaited<ReturnType<SourcePackageStore['request']>>;
    platform?: boolean;
    projectState?: 'absent' | 'archived' | 'invisible';
    sourceState?: 'absent' | 'foreign' | 'own';
    attached?: boolean;
  } = {},
) {
  let sequence = 0;
  const ids = { ulid: () => `01JB${String(++sequence).padStart(22, '0')}` };
  const log = vi.fn();
  const visible = options.projectState === undefined;
  const projects = {
    get: vi.fn(async () =>
      options.projectState === 'absent' || options.projectState === 'invisible'
        ? null
        : {
            status:
              options.projectState === 'archived' ? ('archived' as const) : ('active' as const),
          },
    ),
  };
  const row = (projectId: string | null) =>
    ({
      id: SOURCE,
      projectId,
      name: 'shared',
      ecosystem: options.ecosystem ?? 'composer',
      type: options.type ?? 'packagist_proxy',
    }) as SourceRecord;
  const sources = {
    get: vi.fn(async () =>
      options.sourceState === 'absent'
        ? null
        : row(
            options.sourceState === 'foreign'
              ? OTHER_PROJECT
              : options.sourceState === 'own'
                ? PROJECT
                : null,
          ),
    ),
  };
  const store = {
    present: vi.fn<SourcePackageStore['present']>().mockResolvedValue(options.present ?? false),
    request: vi
      .fn<SourcePackageStore['request']>()
      .mockResolvedValue(options.requestResult ?? 'accepted'),
  };
  const probe = vi.fn<SourcePackageProbe>().mockResolvedValue(options.probeResult ?? 'found');
  const enqueue = vi.fn().mockResolvedValue({ id: 'job-1', created: true });
  const projectSources = {
    list: vi.fn(async () => (options.attached === false ? [] : [{ sourceId: SOURCE }])),
  };
  const permissions = options.permissions ?? ['project:read', 'project:sources:write'];
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: sourcePackageRoutes({
      sources,
      store,
      probe,
      projectSources,
      projects,
      ids,
      clock,
      clientIp: () => '203.0.113.7',
    }),
    ports: { organizations: { get: async () => null }, ids, clock },
    ...(options.platform === false
      ? {}
      : {
          registration: collectRegistrations([], {
            coreJobs: [
              registerCoreJob({
                name: 'package-sync',
                version: 1,
                validate: (input) => input,
                handler: async () => {},
              }),
            ],
          }),
          platformServices: {
            blob: {} as BlobStore,
            cache: {} as Cache,
            jobStore: { enqueue, status: async () => null },
          },
        }),
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: 'user-1' },
          identity: null,
          protectedHolder: false,
          project: input.boundary === 'project' && visible ? { id: PROJECT } : null,
          organizationPermissions: [],
          projectPermissions: options.projectState === 'invisible' ? [] : permissions,
        }),
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
        nowMs: () => clock.now().getTime(),
        dispatch: (run) => {
          void run();
        },
        log,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (method: string, target = path, body?: unknown) =>
    app.fetch(
      new Request(ORIGIN + target, {
        method,
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${SESSION}`,
          'x-csrf-token': CSRF,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { request, store, probe, enqueue, projectSources, sources, projects, log };
}

it('declares a strict API spec with the same permission as source sync', () => {
  expect(() => defineApi(SOURCE_PACKAGE_API_SPEC)).not.toThrow();
  expect(SOURCE_PACKAGE_API_SPEC.permission).toBe('project:sources:write');
});

it.each([
  ['composer', 'packagist_proxy', 'acme/widget'],
  ['npm', 'npmjs_proxy', 'widget'],
  ['npm', 'npmjs_proxy', '@acme/widget'],
  ['npm', 'npm_registry', '@private/widget'],
] as const)('queues %s from the selected %s source', async (ecosystem, type, name) => {
  const f = await fixture({ ecosystem, type });
  const response = await f.request('POST', path, { name });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ name, state: 'queued', jobId: 'job-1' });
  expect(f.sources.get).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), SOURCE);
  expect(f.projectSources.list).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), {
    projectId: PROJECT,
  });
  expect(f.store.present).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), SOURCE, name);
  expect(f.probe).toHaveBeenCalledExactlyOnceWith(
    orgContext('org-1'),
    SOURCE,
    name,
    expect.any(AbortSignal),
  );
  expect(f.store.request).toHaveBeenNthCalledWith(
    2,
    orgContext('org-1'),
    expect.objectContaining({ userId: 'user-1', sessionId: 'session-1' }),
    {
      projectId: PROJECT,
      sourceId: SOURCE,
      audit: expect.objectContaining({
        action: 'source.package_requested',
        target: { type: 'source', id: SOURCE },
        projectId: PROJECT,
        sourceIp: '203.0.113.7',
        payloadJson: expect.any(String),
      }),
    },
  );
  expect(f.store.request).toHaveBeenCalledTimes(2);
  expect(f.store.request).toHaveBeenNthCalledWith(
    1,
    orgContext('org-1'),
    expect.objectContaining({ userId: 'user-1' }),
    { projectId: PROJECT, sourceId: SOURCE },
  );
  const audit = f.store.request.mock.calls[1]?.[2].audit;
  expect(JSON.parse(audit!.payloadJson).changes).toEqual({ package_name: { new: name } });
  expect(f.store.request.mock.invocationCallOrder[0]).toBeLessThan(
    f.enqueue.mock.invocationCallOrder[0]!,
  );
  expect(f.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
    f.store.request.mock.invocationCallOrder[1]!,
  );
  expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(
    orgContext('org-1'),
    expect.objectContaining({
      type: PACKAGE_SYNC_JOB_TYPE,
      projectId: PROJECT,
      payloadJson: JSON.stringify({ key: name, sourceId: SOURCE }),
      resourceKey: await packageSyncEnqueueInput({ sourceId: SOURCE, key: name }, 'unused').then(
        (x) => x.resourceKey,
      ),
    }),
  );
});

it('returns 200 without upstream or queue work when already complete', async () => {
  const f = await fixture({ present: true });
  const response = await f.request('POST', path, { name: 'acme/widget' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ name: 'acme/widget', state: 'present' });
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.store.request).toHaveBeenCalledOnce();
  expect(f.store.request.mock.calls[0]?.[2].audit).toBeUndefined();
});

it('normalizes Composer names and answers repeated completed requests with 200', async () => {
  const f = await fixture();
  expect((await f.request('POST', path, { name: 'Acme/Widget' })).status).toBe(202);
  expect(f.probe.mock.calls[0]?.[2]).toBe('acme/widget');
  f.store.present.mockResolvedValue(true);
  expect((await f.request('POST', path, { name: 'Acme/Widget' })).status).toBe(200);
  expect(f.enqueue).toHaveBeenCalledTimes(1);
});

it('returns package_not_found for a definitive upstream 404', async () => {
  const f = await fixture({ probeResult: 'not_found' });
  const response = await f.request('POST', path, { name: 'acme/missing' });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    error: { code: 'package_not_found', message: 'Package not found' },
  });
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.store.request).not.toHaveBeenCalled();
});

it.each(['vcs', 'composer_repository', 'hosted'] as const)(
  'rejects source kind %s',
  async (type) => {
    const f = await fixture({ type });
    const response = await f.request('POST', path, { name: 'acme/widget' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_source_kind' } });
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  },
);

it.each([
  { attached: false },
  { sourceState: 'absent' },
  { sourceState: 'foreign' },
  { projectState: 'absent' },
  { projectState: 'archived' },
  { projectState: 'invisible' },
] as const)('hides unavailable targets: %j', async (options) => {
  const f = await fixture(options);
  expect((await f.request('POST', path, { name: 'acme/widget' })).status).toBe(404);
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
});

it('requires project source write before querying sources or upstream', async () => {
  const f = await fixture({ permissions: ['project:read', 'project:sources:read'] });
  expect((await f.request('POST', path, { name: 'acme/widget' })).status).toBe(403);
  expect(f.sources.get).not.toHaveBeenCalled();
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
});

it.each([
  ['composer', 'widget'],
  ['composer', 'https://user:secret@example.test/pkg'],
  ['composer', '../acme/pkg'],
  ['npm', '@scope'],
  ['npm', 'node_modules'],
  ['npm', '@scope/../pkg'],
  ['npm', 'a'.repeat(215)],
] as const)('rejects invalid %s name without echoing it', async (ecosystem, name) => {
  const f = await fixture({
    ecosystem,
    type: ecosystem === 'npm' ? 'npmjs_proxy' : 'packagist_proxy',
  });
  const response = await f.request('POST', path, { name });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain(name);
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
});

it.each([{}, { name: '' }, { name: 1 }, { name: 'acme/widget', extra: true }])(
  'rejects invalid body %j',
  async (body) => {
    const f = await fixture();
    expect((await f.request('POST', path, body)).status).toBe(400);
    expect(f.probe).not.toHaveBeenCalled();
  },
);

it.each([
  ['forbidden', 403],
  ['not_found', 404],
  ['source_paused', 409],
  ['unavailable', 503],
] as const)('does not enqueue after a fenced %s refusal', async (requestResult, status) => {
  const f = await fixture({ requestResult });
  expect((await f.request('POST', path, { name: 'acme/widget' })).status).toBe(status);
  expect(f.enqueue).not.toHaveBeenCalled();
});

it.each([
  ['unsupported_package', 400],
  ['unavailable', 503],
  ['upstream_refused', 502],
  ['bad_gateway', 502],
] as const)('maps upstream %s to a fixed error', async (probeResult, status) => {
  const f = await fixture({ probeResult });
  expect((await f.request('POST', path, { name: 'acme/widget' })).status).toBe(status);
  expect(f.enqueue).not.toHaveBeenCalled();
});

it('does not expose upstream exceptions', async () => {
  const f = await fixture();
  f.probe.mockRejectedValue(new Error('https://user:secret@example.test'));
  const response = await f.request('POST', path, { name: 'acme/widget' });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('secret');
  expect(JSON.stringify(f.log.mock.calls)).not.toContain('secret');
  expect(f.enqueue).not.toHaveBeenCalled();
});

it('requires a queue for new packages', async () => {
  const f = await fixture({ platform: false });
  expect((await f.request('POST', path, { name: 'acme/widget' })).status).toBe(503);
  expect(f.probe).not.toHaveBeenCalled();
});

it('does not expose queue exceptions', async () => {
  const f = await fixture();
  f.enqueue.mockRejectedValue(new Error('https://user:secret@example.test'));
  const response = await f.request('POST', path, { name: 'acme/widget' });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('secret');
  expect(JSON.stringify(f.log.mock.calls)).not.toContain('secret');
  expect(f.store.request).toHaveBeenCalledOnce();
  expect(f.store.request.mock.calls[0]?.[2].audit).toBeUndefined();
});

it('queues an attached project-owned proxy', async () => {
  const f = await fixture({ sourceState: 'own' });
  expect((await f.request('POST', path, { name: 'acme/widget' })).status).toBe(202);
  expect(f.enqueue).toHaveBeenCalledOnce();
});

it('refuses an unattached project-owned proxy', async () => {
  const f = await fixture({ sourceState: 'own', attached: false });
  expect((await f.request('POST', path, { name: 'acme/widget' })).status).toBe(404);
  expect(f.enqueue).not.toHaveBeenCalled();
});

it('allows project source write to request an attached organization proxy (DEC-9)', async () => {
  const f = await fixture({ permissions: ['project:sources:write'] });
  expect((await f.request('POST', path, { name: 'acme/widget' })).status).toBe(202);
  expect(f.enqueue).toHaveBeenCalledOnce();
});

it('requires the selected source attachment even when another source is attached', async () => {
  const f = await fixture();
  f.projectSources.list.mockResolvedValue([{ sourceId: '01JA0000000000000000000004' }]);
  expect((await f.request('POST', path, { name: 'acme/widget' })).status).toBe(404);
  expect(f.store.request).not.toHaveBeenCalled();
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
});

it.each([false, true])(
  'uses the legacy npm key and display name (present: %s)',
  async (present) => {
    const f = await fixture({ ecosystem: 'npm', type: 'npmjs_proxy', present });
    const response = await f.request('POST', path, { name: 'JSONStream' });
    expect(response.status).toBe(present ? 200 : 202);
    expect(await response.json()).toMatchObject({ name: 'JSONStream' });
    const key = '!j!s!o!n!stream';
    expect(f.store.present).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), SOURCE, key);
    if (!present) {
      expect(f.probe).toHaveBeenCalledWith(
        orgContext('org-1'),
        SOURCE,
        key,
        expect.any(AbortSignal),
      );
      expect(JSON.parse(f.enqueue.mock.calls[0]![1].payloadJson)).toEqual({
        sourceId: SOURCE,
        key,
      });
      expect(JSON.parse(f.store.request.mock.calls[1]![2].audit!.payloadJson).changes).toEqual({
        package_name: { new: 'JSONStream' },
      });
    }
  },
);

it('returns a fixed 400 unsupported_package when the private registry cannot serve the name', async () => {
  const f = await fixture({
    ecosystem: 'npm',
    type: 'npm_registry',
    probeResult: 'unsupported_package',
  });
  const response = await f.request('POST', path, { name: '@outside/widget' });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: 'unsupported_package', message: 'Unsupported package' },
  });
  expect(f.store.request).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
});

it('documents DEC-9 and every route error with the shared OpenAPI error schema', () => {
  expect(SOURCE_PACKAGE_API_SPEC.service).toBe('SourceError');
  const operation = generateOpenApi([SOURCE_PACKAGE_API_SPEC], {
    title: 'Package Broker',
    version: '2.0.0',
  }).paths['/_pb/projects/{project}/sources/{source}/packages']!.post!;
  expect(operation.summary).toContain('project:sources:write');
  expect(operation.summary).toContain('organization proxy attached to the project');
  for (const status of [400, 403, 404, 409, 502, 503] as const) {
    expect(SOURCE_PACKAGE_API_SPEC.api.responses[status]).toBeNull();
    expect(operation.responses).toMatchObject({
      [status]: {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
    });
  }
});
