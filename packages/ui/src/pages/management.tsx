import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ApiResult } from '../api.js';
import { safePageHash, type ShellServices, type ReplayResult } from '../auth.js';
import { buildListFilterHash } from '../page-hash.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import { FilterToolbar } from '../components/ui/toolbar.js';
import { ListState } from '../components/ui/list-state.js';

export interface ManagementQuery {
  project: string | null;
  status?: string;
  q?: string;
  after?: string | undefined;
}
const hasControl = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function parseManagementHash(hash: string, statuses: readonly string[]): ManagementQuery {
  const params = new URLSearchParams(safePageHash(hash).split('?')[1]);
  const query: ManagementQuery = { project: params.get('project') };
  const status = params.get('status');
  if (status !== null && statuses.includes(status)) query.status = status;
  const q = params.get('q');
  if (q && !hasControl(q)) query.q = q;
  const after = params.get('after');
  if (after && !hasControl(after)) query.after = after;
  return query;
}
export function createManagementStore<S>(initial: S) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => state,
    set(patch: Partial<S>) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export function failureNotice(result: { status: number; code?: string }): string {
  if (result.status === 412) return 'Changed elsewhere. Reload before trying again.';
  switch (result.code) {
    case 'last_holder':
      return 'The last holder of this role cannot be removed.';
    case 'forbidden':
      return 'You do not have permission for this action.';
    case 'not_found':
      return 'Not found. Reload the current data.';
    case 'invalid_request':
      return 'Check the entered values and try again.';
    case 'duplicate':
      return 'An item with these values already exists.';
    case 'conflict':
      return 'The action conflicts with the current data. Reload and review it.';
    default:
      return 'The request could not be completed.';
  }
}
export function requireReauth(services: ShellServices, result: ApiResult<unknown>): boolean {
  if (result.ok || result.code !== 'reauth_required') return false;
  services.requireReauth(result.request, { credential: false, secretFields: [] });
  return true;
}
export function revisionTag(revision: number): string | null {
  return Number.isSafeInteger(revision) && revision > 0 ? `"r${revision}"` : null;
}
export function formValues(event: FormEvent<HTMLFormElement>): Record<string, string> {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  event.currentTarget.reset();
  return Object.fromEntries([...data].map(([key, value]) => [key, String(value)]));
}
export function Field(props: { name: string; label: string; value?: string; required?: boolean }) {
  return (
    <Label className="grid gap-1">
      {props.label}
      <Input name={props.name} defaultValue={props.value ?? ''} required={props.required ?? true} />
    </Label>
  );
}
export function ManagementNotice(props: {
  notice: string | null;
  loading: boolean;
  busy: boolean;
  reload: () => void;
  listError?: boolean;
}) {
  return (
    <>
      {props.listError ? (
        <ListState kind="error" title={props.notice ?? 'Unable to load this list.'} />
      ) : props.notice ? (
        <Alert className="my-4">
          <AlertDescription>{props.notice}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        variant="outline"
        className="my-4"
        disabled={props.loading || props.busy}
        onClick={props.reload}
      >
        Reload
      </Button>
      {props.loading ? <ListState kind="loading" title="Loading…" /> : null}
    </>
  );
}
export function ManagementFilters(props: {
  route: 'projects' | 'access';
  query: ManagementQuery;
  statuses: readonly string[];
  children?: ReactNode;
}) {
  const go = (query: ManagementQuery) => {
    window.location.hash = buildListFilterHash(props.route, query);
  };
  return (
    <FilterToolbar
      chips={[
        ...(props.query.q
          ? [
              {
                label: 'Name prefix',
                value: props.query.q,
                onRemove: () =>
                  go({
                    project: props.query.project,
                    ...(props.query.status ? { status: props.query.status } : {}),
                  }),
              },
            ]
          : []),
        ...(props.query.status
          ? [
              {
                label: props.route === 'projects' ? 'Status' : 'View',
                value: props.query.status,
                onRemove: () =>
                  go({
                    project: props.query.project,
                    ...(props.query.q ? { q: props.query.q } : {}),
                  }),
              },
            ]
          : []),
      ]}
    >
      <form
        className="my-4 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          go({
            project: props.query.project,
            status: String(data.get('status') ?? ''),
            q: String(data.get('q') ?? ''),
          });
        }}
      >
        <div>
          <Label className="grid gap-1">
            {props.route === 'projects' ? 'Name prefix (filtering loaded projects)' : 'Name prefix'}
            <Input name="q" maxLength={200} defaultValue={props.query.q ?? ''} />
          </Label>
        </div>
        <div>
          <Label className="grid gap-1">
            {props.route === 'projects' ? 'Status' : 'View'}
            <Select
              name="status"
              defaultValue={
                props.query.status ?? (props.route === 'projects' ? '' : props.statuses[0])
              }
            >
              {props.route === 'projects' ? <option value="">All statuses</option> : null}
              {props.statuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Label>
        </div>
        <Button type="submit">Apply filters</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => go({ project: props.query.project })}
        >
          Clear filters
        </Button>
        {props.children}
      </form>
    </FilterToolbar>
  );
}
export function useManagementHash<Q>(
  services: ShellServices,
  controller: {
    load: (query: Q) => Promise<void>;
    replayed: (result: ReplayResult) => Promise<void>;
    dispose: () => void;
  },
  parse: (hash: string) => Q,
  route: 'projects' | 'access',
) {
  const [hash, setHash] = useState(() =>
    typeof window === 'undefined' ? `#/${route}` : window.location.hash,
  );
  useEffect(() => {
    const change = () => setHash(window.location.hash);
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    void controller.load(parse(hash));
    return () => controller.dispose();
  }, [controller, hash, parse]);
  useEffect(
    () =>
      services.subscribeReplay?.((result) => {
        void controller.replayed(result);
      }),
    [services, controller],
  );
  return hash;
}
