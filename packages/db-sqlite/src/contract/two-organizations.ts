import { orgContext } from '@package-broker/core/db/port';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';

export interface TwoOrganizations {
  readonly a: OrgContext;
  readonly b: OrgContext;
}

const A = { id: '01J00000000000000000000A0A', slug: 'org-a', name: 'Organization A' } as const;
const B = { id: '01J00000000000000000000B0B', slug: 'org-b', name: 'Organization B' } as const;

function insert(org: {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}): ScalarStatement {
  return {
    sql: 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)',
    params: [org.id, org.slug, org.name],
  };
}

/** Test databases only. */
export async function seedTwoOrganizations(executor: ScalarSqlExecutor): Promise<TwoOrganizations> {
  await executor.batch([
    { sql: 'DROP INDEX organization_singleton', params: [] },
    insert(A),
    insert(B),
  ]);
  return { a: orgContext(A.id), b: orgContext(B.id) };
}
