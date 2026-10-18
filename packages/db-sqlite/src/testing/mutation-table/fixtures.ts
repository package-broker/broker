import { orgOf, seeder, type CaseContext, type Seed, type OrgWaiver } from './harness.js';
import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import { sql } from 'kysely';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { compile, db } from '../../kysely.js';
import type { Expression, SqlBool } from 'kysely';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import type { ProtectedHolderProvider } from '../../kysely.js';
import { createCatalogueWriteGuard } from '../../repositories/catalogue-write-package.js';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';

export const NOT_NULL = '(? is not null)';

export const ALWAYS = '(1 = 1)';

export const A_JOB = '01J0JOB00000000000000000M1';

export const OWNER = '01J0WWWWWWWWWWWWWWWWWW0M01';

export const FUTURE = '2099-01-01T00:00:00.000Z';

export const HASH = 'a'.repeat(64);

export const OTHER_HASH = 'b'.repeat(64);

export const ref = (table: string, column: string, tail: string): RegExp =>
  new RegExp(`(?<![\\w".])"?${table}"?\\."?${column}"? = ${tail}`);

export async function seedProject(seed: Seed, id: string, orgId: string): Promise<void> {
  await seed(
    'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
    id,
    orgId,
    id.toLowerCase(),
    id,
    'active',
  );
}

export async function seedSource(
  seed: Seed,
  id: string,
  orgId: string,
  type: string,
  ecosystem = 'composer',
): Promise<void> {
  await seed(
    'INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, ?, ?)',
    id,
    orgId,
    id,
    ecosystem,
    type,
  );
}

export async function seedPackage(
  seed: Seed,
  id: string,
  orgId: string,
  sourceId: string,
  name: string,
  ecosystem = 'composer',
): Promise<void> {
  await seed(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)',
    id,
    orgId,
    sourceId,
    ecosystem,
    name,
  );
}

export async function seedUser(seed: Seed, id: string, orgId: string): Promise<void> {
  await seed(
    'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
    id,
    orgId,
    `${id.toLowerCase()}@example.test`,
  );
}

export async function seedVersion(
  seed: Seed,
  id: string,
  orgId: string,
  packageId: string,
  version: string,
): Promise<void> {
  await seed(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, 'upstream', '{}')`,
    id,
    orgId,
    packageId,
    version,
    version,
    '2020-01-01T00:00:00.000Z',
  );
}

export const sessionOfForeignUser = async (context: CaseContext): Promise<void> => {
  const seed = seeder(context.executor);
  const { foreign } = orgOf(context);
  await seedUser(seed, 'U-FOREIGN', foreign.orgId);
  await seed(
    `INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    'SES-FOREIGN',
    foreign.orgId,
    'U-FOREIGN',
    HASH,
    OTHER_HASH,
    FUTURE,
  );
};

export type Layer = 'user' | 'grant' | 'role' | 'permission' | 'identity' | 'binding';

export const CHAIN: readonly Layer[] = ['user', 'grant', 'role', 'permission'];

export const ANCHORS: readonly ProtectedHolderProvider[] = [
  { provider: 'oidc', anchor: 'oidc:https://idp.example.test', emailAuthoritative: true },
  { provider: 'oidc2', anchor: 'oidc:https://idp2.example.test', emailAuthoritative: true },
];

export const ORG_PERMISSION = 'org:settings:write';

export const PROJECT_PERMISSION = 'project:packages:write';

export interface Subject {
  readonly userId: string;
  readonly sessionId: string;
}

export async function seedSubject(
  context: CaseContext,
  key: string,
  options: { projectId?: string; mismatched?: Layer } = {},
): Promise<Subject> {
  const seed = seeder(context.executor);
  const { own, foreign } = orgOf(context);
  const from = options.mismatched === undefined ? -1 : CHAIN.indexOf(options.mismatched);
  const chainOrg = (layer: Layer): string =>
    from >= 0 && CHAIN.indexOf(layer) >= from ? foreign.orgId : own.orgId;
  const email = `${key}@example.test`;
  const userId = `U-${key}`;
  const provider = options.mismatched === 'binding' ? 'oidc2' : 'oidc';
  const scope = options.projectId === undefined ? 'organization' : 'project';
  await seed(
    'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
    userId,
    chainOrg('user'),
    email,
    'active',
  );
  await seed(
    'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    `I-${key}`,
    options.mismatched === 'identity' ? foreign.orgId : own.orgId,
    userId,
    provider,
    `sub-${key}`,
    email,
    new Date(Date.now() - 60_000).toISOString(),
  );
  await seed(
    'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)',
    `R-${key}`,
    chainOrg('role'),
    `role-${key}`,
    key,
    scope,
  );
  await seed(
    'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
    chainOrg('permission'),
    `R-${key}`,
    options.projectId === undefined ? ORG_PERMISSION : PROJECT_PERMISSION,
  );
  await seed(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
    `G-${key}`,
    chainOrg('grant'),
    'email',
    email,
    scope,
    options.projectId ?? null,
    `R-${key}`,
  );
  const now = new Date().toISOString();
  await seed(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `SES-${key}`,
    own.orgId,
    userId,
    key.length === 0 ? HASH : `${key.padEnd(64, 'c')}`.slice(0, 64),
    OTHER_HASH,
    now,
    now,
    FUTURE,
  );
  return { userId, sessionId: `SES-${key}` };
}

export async function seedBindings(context: CaseContext): Promise<void> {
  const seed = seeder(context.executor);
  const { own, foreign } = orgOf(context);
  await seed(
    'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    own.orgId,
    'oidc',
    ANCHORS[0]?.anchor ?? '',
  );
  await seed(
    'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    foreign.orgId,
    'oidc2',
    ANCHORS[1]?.anchor ?? '',
  );
}

export async function held(
  context: CaseContext,
  guard: Expression<SqlBool>,
  mutated: boolean,
): Promise<boolean> {
  const statement = compile(db.selectNoFrom(sql<number>`(${guard})`.as('held')));
  const rows = await context.executor.all<{ held: number }>(
    mutated ? context.mutate(statement) : statement,
  );
  return rows[0]?.held === 1;
}

export function fenceOf(subject: Subject): MutationFence {
  return mutationFence(
    { userId: subject.userId, sessionId: subject.sessionId } as unknown as AuthenticatedActor,
    {},
  );
}

export async function guardPasses(
  context: CaseContext,
  guard: readonly Statement[],
  mutated: boolean,
): Promise<boolean> {
  try {
    await context.executor.batch(
      guard.map((statement) => (mutated ? context.mutate(statement) : statement)),
    );
    return true;
  } catch (error) {
    if (!String(error).includes(ACCESS_MUTATION_GUARD_CONSTRAINT)) throw error;
    return false;
  }
}

export const PERMISSION_ROWS =
  'inside permissionRows, which has its own registration (access.ts#permissionRows)';

export const REVISION_CLOCK = /max\(\s*unixepoch\('now', 'subsec'\)/;

export const WRITE_GUARD = { id: A_JOB, owner: OWNER, fence: 3 } as const;

export const WRITE_ORG = { orgId: '01J00000000000000000000A0A' } as OrgContext;

export const npmVersions = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    version: `1.0.${String(index)}`,
    versionNormalized: `1.0.${String(index)}`,
    history: { at: '2020-05-06T07:08:09.010Z', basis: 'release_date' as const },
    license: null,
    upstreamReleasedAt: null,
    distType: null,
    sourceRef: null,
    metadata: normalizeVersionMetadata('npm', { name: 'widget' }),
  }));

export const writeGuard = () => createCatalogueWriteGuard(WRITE_ORG, WRITE_GUARD);

export const GROUP_BRANCH = 'group membership branch; no case seeds memberships yet';

export const permissionRowsWaiver: OrgWaiver = {
  locate: /"guard_\w+"\."org_id" = /,
  reason: PERMISSION_ROWS,
};
