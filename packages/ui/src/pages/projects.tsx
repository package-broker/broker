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
  useManagementHash,
  type ManagementQuery,
} from './management.js';

type Project = operations['getProject']['responses'][200]['content']['application/json'];
type ProjectItem =
  operations['listProjects']['responses'][200]['content']['application/json']['items'][number];
type Create = operations['createProject']['requestBody']['content']['application/json'];
type Changes = operations['updateProject']['requestBody']['content']['application/json'];
export type ProjectsQuery = ManagementQuery & { status?: 'active' | 'archived' };
const STATUSES = ['active', 'archived'] as const;
export const parseProjectsHash = (hash: string): ProjectsQuery =>
  parseManagementHash(hash, STATUSES) as ProjectsQuery;
export const buildProjectsHash = (query: ProjectsQuery) =>
  buildListFilterHash('projects', parseProjectsHash(buildListFilterHash('projects', query)));
interface ProjectsState {
  query: ProjectsQuery;
  items: ProjectItem[];
  next: string | null;
  selected: Project | null;
  etag: string | null;
  organization: string[];
  permissions: string[];
  loading: boolean;
  busy: boolean;
  stale: boolean;
  notice: string | null;
}
export function projectsViewModel(state: ProjectsState) {
  const selected = state.selected;
  const ready = !!selected && !!state.etag && !state.loading && !state.stale;
  return {
    items: state.items.filter(
      (item) => !state.query.q || item.name.toLowerCase().startsWith(state.query.q.toLowerCase()),
    ),
    create: state.organization.includes('org:projects:create') && !state.stale && !state.loading,
    settings:
      ready && selected.status === 'active' && state.permissions.includes('project:settings:write'),
    transition: ready && state.organization.includes('org:projects:archive'),
  };
}
export function createProjectsController(services: ShellServices) {
  const store = createManagementStore<ProjectsState>({
    query: { project: null },
    items: [],
    next: null,
    selected: null,
    etag: null,
    organization: [],
    permissions: [],
    loading: false,
    busy: false,
    stale: false,
    notice: null,
  });
  let generation = 0;
  const { client } = services;
  async function load(query: ProjectsQuery, notice: string | null = null): Promise<void> {
    const current = ++generation;
    store.set({
      query,
      items: [],
      next: null,
      selected: null,
      etag: null,
      organization: [],
      permissions: [],
      loading: true,
      busy: false,
      stale: false,
      notice,
    });
    const [list, organization, selected, permissions] = await Promise.all([
      client.request('get', '/_pb/projects', {
        query: { status: query.status, after: query.after, limit: '50' },
      }),
      client.request('get', '/_pb/me/permissions'),
      query.project === null
        ? null
        : client.request('get', '/_pb/projects/{project}', { params: { project: query.project } }),
      query.project === null
        ? null
        : client.request('get', '/_pb/projects/{project}/permissions', {
            params: { project: query.project },
          }),
    ]);
    if (current !== generation) return;
    store.set({
      loading: false,
      items: list.ok ? list.data.items : [],
      next: list.ok ? list.data.next : null,
      organization: organization.ok ? organization.data.organization : [],
      selected: selected?.ok ? selected.data : null,
      etag: selected?.ok ? (selected.headers?.etag ?? null) : null,
      permissions: permissions?.ok ? permissions.data.project : [],
      notice: !list.ok
        ? failureNotice(list)
        : selected && !selected.ok
          ? failureNotice(selected)
          : notice,
    });
  }
  async function write(run: () => Promise<ApiResult<unknown>>) {
    const state = store.snapshot();
    if (state.busy || state.loading || state.stale) return;
    const current = generation;
    store.set({ busy: true, notice: null });
    const result = await run();
    if (current !== generation) return;
    store.set({ busy: false });
    if (requireReauth(services, result)) {
      store.set({
        stale: true,
        notice: 'Complete reauthentication and confirm the pending action.',
      });
    } else if (!result.ok) {
      store.set({ stale: result.status === 412, notice: failureNotice(result) });
    } else await load(state.query, 'Project updated.');
  }
  return {
    snapshot: store.snapshot,
    subscribe: store.subscribe,
    load,
    async create(body: Create) {
      if (projectsViewModel(store.snapshot()).create)
        await write(() =>
          client.request('post', '/_pb/projects', { body, idempotencyKey: crypto.randomUUID() }),
        );
    },
    async update(body: Changes) {
      const state = store.snapshot();
      if (projectsViewModel(state).settings)
        await write(() =>
          client.request('patch', '/_pb/projects/{project}', {
            params: { project: state.selected!.slug },
            headers: { 'If-Match': state.etag! },
            body,
          }),
        );
    },
    async transition() {
      const state = store.snapshot();
      if (projectsViewModel(state).transition)
        await write(() =>
          client.request(
            'post',
            state.selected!.status === 'active'
              ? '/_pb/projects/{project}/archive'
              : '/_pb/projects/{project}/restore',
            {
              params: { project: state.selected!.slug },
              headers: { 'If-Match': state.etag! },
              idempotencyKey: crypto.randomUUID(),
            },
          ),
        );
    },
    async replayed(result: ReplayResult) {
      const project = store.snapshot().query.project;
      const path = project === null ? null : `/_pb/projects/${encodeURIComponent(project)}`;
      if (
        result.path !== '/_pb/projects' &&
        (path === null || ![path, `${path}/archive`, `${path}/restore`].includes(result.path))
      )
        return;
      if (result.ok) await load(store.snapshot().query, 'Project updated.');
      else store.set({ stale: true, notice: failureNotice(result) });
    },
    dispose() {
      ++generation;
    },
  };
}
type ProjectsController = ReturnType<typeof createProjectsController>;
function TokenPolicy(props: { project?: Project }) {
  return (
    <>
      <Label className="grid gap-1">
        Maximum token scope
        <Select name="tokenMaxScope" defaultValue={props.project?.tokenMaxScope ?? 'read'}>
          {['read', 'write', 'full'].map((scope) => (
            <option key={scope} value={scope}>
              {scope}
            </option>
          ))}
        </Select>
      </Label>
      <Label className="grid gap-1">
        Publish approval
        <Select
          name="requirePublishApproval"
          defaultValue={String(props.project?.requirePublishApproval ?? false)}
        >
          <option value="false">Not required</option>
          <option value="true">Required</option>
        </Select>
      </Label>
    </>
  );
}
export function ProjectsView({
  state,
  controller,
}: {
  state: ProjectsState;
  controller: ProjectsController;
}) {
  const model = projectsViewModel(state);
  return (
    <>
      <ManagementNotice {...state} reload={() => void controller.load(state.query)} />
      {state.query.q ? <p>Filtering loaded projects on this page.</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {model.items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <a
                  className="underline"
                  href={buildProjectsHash({ ...state.query, project: item.slug })}
                >
                  {item.name}
                </a>
              </TableCell>
              <TableCell>{item.slug}</TableCell>
              <TableCell>{item.status}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!state.loading && model.items.length === 0 ? <p>No projects found on this page.</p> : null}
      {state.next ? (
        <a
          className="my-4 inline-block underline"
          href={buildProjectsHash({ ...state.query, after: state.next })}
        >
          Next projects
        </a>
      ) : null}
      {model.create ? (
        <form
          className="my-6 grid gap-3"
          onSubmit={(event) => {
            const values = formValues(event);
            void controller.create({
              name: values['name'] ?? '',
              slug: values['slug'] ?? '',
              tokenMaxScope: values['tokenMaxScope'] as Project['tokenMaxScope'],
              requirePublishApproval: values['requirePublishApproval'] === 'true',
            });
          }}
        >
          <h2 className="text-lg font-semibold">New project</h2>
          <Field name="name" label="Project name" />
          <Field name="slug" label="Slug" />
          <TokenPolicy />
          <Button disabled={state.busy}>Create project</Button>
        </form>
      ) : null}
      {state.selected ? (
        <section className="my-6 grid gap-3" aria-label="Project settings">
          <h2 className="text-lg font-semibold">Settings: {state.selected.name}</h2>
          <p>
            Maximum token scope: {state.selected.tokenMaxScope}. Publish approval:{' '}
            {state.selected.requirePublishApproval ? 'required' : 'not required'}.
          </p>
          {model.settings ? (
            <form
              key={`${state.selected.id}-${state.etag}`}
              className="grid gap-3"
              onSubmit={(event) => {
                const values = formValues(event);
                void controller.update({
                  name: values['name'] ?? '',
                  tokenMaxScope: values['tokenMaxScope'] as Project['tokenMaxScope'],
                  requirePublishApproval: values['requirePublishApproval'] === 'true',
                });
              }}
            >
              <Field name="name" label="Project name" value={state.selected.name} />
              <TokenPolicy project={state.selected} />
              <Button disabled={state.busy}>Save settings</Button>
            </form>
          ) : null}
          {model.transition ? (
            <Button
              variant="outline"
              disabled={state.busy}
              onClick={() => void controller.transition()}
            >
              {state.selected.status === 'active' ? 'Archive' : 'Restore'}
            </Button>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
export function ProjectsPage() {
  const services = useServices();
  const controller = useMemo(() => createProjectsController(services), [services]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const hash = useManagementHash(services, controller, parseProjectsHash, 'projects');
  return (
    <section aria-labelledby="page-heading">
      <h1 id="page-heading" className="text-xl font-semibold">
        Projects
      </h1>
      <ManagementFilters
        key={hash}
        route="projects"
        query={parseProjectsHash(hash)}
        statuses={STATUSES}
      />
      <ProjectsView state={state} controller={controller} />
    </section>
  );
}
