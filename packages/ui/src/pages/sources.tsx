import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { responseHeader, type ApiResult } from '../api.js';
import type { operations } from '../api-types.js';
import { useServices, type ReplayResult, type ShellServices } from '../auth.js';
import { StatusBadge } from '../components/ui/status-badge.js';
import { IdText } from '../components/ui/id-text.js';
import { Time } from '../components/ui/time.js';
import { Badge } from '../components/ui/badge.js';
import { LoadedListFilters } from '../components/ui/toolbar.js';
import { ListState } from '../components/ui/list-state.js';
import { ConfirmAction } from '../components/ui/confirm-action.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import { DataTable } from '../components/ui/table.js';
import { buildListFilterHash } from '../page-hash.js';

type ResponseBody<K extends keyof operations> = operations[K] extends {
  responses: { 200: { content: { 'application/json': infer T } } };
}
  ? T
  : never;
type SourcePage = ResponseBody<'listOrganizationSources'> | ResponseBody<'listProjectSources'>;
export type Source = SourcePage['items'][number];
type Names = ResponseBody<'listRegisteredNames'>;
type Preview = ResponseBody<'resolveName'>;
type CredentialKind =
  operations['writeOrganizationSourceCredential']['requestBody']['content']['application/json']['kind'];
const CREDENTIAL_FIELDS = {
  http_basic: ['username', 'password'],
  bearer: ['token'],
  header: ['name', 'value'],
  query: ['param', 'value'],
  github_app: ['appId', 'privateKeyPem', 'webhookSecret'],
  npm_token: ['token'],
  ssh_key: ['privateKeyPem', 'knownHosts'],
} as const satisfies Record<CredentialKind, readonly string[]>;
const CREDENTIAL_KINDS = Object.keys(CREDENTIAL_FIELDS) as CredentialKind[];

function canTogglePause(project: string | null, source: Source) {
  return (
    project === null ||
    source.status !== 'paused' ||
    ['packagist_proxy', 'npmjs_proxy'].includes(source.type)
  );
}

interface SourcesState {
  items: Source[];
  next: string | null;
  loading: boolean;
  listError: boolean;
  settingsVersion: number;
  busy: boolean;
  error: string | null;
  credentialSource: string | null;
  credentialVersion: number;
  savedCredential: { source: string; at: string } | null;
  names: (Names & { source: string }) | null;
  preview: Preview | null;
  order: string[];
  etag: string | null;
}

function displayUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function createSourcesModel(
  services: ShellServices,
  project: string | null,
  now = () => new Date().toISOString(),
) {
  const { client } = services;
  let state: SourcesState = {
    items: [],
    next: null,
    loading: true,
    listError: false,
    settingsVersion: 0,
    busy: false,
    error: null,
    credentialSource: null,
    credentialVersion: 0,
    savedCredential: null,
    names: null,
    preview: null,
    order: [],
    etag: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SourcesState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  let listVersion = 0;
  let namesVersion = 0;
  let previewVersion = 0;

  function failure(result: ApiResult<unknown>, credential = false): boolean {
    if (result.ok) return false;
    if (result.code === 'reauth_required') {
      services.requireReauth(
        credential ? { method: result.request.method, path: result.request.path } : result.request,
        { credential, secretFields: [] },
      );
      set({
        error: credential
          ? 'Reauthenticate, then enter the credential again.'
          : 'Reauthentication is required.',
      });
    } else {
      set({ error: 'The request could not be saved or loaded. Refresh and try again.' });
    }
    return true;
  }

  async function load(more = false) {
    if (more && (state.loading || state.next === null)) return;
    const version = ++listVersion;
    const after = more ? state.next : null;
    const previousEtag = state.etag;
    ++previewVersion;
    set({ loading: true, listError: false, error: null, etag: null, preview: null, order: [] });
    const query = { limit: '100', ...(after === null ? {} : { after }) };
    const result: ApiResult<SourcePage> =
      project === null
        ? await client.request('get', '/_pb/sources', { query })
        : await client.request('get', '/_pb/projects/{project}/sources', {
            params: { project },
            query,
          });
    if (version !== listVersion) return;
    if (failure(result) || !result.ok) {
      set({ loading: false, listError: true });
      return;
    }
    const etag = responseHeader(result, 'etag') ?? null;
    if (project !== null && more && etag !== previousEtag) {
      await load();
      return;
    }
    const page = result.data.items.map((item) => ({ ...item, url: displayUrl(item.url) }));
    const items = more ? [...state.items, ...page] : page;
    const attached = items.flatMap((item) =>
      'attached' in item &&
      item.attached === true &&
      'precedence' in item &&
      typeof item.precedence === 'number'
        ? [{ id: item.id, precedence: item.precedence }]
        : [],
    );
    set({
      items,
      settingsVersion: state.settingsVersion + 1,
      next: result.data.next,
      loading: false,
      etag,
      order: attached.sort((a, b) => a.precedence - b.precedence).map(({ id }) => id),
    });
  }

  async function names(source: string, more = false) {
    const previous = state.names;
    if (more && (previous?.source !== source || previous.next === null)) return;
    const version = ++namesVersion;
    const after = more ? previous?.next : null;
    const result = await client.request('get', '/_pb/sources/{source}/names', {
      params: { source },
      query: { limit: '100', ...(after == null ? {} : { after }) },
    });
    if (version !== namesVersion || failure(result) || !result.ok) return;
    set({
      names: {
        ...result.data,
        source,
        items: more ? [...previous!.items, ...result.data.items] : result.data.items,
      },
    });
  }

  async function mutate(request: () => Promise<ApiResult<unknown>>, after: () => Promise<void>) {
    if (state.busy) return;
    set({ busy: true, error: null });
    try {
      const result = await request();
      if (!failure(result)) await after();
    } finally {
      set({ busy: false });
    }
  }

  return {
    project,
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    names,
    async replayed(result: ReplayResult) {
      const prefix =
        project === null ? '/_pb/sources' : `/_pb/projects/${encodeURIComponent(project)}/sources`;
      const namesChange = /^\/_pb\/sources\/[^/]+\/names(?:\/[^/]+)?$/.test(result.path);
      if (result.path !== prefix && !result.path.startsWith(`${prefix}/`) && !namesChange) return;
      const selectedNames = state.names?.source;
      await load();
      if (selectedNames !== undefined) await names(selectedNames);
    },
    moveSource(source: string, direction: -1 | 1) {
      if (state.loading || state.busy || state.next !== null) return;
      const order = [...state.order];
      const index = order.indexOf(source);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return;
      [order[index], order[target]] = [order[target]!, order[index]!];
      set({ order });
    },
    async saveOrder() {
      if (
        project === null ||
        state.loading ||
        state.busy ||
        state.next !== null ||
        state.etag === null
      )
        return;
      const etag = state.etag;
      const sourceIds = [...state.order];
      set({ busy: true, error: null, preview: null });
      ++previewVersion;
      try {
        const result = await client.request('put', '/_pb/projects/{project}/sources/order', {
          params: { project },
          headers: { 'If-Match': etag },
          body: { sourceIds },
        });
        if (!result.ok && result.status === 412) {
          await load();
          set({ error: 'Source ordering changed. Review the reloaded list before saving again.' });
        } else if (!failure(result)) {
          await load();
        }
      } finally {
        set({ busy: false });
      }
    },
    chooseCredential(source: string) {
      set({
        credentialSource: source,
        credentialVersion: state.credentialVersion + 1,
        error: null,
      });
    },
    async credential(source: string, kind: CredentialKind, material: string) {
      if (state.busy) return;
      set({
        busy: true,
        error: null,
        credentialSource: source,
        credentialVersion: state.credentialVersion + 1,
        savedCredential: null,
      });
      try {
        const result =
          project === null
            ? await client.request('put', '/_pb/sources/{source}/credential', {
                params: { source },
                body: { kind, material },
              })
            : await client.request('put', '/_pb/projects/{project}/sources/{source}/credential', {
                params: { project, source },
                body: { kind, material },
              });
        if (!failure(result, true)) {
          set({
            savedCredential: { source, at: now() },
            items: state.items.map((item) =>
              item.id === source ? { ...item, hasCredential: true } : item,
            ),
          });
        }
      } finally {
        set({ busy: false });
      }
    },
    edit(source: string, pollIntervalSeconds: number, removalPolicy: Source['removalPolicy']) {
      if (!Number.isSafeInteger(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
        set({ error: 'Polling interval must be a positive whole number.' });
        return Promise.resolve();
      }
      const body = { pollIntervalSeconds, removalPolicy };
      return mutate(
        () =>
          project === null
            ? client.request('patch', '/_pb/sources/{source}', { params: { source }, body })
            : client.request('patch', '/_pb/projects/{project}/sources/{source}', {
                params: { project, source },
                body,
              }),
        () => load(),
      );
    },
    togglePause(source: Source) {
      if (!canTogglePause(project, source)) return Promise.resolve();
      if (source.status === 'paused' && !['packagist_proxy', 'npmjs_proxy'].includes(source.type)) {
        return mutate(
          () =>
            client.request('post', '/_pb/sources/{source}/enable', {
              params: { source: source.id },
            }),
          () => load(),
        );
      }
      const action = source.status === 'paused' ? 'resume' : 'pause';
      return mutate(
        () =>
          project === null
            ? client.request('post', `/_pb/sources/{source}/${action}`, {
                params: { source: source.id },
              })
            : client.request('post', `/_pb/projects/{project}/sources/{source}/${action}`, {
                params: { project, source: source.id },
              }),
        () => load(),
      );
    },
    addName(source: string, pattern: string) {
      if (pattern.length === 0 || pattern.length > 50 || !/^[a-z0-9._~@!/*-]+$/.test(pattern)) {
        set({ error: 'Enter a registered pattern of 1 to 50 supported characters.' });
        return Promise.resolve();
      }
      return mutate(
        () =>
          client.request('post', '/_pb/sources/{source}/names', {
            params: { source },
            body: { pattern },
          }),
        () => names(source),
      );
    },
    removeName(source: string, name: string) {
      return mutate(
        () =>
          client.request('delete', '/_pb/sources/{source}/names/{name}', {
            params: { source, name },
          }),
        async () => {
          await names(source);
          await load();
        },
      );
    },
    async resolve(name: string) {
      const version = ++previewVersion;
      set({ preview: null, error: null });
      if (project === null || name.length === 0 || name.length > 214) {
        set({ error: 'Choose a project and enter a package name of 1 to 214 characters.' });
        return;
      }
      const result = await client.request('get', '/_pb/projects/{project}/resolve', {
        params: { project },
        query: { name },
      });
      if (version === previewVersion && !failure(result) && result.ok)
        set({ preview: result.data });
    },
  };
}

type SourcesModel = ReturnType<typeof createSourcesModel>;
type CredentialForm = {
  elements: { namedItem(name: string): { value: string } | null };
  reset(): void;
};

export function submitCredential(model: SourcesModel, source: string, form: CredentialForm) {
  const kind = form.elements.namedItem('kind')?.value as CredentialKind;
  const fields = CREDENTIAL_KINDS.includes(kind) ? CREDENTIAL_FIELDS[kind] : null;
  const material =
    fields === null
      ? null
      : JSON.stringify(
          Object.fromEntries(
            fields.map((field) => [field, form.elements.namedItem(field)?.value ?? '']),
          ),
        );
  form.reset();
  if (material === null) return Promise.resolve();
  return model.credential(source, kind, material);
}

export function CredentialFields({ kind, busy }: { kind: CredentialKind; busy: boolean }) {
  return (
    <>
      {CREDENTIAL_FIELDS[kind].map((field) => (
        <div key={field}>
          <Label htmlFor={`credential-${field}`}>{field}</Label>
          <Input
            id={`credential-${field}`}
            name={field}
            type="password"
            autoComplete="off"
            defaultValue=""
            maxLength={16384}
            required
            disabled={busy}
          />
        </div>
      ))}
    </>
  );
}

function CredentialEditor({
  model,
  source,
  busy,
}: {
  model: SourcesModel;
  source: string;
  busy: boolean;
}) {
  const [kind, setKind] = useState<CredentialKind>('bearer');
  return (
    <form
      className="grid gap-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void submitCredential(model, source, event.currentTarget as unknown as CredentialForm);
      }}
    >
      <Label htmlFor="credential-kind">Credential kind</Label>
      <Select
        id="credential-kind"
        name="kind"
        value={kind}
        disabled={busy}
        onChange={(event) => setKind(event.currentTarget.value as CredentialKind)}
      >
        {CREDENTIAL_KINDS.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </Select>
      <CredentialFields key={kind} kind={kind} busy={busy} />
      <Button disabled={busy}>Save credential</Button>
    </form>
  );
}

function formValue(form: HTMLFormElement, name: string): string {
  return new FormData(form).get(name)?.toString() ?? '';
}

export function SourceCard({
  source,
  model,
  busy,
}: {
  source: Source;
  model: SourcesModel;
  busy: boolean;
}) {
  const owned = model.project === null || source.projectId !== null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{source.name}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <IdText value={source.id} label="source ID" />
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {source.ecosystem} · {source.type}
          </Badge>
          <StatusBadge status={source.status} />
        </div>
        <p className="break-all">{displayUrl(source.url) ?? 'No displayable URL'}</p>
        <p>{source.hasCredential ? 'credential set · write-only' : 'No credential set'}</p>
        {model.project !== null && 'attached' in source ? (
          <p>Attached to this project: {source.attached ? 'Yes' : 'No'}</p>
        ) : null}
        {owned ? (
          <form
            key={model.snapshot().settingsVersion}
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              void model.edit(
                source.id,
                Number(formValue(form, 'interval')),
                formValue(form, 'policy') as Source['removalPolicy'],
              );
            }}
          >
            <div>
              <Label htmlFor={`interval-${source.id}`}>Polling interval (seconds)</Label>
              <Input
                id={`interval-${source.id}`}
                name="interval"
                type="number"
                min={1}
                step={1}
                required
                defaultValue={source.pollIntervalSeconds}
              />
            </div>
            <div>
              <Label htmlFor={`policy-${source.id}`}>Removal policy</Label>
              <Select id={`policy-${source.id}`} name="policy" defaultValue={source.removalPolicy}>
                <option value="flag">Flag</option>
                <option value="exclude">Exclude</option>
              </Select>
            </div>
            <Button disabled={busy}>Save settings</Button>
          </form>
        ) : (
          <p>Manage this organization source in organization scope.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {owned ? (
            <>
              {canTogglePause(model.project, source) ? (
                source.status === 'paused' ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void model.togglePause(source)}
                  >
                    Enable
                  </Button>
                ) : (
                  <ConfirmAction
                    key={`${source.id}:${source.status}`}
                    action="Pause"
                    target={`${source.name} (${source.id})`}
                    scope={model.project === null ? 'Organization' : `Project: ${model.project}`}
                    description="Pausing this source stops it from resolving packages in this scope. You can enable it again later."
                    disabled={busy}
                    onConfirm={() => void model.togglePause(source)}
                  />
                )
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => model.chooseCredential(source.id)}
              >
                Set credential
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              void model.names(source.id);
            }}
          >
            Registered names
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export interface SourceFilters {
  q: string;
  type: string;
  scope: string;
}
export function filterSources(items: Source[], filters: SourceFilters) {
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(filters.q.toLowerCase()) &&
      (!filters.type || item.type === filters.type) &&
      (!filters.scope ||
        (filters.scope === 'organization' ? item.projectId === null : item.projectId !== null)),
  );
}
export function SourcesView({ model }: { model: SourcesModel }) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [filters, setFilters] = useState<SourceFilters>({ q: '', type: '', scope: '' });
  const filtered = !!(filters.q || filters.type || filters.scope);
  const items = filterSources(state.items, filters).sort((a, b) => {
    const position = (id: string) => {
      const index = state.order.indexOf(id);
      return index < 0 ? Infinity : index;
    };
    return position(a.id) - position(b.id);
  });
  return (
    <section aria-labelledby="page-heading" className="grid gap-6">
      <h1 id="page-heading" className="text-xl font-semibold">
        Sources
      </h1>
      <p className="text-neutral-600">
        Upstream registries and private repositories. Attached sources are tried in precedence
        order.
      </p>
      <p className="rounded-md border border-blue-200 bg-blue-50 p-3">
        Credentials are write-only. The broker never shows them again; set a new credential to
        rotate a secret.
      </p>
      <LoadedListFilters
        values={filters}
        fields={[
          { key: 'q', label: 'Name (loaded sources)' },
          {
            key: 'type',
            label: 'Type',
            options: [...new Set(state.items.map((item) => item.type))].sort(),
          },
          { key: 'scope', label: 'Source scope', options: ['organization', 'project'] },
        ]}
        onChange={setFilters}
      />
      {state.error ? <ListState kind="error" title={state.error} /> : null}
      <Button
        type="button"
        variant="outline"
        disabled={state.loading || state.busy}
        onClick={() => {
          void model.load();
        }}
      >
        Refresh sources
      </Button>
      {state.loading ? (
        <ListState kind="loading" title="Loading sources…" />
      ) : !state.listError && items.length === 0 ? (
        <ListState
          kind={filtered ? 'filtered-empty' : 'empty'}
          title={filtered ? 'No sources match these filters.' : 'No sources.'}
        />
      ) : null}
      {!state.loading && !state.listError && items.length ? (
        <>
          <p className="text-sm text-neutral-600">
            {items.length} sources loaded{filtered ? ' matching filters' : ''}
          </p>
          <DataTable
            label="Sources in precedence order"
            items={items}
            columns={[
              {
                key: 'name',
                label: 'Source',
                value: (source) => source.name,
                render: (source) => (
                  <div className="grid gap-1">
                    <strong>{source.name}</strong>
                    <span className="text-xs text-neutral-600">
                      {source.ecosystem} · {source.type}
                    </span>
                    <StatusBadge status={source.status} />
                  </div>
                ),
              },
              {
                key: 'precedence',
                label: 'Precedence',
                value: (source) =>
                  state.order.indexOf(source.id) < 0 ? '—' : state.order.indexOf(source.id) + 1,
                render: (source) => {
                  const index = state.order.indexOf(source.id);
                  return index < 0 ? (
                    '—'
                  ) : (
                    <div className="flex flex-wrap items-center gap-1">
                      <strong>{index + 1}</strong>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move up ${source.name}`}
                        disabled={state.busy || state.next !== null || index === 0}
                        onClick={() => model.moveSource(source.id, -1)}
                      >
                        Move up
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move down ${source.name}`}
                        disabled={
                          state.busy || state.next !== null || index === state.order.length - 1
                        }
                        onClick={() => model.moveSource(source.id, 1)}
                      >
                        Move down
                      </Button>
                    </div>
                  );
                },
              },
              {
                key: 'scope',
                label: 'Attached to',
                value: (source) =>
                  source.projectId === null ? 'Organization source' : 'Project source',
                render: (source) => (
                  <div className="grid gap-1">
                    <span>
                      {source.projectId === null ? 'Organization source' : 'Project source'}
                    </span>
                    {model.project === null && 'attachedProjectCount' in source ? (
                      <Badge variant="secondary">
                        {`Attached to ${source.attachedProjectCount} projects`}
                      </Badge>
                    ) : null}
                    {'attached' in source ? (
                      <span className="text-xs text-neutral-600">
                        {source.attached
                          ? 'Attached to this project'
                          : 'Not attached to this project'}
                      </span>
                    ) : null}
                  </div>
                ),
              },
              {
                key: 'credential',
                label: 'Credentials',
                value: (source) => (source.hasCredential ? 'Set · write-only' : 'None'),
                render: (source) =>
                  source.hasCredential ? <Badge variant="outline">Set · write-only</Badge> : 'None',
              },
              {
                key: 'sync',
                label: 'Last successful sync',
                value: (source) => source.lastSuccessAt ?? '',
                priority: 2,
                render: (source) => <Time value={source.lastSuccessAt} fallback="Never" />,
              },
              {
                key: 'id',
                label: 'Source ID',
                value: (source) => source.id,
                priority: 3,
                render: (source) => <IdText value={source.id} label="source ID" />,
              },
              {
                key: 'actions',
                label: 'Actions',
                value: () => '',
                sortable: false,
                render: (source) => (
                  <details>
                    <summary className="cursor-pointer underline">Edit source</summary>
                    <div className="mt-3">
                      <SourceCard source={source} model={model} busy={state.busy} />
                    </div>
                  </details>
                ),
              },
            ]}
          />
        </>
      ) : null}
      {state.next !== null ? (
        <Button
          disabled={state.loading || state.busy}
          onClick={() => {
            void model.load(true);
          }}
        >
          Load more sources
        </Button>
      ) : null}
      {state.credentialSource !== null ? (
        <Card>
          <CardHeader>
            <CardTitle>Set credential</CardTitle>
          </CardHeader>
          <CardContent>
            <IdText value={state.credentialSource} label="source ID" />
            <CredentialEditor
              key={state.credentialVersion}
              model={model}
              source={state.credentialSource}
              busy={state.busy}
            />
          </CardContent>
        </Card>
      ) : null}
      {state.savedCredential ? (
        <p role="status">
          credential set · {state.savedCredential.source} ·{' '}
          <Time value={state.savedCredential.at} />
        </p>
      ) : null}
      {state.names ? (
        <Card>
          <CardHeader>
            <CardTitle>Registered names</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <IdText value={state.names.source} label="source ID" />
            <ul>
              {state.names.items.map((name) => (
                <li key={name.id} className="flex items-center gap-3">
                  <span>{name.pattern}</span>
                  <ConfirmAction
                    action={`Remove ${name.pattern}`}
                    target={name.pattern}
                    scope={model.project === null ? 'Organization' : `Project: ${model.project}`}
                    description="Removing this registered pattern can stop the source from resolving matching packages. Add the pattern again to restore it."
                    disabled={state.busy}
                    onConfirm={() => void model.removeName(name.sourceId, name.id)}
                  />
                </li>
              ))}
            </ul>
            {state.names.next !== null ? (
              <Button
                disabled={state.busy}
                onClick={() => {
                  void model.names(state.names!.source, true);
                }}
              >
                Load more names
              </Button>
            ) : null}
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const pattern = formValue(form, 'pattern');
                form.reset();
                void model.addName(state.names!.source, pattern);
              }}
            >
              <Label htmlFor="registered-pattern">Registered pattern</Label>
              <Input id="registered-pattern" name="pattern" maxLength={50} required />
              <Button disabled={state.busy}>Add name</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {model.project !== null ? (
        <Card>
          <CardHeader>
            <CardTitle>Source order</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p>Earlier sources take precedence. Only attached sources are ordered.</p>
            {state.next !== null ? <p>Load all sources before changing their order.</p> : null}

            <Button
              disabled={state.loading || state.busy || state.next !== null || state.etag === null}
              onClick={() => {
                void model.saveOrder();
              }}
            >
              Save source order
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {model.project !== null ? (
        <Card>
          <CardHeader>
            <CardTitle>Who wins</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void model.resolve(formValue(event.currentTarget, 'name'));
              }}
            >
              <Label htmlFor="resolve-name">Package name</Label>
              <Input id="resolve-name" name="name" maxLength={214} required />
              <Button>Preview</Button>
            </form>
            {state.preview ? (
              <div aria-live="polite">
                <p>{state.preview.name}</p>
                <p>
                  Winning source: <IdText value={state.preview.winner} label="winning source ID" />
                </p>
                <ol>
                  {state.preview.candidates.map((candidate) => (
                    <li key={candidate.sourceId}>
                      {candidate.sourceName} ·{' '}
                      <IdText value={candidate.sourceId} label="candidate source ID" /> ·{' '}
                      {candidate.eligible ? 'Eligible' : 'Ineligible'}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

function projectFromHash() {
  if (typeof window === 'undefined') return null;
  const project = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('project');
  return new URLSearchParams(buildListFilterHash('sources', { project }).split('?')[1] ?? '').get(
    'project',
  );
}

export function SourcesPage() {
  const services = useServices();
  const [project, setProject] = useState(projectFromHash);
  useEffect(() => {
    const changed = () => setProject(projectFromHash());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const model = useMemo(() => createSourcesModel(services, project), [services, project]);
  useEffect(() => {
    void model.load();
  }, [model]);
  useEffect(
    () =>
      services.subscribeReplay?.((result) => {
        void model.replayed(result);
      }),
    [services, model],
  );
  return <SourcesView key={project ?? 'organization'} model={model} />;
}
