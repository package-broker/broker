import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../auth/primitives.js';
import { createAuthorizationEngine, patValidationGate } from '../../authz/engine.js';
import type { EngineAccessPort } from '../../authz/engine.js';
import type {
  PackageAdminReader,
  PackageListItem,
  VersionListItem,
} from '../../db/package-admin.js';
import type { VulnerabilityStatus } from '../../db/vulnerability.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { packageRoutes } from './packages.js';

const ID = '01JA0000000000000000000000';
const OTHER = '01JA0000000000000000000001';
const SECRET = 'A'.repeat(43);
const PROJECT = '/_pb/projects/demo/packages';
const paths = [
  PROJECT,
  `${PROJECT}/${ID}/versions`,
  '/_pb/packages',
  `/_pb/packages/${ID}/versions`,
];
const org = orgContext('org-1');
const item: PackageListItem = {
  id: ID,
  ecosystem: 'npm',
  name: '@acme/lib',
  latestVersion: '1.0.0',
  visibleToNewProjects: true,
  newProjectAccessMode: 'none',
  revision: 1,
  status: 'active',
  source: { id: OTHER, name: 'Private', type: 'hosted', projectId: ID },
  versionCount: 2,
  lastSyncedAt: null,
};
const version: VersionListItem = {
  integrity: null,
  distTags: [],
  publishedBy: null,
  approvedBy: null,
  id: ID,
  version: '1.0.0',
  stability: 'stable',
  status: 'quarantined',
  publishedAt: '2026-10-17T00:00:00.000Z',
  removedUpstreamAt: null,
  tombstonedAt: null,
  revision: 1,
};

beforeEach(() => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
});
afterEach(() => vi.restoreAllMocks());

async function fixture(
  options: {
    permissions?: string[];
    readStatuses?: (
      ctx: typeof org,
      ids: readonly string[],
    ) => Promise<ReadonlyMap<string, VulnerabilityStatus>>;
    listProject?: PackageAdminReader['listProject'];
    listOrganization?: PackageAdminReader['listOrganization'];
    listVersions?: PackageAdminReader['listVersions'];
  } = {},
) {
  const listProject = vi.fn<PackageAdminReader['listProject']>(
    options.listProject ?? (async () => ({ items: [item], next: null })),
  );
  const listOrganization = vi.fn<PackageAdminReader['listOrganization']>(
    options.listOrganization ?? (async () => ({ items: [item], next: null })),
  );
  const listVersions = vi.fn<PackageAdminReader['listVersions']>(
    options.listVersions ?? (async () => ({ items: [version], next: null })),
  );
  const permissions = options.permissions ?? ['org:sources:read', 'project:packages:read'];
  const lookupSession = vi.fn<EngineAccessPort['lookupSession']>(async (_ctx, input) => {
    if (input.secretHash !== (await sha256Hex(SECRET))) return null;
    const exists = input.projectSlug === 'demo' || input.projectSlug === 'invisible';
    return {
      session: { id: 'session-1', csrfHash: '' },
      user: { id: 'user-1' },
      identity: null,
      protectedHolder: false,
      project: exists ? { id: ID } : null,
      organizationPermissions: permissions.filter((p) => p.startsWith('org:')),
      projectPermissions:
        input.projectSlug === 'demo'
          ? ['project:read', ...permissions.filter((p) => p.startsWith('project:'))]
          : [],
    };
  });
  const resolve = vi.fn(async () => ({ kind: 'absent' as const }));
  const log = vi.fn();
  const readStatuses = vi.fn(options.readStatuses ?? (async () => new Map()));
  const routes = packageRoutes({ listProject, listOrganization, listVersions, readStatuses });
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: routes,
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-17T00:00:00.000Z'),
      ids: { ulid: () => ID },
    },
    resolveOrg: async () => org,
    health: async () => true,
    log,
    packageResolver: { resolve },
    authorization: createAuthorizationEngine({
      access: {
        lookupSession,
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
        nowMs: () => 0,
        dispatch: () => undefined,
        log,
      },
      patValidation: patValidationGate,
      publicOrigin: 'https://broker.test',
      providerAnchors: async () => [],
    }),
  });
  const request = (path: string, authenticated = true) =>
    kernel.fetch(
      new Request(`https://broker.test${path}`, {
        headers: authenticated ? { cookie: `__Host-pb_session=${SECRET}` } : {},
      }),
    );
  return {
    request,
    listProject,
    listOrganization,
    listVersions,
    readStatuses,
    resolve,
    routes,
    log,
  };
}

async function dump(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers],
    body: (await response.json()) as unknown,
  };
}

it('declares all four operations and exposes only project reads to MCP', async () => {
  const f = await fixture();
  expect(
    f.routes.map((r) => [
      r.path,
      r.boundary,
      r.permission,
      r.api?.exempt === undefined ? r.api?.operationId : undefined,
      r.api?.exempt === undefined && r.api?.mcp === true,
    ]),
  ).toEqual([
    [
      '/_pb/projects/:project/packages',
      'project',
      'project:packages:read',
      'listProjectPackages',
      true,
    ],
    [
      '/_pb/projects/:project/packages/:package/versions',
      'project',
      'project:packages:read',
      'listProjectPackageVersions',
      true,
    ],
    ['/_pb/packages', 'organization', 'org:sources:read', 'listPackages', false],
    [
      '/_pb/packages/:package/versions',
      'organization',
      'org:sources:read',
      'listPackageVersions',
      false,
    ],
  ]);
});

for (const path of paths) {
  it(`requires authentication for ${path}`, async () => {
    const f = await fixture();
    expect((await f.request(path, false)).status).toBe(401);
    expect(f.listProject).not.toHaveBeenCalled();
    expect(f.listOrganization).not.toHaveBeenCalled();
    expect(f.listVersions).not.toHaveBeenCalled();
    expect(f.readStatuses).not.toHaveBeenCalled();
  });
  it(`denies missing permission on visible resource ${path}`, async () => {
    const f = await fixture({ permissions: [] });
    const response = await f.request(path);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('project:packages:read');
    expect(f.listProject).not.toHaveBeenCalled();
    expect(f.listOrganization).not.toHaveBeenCalled();
    expect(f.listVersions).not.toHaveBeenCalled();
    expect(f.readStatuses).not.toHaveBeenCalled();
  });
}
for (const slug of ['absent', 'archived', 'foreign', 'invisible']) {
  it(`hides ${slug} projects before the handler runs`, async () => {
    const f = await fixture({ permissions: [] });
    const response = await f.request(`/_pb/projects/${slug}/packages`);
    expect(response.status).toBe(404);
    expect(await dump(response)).toEqual(
      await dump(await f.request('/_pb/projects/absent/packages')),
    );
    expect(f.listProject).not.toHaveBeenCalled();
  });
}
for (const cause of ['unattached', 'pattern-excluded', 'outranked', 'foreign', 'absent']) {
  it(`uses the uniform 404 when the reader cannot see an ${cause} package`, async () => {
    const f = await fixture({ listVersions: async () => null });
    const response = await f.request(`${PROJECT}/${ID}/versions`);
    expect(response.status).toBe(404);
    expect(await dump(response)).toEqual(
      await dump(await f.request('/_pb/projects/absent/packages')),
    );
    expect(f.listVersions).toHaveBeenCalledWith(org, { projectId: ID, packageId: ID, limit: 50 });
    expect(f.resolve).not.toHaveBeenCalled();
  });
}
it('hides an absent organization package with the same 404 envelope', async () => {
  const f = await fixture({ listVersions: async () => null });
  expect(await dump(await f.request(paths[3]!))).toEqual(
    await dump(await f.request('/_pb/projects/absent/packages')),
  );
});
for (const base of [PROJECT, '/_pb/packages']) {
  it(`hides malformed package ids on ${base}`, async () => {
    const f = await fixture();
    expect(await dump(await f.request(`${base}/bad/versions`))).toEqual(
      await dump(await f.request('/_pb/projects/absent/packages')),
    );
    expect(f.listVersions).not.toHaveBeenCalled();
    expect(f.readStatuses).not.toHaveBeenCalled();
  });
}
it('passes organization filters and scope without changing literal prefixes', async () => {
  const f = await fixture();
  const q = '%_\\';
  const query = new URLSearchParams({
    project: ID,
    source: OTHER,
    ecosystem: 'npm',
    status: 'quarantined',
    q,
    limit: '100',
    after: `npm:@acme/lib:${ID}`,
  });
  expect((await f.request(`/_pb/packages?${query}`)).status).toBe(200);
  expect(f.listOrganization).toHaveBeenCalledWith(org, {
    projectId: ID,
    sourceId: OTHER,
    ecosystem: 'npm',
    status: 'quarantined',
    q,
    limit: 100,
    after: `npm:@acme/lib:${ID}`,
  });
});
it('delegates winner filtering and literal prefix matching to the project reader', async () => {
  const f = await fixture({ listProject: async () => ({ items: [], next: 'npm:hidden' }) });
  const response = await f.request(
    `${PROJECT}?q=%25_%5C&source=${OTHER}&status=active&ecosystem=npm`,
  );
  expect(await response.json()).toEqual({ items: [], next: 'npm:hidden' });
  expect(f.listProject).toHaveBeenCalledWith(org, ID, {
    q: '%_\\',
    sourceId: OTHER,
    status: 'active',
    ecosystem: 'npm',
    limit: 50,
  });
});
for (const base of [PROJECT, '/_pb/packages']) {
  it(`passes a 100-character prefix unshortened on ${base}`, async () => {
    const f = await fixture();
    expect((await f.request(`${base}?q=${'a'.repeat(100)}`)).status).toBe(200);
    const reader = base === PROJECT ? f.listProject : f.listOrganization;
    expect(reader.mock.calls[0]?.at(-1)).toEqual({ q: 'a'.repeat(100), limit: 50 });
  });
  for (const [label, query] of [
    ['101-character prefix', `q=${'a'.repeat(101)}`],
    ['uppercase prefix', 'q=Acme'],
    ['empty prefix', 'q='],
    ['NUL prefix', 'q=%00'],
    ['malformed cursor', 'after=bad'],
    ['empty cursor name', 'after=npm:'],
    ['wrong cursor ecosystem', 'after=gem:foo'],
    ['zero limit', 'limit=0'],
    ['excess limit', 'limit=101'],
    ['fractional limit', 'limit=1.5'],
    ['duplicate limit', 'limit=1&limit=2'],
    ['invalid status', 'status=secret'],
    ['invalid source', 'source=bad'],
    ['invalid ecosystem', 'ecosystem=gem'],
    ['unknown query', 'extra=1'],
  ]) {
    it(`rejects ${label} on ${base} before calling a reader`, async () => {
      const f = await fixture();
      const response = await f.request(`${base}?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
      expect(f.listProject).not.toHaveBeenCalled();
      expect(f.listOrganization).not.toHaveBeenCalled();
    });
  }
}
it('rejects a project filter on a project list', async () => {
  const f = await fixture();
  expect((await f.request(`${PROJECT}?project=${ID}`)).status).toBe(400);
  expect(f.listProject).not.toHaveBeenCalled();
});
it('rejects a malformed organization cursor id', async () => {
  const f = await fixture();
  expect((await f.request('/_pb/packages?after=npm:foo:bad')).status).toBe(400);
  expect(f.listOrganization).not.toHaveBeenCalled();
});
for (const base of [PROJECT, '/_pb/packages']) {
  it(`keeps reader cursors intact while paging ${base}`, async () => {
    const second = { ...item, id: OTHER, name: 'z' };
    const cursor = base === PROJECT ? 'npm:@acme/lib' : `npm:@acme/lib:${ID}`;
    const page = async (_ctx: unknown, query: { after?: string }) =>
      query.after === cursor ? { items: [second], next: null } : { items: [item], next: cursor };
    const f = await fixture({
      listOrganization: page,
      listProject: (ctx, _id, query) => page(ctx, query),
    });
    const first = (await (await f.request(`${base}?limit=1`)).json()) as {
      items: PackageListItem[];
      next: string;
    };
    const last = (await (
      await f.request(`${base}?limit=1&after=${encodeURIComponent(first.next)}`)
    ).json()) as { items: PackageListItem[]; next: null };
    expect([...first.items, ...last.items].map((p) => p.id)).toEqual([ID, OTHER]);
    expect(last.next).toBeNull();
  });
}
for (const path of [paths[1]!, paths[3]!]) {
  it(`returns every version status with only operator fields on ${path}`, async () => {
    const versions = ['active', 'removed_upstream', 'quarantined', 'tombstoned', 'yanked'].map(
      (status) => ({ ...version, status }) as VersionListItem,
    );
    const f = await fixture({
      listVersions: async () => ({
        items: versions.map((v) => ({
          ...v,
          metadata: 'private',
          sourceRef: 'private',
          blobId: 'private',
          digest: 'private',
        })),
        next: OTHER,
      }),
    });
    const response = await f.request(`${path}?limit=1&after=${ID}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: versions.map((v) => ({ ...v, vulnerability: masked })),
      next: OTHER,
    });
    expect(f.listVersions).toHaveBeenCalledWith(org, {
      packageId: ID,
      projectId: path.startsWith(PROJECT) ? ID : null,
      limit: 1,
      after: ID,
    });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it(`rejects malformed version cursors on ${path}`, async () => {
    const f = await fixture();
    expect((await f.request(`${path}?after=bad`)).status).toBe(400);
    expect(f.listVersions).not.toHaveBeenCalled();
    expect(f.readStatuses).not.toHaveBeenCalled();
  });
}
it('returns only declared package fields', async () => {
  const f = await fixture({
    listOrganization: async () => ({
      items: [{ ...item, metadata: 'private', source: { ...item.source, credential: 'private' } }],
      next: null,
    }),
  });
  expect(await (await f.request('/_pb/packages')).json()).toEqual({ items: [item], next: null });
});
it('lets the reader admit project-owned packages even when another source wins', async () => {
  const f = await fixture();
  expect((await f.request(paths[1]!)).status).toBe(200);
  expect(f.listVersions).toHaveBeenCalledWith(org, { packageId: ID, projectId: ID, limit: 50 });
  expect(f.resolve).not.toHaveBeenCalled();
});
for (const base of [PROJECT, '/_pb/packages']) {
  it(`accepts a reader cursor whose package name contains colons on ${base}`, async () => {
    const f = await fixture();
    const after = base === PROJECT ? 'npm:a:b' : `npm:a:b:${ID}`;
    expect((await f.request(`${base}?after=${encodeURIComponent(after)}`)).status).toBe(200);
  });
  it(`counts prefix characters as Unicode code points on ${base}`, async () => {
    const f = await fixture();
    expect((await f.request(`${base}?q=${encodeURIComponent('😀'.repeat(100))}`)).status).toBe(200);
    expect((await f.request(`${base}?q=${encodeURIComponent('😀'.repeat(101))}`)).status).toBe(400);
  });
}

const masked: VulnerabilityStatus = {
  status: 'unknown',
  reason: 'not_checked',
  source: null,
  fetchedAt: null,
  lastKnownStatus: null,
  advisoryCount: 0,
  advisories: [],
  detailsComplete: false,
  advisoriesTruncated: false,
};
for (const path of [paths[1]!, paths[3]!]) {
  it(`projects only the visible page on ${path} without outbound requests`, async () => {
    const outbound = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected egress'));
    const assessment: VulnerabilityStatus = {
      ...masked,
      status: 'affected',
      reason: null,
      source: 'osv',
      fetchedAt: '2026-10-20T00:00:00.000Z',
      lastKnownStatus: 'affected',
      advisoryCount: 1,
      advisories: [
        {
          id: 'GHSA-aaaa-bbbb-cccc',
          url: null,
          severity: { level: 'high', entries: [] },
          detailsFetchedAt: null,
        },
      ],
    };
    const f = await fixture({
      readStatuses: async () =>
        new Map([
          [
            ID,
            {
              ...assessment,
              provenance: 'private',
              advisories: assessment.advisories.map((advisory) => ({
                ...advisory,
                summary: 'private',
              })),
            },
          ],
        ]),
    });
    expect(await (await f.request(`${path}?limit=100`)).json()).toEqual({
      items: [{ ...version, vulnerability: assessment }],
      next: null,
    });
    expect(f.readStatuses).toHaveBeenCalledExactlyOnceWith(org, [ID]);
    expect(outbound).not.toHaveBeenCalled();
  });
  it(`does not project an invisible package on ${path}`, async () => {
    const f = await fixture({ listVersions: async () => null });
    expect((await f.request(path)).status).toBe(404);
    expect(f.readStatuses).not.toHaveBeenCalled();
  });
  it(`masks a failed projection on ${path}`, async () => {
    const f = await fixture({
      readStatuses: async () => {
        throw new Error('private evidence');
      },
    });
    expect(await (await f.request(path)).json()).toEqual({
      items: [{ ...version, vulnerability: masked }],
      next: null,
    });
  });
}

it('projects publication attribution without extra account fields', async () => {
  const f = await fixture({
    listVersions: async () => ({
      items: [
        {
          ...version,
          integrity: 'sha512-public',
          distTags: ['latest', 'next'],
          publishedBy: { kind: 'user', displayName: 'Publisher', email: 'private@example.test' },
          approvedBy: {
            displayName: 'Approver',
            decidedAt: '2026-10-30T00:00:00.000Z',
            token: 'private-token',
          },
        },
      ],
      next: null,
    }),
  });
  const response = await f.request(`/_pb/packages/${ID}/versions`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({
    items: [
      {
        integrity: 'sha512-public',
        distTags: ['latest', 'next'],
        publishedBy: { kind: 'user', displayName: 'Publisher' },
        approvedBy: { displayName: 'Approver', decidedAt: '2026-10-30T00:00:00.000Z' },
      },
    ],
  });
  expect(body).not.toContain('private@example.test');
  expect(body).not.toContain('private-token');
});
