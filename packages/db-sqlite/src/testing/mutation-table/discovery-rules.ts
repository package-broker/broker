import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { expect } from 'vitest';
import { sql } from 'kysely';
import { compile, db } from '../../kysely.js';
import { createDiscoveryRuleRepository } from '../../repositories/discovery-rules.js';
import {
  discoveryRuleAuthority,
  sourceAuthority,
  discoverySourceOwned,
} from '../../repositories/discovery-rule-authority.js';
import {
  RULE_ID,
  seedDiscoveryRule,
  seedDiscoveryLease,
  ruleFence,
} from '../discovery-rules-fixture.js';
import { executing, factoryEntry } from './factory-cases.js';
import { held } from './fixtures.js';
import { orgOf, type MutationEntry } from './harness.js';

const authorityDecisions: NonNullable<MutationEntry['sqlDecisions']> = [
  [
    'rule identity',
    /dr\.id = \?/,
    '? is not null',
    "update source_discovery_rule set id='OTHER' where org_id=?",
  ],
  [
    'credential identity',
    /dr\.credential_id = \?/,
    '? is not null',
    "update source_discovery_rule set credential_id='OTHER' where org_id=?",
  ],

  [
    'revision',
    /dr\.revision = \?/,
    '? is not null',
    'update source_discovery_rule set revision=2 where org_id=?',
  ],
  [
    'enabled',
    /dr\.enabled = 1/,
    '1=1',
    'update source_discovery_rule set enabled=0 where org_id=?',
  ],
  [
    'installation',
    /dr\.installation_id = \?/,
    '? is not null',
    'update source_discovery_rule set installation_id=42 where org_id=?',
  ],
  [
    'credential kind',
    /dc\.kind = 'github_app'/,
    '1=1',
    "update credential set kind='github_token' where org_id=?",
  ],
  [
    'credential scope',
    /dc\.project_id is null/,
    '1=1',
    "update credential set project_id='P' where org_id=?",
  ],
  ['job identity', /dj\.id = \?/, '? is not null', "update job set id='OTHER' where org_id=?"],
  [
    'lease owner',
    /dj\.lease_owner = \?/,
    '? is not null',
    "update job set lease_owner='other' where org_id=?",
  ],
  ['lease fence', /dj\.fence = \?/, '? is not null', 'update job set fence=4 where org_id=?'],
  ['job state', /dj\.state = 'running'/, '1=1', "update job set state='succeeded' where org_id=?"],
  [
    'lease expiry',
    /dj\.lease_until > strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/,
    '1=1',
    "update job set lease_until='2000-01-01T00:00:00.000Z' where org_id=?",
  ],
  [
    'job type',
    /dj\.type = 'core:discovery-rule:v1'/,
    '1=1',
    "update job set type='core:other:v1' where org_id=?",
  ],
  [
    'resource key',
    /dj\.resource_key = \?/,
    '? is not null',
    "update job set resource_key='other' where org_id=?",
  ],
  [
    'payload rule',
    /json_extract\(dj\.payload_json, '\$\.ruleId'\) = dr\.id/,
    '1=1',
    `update job set payload_json='{"ruleId":"other","revision":1}' where org_id=?`,
  ],
  [
    'payload revision',
    /json_extract\(dj\.payload_json, '\$\.revision'\) = dr\.revision/,
    '1=1',
    `update job set payload_json='{"ruleId":"${RULE_ID}","revision":2}' where org_id=?`,
  ],
].map(([label, pattern, replacement, mutation]) => ({
  name: `discovery ${String(label)} guard`,
  pattern: pattern as RegExp,
  replacement: replacement as string,
  expected: 1,
  case: {
    name: `revoked ${String(label)} denies scheduled writes`,
    async run(context) {
      const { own } = orgOf(context);
      await seedDiscoveryRule(context.executor, own);
      await seedDiscoveryLease(context.executor, own);
      await context.executor.all({
        sql: "insert into project(id,org_id,slug,name) values('P',?,'p','P')",
        params: [own.orgId],
      });
      expect(await held(context, discoveryRuleAuthority(own, ruleFence()), false)).toBe(true);
      if (label === 'credential identity')
        await context.executor.all({
          sql: "insert into credential(id,org_id,kind,ciphertext,nonce,key_version,aad) values('OTHER',?,'github_app',x'00',zeroblob(12),1,'aad')",
          params: [own.orgId],
        });
      await context.executor.all({ sql: mutation as string, params: [own.orgId] });
      if (label === 'rule identity')
        await context.executor.all({
          sql: 'update job set payload_json=? where org_id=?',
          params: [JSON.stringify({ ruleId: 'OTHER', revision: 1 }), own.orgId],
        });

      if (label === 'revision')
        await context.executor.all({
          sql: 'update job set payload_json=? where org_id=?',
          params: [JSON.stringify({ ruleId: RULE_ID, revision: 2 }), own.orgId],
        });
      expect(await held(context, discoveryRuleAuthority(own, ruleFence()), true)).toBe(false);
    },
  },
}));

const registrations: readonly MutationEntry[] = [
  ...(['list', 'get', 'due'] as const).map((method) =>
    factoryEntry(
      'discovery-rules',
      'createDiscoveryRuleRepository',
      {
        name: `${method} excludes foreign discovery rules`,
        async run(context) {
          const { own, foreign } = orgOf(context);
          await seedDiscoveryRule(context.executor, foreign);
          if (method === 'due') {
            await context.executor.all({
              sql: "insert into credential(id,org_id,kind,ciphertext,nonce,key_version,aad) values('OWN-CREDENTIAL',?,'github_app',x'00',zeroblob(12),1,'aad')",
              params: [own.orgId],
            });
            // A damaged binding isolates the rule scope from the redundant credential scope.
            await context.executor.all({ sql: 'pragma foreign_keys=off', params: [] });
            await context.executor.all({
              sql: "update source_discovery_rule set credential_id='OWN-CREDENTIAL' where org_id=?",
              params: [foreign.orgId],
            });
            await context.executor.all({ sql: 'pragma foreign_keys=on', params: [] });
          }
          const repo = createDiscoveryRuleRepository(executing(context), []);
          expect(
            await (method === 'get'
              ? repo.get(own, RULE_ID)
              : method === 'list'
                ? repo.list(own, null, 100)
                : repo.due(own, new Date().toISOString())),
          ).toEqual(method === 'get' ? null : []);
        },
      },
      method === 'due' ? /dr.org_id=\?/ : /org_id=\?/,
      method === 'due'
        ? [
            {
              locate: /where org_id=\?/,
              reason: 'The terminal invalid-binding update is independently mutated below.',
            },
            {
              locate: /c.org_id=\?/,
              reason:
                'Credential correlation is bounded by the scoped rule and its composite credential FK.',
            },
            {
              locate: /j.org_id=\?/,
              reason:
                'The resource exclusion can only remove a scoped due candidate; it cannot expose a foreign rule.',
            },
          ]
        : [],
    ),
  ),
  ...(['discoveryRuleAuthority', 'sourceAuthority'] as const).flatMap((builder) => [
    factoryEntry(
      'discovery-rule-authority',
      builder,
      {
        name: `${builder} excludes a foreign rule and its lease`,
        async run(context) {
          const { own, foreign } = orgOf(context);
          await seedDiscoveryRule(context.executor, foreign);
          await seedDiscoveryLease(context.executor, foreign);
          const build =
            builder === 'discoveryRuleAuthority'
              ? discoveryRuleAuthority(own, ruleFence())
              : sourceAuthority(own, ruleFence(), {
                  permission: 'org:sources:write',
                  projectId: null,
                  providerAnchors: [],
                });
          expect(await held(context, build, true)).toBe(false);
        },
      },
      /dr.org_id = \?/,
      [
        {
          locate: /dc.org_id = dr.org_id/,
          reason:
            'Organization join follows the registered dr scope; a foreign credential is covered by the composite credential foreign key.',
        },
        {
          locate: /dj.org_id = dr.org_id/,
          reason:
            'The lease join must belong to the rule organization; independently mutated below.',
        },
      ],
    ),
    factoryEntry(
      'discovery-rule-authority',
      builder,
      {
        name: `${builder} rejects a foreign job with an own rule`,
        async run(context) {
          const { own, foreign } = orgOf(context);
          await seedDiscoveryRule(context.executor, own);
          await seedDiscoveryLease(context.executor, foreign);
          const build =
            builder === 'discoveryRuleAuthority'
              ? discoveryRuleAuthority(own, ruleFence())
              : sourceAuthority(own, ruleFence(), {
                  permission: 'org:sources:write',
                  projectId: null,
                  providerAnchors: [],
                });
          const statement = compile(db.selectNoFrom(sql<number>`(${build})`.as('held')));
          expect((await executing(context).all<{ held: number }>(statement))[0]?.held).toBe(0);
        },
      },
      /dj.org_id = dr.org_id/,
      [
        { locate: /dr.org_id = \?/, reason: 'Registered by the foreign rule case.' },
        {
          locate: /dc.org_id = dr.org_id/,
          reason: 'Composite credential foreign key binds the credential to this organization.',
        },
      ],
      '(1 = 1)',
    ),
  ]),
  factoryEntry(
    'discovery-rules',
    'createDiscoveryRuleRepository',
    {
      name: 'credential failure writes leave foreign invalid bindings unchanged',
      async run(context) {
        const { own, foreign } = orgOf(context);
        await seedDiscoveryRule(context.executor, foreign);
        await seedDiscoveryRule(context.executor, own, RULE_ID, 'OWN-CREDENTIAL');
        await context.executor.all({
          sql: "update credential set kind='github_token' where org_id=?",
          params: [own.orgId],
        });
        await context.executor.all({
          sql: "update credential set kind='github_token' where org_id=?",
          params: [foreign.orgId],
        });
        await seedDiscoveryLease(context.executor, own);
        await context.executor.all({
          sql: "update job set type='core:discovery-rules:v1' where org_id=?",
          params: [own.orgId],
        });
        const counted = executing(context);
        const checked: SqlExecutor = {
          ...counted,
          async all<R>(statement: Statement) {
            const rows = await counted.all<R>(statement);
            if (statement.sql.startsWith('select id from source_discovery_rule'))
              expect(rows).toHaveLength(1);
            return rows;
          },
        };
        await createDiscoveryRuleRepository(checked, []).failUnavailableCredentials(
          own,
          { id: 'DRJOB', owner: 'worker', fence: 3 },
          new Date().toISOString(),
        );
        expect(
          (await createDiscoveryRuleRepository(context.executor, []).get(foreign, RULE_ID))
            ?.outcome,
        ).toBeNull();
      },
    },
    /org_id=\?(?= and (?:enabled=1|id=\? and enabled=1))/,
    [
      {
        locate: /(?<=from job where )org_id=\?/,
        reason:
          'Scheduler type validation repeats the organization-bound jobLeaseGuard checked immediately before it.',
      },
      {
        locate: /job\.org_id = \?/,
        reason:
          'The job lease guard is independently mutation tested; scheduler lease failure contracts cover stale and foreign leases.',
      },
      {
        locate: /c.org_id=\?/,
        reason: 'Credential correlation follows the scoped rule and the credential composite FK.',
      },
      { locate: /j.org_id=\?/, reason: 'Resource filtering can only remove scoped candidates.' },
    ],
    undefined,
    2,
  ),
  factoryEntry(
    'discovery-rule-authority',
    'discoverySourceOwned',
    {
      name: 'ownership refuses a source and run in another organization',
      async run(context) {
        const { own, foreign } = orgOf(context);
        await seedDiscoveryRule(context.executor, foreign);
        await context.executor.all({
          sql: "insert into source(id,org_id,name,ecosystem,type) values('owned-source',?,'Owned','npm','vcs')",
          params: [foreign.orgId],
        });
        await context.executor.all({
          sql: 'insert into source_discovery_admission(org_id,source_id,rule_id) values(?,?,?)',
          params: [foreign.orgId, 'owned-source', RULE_ID],
        });
        expect(
          await held(context, discoverySourceOwned(own, ruleFence(), 'owned-source'), true),
        ).toBe(false);
      },
    },
    /da.org_id=\?/,
    [
      {
        locate: /dr.org_id=da.org_id/,
        reason: 'The join follows the independently mutated admission organization scope.',
      },
    ],
  ),
];

const ownershipDecisions: NonNullable<MutationEntry['sqlDecisions']> = [
  ['source identity', /da.source_id=\?/, '? is not null'],
  ['rule identity', /da.rule_id=\?/, '? is not null'],
].map(([label, pattern, replacement]) => ({
  name: `discovery ownership ${String(label)}`,
  pattern: pattern as RegExp,
  replacement: replacement as string,
  expected: 1,
  case: {
    name: `ownership refuses a different ${String(label)}`,
    async run(context) {
      const { own } = orgOf(context);
      await seedDiscoveryRule(context.executor, own);
      await context.executor.all({
        sql: "insert into source(id,org_id,name,ecosystem,type) values('owned-source',?,'Owned','npm','vcs')",
        params: [own.orgId],
      });
      await context.executor.all({
        sql: 'insert into source_discovery_admission(org_id,source_id,rule_id) values(?,?,?)',
        params: [own.orgId, 'owned-source', RULE_ID],
      });
      expect(
        await held(context, discoverySourceOwned(own, ruleFence(), 'owned-source'), false),
      ).toBe(true);
      if (label === 'rule identity') {
        await context.executor.all({
          sql: "insert into source_discovery_rule(org_id,id,name,credential_id,installation_id,ecosystem,repository_pattern,created_at,updated_at) select org_id,'OTHER','Other',credential_id,installation_id,ecosystem,repository_pattern,created_at,updated_at from source_discovery_rule where org_id=?",
          params: [own.orgId],
        });
        await context.executor.all({
          sql: "update source_discovery_admission set rule_id='OTHER' where org_id=?",
          params: [own.orgId],
        });
      }
      expect(
        await held(
          context,
          discoverySourceOwned(
            own,
            ruleFence(),
            label === 'source identity' ? 'OTHER' : 'owned-source',
          ),
          true,
        ),
      ).toBe(false);
    },
  },
}));

export const entries: readonly MutationEntry[] = registrations.map((entry, index) =>
  entry.builder === 'discoverySourceOwned'
    ? { ...entry, sqlDecisions: ownershipDecisions }
    : index === 3
      ? { ...entry, sqlDecisions: authorityDecisions }
      : entry,
);
