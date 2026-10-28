import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import type { Controller, State } from '../tokens.js';

export const permissionCopy: Record<string, [string, string]> = {
  'project:read': ['Read project details', 'View project information.'],
  'project:packages:read': [
    'Install and download packages',
    'Read package metadata and download packages.',
  ],
  'project:packages:write': [
    'Include publish permission',
    'Publishing is not available in this version.',
  ],
  'project:grants:read': ['Read project grants', 'View who has access to this project.'],
  'project:sources:read': ['Read project sources', "View this project's package sources."],
  'project:audit:read': ['Read project audit records', 'View recorded changes in this project.'],
  'org:read': ['Read organization details', 'View organization information.'],
  'org:users:read': ['Read organization users', 'Read user information allowed by the API.'],
  'org:roles:read': ['Read organization roles', 'View organization role definitions.'],
  'org:grants:read': ['Read organization grants', 'View organization access rules.'],
  'org:sources:read': ['Read organization sources', 'View organization package sources.'],
  'org:import:write': [
    // eslint-disable-next-line no-restricted-syntax -- Permission label, not SQL.
    'Create and read import runs',
    'Plan and inspect imports; cannot approve or apply them.',
  ],
  'org:audit:read': ['Read organization audit records', 'View recorded organization changes.'],
};
export const tokenEligiblePermissions = Object.keys(permissionCopy);
const install = ['project:read', 'project:packages:read'];
const records = [
  'project:read',
  'project:grants:read',
  'project:sources:read',
  'project:audit:read',
];

export function PrincipalForm({
  state: s,
  controller: c,
}: {
  state: State;
  controller: Controller;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [binding, setBinding] = useState('');
  const [permissions, setPermissions] = useState<string[]>(install);
  const [preset, setPreset] = useState('Install packages');
  const [error, setError] = useState('');
  const [errorTarget, setErrorTarget] = useState('principal-name');
  const [created, setCreated] = useState<{ id: string; projectId: string | null } | null>(null);
  const project = s.projects.find((p) => p.id === binding);
  const allowed =
    binding === 'organization' ? s.organizationPermissions : (project?.permissions ?? []);
  const eligible = tokenEligiblePermissions
    .filter((key) => binding === 'organization' || key.startsWith('project:'))
    .map((name) => ({
      name,
      scope: name.startsWith('org:') ? 'organization' : 'project',
      description: permissionCopy[name]![0],
    }));
  const canManage = s.organizationPermissions.includes('org:service-principals:write');
  // The current create route requires organization admin authority for a project binding too.
  const admin = s.organizationPermissions.includes('org:settings:write') && canManage;
  useEffect(() => {
    if (project) c.loadProjectPolicies([project.id]);
  }, [c, project]);
  useEffect(() => {
    if (!binding || (project && project.policyState !== 'loaded')) return;
    setPermissions((old) =>
      (preset === 'Install packages'
        ? install
        : preset === 'Read project records'
          ? records
          : old
      ).filter((p) => allowed.includes(p)),
    );
  }, [binding, project, preset, s.organizationPermissions]);
  if (!admin) return null;
  return (
    <>
      <Button
        className="min-h-11 w-full sm:w-auto"
        type="button"
        onClick={() => {
          setOpen(true);
          setCreated(null);
        }}
      >
        New service principal
      </Button>
      {created && (
        <div>
          <Button
            className="min-h-11 w-full sm:w-auto"
            type="button"
            onClick={() => {
              c.choosePrincipal(
                created.id,
                s.projects.find((p) => p.id === created.projectId)?.slug ?? null,
                created.projectId === null,
              );
              setCreated(null);
              document.getElementById('new-token')?.focus();
            }}
          >
            Create token
          </Button>
        </div>
      )}
      {open && (
        <form
          noValidate
          aria-label="New service principal"
          className="grid max-w-5xl items-start gap-x-6 gap-y-4 lg:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const failure = !name.trim()
              ? { target: 'principal-name', message: 'Enter a service identity name.' }
              : !binding
                ? { target: 'principal-project', message: 'Choose a project.' }
                : project?.policyState === 'loading' || project?.policyState === 'idle'
                  ? { target: 'principal-project', message: 'Project access is still loading.' }
                  : project?.policyState === 'error'
                    ? {
                        target: 'principal-project',
                        message: 'Project access could not be loaded. Try again.',
                      }
                    : !permissions.length
                      ? {
                          target: 'principal-permissions',
                          message: 'Choose at least one permission.',
                        }
                      : !permissions.every((p) => allowed.includes(p))
                        ? {
                            target: 'principal-permissions',
                            message: 'You cannot grant every selected permission here.',
                          }
                        : null;
            if (failure) {
              setErrorTarget(failure.target);
              requestAnimationFrame(() => document.getElementById('principal-errors')?.focus());
              setError(failure.message);
              return;
            }
            setError('');
            void c
              .createPrincipal(name, binding === 'organization' ? '' : binding, permissions)
              .then((value) => {
                if (value) {
                  setCreated(value);
                  setOpen(false);
                  setName('');
                }
              });
          }}
        >
          <h2 className="lg:col-span-2">New service principal</h2>
          <p className="lg:col-span-2">
            Create a service identity for automation, then issue a token for it.
          </p>
          {error && (
            <div id="principal-errors" tabIndex={-1} role="alert" className="lg:col-span-2">
              <button
                type="button"
                className="min-h-11 underline"
                onClick={() => document.getElementById(errorTarget)?.focus()}
              >
                {error}
              </button>
            </div>
          )}
          <div>
            <Label htmlFor="principal-name">Service identity name</Label>
            <Input
              className="min-h-11"
              id="principal-name"
              aria-invalid={!!error && errorTarget === 'principal-name'}
              value={name}
              placeholder="e.g. ci-storefront"
              aria-describedby="principal-name-help"
              onChange={(e) => setName(e.target.value)}
            />
            <p id="principal-name-help">
              Use one identity for each CI pipeline so you can stop its access separately.
            </p>
          </div>
          <div>
            <Label htmlFor="principal-project">Project</Label>
            <Select
              className="min-h-11"
              id="principal-project"
              aria-invalid={!!error && errorTarget === 'principal-project'}
              value={binding}
              onChange={(e) => {
                const next = e.target.value;
                const kept = permissions.filter(
                  (p) => next === 'organization' || p.startsWith('project:'),
                );
                setBinding(next);
                setPermissions(kept);
                if (kept.length !== permissions.length)
                  c.announce('Project changed. Incompatible permissions were removed.');
              }}
            >
              <option value="">Choose a project</option>
              {s.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="organization">Organization-wide (advanced)</option>
            </Select>
            {binding === 'organization' && (
              <p>
                Can carry permissions across projects and for the organization. Choose a single
                project for a CI pipeline that only installs its packages.
              </p>
            )}
          </div>
          <fieldset id="principal-permissions" tabIndex={-1} className="lg:col-span-2">
            <legend>Permissions</legend>
            <div className="flex flex-wrap gap-2">
              {['Install packages', 'Read project records', 'Custom'].map((label) => (
                <Button
                  className="min-h-11 w-full sm:w-auto"
                  key={label}
                  type="button"
                  aria-pressed={preset === label}
                  onClick={() => {
                    setPreset(label);
                    if (label !== 'Custom')
                      setPermissions(
                        (label === 'Install packages' ? install : records).filter((p) =>
                          allowed.includes(p),
                        ),
                      );
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
            {preset === 'Read project records' && (
              <p>
                To issue an Install and download token, also select Install and download packages.
              </p>
            )}
            {project?.policyState === 'loading' && <p>Loading project access…</p>}
            {project?.policyState === 'error' && (
              <Button
                className="min-h-11 w-full sm:w-auto"
                type="button"
                onClick={() => c.loadProjectPolicies([project.id], true)}
              >
                Try again loading project access
              </Button>
            )}
            {(binding === 'organization'
              ? ['Packages', 'Project records', 'Organization']
              : ['Packages', 'Project records']
            ).map((group) => (
              <fieldset key={group}>
                <legend>{group}</legend>
                {eligible
                  .filter((p) =>
                    group === 'Organization'
                      ? p.scope === 'organization'
                      : group === 'Packages'
                        ? install.includes(p.name) || p.name === 'project:packages:write'
                        : p.scope === 'project' &&
                          !install.includes(p.name) &&
                          p.name !== 'project:packages:write',
                  )
                  .map((p) => (
                    <label key={p.name} className="flex min-h-11 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={permissions.includes(p.name) && allowed.includes(p.name)}
                        disabled={!allowed.includes(p.name)}
                        aria-invalid={!!error && errorTarget === 'principal-permissions'}
                        onChange={(e) => {
                          setPreset('Custom');
                          setPermissions((old) =>
                            e.target.checked
                              ? [...old, p.name]
                              : old.filter((key) => key !== p.name),
                          );
                        }}
                      />
                      {permissionCopy[p.name]?.[0] ?? p.description} — {permissionCopy[p.name]?.[1]}
                      {!allowed.includes(p.name) && ' You cannot grant this permission here.'}
                    </label>
                  ))}
              </fieldset>
            ))}
            <p>
              A token's access level and the project's access policy may limit these permissions
              further.
            </p>
          </fieldset>
          <p className="lg:col-span-2">
            {name} · {binding === 'organization' ? 'Organization-wide' : project?.name} ·{' '}
            {permissions.length} {permissions.length === 1 ? 'permission' : 'permissions'}
          </p>
          <div className="flex flex-wrap gap-2 lg:col-span-2">
            <Button className="min-h-11 w-full sm:w-auto" type="submit" disabled={s.busy}>
              {/* eslint-disable-next-line no-restricted-syntax -- Button copy, not SQL. */}
              {s.busy ? 'Creating service principal…' : 'Create service principal'}
            </Button>
            <Button
              className="min-h-11 w-full sm:w-auto"
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
