import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import { ServicesContext } from '../auth.js';
import { buildListFilterHash } from '../page-hash.js';
import {
  PackageVersions,
  PackagesView,
  PackagesPage,
  buildPackagesHash,
  createPackagesController,
  packageActions,
  parsePackagesHash,
  type PackageItem,
  type PackageAccess,
  type VersionItem,
} from './packages.js';

const projectId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const packageId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const versionId = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const sourceId = '01ARZ3NDEKTSV4RRFFQ69G5FAY';
const own: PackageItem = {
  id: packageId,
  name: '@example/library',
  ecosystem: 'npm',
  latestVersion: '1.2.3',
  status: 'active',
  source: { id: sourceId, name: 'Project source', type: 'vcs', projectId },
  versionCount: 4,
  lastSyncedAt: '2026-10-17T12:00:00Z',
};
const shared: PackageItem = {
  ...own,
  id: sourceId,
  source: { ...own.source, name: 'Organization source', projectId: null },
};
const version: VersionItem = {
  id: versionId,
  version: '1.2.3',
  stability: 'stable',
  status: 'active',
  publishedAt: '2026-10-17T12:00:00Z',
  removedUpstreamAt: null,
  tombstonedAt: null,
  revision: 1,
  vulnerability: {
    status: 'unknown',
    reason: 'not_checked',
    source: null,
    fetchedAt: null,
    lastKnownStatus: null,
    advisoryCount: 0,
    advisories: [],
    detailsComplete: false,
    advisoriesTruncated: false,
  },
};
const manager: PackageAccess = {
  organization: [],
  project: ['project:packages:manage'],
  projectId,
  projectSlug: 'web',
};
const admin = { ...manager, organization: ['org:packages:manage'] };
const reader = { ...manager, project: [] };
const query = { project: 'web' };
const labels = (html: string) =>
  [...html.matchAll(/data-package-action="([a-z]+)"/g)].map((match) => match[1]);
function panel(item: PackageItem, access = manager, status: VersionItem['status'] = 'active') {
  return renderToString(
    createElement(PackageVersions, {
      item,
      versions: [{ ...version, status }],
      access,
      busy: false,
      onAction: vi.fn(),
    }),
  );
}
function fixture(
  options: {
    status?: number;
    code?: string;
    message?: string;
    items?: PackageItem[];
    versionStatus?: VersionItem['status'];
  } = {},
) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST')
      return new Response(
        JSON.stringify(
          options.status
            ? {
                error: {
                  code: options.code ?? 'not_found',
                  message: options.message ?? 'private request data',
                },
              }
            : { id: versionId, status: 'quarantined' },
        ),
        { status: options.status ?? 200 },
      );
    if (url === '/_pb/me/permissions') return Response.json({ organization: [] });
    if (url.endsWith('/permissions'))
      return Response.json({ project: ['project:packages:manage'] });
    if (url === '/_pb/projects/web') return Response.json({ id: projectId });
    if (url.includes('/versions'))
      return Response.json({
        items: [{ ...version, status: options.versionStatus ?? 'active' }],
        next: null,
      });
    return Response.json({ items: options.items ?? [own, shared], next: 'npm:opaque:+/%?=' });
  });
  const requireReauth = vi.fn();
  const controller = createPackagesController({
    client: createApiClient<paths>({ fetch, readCookie: () => undefined }),
    requireReauth,
  });
  return { controller, fetch, requireReauth };
}

describe('D8 action visibility', () => {
  it('gives a project manager the three state actions across their own versions', () => {
    expect(labels(panel(own))).toEqual(['quarantine', 'tombstone']);
    expect(labels(panel(own, manager, 'quarantined'))).toEqual(['tombstone', 'release']);
  });
  it('shows no action on an organization source to a project manager', () => {
    expect(labels(panel(shared))).toEqual([]);
  });
  it('shows no action on a foreign project source to a project manager', () => {
    expect(labels(panel({ ...own, source: { ...own.source, projectId: sourceId } }))).toEqual([]);
  });
  it('gives organization admins actions on both kinds of package', () => {
    for (const item of [own, shared])
      expect(labels(panel(item, admin))).toEqual(['quarantine', 'tombstone']);
  });
  it('does not offer rebuild while the generated API omits the operation', () => {
    expect(panel(own, admin)).not.toContain('Rebuild');
  });
  it('shows neither actions nor a disabled permission hint to a reader', () => {
    const html = panel(own, reader);
    expect(labels(html)).toEqual([]);
    expect(html).not.toMatch(/disabled|packages:manage|permission/i);
  });
  it('does not infer project authority in the organization view', () => {
    expect(
      packageActions(own, version.status, { ...manager, projectSlug: null, projectId: null }),
    ).toEqual([]);
  });
  it.each([
    ['active', ['quarantine', 'tombstone']],
    ['removed_upstream', ['quarantine', 'tombstone']],
    ['quarantined', ['tombstone', 'release']],
    ['tombstoned', []],
    ['yanked', []],
  ] as const)('renders exactly the actions for %s', (status, actions) => {
    expect(labels(panel(own, manager, status))).toEqual(actions);
    expect(labels(panel(own, admin, status))).toEqual(actions);
  });
});

describe('hash filters', () => {
  it('uses the shared hash encoding for package navigation', () => {
    const state = { ...query, q: '@scope/pkg & tool', after: 'opaque/+=' };
    expect(buildPackagesHash(state)).toBe(buildListFilterHash('packages', state));
  });
  it('drops oversized cursors when reading a package hash', () => {
    expect(parsePackagesHash(`#/packages?after=${'x'.repeat(4097)}`).after).toBeUndefined();
  });
  it('keeps a boundary-length cursor when reading a package hash', () => {
    expect(parsePackagesHash(`#/packages?after=${'x'.repeat(4096)}`).after).toBe('x'.repeat(4096));
  });
  it('drops unencodable values when building a package hash', () => {
    expect(buildPackagesHash({ project: null, q: '\ud800' })).toBe('#/packages');
  });
  it('round-trips filters and project scope', () => {
    const state = parsePackagesHash(
      `#/packages?project=web&status=quarantined&source=${sourceId}&q=%40example`,
    );
    expect(parsePackagesHash(buildPackagesHash(state))).toEqual(state);
    expect(state).toMatchObject({
      project: 'web',
      status: 'quarantined',
      source: sourceId,
      q: '@example',
    });
  });
  it('round-trips an organization project filter without switching scope', () => {
    const state = parsePackagesHash(`#/packages?projectId=${projectId}`);
    expect(state).toMatchObject({ project: null, projectId });
    expect(parsePackagesHash(buildPackagesHash(state))).toEqual(state);
  });
  it('drops unknown status values', () => {
    expect(parsePackagesHash('#/packages?status=secret').status).toBeUndefined();
  });
  it('drops malformed source values', () => {
    expect(parsePackagesHash('#/packages?source=unknown').source).toBeUndefined();
  });
  it('drops malformed organization project filters', () => {
    expect(parsePackagesHash('#/packages?projectId=unknown').projectId).toBeUndefined();
  });
  it('drops unknown filters', () => {
    expect(buildPackagesHash(parsePackagesHash('#/packages?unknown=secret'))).toBe('#/packages');
  });
  it('round-trips an opaque cursor unchanged', () => {
    const after = 'npm:@scope/name:+/%?=\u2603';
    expect(parsePackagesHash(buildPackagesHash({ ...query, after })).after).toBe(after);
  });
});

describe('filter reset', () => {
  it.each(['#/packages', '#/packages?project=web'])(
    'uses native form reset when clearing draft filters keeps the hash at %s',
    (hash) => {
      vi.stubGlobal('window', { location: { hash } });
      try {
        const html = renderToString(
          createElement(
            ServicesContext.Provider,
            {
              value: {
                client: createApiClient<paths>({ fetch: vi.fn(), readCookie: () => undefined }),
                requireReauth: vi.fn(),
              },
            },
            createElement(PackagesPage),
          ),
        );
        expect(html).toMatch(/<button\b[^>]*type="reset"[^>]*>Clear filters<\/button>/);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});

describe('page requests and actions', () => {
  it.each([false, true])(
    'describes the mutation route scope (organization admin: %s)',
    async (organizationAdmin) => {
      const f = fixture({ status: 403, code: 'reauth_required' });
      if (organizationAdmin)
        f.fetch.mockImplementationOnce(async () =>
          Response.json({ organization: ['org:packages:manage'] }),
        );
      await f.controller.load(query);
      await f.controller.open(own.id);
      await f.controller.act(versionId, 'tombstone');
      const html = renderToString(
        createElement(PackagesView, {
          state: f.controller.snapshot(),
          onOpen: vi.fn(),
          onAction: vi.fn(),
          onNext: vi.fn(),
          onVersionNext: vi.fn(),
          onRefresh: vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
      const scope = organizationAdmin ? 'Organization' : 'Project web';
      expect(html).toContain(`<dd>${scope}</dd>`);
      expect(html).toContain('Only this version is affected.');
      await f.controller.confirmTombstone();
      expect(f.requireReauth).toHaveBeenCalledWith(
        expect.objectContaining({
          path: organizationAdmin
            ? `/_pb/packages/${packageId}/versions/${versionId}/tombstone`
            : `/_pb/projects/web/packages/${packageId}/versions/${versionId}/tombstone`,
        }),
        expect.objectContaining({
          display: { packageName: own.name, version: version.version, scope },
        }),
      );
    },
  );

  it('loads project permissions and resolves its id independently of its slug', async () => {
    const f = fixture();
    await f.controller.load(query);
    expect(f.controller.snapshot().access).toEqual(manager);
    expect(f.fetch.mock.calls.map(([url]) => url)).toContain('/_pb/projects/web/permissions');
    expect(f.fetch.mock.calls.map(([url]) => url)).not.toContain('/_pb/session');
  });
  it('sends organization filters and the cursor through the client', async () => {
    const f = fixture();
    await f.controller.load({
      project: null,
      projectId,
      source: sourceId,
      status: 'active',
      q: '@example',
      after: 'opaque:+/%?=',
    });
    const [url, init] = f.fetch.mock.calls.find(([url]) => url.startsWith('/_pb/packages?'))!;
    const params = new URL(url, 'https://broker.invalid').searchParams;
    expect(Object.fromEntries(params)).toEqual({
      project: projectId,
      source: sourceId,
      status: 'active',
      q: '@example',
      after: 'opaque:+/%?=',
    });
    expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
  });
  it('pages versions by id', async () => {
    const f = fixture();
    await f.controller.load(query);
    await f.controller.open(own.id, versionId);
    expect(f.fetch.mock.calls.map(([url]) => url)).toContain(
      `/_pb/projects/web/packages/${packageId}/versions?after=${versionId}`,
    );
  });
  it('uses the project action route with an empty JSON body', async () => {
    const f = fixture();
    await f.controller.load(query);
    await f.controller.open(own.id);
    await f.controller.act(versionId, 'quarantine');
    expect(f.fetch).toHaveBeenCalledWith(
      `/_pb/projects/web/packages/${packageId}/versions/${versionId}/quarantine`,
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
  it('uses organization routes for organization admins in a project view', async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async () =>
      Response.json({ organization: ['org:packages:manage'] }),
    );
    await f.controller.load(query);
    await f.controller.open(shared.id);
    await f.controller.act(versionId, 'quarantine');
    expect(f.fetch).toHaveBeenCalledWith(
      `/_pb/packages/${shared.id}/versions/${versionId}/quarantine`,
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
  it('does not send a forbidden action for a shared source', async () => {
    const f = fixture();
    await f.controller.load(query);
    await f.controller.open(shared.id);
    await f.controller.act(versionId, 'quarantine');
    expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });
  it('does not send an action disallowed by version status', async () => {
    const f = fixture({ versionStatus: 'tombstoned' });
    await f.controller.load(query);
    await f.controller.open(own.id);
    await f.controller.act(versionId, 'quarantine');
    expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });
  it('requires explicit confirmation before tombstoning', async () => {
    const f = fixture();
    await f.controller.load(query);
    await f.controller.open(own.id);
    await f.controller.act(versionId, 'tombstone');
    expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    expect(f.controller.snapshot().confirmVersion).toBe(versionId);
    await f.controller.confirmTombstone();
    expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
  it('cancels a tombstone without sending a request', async () => {
    const f = fixture();
    await f.controller.load(query);
    await f.controller.open(own.id);
    await f.controller.act(versionId, 'tombstone');
    f.controller.cancelTombstone();
    await f.controller.confirmTombstone();
    expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });
  it.each(['absent', 'foreign'])(
    'shows generic not found for an %s package and refreshes the list',
    async (kind) => {
      const f = fixture({ status: 404, message: `${kind} private request data` });
      await f.controller.load(query);
      await f.controller.open(own.id);
      const before = f.fetch.mock.calls.filter(
        ([url]) => url === '/_pb/projects/web/packages',
      ).length;
      await f.controller.act(versionId, 'quarantine');
      expect(f.controller.snapshot().notice).toBe('Not found.');
      expect(f.controller.snapshot().selected).toBeNull();
      expect(
        f.fetch.mock.calls.filter(([url]) => url === '/_pb/projects/web/packages'),
      ).toHaveLength(before + 1);
      expect(JSON.stringify(f.controller.snapshot())).not.toContain('private request data');
    },
  );
  it.each([
    [200, 'Version updated.'],
    [404, 'Not found.'],
  ])(
    'shows a failed list reload beside the mutation notice after HTTP %s',
    async (status, notice) => {
      const f = fixture(status === 200 ? {} : { status });
      await f.controller.load(query);
      await f.controller.open(own.id);
      const original = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation((url, init) =>
        url === '/_pb/projects/web/packages'
          ? Promise.resolve(new Response('{}', { status: 503 }))
          : original(url, init),
      );
      await f.controller.act(versionId, 'quarantine');
      const html = renderToString(
        createElement(PackagesView, {
          state: f.controller.snapshot(),
          onOpen: vi.fn(),
          onAction: vi.fn(),
          onNext: vi.fn(),
          onVersionNext: vi.fn(),
          onRefresh: vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
      expect(html).toContain(notice);
      expect(html).toContain('Packages could not be loaded. Try again.');
      expect(f.controller.snapshot().loading).toBe(false);
    },
  );
  it('shows a generic conflict notice', async () => {
    const f = fixture({ status: 409, code: 'conflict' });
    await f.controller.load(query);
    await f.controller.open(own.id);
    await f.controller.act(versionId, 'quarantine');
    expect(f.controller.snapshot().notice).toBe('The version changed, refresh.');
  });
  it('hands reauthentication to T539 without credentials', async () => {
    const f = fixture({ status: 403, code: 'reauth_required' });
    await f.controller.load(query);
    await f.controller.open(own.id);
    await f.controller.act(versionId, 'tombstone');
    await f.controller.confirmTombstone();
    expect(f.requireReauth).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: `/_pb/projects/web/packages/${packageId}/versions/${versionId}/tombstone`,
        body: {},
      }),
      {
        credential: false,
        secretFields: [],
        display: { packageName: own.name, version: '1.2.3', scope: 'Project web' },
      },
    );
    expect(f.controller.snapshot().confirmVersion).toBeNull();
  });
  it('ignores a stale response after a scope change', async () => {
    const f = fixture();
    let resolve!: (response: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const stale = f.controller.load(query);
    await f.controller.load({ project: null });
    resolve(Response.json({ organization: ['org:packages:manage'] }));
    await stale;
    expect(f.controller.snapshot().access.projectSlug).toBeNull();
    expect(f.controller.snapshot().access.organization).toEqual([]);
  });
});

describe('package markup', () => {
  it('renders the specified columns and safely escapes publisher text', async () => {
    const f = fixture({ items: [{ ...own, name: '<script>secret</script>' }] });
    await f.controller.load(query);
    const html = renderToString(
      createElement(PackagesView, {
        state: f.controller.snapshot(),
        onOpen: vi.fn(),
        onAction: vi.fn(),
        onNext: vi.fn(),
        onVersionNext: vi.fn(),
        onRefresh: vi.fn(),
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    for (const text of [
      'Name',
      'Latest version',
      'Winning source',
      'Status',
      'Version count',
      'Last synced',
      'Project source',
      'vcs',
    ])
      expect(html).toContain(text);
    expect(html).toContain('&lt;script&gt;secret&lt;/script&gt;');
    expect(html).not.toMatch(/<script|<style|style=|href="https?:/);
  });
});

describe('reauth replay refresh', () => {
  it.each([200, 409])(
    'refreshes the selected detail and its version cursor after replay HTTP %s',
    async (status) => {
      const f = fixture();
      await f.controller.load(query);
      await f.controller.open(own.id, 'older');
      const original = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation((url, init) =>
        url.includes('/versions')
          ? Promise.resolve(
              Response.json({ items: [{ ...version, status: 'tombstoned' }], next: null }),
            )
          : original(url, init),
      );
      await f.controller.replayed({
        path: `/_pb/projects/web/packages/${packageId}/versions/${versionId}/tombstone`,
        ok: status === 200,
        status,
      });
      expect(f.controller.snapshot().selected?.id).toBe(own.id);
      expect(f.controller.snapshot().versions[0]?.status).toBe('tombstoned');
      expect(f.fetch.mock.calls.at(-1)?.[0]).toBe(
        `/_pb/projects/web/packages/${packageId}/versions?after=older`,
      );
    },
  );

  it.each([200, 404, 409])('refreshes package data after a replay returns %s', async (status) => {
    const f = fixture();
    await f.controller.load(query);
    const before = f.fetch.mock.calls.length;
    await f.controller.replayed({
      path: `/_pb/projects/web/packages/${packageId}/versions/${versionId}/tombstone`,
      ok: status === 200,
      status,
    });
    expect(f.fetch.mock.calls.length).toBeGreaterThan(before);
    expect(f.controller.snapshot().notice).toBe(
      status === 404
        ? 'Not found.'
        : status === 409
          ? 'The version changed, refresh.'
          : 'Version updated.',
    );
  });
  it.each([
    [200, 'Version updated.'],
    [404, 'Not found.'],
    [409, 'The version changed, refresh.'],
  ])(
    'preserves both notices when the reload after replay HTTP %s fails',
    async (status, notice) => {
      const f = fixture();
      await f.controller.load(query);
      const original = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation((url, init) =>
        url === '/_pb/projects/web/packages'
          ? Promise.resolve(new Response('{}', { status: 503 }))
          : original(url, init),
      );
      await f.controller.replayed({
        path: `/_pb/projects/web/packages/${packageId}/versions/${versionId}/tombstone`,
        ok: status === 200,
        status,
      });
      expect(f.controller.snapshot().notice).toContain(notice);
      expect(f.controller.snapshot().notice).toContain('Packages could not be loaded. Try again.');
    },
  );
  it('ignores replay results for another project', async () => {
    const f = fixture();
    await f.controller.load(query);
    const before = f.fetch.mock.calls.length;
    await f.controller.replayed({
      path: `/_pb/projects/other/packages/${packageId}/versions/${versionId}/tombstone`,
      ok: true,
      status: 200,
    });
    expect(f.fetch.mock.calls.length).toBe(before);
  });
  it('ignores replay results for other resource routes', async () => {
    const f = fixture();
    await f.controller.load(query);
    const before = f.fetch.mock.calls.length;
    await f.controller.replayed({ path: '/_pb/projects/web/tokens', ok: true, status: 200 });
    expect(f.fetch.mock.calls.length).toBe(before);
  });
});

describe('request edge cases', () => {
  it('fails closed when organization permissions cannot be loaded', async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
    await f.controller.load({ project: null });
    await f.controller.open(shared.id);
    await f.controller.act(versionId, 'quarantine');
    expect(f.controller.snapshot().access.organization).toEqual([]);
    expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });
  it('fails closed when the project id cannot be resolved', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((url, init) =>
      url === '/_pb/projects/web'
        ? Promise.resolve(new Response('{}', { status: 404 }))
        : original(url, init),
    );
    await f.controller.load(query);
    await f.controller.open(own.id);
    await f.controller.act(versionId, 'quarantine');
    expect(f.controller.snapshot().access.projectId).toBeNull();
    expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });
  it('does not send a second action while one is pending', async () => {
    const f = fixture();
    await f.controller.load(query);
    await f.controller.open(own.id);
    const original = f.fetch.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    f.fetch.mockImplementation((url, init) =>
      init.method === 'POST'
        ? new Promise<Response>((done) => {
            resolve = done;
          })
        : original(url, init),
    );
    const first = f.controller.act(versionId, 'quarantine');
    await f.controller.act(versionId, 'quarantine');
    expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    resolve(Response.json({ id: versionId, status: 'quarantined' }));
    await first;
  });
  it('ignores version data arriving after a scope change', async () => {
    const f = fixture();
    await f.controller.load(query);
    let resolve!: (response: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const pending = f.controller.open(own.id);
    await f.controller.load({ project: null });
    resolve(Response.json({ items: [version], next: versionId }));
    await pending;
    expect(f.controller.snapshot().versions).toEqual([]);
    expect(f.controller.snapshot().selected).toBeNull();
  });
  it('ignores action failures arriving after a scope change', async () => {
    const f = fixture();
    await f.controller.load(query);
    await f.controller.open(own.id);
    let resolve!: (response: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const pending = f.controller.act(versionId, 'quarantine');
    await f.controller.load({ project: null });
    resolve(new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 }));
    await pending;
    expect(f.controller.snapshot().query.project).toBeNull();
    expect(f.controller.snapshot().notice).toBeNull();
  });
});

describe('detail return state', () => {
  it('keeps the cached list across hash navigation to a detail and back', async () => {
    const f = fixture();
    const filters = { ...query, q: '@example', after: 'same-cursor' };
    await f.controller.load(filters);
    const items = f.controller.snapshot().items;
    const next = f.controller.snapshot().next;
    f.controller.dispose();
    await f.controller.navigate(filters, own.id);
    f.controller.dispose();
    await f.controller.navigate(filters);
    expect(f.controller.snapshot()).toMatchObject({ query: filters, selected: null, next });
    expect(f.controller.snapshot().items).toBe(items);
    expect(f.fetch.mock.calls.filter(([url]) => url.includes('/packages?'))).toHaveLength(1);
    await f.controller.navigate({ project: null });
    expect(f.controller.snapshot().access.projectSlug).toBeNull();
    expect(f.fetch.mock.calls.map(([url]) => url)).toContain('/_pb/packages');
  });

  it.each(['dispose', 'navigate'] as const)(
    'does not reopen detail after a refresh completes following %s',
    async (navigation) => {
      const f = fixture();
      await f.controller.load(query);
      await f.controller.open(own.id);
      let resolve!: (response: Response) => void;
      f.fetch.mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
      const pending = f.controller.refresh();
      if (navigation === 'dispose') f.controller.dispose();
      else await f.controller.navigate({ project: null });
      const before = f.fetch.mock.calls.length;
      resolve(Response.json({ organization: [] }));
      await pending;
      expect(f.controller.snapshot().selected).toBeNull();
      expect(f.fetch.mock.calls.length).toBe(before);
    },
  );

  it('returns to the same package list and cursor', async () => {
    const f = fixture();
    const filters = { ...query, q: '@example', status: 'active' as const, after: 'same-cursor' };
    await f.controller.load(filters);
    await f.controller.open(own.id);
    const items = f.controller.snapshot().items;
    const next = f.controller.snapshot().next;
    f.controller.close();
    expect(f.controller.snapshot()).toMatchObject({
      query: filters,
      selected: null,
      versions: [],
      versionsLoading: false,
    });
    expect(f.controller.snapshot().items).toBe(items);
    expect(f.controller.snapshot().next).toBe(next);
  });
});
