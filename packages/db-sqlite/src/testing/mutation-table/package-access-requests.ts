import { expect } from 'vitest';
import { createPackageAccessRequestRepository } from '../../repositories/package-access-requests.js';
import { accessFixture } from '../../contract/package-access-requests-fixture.js';
import { ANCHORS, NOT_NULL } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

function foreignRead(method: 'get' | 'list' | 'due'): ContractCase {
  return {
    name: `${method} excludes another organization's access request`,
    async run(context) {
      const f = await accessFixture(context.executor, context);
      const row = await f.repo.request(f.org, f.requestFence, f.input());
      await f.seed("UPDATE package_access_request SET expires_at = '2000-01-01T00:00:00.000Z'");
      const repo = createPackageAccessRequestRepository(executing(context), ANCHORS);
      const { foreign } = orgOf(context);
      if (method === 'get') expect(await repo.get(foreign, row.id)).toBeNull();
      else if (method === 'list')
        expect((await repo.list(foreign, { limit: 50 })).items).toEqual([]);
      else expect(await repo.due(foreign)).toEqual([]);
    },
  };
}
const foreignPackage: ContractCase = {
  name: 'requestable excludes a foreign package of an own source',
  async run(context) {
    const f = await accessFixture(context.executor, context);
    await f.seed.forged('UPDATE package SET org_id = ?', orgOf(context).foreign.orgId);
    expect(
      (
        await createPackageAccessRequestRepository(executing(context), ANCHORS).requestable(
          f.org,
          'PROJECT',
          { limit: 50 },
        )
      ).items,
    ).toEqual([]);
  },
};
function foreignRequestableLayer(layer: 'source' | 'project_source' | 'project'): ContractCase {
  return {
    name: `requestable excludes a foreign ${layer}`,
    async run(context) {
      const f = await accessFixture(context.executor, context);
      await f.seed.forged(`UPDATE ${layer} SET org_id = ?`, orgOf(context).foreign.orgId);
      expect(
        (
          await createPackageAccessRequestRepository(executing(context), ANCHORS).requestable(
            f.org,
            'PROJECT',
            { limit: 50 },
          )
        ).items,
      ).toEqual([]);
    },
  };
}
const foreignMembership: ContractCase = {
  name: 'foreign membership cannot hide an own requestable package',
  async run(context) {
    const f = await accessFixture(context.executor, context);
    await f.seed.forged(
      "INSERT INTO project_package (org_id, project_id, package_id, ecosystem, name, origin) VALUES (?, 'PROJECT', 'PACKAGE', 'npm', 'widget', 'explicit')",
      orgOf(context).foreign.orgId,
    );
    expect(
      (
        await createPackageAccessRequestRepository(executing(context), ANCHORS).requestable(
          f.org,
          'PROJECT',
          { limit: 50 },
        )
      ).items,
    ).toHaveLength(1);
  },
};
const requestableWaivers = [
  {
    locate: /(?<![\w])(?:p|rs|ra|rp|rm)\.org_id = \?/,
    reason:
      'Independent package, source, attachment, project and negative membership factory entries cover each organization predicate.',
  },
];
export const entries: readonly MutationEntry[] = [
  ...(
    [
      ['source', 'rs'],
      ['project_source', 'ra'],
      ['project', 'rp'],
    ] as const
  ).map(([layer, alias]) =>
    factoryEntry(
      'package-access-requests',
      'createPackageAccessRequestRepository',
      foreignRequestableLayer(layer),
      new RegExp(`(?<![\\w])${alias}\\.org_id = \\?`),
      requestableWaivers,
    ),
  ),
  factoryEntry(
    'package-access-requests',
    'createPackageAccessRequestRepository',
    foreignMembership,
    /rm\.org_id = \?/,
    requestableWaivers,
  ),
  ...(['get', 'list', 'due'] as const).map((method) =>
    factoryEntry(
      'package-access-requests',
      'createPackageAccessRequestRepository',
      foreignRead(method),
      /"ar"\."org_id" = \?/,
      [
        {
          locate: /"(?:ap|aj|au|ad)"\."org_id" = "ar"\."org_id"/,
          reason:
            'Composite organization join equality; the ar organization predicate scopes all three rows.',
        },
      ],
      NOT_NULL,
    ),
  ),
  factoryEntry(
    'package-access-requests',
    'createPackageAccessRequestRepository',
    foreignPackage,
    /(?<![\w])p\.org_id = \?/,
    requestableWaivers,
  ),
];
