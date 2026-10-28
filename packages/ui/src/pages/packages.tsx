import { PackageSourceControls } from './packages/source-actions.js';
import { PROXY_DEMAND_MESSAGE } from './sources/proxy-message.js';
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { operations } from '../api-types.js';
import { safePageHash, useServices, type ShellServices, type ReplayResult } from '../auth.js';
import { buildListFilterHash } from '../page-hash.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import { DataTable } from '../components/ui/table.js';
import { STATUS_LABELS, StatusBadge } from '../components/ui/status-badge.js';
import { Time } from '../components/ui/time.js';
import { VulnerabilityStatus } from '../components/vulnerability-status.js';
import { IdText } from '../components/ui/id-text.js';
import { ListState } from '../components/ui/list-state.js';
import { FilterToolbar } from '../components/ui/toolbar.js';

export type PackageItem =
  operations['listPackages']['responses'][200]['content']['application/json']['items'][number];
export type VersionItem =
  operations['listPackageVersions']['responses'][200]['content']['application/json']['items'][number];
type PackageStatus = PackageItem['status'];
type Action = 'quarantine' | 'tombstone' | 'release';

const STATUSES: readonly PackageStatus[] = [
  'active',
  'quarantined',
  'tombstoned',
  'removed_upstream',
];
const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ACTION_LABELS: Record<Action, string> = {
  quarantine: 'Quarantine',
  tombstone: 'Tombstone',
  release: 'Release',
};
const statusLabel = (status: PackageStatus) => STATUS_LABELS[status];

function mutationScope(access: PackageAccess): string {
  return access.organization.includes('org:packages:manage')
    ? 'Organization'
    : `Project ${access.projectSlug}`;
}

export interface PackageQuery {
  project: string | null;
  projectId?: string;
  status?: PackageStatus;
  source?: string;
  q?: string;
  after?: string;
}

export function parsePackagesHash(hash: string): PackageQuery {
  const params = new URLSearchParams(safePageHash(hash).split('?')[1]);
  const state: PackageQuery = { project: params.get('project') };
  const status = params.get('status');
  if (STATUSES.includes(status as PackageStatus)) state.status = status as PackageStatus;
  const source = params.get('source');
  if (source !== null) state.source = source;
  const projectId = params.get('projectId');
  if (state.project === null && projectId !== null) state.projectId = projectId;
  const q = params.get('q')?.trim().toLowerCase();
  if (q && q.length <= 100 && !q.includes('\0')) state.q = q;
  const after = params.get('after');
  if (after !== null) state.after = after;
  return state;
}

export function buildPackagesHash(state: PackageQuery): string {
  return buildListFilterHash('packages', state);
}

export interface PackageAccess {
  organization: readonly string[];
  project: readonly string[];
  projectId: string | null;
  projectSlug: string | null;
}

export function packageActions(
  item: PackageItem,
  status: VersionItem['status'],
  access: PackageAccess,
): Action[] {
  const admin = access.organization.includes('org:packages:manage');
  const manager =
    access.projectSlug !== null &&
    access.projectId !== null &&
    access.project.includes('project:packages:manage') &&
    item.source.projectId === access.projectId;
  if (!admin && !manager) return [];
  const actions: Action[] = [];
  if (status === 'active' || status === 'removed_upstream') actions.push('quarantine');
  if (status === 'active' || status === 'removed_upstream' || status === 'quarantined')
    actions.push('tombstone');
  if (status === 'quarantined') actions.push('release');
  return actions;
}

export interface PackagesState {
  query: PackageQuery;
  items: readonly PackageItem[];
  next: string | null;
  access: PackageAccess;
  selected: PackageItem | null;
  versions: readonly VersionItem[];
  versionsNext: string | null;
  loading: boolean;
  versionsLoading: boolean;
  busy: boolean;
  notice: string | null;
  confirmVersion: string | null;
  listError?: boolean;
  versionsError?: boolean;
}

export function createPackagesController(services: ShellServices) {
  let state: PackagesState = {
    query: { project: null },
    items: [],
    next: null,
    access: { organization: [], project: [], projectId: null, projectSlug: null },
    selected: null,
    versions: [],
    versionsNext: null,
    loading: false,
    versionsLoading: false,
    busy: false,
    notice: null,
    confirmVersion: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<PackagesState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  let generation = 0;
  let versionGeneration = 0;
  let navigationGeneration = 0;
  let loadedQuery: string | null = null;
  let versionAfter: string | undefined;
  const client = services.client;

  async function load(query: PackageQuery, notice: string | null = null): Promise<void> {
    const current = ++generation;
    ++versionGeneration;
    loadedQuery = null;
    set({
      query,
      items: [],
      next: null,
      selected: null,
      versions: [],
      versionsNext: null,
      confirmVersion: null,
      loading: true,
      listError: false,
      versionsError: false,
      versionsLoading: false,
      busy: false,
      notice,
      access: { organization: [], project: [], projectId: null, projectSlug: query.project },
    });
    const filters = { status: query.status, source: query.source, q: query.q, after: query.after };
    const [permissions, projectPermissions, project, list] = await Promise.all([
      client.request('get', '/_pb/me/permissions'),
      query.project === null
        ? null
        : client.request('get', '/_pb/projects/{project}/permissions', {
            params: { project: query.project },
          }),
      query.project === null
        ? null
        : client.request('get', '/_pb/projects/{project}', { params: { project: query.project } }),
      query.project === null
        ? client.request('get', '/_pb/packages', {
            query: { ...filters, project: query.projectId },
          })
        : client.request('get', '/_pb/projects/{project}/packages', {
            params: { project: query.project },
            query: filters,
          }),
    ]);
    if (current !== generation) return;
    loadedQuery = list.ok ? buildPackagesHash(query) : null;
    set({
      loading: false,
      listError: !list.ok,
      access: {
        organization: permissions.ok ? permissions.data.organization : [],
        project: projectPermissions?.ok ? projectPermissions.data.project : [],
        projectId: project?.ok ? project.data.id : null,
        projectSlug: query.project,
      },
      items: list.ok ? list.data.items : [],
      next: list.ok ? list.data.next : null,
      notice:
        [
          notice,
          list.ok
            ? null
            : list.status === 404
              ? 'Not found.'
              : 'Packages could not be loaded. Try again.',
        ]
          .filter(Boolean)
          .join(' ') || null,
    });
  }

  async function open(id: string, after?: string): Promise<void> {
    if (state.busy || state.loading) return;
    const selected = state.items.find((item) => item.id === id);
    if (!selected) return;
    const current = ++versionGeneration;
    const scope = generation;
    const project = state.query.project;
    versionAfter = after;
    set({
      selected,
      versions: [],
      versionsNext: null,
      versionsLoading: true,
      versionsError: false,
      confirmVersion: null,
    });
    const result =
      project === null
        ? await client.request('get', '/_pb/packages/{package}/versions', {
            params: { package: id },
            query: { after },
          })
        : await client.request('get', '/_pb/projects/{project}/packages/{package}/versions', {
            params: { project, package: id },
            query: { after },
          });
    if (current !== versionGeneration || scope !== generation) return;
    set({
      versionsLoading: false,
      versionsError: !result.ok,
      versions: result.ok ? result.data.items : [],
      versionsNext: result.ok ? result.data.next : null,
      notice: result.ok
        ? state.notice
        : result.status === 404
          ? 'Not found.'
          : 'Versions could not be loaded. Try again.',
    });
  }

  function close() {
    ++versionGeneration;
    versionAfter = undefined;
    set({
      selected: null,
      versions: [],
      versionsNext: null,
      versionsLoading: false,
      confirmVersion: null,
    });
  }

  async function navigate(query: PackageQuery, id?: string, after?: string): Promise<void> {
    const current = ++navigationGeneration;
    if (loadedQuery !== buildPackagesHash(query)) await load(query);
    if (current !== navigationGeneration) return;
    if (id) await open(id, after);
    else close();
  }

  async function refresh(notice: string | null = null): Promise<void> {
    const selected = state.selected?.id;
    const after = versionAfter;
    const current = generation;
    const navigation = navigationGeneration;
    await load(state.query, notice);
    if (generation === current + 1 && navigation === navigationGeneration && selected)
      await open(selected, after);
  }

  async function execute(versionId: string, action: Action, confirmed = false): Promise<void> {
    const item = state.selected;
    const version = state.versions.find((entry) => entry.id === versionId);
    if (
      state.busy ||
      state.loading ||
      state.versionsLoading ||
      !item ||
      !version ||
      !packageActions(item, version.status, state.access).includes(action)
    )
      return;
    if (action === 'tombstone' && !confirmed) {
      set({ confirmVersion: versionId });
      return;
    }
    const current = generation;
    const currentVersions = versionGeneration;
    const query = state.query;
    const params = { package: item.id, version: version.id };
    const project = state.access.projectSlug;
    set({ busy: true, notice: null, confirmVersion: null });
    const result = state.access.organization.includes('org:packages:manage')
      ? await client.request('post', `/_pb/packages/{package}/versions/{version}/${action}`, {
          params,
          body: {},
        })
      : await client.request(
          'post',
          `/_pb/projects/{project}/packages/{package}/versions/{version}/${action}`,
          { params: { ...params, project: project! }, body: {} },
        );
    if (current !== generation || currentVersions !== versionGeneration) return;
    set({ busy: false });
    if (!result.ok && result.code === 'reauth_required') {
      services.requireReauth(result.request, {
        credential: false,
        secretFields: [],
        display: {
          packageName: item.name,
          version: version.version,
          scope: mutationScope(state.access),
        },
      });
      return;
    }
    if (!result.ok && result.status === 404) {
      await load(query, 'Not found.');
      return;
    }
    if (!result.ok) {
      set({
        notice:
          result.status === 409
            ? 'The version changed, refresh.'
            : 'The action could not be completed. Try again.',
      });
      return;
    }
    await load(query, 'Version updated.');
    if (generation === current + 1) await open(item.id);
  }

  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async replayed(result: ReplayResult) {
      const prefix =
        state.query.project === null
          ? null
          : `/_pb/projects/${encodeURIComponent(state.query.project)}/packages/`;
      const suffix = result.path.startsWith('/_pb/packages/')
        ? result.path.slice('/_pb/packages/'.length)
        : prefix !== null && result.path.startsWith(prefix)
          ? result.path.slice(prefix.length)
          : null;
      if (
        suffix === null ||
        !/^[^/]+\/versions\/[^/]+\/(quarantine|tombstone|release)$/.test(suffix)
      )
        return;
      await refresh(
        result.ok
          ? 'Version updated.'
          : result.status === 404
            ? 'Not found.'
            : result.status === 409
              ? 'The version changed, refresh.'
              : 'The action could not be completed. Try again.',
      );
    },
    load,
    open,
    navigate,
    refresh,
    act: execute,
    close,
    cancelTombstone: () => set({ confirmVersion: null }),
    async confirmTombstone() {
      const id = state.confirmVersion;
      if (id !== null) await execute(id, 'tombstone', true);
    },
    dispose() {
      ++navigationGeneration;
      ++generation;
      ++versionGeneration;
    },
  };
}

export function PackageVersions(props: {
  item: PackageItem;
  versions: readonly VersionItem[];
  access: PackageAccess;
  busy: boolean;
  onAction: (version: string, action: Action) => void;
}) {
  return (
    <DataTable
      label={`Versions of ${props.item.name}`}
      items={props.versions}
      columns={[
        {
          key: 'version',
          label: 'Version',
          value: (version) => version.version,
          render: (version) => <span className="font-mono">{version.version}</span>,
        },
        {
          key: 'status',
          label: 'Status',
          value: (version) => version.status,
          render: (version) => <StatusBadge status={version.status} />,
        },
        {
          key: 'vulnerability',
          label: 'Known vulnerabilities',
          value: (version) => version.vulnerability.status,
          render: (version) => (
            <VulnerabilityStatus
              assessment={version.vulnerability}
              sourceType={props.item.source.type}
            />
          ),
        },
        {
          key: 'published',
          label: 'Published',
          priority: 2,
          value: (version) => version.publishedAt ?? '',
          render: (version) => <Time value={version.publishedAt} />,
        },
        {
          key: 'actions',
          label: 'Actions',
          value: () => '',
          render: (version) => (
            <div className="flex flex-wrap gap-2">
              {packageActions(props.item, version.status, props.access).map((action) => (
                <Button
                  type="button"
                  key={action}
                  size="sm"
                  variant={action === 'tombstone' ? 'ghost' : 'outline'}
                  className={action === 'tombstone' ? 'text-red-700' : undefined}
                  disabled={props.busy}
                  data-package-action={action}
                  onClick={() => props.onAction(version.id, action)}
                >
                  {ACTION_LABELS[action]}
                </Button>
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}

export function PackagesView(props: {
  state: PackagesState;
  onOpen: (id: string) => void;
  onAction: (version: string, action: Action) => void;
  onNext: () => void;
  onVersionNext: () => void;
  onRefresh: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onBack?: () => void;
}) {
  const { state } = props;
  const confirm = state.versions.find((version) => version.id === state.confirmVersion);
  const filtered = !!(
    state.query.q ||
    state.query.status ||
    state.query.source ||
    state.query.projectId ||
    state.query.after
  );
  return (
    <>
      {state.notice ? (
        <Alert className="my-4">
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}
      <div className="my-4 flex flex-wrap items-center gap-3">
        <span className="mr-auto text-neutral-600">
          {state.selected ? state.selected.name : `${state.items.length} packages on this page`}
        </span>
        <Button
          type="button"
          variant="outline"
          onClick={props.onRefresh}
          disabled={state.loading || state.busy}
        >
          Refresh
        </Button>
      </div>
      {state.selected === null ? (
        state.loading ? (
          <ListState kind="loading" title="Loading packages…" />
        ) : state.items.length ? (
          <>
            <DataTable
              label="Packages"
              items={state.items}
              columns={[
                {
                  key: 'name',
                  label: 'Name',
                  value: (item) => item.name,
                  render: (item) => (
                    <>
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto justify-start p-0 text-left"
                        disabled={state.busy}
                        onClick={() => props.onOpen(item.id)}
                      >
                        {item.name}
                      </Button>
                      <span className="block text-xs text-neutral-600">{item.ecosystem}</span>
                    </>
                  ),
                },
                {
                  key: 'status',
                  label: 'Status',
                  value: (item) => item.status,
                  render: (item) => <StatusBadge status={item.status} />,
                },
                {
                  key: 'latest',
                  label: 'Latest version',
                  value: (item) => item.latestVersion ?? '',
                  render: (item) => <span className="font-mono">{item.latestVersion ?? '—'}</span>,
                },
                {
                  key: 'source',
                  label: 'Winning source',
                  priority: 2,
                  value: (item) => item.source.name,
                  render: (item) => (
                    <>
                      {item.source.name}
                      <span className="block text-xs text-neutral-600">{item.source.type}</span>
                    </>
                  ),
                },
                {
                  key: 'count',
                  label: 'Version count',
                  priority: 2,
                  value: (item) => item.versionCount,
                },
                {
                  key: 'synced',
                  label: 'Last synced',
                  priority: 3,
                  value: (item) => item.lastSyncedAt ?? '',
                  render: (item) => <Time value={item.lastSyncedAt} fallback="Never" />,
                },
              ]}
            />
            {state.next ? (
              <Button
                type="button"
                className="my-4"
                variant="outline"
                disabled={state.busy}
                onClick={props.onNext}
              >
                Next packages
              </Button>
            ) : null}
          </>
        ) : state.listError ? (
          <ListState kind="error" title="Packages could not be loaded">
            <Button type="button" variant="outline" onClick={props.onRefresh}>
              Retry
            </Button>
          </ListState>
        ) : (
          <ListState
            kind={filtered ? 'filtered-empty' : 'empty'}
            title={filtered ? 'No packages match these filters' : 'No packages yet'}
          >
            {filtered
              ? 'Change or clear the filters to see more packages.'
              : `No packages yet. Add a package from a connected source, or attach a source to get started. ${PROXY_DEMAND_MESSAGE}`}
          </ListState>
        )
      ) : (
        <section aria-labelledby="versions-heading" className="space-y-4">
          <Button
            type="button"
            variant="link"
            className="px-0"
            onClick={props.onBack}
            disabled={state.busy}
          >
            ← Back to packages
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="versions-heading" className="text-lg font-semibold break-all">
              Versions of {state.selected.name}
            </h2>
            <StatusBadge status={state.selected.status} />
          </div>
          <IdText value={state.selected.id} label="package ID" />
          {state.versionsLoading ? (
            <ListState kind="loading" title="Loading versions…" />
          ) : state.versions.length ? (
            <>
              <PackageVersions
                item={state.selected}
                versions={state.versions}
                access={state.access}
                busy={state.busy}
                onAction={props.onAction}
              />
              {state.versionsNext ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={state.busy}
                  onClick={props.onVersionNext}
                >
                  Next versions
                </Button>
              ) : null}
            </>
          ) : (
            <ListState
              kind={state.versionsError ? 'error' : 'empty'}
              title={state.versionsError ? 'Versions could not be loaded' : 'No versions found.'}
            />
          )}
        </section>
      )}
      {state.confirmVersion !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) props.onCancel();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Tombstone {confirm?.version ?? 'version'}?</DialogTitle>
              <DialogDescription>
                This removes the version from package resolution. Clients can no longer install it.
                Only this version is affected. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <dl className="detail-list">
              <dt>Package</dt>
              <dd>{state.selected?.name}</dd>
              <dt>Version</dt>
              <dd className="font-mono">{confirm?.version}</dd>
              <dt>Scope</dt>
              <dd>{mutationScope(state.access)}</dd>
            </dl>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={props.onCancel}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={props.onConfirm}>
                Confirm tombstone
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function PackageFilters(props: { query: PackageQuery; onChange: (query: PackageQuery) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    if (props.query.project !== null) params.set('project', props.query.project);
    for (const name of ['status', 'source', 'projectId', 'q']) {
      const value = data.get(name);
      if (typeof value === 'string' && value.trim() !== '') params.set(name, value.trim());
    }
    props.onChange(parsePackagesHash(`#/packages?${params}`));
  }
  return (
    <FilterToolbar
      chips={(['q', 'status', 'source', 'projectId'] as const).flatMap((key) =>
        props.query[key]
          ? [
              {
                label: {
                  q: 'Name prefix',
                  status: 'Status',
                  source: 'Source',
                  projectId: 'Project',
                }[key],
                value: props.query[key]!,
                onRemove: () => {
                  const next = { ...props.query };
                  delete next[key];
                  delete next.after;
                  props.onChange(next);
                },
              },
            ]
          : [],
      )}
    >
      <form onSubmit={submit} className="my-4 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="package-q">Name prefix</Label>
          <Input id="package-q" name="q" maxLength={100} defaultValue={props.query.q ?? ''} />
        </div>
        <div>
          <Label htmlFor="package-status">Status</Label>
          <Select id="package-status" name="status" defaultValue={props.query.status ?? ''}>
            <option value="">All statuses</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="package-source">Source ID</Label>
          <Input
            id="package-source"
            name="source"
            pattern={ID.source}
            defaultValue={props.query.source ?? ''}
          />
        </div>
        {props.query.project === null ? (
          <div>
            <Label htmlFor="package-project">Project ID</Label>
            <Input
              id="package-project"
              name="projectId"
              pattern={ID.source}
              defaultValue={props.query.projectId ?? ''}
            />
          </div>
        ) : null}
        <Button type="submit">Apply filters</Button>
        <Button
          type="reset"
          variant="outline"
          onClick={() => props.onChange({ project: props.query.project })}
        >
          Clear filters
        </Button>
      </form>
    </FilterToolbar>
  );
}

export function PackagesPage() {
  const services = useServices();
  const controller = useMemo(() => createPackagesController(services), [services]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const [hash, setHash] = useState(() =>
    typeof window === 'undefined' ? '#/packages' : window.location.hash,
  );
  useEffect(() => {
    const change = () => setHash(window.location.hash);
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    const query = new URLSearchParams(hash.split('?')[1]);
    void controller.navigate(
      parsePackagesHash(hash),
      query.get('package') ?? undefined,
      query.get('versionAfter') ?? undefined,
    );
    return () => controller.dispose();
  }, [controller, hash]);
  useEffect(
    () =>
      services.subscribeReplay?.((result) => {
        void controller.replayed(result);
      }),
    [services, controller],
  );
  const go = (query: PackageQuery) => {
    window.location.hash = buildPackagesHash(query);
  };
  return (
    <section aria-labelledby="page-heading">
      <h1 tabIndex={-1} id="page-heading" className="text-2xl font-semibold">
        Packages
      </h1>
      {state.selected === null ? (
        <PackageSourceControls
          key={state.query.project}
          services={services}
          project={state.query.project}
        />
      ) : null}
      {state.selected === null ? (
        <PackageFilters key={hash} query={parsePackagesHash(hash)} onChange={go} />
      ) : null}
      <PackagesView
        state={state}
        onOpen={(id) => {
          const query = new URLSearchParams(buildPackagesHash(state.query).split('?')[1]);
          query.set('package', id);
          window.location.hash = `#/packages?${query}`;
        }}
        onBack={() => go(state.query)}
        onAction={(id, action) => void controller.act(id, action)}
        onNext={() => {
          if (state.next !== null) go({ ...state.query, after: state.next });
        }}
        onVersionNext={() => {
          if (state.selected && state.versionsNext) {
            const query = new URLSearchParams(hash.split('?')[1]);
            query.set('versionAfter', state.versionsNext);
            window.location.hash = `#/packages?${query}`;
          }
        }}
        onRefresh={() => void controller.refresh()}
        onConfirm={() => void controller.confirmTombstone()}
        onCancel={controller.cancelTombstone}
      />
    </section>
  );
}
