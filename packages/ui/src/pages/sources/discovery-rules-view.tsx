import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ShellServices } from '../../auth.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { RowActions } from '../../components/ui/row-actions.js';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../components/ui/dialog.js';
import { connectionLabel, discoveryReason, PATTERN_HELP } from '../packages/discovery-labels.js';
import {
  createDiscoveryRules,
  ruleState,
  runFailure,
  scheduleWords,
  type DiscoveryRulesModel,
  type Rule,
} from './discovery-rules.js';

function Instant({ value }: { value: string | null | undefined }) {
  if (!value) return <>Not yet</>;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? (
    <>Time unavailable</>
  ) : (
    <time dateTime={value}>
      {date.toLocaleString()} ({Intl.DateTimeFormat().resolvedOptions().timeZone})
    </time>
  );
}
function CompletedRun({ rule }: { rule: Rule }) {
  const completed = rule.completed;
  return (
    <div className="space-y-2">
      <h4 className="font-semibold">Last completed run</h4>
      {!completed?.lastRunAt ? (
        <p>No completed run yet.</p>
      ) : (
        <>
          <p>
            <Instant value={completed.lastRunAt} />
          </p>
          <p>
            {completed.created} created · {completed.existing} existing · {completed.skipped}{' '}
            skipped · {completed.failed} failed
          </p>
          <details>
            <summary className="min-h-11 cursor-pointer">Last-run details</summary>
            {completed.outcome === 'failed' ? (
              <p>{runFailure(completed.failureReason, completed.failed)}</p>
            ) : null}
            {completed.skips.length ? (
              <>
                <h4 className="font-semibold">Skipped repositories</h4>
                <ul>
                  {completed.skips.map((skip, index) => (
                    <li key={index} className="break-words">
                      {skip.repository}: {discoveryReason(skip.reason)}
                    </li>
                  ))}
                </ul>
                <p>Up to 50 skipped repositories are retained.</p>
              </>
            ) : (
              <p>No retained skip details.</p>
            )}
            {completed.failed > 0 ? (
              <p>
                Repository failure details are not retained for completed runs. Check the connection
                and run the rule again.
              </p>
            ) : null}
          </details>
        </>
      )}
    </div>
  );
}
function RuleForm({ model }: { model: DiscoveryRulesModel }) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const draft = state.draft!;
  const original = state.items.find((r) => r.id === state.editing);
  const restart =
    original &&
    (original.ecosystem !== draft.ecosystem ||
      original.pattern !== draft.pattern ||
      original.includeForks !== draft.includeForks ||
      ('credentialId' in original &&
        (original.credentialId !== draft.credentialId ||
          original.installationId !== draft.installationId)));
  const pattern = useRef<HTMLInputElement>(null);
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    name.current?.focus();
  }, []);
  useEffect(() => {
    if (state.patternError) pattern.current?.focus();
  }, [state.patternError]);
  const currentBinding =
    original &&
    'credentialId' in original &&
    original.credentialId === draft.credentialId &&
    original.installationId === draft.installationId;
  const disabled = state.busy || state.reauthPending;
  const selected = state.connections.findIndex(
    (c) => c.credentialId === draft.credentialId && c.installationId === draft.installationId,
  );
  return (
    <form
      className="grid max-w-5xl items-start gap-x-6 gap-y-4 rounded border p-4 lg:grid-cols-2"
      aria-label={state.editing ? 'Edit discovery rule' : 'New discovery rule'}
      aria-busy={disabled}
      onSubmit={(event) => {
        event.preventDefault();
        void model.save();
      }}
    >
      <p className="lg:col-span-2">
        {state.editing ? 'Edit discovery rule' : 'New discovery rule'} · Organization sources.
        Matching repositories become shared sources. Projects attach these sources to use their
        packages.
      </p>
      <div>
        <Label htmlFor="rule-name">Name (required)</Label>
        <Input
          id="rule-name"
          ref={name}
          className="min-h-11"
          required
          maxLength={80}
          value={draft.name}
          disabled={disabled}
          onChange={(e) => model.configure({ name: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor="rule-connection">GitHub connection (required)</Label>
        <Select
          id="rule-connection"
          className="min-h-11 max-w-full"
          disabled={disabled || !state.connections.length}
          value={selected < 0 ? '' : String(selected)}
          onChange={(e) => {
            const c = state.connections[Number(e.target.value)];
            if (c)
              model.configure({ credentialId: c.credentialId, installationId: c.installationId });
          }}
        >
          <option value="" disabled>
            {currentBinding
              ? 'Current connection (no longer used by any source)'
              : 'Choose a connection'}
          </option>
          {state.connections.map((c, i) => (
            <option key={i} value={String(i)}>
              {connectionLabel(c)}
            </option>
          ))}
        </Select>
        {selected < 0 && !currentBinding ? (
          <p>The saved connection is unavailable. Choose an available GitHub connection.</p>
        ) : null}
      </div>
      <div>
        <Label htmlFor="rule-ecosystem">Package ecosystem</Label>
        <Select
          id="rule-ecosystem"
          className="min-h-11"
          disabled={disabled}
          value={draft.ecosystem}
          onChange={(e) =>
            model.configure({ ecosystem: e.target.value as 'composer' | 'npm' | 'both' })
          }
        >
          <option value="npm">npm</option>
          <option value="composer">Composer</option>
          <option value="both">Composer and npm</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="rule-pattern">Repository name pattern (optional)</Label>
        <Input
          id="rule-pattern"
          ref={pattern}
          className="min-h-11"
          maxLength={100}
          value={draft.pattern}
          disabled={disabled}
          aria-invalid={!!state.patternError}
          aria-describedby={`rule-pattern-help${state.patternError ? ' rule-pattern-error' : ''}`}
          onChange={(e) => model.configure({ pattern: e.target.value })}
        />
        <p id="rule-pattern-help">{PATTERN_HELP}</p>
        {state.patternError ? (
          <p id="rule-pattern-error" role="alert">
            {state.patternError}
          </p>
        ) : null}
      </div>
      <div>
        <Label htmlFor="rule-interval">Scan interval in hours (required)</Label>
        <Input
          id="rule-interval"
          className="min-h-11"
          type="number"
          required
          min={1}
          max={720}
          step={1}
          value={(draft.intervalSeconds ?? 86400) / 3600}
          disabled={disabled}
          aria-describedby="rule-interval-help"
          onChange={(e) =>
            model.configure({ intervalSeconds: Math.round(Number(e.target.value) * 3600) })
          }
        />
        <p id="rule-interval-help">From one hour to 30 days. GitHub limits may delay a scan.</p>
      </div>
      <fieldset>
        <legend>Scan settings</legend>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={draft.includeForks ?? false}
            disabled={disabled}
            onChange={(e) => model.configure({ includeForks: e.target.checked })}
          />
          Include forks
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={draft.enabled ?? true}
            disabled={disabled}
            onChange={(e) => model.configure({ enabled: e.target.checked })}
          />
          Enabled
        </label>
      </fieldset>
      {restart ? (
        <p className="lg:col-span-2">
          Changing the connection, ecosystem, pattern or forks restarts the scan. Imported sources
          stay.
        </p>
      ) : null}
      {state.stale ? (
        <div className="lg:col-span-2">
          <p>Your draft is retained above. The newer rule is shown in the list below.</p>
          <Button type="button" className="min-h-11" onClick={() => model.reviewLatest()}>
            Use latest settings and review
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 lg:col-span-2">
        <Button
          type="submit"
          className="min-h-11 w-full sm:w-auto"
          disabled={disabled || state.loading || state.stale || (selected < 0 && !currentBinding)}
        >
          {state.busy ? 'Saving rule…' : 'Save rule'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full sm:w-auto"
          disabled={disabled}
          onClick={() => model.close()}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
export function DiscoveryRules({ services }: { services: ShellServices }) {
  const model = useMemo(() => createDiscoveryRules(services), [services]);
  useEffect(() => {
    void model.load().then(() => {
      if (
        new URLSearchParams(window.location.hash.split('?')[1]).get('discovery') === 'new' &&
        !model.snapshot().draft
      )
        model.edit();
    });
    const unsubscribe = services.subscribeReplay?.((result) => {
      if (result.path.startsWith('/_pb/sources/discovery/rules')) {
        void model.replayed(result);
      }
    });
    return () => {
      unsubscribe?.();
      model.dispose();
    };
  }, [model, services]);
  return <DiscoveryRulesView model={model} />;
}
export function DiscoveryRulesView({ model }: { model: DiscoveryRulesModel }) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const notice = useRef<HTMLParagraphElement>(null);
  const focusHeadingAfterDelete = useRef(false);
  useEffect(() => {
    if (state.notice && !state.loading && !state.draft) notice.current?.focus();
  }, [state.notice, state.loading, state.draft]);
  useEffect(() => {
    if (deleting || !focusHeadingAfterDelete.current) return;
    focusHeadingAfterDelete.current = false;
    heading.current?.focus();
  }, [deleting]);
  if (!state.visible && !state.loading && !state.error) return null;
  return (
    <section aria-labelledby="discovery-rules-heading" className="mt-8 grid min-w-0 gap-4">
      <h2
        ref={heading}
        tabIndex={-1}
        id="discovery-rules-heading"
        className="text-lg font-semibold"
      >
        Discovery rules
      </h2>
      <p>
        Organization rules keep matching GitHub repositories available as shared sources. Existing
        sources are counted, never duplicated. Deleting a rule leaves imported sources in place.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          className="min-h-11"
          variant="outline"
          disabled={state.loading || state.busy}
          onClick={() => void model.load()}
        >
          Reload rules
        </Button>
        {state.manager ? (
          <Button
            className="min-h-11"
            disabled={state.loading || state.busy || !!state.draft}
            onClick={() => model.edit()}
          >
            Create discovery rule
          </Button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" ref={notice} tabIndex={-1}>
        {state.notice}
      </p>
      {state.error && !deleting ? <p role="alert">{state.error}</p> : null}
      {state.connectionsError ? (
        <p>GitHub connections could not be loaded. Reload rules to try again.</p>
      ) : state.manager && !state.loading && !state.connections.length ? (
        <p>
          No GitHub App connections yet. Add an organization GitHub source with GitHub App
          authentication first.{' '}
          <a className="underline" href="#/sources?create=vcs&provider=github">
            Add a GitHub source
          </a>
        </p>
      ) : null}
      {state.draft && state.manager ? <RuleForm model={model} /> : null}
      {!state.loading && !state.items.length && !state.error ? (
        <p>No discovery rules yet.</p>
      ) : null}
      <ul className="grid min-w-0 gap-4">
        {state.items.map((rule) => (
          <li key={rule.id} className="min-w-0 space-y-2 rounded border p-4">
            <h3 className="break-words font-semibold">{rule.name}</h3>
            <dl className="grid gap-2 sm:grid-cols-2">
              <div>
                <dt>Ecosystem</dt>
                <dd>
                  {rule.ecosystem === 'both'
                    ? 'Composer and npm'
                    : rule.ecosystem === 'composer'
                      ? 'Composer'
                      : 'npm'}
                </dd>
              </div>
              <div>
                <dt>Repository pattern</dt>
                <dd className="break-words">{rule.pattern}</dd>
              </div>
              <div>
                <dt>Forks</dt>
                <dd>{rule.includeForks ? 'Included' : 'Excluded'}</dd>
              </div>
              <div>
                <dt>Schedule</dt>
                <dd>{scheduleWords(rule.intervalSeconds)}</dd>
              </div>
              <div>
                <dt>Enabled</dt>
                <dd>{rule.enabled ? 'Enabled' : 'Disabled'}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>
                  {!rule.enabled ? 'Scheduled scans stopped' : ruleState(rule)}
                  {'outcome' in rule && rule.outcome === 'rate_limited' ? (
                    <>
                      {' '}
                      until <Instant value={rule.nextRunAt} />
                    </>
                  ) : null}
                </dd>
              </div>
            </dl>
            <CompletedRun rule={rule} />
            {state.manager && 'created' in rule ? (
              <p>
                Current run: {rule.created} created · {rule.existing} existing · {rule.skipped}{' '}
                skipped · {rule.failed} failed · {rule.remaining.length} repositories remaining in
                the current page{rule.cursor ? '; more pages to scan' : ''}.
              </p>
            ) : null}
            {state.manager ? (
              <RowActions
                entityLabel={rule.name}
                actions={[
                  {
                    id: 'run',
                    label: 'Run now',
                    disabled:
                      state.busy ||
                      state.reauthPending ||
                      state.loading ||
                      state.stale ||
                      !rule.enabled,
                    onSelect: () => void model.run(rule),
                  },
                ]}
                overflow={[
                  {
                    id: 'edit',
                    label: 'Edit',
                    disabled: state.busy || state.reauthPending || state.loading || !!state.draft,
                    onSelect: () => model.edit(rule),
                  },
                  {
                    id: 'toggle',
                    label: rule.enabled ? 'Disable' : 'Enable',
                    disabled: state.busy || state.reauthPending || state.loading || state.stale,
                    onSelect: () => void model.toggle(rule),
                  },
                  {
                    id: 'delete',
                    label: 'Delete',
                    variant: 'destructive',
                    disabled: state.busy || state.reauthPending || state.loading || state.stale,
                    onSelect: () => setDeleting(rule),
                  },
                ]}
              />
            ) : null}
            {state.manager && !rule.enabled ? (
              <p>Enable this rule before requesting a scan.</p>
            ) : null}
          </li>
        ))}
      </ul>
      {state.next ? (
        <Button
          className="min-h-11"
          disabled={state.loading || state.busy}
          onClick={() => void model.load(true)}
        >
          Load more rules
        </Button>
      ) : null}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !state.busy) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Delete discovery rule</DialogTitle>
          <DialogDescription>
            Remove the rule {deleting?.name} in this organization? Scheduled scans stop. Imported
            sources stay. This cannot be undone.
          </DialogDescription>
          {state.error && deleting ? <p role="alert">{state.error}</p> : null}
          <DialogFooter>
            <Button
              className="min-h-11"
              variant="outline"
              disabled={state.busy}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              variant="destructive"
              disabled={state.busy}
              onClick={() => {
                if (deleting)
                  void model.remove(deleting).then((ok) => {
                    if (ok) {
                      focusHeadingAfterDelete.current = true;
                      setDeleting(null);
                    }
                  });
              }}
            >
              {state.busy ? 'Deleting rule…' : <>Delete rule</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
