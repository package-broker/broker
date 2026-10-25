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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../components/ui/dropdown-menu.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import { DataTable } from '../components/ui/table.js';
import { buildListFilterHash } from '../page-hash.js';
import {
  SourceForm,
  SOURCE_TYPE_LABELS,
  sourceFieldErrors,
  type CreateSource,
  type SourceChanges,
} from './sources/source-form.js';

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

export function sourceCredentialKind(body: CreateSource): CredentialKind {
  if (body.type === 'composer_repository') return 'http_basic';
  if (body.type === 'npm_registry') return 'npm_token';
  if (body.type === 'vcs') {
    const config = body.config as { provider?: string; installationId?: number } | undefined;
    if (config?.provider === 'ssh') return 'ssh_key';
    if (config?.provider === 'github' && config.installationId !== undefined) return 'github_app';
  }
  return 'bearer';
}

function isProxy(source: Source) {
  return ['packagist_proxy', 'npmjs_proxy'].includes(source.type);
}

const ENABLE_ADMIN_MESSAGE = 'An organization admin must enable this source.';
const ENABLE_CONFLICT_MESSAGE = 'Register package names, then enable the source.';

type Ownership = 'organization' | 'project' | 'all';

interface SourcesState {
  ownership: Ownership;
  editor: 'create' | Source | null;
  fieldErrors: Record<string, string>;
  formError: string | null;
  available: Source[];
  availableNext: string | null;
  availableLoading: boolean;
  availableError: boolean;
  items: Source[];
  next: string | null;
  loading: boolean;
  listError: boolean;
  settingsVersion: number;
  busy: boolean;
  error: string | null;
  notice: string | null;
  createdSource: string | null;
  credentialSource: string | null;
  credentialVersion: number;
  credentialKind: CredentialKind;
  savedCredential: { source: string; at: string } | null;
  names: (Names & { source: string }) | null;
  preview: Preview | null;
  order: string[];
  etag: string | null;
  canEnableProjectSource: boolean;
  enableDenied: string[];
  enableConflicts: string[];
}

export function displayUrl(value: string | null): string | null {
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
    ownership: 'organization',
    editor: null,
    fieldErrors: {},
    formError: null,
    available: [],
    availableNext: null,
    availableLoading: false,
    availableError: false,
    items: [],
    next: null,
    loading: true,
    listError: false,
    settingsVersion: 0,
    busy: false,
    error: null,
    notice: null,
    createdSource: null,
    credentialSource: null,
    credentialVersion: 0,
    credentialKind: 'bearer',
    savedCredential: null,
    names: null,
    preview: null,
    order: [],
    etag: null,
    canEnableProjectSource: false,
    enableDenied: [],
    enableConflicts: [],
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SourcesState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  let listVersion = 0;
  let availableVersion = 0;
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
        enableDenied: [],
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
    set({
      loading: true,
      listError: false,
      error: null,
      etag: null,
      preview: null,
      order: [],
      enableDenied: [],
      enableConflicts: [],
      canEnableProjectSource: false,
    });
    const query = { limit: '100', ...(after === null ? {} : { after }) };
    const [permissions, result] = await Promise.all([
      project !== null || state.ownership !== 'organization'
        ? client.request('get', '/_pb/me/permissions')
        : null,
      project === null
        ? client.request('get', '/_pb/sources', {
            query: {
              ...query,
              ...(state.ownership === 'organization' ? {} : { ownership: state.ownership }),
            },
          })
        : client.request('get', '/_pb/projects/{project}/sources', {
            params: { project },
            query,
          }),
    ]);
    if (version !== listVersion) return;
    if (failure(result) || !result.ok) {
      set({ loading: false, listError: true });
      return;
    }
    set({
      canEnableProjectSource:
        permissions?.ok === true && permissions.data.organization.includes('org:sources:write'),
    });
    const etag = responseHeader<SourcePage>(result, 'etag') ?? null;
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

  async function loadAvailable(more = false) {
    if (project === null || (more && (state.availableLoading || state.availableNext === null)))
      return;
    const version = ++availableVersion;
    const after = more ? state.availableNext : null;
    set({ availableLoading: true, availableError: false });
    const result = await client.request('get', '/_pb/sources', {
      query: { limit: '100', ...(after === null ? {} : { after }) },
    });
    if (version !== availableVersion) return;
    if (!result.ok) {
      set({ available: [], availableNext: null, availableLoading: false, availableError: true });
      return;
    }
    const page = result.data.items.map((item) => ({
      ...item,
      attached: false as const,
      url: displayUrl(item.url),
    }));
    set({
      available: more ? [...state.available, ...page] : page,
      availableNext: result.data.next,
      availableLoading: false,
    });
  }

  async function findLoadedSource(source: string) {
    while (
      !state.items.some((item) => item.id === source) &&
      state.next !== null &&
      !state.listError
    ) {
      await load(true);
    }
    return state.items.find((item) => item.id === source);
  }

  async function revealCreated(source: string, body?: CreateSource) {
    const created = await findLoadedSource(source);
    if (created) set({ createdSource: source });
    if (created && !isProxy(created) && created.type !== 'hosted') {
      set({
        credentialSource: source,
        credentialVersion: state.credentialVersion + 1,
        credentialKind: body
          ? sourceCredentialKind(body)
          : created.type === 'composer_repository'
            ? 'http_basic'
            : created.type === 'npm_registry'
              ? 'npm_token'
              : created.githubAuthentication === 'app'
                ? 'github_app'
                : 'bearer',
      });
    }
  }

  async function names(source: string, more = false) {
    const previous = state.names;
    if (!more) set({ credentialSource: null, error: null });
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
    set({ busy: true, error: null, notice: null });
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
    enableNeedsAdmin(source: Source) {
      return (
        source.projectId !== null &&
        (!state.canEnableProjectSource || state.enableDenied.includes(source.id))
      );
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    async setOwnership(ownership: Ownership) {
      if (project !== null || state.busy) return;
      set({ ownership, items: [], next: null });
      await load();
    },
    loadAvailable,
    names,
    openEditor(source: Source | null = null) {
      if (state.busy) return;
      if (source && project !== null && source.projectId === null) return;
      set({
        editor: source ?? 'create',
        fieldErrors: {},
        formError: null,
        error: null,
        credentialSource: null,
        savedCredential: null,
      });
    },
    closeEditor() {
      if (!state.busy) set({ editor: null, fieldErrors: {}, formError: null });
    },
    async saveSource(body: CreateSource | SourceChanges) {
      if (state.busy || state.editor === null) return;
      const editor = state.editor;
      set({ busy: true, error: null, formError: null, fieldErrors: {} });
      try {
        const result =
          editor === 'create'
            ? project === null
              ? await client.request('post', '/_pb/sources', { body: body as CreateSource })
              : await client.request('post', '/_pb/projects/{project}/sources', {
                  params: { project },
                  body: body as CreateSource,
                })
            : project === null
              ? await client.request('patch', '/_pb/sources/{source}', {
                  params: { source: editor.id },
                  body,
                })
              : await client.request('patch', '/_pb/projects/{project}/sources/{source}', {
                  params: { project, source: editor.id },
                  body,
                });
        if (!result.ok) {
          failure(result);
          set({ fieldErrors: sourceFieldErrors(result.details), formError: state.error });
          return;
        }
        set({
          editor: null,
          fieldErrors: {},
          formError: null,
          ...(editor === 'create' && project === null && state.ownership === 'project'
            ? { ownership: 'organization' as const }
            : {}),
        });
        await load();
        if (editor === 'create' && result.data && 'id' in result.data) {
          await revealCreated(result.data.id, body as CreateSource);
        }
      } finally {
        set({ busy: false });
      }
    },
    attachment(source: string, attached: boolean) {
      if (project === null) return Promise.resolve();
      return mutate(
        () =>
          attached
            ? client.request('put', '/_pb/projects/{project}/sources/{source}/attachment', {
                params: { project, source },
                body: {},
              })
            : client.request('delete', '/_pb/projects/{project}/sources/{source}/attachment', {
                params: { project, source },
              }),
        () => load(),
      );
    },
    async replayed(result: ReplayResult) {
      const prefix =
        project === null ? '/_pb/sources' : `/_pb/projects/${encodeURIComponent(project)}/sources`;
      const namesChange = /^\/_pb\/sources\/[^/]+\/names(?:\/[^/]+)?$/.test(result.path);
      const enableChange = /^\/_pb\/sources\/([^/]+)\/enable$/.exec(result.path);
      if (
        result.path !== prefix &&
        !result.path.startsWith(`${prefix}/`) &&
        !namesChange &&
        !enableChange
      )
        return;
      const selectedNames = state.names?.source;
      set({ enableDenied: [], enableConflicts: [] });
      if (result.ok)
        set({
          editor: null,
          fieldErrors: {},
          formError: null,
          ...(result.createdSourceId && project === null && state.ownership === 'project'
            ? { ownership: 'organization' as const }
            : {}),
        });
      await load();
      if (enableChange && !result.ok) {
        if (
          result.status === 403 &&
          result.code === 'forbidden' &&
          state.items.some((source) => source.id === enableChange[1] && source.projectId !== null)
        ) {
          set({ enableDenied: [enableChange[1]!] });
        } else if (result.status === 409 && result.code === 'conflict') {
          set({ enableConflicts: [enableChange[1]!] });
        } else {
          set({ error: 'The request could not be saved or loaded. Refresh and try again.' });
        }
      }
      if (result.ok && result.createdSourceId) await revealCreated(result.createdSourceId);
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
    closeCredential() {
      if (!state.busy) set({ credentialSource: null });
    },
    closeNames() {
      if (state.busy) return;
      ++namesVersion;
      set({ names: null });
    },
    chooseCredential(source: string) {
      ++namesVersion;
      set({
        credentialSource: source,
        names: null,
        savedCredential: null,
        credentialVersion: state.credentialVersion + 1,
        credentialKind: 'bearer',
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
    syncNow(source: Source) {
      if (source.status === 'paused' || (project !== null && source.projectId === null))
        return Promise.resolve();
      return mutate(
        () =>
          project === null
            ? client.request('post', '/_pb/sources/{source}/sync', {
                params: { source: source.id },
              })
            : client.request('post', '/_pb/projects/{project}/sources/{source}/sync', {
                params: { project, source: source.id },
              }),
        async () => {
          await load();
          await findLoadedSource(source.id);
          set({ notice: 'Sync requested.' });
        },
      );
    },
    async togglePause(source: Source) {
      if (project !== null && source.projectId === null) return;
      if (source.status === 'paused' && !isProxy(source)) {
        if (
          state.busy ||
          (source.projectId !== null &&
            (!state.canEnableProjectSource || state.enableDenied.includes(source.id)))
        )
          return;
        set({
          busy: true,
          error: null,
          notice: null,
          enableConflicts: state.enableConflicts.filter((id) => id !== source.id),
        });
        try {
          const result = await client.request('post', '/_pb/sources/{source}/enable', {
            params: { source: source.id },
          });
          if (
            source.projectId !== null &&
            !result.ok &&
            result.status === 403 &&
            result.code === 'forbidden'
          ) {
            set({ enableDenied: [...new Set([...state.enableDenied, source.id])] });
          } else if (!result.ok && result.status === 409 && result.code === 'conflict') {
            set({ enableConflicts: [...new Set([...state.enableConflicts, source.id])] });
          } else if (!failure(result)) {
            await load();
          }
        } finally {
          set({ busy: false });
        }
        return;
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
  initialKind,
}: {
  model: SourcesModel;
  source: string;
  busy: boolean;
  initialKind: CredentialKind;
}) {
  const [kind, setKind] = useState<CredentialKind>(initialKind);
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

const SYNC_ERROR_LABELS: Record<string, string> = {
  network: 'Network failure',
  timeout: 'Sync timed out',
  http_error: 'HTTP error',
  unauthorized: 'Authorization failed',
  rate_limited: 'Rate limited',
  not_found: 'Not found',
  invalid_response: 'Invalid response',
  mass_absence: 'Mass package absence',
  too_large: 'Response too large',
  policy_denied: 'Policy denied',
  credential_unavailable: 'Credential unavailable',
  internal: 'Internal error',
};

function SyncStatus({ source }: { source: Source }) {
  const errorLabel =
    source.lastError !== null && Object.hasOwn(SYNC_ERROR_LABELS, source.lastError)
      ? SYNC_ERROR_LABELS[source.lastError]
      : null;
  return (
    <div className="grid gap-1 text-sm">
      <p>
        Last success: <Time value={source.lastSuccessAt} fallback="Never" />
      </p>
      <p>
        Last error:{' '}
        {source.lastError === null ? (
          'None'
        ) : (
          <>
            {errorLabel && `${errorLabel} · `}
            <code>{source.lastError}</code>
          </>
        )}
      </p>
      <p>
        Next poll: <Time value={source.nextPollAt} fallback="None" />
      </p>
    </div>
  );
}

export function SourceActions({
  source,
  model,
  busy,
}: {
  source: Source;
  model: SourcesModel;
  busy: boolean;
}) {
  const owned = model.project === null ? source.projectId === null : source.projectId !== null;
  const organizationProject = model.project === null && source.projectId !== null;
  return (
    <>
      {owned ? (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={busy || source.status === 'paused'}
            aria-describedby={source.status === 'paused' ? `sync-paused-${source.id}` : undefined}
            onClick={() => void model.syncNow(source)}
          >
            Sync now
          </Button>
          {source.status === 'paused' ? (
            <p id={`sync-paused-${source.id}`}>Enable before syncing.</p>
          ) : null}
        </>
      ) : null}
      <DropdownMenu
        onKeyDown={(event) => {
          if (event.key === 'Escape' && event.currentTarget.contains(event.target as Node)) {
            event.preventDefault();
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }
        }}
      >
        <DropdownMenuTrigger>More</DropdownMenuTrigger>
        <DropdownMenuContent className="grid gap-1">
          {owned || organizationProject ? (
            <>
              {organizationProject &&
              (source.status !== 'paused' || isProxy(source)) ? null : source.status !== 'paused' ||
                isProxy(source) ||
                !model.enableNeedsAdmin(source) ? (
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
              ) : (
                <p role="status">{ENABLE_ADMIN_MESSAGE}</p>
              )}
              {model.snapshot().enableConflicts.includes(source.id) ? (
                <p role="status">{ENABLE_CONFLICT_MESSAGE}</p>
              ) : null}

              {owned ? (
                <DropdownMenuItem disabled={busy} onClick={() => model.chooseCredential(source.id)}>
                  Set credential
                </DropdownMenuItem>
              ) : null}
            </>
          ) : (
            <p>Manage this organization source in organization scope.</p>
          )}
          <DropdownMenuItem disabled={busy} onClick={() => void model.names(source.id)}>
            Registered names
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
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
  const created = state.items.find((item) => item.id === state.createdSource);
  const membershipKnown = !state.loading && !state.listError && state.next === null;
  const combined = [
    ...state.items,
    ...(membershipKnown
      ? state.available.filter((candidate) => !state.items.some((item) => item.id === candidate.id))
      : []),
  ];
  const items = filterSources(combined, filters).sort((a, b) => {
    const position = (id: string) => {
      const index = state.order.indexOf(id);
      return index < 0 ? Infinity : index;
    };
    return position(a.id) - position(b.id);
  });
  return (
    <section aria-labelledby="page-heading" className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="page-heading" className="text-xl font-semibold">
          Sources
        </h1>
        <Button type="button" disabled={state.busy} onClick={() => model.openEditor()}>
          Add source
        </Button>
      </div>
      {state.editor !== null ? (
        <SourceForm
          source={state.editor === 'create' ? null : state.editor}
          busy={state.busy}
          errors={state.fieldErrors}
          alert={state.formError}
          onSubmit={(body) => {
            if (state.editor === 'create') setFilters({ q: '', type: '', scope: '' });
            void model.saveSource(body);
          }}
          onClose={() => model.closeEditor()}
        />
      ) : null}
      <p className="text-neutral-600">
        Upstream registries and private repositories. Attached sources are tried in precedence
        order.
      </p>
      <p className="rounded-md border border-blue-200 bg-blue-50 p-3">
        Credentials are write-only. The broker never shows them again; set a new credential to
        rotate a secret.
      </p>
      {model.project === null ? (
        <Label>
          Ownership
          <Select
            value={state.ownership}
            disabled={state.busy}
            onChange={(event) => void model.setOwnership(event.target.value as Ownership)}
          >
            <option value="organization">Organization</option>
            <option value="project">Project-owned</option>
            <option value="all">All</option>
          </Select>
        </Label>
      ) : null}
      <LoadedListFilters
        values={{ ...filters, type: SOURCE_TYPE_LABELS[filters.type as Source['type']] ?? '' }}
        fields={[
          { key: 'q', label: 'Name (loaded sources)' },
          {
            key: 'type',
            label: 'Type',
            options: [...new Set(combined.map((item) => SOURCE_TYPE_LABELS[item.type]))].sort(),
          },
          ...(model.project === null
            ? []
            : [{ key: 'scope', label: 'Source scope', options: ['organization', 'project'] }]),
        ]}
        onChange={(next) =>
          setFilters({
            q: next.q ?? '',
            scope: model.project === null ? '' : (next.scope ?? ''),
            type:
              Object.keys(SOURCE_TYPE_LABELS).find(
                (key) => SOURCE_TYPE_LABELS[key as Source['type']] === next.type,
              ) ?? '',
          })
        }
      />
      {state.notice ? <p role="status">{state.notice}</p> : null}
      {created?.status === 'paused' && !isProxy(created) ? (
        <p role="status">
          Next steps for {created.name}:{' '}
          {model.enableNeedsAdmin(created)
            ? ENABLE_ADMIN_MESSAGE
            : state.names?.source === created.id && state.names.items.length > 0
              ? 'Enable the source.'
              : 'Register names, then Enable the source.'}
        </p>
      ) : null}
      {state.error ? <ListState kind="error" title={state.error} /> : null}
      <Button
        type="button"
        variant="outline"
        disabled={state.loading || state.busy}
        onClick={() => {
          void model.load();
          void model.loadAvailable();
        }}
      >
        Refresh sources
      </Button>
      {model.project !== null && !membershipKnown && state.available.length > 0 ? (
        <p className="text-sm text-neutral-600">
          Load all project sources before attaching organization sources.
        </p>
      ) : null}
      {state.availableLoading ? (
        <ListState kind="loading" title="Loading organization sources…" />
      ) : null}
      {state.availableError ? (
        <ListState
          kind="error"
          title="Organization sources could not be loaded. Project sources are still shown."
        />
      ) : null}
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
                    {'projectName' in source && source.projectName !== null ? (
                      <span>{`Project: ${source.projectName}`}</span>
                    ) : null}
                    <span className="text-xs text-neutral-600">
                      {source.ecosystem === 'composer' ? 'Composer' : 'npm'} ·{' '}
                      {SOURCE_TYPE_LABELS[source.type]}
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
                label: 'Sync status',
                value: (source) => source.lastSuccessAt ?? '',
                render: (source) => <SyncStatus source={source} />,
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
                  <div className="flex flex-wrap items-start gap-2">
                    {(
                      model.project === null ? source.projectId === null : source.projectId !== null
                    ) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={state.busy}
                        onClick={() => model.openEditor(source)}
                      >
                        Edit
                      </Button>
                    ) : null}
                    {model.project !== null && 'attached' in source ? (
                      source.attached ? (
                        <ConfirmAction
                          action="Detach"
                          target={`${source.name} (${source.id})`}
                          scope={`Project: ${model.project}`}
                          description="Detaching this source stops this project from resolving packages through it. You can attach it again later."
                          disabled={state.busy}
                          onConfirm={() => void model.attachment(source.id, false)}
                        />
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={state.busy}
                          onClick={() => void model.attachment(source.id, true)}
                        >
                          Attach
                        </Button>
                      )
                    ) : null}
                    <SourceActions source={source} model={model} busy={state.busy} />
                  </div>
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
      {state.availableNext !== null ? (
        <Button
          disabled={state.availableLoading || state.busy}
          onClick={() => void model.loadAvailable(true)}
        >
          Load more organization sources
        </Button>
      ) : null}
      {state.credentialSource !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) model.closeCredential();
          }}
        >
          <DialogContent
            variant="source"
            onCancel={(event) => {
              if (state.busy) event.preventDefault();
            }}
          >
            <DialogHeader className="shrink-0 p-6 pr-16">
              <DialogTitle>Set credential</DialogTitle>
              <DialogDescription>
                Credentials are write-only. Save a new credential to rotate a secret.
              </DialogDescription>
            </DialogHeader>
            <div className="grid min-h-0 gap-3 overflow-y-auto px-6 pb-6">
              <IdText value={state.credentialSource} label="source ID" />
              <CredentialEditor
                key={state.credentialVersion}
                model={model}
                source={state.credentialSource}
                initialKind={state.credentialKind}
                busy={state.busy}
              />
              {state.error ? <p role="alert">{state.error}</p> : null}
              {state.savedCredential?.source === state.credentialSource ? (
                <p role="status">
                  credential set · <Time value={state.savedCredential.at} />
                </p>
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
      {state.savedCredential && state.credentialSource === null ? (
        <p role="status">
          credential set · {state.savedCredential.source} ·{' '}
          <Time value={state.savedCredential.at} />
        </p>
      ) : null}
      {state.names ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) model.closeNames();
          }}
        >
          <DialogContent
            variant="source"
            onCancel={(event) => {
              if (state.busy) event.preventDefault();
            }}
          >
            <DialogHeader className="shrink-0 p-6 pr-16">
              <DialogTitle>Registered names</DialogTitle>
              <DialogDescription>
                Manage the package patterns registered for this source.
              </DialogDescription>
            </DialogHeader>
            <div className="grid min-h-0 gap-3 overflow-y-auto px-6 pb-6">
              {state.error ? <p role="alert">{state.error}</p> : null}
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
            </div>
          </DialogContent>
        </Dialog>
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
    void model.loadAvailable();
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
