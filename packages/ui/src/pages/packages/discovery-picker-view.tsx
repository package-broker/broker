import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ShellServices } from '../../auth.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { connectionLabel, PATTERN_HELP } from './discovery-labels.js';
import { prefillDiscoveryRule } from '../sources/discovery-rule-prefill.js';
import { createDiscoveryPicker, discoveryReason } from './discovery-picker.js';

export function DiscoveryPicker({
  services,
  ecosystem,
  onBack,
  onImportingChange,
}: {
  services: ShellServices;
  ecosystem: 'composer' | 'npm';
  onBack: () => void;
  onImportingChange: (importing: boolean) => void;
}) {
  const model = useMemo(() => createDiscoveryPicker(services, ecosystem), [services, ecosystem]);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  useEffect(() => {
    void model.load();
    return () => model.cancel();
  }, [model]);
  // Reported from the store, not from a render effect: the dialog's Escape guard must see the
  // import start in the same render as the click, or an early Escape closes the dialog mid-import.
  useEffect(() => {
    let importing = model.snapshot().importing;
    onImportingChange(importing);
    const unsubscribe = model.subscribe(() => {
      if (model.snapshot().importing === importing) return;
      importing = model.snapshot().importing;
      onImportingChange(importing);
    });
    return () => {
      unsubscribe();
      onImportingChange(false);
    };
  }, [model, onImportingChange]);
  const connectionControl = useRef<HTMLSelectElement>(null);
  const initiallyFocused = useRef(false);
  const patternControl = useRef<HTMLInputElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state.reviewed) previewHeading.current?.focus();
  }, [state.reviewed, state.entries]);
  useEffect(() => {
    if (!state.loading && state.connections.length && !initiallyFocused.current) {
      initiallyFocused.current = true;
      connectionControl.current?.focus();
    }
  }, [state.loading, state.connections.length]);
  useEffect(() => {
    if (state.patternError) patternControl.current?.focus();
  }, [state.patternError]);
  const eligible = state.entries.filter((e) => e.action === 'new' && model.eligible(e.repository));
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate =
        state.selected.length > 0 && state.selected.length < eligible.length;
  }, [state.selected, eligible.length]);
  const failed = state.results.some(
    (r) => r.outcome === 'failed' && !state.pending.includes(r.repository),
  );
  return (
    <section aria-label="GitHub organization repositories" className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={state.busy} onClick={onBack}>
          Back
        </Button>
        <Button variant="outline" disabled={state.busy} onClick={() => model.startOver()}>
          Start over
        </Button>
      </div>
      {state.importing ? (
        <p>Import in progress. Wait for this batch to finish before closing or going back.</p>
      ) : null}
      <p>
        Import {ecosystem === 'npm' ? 'npm' : 'Composer'} repositories as shared organization
        sources. Projects can attach these sources to use their packages.
      </p>
      {state.loading ? <p role="status">Loading GitHub connections…</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {!state.loading && !state.connections.length ? (
        <>
          {state.error ? (
            <Button onClick={() => void model.load()}>Try again</Button>
          ) : (
            <>
              <p>
                No GitHub App connections yet. Add one organization GitHub source with GitHub App
                authentication first, then return here to choose repositories.
              </p>
              <a
                className="inline-flex min-h-11 items-center underline"
                href="#/sources?create=vcs&provider=github"
              >
                Add a GitHub source
              </a>
            </>
          )}
        </>
      ) : null}
      {state.connections.length ? (
        <>
          <form
            className="grid max-w-5xl items-start gap-x-6 gap-y-4 lg:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void model.preview().then(() => {
                if (model.snapshot().patternError) patternControl.current?.focus();
              });
            }}
            aria-busy={state.busy}
            noValidate
          >
            <div className="min-w-0">
              <Label htmlFor="discovery-connection">GitHub connection</Label>
              <Select
                id="discovery-connection"
                ref={connectionControl}
                className="min-h-11 min-w-0 max-w-full"
                value={state.connection}
                disabled={state.busy}
                onChange={(e) => model.configure({ connection: e.target.value })}
              >
                {state.connections.map((c, i) => (
                  <option key={`${c.credentialId}:${c.installationId}`} value={String(i)}>
                    {connectionLabel(c)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-0">
              <Label htmlFor="discovery-pattern">Repository name pattern (optional)</Label>
              <Input
                id="discovery-pattern"
                ref={patternControl}
                className="min-h-11"
                value={state.pattern}
                maxLength={100}
                pattern="[A-Za-z0-9._*?\-]{1,100}"
                aria-invalid={!!state.patternError}
                aria-describedby={`discovery-pattern-help${state.patternError ? ' discovery-pattern-error' : ''}`}
                disabled={state.busy}
                onChange={(e) => model.configure({ pattern: e.target.value })}
              />
              {state.patternError ? (
                <p id="discovery-pattern-error" role="alert">
                  {state.patternError}
                </p>
              ) : null}
              <p id="discovery-pattern-help">{PATTERN_HELP}</p>
            </div>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={state.includeForks}
                disabled={state.busy}
                onChange={(e) => model.configure({ includeForks: e.target.checked })}
              />
              Include forks
            </label>
            <div className="lg:col-span-2">
              <Button className="min-h-11 w-full sm:w-auto" disabled={state.busy} type="submit">
                {state.busy && !state.importing
                  ? 'Previewing repositories…'
                  : 'Preview repositories'}
              </Button>
            </div>
          </form>
          <a
            className="inline-flex min-h-11 items-center underline"
            href="#/sources?discovery=new"
            aria-disabled={state.busy || !state.connections[Number(state.connection)]}
            aria-describedby="rule-prefill-help"
            onClick={(event) => {
              const chosen = state.connections[Number(state.connection)];
              if (state.busy || !chosen) {
                event.preventDefault();
                return;
              }
              prefillDiscoveryRule(services, {
                credentialId: chosen.credentialId,
                installationId: chosen.installationId,
                ecosystem,
                pattern: state.pattern || '*',
                includeForks: state.includeForks,
              });
            }}
          >
            Keep this selection up to date
          </a>
          <p id="rule-prefill-help">
            {state.connections[Number(state.connection)] === undefined
              ? 'Choose a connection to keep this selection up to date. '
              : ''}
            A rule scans all repositories matching these settings, including future matches.
            Individual checkboxes do not limit the rule.
          </p>
          {state.reviewed ? (
            <div className="space-y-4">
              <h3 ref={previewHeading} tabIndex={-1} className="font-semibold">
                Repository preview
              </h3>
              <p>
                Select up to 20 repositories per import. Load more replaces the current preview
                page.
              </p>
              {state.selected.length === 20 ? (
                <p role="status" aria-live="polite">
                  20 repository limit reached. Import these repositories before selecting more.
                </p>
              ) : null}
              {(['new', 'existing', 'skipped'] as const).map((action) => {
                const entries = state.entries.filter(
                  (e) =>
                    (e.action === 'new' && !model.eligible(e.repository)
                      ? 'existing'
                      : e.action) === action,
                );
                return (
                  <section
                    key={action}
                    aria-label={
                      action === 'new'
                        ? 'Will be added'
                        : action === 'existing'
                          ? 'Already added'
                          : 'Skipped'
                    }
                  >
                    <h3 className="font-semibold">
                      {action === 'new'
                        ? 'Will be added'
                        : action === 'existing'
                          ? 'Already added'
                          : 'Skipped'}{' '}
                      ({entries.length})
                    </h3>
                    {action === 'new' && eligible.length ? (
                      <label className="flex min-h-11 items-center gap-2">
                        <input
                          type="checkbox"
                          disabled={state.busy}
                          ref={selectAll}
                          checked={state.selected.length === Math.min(eligible.length, 20)}
                          onChange={(e) => model.selectPage(e.target.checked)}
                        />
                        Select all on page (up to 20)
                      </label>
                    ) : null}
                    <ul className="space-y-2">
                      {entries.map((entry) => (
                        <li
                          key={`${entry.repository}:${entry.ecosystem}`}
                          className="break-words rounded border p-3"
                        >
                          {action === 'new' ? (
                            <label className="flex min-h-11 items-center gap-2">
                              <input
                                type="checkbox"
                                checked={state.selected.includes(entry.repository)}
                                disabled={
                                  state.busy ||
                                  (state.selected.length >= 20 &&
                                    !state.selected.includes(entry.repository))
                                }
                                onChange={(e) => model.toggle(entry.repository, e.target.checked)}
                              />
                              {entry.repository}
                            </label>
                          ) : (
                            <p>{entry.repository}</p>
                          )}
                          {entry.packageName ? <p>{entry.packageName}</p> : null}
                          {action === 'existing' ? (
                            <p>
                              This repository already has an organization source. No new source will
                              be created.
                            </p>
                          ) : null}
                          {action === 'skipped' ? <p>{discoveryReason(entry.reason)}</p> : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {!state.entries.length ? (
                <p>
                  No repositories match this preview. Change the pattern or connection and try
                  again.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <Button
                  className="min-h-11 w-full sm:w-auto"
                  disabled={state.busy || !!state.pending.length || !state.selected.length}
                  onClick={() => void model.importSelected()}
                >
                  Import selected ({state.selected.length})
                </Button>
                {state.nextCursor ? (
                  <Button
                    variant="outline"
                    className="min-h-11 w-full sm:w-auto"
                    disabled={state.busy}
                    onClick={() => void model.preview(true)}
                  >
                    Load more
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {state.total > 0 ? (
            <p role="status" aria-live="polite">
              {state.importing
                ? 'Importing'
                : state.pending.length
                  ? 'Import paused'
                  : 'Import finished'}
              : {state.progress} of {state.total} repositories processed.
            </p>
          ) : null}
          {state.pending.length ? (
            <Button disabled={state.busy} onClick={() => void model.continueImport()}>
              Continue import
            </Button>
          ) : null}
          {state.results.length ? (
            <section aria-label="Import results" className="space-y-3">
              <h3 className="font-semibold">Import results</h3>
              <ul className="space-y-2">
                {state.results.map((r) => (
                  <li key={r.repository} className="break-words rounded border p-3">
                    <p>
                      {r.repository} ·{' '}
                      {r.outcome === 'created'
                        ? 'Created'
                        : r.outcome === 'existing'
                          ? 'Already added'
                          : r.outcome === 'skipped'
                            ? 'Refused'
                            : 'Failed'}
                    </p>
                    {r.outcome === 'skipped' ? <p>{discoveryReason(r.reason)}</p> : null}
                    {r.outcome === 'failed' ? (
                      <p>No successful import was confirmed. Try this repository again.</p>
                    ) : null}
                  </li>
                ))}
              </ul>
              {failed ? (
                <Button
                  className="min-h-11 w-full sm:w-auto"
                  disabled={state.busy}
                  onClick={() => void model.retryFailed()}
                >
                  Retry failed repositories
                </Button>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
