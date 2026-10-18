import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile, db } from '../kysely.js';
import {
  builderAllowlist,
  checkCompleteness,
  countDecisions,
  exportedBuilders,
  judge,
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

  it('recognises builders by return type and ignores factories and plain helpers', () => {
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
    expect(exportedBuilders(source)).toEqual(['guardOne', 'planOne', 'inferred', 'arrowTwo']);
  });
});

describe('mutation table org comparisons', () => {
  for (const entry of mutationTable) {
    it(`${entry.builder}: every org_id comparison is registered or waived`, async () => {
      expect(await unaccountedOrgComparisons(entry)).toEqual([]);
    });
  }
});
