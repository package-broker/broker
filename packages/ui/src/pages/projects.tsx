import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { operations } from '../api-types.js';
import type { ApiResult } from '../api.js';
import { useServices, type ShellServices, type ReplayResult } from '../auth.js';
import { buildListFilterHash } from '../page-hash.js';
import { Button } from '../components/ui/button.js';
import { DataTable } from '../components/ui/table.js';
import { StatusBadge } from '../components/ui/status-badge.js';
import { IdText } from '../components/ui/id-text.js';
import { ListState } from '../components/ui/list-state.js';
import { ConfirmAction } from '../components/ui/confirm-action.js';
import {
  createManagementStore,
  failureNotice,
  ManagementFilters,
  ManagementNotice,
  parseManagementHash,
  requireReauth,
  useManagementHash,
  type ManagementQuery,
} from './management.js';

import { ProjectForm } from './projects/project-form.js';

type Project = operations['getProject']['responses'][200]['content']['application/json'];
type ProjectItem =
  operations['listProjects']['responses'][200]['content']['application/json']['items'][number];
type Create = operations['createProject']['requestBody']['content']['application/json'];
type Changes = operations['updateProject']['requestBody']['content']['application/json'];
export type ProjectsQuery = ManagementQuery & { status?: 'active' | 'archived' };
const ARCHIVED_NOTICE = 'Project archived.';
const STATUSES = ['active', 'archived'] as const;
export const parseProjectsHash = (hash: string): ProjectsQuery =>
  parseManagementHash(hash, STATUSES) as ProjectsQuery;
export const buildProjectsHash = (query: ProjectsQuery) =>
  buildListFilterHash('projects', parseProjectsHash(buildListFilterHash('projects', query)));
type ProjectPage = { items: ProjectItem[]; next: string | null };
async function loadProjectList(
  client: ShellServices['client'],
  query: ProjectsQuery,
  includeArchived = true,
): Promise<ApiResult<ProjectPage>> {
  if (query.status)
    return client.request('get', '/_pb/projects', {
      query: { status: query.status, after: query.after, limit: '50' },
    });
  let cursors: (string | null | undefined)[] = [query.after, undefined];
  if (query.after?.startsWith('all:')) {
    try {
      const parsed: unknown = JSON.parse(query.after.slice(4));
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        !parsed.every((value) => value === null || typeof value === 'string')
      )
        throw new Error('Invalid cursor');
      cursors = parsed;
    } catch {
      return {
        ok: false,
        status: 400,
        code: 'invalid_request',
        details: [],
        request: { method: 'GET', path: '/_pb/projects' },
      };
    }
  }
  if (!includeArchived && cursors[0] === null)
    return { ok: true, status: 200, data: { items: [], next: null } };
  if (!includeArchived)
    return client.request('get', '/_pb/projects', {
      query: { status: 'active', after: cursors[0] ?? undefined, limit: '50' },
    });
  const pages = await Promise.all(
    STATUSES.map((status, index) =>
      cursors[index] === null
        ? null
        : client.request('get', '/_pb/projects', {
            query: { status, after: cursors[index] ?? undefined, limit: '50' },
          }),
    ),
  );
  const items: ProjectItem[] = [];
  const next: (string | null)[] = [];
  for (const [index, page] of pages.entries()) {
    if (page && !page.ok) {
      if (STATUSES[index] === 'archived' && page.status === 403) {
        next.push(null);
        continue;
      }
      return page;
    }
    if (page?.ok) items.push(...page.data.items);
    next.push(page?.ok ? page.data.next : null);
  }
  return {
    ok: true,
    status: 200,
    data: {
      items,
      next: next.some((cursor) => cursor !== null) ? `all:${JSON.stringify(next)}` : null,
    },
  };
}
interface ProjectsState {
  query: ProjectsQuery;
  items: ProjectItem[];
  next: string | null;
  selected: Project | null;
  etag: string | null;
  organization: string[];
  permissions: string[];
  loading: boolean;
  listError: boolean;
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
    transitionItems:
      !state.loading && !state.stale && state.organization.includes('org:projects:archive'),
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
    listError: false,
    busy: false,
    stale: false,
    notice: null,
  });
  let generation = 0;
  const { client } = services;
  async function load(
    query: ProjectsQuery,
    notice: string | null = buildProjectsHash(query) ===
      buildProjectsHash(store.snapshot().query) && store.snapshot().notice === ARCHIVED_NOTICE
      ? ARCHIVED_NOTICE
      : null,
  ): Promise<void> {
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
      listError: false,
      busy: false,
      stale: false,
      notice,
    });
    const organizationRequest = client.request('get', '/_pb/me/permissions');
    const [initialList, organization, initialSelected, initialPermissions] = await Promise.all([
      organizationRequest.then((result) =>
        loadProjectList(
          client,
          query,
          result.ok &&
            result.data.organization.includes('org:projects:archive') &&
            result.data.organization.includes('project:read'),
        ),
      ),
      organizationRequest,
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
    let list = initialList;
    let selected = initialSelected;
    let permissions = initialPermissions;
    if (selected && !selected.ok && selected.status === 404) {
      let after: string | undefined;
      const cursors = new Set<string>();
      while (true) {
        const archivedQuery: ProjectsQuery = { project: null, status: 'archived', after };
        const archived = await loadProjectList(client, archivedQuery);
        if (current !== generation) return;
        if (!archived.ok) break;
        if (
          archived.data.items.some(
            (item) => item.slug === query.project && item.status === 'archived',
          )
        ) {
          query = archivedQuery;
          list = archived;
          selected = null;
          permissions = null;
          notice = ARCHIVED_NOTICE;
          break;
        }
        const next = archived.data.next;
        if (!next || cursors.has(next)) break;
        cursors.add(next);
        after = next;
      }
    }
    if (notice === ARCHIVED_NOTICE) {
      query = { ...query, project: null };
      selected = null;
      permissions = null;
      if (!list.ok) {
        query = { ...query, status: 'active', after: undefined };
        list = await loadProjectList(client, query);
        if (current !== generation) return;
      }
    }
    store.set({
      query,
      loading: false,
      listError: !list.ok,
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
  async function write(
    run: () => Promise<ApiResult<unknown>>,
    archivedSlug?: string,
    successNotice = 'Project updated.',
    conflictNotice = 'Changed elsewhere. Reload before trying again.',
  ) {
    const state = store.snapshot();
    if (state.busy || state.loading || state.stale) return;
    const current = generation;
    store.set({ busy: true, notice: null });
    const result = await run();
    if (result.ok) services.onProjectsChanged?.();
    if (current !== generation) return;
    store.set({ busy: false });
    if (requireReauth(services, result)) {
      store.set({
        stale: true,
        notice: 'Complete reauthentication and confirm the pending action.',
      });
    } else if (!result.ok) {
      store.set({
        stale: result.status === 412,
        notice: result.status === 412 ? conflictNotice : failureNotice(result),
      });
    } else
      await load(
        archivedSlug ? { ...state.query, project: archivedSlug } : state.query,
        archivedSlug ? ARCHIVED_NOTICE : successNotice,
      );
    return result;
  }
  return {
    snapshot: store.snapshot,
    subscribe: store.subscribe,
    load,
    async create(body: Create) {
      if (projectsViewModel(store.snapshot()).create)
        return write(
          () =>
            client.request('post', '/_pb/projects', { body, idempotencyKey: crypto.randomUUID() }),
          undefined,
          'Project created.',
        );
    },
    async update(body: Changes) {
      const state = store.snapshot();
      if (projectsViewModel(state).settings)
        return write(
          () =>
            client.request('patch', '/_pb/projects/{project}', {
              params: { project: state.selected!.slug },
              headers: { 'If-Match': state.etag! },
              body,
            }),
          undefined,
          'Access policy saved. Existing tokens now use this limit.',
          'This project changed while you were editing. Reload the latest settings before saving.',
        );
    },
    async transition() {
      const state = store.snapshot();
      if (projectsViewModel(state).transition)
        await write(
          () =>
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
          state.selected!.status === 'active' ? state.selected!.slug : undefined,
        );
    },
    async transitionItem(id: string) {
      const state = store.snapshot();
      const item = state.items.find((entry) => entry.id === id);
      if (!item?.etag || !projectsViewModel(state).transitionItems) return;
      await write(
        () =>
          client.request(
            'post',
            item.status === 'active'
              ? '/_pb/projects/{project}/archive'
              : '/_pb/projects/{project}/restore',
            {
              params: { project: item.slug },
              headers: { 'If-Match': item.etag },
              idempotencyKey: crypto.randomUUID(),
            },
          ),
        item.status === 'active' ? item.slug : undefined,
      );
    },
    async replayed(result: ReplayResult) {
      const project = store.snapshot().query.project;
      const path = project === null ? null : `/_pb/projects/${encodeURIComponent(project)}`;
      const listTransition = /^\/_pb\/projects\/[^/]+\/(?:archive|restore)$/.test(result.path);
      if (
        !listTransition &&
        result.path !== '/_pb/projects' &&
        (path === null || ![path, `${path}/archive`, `${path}/restore`].includes(result.path))
      )
        return;
      if (result.ok) {
        const archivedSlug =
          listTransition && result.path.endsWith('/archive')
            ? decodeURIComponent(result.path.split('/')[3]!)
            : null;
        await load(
          archivedSlug
            ? { ...store.snapshot().query, project: archivedSlug }
            : store.snapshot().query,
          archivedSlug
            ? ARCHIVED_NOTICE
            : result.path === '/_pb/projects'
              ? 'Project created.'
              : result.path === path
                ? 'Access policy saved. Existing tokens now use this limit.'
                : 'Project updated.',
        );
      } else
        store.set({
          stale: true,
          notice:
            result.path === path && result.status === 412
              ? 'This project changed while you were editing. Reload the latest settings before saving.'
              : failureNotice(result),
        });
    },
    dispose() {
      ++generation;
    },
  };
}
type ProjectsController = ReturnType<typeof createProjectsController>;
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
      <p role="status" className="sr-only">
        {state.notice}
      </p>
      <ManagementNotice {...state} reload={() => void controller.load(state.query)} />
      {state.query.q ? <p>Filtering loaded projects on this page.</p> : null}
      {!state.loading && !state.listError ? (
        model.items.length ? (
          <>
            <p className="my-3 text-sm text-neutral-600">
              {model.items.length} projects on this page
            </p>
            <DataTable
              label="Projects"
              items={model.items}
              selectedId={state.selected?.id ?? ''}
              columns={[
                {
                  key: 'name',
                  label: 'Name',
                  value: (item) => item.name,
                  render: (item) => (
                    <div className="grid gap-1">
                      <a
                        className="font-medium underline"
                        href={buildProjectsHash({ ...state.query, project: item.slug })}
                      >
                        {item.name}
                      </a>
                      <code className="text-xs text-neutral-600">{item.slug}</code>
                    </div>
                  ),
                },
                {
                  key: 'status',
                  label: 'Status',
                  value: (item) => item.status,
                  render: (item) => <StatusBadge status={item.status} />,
                },
                {
                  key: 'id',
                  label: 'Project ID',
                  value: (item) => item.id,
                  render: (item) => <IdText value={item.id} label="project ID" />,
                  priority: 3,
                },
                {
                  key: 'actions',
                  label: 'Actions',
                  value: () => '',
                  sortable: false,
                  render: (item) => (
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        className="underline"
                        href={buildProjectsHash({ ...state.query, project: item.slug })}
                      >
                        Open settings
                      </a>
                      {model.transitionItems && item.etag ? (
                        item.status === 'active' ? (
                          <ConfirmAction
                            key={`${item.id}:${item.etag}`}
                            action="Archive"
                            target={`${item.name} (${item.id})`}
                            scope={`Project: ${item.slug}`}
                            description="Archiving keeps project history and blocks new publishes. You can restore this project later."
                            disabled={state.busy}
                            onConfirm={() => void controller.transitionItem(item.id)}
                          />
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={state.busy}
                            onClick={() => void controller.transitionItem(item.id)}
                          >
                            Restore
                          </Button>
                        )
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
          </>
        ) : (
          <ListState
            kind={state.query.q || state.query.status ? 'filtered-empty' : 'empty'}
            title="No projects found on this page."
          />
        )
      ) : null}
      {state.next ? (
        <a
          className="my-4 inline-block underline"
          href={buildProjectsHash({ ...state.query, after: state.next })}
        >
          Next projects
        </a>
      ) : null}
      {state.organization.includes('org:projects:create') && !state.loading ? (
        <details className="detail-group my-6">
          <summary className="cursor-pointer font-semibold">New project</summary>
          <ProjectForm
            disabled={!model.create || state.busy}
            submit={(body) => controller.create({ ...body, slug: body.slug ?? '' })}
          />
        </details>
      ) : null}
      {state.selected ? (
        <section className="detail-group my-6 grid gap-3" aria-label="Project settings">
          <h2 className="text-lg font-semibold">Settings: {state.selected.name}</h2>
          {state.permissions.includes('project:settings:write') &&
          state.selected.status === 'active' ? (
            <ProjectForm
              key={`${state.selected.id}-${state.etag}`}
              project={state.selected}
              disabled={!model.settings || state.busy}
              submit={controller.update}
            />
          ) : state.selected.requirePublishApproval ? (
            <p className="text-sm text-neutral-600">
              Publish approval is saved as required, but approval is not enforced in this version.
            </p>
          ) : null}
          {model.transition ? (
            state.selected.status === 'active' ? (
              <ConfirmAction
                key={`${state.selected.id}:${state.etag}`}
                action="Archive"
                target={state.selected.name}
                scope={`Project: ${state.selected.slug}`}
                description="Archiving keeps project history and blocks new publishes. You can restore this project later."
                disabled={state.busy}
                onConfirm={() => void controller.transition()}
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={state.busy}
                onClick={() => void controller.transition()}
              >
                Restore
              </Button>
            )
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
  useEffect(() => {
    if (state.loading || state.notice !== ARCHIVED_NOTICE || state.query.project !== null) return;
    const next = buildProjectsHash(state.query);
    if (window.location.hash === next) return;
    window.history.replaceState(null, '', next);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, [state.loading, state.notice, state.query]);
  return (
    <section aria-labelledby="page-heading">
      <h1 tabIndex={-1} id="page-heading" className="text-xl font-semibold">
        Projects
      </h1>
      <p className="mt-1 text-neutral-600">
        Scopes for sources, packages and tokens. Archiving keeps history and blocks new publishes.
      </p>
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
