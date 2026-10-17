import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { compile, db, protectedHolder, type ProtectedHolderInput } from './kysely.js';
import { lookupTokenStatement } from './repositories/access.js';
import { openMigratedDatabase, type MigratedDatabase } from './testing/migrated-database.js';

const NOW = '2026-10-15T12:00:00.000Z';
const OIDC = { provider: 'oidc', anchor: 'https://idp.example.test', emailAuthoritative: false };

let database: MigratedDatabase;
let a: OrgContext;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ({ a } = database.orgs);
});

afterEach(async () => {
  await database.close();
});

async function plan(statement: Statement): Promise<string[]> {
  const rows = await database.executor.all<{ detail: string }>({
    sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
    params: statement.params,
  });
  return rows.map((row) => row.detail);
}

function localLoginAccess(details: readonly string[]): string[] {
  return details.filter((detail) => /^(?:SCAN|SEARCH) \S*login/i.test(detail));
}

const holderInputs: Record<string, ProtectedHolderInput> = {
  local_recovery: { kind: 'local_recovery' },
  fresh: { kind: 'fresh', now: NOW, providers: [OIDC] },
};

describe('local login access paths', () => {
  const lookups = {
    'sso anchors': [OIDC],
    'no anchors': [],
  } as const;

  for (const [label, providerAnchors] of Object.entries(lookups)) {
    for (const boundary of ['project', 'organization'] as const) {
      it(`token lookup (${label}, ${boundary}) searches local_login by index`, async () => {
        const details = await plan(
          lookupTokenStatement(a, {
            selector: 'abcdefghijkl',
            boundary,
            projectSlug: boundary === 'project' ? 'alpha' : null,
            providerAnchors: [...providerAnchors],
          }),
        );
        const access = localLoginAccess(details);
        expect(access, details.join('\n')).not.toEqual([]);
        for (const detail of access) {
          expect(detail, details.join('\n')).toMatch(/^SEARCH /);
          expect(detail, details.join('\n')).toMatch(/USING (?:COVERING )?INDEX|PRIMARY KEY/);
        }
      });
    }
  }

  for (const [label, input] of Object.entries(holderInputs)) {
    it(`protectedHolder (${label}) searches local_login by index`, async () => {
      const details = await plan(
        compile(
          db
            .selectFrom('user_account as candidate')
            .select('candidate.id')
            .where((eb) => protectedHolder(a, eb.ref('candidate.id'), input)),
        ),
      );
      const access = localLoginAccess(details);
      expect(access, details.join('\n')).not.toEqual([]);
      for (const detail of access) {
        expect(detail, details.join('\n')).toMatch(/^SEARCH /);
        expect(detail, details.join('\n')).toMatch(/USING (?:COVERING )?INDEX|PRIMARY KEY/);
      }
    });
  }
});
