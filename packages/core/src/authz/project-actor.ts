import type { OrgId } from '../db/port.js';

/** Project-scope actor: `permissions` is the union of organization and project grants for `projectId`. Never an ActorContext. */
export interface ProjectActor {
  readonly kind: 'project';
  readonly userId: string;
  readonly orgId: OrgId;
  readonly projectId: string;
  readonly permissions: ReadonlySet<string>;
}

export const PACKAGE_BOUNDARY_PERMISSIONS: ReadonlySet<string> = new Set([
  'project:packages:read',
  'project:packages:write',
]);

export function accessGrantFenceKey(grantId: string): string {
  return `access_grant:${grantId}`;
}

export function roleFenceKey(roleId: string): string {
  return `role:${roleId}`;
}

/** The project-boundary permission union: project-scope rows plus the `project:*` names of organization-scope rows. */
export function projectBoundaryPermissions(
  projectPermissions: readonly string[],
  organizationPermissions: readonly string[],
): Set<string> {
  return new Set([
    ...projectPermissions,
    ...organizationPermissions.filter((name) => name.startsWith('project:')),
  ]);
}
