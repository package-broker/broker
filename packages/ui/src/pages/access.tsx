import { useMemo, useSyncExternalStore } from 'react';
import type { operations } from '../api-types.js';
import type { ApiResult } from '../api.js';
import { useServices, type ShellServices, type ReplayResult } from '../auth.js';
import { buildListFilterHash } from '../page-hash.js';
import { Button } from '../components/ui/button.js';
import { Label } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
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
  roleId: string;
  roleName: string;
  revision: number;
}
export type AccessQuery = ManagementQuery;
const VIEWS = ['grants', 'roles'] as const;
export const parseAccessHash = (hash: string): AccessQuery => parseManagementHash(hash, VIEWS);
export const buildAccessHash = (query: AccessQuery) =>
  buildListFilterHash('access', parseAccessHash(buildListFilterHash('access', query)));
interface AccessState {
  query: AccessQuery;
  roles: Role[];
  grants: Grant[];
  next: string | null;
  organization: string[];
  permissions: string[];
  loading: boolean;
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
      [grant.principalName, grant.principalId, grant.id].some((value) =>
        value?.toLowerCase().startsWith(prefix),
      ),
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
    grants: [],
    next: null,
    organization: [],
    permissions: [],
    loading: false,
    busy: false,
    stale: false,
    notice: null,
  });
  const { client } = services;
  let generation = 0;
  async function load(query: AccessQuery, notice: string | null = null): Promise<void> {
    const current = ++generation;
    store.set({
      query,
      roles: [],
      grants: [],
      next: null,
      organization: [],
      permissions: [],
      loading: true,
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
    const canRead =
      query.project === null
        ? orgPermissions.includes(roles ? 'org:roles:read' : 'org:grants:read')
        : permissions.includes('project:grants:read');
    if (!canRead) {
      store.set({ loading: false, notice: 'You do not have permission to view this list.' });
      return;
    }
    const page = { after: query.after, limit: '50' };
    if (roles) {
      const result = await client.request('get', '/_pb/roles', { query: page });
      if (current !== generation) return;
      store.set({
        loading: false,
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
        grants: result.ok
          ? result.data.items.map((item) => ({
              id: item.id,
              principalId: item.principal.id,
              principalName: item.principal.displayName,
              kind: item.principal.kind,
              roleId: item.role.id,
              roleName: item.role.name,
              revision: item.revision,
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
        grants: result.ok
          ? result.data.items.map((item) => ({
              id: item.id,
              principalId: null,
              principalName: null,
              kind: item.subject.type,
              roleId: item.roleId,
              roleName: item.roleId,
              revision: item.revision,
            }))
          : [],
        next: result.ok ? result.data.next : null,
        notice: result.ok ? notice : failureNotice(result),
      });
    }
  }
  async function write(run: () => Promise<ApiResult<unknown>>) {
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
    else if (!result.ok) store.set({ stale: result.status === 412, notice: failureNotice(result) });
    else await load(state.query, 'Access updated.');
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
    async createGrant(body: GrantInput) {
      const state = store.snapshot();
      if (!accessViewModel(state).writeGrants) return;
      await write(() =>
        state.query.project === null
          ? client.request('post', '/_pb/grants', { body, idempotencyKey: crypto.randomUUID() })
          : client.request('post', '/_pb/projects/{project}/grants', {
              params: { project: state.query.project },
              body,
              idempotencyKey: crypto.randomUUID(),
            }),
      );
    },
    async changeGrant(id: string, roleId: string) {
      const grant = mutableGrant(id);
      if (!grant) return;
      const project = store.snapshot().query.project;
      const headers = { 'If-Match': revisionTag(grant.revision)! };
      await write(() =>
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
      );
    },
    async revoke(id: string) {
      const grant = mutableGrant(id);
      if (!grant) return;
      const project = store.snapshot().query.project;
      const headers = { 'If-Match': revisionTag(grant.revision)! };
      await write(() =>
        project === null
          ? client.request('delete', '/_pb/grants/{grant}', { params: { grant: id }, headers })
          : client.request('delete', '/_pb/projects/{project}/grants/{grant}', {
              params: { project, grant: id },
              headers,
            }),
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
      else store.set({ stale: true, notice: failureNotice(result) });
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
  return (
    <>
      <ManagementNotice {...state} reload={() => void controller.load(state.query)} />
      {rolesView(state) ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                {['Role', 'Scope', 'Permissions', 'Actions'].map((label) => (
                  <TableHead key={label}>{label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {model.roles.map((role) => (
                <TableRow key={`${role.id}-${role.revision}`}>
                  <TableCell>
                    {role.name}
                    <code className="block text-xs">{role.id}</code>
                    {role.isSystem ? ' (system)' : ''}
                    {role.protectsLastHolder ? ' (last holder protected)' : ''}
                  </TableCell>
                  <TableCell>{role.scope}</TableCell>
                  <TableCell>{role.permissions.join(', ')}</TableCell>
                  <TableCell>
                    {model.writeRoles && !role.isSystem && revisionTag(role.revision) ? (
                      <div className="grid gap-3">
                        <form
                          className="grid gap-2"
                          onSubmit={(event) => {
                            const values = formValues(event);
                            void controller.updateRole(role.id, { name: values['name'] ?? '' });
                          }}
                        >
                          <Field name="name" label="Role name" value={role.name} />
                          <Button disabled={state.busy}>Rename role</Button>
                        </form>
                        <form
                          className="grid gap-2"
                          onSubmit={(event) => {
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
                          <Button disabled={state.busy}>Save permissions</Button>
                        </form>
                        <Button
                          variant="destructive"
                          disabled={state.busy}
                          onClick={() => void controller.deleteRole(role.id)}
                        >
                          Delete role
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {model.writeRoles ? (
            <form
              className="my-6 grid gap-3"
              onSubmit={(event) => {
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
              <Button disabled={state.busy}>Create role</Button>
            </form>
          ) : null}
        </>
      ) : (
        <>
          <h2 className="my-3 text-lg font-semibold">
            {state.query.project === null ? 'Organization grants' : 'Members and project grants'}
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                {['Principal / grant', 'Kind', 'Role', 'Actions'].map((label) => (
                  <TableHead key={label}>{label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {model.grants.map((grant) => (
                <TableRow key={`${grant.id}-${grant.revision}`}>
                  <TableCell>
                    {grant.principalName ?? grant.principalId ?? grant.id}
                    {grant.principalName !== null ? (
                      <code className="block text-xs">{grant.principalId}</code>
                    ) : null}
                  </TableCell>
                  <TableCell>{grant.kind}</TableCell>
                  <TableCell>{grant.roleName}</TableCell>
                  <TableCell>
                    {model.writeGrants && revisionTag(grant.revision) ? (
                      <div className="grid gap-2">
                        <form
                          className="grid gap-2"
                          onSubmit={(event) => {
                            const values = formValues(event);
                            void controller.changeGrant(grant.id, values['roleId'] ?? '');
                          }}
                        >
                          <Field name="roleId" label="Role ID" value={grant.roleId} />
                          <Button disabled={state.busy}>Change role</Button>
                        </form>
                        <Button
                          variant="destructive"
                          disabled={state.busy}
                          onClick={() => void controller.revoke(grant.id)}
                        >
                          Revoke
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {model.writeGrants ? (
            <form
              className="my-6 grid gap-3"
              onSubmit={(event) => {
                const values = formValues(event);
                void controller.createGrant({
                  roleId: values['roleId'] ?? '',
                  subject:
                    values['type'] === 'group'
                      ? {
                          type: 'group',
                          provider: values['provider'] ?? '',
                          value: values['subject'] ?? '',
                        }
                      : { type: 'email', value: values['subject'] ?? '' },
                });
              }}
            >
              <h2 className="text-lg font-semibold">New grant</h2>
              <Field name="roleId" label="Role ID" />
              <Label className="grid gap-1">
                Subject type
                <Select name="type">
                  <option value="email">Email</option>
                  <option value="group">Group</option>
                </Select>
              </Label>
              <Field name="subject" label="Subject value" />
              <Field name="provider" label="Provider (groups only)" required={false} />
              <Button disabled={state.busy}>Create grant</Button>
            </form>
          ) : null}
        </>
      )}
      {!state.loading && (rolesView(state) ? model.roles : model.grants).length === 0 ? (
        <p>No entries found on this page.</p>
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
      <h1 id="page-heading" className="text-xl font-semibold">
        Access
      </h1>
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
