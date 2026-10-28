import { useEffect, useState } from 'react';
import { permissionCopy, tokenEligiblePermissions } from './principal-form.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import {
  dayLabel,
  lifetimeChoices,
  type Controller,
  type Draft,
  type IssueProject,
  type State,
} from '../tokens.js';

// eslint-disable-next-line no-restricted-syntax -- Button copy, not SQL.
export const createTokenLabel = 'Create token';

export const accessLabels = {
  read: 'Install and download',
  write: 'Include publish permission',
  full: 'Include grants, sources and audit access',
};
const permissionLabels: Record<string, string> = {
  'project:read': 'Read project details',
  'project:packages:read': 'Install and download packages',
  'project:packages:write': 'Include publish permission',
  'project:grants:read': 'Read project grants',
  'project:sources:read': 'Read project sources',
  'project:audit:read': 'Read project audit records',
};
const descriptions = {
  read: 'Read project details and download packages.',
  write:
    'Also include the package publishing permission. Publishing is not available in this version.',
  full: 'Also allow reading project grants, sources and audit records, plus the publish permission.',
};
const levelAnchor = { read: 'project:packages:read', write: 'project:packages:write', full: null };
const levelMask = {
  read: ['project:read', 'project:packages:read'],
  write: ['project:read', 'project:packages:read', 'project:packages:write'],
  full: null,
};
export function conferredPermissions(
  permissions: string[],
  scope: Draft['scope'],
  organizationBound: boolean,
) {
  const mask = levelMask[scope];
  return [
    ...new Set(
      permissions.filter(
        (name) =>
          tokenEligiblePermissions.includes(name) &&
          (mask === null || mask.includes(name)) &&
          (organizationBound || name.startsWith('project:')),
      ),
    ),
  ].sort();
}
export function organizationScopeReason(
  scope: Draft['scope'],
  principalPermissions: string[] | undefined,
  organizationPermissions: string[],
) {
  if (!principalPermissions) return 'Choose a service identity first.';
  if (!principalPermissions.length) return 'This service identity has no permissions.';
  const covers = conferredPermissions(principalPermissions, scope, true);
  const anchor = levelAnchor[scope];
  if (anchor !== null && !covers.includes(anchor))
    return 'The service identity needs the required package permission.';
  if (!covers.length)
    return 'This service identity has no token-eligible permissions at this access level.';
  if (covers.some((p) => !organizationPermissions.includes(p)))
    return 'You cannot confer this service identity’s permissions at this access level.';
  return null;
}
export function scopeReason(
  scope: Draft['scope'],
  projects: IssueProject[],
  personal: boolean,
  principalPermissions?: string[],
) {
  if (!projects.length) return 'Choose a project first.';
  const rank = { read: 0, write: 1, full: 2 };
  for (const project of projects) {
    if (project.policyState === 'idle' || project.policyState === 'loading')
      return 'Loading project access…';
    if (project.cap === null || project.permissions === null)
      return 'Project policy or permissions could not be loaded. Try again.';
    if (rank[scope] > rank[project.cap])
      return 'This access level is not available for every selected project. Choose Install and download or change the selected projects.';
    const required = scope === 'read' ? 'project:packages:read' : 'project:packages:write';
    if (personal && !project.permissions.includes(required))
      return scope === 'full'
        ? 'Creating this access level requires package publishing permission on every selected project, even when you only need audit access.'
        : 'Your access does not include the required package permission for every selected project.';
    if (!personal) {
      if (!project.permissions.includes('project:tokens:create'))
        return 'You need permission to create tokens for this project.';
      if (!principalPermissions) return 'Choose a service identity first.';
      if (!principalPermissions.length)
        return 'This service identity has no permissions. Choose another identity or ask an organization administrator to grant it access.';
      const covers = conferredPermissions(principalPermissions, scope, false);
      if (scope !== 'full' && !covers.includes(levelAnchor[scope]!))
        return 'The service identity needs the required package permission.';
      if (!covers.length || covers.some((p) => !project.permissions!.includes(p)))
        return 'You cannot confer this service identity’s permissions at this access level.';
    }
  }
  return null;
}
interface FormDraft {
  name: string;
  scope: Draft['scope'];
  days: string;
  project: string;
  ids: string[];
  mode: 'selected' | 'all';
  principal: string;
}
const empty = (): FormDraft => ({
  name: '',
  scope: 'read',
  days: '',
  project: '',
  ids: [],
  mode: 'selected',
  principal: '',
});

export function selectionError(ids: string[]) {
  return ids.length < 1 || ids.length > 200 ? 'Choose between 1 and 200 projects.' : null;
}

export function usablePrincipals(state: State, projectId: string | null | undefined) {
  return state.principals.filter((p) => p.status === 'active' && p.projectId === projectId);
}

export function IssueTokenForm({
  state: s,
  controller: c,
  initialAudience = 'ci',
  defaultOpen = false,
}: {
  state: State;
  controller: Controller;
  initialAudience?: 'ci' | 'personal';
  defaultOpen?: boolean;
}) {
  const restored = s.issuanceDraft;
  const [open, setOpen] = useState(defaultOpen || restored !== null);
  const [personal, setPersonal] = useState(
    restored ? restored.target === 'personal' : initialAudience === 'personal',
  );
  const fromRestored = (): FormDraft =>
    restored
      ? {
          name: restored.draft.name,
          scope: restored.draft.scope,
          days: String(restored.draft.lifetimeDays),
          project: restored.target === 'organization' ? '__organization' : (restored.project ?? ''),
          ids: restored.draft.projectIds,
          mode: restored.draft.projectMode,
          principal: restored.draft.servicePrincipalId,
        }
      : empty();
  const [ci, setCi] = useState<FormDraft>(() =>
    restored && restored.target !== 'personal'
      ? fromRestored()
      : { ...empty(), project: s.issuanceProject ?? '' },
  );
  useEffect(() => {
    if (s.issuanceProject !== null)
      setCi((old) => ({
        ...old,
        project: s.issuanceProject!,
        principal: s.issuancePrincipal ?? old.principal,
        scope: s.issuanceProject === '__organization' ? 'full' : old.scope,
      }));
    if (s.issuancePrincipal) {
      setOpen(true);
      setPersonal(false);
    }
  }, [s.issuanceProject, s.issuancePrincipal, s.issuanceNonce]);
  const [me, setMe] = useState<FormDraft>(() =>
    restored?.target === 'personal' ? fromRestored() : empty(),
  );
  useEffect(() => {
    if (!restored) return;
    const value: FormDraft = {
      name: restored.draft.name,
      scope: restored.draft.scope,
      days: String(restored.draft.lifetimeDays),
      project: restored.target === 'organization' ? '__organization' : (restored.project ?? ''),
      ids: restored.draft.projectIds,
      mode: restored.draft.projectMode,
      principal: restored.draft.servicePrincipalId,
    };
    (restored.target === 'personal' ? setMe : setCi)(value);
    setPersonal(restored.target === 'personal');
    setOpen(true);
  }, [restored]);
  const [search, setSearch] = useState('');
  type FieldError = { message: string; target: string } | null;
  const [ciError, setCiError] = useState<FieldError>(null);
  const [meError, setMeError] = useState<FieldError>(null);
  const error = personal ? meError : ciError;
  const setError = personal ? setMeError : setCiError;
  const d = personal ? me : ci;
  const update = (value: Partial<FormDraft>) =>
    (personal ? setMe : setCi)((old) => ({ ...old, ...value }));
  const projects = personal
    ? s.projects.filter((p) =>
        d.mode === 'all'
          ? p.permissions === null ||
            p.permissions.some(
              (x) => x === 'project:packages:read' || x === 'project:packages:write',
            )
          : d.ids.includes(p.id),
      )
    : s.projects.filter((p) => p.slug === d.project);
  const organization = !personal && d.project === '__organization';
  const principals = usablePrincipals(s, organization ? null : projects[0]?.id);
  const principal = principals.find((p) => p.id === d.principal);
  const policy = s.lifetime?.[personal ? 'personal' : 'service'];
  const days = d.days || String(policy?.defaultDays ?? '');
  const all = personal && d.mode === 'all';
  const organizationReason = (scope: Draft['scope']) =>
    !principal
      ? 'Choose a service identity first.'
      : organizationScopeReason(scope, principal.permissions, s.organizationPermissions);
  const reason = all
    ? null
    : organization
      ? organizationReason(d.scope)
      : scopeReason(d.scope, projects, personal, principal?.permissions);
  const policyIds = projects.map((p) => p.id).join(',');
  useEffect(() => {
    if (open && !all) c.loadProjectPolicies(policyIds ? policyIds.split(',') : []);
  }, [c, open, all, policyIds, s.projects]);
  function validate(): FieldError {
    if (!d.name.trim()) return { message: 'Enter a token name.', target: 'issue-name' };
    if (s.projectsError && !all)
      return {
        message: 'Projects could not be loaded. Try again.',
        target: personal ? 'project-search' : 'issue-project',
      };
    if (personal && d.mode === 'selected' && selectionError(d.ids))
      return { message: selectionError(d.ids)!, target: 'project-search' };
    if (!personal && !d.project)
      return { message: 'Choose a project first.', target: 'issue-project' };
    if (!personal && !principal)
      return { message: 'Choose a service identity first.', target: 'issue-principal' };
    if (reason) return { message: reason, target: 'issue-access' };
    if (!policy || !lifetimeChoices(policy).includes(Number(days)))
      return { message: 'Choose an available lifetime.', target: 'issue-lifetime' };
    return null;
  }
  function close() {
    setOpen(false);
    document.getElementById('new-token')?.focus();
  }
  return (
    <>
      <Button className="min-h-11" id="new-token" type="button" onClick={() => setOpen(true)}>
        New token
      </Button>
      {!open ? null : (
        <form
          noValidate
          className="grid max-w-5xl items-start gap-x-6 gap-y-4 lg:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const invalid = validate();
            if (invalid) {
              setError(invalid);
              requestAnimationFrame(() => document.getElementById('token-errors')?.focus());
              return;
            }
            setError(null);
            void c.issueFor(
              personal ? 'personal' : organization ? 'organization' : 'project',
              personal || organization ? null : d.project,
              {
                name: d.name,
                scope: d.scope,
                lifetimeDays: Number(days),
                servicePrincipalId: personal ? '' : d.principal,
                projectMode: personal ? d.mode : 'selected',
                projectIds: personal && d.mode === 'selected' ? d.ids : [],
              },
            );
          }}
        >
          <h2 className="lg:col-span-2">New token</h2>
          <fieldset className="lg:col-span-2">
            <legend>Who is this token for?</legend>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="audience"
                checked={!personal}
                onChange={() => {
                  setPersonal(false);
                }}
              />
              A CI pipeline or service
            </label>
            <p>Keeps working when the person who created it leaves.</p>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="audience"
                checked={personal}
                onChange={() => {
                  setPersonal(true);
                }}
              />
              Me
            </label>
            <p>Uses your access. Stops working if you leave or your account is suspended.</p>
          </fieldset>
          {error && (
            <div id="token-errors" role="alert" tabIndex={-1} className="lg:col-span-2">
              <button
                type="button"
                className="min-h-11 underline"
                onClick={() => document.getElementById(error.target)?.focus()}
              >
                {error.message}
              </button>
            </div>
          )}
          <div>
            <Label htmlFor="issue-name">Token name</Label>
            <Input
              className="min-h-11"
              id="issue-name"
              value={d.name}
              aria-invalid={!!error && !d.name.trim()}
              aria-describedby={error ? 'token-errors' : undefined}
              placeholder={personal ? 'e.g. My laptop' : 'e.g. Storefront CI'}
              onChange={(e) => update({ name: e.target.value })}
            />
          </div>
          {personal ? (
            <fieldset>
              <legend>Which projects?</legend>
              {(['selected', 'all'] as const).map((mode) => (
                <label key={mode} className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="projects-mode"
                    checked={d.mode === mode}
                    onChange={() => update({ mode })}
                  />
                  {mode === 'selected' ? 'Choose projects' : 'All projects I can access'}
                </label>
              ))}
              {d.mode === 'all' ? (
                <p>Includes projects you can access now and projects you gain access to later.</p>
              ) : (
                <>
                  <Label htmlFor="project-search">Search projects</Label>
                  <Input
                    className="min-h-11"
                    id="project-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <p id="project-help">
                    Choose up to 200 projects. This does not give you access you do not already
                    have.
                  </p>
                  <p>
                    {d.ids.length} {d.ids.length === 1 ? 'project selected' : 'projects selected'}
                  </p>
                  <div className="max-h-60 overflow-y-auto">
                    {s.projects
                      .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
                      .map((p) => (
                        <label key={p.id} className="flex min-h-11 items-center gap-2">
                          <input
                            type="checkbox"
                            checked={d.ids.includes(p.id)}
                            disabled={!d.ids.includes(p.id) && d.ids.length >= 200}
                            aria-describedby="project-help"
                            onChange={(e) =>
                              update({
                                ids: e.target.checked
                                  ? [...d.ids, p.id]
                                  : d.ids.filter((id) => id !== p.id),
                              })
                            }
                          />
                          {p.name}
                        </label>
                      ))}
                  </div>
                </>
              )}
            </fieldset>
          ) : (
            <div>
              <Label htmlFor="issue-project">Project</Label>
              <Select
                className="min-h-11"
                aria-invalid={!!error && !d.project}
                aria-describedby={error ? 'token-errors' : undefined}
                id="issue-project"
                value={d.project}
                onChange={(e) =>
                  update({
                    project: e.target.value,
                    principal: '',
                    scope: e.target.value === '__organization' ? 'full' : 'read',
                  })
                }
              >
                <option value="">Choose a project</option>
                {s.projects.map((p) => (
                  <option key={p.id} value={p.slug}>
                    {p.name}
                  </option>
                ))}
                {s.organizationPermissions.includes('org:settings:write') &&
                  s.organizationPermissions.includes('org:service-principals:write') && (
                    <option value="__organization">Organization-wide (advanced)</option>
                  )}
              </Select>
              {d.project === '' &&
                d.principal !== '' &&
                s.principals.some((p) => p.id === d.principal && p.projectId !== null) && (
                  <p>
                    Project name unavailable. You may not have access to this service identity’s
                    project.
                  </p>
                )}
            </div>
          )}
          {s.projectsError && (
            <p className="lg:col-span-2">
              Projects could not be loaded.{' '}
              <Button type="button" onClick={() => void c.identity()}>
                Try again
              </Button>
            </p>
          )}
          <fieldset
            id="issue-access"
            tabIndex={-1}
            className="lg:col-span-2"
            aria-describedby="access-help"
          >
            <legend>What can this token do?</legend>
            {(['read', 'write', 'full'] as const).map((scope) => {
              const why = all
                ? null
                : organization
                  ? organizationReason(scope)
                  : scopeReason(scope, projects, personal, principal?.permissions);
              return (
                <div key={scope}>
                  <label className="flex min-h-11 items-center gap-2">
                    <input
                      type="radio"
                      name="access"
                      checked={d.scope === scope}
                      disabled={why !== null}
                      aria-invalid={error?.target === 'issue-access'}
                      onChange={() => update({ scope })}
                      aria-describedby={`help-${scope}`}
                    />
                    {accessLabels[scope]}
                  </label>
                  <p id={`help-${scope}`}>
                    {descriptions[scope]} {why}
                  </p>
                </div>
              );
            })}
            {projects
              .filter((p) => !all || p.policyState === 'error')
              .map((p) => (
                <p key={p.id}>
                  {p.cap && !all
                    ? `${p.name} allows ${{ read: 'install and download only', write: 'install, download and publish permission', full: 'all token-eligible project permissions' }[p.cap]}.`
                    : `${p.name}: ${p.policyState === 'loading' ? 'Loading project access…' : p.policyState === 'error' ? 'Project access could not be loaded.' : 'Project access has not been loaded.'}`}
                </p>
              ))}
            {projects.some((p) => p.policyState === 'error') && (
              <Button
                type="button"
                onClick={() =>
                  c.loadProjectPolicies(
                    projects.filter((p) => p.policyState === 'error').map((p) => p.id),
                    true,
                  )
                }
              >
                Try again loading project access
              </Button>
            )}
            {organization && (
              <p>
                This token may also use the service identity’s organization permissions. Project
                policies only limit access within projects.
              </p>
            )}
            <p id="access-help">
              Your token can only use permissions its holder has and the project allows. Tokens
              cannot change project settings or delete packages. Publishing is not available in this
              version.
            </p>
          </fieldset>
          {!personal && (
            <div>
              <Label htmlFor="issue-principal">Service identity</Label>
              <Select
                className="min-h-11"
                aria-invalid={!!error && !principal}
                aria-describedby={error ? 'token-errors' : undefined}
                id="issue-principal"
                value={d.principal}
                onChange={(e) => update({ principal: e.target.value })}
              >
                <option value="">Choose a service identity</option>
                {principals.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <p>
                A service principal is an identity for automation. Its tokens keep working when the
                person who created them leaves.
              </p>
              {principal && (
                <p>
                  Permissions:{' '}
                  {(principal.permissions ?? [])
                    .map((p) => permissionLabels[p] ?? permissionCopy[p]?.[0])
                    .filter(Boolean)
                    .join('; ')}
                </p>
              )}
              {s.principalsLoading ? (
                <p>Loading service principals…</p>
              ) : s.principalsError ? (
                <p>
                  Service principals could not be loaded.{' '}
                  <Button type="button" onClick={() => void c.loadPrincipals()}>
                    Try again
                  </Button>
                </p>
              ) : (
                (s.principalsRestricted || !principals.length) && (
                  <p>
                    {s.principalsRestricted && 'You cannot browse service principals here. '}Ask an
                    organization administrator to create a service identity for this project.
                  </p>
                )
              )}
            </div>
          )}
          <div>
            <Label htmlFor="issue-lifetime">Expires after</Label>
            <Select
              className="min-h-11"
              id="issue-lifetime"
              aria-invalid={error?.target === 'issue-lifetime'}
              aria-describedby={error?.target === 'issue-lifetime' ? 'token-errors' : undefined}
              value={days}
              disabled={!policy}
              onChange={(e) => update({ days: e.target.value })}
            >
              {policy &&
                lifetimeChoices(policy).map((n) => (
                  <option key={n} value={n}>
                    {dayLabel(n)}
                    {n === policy.defaultDays ? ' (organization default)' : ''}
                  </option>
                ))}
            </Select>
            {!policy && !s.loading && (
              <Button type="button" onClick={() => void c.load()}>
                Try again
              </Button>
            )}
            <p>
              {policy
                ? `Maximum: ${dayLabel(policy.maxDays)}. Create a replacement before this token expires.`
                : 'Lifetime policy could not be loaded.'}
            </p>
          </div>
          <p className="lg:col-span-2 break-words">
            {[
              d.name,
              all ? 'All projects I can access' : projects.map((p) => p.name).join(', '),
              accessLabels[d.scope],
              dayLabel(Number(days)),
              personal ? '' : principal?.name,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <div className="flex flex-wrap gap-2 lg:col-span-2">
            <Button className="min-h-11 w-full sm:w-auto" type="submit" disabled={s.busy}>
              {s.busy ? 'Creating token…' : createTokenLabel}
            </Button>
            <Button
              className="min-h-11 w-full sm:w-auto"
              type="button"
              variant="outline"
              disabled={s.busy}
              onClick={close}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
