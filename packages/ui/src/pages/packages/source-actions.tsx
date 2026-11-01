import { buildListFilterHash } from '../../page-hash.js';
import { mirrorOutcome, sourceSyncResponse, SYNC_REQUESTED } from '../sources/sync-copy.js';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ShellServices } from '../../auth.js';
import type { Source } from '../sources.js';
import { SOURCE_TYPE_LABELS } from '../sources/source-form.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../components/ui/dialog.js';

export function sourceHealth(source: Source) {
  if (source.status === 'paused') return 'Paused · Enable this source to sync.';
  if (source.lastError) return 'Last check failed';
  return source.lastSuccessAt ? 'Last check succeeded' : 'Not checked yet';
}
export function mirrorSource(source: Source) {
  return (
    ['packagist_proxy', 'npmjs_proxy', 'npm_registry'].includes(source.type) &&
    'attached' in source &&
    source.attached
  );
}
export function canSync(
  source: Source,
  organization: readonly string[],
  project: readonly string[],
  projectId: string | null,
) {
  return source.projectId === null
    ? organization.includes('org:sources:write')
    : source.projectId === projectId && project.includes('project:sources:write');
}
export function syncScope(source: Source) {
  if (['packagist_proxy', 'npmjs_proxy', 'npm_registry'].includes(source.type))
    return 'Checks packages already held from this source when their metadata is due for refresh. This does not download the whole registry.';
  return source.type === 'vcs'
    ? 'Syncs the Composer package from this configured Git repository.'
    : "Syncs packages selected in this source's settings.";
}
type Project = { id: string; name: string; slug: string };
export function createSourceActions(services: ShellServices, scope: string | null) {
  const { client } = services;
  let state = {
    loading: true,
    busy: false,
    organization: [] as string[],
    permissions: [] as string[],
    projects: [] as Project[],
    project: null as Project | null,
    sources: [] as Source[],
    error: null as string | null,
    notice: null as string | null,
    requested: [] as string[],
    available: null as { name: string; source: string } | null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  let generation = 0;
  async function selectProject(slug: string | null) {
    const current = ++generation;
    set({
      loading: true,
      busy: false,
      project: null,
      permissions: [],
      sources: [],
      error: null,
      notice: null,
      available: null,
    });
    if (slug === null) {
      const sources: Source[] = [];
      let after: string | undefined;
      do {
        const result = await client.request('get', '/_pb/sources', {
          query: { ownership: 'organization', limit: '100', ...(after ? { after } : {}) },
        });
        if (current !== generation) return;
        if (!result.ok) {
          set({ loading: false, error: 'Sources could not be loaded. Try again.' });
          return;
        }
        sources.push(...result.data.items);
        after = result.data.next ?? undefined;
      } while (after);
      set({ loading: false, sources });
      return;
    }
    const [project, permissions] = await Promise.all([
      client.request('get', '/_pb/projects/{project}', { params: { project: slug } }),
      client.request('get', '/_pb/projects/{project}/permissions', { params: { project: slug } }),
    ]);
    if (current !== generation) return;
    if (!project.ok || project.data.status !== 'active' || !permissions.ok) {
      set({
        loading: false,
        error: 'Project access could not be loaded. Choose an active project.',
      });
      return;
    }
    const sources: Source[] = [];
    let after: string | undefined;
    do {
      const result = await client.request('get', '/_pb/projects/{project}/sources', {
        params: { project: slug },
        query: { limit: '100', ...(after ? { after } : {}) },
      });
      if (current !== generation) return;
      if (!result.ok) {
        set({ loading: false, error: 'Sources could not be loaded. Try again.' });
        return;
      }
      sources.push(...result.data.items.filter((source) => source.attached));
      after = result.data.next ?? undefined;
    } while (after);
    set({ loading: false, project: project.data, permissions: permissions.data.project, sources });
  }
  return {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    selectProject,
    clearFeedback() {
      set({ notice: null, error: null, available: null });
    },
    async load() {
      const permissions = await client.request('get', '/_pb/me/permissions');
      set({ organization: permissions.ok ? permissions.data.organization : [] });
      if (scope === null) {
        const projects: Project[] = [];
        let after: string | undefined;
        do {
          const result = await client.request('get', '/_pb/projects', {
            query: { status: 'active', limit: '100', ...(after ? { after } : {}) },
          });
          if (!result.ok) break;
          const allowed = await Promise.all(
            result.data.items
              .filter((p) => p.status === 'active')
              .map(async (p) => {
                const access = await client.request('get', '/_pb/projects/{project}/permissions', {
                  params: { project: p.slug },
                });
                return access.ok && access.data.project.includes('project:sources:write')
                  ? p
                  : null;
              }),
          );
          projects.push(...allowed.filter((p) => p !== null));
          after = result.data.next ?? undefined;
        } while (after);
        set({ projects });
      }
      await selectProject(scope);
    },
    async submit(mode: 'mirror' | 'sync', sourceId: string, name: string) {
      const source = state.sources.find((s) => s.id === sourceId);
      if (!source || state.busy || state.loading || source.status === 'paused') return;
      if (
        mode === 'mirror' &&
        (!state.project ||
          !state.permissions.includes('project:sources:write') ||
          !mirrorSource(source))
      )
        return;
      if (
        mode === 'sync' &&
        (!canSync(source, state.organization, state.permissions, state.project?.id ?? null) ||
          state.requested.includes(source.id))
      )
        return;
      name = name.trim();
      if (mode === 'mirror' && (!name || name.length > 428)) {
        set({ error: 'Enter a package name of 1 to 428 characters.' });
        return;
      }
      const current = generation;
      set({ busy: true, error: null, notice: null, available: null });
      const response =
        mode === 'mirror'
          ? await client.request('post', '/_pb/projects/{project}/sources/{source}/packages', {
              params: { project: state.project!.slug, source: source.id },
              body: { name },
            })
          : source.projectId === null
            ? await client.request('post', '/_pb/sources/{source}/sync', {
                params: { source: source.id },
              })
            : await client.request('post', '/_pb/projects/{project}/sources/{source}/sync', {
                params: { project: state.project!.slug, source: source.id },
              });
      if (current !== generation) return;
      const result = mode === 'sync' ? sourceSyncResponse(response) : response;
      if (result.ok)
        set({
          busy: false,
          notice:
            mode === 'mirror' ? mirrorOutcome(result.status, name, source.name) : SYNC_REQUESTED,
          available:
            mode === 'mirror' && result.status === 200 ? { name, source: source.id } : null,
          requested: mode === 'sync' ? [...state.requested, source.id] : state.requested,
        });
      else
        set({
          busy: false,
          error:
            result.status === 403
              ? 'You no longer have permission to sync this source. Your selection has been kept.'
              : result.code === 'source_paused'
                ? 'This source is paused. Enable it before syncing.'
                : result.code === 'package_not_found'
                  ? `No packages match ‘${name}’ in ${source.name}. Check the name or choose another source.`
                  : result.status === 400
                    ? 'Enter a valid package name for this source.'
                    : "Sync couldn't be queued. Try again shortly.",
        });
    },
  };
}

export function AddChoices({
  ecosystem,
  mirror,
  setup,
  imported,
  onMirror,
  sourceLink,
}: {
  ecosystem: string;
  mirror: boolean;
  setup: boolean;
  imported: boolean;
  onMirror: () => void;
  sourceLink: string;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded border p-4">
        <h3 className="font-semibold">From a mirror</h3>
        <p>
          {ecosystem === 'npm'
            ? 'Find packages in a connected npm registry.'
            : 'Find packages in Packagist or another connected Composer repository.'}
        </p>
        {mirror ? (
          <Button className="mt-2 min-h-11" onClick={onMirror}>
            From a mirror
          </Button>
        ) : (
          <p>A project source manager can add packages from a mirror.</p>
        )}
      </div>
      {ecosystem === 'composer' ? (
        <>
          <div className="rounded border p-4">
            <h3 className="font-semibold">From a connected GitHub organization</h3>
            <p>Choose repositories your GitHub connection can access.</p>
            <p>Organization picker · Coming soon</p>
            {setup ? (
              <a
                className="inline-flex min-h-11 items-center underline"
                href={`${sourceLink}&provider=github`}
              >
                Set up a GitHub repository source
              </a>
            ) : (
              <p>Ask an organization source manager to connect GitHub.</p>
            )}
          </div>
          <div className="rounded border p-4">
            <h3 className="font-semibold">By repository URL</h3>
            <p>Add a Composer package from a Git repository.</p>
            {setup ? (
              <a className="inline-flex min-h-11 items-center underline" href={sourceLink}>
                By repository URL
              </a>
            ) : (
              <p>A source manager can add a Git repository.</p>
            )}
          </div>
        </>
      ) : null}
      <div className="rounded border p-4">
        <h3 className="font-semibold">Import configuration</h3>
        <p>Bring source and package selections from a Satis configuration using the CLI.</p>
        <code className="break-all">pb import satis plan</code>
        {imported ? (
          <a href="#/import" className="flex min-h-11 items-center underline">
            Import review
          </a>
        ) : (
          <p>An organization import manager can review imports.</p>
        )}
      </div>
      <div className="lg:col-span-2">
        <h3 className="font-semibold">Upload a private package</h3>
        <p>Publish a package archive for this project.</p>
        <p>Coming soon · Upload and publishing belong to #947.</p>
      </div>
    </div>
  );
}

export function PackageSourceControls({
  services,
  project,
  onSourcesChanged,
}: {
  services: ShellServices;
  project: string | null;
  onSourcesChanged?: (scope: string | null, signature: string) => void;
}) {
  const model = useMemo(() => createSourceActions(services, project), [services, project]);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const sourceSignature = state.loading
    ? null
    : JSON.stringify(state.sources.map((source) => [source.id, source.name]));
  useEffect(() => {
    if (sourceSignature !== null)
      onSourcesChanged?.(state.project?.slug ?? project, sourceSignature);
  }, [sourceSignature, onSourcesChanged, state.project?.slug, project]);
  const [mode, setMode] = useState<'choices' | 'mirror' | 'sync' | null>(null);
  const [ecosystem, setEcosystem] = useState('composer');
  const [sourceId, setSource] = useState('');
  const [sourceError, setSourceError] = useState(false);
  const [name, setName] = useState('');
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void model.load();
  }, [model]);
  useEffect(() => {
    if (state.notice || state.error) result.current?.focus();
  }, [state.notice, state.error]);
  const source = state.sources.find((s) => s.id === sourceId);
  const manager = state.permissions.includes('project:sources:write');
  const orgManager = state.organization.includes('org:sources:write');
  const setup = project === null ? orgManager : manager;
  const sources = state.sources.filter(
    (s) => mode !== 'mirror' || (s.ecosystem === ecosystem && mirrorSource(s)),
  );
  const authorized =
    source &&
    (mode === 'mirror'
      ? manager && !!state.project
      : canSync(source, state.organization, state.permissions, state.project?.id ?? null));
  const link = `#/sources?create=vcs${project ? `&project=${encodeURIComponent(project)}` : ''}`;
  function open(next: 'choices' | 'sync') {
    setSource('');
    setSourceError(false);
    setName('');
    model.clearFeedback();
    setMode(next);
  }
  return (
    <>
      <p className="my-3 text-neutral-600">
        {project
          ? `Packages available to ${state.project?.name ?? project}.`
          : 'Packages available across your organization.'}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button className="min-h-11" onClick={() => open('choices')}>
          Add package
        </Button>
        <Button className="min-h-11" variant="outline" onClick={() => open('sync')}>
          Sync from source
        </Button>
      </div>
      {mode ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setMode(null);
          }}
        >
          <DialogContent variant="source" className="lg:max-w-5xl">
            <DialogHeader className="shrink-0 p-6 pr-16">
              <DialogTitle>{mode === 'sync' ? 'Sync from source' : 'Add package'}</DialogTitle>
              <DialogDescription>
                {mode === 'sync'
                  ? 'Check a source for package updates.'
                  : state.project
                    ? `Add packages to ${state.project.name}.`
                    : 'Choose how to add packages to a project.'}
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto px-6 pb-6">
              {state.loading ? <p role="status">Loading sources…</p> : null}
              {mode === 'choices' ? (
                <>
                  <Label htmlFor="choice-ecosystem">Ecosystem</Label>
                  <Select
                    className="mb-4 min-h-11"
                    id="choice-ecosystem"
                    value={ecosystem}
                    onChange={(e) => setEcosystem(e.target.value)}
                  >
                    <option value="composer">Composer</option>
                    <option value="npm">npm</option>
                  </Select>
                  <AddChoices
                    ecosystem={ecosystem}
                    mirror={project === null ? state.projects.length > 0 : manager}
                    setup={setup}
                    imported={state.organization.includes('org:import:write')}
                    sourceLink={link}
                    onMirror={() => setMode('mirror')}
                  />
                </>
              ) : (
                <form
                  id="source-action-form"
                  className="grid gap-4 lg:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (source) void model.submit(mode, source.id, name);
                  }}
                >
                  {project === null ? (
                    <div>
                      <Label htmlFor="destination-project">Project</Label>
                      <Select
                        id="destination-project"
                        className="min-h-11"
                        disabled={state.busy}
                        value={state.project?.slug ?? ''}
                        onChange={(e) => {
                          setSource('');
                          setSourceError(false);
                          void model.selectProject(e.target.value || null);
                        }}
                      >
                        <option value="">
                          {mode === 'sync' ? 'Organization sources' : 'Choose a project'}
                        </option>
                        {state.projects.map((p) => (
                          <option key={p.id} value={p.slug}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ) : null}
                  {mode === 'mirror' ? (
                    <div>
                      <Label htmlFor="mirror-ecosystem">Ecosystem</Label>
                      <Select
                        id="mirror-ecosystem"
                        className="min-h-11"
                        value={ecosystem}
                        disabled={state.busy}
                        onChange={(e) => {
                          setEcosystem(e.target.value);
                          setSource('');
                          setSourceError(false);
                        }}
                      >
                        <option value="composer">Composer</option>
                        <option value="npm">npm</option>
                      </Select>
                    </div>
                  ) : null}
                  <div>
                    <Label htmlFor="package-source">Source</Label>
                    <Select
                      id="package-source"
                      className="min-h-11"
                      required
                      aria-invalid={sourceError || undefined}
                      aria-describedby={sourceError ? 'package-source-error' : undefined}
                      onInvalid={() => setSourceError(true)}
                      disabled={state.loading || state.busy}
                      value={sourceId}
                      onChange={(e) => {
                        setSource(e.target.value);
                        setSourceError(false);
                        model.clearFeedback();
                      }}
                    >
                      <option value="">Choose a source</option>
                      {sources.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {SOURCE_TYPE_LABELS[s.type]} · {sourceHealth(s)}
                        </option>
                      ))}
                    </Select>
                    {sourceError ? (
                      <p id="package-source-error" role="alert">
                        Choose a source.
                      </p>
                    ) : null}
                  </div>
                  {mode === 'mirror' ? (
                    <div>
                      <Label htmlFor="mirror-package">Find a package</Label>
                      <Input
                        id="mirror-package"
                        className="min-h-11"
                        required
                        maxLength={428}
                        disabled={state.busy}
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          model.clearFeedback();
                        }}
                        aria-describedby="mirror-help"
                      />
                      <p id="mirror-help">
                        This source does not support search. Enter the full package name.
                      </p>
                    </div>
                  ) : null}
                  <div className="space-y-3 lg:col-span-2">
                    {!sources.length && !state.loading ? (
                      <p>
                        {state.project
                          ? `No sources available for ${state.project.name}. Attach a source before adding packages.`
                          : mode === 'mirror'
                            ? 'Choose a destination project before adding packages.'
                            : 'No sources available.'}
                      </p>
                    ) : null}
                    {!sources.length && setup && !state.loading ? (
                      <a
                        className="inline-flex min-h-11 items-center underline"
                        href={`#/sources${state.project ? `?project=${encodeURIComponent(state.project.slug)}` : ''}`}
                      >
                        Manage sources
                      </a>
                    ) : null}
                    {source ? (
                      <>
                        <p>
                          {source.projectId === null
                            ? 'Shared organization source'
                            : `Only ${state.project?.name ?? project}`}
                        </p>
                        <p>{sourceHealth(source)}</p>
                        {source.status === 'paused' ? (
                          <p>This source is paused. Enable it before syncing.</p>
                        ) : null}
                        {mode === 'sync' && state.requested.includes(source.id) && !state.notice ? (
                          <p role="status">{SYNC_REQUESTED}</p>
                        ) : null}
                        {mode === 'sync' ? (
                          <>
                            <h3 className="font-semibold">
                              {mirrorSource(source) ||
                              ['packagist_proxy', 'npmjs_proxy'].includes(source.type)
                                ? 'Check cached packages for updates'
                                : 'All configured packages'}
                            </h3>
                            <p>{syncScope(source)}</p>
                            {source.type === 'composer_repository' &&
                            source.config &&
                            'selection' in source.config ? (
                              <p className="break-words">
                                Configured selection:{' '}
                                {[
                                  ...(source.config.selection?.packages ?? []),
                                  ...(source.config.selection?.patterns ?? []),
                                ].join(', ') || 'No packages selected.'}
                              </p>
                            ) : null}
                            {source.projectId === null ? (
                              <p>
                                This source is shared. Updated metadata can be used by other
                                attached projects.
                              </p>
                            ) : null}
                            {!authorized ? (
                              <p>
                                {source.projectId === null
                                  ? 'An organization source manager can sync this source.'
                                  : 'A project source manager can sync this source.'}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <p>
                              Checks this source and queues the package if it is not already
                              available.
                            </p>
                            <p>
                              This syncs the selected packages. Dependencies are fetched through
                              your project's sources when requested.
                            </p>
                          </>
                        )}
                      </>
                    ) : null}
                  </div>
                </form>
              )}
              {state.notice || state.error ? (
                <div
                  ref={result}
                  tabIndex={-1}
                  className="mt-4 break-words"
                  role={state.error ? 'alert' : 'status'}
                  aria-live="polite"
                >
                  <h3 className="font-semibold">
                    {state.error ? 'Request could not be completed' : 'Request outcome'}
                  </h3>
                  <p>{state.error ?? state.notice}</p>
                  {state.available ? (
                    <a
                      className="inline-flex min-h-11 items-center underline"
                      href={buildListFilterHash('packages', {
                        project: state.project?.slug ?? null,
                        q: state.available.name,
                        source: state.available.source,
                      })}
                    >
                      View
                    </a>
                  ) : null}
                  {state.notice ? (
                    <a
                      className="inline-flex min-h-11 items-center underline"
                      href={`#/sources${state.project ? `?project=${encodeURIComponent(state.project.slug)}` : ''}`}
                    >
                      View sources
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
            <DialogFooter className="shrink-0 border-t bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {mode !== 'choices' && authorized && source?.status !== 'paused' ? (
                <Button
                  className="min-h-11"
                  form="source-action-form"
                  type="submit"
                  disabled={
                    state.busy ||
                    state.loading ||
                    !!state.notice ||
                    (mode === 'sync' && state.requested.includes(source.id))
                  }
                >
                  {state.busy
                    ? 'Requesting…'
                    : mode === 'mirror'
                      ? 'Add package'
                      : 'Request source sync'}
                </Button>
              ) : null}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
