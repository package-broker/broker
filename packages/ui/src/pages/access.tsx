import { GrantForm, ChangeRoleForm, grantSummary } from './access/grant-form.js';
import { loadRoleCatalogue, type Catalogue, type Provider } from './access/role-catalogue.js';
import { useMemo, useSyncExternalStore } from 'react';
import type { operations } from '../api-types.js';
import type { ApiResult } from '../api.js';
import { useServices, type ShellServices, type ReplayResult } from '../auth.js';
import { buildListFilterHash } from '../page-hash.js';
import { Button } from '../components/ui/button.js';
import { Label } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import { DataTable } from '../components/ui/table.js';
import { IdText } from '../components/ui/id-text.js';
import { ListDate } from '../components/ui/list-date.js';
import { ReadableList } from '../components/ui/readable-list.js';
import { ListRowActions } from '../components/ui/list-row-actions.js';
import { permissionDescriptions } from './access/permission-descriptions.js';
import { Badge } from '../components/ui/badge.js';
import { ListState } from '../components/ui/list-state.js';
import { ConfirmAction } from '../components/ui/confirm-action.js';
import {
  createManagementStore,
  failureNotice,
  Field,
  formValues,
  ManagementFilters,
  ManagementNotice,
  parseManagementHash,
  requireReauth,
  revisionTag,
  useManagementHash,
  type ManagementQuery,
} from './management.js';

type Role =
  operations['listRoles']['responses'][200]['content']['application/json']['items'][number];
type GrantInput = operations['createGrant']['requestBody']['content']['application/json'];
type RoleInput = operations['createRole']['requestBody']['content']['application/json'];
type RoleChanges = operations['updateRole']['requestBody']['content']['application/json'];
interface Grant {
  id: string;
  principalId: string | null;
  principalName: string | null;
  kind: string;
  provider?: string | undefined;
  visibility?: string;
  rolePermissions?: string[] | undefined;
  roleId: string;
  roleName: string;
  revision: number;
  createdAt: string;
}
export type AccessQuery = ManagementQuery;
const VIEWS = ['grants', 'roles'] as const;
export const parseAccessHash = (hash: string): AccessQuery => parseManagementHash(hash, VIEWS);
export const buildAccessHash = (query: AccessQuery) =>
  buildListFilterHash('access', parseAccessHash(buildListFilterHash('access', query)));
interface AccessState {
  query: AccessQuery;
  roles: Role[];
  catalogue: Catalogue;
  providers: Provider[];
  providerStatus: 'ready' | 'loading' | 'error';
  organizationName: string;
  grants: Grant[];
  next: string | null;
  organization: string[];
  permissions: string[];
  loading: boolean;
  listError: boolean;
  busy: boolean;
  stale: boolean;
  notice: string | null;
}
const rolesView = (state: AccessState) =>
  state.query.project === null && state.query.status === 'roles';
export function accessViewModel(state: AccessState) {
  const ready = !state.loading && !state.stale;
  const prefix = state.query.q?.toLowerCase() ?? '';
  return {
    roles: state.roles.filter((role) => role.name.toLowerCase().startsWith(prefix)),
    grants: state.grants.filter((grant) =>
      [
        grant.principalName,
        grant.roleName,
        state.providers.find((provider) => provider.id === grant.provider)?.displayName ??
          (grant.provider ? `Provider: ${grant.provider}` : undefined),
      ].some((value) => value?.toLowerCase().startsWith(prefix)),
    ),
    writeRoles:
      ready && state.query.project === null && state.organization.includes('org:roles:write'),
    writeGrants:
      ready &&
      (state.query.project === null
        ? state.organization.includes('org:grants:write')
        : state.permissions.includes('project:grants:write')),
  };
}
export function createAccessController(services: ShellServices) {
  const store = createManagementStore<AccessState>({
    query: { project: null },
    roles: [],
    catalogue: { roles: [], status: 'loading' },
    providers: [],
    providerStatus: 'loading',
    organizationName: 'this organization',
    grants: [],
    next: null,
    organization: [],
    permissions: [],
    loading: false,
    listError: false,
    busy: false,
    stale: false,
    notice: null,
  });
  const { client } = services;
  let generation = 0;
  let optionsGeneration = 0;
  async function loadFormOptions() {
    const current = ++optionsGeneration;
    const scopeGeneration = generation;
    store.set({ catalogue: { roles: [], status: 'loading' }, providerStatus: 'loading' });
    const isCurrent = () => current === optionsGeneration && scopeGeneration === generation;
    await Promise.all([
      loadRoleCatalogue(client).then((catalogue) => {
        if (!isCurrent()) return;
        store.set({
          catalogue,
          grants: store.snapshot().grants.map((grant) => {
            if (grant.rolePermissions !== undefined) return grant;
            const role = catalogue.roles.find((role) => role.id === grant.roleId);
            return {
              ...grant,
              roleName:
                grant.roleName === 'Role name unavailable'
                  ? (role?.name ?? grant.roleName)
                  : grant.roleName,
              rolePermissions: role?.permissions,
            };
          }),
        });
      }),
      client.request('get', '/_pb/auth/providers').then((providers) => {
        if (!isCurrent()) return;
        store.set({
          providers: providers.ok ? providers.data.providers : [],
          providerStatus: providers.ok ? 'ready' : 'error',
        });
      }),
      client.request('get', '/_pb/organization').then((organization) => {
        if (!isCurrent()) return;
        store.set({
          organizationName: organization.ok ? organization.data.name : 'this organization',
        });
      }),
    ]);
  }
  async function load(query: AccessQuery, notice: string | null = null): Promise<void> {
    const current = ++generation;
    store.set({
      query,
      roles: [],
      catalogue: { roles: [], status: 'loading' },
      providers: [],
      providerStatus: 'loading',
      organizationName: 'this organization',
      grants: [],
      next: null,
      organization: [],
      permissions: [],
      loading: true,
      listError: false,
      busy: false,
      stale: false,
      notice,
    });
    const [organization, project] = await Promise.all([
      client.request('get', '/_pb/me/permissions'),
      query.project === null
        ? null
        : client.request('get', '/_pb/projects/{project}/permissions', {
            params: { project: query.project },
          }),
    ]);
    if (current !== generation) return;
    const orgPermissions = organization.ok ? organization.data.organization : [];
    const permissions = project?.ok ? project.data.project : [];
    store.set({ organization: orgPermissions, permissions });
    const roles = rolesView(store.snapshot());
    if (!roles) void loadFormOptions();
    if (current !== generation) return;
    const canRead =
      query.project === null
        ? orgPermissions.includes(roles ? 'org:roles:read' : 'org:grants:read')
        : permissions.includes('project:grants:read');
    if (!canRead) {
      store.set({
        loading: false,
        listError: true,
        notice: 'You do not have permission to view this list.',
      });
      return;
    }
    const page = { after: query.after, limit: '50' };
    if (roles) {
      const result = await client.request('get', '/_pb/roles', { query: page });
      if (current !== generation) return;
      store.set({
        loading: false,
        listError: !result.ok,
        roles: result.ok ? result.data.items : [],
        next: result.ok ? result.data.next : null,
        notice: result.ok ? notice : failureNotice(result),
      });
    } else if (query.project !== null) {
      const result = await client.request('get', '/_pb/projects/{project}/grants', {
        params: { project: query.project },
        query: page,
      });
      if (current !== generation) return;
      store.set({
        loading: false,
        listError: !result.ok,
        grants: result.ok
          ? result.data.items.map((item) => ({
              id: item.id,
              principalId: item.principal.id,
              principalName:
                item.principal.visibility === 'redacted'
                  ? item.principal.kind === 'group'
                    ? 'Group value hidden'
                    : 'Email address hidden'
                  : item.principal.kind === 'group'
                    ? 'groupValue' in item.principal
                      ? item.principal.groupValue
                      : null
                    : (('email' in item.principal ? item.principal.email : null) ??
                      item.principal.displayName),
              visibility: item.principal.visibility,
              provider: 'provider' in item.principal ? item.principal.provider : undefined,
              rolePermissions: item.role.permissions,
              kind: item.principal.kind,
              roleId: item.role.id,
              roleName: item.role.name,
              revision: item.revision,
              createdAt: item.createdAt,
            }))
          : [],
        next: result.ok ? result.data.next : null,
        notice: result.ok ? notice : failureNotice(result),
      });
    } else {
      const result = await client.request('get', '/_pb/grants', { query: page });
      if (current !== generation) return;
      store.set({
        loading: false,
        listError: !result.ok,
        grants: result.ok
          ? result.data.items.map((item) => ({
              id: item.id,
              principalId: null,
              principalName:
                item.subject.visibility === 'redacted'
                  ? item.subject.type === 'group'
                    ? 'Group value hidden'
                    : 'Email address hidden'
                  : 'value' in item.subject
                    ? item.subject.value
                    : null,
              visibility: item.subject.visibility,
              provider: 'provider' in item.subject ? item.subject.provider : undefined,
              kind: item.subject.type,
              roleId: item.roleId,
              roleName:
                item.role?.name ??
                store.snapshot().catalogue.roles.find((role) => role.id === item.roleId)?.name ??
                'Role name unavailable',
              rolePermissions:
                item.role?.permissions ??
                store.snapshot().catalogue.roles.find((role) => role.id === item.roleId)
                  ?.permissions,
              revision: item.revision,
              createdAt: item.createdAt,
            }))
          : [],
        next: result.ok ? result.data.next : null,
        notice: result.ok ? notice : failureNotice(result),
      });
    }
  }
  async function write(
    run: () => Promise<ApiResult<unknown>>,
    success = 'Access updated.',
    grantMutation = false,
  ) {
    const state = store.snapshot();
    if (state.busy || state.loading || state.stale) return;
    const current = generation;
    store.set({ busy: true, notice: null });
    const result = await run();
    if (current !== generation) return;
    store.set({ busy: false });
    if (requireReauth(services, result))
      store.set({
        stale: true,
        notice: 'Complete reauthentication and confirm the pending action.',
      });
    else if (!result.ok)
      store.set({
        stale: result.status === 412,
        notice:
          grantMutation && result.status === 412
            ? 'This grant changed. Reload it before saving.'
            : failureNotice(result),
      });
    else await load(state.query, success);
  }
  const mutableRole = (id: string) => {
    const state = store.snapshot();
    const role = state.roles.find((item) => item.id === id);
    return accessViewModel(state).writeRoles && role && !role.isSystem && revisionTag(role.revision)
      ? role
      : null;
  };
  const mutableGrant = (id: string) => {
    const state = store.snapshot();
    const grant = state.grants.find((item) => item.id === id);
    return accessViewModel(state).writeGrants && grant && revisionTag(grant.revision)
      ? grant
      : null;
  };
  return {
    snapshot: store.snapshot,
    subscribe: store.subscribe,
    load,
    loadFormOptions,
    async createGrant(body: GrantInput) {
      const state = store.snapshot();
      if (!accessViewModel(state).writeGrants) return;
      const confirmation = grantSummary(
        {
          type: body.subject.type,
          email: body.subject.type === 'email' ? body.subject.value : '',
          group: body.subject.type === 'group' ? body.subject.value : '',
          provider: body.subject.type === 'group' ? body.subject.provider : '',
          roleId: body.roleId,
        },
        state.catalogue.roles.find((role) => role.id === body.roleId),
        body.subject.type === 'group'
          ? state.providers.find(
              (provider) => body.subject.type === 'group' && provider.id === body.subject.provider,
            )
          : undefined,
        state.query.project,
        state.organizationName,
      );
      await write(
        () =>
          state.query.project === null
            ? client.request('post', '/_pb/grants', { body, idempotencyKey: crypto.randomUUID() })
            : client.request('post', '/_pb/projects/{project}/grants', {
                params: { project: state.query.project },
                body,
                idempotencyKey: crypto.randomUUID(),
              }),
        `Grant created. Access depends on the person's email or the groups their provider reports at sign-in. ${confirmation}`,
        true,
      );
    },
    async changeGrant(id: string, roleId: string) {
      const grant = mutableGrant(id);
      if (!grant) return;
      const project = store.snapshot().query.project;
      const headers = { 'If-Match': revisionTag(grant.revision)! };
      await write(
        () =>
          project === null
            ? client.request('patch', '/_pb/grants/{grant}', {
                params: { grant: id },
                headers,
                body: { roleId },
              })
            : client.request('patch', '/_pb/projects/{project}/grants/{grant}', {
                params: { project, grant: id },
                headers,
                body: { roleId },
              }),
        undefined,
        true,
      );
    },
    async revoke(id: string) {
      const grant = mutableGrant(id);
      if (!grant) return;
      const project = store.snapshot().query.project;
      const headers = { 'If-Match': revisionTag(grant.revision)! };
      await write(
        () =>
          project === null
            ? client.request('delete', '/_pb/grants/{grant}', { params: { grant: id }, headers })
            : client.request('delete', '/_pb/projects/{project}/grants/{grant}', {
                params: { project, grant: id },
                headers,
              }),
        undefined,
        true,
      );
    },
    async createRole(body: RoleInput) {
      if (accessViewModel(store.snapshot()).writeRoles)
        await write(() =>
          client.request('post', '/_pb/roles', { body, idempotencyKey: crypto.randomUUID() }),
        );
    },
    async updateRole(id: string, body: RoleChanges) {
      const role = mutableRole(id);
      if (role)
        await write(() =>
          client.request('patch', '/_pb/roles/{role}', {
            params: { role: id },
            headers: { 'If-Match': revisionTag(role.revision)! },
            body,
          }),
        );
    },
    async deleteRole(id: string) {
      const role = mutableRole(id);
      if (role)
        await write(() =>
          client.request('delete', '/_pb/roles/{role}', {
            params: { role: id },
            headers: { 'If-Match': revisionTag(role.revision)! },
          }),
        );
    },
    async replayed(result: ReplayResult) {
      const project = store.snapshot().query.project;
      const prefix =
        project === null
          ? rolesView(store.snapshot())
            ? '/_pb/roles'
            : '/_pb/grants'
          : `/_pb/projects/${encodeURIComponent(project)}/grants`;
      if (result.path !== prefix && !result.path.startsWith(`${prefix}/`)) return;
      if (result.ok) await load(store.snapshot().query, 'Access updated.');
      else
        store.set({
          stale: true,
          notice:
            result.status === 412 && !rolesView(store.snapshot())
              ? 'This grant changed. Reload it before saving.'
              : failureNotice(result),
        });
    },
    dispose() {
      ++generation;
    },
  };
}
type AccessController = ReturnType<typeof createAccessController>;
const permissionsOf = (value = '') => value.split(/[\s,]+/).filter(Boolean);
export function AccessView({
  state,
  controller,
}: {
  state: AccessState;
  controller: AccessController;
}) {
  const model = accessViewModel(state);
  const showGrantForms =
    !state.loading &&
    (state.query.project === null
      ? state.organization.includes('org:grants:write')
      : state.permissions.includes('project:grants:write'));
  return (
    <>
      <ManagementNotice
        listLabel={
          rolesView(state)
            ? undefined
            : state.query.project === null
              ? 'Organization grants'
              : 'Project grants'
        }
        {...state}
        reload={() => void controller.load(state.query)}
      />
      {rolesView(state) ? (
        <>
          {!state.loading && !state.listError && model.roles.length ? (
            <DataTable
              label="Roles"
              items={model.roles}
              columns={[
                {
                  key: 'name',
                  label: 'Role',
                  value: (role) => role.name,
                  render: (role) => (
                    <div className="grid gap-1">
                      <strong>{role.name}</strong>
                      <IdText value={role.id} label="role ID" />
                      {role.isSystem ? <Badge variant="outline">System</Badge> : null}
                      {role.protectsLastHolder ? (
                        <span className="text-xs text-neutral-600">Last holder protected</span>
                      ) : null}
                    </div>
                  ),
                },
                { key: 'scope', label: 'Scope', value: (role) => role.scope },
                {
                  key: 'permissions',
                  label: 'Permissions',
                  value: (role) => role.permissions.join(', '),
                  render: (role) => (
                    <div className="flex flex-wrap gap-1">
                      {role.permissions.map((permission) => (
                        <Badge key={permission} variant="outline">
                          {permission}
                        </Badge>
                      ))}
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  label: 'Actions',
                  value: () => '',
                  sortable: false,
                  render: (role) =>
                    model.writeRoles && !role.isSystem && revisionTag(role.revision) ? (
                      <details>
                        <summary className="cursor-pointer underline">Edit role</summary>
                        <div className="mt-3 grid gap-3">
                          <form
                            className="grid gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              if (state.busy) return;
                              const values = formValues(event);
                              void controller.updateRole(role.id, { name: values['name'] ?? '' });
                            }}
                          >
                            <Field name="name" label="Role name" value={role.name} />
                            <Button type="submit" disabled={state.busy}>
                              Rename role
                            </Button>
                          </form>
                          <form
                            className="grid gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              if (state.busy) return;
                              const values = formValues(event);
                              void controller.updateRole(role.id, {
                                permissions: permissionsOf(values['permissions']),
                              });
                            }}
                          >
                            <Field
                              name="permissions"
                              label="Permissions (comma separated)"
                              value={role.permissions.join(', ')}
                              required={false}
                            />
                            <Button type="submit" disabled={state.busy}>
                              Save permissions
                            </Button>
                          </form>
                          <ConfirmAction
                            key={`${role.id}:${role.revision}`}
                            action="Remove role"
                            target={`${role.name} (${role.id})`}
                            scope="Organization"
                            description="Deleting this role removes its permission bundle. Review grants using this role before continuing. This cannot be undone."
                            disabled={state.busy}
                            onConfirm={() => void controller.deleteRole(role.id)}
                          />
                        </div>
                      </details>
                    ) : null,
                },
              ]}
            />
          ) : null}
          {model.writeRoles ? (
            <details className="detail-group my-6">
              <summary className="cursor-pointer font-semibold">New role</summary>
              <form
                className="my-6 grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (state.busy) return;
                  const values = formValues(event);
                  void controller.createRole({
                    key: values['key'] ?? '',
                    name: values['name'] ?? '',
                    scope: values['scope'] as RoleInput['scope'],
                    permissions: permissionsOf(values['permissions']),
                  });
                }}
              >
                <h2 className="text-lg font-semibold">New role</h2>
                <Field name="key" label="Role key" />
                <Field name="name" label="Role name" />
                <Label className="grid gap-1">
                  Scope
                  <Select name="scope">
                    <option value="organization">Organization</option>
                    <option value="project">Project</option>
                  </Select>
                </Label>
                <Field name="permissions" label="Permissions (comma separated)" required={false} />
                <Button type="submit" disabled={state.busy}>
                  Create role
                </Button>
              </form>
            </details>
          ) : null}
        </>
      ) : (
        <>
          <h2 className="my-3 text-lg font-semibold">
            {state.query.project === null ? 'Organization grants' : 'Project grants'}
          </h2>
          <p className="text-sm text-neutral-600">
            {state.query.project === null
              ? state.organizationName
              : `Project: /${state.query.project}`}{' '}
            · Grants describe access rules; other grants may also apply.
          </p>
          {!state.loading && !state.listError ? (
            <p className="my-3 text-sm text-neutral-600">
              {model.grants.length} grants on this page
            </p>
          ) : null}
          {!state.loading && !state.listError && model.grants.length ? (
            <ReadableList
              label={state.query.project === null ? 'Organization grants' : 'Project grants'}
              items={model.grants}
              columns={[
                {
                  key: 'subject',
                  label: 'Person or group',
                  value: (grant) => grant.principalName ?? 'Name unavailable',
                  render: (grant) => (
                    <div className="grid gap-1">
                      <strong>{grant.principalName ?? 'Name unavailable'}</strong>
                      <span className="text-xs text-neutral-600">
                        {grant.kind === 'group' ? 'Group' : 'Person'}
                        {state.query.project !== null && grant.kind === 'email'
                          ? ' · No account yet'
                          : ''}
                        {grant.provider
                          ? ` · ${state.providers.find((provider) => provider.id === grant.provider)?.displayName ?? `Provider: ${grant.provider}`}`
                          : ''}
                      </span>
                    </div>
                  ),
                },
                {
                  key: 'role',
                  label: 'Role',
                  value: (grant) => grant.roleName,
                  render: (grant) => (
                    <div className="grid gap-1">
                      <span>{grant.roleName}</span>
                      {grant.rolePermissions ? (
                        <details>
                          <summary
                            className="min-h-11 cursor-pointer py-2"
                            aria-label={`View permissions for ${grant.roleName}`}
                          >
                            View permissions ({grant.rolePermissions.length})
                          </summary>
                          <ul>
                            {grant.rolePermissions.map((permission) => (
                              <li key={permission} className="my-2">
                                {permissionDescriptions[permission] ??
                                  'Permission description unavailable'}{' '}
                                <code className="break-all text-xs">{permission}</code>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        <span className="text-xs text-neutral-600">Permissions unavailable</span>
                      )}
                    </div>
                  ),
                },
                {
                  key: 'added',
                  label: 'Added',
                  value: (grant) => Date.parse(grant.createdAt) || 0,
                  render: (grant) => <ListDate value={grant.createdAt} />,
                },
                {
                  key: 'actions',
                  label: 'Actions',
                  value: () => '',
                  sortable: false,
                  render: (grant) => (
                    <ListRowActions
                      id={grant.id}
                      name={grant.principalName ?? 'Name unavailable'}
                      scope={`${state.query.project === null ? state.organizationName : `Project: /${state.query.project}`} · ${grant.roleName}${grant.provider ? ` · ${state.providers.find((provider) => provider.id === grant.provider)?.displayName ?? `Provider: ${grant.provider}`}` : ''}`}
                      primary={
                        showGrantForms && revisionTag(grant.revision)
                          ? {
                              id: 'change',
                              label: 'Change role',
                              disabled: state.busy || state.stale,
                              onSelect: () => {},
                            }
                          : undefined
                      }
                      mutation={
                        showGrantForms && revisionTag(grant.revision)
                          ? {
                              label: 'Revoke grant',
                              description:
                                'This removes the access provided by this grant. Other grants still apply. To restore this access, create a new grant.',
                              disabled: state.busy || state.stale,
                              run: () => void controller.revoke(grant.id),
                            }
                          : undefined
                      }
                    >
                      {state.notice ? <p role="alert">{state.notice}</p> : null}
                      {state.stale ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void controller.load(state.query)}
                        >
                          Reload
                        </Button>
                      ) : null}
                      <ChangeRoleForm
                        catalogue={state.catalogue}
                        project={state.query.project}
                        currentRole={grant.roleId}
                        busy={state.busy || state.stale}
                        retry={() => void controller.loadFormOptions()}
                        submit={(roleId) => controller.changeGrant(grant.id, roleId)}
                      />
                    </ListRowActions>
                  ),
                },
              ]}
            />
          ) : null}
          {showGrantForms ? (
            <details className="detail-group my-6">
              <summary className="cursor-pointer font-semibold">New grant</summary>
              <GrantForm
                key={state.query.project ?? 'organization'}
                catalogue={state.catalogue}
                providers={state.providers}
                providerStatus={state.providerStatus}
                project={state.query.project}
                organization={state.organizationName}
                busy={state.busy || state.stale}
                retry={() => void controller.loadFormOptions()}
                submit={(body) => controller.createGrant(body)}
              />
            </details>
          ) : null}
        </>
      )}
      {!state.loading &&
      !state.listError &&
      (rolesView(state) ? model.roles : model.grants).length === 0 ? (
        <ListState
          kind={state.query.q ? 'filtered-empty' : 'empty'}
          title={
            rolesView(state)
              ? 'No entries found on this page.'
              : state.query.q
                ? 'No grants match these filters on this page.'
                : state.query.project === null
                  ? 'No organization grants yet.'
                  : 'No project grants yet.'
          }
        >
          {state.query.q ? (
            <a
              className="underline"
              href={buildAccessHash({
                project: state.query.project,
                ...(state.query.status ? { status: state.query.status } : {}),
              })}
            >
              Clear filters
            </a>
          ) : !rolesView(state) ? (
            <p>
              {state.query.project === null
                ? 'Give a person or sign-in group an organization role.'
                : 'Give a person or sign-in group access to this project.'}
            </p>
          ) : null}
        </ListState>
      ) : null}
      {state.next ? (
        <a
          className="my-4 inline-block underline"
          href={buildAccessHash({ ...state.query, after: state.next })}
        >
          Next entries
        </a>
      ) : null}
    </>
  );
}
export function AccessPage() {
  const services = useServices();
  const controller = useMemo(() => createAccessController(services), [services]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const hash = useManagementHash(services, controller, parseAccessHash, 'access');
  const query = parseAccessHash(hash);
  return (
    <section aria-labelledby="page-heading">
      <h1 tabIndex={-1} id="page-heading" className="text-xl font-semibold">
        Access
      </h1>
      <p className="mt-1 text-neutral-600">
        Grants give people and sign-in groups access through roles. Other grants may also apply.
      </p>
      <ManagementFilters
        key={hash}
        route="access"
        query={query}
        statuses={query.project === null ? VIEWS : ['grants']}
      />
      <AccessView state={state} controller={controller} />
    </section>
  );
}
