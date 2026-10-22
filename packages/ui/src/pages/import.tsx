import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { operations } from '../api-types.js';
import { useServices, type ShellServices } from '../auth.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';

type ImportRun = operations['getImportRun']['responses'][200]['content']['application/json'];
type Action = 'approve' | 'apply' | 'cancel' | 'rollback';
interface ImportState {
  runs: ImportRun[];
  next: string | null;
  run: ImportRun | null;
  loading: boolean;
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

export function createImportController(services: ShellServices) {
  let state: ImportState = {
    runs: [],
    next: null,
    run: null,
    loading: false,
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
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(cursor?: string) {
      const version = ++listing;
      set({ loading: true, error: null });
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
      set({ run: null, dialog: false, confirmed: false, error: null, notice: null });
      const result = await services.client.request('get', '/_pb/import-runs/{id}', {
        params: { id },
      });
      if (version !== selection) return;
      set(
        result.ok ? { run: publicRun(result.data) } : { error: 'Unable to load the import run.' },
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
      if (run === null || state.busy) return;
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
      await controller.load();
      set({ notice: 'Action accepted. Reload to check job progress.' });
    },
  };
  return controller;
}

type Controller = ReturnType<typeof createImportController>;

export function ImportView({ state, controller }: { state: ImportState; controller: Controller }) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const run = state.run;
  async function copyPlanHash() {
    if (!run?.planHash) return;
    try {
      await navigator.clipboard.writeText(run.planHash);
      setCopyStatus('Plan hash copied.');
    } catch {
      setCopyStatus('Unable to copy the plan hash.');
    }
  }
  return (
    <section aria-labelledby="page-heading" className="space-y-4">
      <h1 id="page-heading" className="text-xl font-semibold">
        Import
      </h1>
      <p>Upload credentials with the CLI. Import manifests are managed with the CLI.</p>
      {state.error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.notice === null ? null : <p role="status">{state.notice}</p>}
      <Button
        variant="outline"
        disabled={state.loading || state.busy}
        onClick={() => void controller.load()}
      >
        Reload runs
      </Button>
      {state.loading ? <p role="status">Loading import runs…</p> : null}
      <Table>
        <caption className="sr-only">Import runs</caption>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Plan hash</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.runs.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <Button
                  variant="link"
                  disabled={state.busy}
                  onClick={() => {
                    setCopyStatus(null);
                    void controller.select(item.id);
                  }}
                >
                  {item.id}
                </Button>
              </TableCell>
              <TableCell>{item.state}</TableCell>
              <TableCell>{item.planHash?.slice(0, 12) ?? 'No plan hash'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!state.loading && state.runs.length === 0 ? <p>No import runs.</p> : null}
      <Button
        disabled={state.next === null || state.loading || state.busy}
        onClick={() => {
          if (state.next) void controller.load(state.next);
        }}
      >
        Next page
      </Button>
      {run === null ? null : (
        <section aria-labelledby="run-heading" className="space-y-3">
          <h2 id="run-heading" className="text-lg font-semibold">
            Run {run.id}
          </h2>
          <Badge variant="outline">{run.state}</Badge>
          <dl className="grid gap-2">
            <dt>Plan hash</dt>
            <dd className="flex items-center gap-2">
              <code>{run.planHash?.slice(0, 12) ?? 'No plan hash'}</code>
              <Button
                variant="outline"
                disabled={!run.planHash}
                onClick={() => {
                  void copyPlanHash();
                }}
              >
                Copy full plan hash
              </Button>
            </dd>
            <dt>Approved at</dt>
            <dd>{run.approvedAt ?? 'Not approved'}</dd>
            <dt>Approved by user ID</dt>
            <dd>{run.approvedByUserId ?? '—'}</dd>
            <dt>Accepted at</dt>
            <dd>{run.acceptedAt ?? 'Not accepted'}</dd>
            <dt>Before-image retention expires</dt>
            <dd>{run.beforeImageExpiresAt ?? 'Not scheduled'}</dd>
          </dl>
          {copyStatus === null ? null : <p role="status">{copyStatus}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={state.busy}
              onClick={() => void controller.select(run.id)}
            >
              Reload run
            </Button>
            <Button
              disabled={
                state.busy || run.state !== 'planned' || run.approvedAt !== null || !run.planHash
              }
              onClick={() => controller.openApproval()}
            >
              Review approval
            </Button>
            {(['apply', 'cancel', 'rollback'] as const).map((action) => (
              <Button
                key={action}
                variant="outline"
                disabled={state.busy}
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
  useEffect(() => {
    void controller.load();
  }, [controller]);
  return <ImportView state={state} controller={controller} />;
}
