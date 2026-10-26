import { useEffect, useState } from 'react';
import type { operations } from '../api-types.js';
import { useServices, type AuthClient } from '../auth.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { DataTable } from '../components/ui/table.js';
import { Time } from '../components/ui/time.js';
import { IdText } from '../components/ui/id-text.js';
import { FilterToolbar } from '../components/ui/toolbar.js';
import { ListState } from '../components/ui/list-state.js';

type AuditList = operations['listAudit']['responses'][200]['content']['application/json'];
type AuditHead = operations['auditHead']['responses'][200]['content']['application/json'];
export interface AuditFilters {
  actor: string;
  action: string;
  project: string;
  limit: string;
  after: string;
}

export function readAuditHash(hash: string): { filters: AuditFilters; scope: string | null } {
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  const project = query.get('project');
  return {
    scope: project !== null && /^[A-Za-z0-9._-]{1,64}$/.test(project) ? project : null,
    filters: {
      actor: query.get('actor') ?? '',
      action: query.get('action') ?? '',
      project: query.get('filterProject') ?? '',
      limit: query.get('limit') ?? '50',
      after: query.get('after') ?? '',
    },
  };
}

export function auditHash(filters: AuditFilters, scope: string | null): string {
  const query = new URLSearchParams();
  if (scope !== null) query.set('project', scope);
  for (const key of ['actor', 'action', 'project', 'limit', 'after'] as const) {
    if (key === 'project' && scope !== null) continue;
    if (filters[key] !== '') query.set(key === 'project' ? 'filterProject' : key, filters[key]);
  }
  return `#/audit${query.size ? `?${query}` : ''}`;
}

export async function loadAudit(client: AuthClient, filters: AuditFilters, scope: string | null) {
  const query = {
    actor: filters.actor || undefined,
    action: filters.action || undefined,
    limit: filters.limit || undefined,
    after: filters.after || undefined,
  };
  const [list, head] = await Promise.all([
    scope === null
      ? client.request('get', '/_pb/audit', {
          query: {
            actor: query.actor,
            action: query.action,
            project: filters.project || undefined,
            limit: query.limit,
            after: query.after,
          },
        })
      : client.request('get', '/_pb/projects/{project}/audit', {
          params: { project: scope },
          query,
        }),
    client.request('get', '/_pb/audit/head'),
  ]);
  return {
    data: list.ok ? list.data : null,
    head: head.ok ? head.data : null,
    error: !list.ok
      ? 'Unable to load audit events.'
      : !head.ok
        ? 'Unable to load the chain head.'
        : null,
  };
}

export function AuditView(props: {
  filters: AuditFilters;
  scope: string | null;
  data: AuditList | null;
  head: AuditHead | null;
  error: string | null;
  loading: boolean;
  onNavigate: (filters: AuditFilters) => void;
}) {
  return (
    <section aria-labelledby="page-heading" className="space-y-4">
      <h1 tabIndex={-1} id="page-heading" className="text-2xl font-semibold">
        Audit
      </h1>
      {props.head === null ? null : (
        <div className="flex flex-wrap gap-2" aria-label="Audit chain head">
          <Badge variant="outline">{`Head ${props.head.seq}`}</Badge>
          <Badge variant="secondary">
            {props.head.lastVerifiedAt === null ? (
              'never verified'
            ) : (
              <>
                Last verified <Time value={props.head.lastVerifiedAt} />
              </>
            )}
          </Badge>
          {props.head.pendingCount > 0 ? (
            <Badge variant="secondary">{`${props.head.pendingCount} pending`}</Badge>
          ) : null}
        </div>
      )}
      <FilterToolbar
        chips={(['actor', 'action', 'project'] as const).flatMap((key) =>
          props.filters[key] && (key !== 'project' || props.scope === null)
            ? [
                {
                  label: { actor: 'Actor', action: 'Action', project: 'Project' }[key],
                  value: props.filters[key],
                  onRemove: () => props.onNavigate({ ...props.filters, [key]: '', after: '' }),
                },
              ]
            : [],
        )}
      >
        <form
          key={auditHash(props.filters, props.scope)}
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const value = (key: string) => String(form.get(key) ?? '');
            props.onNavigate({
              actor: value('actor'),
              action: value('action'),
              project: value('filterProject'),
              limit: value('limit'),
              after: '',
            });
          }}
        >
          <div>
            <Label htmlFor="audit-actor">Actor</Label>
            <Input
              id="audit-actor"
              name="actor"
              maxLength={200}
              defaultValue={props.filters.actor}
            />
          </div>
          <div>
            <Label htmlFor="audit-action">Action</Label>
            <Input
              id="audit-action"
              name="action"
              maxLength={200}
              defaultValue={props.filters.action}
            />
          </div>
          {props.scope === null ? (
            <div>
              <Label htmlFor="audit-project">Project</Label>
              <Input
                id="audit-project"
                name="filterProject"
                maxLength={200}
                defaultValue={props.filters.project}
              />
            </div>
          ) : null}
          <div>
            <Label htmlFor="audit-limit">Limit</Label>
            <Input
              id="audit-limit"
              name="limit"
              type="number"
              min="1"
              max="200"
              required
              defaultValue={props.filters.limit}
            />
          </div>
          <Button type="submit">Filter</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              props.onNavigate({ actor: '', action: '', project: '', limit: '50', after: '' })
            }
          >
            Clear filters
          </Button>
        </form>
      </FilterToolbar>
      {props.error === null ? null : (
        <ListState kind="error" title={props.error}>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onNavigate({ ...props.filters })}
          >
            Retry
          </Button>
        </ListState>
      )}
      {props.loading ? <ListState kind="loading" title="Loading audit events…" /> : null}
      {props.data === null ? null : (
        <>
          {props.data.items.length ? (
            <DataTable
              label="Audit events"
              items={props.data.items}
              columns={[
                { key: 'seq', label: 'Sequence', value: (item) => item.seq },
                {
                  key: 'time',
                  label: 'Time',
                  value: (item) => item.createdAt,
                  render: (item) => <Time value={item.createdAt} />,
                },
                { key: 'action', label: 'Action', value: (item) => item.action },
                {
                  key: 'actor',
                  label: 'Actor',
                  value: (item) => item.actor.id ?? '',
                  render: (item) => (
                    <>
                      <span className="block text-xs text-neutral-600">{item.actor.type}</span>
                      <IdText value={item.actor.id} label="actor ID" />
                    </>
                  ),
                },
                {
                  key: 'project',
                  label: 'Project',
                  priority: 2,
                  value: (item) => item.projectId ?? '',
                  render: (item) => <IdText value={item.projectId} label="project ID" />,
                },
                {
                  key: 'targetType',
                  label: 'Target type',
                  priority: 2,
                  value: (item) => item.targetType,
                },
                {
                  key: 'targetId',
                  label: 'Target ID',
                  priority: 3,
                  value: (item) => item.targetId ?? '',
                  render: (item) => <IdText value={item.targetId} label="target ID" />,
                },
              ]}
            />
          ) : !props.loading && !props.error ? (
            <ListState
              kind={
                props.filters.actor ||
                props.filters.action ||
                props.filters.project ||
                props.filters.after
                  ? 'filtered-empty'
                  : 'empty'
              }
              title={
                props.filters.actor ||
                props.filters.action ||
                props.filters.project ||
                props.filters.after
                  ? 'No audit events match these filters'
                  : 'No audit events.'
              }
            />
          ) : null}
          <div className="flex gap-2">
            {props.filters.after ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => props.onNavigate({ ...props.filters, after: '' })}
              >
                First page
              </Button>
            ) : null}
            <Button
              type="button"
              disabled={props.data.next === null || props.loading}
              onClick={() => {
                if (props.data?.next)
                  props.onNavigate({ ...props.filters, after: props.data.next });
              }}
            >
              Next page
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export function AuditPage() {
  const { client } = useServices();
  const [hash, setHash] = useState(() => window.location.hash);
  const [result, setResult] = useState<Awaited<ReturnType<typeof loadAudit>>>({
    data: null,
    head: null,
    error: null,
  });
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setResult({ data: null, head: null, error: null });
    const { filters, scope } = readAuditHash(hash);
    void loadAudit(client, filters, scope).then((next) => {
      if (live) {
        setResult(next);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [client, hash, reload]);
  const { filters, scope } = readAuditHash(hash);
  return (
    <AuditView
      {...result}
      filters={filters}
      scope={scope}
      loading={loading}
      onNavigate={(next) => {
        const target = auditHash(next, scope);
        if (window.location.hash === target) setReload((value) => value + 1);
        else window.location.hash = target;
      }}
    />
  );
}
