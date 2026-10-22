import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { operations } from '../api-types.js';
import { useServices, type ShellServices } from '../auth.js';
import { StatusBadge } from '../components/ui/status-badge.js';
import { Time } from '../components/ui/time.js';
import { IdText } from '../components/ui/id-text.js';
import { ListState } from '../components/ui/list-state.js';
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
import { DataTable } from '../components/ui/table.js';

export type ImportRun = operations['getImportRun']['responses'][200]['content']['application/json'];
type Action = 'approve' | 'apply' | 'cancel' | 'rollback';
interface ImportState {
  runs: ImportRun[];
  next: string | null;
  run: ImportRun | null;
  selectedId: string | null;
  loading: boolean;
  detailLoading: boolean;
  cursor?: string | undefined;
  busy: boolean;
  dialog: boolean;
  confirmed: boolean;
  error: string | null;
  notice: string | null;
}

function publicRun(run: ImportRun): ImportRun {
  return {
    id: run.id,
    state: run.state,
    planHash: run.planHash,
    approvedAt: run.approvedAt,
    approvedByUserId: run.approvedByUserId,
    acceptedAt: run.acceptedAt,
    beforeImageExpiresAt: run.beforeImageExpiresAt,
  };
}

export function importActionAllowed(run: ImportRun, action: Action, now = Date.now()): boolean {
  if (action === 'approve')
    return run.state === 'planned' && !!run.planHash && run.approvedAt === null;
  if (action === 'apply') {
    const approved = run.approvedAt === null ? NaN : Date.parse(run.approvedAt);
    return run.state === 'planned' && Number.isFinite(approved) && approved <= now + 60_000;
  }
  if (action === 'cancel') return run.state === 'planned';
  return (
    ['failed', 'applied', 'verifying', 'verified'].includes(run.state) &&
    (run.beforeImageExpiresAt === null || Date.parse(run.beforeImageExpiresAt) > now)
  );
}

export function createImportController(services: ShellServices) {
  let state: ImportState = {
    runs: [],
    next: null,
    run: null,
    selectedId: null,
    loading: false,
    detailLoading: false,
    busy: false,
    dialog: false,
    confirmed: false,
    error: null,
    notice: null,
  };
  let selection = 0;
  let listing = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<ImportState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const controller = {
    back() {
      ++selection;
      set({
        run: null,
        selectedId: null,
        detailLoading: false,
        dialog: false,
        confirmed: false,
        error: null,
        notice: null,
      });
    },
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(cursor?: string) {
      const version = ++listing;
      set({ loading: true, error: null, cursor });
      const result = await services.client.request('get', '/_pb/import-runs', {
        query: { cursor },
      });
      if (version !== listing) return;
      set(
        result.ok
          ? { runs: result.data.items.map(publicRun), next: result.data.next, loading: false }
          : { runs: [], next: null, loading: false, error: 'Unable to load import runs.' },
      );
    },
    async select(id: string) {
      if (state.busy) return;
      const version = ++selection;
      set({
        run: null,
        selectedId: id,
        detailLoading: true,
        dialog: false,
        confirmed: false,
        error: null,
        notice: null,
      });
      const result = await services.client.request('get', '/_pb/import-runs/{id}', {
        params: { id },
      });
      if (version !== selection) return;
      set(
        result.ok
          ? { run: publicRun(result.data), detailLoading: false }
          : { detailLoading: false, error: 'Unable to load the import run.' },
      );
    },
    openApproval() {
      if (
        !state.busy &&
        state.run?.state === 'planned' &&
        state.run.planHash &&
        state.run.approvedAt === null
      )
        set({ dialog: true, confirmed: false });
    },
    closeApproval() {
      if (!state.busy) set({ dialog: false, confirmed: false });
    },
    confirmApproval(confirmed: boolean) {
      if (state.dialog && !state.busy) set({ confirmed });
    },
    async action(action: Action) {
      const run = state.run;
      if (run === null || state.busy || !importActionAllowed(run, action)) return;
      if (
        action === 'approve' &&
        (!state.dialog ||
          !state.confirmed ||
          !run.planHash ||
          run.state !== 'planned' ||
          run.approvedAt !== null)
      )
        return;
      set({ busy: true, error: null, notice: null });
      const result =
        action === 'approve'
          ? await services.client.request('post', '/_pb/import-runs/{id}/approve', {
              params: { id: run.id },
              body: { planHash: run.planHash! },
            })
          : await services.client.request('post', `/_pb/import-runs/{id}/${action}`, {
              params: { id: run.id },
            });
      set({ busy: false, dialog: false, confirmed: false });
      if (!result.ok) {
        if (result.code === 'reauth_required') {
          services.requireReauth(result.request, { credential: false, secretFields: [] });
        } else {
          set({
            error:
              result.code === 'conflict'
                ? 'The run changed. Reload it and try again.'
                : 'Unable to update the import run.',
          });
        }
        return;
      }
      await controller.select(run.id);
      await controller.load(state.cursor);
      set({ notice: 'Action accepted. Reload to check job progress.' });
    },
  };
  return controller;
}

type Controller = ReturnType<typeof createImportController>;

export function ImportView({
  state,
  controller,
  onSelect,
  onBack,
  onPage,
}: {
  state: ImportState;
  controller: Controller;
  onSelect?: (id: string) => void;
  onBack?: () => void;
  onPage?: (cursor?: string) => void;
}) {
  const run = state.run;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section aria-labelledby="page-heading" className="space-y-4">
      <h1 id="page-heading" className="text-2xl font-semibold">
        Import
      </h1>
      <p>Upload credentials with the CLI. Import manifests are managed with the CLI.</p>
      {state.selectedId && run === null ? (
        <Button
          variant="link"
          className="px-0"
          disabled={state.busy}
          onClick={() => (onBack ? onBack() : controller.back())}
        >
          ← Back to import runs
        </Button>
      ) : null}
      {state.error === null ? null : (
        <ListState kind="error" title={state.error}>
          <Button
            variant="outline"
            disabled={state.busy || state.loading}
            onClick={() => {
              if (state.selectedId) void controller.select(state.selectedId);
              else void controller.load(state.cursor);
            }}
          >
            Retry
          </Button>
        </ListState>
      )}
      {state.notice === null ? null : <p role="status">{state.notice}</p>}
      <Button
        variant="outline"
        disabled={state.loading || state.busy}
        onClick={() => void controller.load(state.cursor)}
      >
        Reload runs
      </Button>
      {state.loading ? <ListState kind="loading" title="Loading import runs…" /> : null}
      {state.detailLoading ? <ListState kind="loading" title="Loading import run…" /> : null}
      {run === null && !state.detailLoading && !state.loading ? (
        state.runs.length ? (
          <>
            <DataTable
              label="Import runs"
              items={state.runs}
              columns={[
                {
                  key: 'id',
                  label: 'Run',
                  value: (item) => item.id,
                  render: (item) => (
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        variant="link"
                        className="h-auto p-0 font-mono"
                        disabled={state.busy}
                        onClick={() =>
                          onSelect ? onSelect(item.id) : void controller.select(item.id)
                        }
                      >
                        Run {item.id.slice(0, 6)}…{item.id.slice(-4)}
                      </Button>
                      <IdText value={item.id} label="run ID" />
                    </div>
                  ),
                },
                {
                  key: 'state',
                  label: 'State',
                  value: (item) => item.state,
                  render: (item) => <StatusBadge status={item.state} />,
                },
                {
                  key: 'hash',
                  label: 'Plan hash',
                  value: (item) => item.planHash ?? '',
                  render: (item) =>
                    item.planHash ? (
                      <IdText value={item.planHash} label="plan hash" />
                    ) : (
                      'No plan hash'
                    ),
                },
                {
                  key: 'approved',
                  label: 'Approved',
                  priority: 2,
                  value: (item) => item.approvedAt ?? '',
                  render: (item) => <Time value={item.approvedAt} fallback="Not approved" />,
                },
                {
                  key: 'accepted',
                  label: 'Accepted',
                  priority: 3,
                  value: (item) => item.acceptedAt ?? '',
                  render: (item) => <Time value={item.acceptedAt} fallback="Not accepted" />,
                },
                {
                  key: 'expires',
                  label: 'Before-image expires',
                  priority: 3,
                  value: (item) => item.beforeImageExpiresAt ?? '',
                  render: (item) => (
                    <Time value={item.beforeImageExpiresAt} fallback="Not scheduled" />
                  ),
                },
              ]}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={!state.cursor || state.busy}
                onClick={() => (onPage ? onPage() : void controller.load())}
              >
                First page
              </Button>
              <Button
                variant="outline"
                disabled={!state.next || state.busy}
                onClick={() => {
                  if (state.next) {
                    if (onPage) onPage(state.next);
                    else void controller.load(state.next);
                  }
                }}
              >
                Next page
              </Button>
            </div>
          </>
        ) : !state.error ? (
          <ListState
            kind={state.cursor ? 'filtered-empty' : 'empty'}
            title={state.cursor ? 'No import runs on this page' : 'No import runs.'}
          >
            Create an import plan with the CLI to get started.
          </ListState>
        ) : null
      ) : null}
      {run === null ? null : (
        <section aria-labelledby="run-heading" className="space-y-3">
          <Button
            variant="link"
            className="px-0"
            disabled={state.busy}
            onClick={() => (onBack ? onBack() : controller.back())}
          >
            ← Back to import runs
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="run-heading" className="text-lg font-semibold">
              Run <IdText value={run.id} label="run ID" />
            </h2>
            <StatusBadge status={run.state} />
          </div>
          <div className="detail-grid">
            <div className="detail-group">
              <h3>Plan</h3>
              <dl className="detail-list">
                <dt>Plan hash</dt>
                <dd>
                  {run.planHash ? (
                    <IdText value={run.planHash} label="full plan hash" full />
                  ) : (
                    'No plan hash'
                  )}
                </dd>
                <dt>Run ID</dt>
                <dd>
                  <IdText value={run.id} label="run ID" />
                </dd>
              </dl>
            </div>
            <div className="detail-group">
              <h3>Approval</h3>
              <dl className="detail-list">
                <dt>Approved at</dt>
                <dd>
                  <Time value={run.approvedAt} fallback="Not approved" />
                </dd>
                <dt>Approved by</dt>
                <dd>
                  <IdText value={run.approvedByUserId} label="approving user ID" />
                </dd>
              </dl>
            </div>
            <div className="detail-group">
              <h3>Execution and retention</h3>
              <dl className="detail-list">
                <dt>Accepted at</dt>
                <dd>
                  <Time value={run.acceptedAt} fallback="Not accepted" />
                </dd>
                <dt>Before-image expires</dt>
                <dd>
                  <Time value={run.beforeImageExpiresAt} fallback="Not scheduled" />
                </dd>
              </dl>
            </div>
          </div>
          <h3 className="font-semibold">Actions</h3>
          <p className="text-sm text-neutral-600">
            Apply requires an approved plan. Cancel is available for planned runs. Rollback is
            available after execution while before-images are retained.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={state.busy}
              onClick={() => void controller.select(run.id)}
            >
              Reload run
            </Button>
            <Button
              disabled={state.busy || !importActionAllowed(run, 'approve', now)}
              onClick={() => controller.openApproval()}
            >
              Review approval
            </Button>
            {(['apply', 'cancel', 'rollback'] as const).map((action) => (
              <Button
                key={action}
                variant={action === 'apply' ? 'outline' : 'ghost'}
                className={action === 'apply' ? undefined : 'text-red-700'}
                disabled={state.busy || !importActionAllowed(run, action, now)}
                title={
                  !importActionAllowed(run, action, now)
                    ? 'Unavailable in the current state or retention window.'
                    : undefined
                }
                onClick={() => void controller.action(action)}
              >
                {action === 'apply' ? 'Apply' : action === 'cancel' ? 'Cancel run' : 'Rollback'}
              </Button>
            ))}
          </div>
        </section>
      )}
      {state.dialog && run !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) controller.closeApproval();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Approve import run</DialogTitle>
              <DialogDescription>
                Confirm the full plan hash for the plan you reviewed with the CLI.
              </DialogDescription>
            </DialogHeader>
            <p className="break-all">
              <code>{run.planHash}</code>
            </p>
            <div className="flex items-center gap-2">
              <Input
                id="confirm-plan"
                type="checkbox"
                className="h-4 w-4"
                checked={state.confirmed}
                disabled={state.busy}
                onChange={(event) => controller.confirmApproval(event.currentTarget.checked)}
              />
              <Label htmlFor="confirm-plan">I confirm this plan hash.</Label>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={state.busy}
                onClick={() => controller.closeApproval()}
              >
                Back
              </Button>
              <Button
                disabled={!state.confirmed || state.busy}
                onClick={() => void controller.action('approve')}
              >
                Approve run
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}

export function ImportPage() {
  const services = useServices();
  const controller = useMemo(() => createImportController(services), [services]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const change = () => setHash(window.location.hash);
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    const query = new URLSearchParams(hash.split('?')[1]);
    void controller.load(query.get('cursor') ?? undefined);
    const id = query.get('run');
    if (id) void controller.select(id);
    else controller.back();
  }, [controller, hash]);
  const navigate = (key: 'run' | 'cursor', value?: string) => {
    const query = new URLSearchParams(hash.split('?')[1]);
    if (value) query.set(key, value);
    else query.delete(key);
    if (key === 'cursor') query.delete('run');
    window.location.hash = `#/import${query.size ? `?${query}` : ''}`;
  };
  return (
    <ImportView
      state={state}
      controller={controller}
      onSelect={(id) => navigate('run', id)}
      onBack={() => navigate('run')}
      onPage={(cursor) => navigate('cursor', cursor)}
    />
  );
}
