import { describe, expect, it, vi } from 'vitest';
import { setAccessContext } from '../../authz/access-context.js';
import { setContextPackageActor } from '../../internal/package-actor.js';
import type {
  PackageAdminReader,
  PackageDetailRepository,
  PackageListItem,
  PolicyVersionFacts,
  PolicyVersionFactsReader,
  VersionListItem,
} from '../../db/package-admin.js';
import type { PolicyRule } from '../../db/registry-policy.js';
import type { HookMap, RequestContext, RouteDefinition } from '../../plugin.js';
import { createPolicyServing } from '../../registry/policy/serving.js';
import {
  policyRule,
  projectActor,
  sessionSetup,
} from '../../test-support/registry-policy-session.js';
import { fixedClock } from '../../ids.js';
import { packageDetailRoutes } from './package-detail.js';
import { packageRoutes } from './packages.js';

const PKG_A = '01J0K0000000000000000000PA';
const PKG_B = '01J0K0000000000000000000PB';
const PKG_C = '01J0K0000000000000000000PC';
const BLOCK = '01J0P0000000000000000000B1';
const vid = (pkg: string, n: number) => `${pkg.slice(0, 22)}V${String(n).padStart(3, '0')}`;

function item(id: string, name: string, versionCount: number): PackageListItem {
  return {
    id,
    ecosystem: 'npm',
    name,
    latestVersion: `1.0.${String(versionCount - 1)}`,
    status: 'active',
    source: { id: 'S', name: 'npmjs', type: 'npmjs_proxy', projectId: null },
    versionCount,
    lastSyncedAt: null,
  };
}

function facts(pkg: string, key: string, count: number): PolicyVersionFacts[] {
  return Array.from({ length: count }, (_, n) => ({
    packageId: pkg,
    sourceId: 'S',
    ecosystem: 'npm' as const,
    packageKey: key,
    versionId: vid(pkg, n),
    version: `1.0.${String(n)}`,
    versionNormalized: `1.0.${String(n)}`,
    revision: 1,
    status: 'active' as const,
    publishedAt: new Date(Date.UTC(2025, n, 1)).toISOString(),
    publishedAtBasis: 'release_date',
    createdAt: '2025-01-01T00:00:00.000Z',
  }));
}

function versionItem(row: PolicyVersionFacts): VersionListItem {
  return {
    id: row.versionId,
    version: row.version,
    stability: 'stable',
    status: row.status,
    publishedAt: row.publishedAt,
    removedUpstreamAt: null,
    tombstonedAt: null,
    revision: row.revision,
    integrity: null,
    distTags: [],
    publishedBy: null,
    approvedBy: null,
  };
}

const FLOOR = policyRule('01J0P0000000000000000000F1', {
  kind: 'client_floor',
  packageKey: null,
  clientFamily: 'npm',
  clientMinVersion: '1.0.0',
  denyUnknown: true,
});

type Catalogue = ReadonlyArray<readonly [id: string, key: string, count: number]>;

const CATALOGUE: Catalogue = [
  [PKG_A, 'alpha', 3],
  [PKG_B, 'bravo', 2],
  [PKG_C, 'charlie', 2],
];

function fixture(
  rules: PolicyRule[] = [],
  governed = true,
  hooks: Array<HookMap['registry.read']> = [],
  catalogue: Catalogue = CATALOGUE,
) {
  const rows = new Map(catalogue.map(([id, key, count]) => [id, facts(id, key, count)]));
  const listed = catalogue.map(([id, key, count]) => item(id, key, count));
  const reader = {
    listProject: vi.fn<PackageAdminReader['listProject']>(async (_ctx, _project, query) => {
      const rest = listed.filter((entry) => query.after === undefined || entry.name > query.after);
      const page = rest.slice(0, query.limit);
      return { items: page, next: rest.length > page.length ? page.at(-1)!.name : null };
    }),
    listOrganization: vi.fn<PackageAdminReader['listOrganization']>(async () => ({
      items: listed,
      next: null,
    })),
    listVersions: vi.fn<PackageAdminReader['listVersions']>(async (_ctx, query) => {
      const all = rows.get(query.packageId);
      if (all === undefined) return null;
      const rest = all.filter((row) => query.after === undefined || row.versionId > query.after);
      const page = rest.slice(0, query.limit);
      return {
        items: page.map(versionItem),
        next: rest.length > page.length ? page.at(-1)!.versionId : null,
      };
    }),
  };
  const factsReader: PolicyVersionFactsReader = {
    versionFacts: vi.fn(async (_ctx, query) =>
      [...(rows.get(query.packageId) ?? [])]
        .sort((left, right) =>
          query.newest === true
            ? right.publishedAt.localeCompare(left.publishedAt) ||
              right.versionId.localeCompare(left.versionId)
            : 0,
        )
        .filter((row) => query.versionIds === undefined || query.versionIds.includes(row.versionId))
        .filter((row) => query.after === undefined || row.versionId > query.after)
        .slice(0, query.limit),
    ),
  };
  const actor = projectActor({ projectId: '01J0K0000000000000000000PJ' });
  const setup = sessionSetup({ actor, rules, hooks });
  const policy = governed
    ? { serving: createPolicyServing(setup.deps), facts: factsReader }
    : undefined;
  const repository = {
    packageName: vi.fn<PackageDetailRepository['packageName']>(async () => null),
    readme: vi.fn<PackageDetailRepository['readme']>(async () => null),
    setAccess: vi.fn<PackageDetailRepository['setAccess']>(),
    detail: vi.fn<PackageDetailRepository['detail']>(async (_ctx, query) => {
      const found = listed.find((entry) => entry.id === query.packageId);
      return found === undefined
        ? null
        : ({
            ...found,
            visibleToNewProjects: true,
            newProjectAccessMode: 'none',
            revision: 1,
          } as PackageListItem);
    }),
  };
  const routes = [
    ...packageRoutes(reader, policy),
    ...packageDetailRoutes({
      repository,
      clock: fixedClock('2026-11-01T00:00:00Z'),
      ids: { ulid: () => '01J0R0000000000000000000R1' },
      clientIp: () => null,
      idempotency: { find: async () => null },
      ...(policy === undefined ? {} : { policy }),
    }),
  ];
  const find = (path: string): RouteDefinition => routes.find((route) => route.path === path)!;
  const call = async (
    path: string,
    url: string,
    params: Record<string, string>,
    organizationPermissions?: readonly string[],
  ) => {
    const ctx = {
      request: new Request(`https://broker.test${url}`),
      requestId: '01J0R0000000000000000000R1',
      org: { orgId: actor.orgId },
      principal: { kind: 'user', id: actor.userId },
      projectId: path.startsWith('/_pb/projects') ? actor.projectId : null,
      params,
      ports: {},
    } as unknown as RequestContext;
    if (organizationPermissions !== undefined) {
      setAccessContext(ctx, {
        principal: { kind: 'user', id: actor.userId },
        projectId: null,
        boundary: 'organization',
        sessionId: 'SESSION',
        token: null,
        actor: {
          session: { id: 'SESSION', userId: actor.userId },
          user: { id: actor.userId },
          organizationPermissions,
          projectPermissions: [],
          protectedHolder: false,
        },
        rateKey: {
          stage: 'authenticated',
          tokenSelector: null,
          principalId: actor.userId,
          routeClass: 'organization',
        },
      });
    }
    if (path.startsWith('/_pb/projects')) setContextPackageActor(ctx, actor);
    return find(path).handler(ctx);
  };
  const list = (query = '') =>
    call('/_pb/projects/:project/packages', `/_pb/projects/demo/packages${query}`, {
      project: 'demo',
    });
  const versions = (pkg: string, query = '') =>
    call(
      '/_pb/projects/:project/packages/:package/versions',
      `/_pb/projects/demo/packages/${pkg}/versions${query}`,
      { project: 'demo', package: pkg },
    );
  const orgList = (permissions?: readonly string[]) =>
    call('/_pb/packages', '/_pb/packages', {}, permissions);
  const orgVersions = (pkg: string, permissions?: readonly string[], query = '') =>
    call(
      '/_pb/packages/:package/versions',
      `/_pb/packages/${pkg}/versions${query}`,
      { package: pkg },
      permissions,
    );
  const detail = (pkg: string, permissions?: readonly string[]) =>
    permissions === undefined
      ? call('/_pb/projects/:project/packages/:package', `/_pb/projects/demo/packages/${pkg}`, {
          project: 'demo',
          package: pkg,
        })
      : call('/_pb/packages/:package', `/_pb/packages/${pkg}`, { package: pkg }, permissions);
  return { reader, factsReader, setup, list, versions, orgList, orgVersions, detail, repository };
}

type ListBody = {
  items: Array<{ name: string; latestVersion: string | null; versionCount: number }>;
  next: string | null;
};

describe('project package views with registry policy', () => {
  it('summaries count only permitted versions and never name a denied latest', async () => {
    const { list } = fixture([policyRule(BLOCK, { packageKey: 'alpha', members: ['1.0.2'] })]);
    const body = (await (await list()).json()) as ListBody;
    expect(
      body.items.map(({ name, latestVersion, versionCount }) => [
        name,
        latestVersion,
        versionCount,
      ]),
    ).toEqual([
      ['alpha', '1.0.1', 2],
      ['bravo', '1.0.1', 2],
      ['charlie', '1.0.1', 2],
    ]);
  });

  it('an all-denied package is hidden and an empty filtered page advances', async () => {
    const { list, reader } = fixture([
      policyRule(BLOCK, { packageKey: 'alpha', members: [] }),
      policyRule('01J0P0000000000000000000B2', { packageKey: 'bravo', members: [] }),
    ]);
    const body = (await (await list('?limit=1')).json()) as ListBody;
    expect(body.items.map((entry) => entry.name)).toEqual(['charlie']);
    expect(body.next).toBeNull();
    expect(reader.listProject).toHaveBeenCalledTimes(3);
  });

  it('the organization view of a package manager is the unfiltered inspection view', async () => {
    const { orgList, orgVersions, setup } = fixture([
      policyRule(BLOCK, { packageKey: 'alpha', members: [] }),
    ]);
    const body = (await (
      await orgList(['org:sources:read', 'org:packages:manage'])
    ).json()) as ListBody;
    expect(body.items.map((entry) => entry.name)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(body.items[0]).not.toHaveProperty('versionCountTruncated');
    const page = await orgVersions(PKG_A, ['org:sources:read', 'org:packages:manage']);
    expect(page.status).toBe(200);
    expect(setup.policy.queries).toEqual([]);
  });

  it('with the flag off, stored rules have no effect', async () => {
    const { list, setup } = fixture(
      [policyRule(BLOCK, { packageKey: 'alpha', members: [] })],
      false,
    );
    const body = (await (await list()).json()) as ListBody;
    expect(body.items.map((entry) => [entry.name, entry.versionCount])).toEqual([
      ['alpha', 3],
      ['bravo', 2],
      ['charlie', 2],
    ]);
    expect(setup.policy.queries).toEqual([]);
  });

  it('a version list drops denied versions; a package with none left is the uniform 404', async () => {
    const { versions } = fixture([
      policyRule(BLOCK, { packageKey: 'alpha', members: ['1.0.0'] }),
      policyRule('01J0P0000000000000000000B2', { packageKey: 'bravo', members: [] }),
    ]);
    const body = (await (await versions(PKG_A)).json()) as { items: Array<{ version: string }> };
    expect(body.items.map((entry) => entry.version)).toEqual(['1.0.1', '1.0.2']);
    const hidden = await versions(PKG_B);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('a version page whose versions are all denied advances to permitted ones', async () => {
    const { versions } = fixture([
      policyRule(BLOCK, { packageKey: 'alpha', members: ['1.0.0', '1.0.1'] }),
    ]);
    const body = (await (await versions(PKG_A, '?limit=1')).json()) as {
      items: Array<{ version: string }>;
      next: string | null;
    };
    expect(body.items.map((entry) => entry.version)).toEqual(['1.0.2']);
    expect(body.next).toBeNull();
  });

  it('an unreadable policy is the fixed 503 and an operation denial the fixed 403', async () => {
    const broken = fixture();
    broken.setup.policy.state.fail = true;
    const response = await broken.list();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'policy_unavailable' } });
    const denied = fixture([], true, [
      async (input) =>
        input.phase === 'request' ? { deny: true, reason: 'restricted' } : undefined,
    ]);
    const refused = await denied.versions(PKG_A);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'policy_denied' } });
  });

  it('a client floor that refuses unknown clients does not refuse the browser views', async () => {
    const { list, versions } = fixture([FLOOR]);
    const listed = await list();
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as ListBody).items.map((entry) => entry.name)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ]);
    const page = await versions(PKG_A);
    expect(page.status).toBe(200);
  });

  it('the browser views still apply block rules next to a client floor', async () => {
    const { list } = fixture([FLOOR, policyRule(BLOCK, { packageKey: 'alpha', members: [] })]);
    const body = (await (await list()).json()) as ListBody;
    expect(body.items.map((entry) => entry.name)).toEqual(['bravo', 'charlie']);
  });

  it('the latest of a summary is the newest permitted listed version, never a tombstoned one', async () => {
    const f = fixture([policyRule(BLOCK, { packageKey: 'alpha', members: ['1.0.1'] })]);
    const rows = await f.factsReader.versionFacts({ orgId: 'org-a' } as never, {
      packageId: PKG_A,
      limit: 10,
    });
    vi.mocked(f.factsReader.versionFacts).mockImplementation(async (ctx, query) =>
      query.packageId === PKG_A
        ? rows.map((row) => (row.version === '1.0.2' ? { ...row, status: 'tombstoned' } : row))
        : [],
    );
    const body = (await (await f.list()).json()) as ListBody;
    expect(
      body.items.map(({ name, latestVersion, versionCount }) => [
        name,
        latestVersion,
        versionCount,
      ]),
    ).toEqual([['alpha', '1.0.0', 2]]);
  });
});

const READER = ['org:sources:read'];
const id = (n: number) => `01J0K00000000000000000${String(n).padStart(4, '0')}`;
const key = (n: number) => `p${String(n).padStart(4, '0')}`;

describe('organization package views with registry policy', () => {
  it('an organization reader without management sees only permitted versions and packages', async () => {
    const { orgList } = fixture([
      policyRule(BLOCK, { packageKey: 'alpha', members: [] }),
      policyRule('01J0P0000000000000000000B2', { packageKey: 'bravo', members: ['1.0.1'] }),
    ]);
    for (const permissions of [READER, undefined]) {
      const body = (await (await orgList(permissions)).json()) as ListBody;
      expect(
        body.items.map(({ name, latestVersion, versionCount }) => [
          name,
          latestVersion,
          versionCount,
        ]),
      ).toEqual([
        ['bravo', '1.0.0', 1],
        ['charlie', '1.0.1', 2],
      ]);
      expect(body.items[0]).toMatchObject({ versionCountTruncated: false });
    }
  });

  it('an organization reader gets no denied version; an all-denied package is the uniform 404', async () => {
    const { orgVersions } = fixture([
      policyRule(BLOCK, { packageKey: 'alpha', members: ['1.0.0'] }),
      policyRule('01J0P0000000000000000000B2', { packageKey: 'bravo', members: [] }),
    ]);
    const body = (await (await orgVersions(PKG_A, READER)).json()) as {
      items: Array<{ version: string }>;
    };
    expect(body.items.map((entry) => entry.version)).toEqual(['1.0.1', '1.0.2']);
    const hidden = await orgVersions(PKG_B, READER);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('the organization view applies organization rules only, never a project rule', async () => {
    const { orgList, setup } = fixture([
      policyRule(BLOCK, {
        packageKey: 'alpha',
        members: [],
        projectId: '01J0K0000000000000000000PJ',
      }),
    ]);
    const body = (await (await orgList(READER)).json()) as ListBody;
    expect(body.items.map((entry) => entry.name)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(new Set(setup.policy.queries.map(({ query }) => query.projectId))).toEqual(
      new Set([null]),
    );
  });

  it('an unreadable policy is the fixed 503 for an organization reader', async () => {
    const { orgList, setup } = fixture();
    setup.policy.state.fail = true;
    const response = await orgList(READER);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'policy_unavailable' } });
  });

  it('with the flag off, the organization views stay unfiltered for every caller', async () => {
    const { orgList } = fixture([policyRule(BLOCK, { packageKey: 'alpha', members: [] })], false);
    const body = (await (await orgList(READER)).json()) as ListBody;
    expect(body.items.map((entry) => entry.name)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(body.items[0]).not.toHaveProperty('versionCountTruncated');
  });
});

describe('policy view work bounds', () => {
  it('counts at most the newest 100 versions per package and reports a lower bound, not 503', async () => {
    const catalogue = Array.from({ length: 70 }, (_, n) => [id(n), key(n), 150] as const);
    const { list } = fixture([], true, [], catalogue);
    const response = await list('?limit=100');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListBody & {
      items: Array<{ versionCountTruncated: boolean }>;
    };
    expect(body.items).toHaveLength(70);
    expect(body.items[0]).toMatchObject({
      latestVersion: '1.0.149',
      versionCount: 100,
      versionCountTruncated: true,
    });
  });

  it('a package within the bound reports an exact count', async () => {
    const { list } = fixture();
    const body = (await (await list()).json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ versionCount: 3, versionCountTruncated: false });
  });

  it('stops advancing over hidden pages before the decision budget runs out', async () => {
    const catalogue = Array.from({ length: 150 }, (_, n) => [id(n), key(n), 100] as const);
    const blocks = catalogue.map(([, packageKey], n) =>
      policyRule(`01J0P00000000000000000${String(n).padStart(4, '0')}`, {
        packageKey,
        members: [],
      }),
    );
    const { list } = fixture(blocks, true, [], catalogue);
    const response = await list('?limit=50');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListBody;
    expect(body.items).toEqual([]);
    expect(body.next).toBe(key(99));
  });

  it('a package-wide request denial ends a version list before any version page is read', async () => {
    const { versions, reader } = fixture([], true, [
      async (input) =>
        input.phase === 'request' && input.packageKey === 'alpha'
          ? { deny: true, reason: 'restricted' }
          : undefined,
    ]);
    const hidden = await versions(PKG_A, '?limit=1');
    expect(hidden.status).toBe(404);
    expect(reader.listVersions).not.toHaveBeenCalled();
    const paged = await versions(PKG_A, `?limit=1&after=${vid(PKG_A, 0)}`);
    expect(await paged.json()).toEqual({ items: [], next: null });
    expect((await versions(PKG_B)).status).toBe(200);
  });
});

describe('package detail with registry policy', () => {
  it('the project detail counts only permitted versions and never names a denied latest', async () => {
    const { detail } = fixture([policyRule(BLOCK, { packageKey: 'alpha', members: ['1.0.2'] })]);
    const response = await detail(PKG_A);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: 'alpha',
      latestVersion: '1.0.1',
      versionCount: 2,
      versionCountTruncated: false,
      visibleToNewProjects: true,
      newProjectAccessMode: 'none',
      revision: 1,
    });
  });

  it('an all-denied package detail is the uniform 404 in both boundaries', async () => {
    const { detail } = fixture([policyRule(BLOCK, { packageKey: 'alpha', members: [] })]);
    for (const permissions of [undefined, READER]) {
      const hidden = await detail(PKG_A, permissions);
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('an organization reader gets the filtered detail; a package manager the unfiltered one', async () => {
    const { detail, setup } = fixture([
      policyRule(BLOCK, { packageKey: 'alpha', members: ['1.0.2'] }),
    ]);
    expect(await (await detail(PKG_A, READER)).json()).toMatchObject({
      latestVersion: '1.0.1',
      versionCount: 2,
    });
    const queries = setup.policy.queries.length;
    const managed = await (await detail(PKG_A, ['org:sources:read', 'org:packages:manage'])).json();
    expect(managed).toMatchObject({ latestVersion: '1.0.2', versionCount: 3 });
    expect(managed).not.toHaveProperty('versionCountTruncated');
    expect(setup.policy.queries).toHaveLength(queries);
  });

  it('a package-wide request denial hides the project detail', async () => {
    const { detail } = fixture([], true, [
      async (input) =>
        input.phase === 'request' && input.packageKey === 'alpha'
          ? { deny: true, reason: 'restricted' }
          : undefined,
    ]);
    expect((await detail(PKG_A)).status).toBe(404);
    expect((await detail(PKG_B)).status).toBe(200);
  });

  it('an unreadable policy is the fixed 503 for the detail', async () => {
    const { detail, setup } = fixture();
    setup.policy.state.fail = true;
    const response = await detail(PKG_A);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'policy_unavailable' } });
  });

  it('with the flag off, the detail is the stored row for every caller', async () => {
    const { detail, factsReader, setup } = fixture(
      [policyRule(BLOCK, { packageKey: 'alpha', members: [] })],
      false,
    );
    for (const permissions of [undefined, READER]) {
      const response = await detail(PKG_A, permissions);
      expect(await response.json()).toEqual({
        ...item(PKG_A, 'alpha', 3),
        visibleToNewProjects: true,
        newProjectAccessMode: 'none',
        revision: 1,
      });
    }
    expect(factsReader.versionFacts).not.toHaveBeenCalled();
    expect(setup.policy.queries).toEqual([]);
  });
});
