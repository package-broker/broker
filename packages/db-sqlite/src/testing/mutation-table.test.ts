import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile, db } from '../kysely.js';
import {
  builderAllowlist,
  checkCompleteness,
  countDecisions,
  exportedBuilders,
  judge,
  judgeBatchDecision,
  judgeSqlDecision,
  mutationTable,
  orgOf,
  plantRepeatedDecision,
  seeder,
  unaccountedOrgComparisons,
  type ContractCase,
  type MutationEntry,
} from './mutation-table.js';

const sourceRoot = new URL('../', import.meta.url);
const excluded = /(^|\/)(migrations|contract|testing)\/|\.test\.ts$/;

function repositorySources(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
      .map((name) => name.replaceAll('\\', '/'))
      .filter((name) => name.endsWith('.ts') && !excluded.test(name))
      .map((name) => [name, readFileSync(new URL(name, sourceRoot), 'utf8')]),
  );
}

describe('mutation table', () => {
  it('closes the nine original Round B gaps with executable registrations or SQL exemptions', () => {
    const keys = mutationTable.map(({ file, builder }) => `${file}#${builder}`);
    for (const key of [
      'repositories/catalogue-read.ts#visibleWinner',
      'repositories/catalogue-status.ts#quarantineStatements',
      'repositories/project-readable.ts#listReadableProjectsStatement',
      'repositories/proxy-admission.ts#admittedProxySources',
      'repositories/role.ts#seedDefaultsStatements',
      'repositories/visibility-attach.ts#attachSourceStatements',
      'repositories/visibility-derive.ts#rederiveStatements',
      'internal/catalogue-status-statements.ts#versionStatusStatements',
      'internal/catalogue-status-statements.ts#conditionalEpochBumpStatement',
    ]) {
      if (keys.includes(key)) {
        const entry = mutationTable.find(({ file, builder }) => `${file}#${builder}` === key)!;
        expect(entry.predicates.length, key).toBeGreaterThan(0);
        expect(builderAllowlist).not.toHaveProperty(key);
      } else {
        expect(builderAllowlist[key], key).toMatch(/adds no SQL|no organization column/);
      }
    }
  });

  it('registers behavioral time decisions for package upserts and version writes', () => {
    for (const builder of [
      'packageUpsertStatements',
      'versionInsertStatements',
      'versionUpdateStatements',
    ]) {
      const entry = mutationTable.find((candidate) => candidate.builder === builder)!;
      expect(entry.sqlDecisions?.length, builder).toBeGreaterThan(0);
      expect(entry.decisions ?? [], builder).toEqual([]);
    }
  });

  it('registers this round of lease and shared guard builders', () => {
    const keys = mutationTable.map(({ file, builder }) => `${file}#${builder}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'repositories/blob-lease-guard.ts#blobLeaseNotLive',
        'repositories/fetch-lease.ts#fetchLeaseGuard',
        'repositories/fetch-lease.ts#createFetchLeaseWriteGuard',
        'repositories/job-lease-guard.ts#jobLeaseGuard',
        'repositories/catalogue-write-package.ts#createCatalogueWriteGuard',
        ...[
          'opGuard',
          'ownsIdentity',
          'anchorMatches',
          'adminEligibility',
          'usableLocalLogin',
          'verifiedIdentity',
          'boundVerifiedIdentity',
          'protectedHolder',
          'cacheEpochBumpStatements',
          'assertGuard',
        ].map((builder) => `kysely.ts#${builder}`),
        'repositories/cache-epoch-bump.ts#cacheEpochBumpStatements',
        'repositories/session.ts#revokePreviousStatement',
      ]),
    );
    for (const key of keys) expect(builderAllowlist).not.toHaveProperty(key);
  });

  it('registers a behavioral once-per-batch decision for multi-tag writes', () => {
    const entry = mutationTable.find(({ builder }) => builder === 'distTagStatements');
    expect(entry?.batchDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expected: 1,
          caseName: 'multiple tag changes advance the package revision once per batch',
        }),
      ]),
    );
  });

  it('registers at least five builders', () => {
    expect(mutationTable.length).toBeGreaterThanOrEqual(5);
  });

  for (const entry of mutationTable) {
    for (const predicate of entry.predicates) {
      it(`${entry.builder}: ${predicate.name} is needed by "${predicate.caseName}"`, async () => {
        const result = await judge(entry, predicate);
        expect(`${result.verdict}: ${result.detail}`).toMatch(/^killed/);
      });
    }
    for (const decision of entry.batchDecisions ?? []) {
      it(`${entry.builder}: ${decision.name} is needed by "${decision.caseName}"`, async () => {
        const result = await judgeBatchDecision(entry, decision);
        expect(`${result.verdict}: ${result.detail}`).toMatch(/^killed/);
      });
    }
    for (const decision of entry.sqlDecisions ?? []) {
      it(`${entry.builder}: ${decision.name} is needed by "${decision.case.name}"`, async () => {
        const result = await judgeSqlDecision(decision);
        expect(`${result.verdict}: ${result.detail}`).toMatch(/^killed/);
      });
    }
    for (const decision of entry.decisions ?? []) {
      it(`${entry.builder}: ${decision.name}`, () => {
        const statements = decision.build();
        expect(countDecisions(decision, statements)).toBe(decision.expected);
        expect(
          countDecisions(decision, plantRepeatedDecision(decision, statements)),
        ).toBeGreaterThan(decision.expected);
      });
    }
  }
});

function scopedByOrg(orgId: string) {
  return compile(db.selectFrom('project').select('project.id').where('project.org_id', '=', orgId));
}

const sensitiveCase: ContractCase = {
  name: 'a project of another organization is not listed',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seed(
      "INSERT INTO project (id, org_id, slug, name, status) VALUES ('P-F', ?, 'pf', 'pf', 'active')",
      foreign.orgId,
    );
    const rows = await context.executor.all(context.mutate(scopedByOrg(own.orgId)));
    expect(rows).toEqual([]);
  },
};

const vacuousCase: ContractCase = {
  name: 'only projects of the organization exist',
  async run(context) {
    const seed = seeder(context.executor);
    const { own } = orgOf(context);
    await seed(
      "INSERT INTO project (id, org_id, slug, name, status) VALUES ('P-O', ?, 'po', 'po', 'active')",
      own.orgId,
    );
    const rows = await context.executor.all<{ id: string }>(context.mutate(scopedByOrg(own.orgId)));
    expect(rows.map((row) => row.id)).toEqual(['P-O']);
  },
};

const fixtureEntry = (contractCase: ContractCase): MutationEntry => ({
  builder: 'fixtureScopedProjects',
  file: 'fixture.ts',
  cases: [contractCase],
  predicates: [
    {
      name: 'project rows are scoped to the organization',
      locate: /"project"\."org_id" = \?/,
      neutral: '(? is not null)',
      caseName: contractCase.name,
    },
  ],
});

describe('mutation harness', () => {
  it('kills a case that depends on the predicate', async () => {
    const entry = fixtureEntry(sensitiveCase);
    expect(await judge(entry, entry.predicates[0]!)).toMatchObject({ verdict: 'killed' });
  });

  it('reports a vacuous case', async () => {
    const entry = fixtureEntry(vacuousCase);
    expect(await judge(entry, entry.predicates[0]!)).toMatchObject({ verdict: 'vacuous' });
  });

  it('reports a locator that matches no executed statement', async () => {
    const entry = fixtureEntry(sensitiveCase);
    const missed = { ...entry.predicates[0]!, locate: /"project"\."tenant_id" = \?/ };
    expect(await judge(entry, missed)).toMatchObject({ verdict: 'not-reached' });
  });

  it('reports a baseline that already fails', async () => {
    const broken: ContractCase = {
      name: 'broken',
      run: () => Promise.reject(new Error('setup failed')),
    };
    const entry = fixtureEntry(broken);
    expect(await judge(entry, entry.predicates[0]!)).toMatchObject({ verdict: 'baseline-failed' });
  });

  it('does not count a non-assertion failure as a kill', async () => {
    const crashing: ContractCase = {
      name: 'crashing',
      async run(context) {
        const original = scopedByOrg(orgOf(context).own.orgId);
        if (context.mutate(original).sql !== original.sql) throw new TypeError('not an assertion');
      },
    };
    const entry = fixtureEntry(crashing);
    expect(await judge(entry, entry.predicates[0]!)).toMatchObject({ verdict: 'errored' });
  });

  it('flags every registered predicate once stripping is disabled', async () => {
    for (const entry of mutationTable) {
      for (const predicate of entry.predicates) {
        const result = await judge(entry, predicate, { strip: false });
        expect(result.verdict, `${entry.builder}: ${predicate.name}`).not.toBe('killed');
      }
    }
  });
});

describe('batch decision harness', () => {
  const decision = {
    name: 'advances the project name once',
    pattern: /update project set/,
    expected: 1,
    caseName: 'project name advances once',
  };
  const once: ContractCase = {
    name: decision.caseName,
    async run(context) {
      const { own } = orgOf(context);
      await seeder(context.executor)(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('P', ?, 'p', 'start')",
        own.orgId,
      );
      await context.executor.batch(
        context.mutateBatch([
          { sql: "update project set name = name || 'x' WHERE id = 'P'", params: [] },
        ]),
      );
      const rows = await context.executor.all({
        sql: "SELECT name FROM project WHERE id = 'P'",
        params: [],
      });
      expect(rows).toEqual([{ name: 'startx' }]);
    },
  };
  const entry = (contractCase: ContractCase): MutationEntry => ({
    builder: 'fixture',
    file: 'fixture.ts',
    cases: [contractCase],
    predicates: [],
  });

  it('kills a repeated statement through its observable effect', async () => {
    expect(await judgeBatchDecision(entry(once), decision)).toMatchObject({ verdict: 'killed' });
  });

  it('supports a separate time case and refuses a mismatched case name', async () => {
    const timeEntry = { ...entry(once), cases: [] };
    expect(await judgeBatchDecision(timeEntry, { ...decision, case: once })).toMatchObject({
      verdict: 'killed',
    });
    expect(
      await judgeBatchDecision(timeEntry, { ...decision, case: { ...once, name: 'different' } }),
    ).toMatchObject({ verdict: 'errored' });
  });

  it('reports a repetition that has no observable effect as vacuous', async () => {
    const vacuous: ContractCase = {
      name: decision.caseName,
      async run(context) {
        await context.executor.batch(context.mutateBatch([{ sql: 'SELECT 1', params: [] }]));
      },
    };
    expect(
      await judgeBatchDecision(entry(vacuous), { ...decision, pattern: /SELECT 1/ }),
    ).toMatchObject({ verdict: 'vacuous' });
  });

  it('reports nonassertion mutant failures as errors', async () => {
    const crashing: ContractCase = {
      name: decision.caseName,
      async run(context) {
        const statements = [{ sql: 'SELECT 1', params: [] }];
        if (context.mutateBatch(statements).length !== 1) throw new TypeError('bad batch');
      },
    };
    expect(
      await judgeBatchDecision(entry(crashing), { ...decision, pattern: /SELECT 1/ }),
    ).toMatchObject({ verdict: 'errored' });
  });

  it('requires the exact decision count, a reached statement and a passing baseline', async () => {
    expect(await judgeBatchDecision(entry(once), { ...decision, expected: 2 })).toMatchObject({
      verdict: 'errored',
    });
    expect(
      await judgeBatchDecision(entry(once), { ...decision, pattern: /missing/ }),
    ).toMatchObject({ verdict: 'not-reached' });
    expect(
      await judgeBatchDecision(
        entry({ name: decision.caseName, run: () => Promise.reject(new Error('baseline')) }),
        decision,
      ),
    ).toMatchObject({ verdict: 'baseline-failed' });
    expect(await judgeBatchDecision({ ...entry(once), cases: [] }, decision)).toMatchObject({
      verdict: 'errored',
    });
  });
});

describe('SQL decision harness', () => {
  const conditional: ContractCase = {
    name: 'chooses the true branch',
    async run(context) {
      const rows = await context.executor.all(
        context.mutate({ sql: 'SELECT CASE WHEN 1 = 1 THEN 2 ELSE 1 END AS value', params: [] }),
      );
      expect(rows).toEqual([{ value: 2 }]);
    },
  };
  const decision = {
    name: 'branch condition',
    pattern: /1 = 1/,
    replacement: '1 = 0',
    expected: 1,
    case: conditional,
  };

  it('kills a changed branch through the executed result', async () => {
    expect(await judgeSqlDecision(decision)).toMatchObject({ verdict: 'killed' });
  });

  it('rejects a surviving mutant, incorrect count and unreached decision', async () => {
    expect(await judgeSqlDecision({ ...decision, replacement: '2 = 2' })).toMatchObject({
      verdict: 'vacuous',
    });
    expect(await judgeSqlDecision({ ...decision, expected: 2 })).toMatchObject({
      verdict: 'errored',
    });
    expect(await judgeSqlDecision({ ...decision, pattern: /missing/ })).toMatchObject({
      verdict: 'not-reached',
    });
  });

  it('rejects a broken baseline and a nonassertion mutant error', async () => {
    expect(
      await judgeSqlDecision({
        ...decision,
        case: { name: 'broken', run: () => Promise.reject(new Error('broken baseline')) },
      }),
    ).toMatchObject({ verdict: 'baseline-failed' });
    expect(await judgeSqlDecision({ ...decision, replacement: 'missing_column' })).toMatchObject({
      verdict: 'errored',
    });
  });
});

describe('mutation table completeness', () => {
  it('has no unregistered, stale or doubly listed builder', () => {
    expect(checkCompleteness(repositorySources())).toEqual([]);
  });

  it('fails for an exported builder without a registration', () => {
    const sources = {
      ...repositorySources(),
      'repositories/fresh.ts':
        'export function freshStatement(ctx: OrgContext): Statement {\n  return x;\n}\n',
    };
    expect(checkCompleteness(sources)).toEqual([
      'repositories/fresh.ts#freshStatement has no registration',
    ]);
  });

  it('fails for an allowlist entry whose file no longer exports builders', () => {
    const allowlist = { ...builderAllowlist, 'gone.ts#goneStatement': 'was removed' };
    expect(checkCompleteness(repositorySources(), mutationTable, allowlist)).toEqual([
      'gone.ts#goneStatement is allowlisted but no longer exported',
    ]);
  });

  it('fails for a registration whose builder is no longer exported', () => {
    const sources = repositorySources();
    delete sources['repositories/cache-epoch.ts'];
    expect(checkCompleteness(sources)).toContain(
      'repositories/cache-epoch.ts#epochReadStatement is registered but no longer exported',
    );
  });

  it('scans every source outside tests, migrations, contract and testing', () => {
    const files = Object.keys(repositorySources());
    expect(files).toEqual(
      expect.arrayContaining([
        'kysely.ts',
        'internal/catalogue-write-guard.ts',
        'repositories/access.ts',
      ]),
    );
    expect(
      files.filter((name) => /\.test\.ts$|^(migrations|contract|testing)\//.test(name)),
    ).toEqual([]);
  });

  it('requires registration for SQL factories, including create arrow constants', () => {
    const sources = {
      'factory.ts': [
        'export function createGuard(): CatalogueWriteGuard { return guard; }',
        'export const createReader = (): Reader => reader;',
        'export async function createRemote(): Promise<Reader> { return reader; }',
      ].join('\n'),
    };
    expect(checkCompleteness(sources, [], {})).toEqual([
      'factory.ts#createGuard has no registration',
      'factory.ts#createReader has no registration',
    ]);
  });

  it('fails for an exported arrow constant without a registration', () => {
    const sources = {
      ...repositorySources(),
      'repositories/leaky.ts':
        'export const leakyStatement = (ctx: OrgContext): Statement => compile(query(ctx));\n',
    };
    expect(checkCompleteness(sources)).toEqual([
      'repositories/leaky.ts#leakyStatement has no registration',
    ]);
  });

  it('fails for a re-exported builder without a registration', () => {
    const sources = {
      ...repositorySources(),
      'repositories/relay.ts':
        "export { cacheEpochBumpStatements as relayedStatements } from '../kysely.js';\n",
    };
    expect(checkCompleteness(sources)).toEqual([
      'repositories/relay.ts#relayedStatements has no registration',
    ]);
  });

  it('recognises builders and create factories while ignoring plain helpers', () => {
    const source = [
      'export function guardOne(a: number): Guard {',
      'export function planOne(): DistTagPlan {',
      'export function createThing(): ThingRepository {',
      'export function helper(value: string): string {',
      'export async function load(): Promise<Statement> {',
      'export function inferred(a: { b: number }) {',
      'export const arrowOne = async (a: number): Promise<Statement> => x;',
      'export const arrowTwo = (a: number): Statement[] => x;',
      'export const notAFunction = sql`select 1`;',
    ].join('\n');
    expect(exportedBuilders(source)).toEqual([
      'guardOne',
      'planOne',
      'createThing',
      'inferred',
      'arrowTwo',
    ]);
  });
});

describe('mutation table org comparisons', () => {
  for (const entry of mutationTable) {
    it(`${entry.builder}: every org_id comparison is registered or waived`, async () => {
      expect(await unaccountedOrgComparisons(entry)).toEqual([]);
    });
  }
});
