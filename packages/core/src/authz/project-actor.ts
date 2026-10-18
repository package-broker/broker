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
