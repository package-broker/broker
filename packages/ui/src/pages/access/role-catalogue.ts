import type { operations } from '../../api-types.js';
import type { ShellServices } from '../../auth.js';
export type Role =
  operations['listRoles']['responses'][200]['content']['application/json']['items'][number];
export type Provider =
  operations['listAuthProviders']['responses'][200]['content']['application/json']['providers'][number];
export type Catalogue = { roles: Role[]; status: 'ready' | 'loading' | 'forbidden' | 'error' };
export async function loadRoleCatalogue(client: ShellServices['client']): Promise<Catalogue> {
  const roles: Role[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  do {
    const result = await client.request('get', '/_pb/roles', { query: { limit: '50', after } });
    if (!result.ok) return { roles: [], status: result.status === 403 ? 'forbidden' : 'error' };
    roles.push(...result.data.items);
    after = result.data.next ?? undefined;
    if (after && seen.has(after)) return { roles: [], status: 'error' };
    if (after) seen.add(after);
  } while (after);
  return { roles, status: 'ready' };
}
const order = [
  'project_developer',
  'project_auditor',
  'project_owner',
  'organization_auditor',
  'organization_admin',
];
export const scopeRoles = (roles: Role[], project: string | null) =>
  roles
    .filter((role) => role.scope === (project === null ? 'organization' : 'project'))
    .sort((a, b) => {
      const rank = (role: Role) =>
        role.isSystem && order.includes(role.key) ? order.indexOf(role.key) : order.length;
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
export const systemDescriptions: Record<string, string> = {
  project_developer:
    'Read packages, view sources and issue project tokens; includes publish permission.',
  project_auditor: 'View project details, grants, packages, sources, tokens and audit records.',
  project_owner:
    'Manage project settings, access, packages, sources, service principals and tokens.',
  organization_auditor: 'View organization records and project records across the organization.',
  organization_admin:
    'Manage the organization and all projects, including users, roles, grants and packages.',
};
export const roleDescription = (role: Role) =>
  (role.isSystem && systemDescriptions[role.key]) ||
  `Custom role · ${role.permissions.length} permissions`;
