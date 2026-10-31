import { sql } from 'kysely';
import { expect } from 'vitest';
import { compile, db } from '../../kysely.js';
import { proxyClaimsVerified } from '../../repositories/proxy-claims.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, seedSource } from './fixtures.js';

function foreignClaim(part: 'source' | 'registration'): ContractCase {
  return {
    name: `proxy proof ignores foreign ${part}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'H', part === 'source' ? foreign.orgId : own.orgId, 'hosted');
      await seed("UPDATE source SET ecosystem = 'npm' WHERE id = 'H'");
      await seed.forged(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('C', ?, 'H', 'npm', 'widget')",
        part === 'registration' ? foreign.orgId : own.orgId,
      );
      expect(
        await context.executor.all(
          context.mutate(
            compile(db.selectNoFrom(sql<number>`${proxyClaimsVerified(own)}`.as('verified'))),
          ),
        ),
      ).toEqual([{ verified: 1 }]);
    },
  };
}

export const entries: readonly MutationEntry[] = [
  {
    builder: 'proxyClaimsVerified',
    file: 'repositories/proxy-claims.ts',
    cases: [foreignClaim('source'), foreignClaim('registration')],
    predicates: [
      {
        name: 'claim owner organization',
        locate: /claim_owner\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: foreignClaim('source').name,
      },
      {
        name: 'claim registration organization',
        locate: /proxy_claim\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: foreignClaim('registration').name,
      },
    ],
  },
];
