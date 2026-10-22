import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { operations } from '../api-types.js';
import { useServices, type ShellServices, type ReplayResult } from '../auth.js';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';

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
const SLUG = /^[A-Za-z0-9._-]{1,64}$/;
const ACTION_LABELS: Record<Action, string> = {
  quarantine: 'Quarantine',
  tombstone: 'Tombstone',
  release: 'Release',
};
const statusLabel = (status: string) =>
  status === 'removed_upstream' ? 'Removed upstream' : status;

export interface PackageQuery {
  project: string | null;
  projectId?: string;
  status?: PackageStatus;
  source?: string;
  q?: string;
  after?: string;
}

export function parsePackagesHash(hash: string): PackageQuery {
  const params = new URLSearchParams(hash.split('?').slice(1).join('?'));
  const project = params.get('project');
  const state: PackageQuery = { project: project !== null && SLUG.test(project) ? project : null };
  const status = params.get('status');
  if (STATUSES.includes(status as PackageStatus)) state.status = status as PackageStatus;
  const source = params.get('source');
  if (source !== null && ID.test(source)) state.source = source;
  const projectId = params.get('projectId');
  if (state.project === null && projectId !== null && ID.test(projectId))
    state.projectId = projectId;
  const q = params.get('q')?.trim().toLowerCase();
  if (q && q.length <= 100 && !q.includes('\0')) state.q = q;
  const after = params.get('after');
  if (after !== null) state.after = after;
  return state;
}

export function buildPackagesHash(state: PackageQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state))
    if (value !== null && value !== undefined) params.set(key, value);
  const query = params.toString();
  return `#/packages${query ? `?${query}` : ''}`;
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
  const client = services.client;

  async function load(query: PackageQuery, notice: string | null = null): Promise<void> {
    const current = ++generation;
    ++versionGeneration;
    set({
      query,
      items: [],
      next: null,
      selected: null,
      versions: [],
      versionsNext: null,
      confirmVersion: null,
      loading: true,
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
    set({
      loading: false,
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
    set({
      selected,
      versions: [],
      versionsNext: null,
      versionsLoading: true,
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
      versions: result.ok ? result.data.items : [],
      versionsNext: result.ok ? result.data.next : null,
      notice: result.ok
        ? state.notice
        : result.status === 404
          ? 'Not found.'
          : 'Versions could not be loaded. Try again.',
    });
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
      services.requireReauth(result.request, { credential: false, secretFields: [] });
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
      await load(
        state.query,
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
    act: execute,
    cancelTombstone: () => set({ confirmVersion: null }),
    async confirmTombstone() {
      const id = state.confirmVersion;
      if (id !== null) await execute(id, 'tombstone', true);
    },
    dispose() {
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
    <Table>
      <TableHeader>
        <TableRow>
          {['Version', 'Status', 'Published', 'Actions'].map((label) => (
            <TableHead key={label}>{label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.versions.map((version) => (
          <TableRow key={version.id}>
            <TableCell>{version.version}</TableCell>
            <TableCell>{statusLabel(version.status)}</TableCell>
            <TableCell>{version.publishedAt}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-2">
                {packageActions(props.item, version.status, props.access).map((action) => (
                  <Button
                    key={action}
                    variant={action === 'tombstone' ? 'destructive' : 'outline'}
                    disabled={props.busy}
                    data-package-action={action}
                    onClick={() => props.onAction(version.id, action)}
                  >
                    {ACTION_LABELS[action]}
                  </Button>
                ))}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
}) {
  const { state } = props;
  return (
    <>
      {state.notice === null ? null : (
        <Alert className="my-4">
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      )}
      <Button
        variant="outline"
        className="my-4"
        onClick={props.onRefresh}
        disabled={state.loading || state.busy}
      >
        Refresh
      </Button>
      {state.loading ? (
        <p role="status">Loading packages…</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  'Name',
                  'Ecosystem',
                  'Latest version',
                  'Winning source',
                  'Status',
                  'Version count',
                  'Last synced',
                ].map((label) => (
                  <TableHead key={label}>{label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Button
                      variant="link"
                      disabled={state.busy}
                      onClick={() => props.onOpen(item.id)}
                      aria-expanded={state.selected?.id === item.id}
                    >
                      {item.name}
                    </Button>
                  </TableCell>
                  <TableCell>{item.ecosystem}</TableCell>
                  <TableCell>{item.latestVersion ?? '—'}</TableCell>
                  <TableCell>
                    {item.source.name}
                    <span className="block text-xs text-neutral-600">{item.source.type}</span>
                  </TableCell>
                  <TableCell>{statusLabel(item.status)}</TableCell>
                  <TableCell>{item.versionCount}</TableCell>
                  <TableCell>{item.lastSyncedAt ?? 'Never'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {state.items.length === 0 ? <p>No packages found.</p> : null}
          {state.next === null ? null : (
            <Button className="my-4" variant="outline" disabled={state.busy} onClick={props.onNext}>
              Next packages
            </Button>
          )}
        </>
      )}
      {state.selected === null ? null : (
        <section className="mt-6" aria-labelledby="versions-heading">
          <h2 id="versions-heading" className="text-lg font-semibold">
            Versions of {state.selected.name}
          </h2>
          {state.versionsLoading ? (
            <p role="status">Loading versions…</p>
          ) : (
            <>
              <PackageVersions
                item={state.selected}
                versions={state.versions}
                access={state.access}
                busy={state.busy}
                onAction={props.onAction}
              />
              {state.versions.length === 0 ? <p>No versions found.</p> : null}
              {state.versionsNext === null ? null : (
                <Button variant="outline" disabled={state.busy} onClick={props.onVersionNext}>
                  Next versions
                </Button>
              )}
            </>
          )}
        </section>
      )}
      {state.confirmVersion === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) props.onCancel();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Tombstone version?</DialogTitle>
              <DialogDescription>
                This removes the version from package resolution.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={props.onCancel}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={props.onConfirm}>
                Confirm tombstone
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
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
    void controller.load(parsePackagesHash(hash));
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
      <h1 id="page-heading" className="text-xl font-semibold">
        Packages
      </h1>
      <PackageFilters key={hash} query={parsePackagesHash(hash)} onChange={go} />
      <PackagesView
        state={state}
        onOpen={(id) => void controller.open(id)}
        onAction={(id, action) => void controller.act(id, action)}
        onNext={() => {
          if (state.next !== null) go({ ...state.query, after: state.next });
        }}
        onVersionNext={() => {
          if (state.selected && state.versionsNext)
            void controller.open(state.selected.id, state.versionsNext);
        }}
        onRefresh={() => void controller.load(state.query)}
        onConfirm={() => void controller.confirmTombstone()}
        onCancel={controller.cancelTombstone}
      />
    </section>
  );
}
