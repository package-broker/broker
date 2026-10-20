import { expect } from 'vitest';
import type { CatalogueReader } from '@package-broker/core/db/catalogue';
import type { OrgContext, ScalarSqlExecutor } from '@package-broker/core/db/port';
import { createCatalogueReader } from '../../repositories/catalogue.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { NOT_NULL, ref, seedPackage, seedProject, seedSource, seedVersion } from './fixtures.js';

const scope = { projectId: 'P-O', ecosystem: 'npm' } as const;
const query = { ...scope, key: 'widget' } as const;
const calls: Record<
  keyof CatalogueReader,
  (reader: CatalogueReader, ctx: OrgContext) => Promise<unknown>
> = {
  resolveVersions: (reader, ctx) => reader.resolveVersions(ctx, { ...query, limit: 10 }),
  lookupVersion: (reader, ctx) =>
    reader.lookupVersion(ctx, { ...query, versionNormalized: '1.0.0' }),
  lookupTag: (reader, ctx) => reader.lookupTag(ctx, { ...query, tag: 'latest' }),
  distTags: (reader, ctx) => reader.distTags(ctx, query),
  listVisible: (reader, ctx) => reader.listVisible(ctx, { ...scope, limit: 10 }),
  search: (reader, ctx) => reader.search(ctx, { ...scope, text: 'widget', limit: 10 }),
  resolveDist: (reader, ctx) =>
    reader.resolveDist(ctx, { ...query, by: 'version', versionNormalized: '1.0.0' }),
  admitProxy: (reader, ctx) => reader.admitProxy(ctx, { ...query, key: 'absent' }),
  pageEdges: (reader, ctx) => reader.pageEdges(ctx, { ...scope, limit: 10 }),
  classify: (reader, ctx) => reader.classify(ctx, { ...scope, keys: ['widget'] }),
  classifyWinners: (reader, ctx) => reader.classifyWinners(ctx, { ...scope, keys: ['widget'] }),
  previewWinners: (reader, ctx) => reader.previewWinners(ctx, query),
};

const empty: Record<keyof CatalogueReader, unknown> = {
  resolveVersions: null,
  lookupVersion: null,
  lookupTag: null,
  distTags: null,
  listVisible: { items: [], next: null, openNamespace: false },
  search: [],
  resolveDist: null,
  admitProxy: [],
  pageEdges: { rows: [], next: null },
  classify: [{ key: 'widget', class: 'not_available' }],
  classifyWinners: [{ key: 'widget', winner: null }],
  previewWinners: [],
};

async function seedCatalogue(context: CaseContext, foreignMembership = false): Promise<void> {
  const seed = seeder(context.executor);
  const { own, foreign } = orgOf(context);
  for (const [suffix, ctx] of [
    ['O', own],
    ['F', foreign],
  ] as const) {
    await seedProject(seed, `P-${suffix}`, ctx.orgId);
    await seedSource(seed, `S-${suffix}`, ctx.orgId, 'npm_registry', 'npm');
    await seedPackage(seed, `K-${suffix}`, ctx.orgId, `S-${suffix}`, 'widget', 'npm');
    await seedVersion(seed, `V-${suffix}`, ctx.orgId, `K-${suffix}`, '1.0.0');
    await seed(
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      ctx.orgId,
      `P-${suffix}`,
      `S-${suffix}`,
    );
    await seed.forged(
      "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'explicit')",
      foreignMembership && suffix === 'O' ? foreign.orgId : ctx.orgId,
      `P-${suffix}`,
      `K-${suffix}`,
    );
    await seed(
      "INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, 'latest', ?)",
      ctx.orgId,
      `K-${suffix}`,
      `V-${suffix}`,
    );
    await seedSource(seed, `PROXY-${suffix}`, ctx.orgId, 'npmjs_proxy', 'npm');
    await seed(
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      ctx.orgId,
      `P-${suffix}`,
      `PROXY-${suffix}`,
    );
  }
}

function readerOf(context: CaseContext): CatalogueReader {
  const executor: ScalarSqlExecutor = {
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  };
  return createCatalogueReader(executor);
}

const isolation: ContractCase = {
  name: 'all catalogue methods return only the caller organization data',
  async run(context) {
    await seedCatalogue(context);
    const { own, foreign } = orgOf(context);
    const reader = readerOf(context);
    for (const method of Object.keys(calls) as (keyof CatalogueReader)[]) {
      const result = await calls[method](reader, own);
      expect(result, method).not.toEqual(empty[method]);
      expect(JSON.stringify(result), method).not.toMatch(/(?:K-F|S-F|V-F|PROXY-F)/);
      const foreignResult = await calls[method](reader, foreign);
      expect(foreignResult, method).toEqual(empty[method]);
    }
    expect(
      await reader.resolveDist(own, { ...query, by: 'id', versionId: 'V-O', revision: 1 }),
    ).toMatchObject({ versionId: 'V-O', current: true });
    expect(
      await reader.resolveDist(foreign, { ...query, by: 'id', versionId: 'V-O', revision: 1 }),
    ).toBeNull();
  },
};

const membershipMethods = [
  'resolveVersions',
  'lookupVersion',
  'lookupTag',
  'distTags',
  'listVisible',
  'search',
  'resolveDist',
  'classifyWinners',
  'previewWinners',
] as const;

function foreignMembership(method: (typeof membershipMethods)[number]): ContractCase {
  return {
    name: `${method} rejects a catalogue membership of another organization`,
    async run(context) {
      await seedCatalogue(context, true);
      const { own } = orgOf(context);
      const result = await calls[method](readerOf(context), own);
      expect(result).toEqual(
        method === 'listVisible'
          ? { ...(empty.listVisible as object), openNamespace: true }
          : empty[method],
      );
    },
  };
}

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/catalogue.ts',
    builder: 'createCatalogueReader',
    cases: [isolation, ...membershipMethods.map(foreignMembership)],
    predicates: membershipMethods.map((method) => ({
      name: `${method} scopes catalogue membership to the organization`,
      locate: ref('pp', 'org_id', '\\?'),
      neutral: NOT_NULL,
      copies: 1,
      caseName: foreignMembership(method).name,
    })),
    waivers: [
      {
        locate: /"?guard_\w+"?\."?org_id"? = /,
        reason:
          'The composition adds no SQL: attachedSourceCondition, readTimeCondition and proxyEligibleCondition are delegated unchanged; their foreign attachment, source, project, shadow and registered-name cases are registered in catalogue-predicates.ts and proxy-admission.ts.',
      },
      {
        locate: /(?<![\w".])"?(?:pkg|src|ps|bpp|bp|bs|bps)"?\."?org_id"? = /,
        reason:
          'Delegated winner queries join the same package, source and attachment ids as the scoped guards; visibleWinner and catalogue-predicates registrations test the shared guards. Better-winner aliases repeat that filtering for competing candidates. This factory only composes the existing repositories.',
      },
      {
        locate: /(?<![\w".])(?:v|ev|r|kp|e|dt|b|hp|hs|pj|ops|os|op)\.org_id = /,
        reason:
          'Version, tag, blob, epoch, edge, attachability and open-namespace scopes belong to the delegated read repositories, not this SQL-free composition. The all-method case exercises each statement with two populated organizations and rejects foreign-project reads; individual mutations of these delegate-specific scopes remain the responsibility of those repository registrations.',
      },
      {
        locate: /"k"\."org_id" = \?/,
        reason:
          'The factory delegates admission unchanged; k.org_id is a literal caller org in admitProxy and classify. The independently supplied foreign key is mutation-tested by admittedProxySources in proxy-admission.ts.',
      },
    ],
  },
];
