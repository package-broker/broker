import { expect } from 'vitest';
import { listReadableProjectsStatement } from '../../repositories/project-readable.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ALWAYS, NOT_NULL, ref, seedProject } from './fixtures.js';

type Layer =
  'user' | 'grant' | 'role' | 'permission' | 'project' | 'identity' | 'binding' | 'member';
type Branch = 'email' | 'group';
const providers = [
  {
    provider: 'oidc',
    anchor: 'issuer',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const layers = (branch: Branch): readonly Layer[] => [
  'user',
  'grant',
  'role',
  'permission',
  'project',
  'identity',
  'binding',
  ...(branch === 'group' ? ['member' as const] : []),
];
function readableCase(branch: Branch, layer: Layer): ContractCase {
  return {
    name: `${branch} project listing rejects a foreign ${layer}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      const org = (part: Layer) =>
        part === layer ||
        ((part === 'role' || part === 'permission') && layer === 'grant') ||
        (part === 'permission' && layer === 'role')
          ? foreign.orgId
          : own.orgId;
      const now = new Date().toISOString();
      await seedProject(seed, 'P', org('project'));
      await seed(
        "INSERT INTO user_account (id, org_id, email) VALUES ('U', ?, 'reader@example.test')",
        org('user'),
      );
      await seed(
        "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R', ?, 'reader', 'Reader', 'project')",
        org('role'),
      );
      await seed(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R', 'project:read')",
        org('permission'),
      );
      await seed(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES ('G', ?, ?, ?, ?, 'project', 'P', 'R')",
        org('grant'),
        branch,
        branch === 'email' ? 'reader@example.test' : 'readers',
        branch === 'email' ? null : 'oidc',
      );
      await seed(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('I', ?, 'U', 'oidc', 'subject', 'reader@example.test', 1, ?)",
        org('identity'),
        now,
      );
      await seed(
        "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'issuer')",
        org('binding'),
      );
      if (branch === 'group')
        await seed(
          "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, 'U', 'oidc', 'readers', ?)",
          org('member'),
          now,
        );
      const statement = listReadableProjectsStatement(
        own,
        { userId: 'U' },
        { status: 'active', limit: 10 },
        providers,
      );
      expect(await context.executor.all(context.mutate(statement))).toEqual([]);
    },
  };
}
const aliases = (branch: Branch): Record<Layer, string> => ({
  user: branch === 'email' ? 'eu' : 'gu',
  grant: branch === 'email' ? 'ge' : 'gg',
  role: branch === 'email' ? 'er' : 'gr',
  permission: branch === 'email' ? 'ep' : 'gp',
  project: branch === 'email' ? 'pe' : 'pg',
  identity: `${branch}_evidence_identity`,
  binding: `${branch}_evidence_binding`,
  member: 'gm',
});
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/project-readable.ts',
    builder: 'listReadableProjectsStatement',
    cases: (['email', 'group'] as const).flatMap((branch) =>
      layers(branch).map((layer) => readableCase(branch, layer)),
    ),
    predicates: (['email', 'group'] as const).flatMap((branch) =>
      layers(branch).map((layer) => {
        const alias = aliases(branch);
        const joined = layer === 'role' || layer === 'permission';
        return {
          name: `${branch} ${layer} belongs to the organization`,
          locate: ref(
            alias[layer],
            'org_id',
            joined ? `"${alias[layer === 'role' ? 'grant' : 'role']}"\\."org_id"` : '\\?',
          ),
          neutral: joined ? ALWAYS : NOT_NULL,
          copies: 1,
          caseName: readableCase(branch, layer).name,
        };
      }),
    ),
  },
];
