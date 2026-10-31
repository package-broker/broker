import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { ShellServices } from '../../auth.js';
import type { operations } from '../../api-types.js';
import type { ApiResult } from '../../api.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { DataTable } from '../../components/ui/table.js';
import { ConfirmAction } from '../../components/ui/confirm-action.js';
import { ListState } from '../../components/ui/list-state.js';
import { Time } from '../../components/ui/time.js';

type Publisher =
  operations['listTrustedPublishers']['responses'][200]['content']['application/json']['items'][number];
type Draft = {
  packageName: string;
  repository: string;
  workflow: string;
  environment: string;
  refPattern: string;
};
const empty = (): Draft => ({
  packageName: '',
  repository: '',
  workflow: '',
  environment: '',
  refPattern: '',
});
export interface State {
  items: Publisher[];
  draft: Draft;
  editing: { id: string; revision: number } | null;
  loading: boolean;
  loadError: boolean;
  busy: boolean;
  stale: boolean;
  editDisabled: boolean;
  notice: string | null;
}
export function createTrustedPublishersController(services: ShellServices) {
  let state: State = {
    items: [],
    draft: empty(),
    editing: null,
    loading: false,
    loadError: false,
    busy: false,
    stale: false,
    editDisabled: false,
    notice: null,
  };
  let epoch = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<State>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const failure = (result: Exclude<ApiResult<unknown>, { ok: true }>) => {
    const conflict = result.code === 'conflict' || result.status === 412 || result.status === 428;
    set({
      stale: conflict,
      notice: conflict
        ? 'This publisher changed. Reload the latest settings and review your draft before saving.'
        : result.code === 'github_credentials_required'
          ? 'Configure a GitHub source for this repository with a GitHub App installation or token first.'
          : result.code === 'ambiguous_trusted_publisher'
            ? 'A publisher already uses this package, repository, workflow and environment.'
            : result.code === 'name_not_claimed'
              ? 'Claim this package on an active hosted npm source first.'
              : 'The publisher could not be saved. Check your settings and try again.',
    });
  };
  const controller = {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    draft(draft: Draft) {
      set({ draft });
    },
    edit(
      item: Pick<
        Publisher,
        'id' | 'revision' | 'packageName' | 'repository' | 'workflow' | 'environment' | 'refPattern'
      >,
    ) {
      set({
        draft: {
          packageName: item.packageName,
          repository: item.repository,
          workflow: item.workflow,
          environment: item.environment,
          refPattern: item.refPattern ?? '',
        },
        editing: { id: item.id, revision: item.revision },
        notice: null,
        editDisabled: false,
      });
    },
    cancel() {
      set({ draft: empty(), editing: null, notice: null, editDisabled: false });
    },
    clear() {
      epoch++;
      set({
        draft: empty(),
        editing: null,
        items: [],
        notice: null,
        busy: false,
        loading: false,
        stale: false,
        editDisabled: false,
        loadError: false,
      });
    },
    async load() {
      if (state.busy) return;
      const version = ++epoch;
      set({ loading: true, loadError: false });
      const result = await services.client.request('get', '/_pb/trusted-publishers');
      if (version !== epoch) return;
      if (!result.ok) {
        set({ loading: false, loadError: true });
        return;
      }
      let editing = state.editing;
      let editDisabled = false;
      if (editing !== null) {
        const current = result.data.items.find(
          (item) => item.id === editing!.id && item.disabledAt === null,
        );
        editDisabled = current === undefined;
        if (current !== undefined) editing = { id: current.id, revision: current.revision };
      }
      set({
        items: result.data.items,
        loading: false,
        stale: false,
        editing,
        editDisabled,
        notice: editDisabled
          ? 'This publisher was disabled or is no longer available. Cancel this edit to create a new publisher.'
          : state.stale
            ? 'Latest settings loaded. Review your draft before saving again.'
            : state.notice,
      });
    },
    async save() {
      if (state.busy || state.loading || state.stale || state.loadError || state.editDisabled)
        return;
      const version = epoch;
      set({ busy: true, notice: null });
      const { draft, editing } = state;
      const body = {
        packageName: draft.packageName,
        repository: draft.repository,
        workflow: draft.workflow,
        environment: draft.environment,
        ...(draft.refPattern === '' ? {} : { refPattern: draft.refPattern }),
      };
      const result =
        editing === null
          ? await services.client.request('post', '/_pb/trusted-publishers', { body })
          : await services.client.request('put', '/_pb/trusted-publishers/{id}', {
              params: { id: editing.id },
              headers: { 'If-Match': `"r${editing.revision}"` },
              body,
            });
      if (version !== epoch) return;
      set({ busy: false });
      if (!result.ok) {
        failure(result);
        return;
      }
      set({ draft: empty(), editing: null, notice: 'Trusted publisher saved.' });
      await controller.load();
    },
    async disable(item: Pick<Publisher, 'id' | 'revision'>) {
      if (state.busy || state.loading || state.stale || state.loadError) return;
      const version = epoch;
      set({ busy: true, notice: null });
      const result = await services.client.request('delete', '/_pb/trusted-publishers/{id}', {
        params: { id: item.id },
        headers: { 'If-Match': `"r${item.revision}"` },
      });
      if (version !== epoch) return;
      set({ busy: false });
      if (!result.ok) {
        failure(result);
        return;
      }
      set({ notice: 'Publisher disabled. Its workload tokens have been revoked.' });
      await controller.load();
    },
  };
  return controller;
}
type Controller = ReturnType<typeof createTrustedPublishersController>;
const subscribeLocation = (listener: () => void) => {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
};
const locationSnapshot = () => window.location.hash;
const serverLocationSnapshot = () => '';

export function TrustedPublishers({
  controller,
  permissions,
}: {
  controller: Controller;
  permissions: readonly string[];
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const hash = useSyncExternalStore(subscribeLocation, locationSnapshot, serverLocationSnapshot);
  const targeted =
    new URLSearchParams(hash.split('?')[1] ?? '').get('section') === 'trusted-publishers';
  const [expanded, setExpanded] = useState(targeted || state.editing !== null);
  const [creating, setCreating] = useState(false);
  const [returnFocus, setReturnFocus] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const formOpen = creating || state.editing !== null;
  const blocked = state.busy || state.loading || state.stale || state.loadError;
  useEffect(() => {
    if (targeted || state.editing !== null) setExpanded(true);
  }, [targeted, state.editing]);
  useEffect(() => {
    if (expanded && formOpen) document.getElementById('publisher-packageName')?.focus();
  }, [expanded, formOpen, state.editing?.id]);
  useEffect(() => {
    if (!returnFocus || formOpen || blocked) return;
    const target = opener.current?.isConnected ? opener.current : addButton.current;
    target?.focus();
    setReturnFocus(false);
  }, [returnFocus, formOpen, blocked]);
  const allowed = permissions.includes('org:service-principals:write');
  const canWrite = allowed && permissions.includes('org:packages:publish');
  useEffect(() => {
    if (allowed) void controller.load();
    return () => controller.clear();
  }, [controller, allowed]);
  if (!allowed) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void controller.save().then(() => {
      if (controller.snapshot().notice !== 'Trusted publisher saved.') return;
      setCreating(false);
      setReturnFocus(true);
    });
  };
  return (
    <details
      id="trusted-publishers"
      className="detail-group space-y-4"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="min-h-11 cursor-pointer font-semibold">Trusted publishers</summary>
      <p>
        Organization · Let a GitHub Actions workflow publish one claimed npm package using
        short-lived credentials.
      </p>
      <p>
        Configure an organization GitHub source for the repository with a GitHub App installation or
        token so its numeric identity can be verified.
      </p>
      {state.notice === null ? null : <p role="status">{state.notice}</p>}
      {canWrite && !formOpen ? (
        <Button
          ref={addButton}
          type="button"
          className="min-h-11"
          disabled={blocked}
          onClick={(event) => {
            opener.current = event.currentTarget;
            setCreating(true);
          }}
        >
          Add trusted publisher
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={state.busy || state.loading}
        onClick={() => void controller.load()}
      >
        Reload trusted publishers
      </Button>
      {state.loading ? (
        <ListState kind="loading" title="Loading trusted publishers…" />
      ) : state.loadError ? (
        <ListState kind="error" title="Trusted publishers could not be loaded." />
      ) : state.items.length === 0 ? (
        <ListState kind="empty" title="No trusted publishers yet." />
      ) : (
        <DataTable
          label="Organization trusted publishers"
          items={state.items}
          columns={[
            {
              key: 'package',
              label: 'Package',
              value: (item) => item.packageName,
              render: (item) => <strong className="break-all">{item.packageName}</strong>,
            },
            {
              key: 'workflow',
              label: 'GitHub workflow',
              value: (item) => item.repository,
              render: (item) => (
                <div className="break-all">
                  <p>{item.repository}</p>
                  <p>{item.workflow}</p>
                </div>
              ),
            },
            {
              key: 'binding',
              label: 'Conditions',
              value: (item) => item.environment,
              render: (item) => (
                <>
                  <p>Environment: {item.environment || 'No environment'}</p>
                  <p>Ref: {item.refPattern ?? 'Any ref'}</p>
                  <p>{item.disabledAt === null ? 'Enabled' : 'Disabled'}</p>
                </>
              ),
            },
            {
              key: 'used',
              label: 'Last used',
              value: (item) => item.lastUsedAt ?? '',
              render: (item) =>
                item.lastUsedAt === null ? 'Never used' : <Time value={item.lastUsedAt} />,
            },
            {
              key: 'actions',
              label: 'Actions',
              value: () => '',
              sortable: false,
              render: (item) =>
                !canWrite || item.disabledAt !== null ? null : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      className="min-h-11"
                      variant="outline"
                      disabled={blocked}
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        setCreating(false);
                        controller.edit(item);
                      }}
                    >
                      Edit publisher
                    </Button>
                    <ConfirmAction
                      action="Disable publisher"
                      target={`${item.packageName}: ${item.repository} / ${item.workflow}`}
                      scope="Organization"
                      description="This workflow will no longer be able to publish through this binding. Its workload tokens will be revoked immediately. The binding remains in the history and cannot be recreated."
                      disabled={blocked}
                      onConfirm={() => void controller.disable(item)}
                    />
                  </div>
                ),
            },
          ]}
        />
      )}
      {!canWrite ? (
        <p>
          Publishing and service identity management permissions are both required to manage
          publishers.
        </p>
      ) : !formOpen ? null : (
        <form
          onSubmit={submit}
          className="grid max-w-5xl items-start gap-x-6 gap-y-4 lg:grid-cols-2"
          aria-label={state.editing === null ? 'New trusted publisher' : 'Edit trusted publisher'}
        >
          <h3 className="lg:col-span-2 font-semibold">
            {state.editing === null ? 'New trusted publisher' : 'Edit trusted publisher'}
          </h3>
          {(
            [
              ['packageName', 'npm package', true],
              ['repository', 'GitHub repository (owner/name)', true],
              ['workflow', 'Workflow filename', true],
              ['environment', 'Environment (optional)', false],
              ['refPattern', 'Ref pattern (optional)', false],
            ] as const
          ).map(([key, label, required]) => (
            <div key={key}>
              <Label htmlFor={`publisher-${key}`}>{label}</Label>
              <Input
                id={`publisher-${key}`}
                value={state.draft[key]}
                required={required}
                maxLength={key === 'packageName' ? 214 : key === 'repository' ? 140 : 255}
                disabled={state.busy}
                aria-describedby={
                  key === 'refPattern'
                    ? 'publisher-ref-help'
                    : key === 'environment'
                      ? 'publisher-environment-help'
                      : undefined
                }
                onChange={(event) =>
                  controller.draft({ ...state.draft, [key]: event.target.value })
                }
              />
              {key === 'refPattern' ? (
                <p id="publisher-ref-help">
                  Use a full ref such as refs/tags/v*. * crosses /, ? matches one character, and
                  matching is case-sensitive. Leave blank to allow any ref.
                </p>
              ) : key === 'environment' ? (
                <p id="publisher-environment-help">
                  ASCII letters are matched without case. Leave blank for a workflow job without an
                  environment. A named environment must match.
                </p>
              ) : null}
            </div>
          ))}
          <p className="lg:col-span-2">
            Saving creates or updates an organization service identity with permission to publish
            this package. Workflow identity is verified against GitHub's numeric repository and
            owner IDs.
          </p>
          <div className="lg:col-span-2 flex flex-wrap gap-2">
            <Button
              type="submit"
              className="min-h-11 w-full sm:w-auto"
              disabled={blocked || state.editDisabled}
            >
              {state.busy ? 'Saving publisher…' : 'Save trusted publisher'}
            </Button>
            <Button
              type="button"
              className="min-h-11"
              variant="outline"
              disabled={state.busy}
              onClick={() => {
                controller.cancel();
                setCreating(false);
                setReturnFocus(true);
              }}
            >
              {state.editing === null ? 'Cancel' : 'Cancel edit'}
            </Button>
          </div>
        </form>
      )}
    </details>
  );
}
