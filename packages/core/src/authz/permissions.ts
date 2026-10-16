export const PERMISSION_PATTERN: RegExp = Object.freeze(
  /^(org|project):[a-z]+(?:-[a-z]+)*(?::[a-z]+(?:-[a-z]+)*)?$/,
);

export type PermissionScope = 'organization' | 'project';

const SCOPE_PREFIXES: Readonly<Record<string, PermissionScope>> = Object.freeze({
  'org:': 'organization',
  'project:': 'project',
});

function scopeOf(name: string): PermissionScope {
  for (const [prefix, scope] of Object.entries(SCOPE_PREFIXES)) {
    if (name.startsWith(prefix)) return scope;
  }
  throw new Error(`Unsupported permission prefix: ${JSON.stringify(name)}`);
}

export interface PermissionInfo {
  readonly name: string;
  readonly scope: PermissionScope;
  readonly description: string;
  readonly sessionOnly: boolean;
}

function permission(name: string, description: string, sessionOnly = true): PermissionInfo {
  return Object.freeze({
    name,
    scope: scopeOf(name),
    description,
    sessionOnly,
  });
}

export const PERMISSIONS: readonly PermissionInfo[] = Object.freeze([
  permission('org:read', 'Read organization details', false),
  permission('org:settings:write', 'Change organization settings'),
  permission('org:users:read', 'Read organization users', false),
  permission('org:users:write', 'Manage organization users'),
  permission('org:roles:read', 'Read organization roles', false),
  permission('org:roles:write', 'Manage organization roles'),
  permission('org:grants:read', 'Read organization grants', false),
  permission('org:grants:write', 'Manage organization grants'),
  permission('org:projects:create', 'Add projects'),
  permission('org:projects:archive', 'Archive projects'),
  permission('org:sources:read', 'Read organization sources', false),
  permission('org:sources:write', 'Manage organization sources'),
  permission('org:tokens:read', 'Read organization tokens'),
  permission('org:tokens:revoke', 'Revoke organization tokens'),
  permission('org:service-principals:write', 'Manage service principals'),
  permission('org:audit:read', 'Read organization audit records', false),
  permission('project:read', 'Read project details', false),
  permission('project:settings:write', 'Change project settings'),
  permission('project:grants:read', 'Read project grants', false),
  permission('project:grants:write', 'Manage project grants'),
  permission('project:packages:read', 'Read project packages', false),
  permission('project:packages:write', 'Publish project packages', false),
  permission('project:packages:manage', 'Manage project packages'),
  permission('project:sources:read', 'Read project sources', false),
  permission('project:sources:write', 'Manage project sources'),
  permission('project:service-principals:write', 'Manage project service principals'),
  permission('project:tokens:create', 'Issue project tokens'),
  permission('project:tokens:read', 'Read project tokens'),
  permission('project:tokens:revoke', 'Revoke project tokens'),
  permission('project:audit:read', 'Read project audit records', false),
]);

export type DefaultRoleKey =
  | 'organization_admin'
  | 'organization_auditor'
  | 'project_owner'
  | 'project_developer'
  | 'project_auditor';

export interface DefaultRole {
  readonly key: DefaultRoleKey;
  readonly name: string;
  readonly scope: PermissionScope;
  readonly protectsLastHolder: boolean;
  readonly permissions: readonly string[];
}

function role(
  key: DefaultRoleKey,
  name: string,
  scope: DefaultRole['scope'],
  permissions: readonly string[],
): DefaultRole {
  return Object.freeze({
    key,
    name,
    scope,
    protectsLastHolder: key === 'organization_admin',
    permissions: Object.freeze([...permissions]),
  });
}

export const DEFAULT_ROLES: readonly DefaultRole[] = Object.freeze([
  role(
    'organization_admin',
    'Organization Admin',
    'organization',
    PERMISSIONS.map(({ name }) => name),
  ),
  role('organization_auditor', 'Organization Auditor', 'organization', [
    'org:read',
    'org:users:read',
    'org:roles:read',
    'org:grants:read',
    'org:sources:read',
    'org:tokens:read',
    'org:audit:read',
    'project:read',
    'project:grants:read',
    'project:packages:read',
    'project:sources:read',
    'project:tokens:read',
    'project:audit:read',
  ]),
  role('project_owner', 'Project Owner', 'project', [
    'project:read',
    'project:settings:write',
    'project:grants:read',
    'project:grants:write',
    'project:packages:read',
    'project:packages:write',
    'project:packages:manage',
    'project:sources:read',
    'project:sources:write',
    'project:service-principals:write',
    'project:tokens:create',
    'project:tokens:read',
    'project:tokens:revoke',
    'project:audit:read',
  ]),
  role('project_developer', 'Project Developer', 'project', [
    'project:read',
    'project:packages:read',
    'project:packages:write',
    'project:sources:read',
    'project:tokens:create',
  ]),
  role('project_auditor', 'Project Auditor', 'project', [
    'project:read',
    'project:grants:read',
    'project:packages:read',
    'project:sources:read',
    'project:tokens:read',
    'project:audit:read',
  ]),
]);

const permissionNames = new Set(PERMISSIONS.map(({ name }) => name));

export function isPermission(name: string): boolean {
  return permissionNames.has(name);
}

const MAX_REPORTED_NAME_LENGTH = 80;

function quotedName(name: string): string {
  const bounded =
    name.length > MAX_REPORTED_NAME_LENGTH ? name.slice(0, MAX_REPORTED_NAME_LENGTH) : name;
  return JSON.stringify(bounded);
}

export function rolePermissionProblems(
  scope: PermissionScope,
  permissions: readonly string[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const name of permissions) {
    if (!isPermission(name)) {
      problems.push(`Unknown permission: ${quotedName(name)}`);
    } else if (scope === 'project' && scopeOf(name) === 'organization') {
      problems.push(`Organization permission in project role: ${quotedName(name)}`);
    }
    if (seen.has(name)) problems.push(`Duplicate permission: ${quotedName(name)}`);
    seen.add(name);
  }
  return problems;
}

class ReadOnlyPermissionSet<T> extends Set<T> {
  constructor(values: Iterable<T>) {
    super();
    for (const value of values) Set.prototype.add.call(this, value);
  }

  override add(): this {
    throw new TypeError('This set is read-only: add');
  }

  override delete(): boolean {
    throw new TypeError('This set is read-only: delete');
  }

  override clear(): void {
    throw new TypeError('This set is read-only: clear');
  }
}

export function effectivePermissions(stored: readonly string[]): ReadonlySet<string> {
  return new ReadOnlyPermissionSet(stored.filter(isPermission));
}

export function missingCatalogue(stored: readonly string[]): string[] {
  const present = new Set(stored);
  return PERMISSIONS.filter(({ name }) => !present.has(name)).map(({ name }) => name);
}
