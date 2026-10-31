import { useEffect, useState } from 'react';
import type { operations } from '../api-types.js';
import { useServices, type AuthClient } from '../auth.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { DataTable } from '../components/ui/table.js';
import { Time } from '../components/ui/time.js';
import { FilterToolbar } from '../components/ui/toolbar.js';
import { ListState } from '../components/ui/list-state.js';

type AuditList = operations['listAudit']['responses'][200]['content']['application/json'];
export type AuditStatus =
  operations['getAuditStatus']['responses'][200]['content']['application/json'];
type AuditHead = operations['auditHead']['responses'][200]['content']['application/json'];
function isWithheld(
  item: AuditList['items'][number],
): item is Extract<AuditList['items'][number], { kind: 'withheld' }> {
  return 'kind' in item && item.kind === 'withheld';
}

function AuditReference({
  id,
  label,
  name,
}: {
  id: string | null;
  label: string;
  name?: string | undefined;
}) {
  const [notice, setNotice] = useState('');
  const [manual, setManual] = useState(false);
  if (id === null) return <span>Not recorded</span>;
  return (
    <div>
      <span className="block">{name ?? 'Name unavailable'}</span>
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={() => {
          void (async () => {
            try {
              await navigator.clipboard.writeText(id);
              setNotice('ID copied.');
              setManual(false);
            } catch {
              setNotice('Could not copy ID. Copy the value below.');
              setManual(true);
            }
          })();
        }}
      >
        Copy {label} ID
      </Button>
      {notice ? <span role="status">{notice}</span> : null}
      {manual ? <code className="block break-all">{id}</code> : null}
    </div>
  );
}
const actorLabels: Record<string, string> = {
  user: 'Person',
  service: 'Service account',
  service_principal: 'Service account',
  customer: 'Customer',
  system: 'System',
  anonymous: 'Anonymous visitor',
};
function eventLabel(value: string): string {
  const words = value.replace(/[._-]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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

export async function loadAudit(
  client: AuthClient,
  filters: AuditFilters,
  scope: string | null,
  features: { auditTrail: boolean } | null,
  organization: boolean | null,
): Promise<{
  data: AuditList | null;
  head: AuditHead | null;
  status: AuditStatus | null;
  error: string | null;
  explanation: string | null;
}> {
  const empty = { data: null, head: null, status: null };
  try {
    if (features === null || organization === null)
      return {
        ...empty,
        error: 'Audit capabilities could not be loaded. Try again.',
        explanation: null,
      };
    const explanation = organization
      ? 'You can read organization audit events and delivery status. Project scope limits the events shown.'
      : scope === null
        ? 'Organization audit access is required here. If you have project audit access, select that project.'
        : 'Reading this project’s events requires project audit access. Verification and capacity details are available to organization auditors.';
    const statusRequest = organization
      ? client.request('get', '/_pb/audit/status')
      : Promise.resolve(null);
    if (!features.auditTrail || (!organization && scope === null)) {
      const status = await statusRequest;
      return {
        ...empty,
        status: status?.ok ? status.data : null,
        error: status && !status.ok ? 'Audit status could not be loaded. Try again.' : null,
        explanation: !features.auditTrail
          ? `${explanation} The audit trail is inactive; local event history is unavailable.`
          : explanation,
      };
    }
    const query = {
      actor: filters.actor || undefined,
      action: filters.action || undefined,
      limit: filters.limit || undefined,
      after: filters.after || undefined,
    };
    const [list, head, status] = await Promise.all([
      scope === null
        ? client.request('get', '/_pb/audit', {
            query: { ...query, project: filters.project || undefined },
          })
        : client.request('get', '/_pb/projects/{project}/audit', {
            params: { project: scope },
            query,
          }),
      organization ? client.request('get', '/_pb/audit/head') : Promise.resolve(null),
      statusRequest,
    ]);
    return {
      data: list.ok ? list.data : null,
      head: head?.ok ? head.data : null,
      status: status?.ok ? status.data : null,
      explanation:
        !list.ok && list.status === 403
          ? 'You do not have access to audit events for this scope. Ask an organization administrator for audit access.'
          : explanation,
      error: !list.ok
        ? list.status === 403 || list.status === 404
          ? 'Audit events are unavailable for this scope. Audit permission and an active trail are required.'
          : 'Audit events could not be loaded. Try again.'
        : head && !head.ok
          ? 'Audit verification could not be loaded. Try again.'
          : status && !status.ok
            ? 'Audit status could not be loaded. Try again.'
            : null,
    };
  } catch {
    return {
      ...empty,
      error: 'Audit information could not be loaded. Try again.',
      explanation: null,
    };
  }
}

const modeLabels = { trail: 'Local audit trail', export: 'Export only', none: 'No durable audit' };
const sourceLabels: Record<string, string> = {
  build: 'build configuration',
  env: 'environment configuration',
  stored: 'saved organization settings',
};
const sinkLabels = {
  active: 'Active',
  inactive: 'Inactive: destination is not configured',
  blocked: 'Blocked: delivery needs operator review',
  disabled: 'Disabled',
  retired: 'Retired',
};
const incidentLabels: Record<string, string> = {
  gap: 'Missing event ranges',
  skipped: 'Skipped deliveries',
  uncertain: 'Uncertain deliveries',
  withheld: 'Withheld content',
  chain_reset: 'Chain integrity recoveries',
  epoch_bump: 'Journal generation changes',
  mode_change: 'Audit mode changes',
  policy_change: 'Audit policy changes',
  cutover: 'Mode transitions',
  rebind: 'Destination replacements',
  retire: 'Retired destinations',
  unblock: 'Delivery unblocks',
  restore_confirmed: 'Confirmed restores',
  export: 'Verified exports',
  replay: 'Delivery replays',
};
export function AuditStatusView({
  status,
  announceAlert = true,
}: {
  status: AuditStatus;
  announceAlert?: boolean;
}) {
  const loss = status.ledger.some((entry) => entry.kind === 'gap' && entry.count > 0);
  const severe =
    status.capacity.state === 'refusing'
      ? 'capacity'
      : loss
        ? 'loss'
        : status.restorePending
          ? 'restore'
          : status.health.status !== 'ok'
            ? 'health'
            : null;
  return (
    <section aria-label="Organization audit status" className="space-y-2">
      <h2 className="text-lg font-semibold">Organization audit status</h2>
      <p>
        Effective mode: {modeLabels[status.mode]}. Set by {sourceLabels[status.modeSource]}.
      </p>
      {status.mode === 'export' ? (
        <p>
          Events are sent to configured destinations. Local event history is unavailable without an
          active trail.
        </p>
      ) : null}
      {status.mode === 'none' ? (
        <p>No durable audit history is being kept. Changes may have no recoverable audit record.</p>
      ) : null}
      {status.pendingMode ? (
        <p>
          Pending mode: {modeLabels[status.pendingMode]}. The effective mode stays in use until the
          transition completes.
        </p>
      ) : null}
      <p>
        {status.policy === 'required'
          ? 'Required audit policy: durable audit is required; capacity can refuse ordinary changes.'
          : 'Availability policy: changes can continue when audit capacity is exhausted; older undelivered events may be lost.'}{' '}
        Set by {sourceLabels[status.policySource]}.
      </p>
      {status.capacity.state !== 'ok' ? (
        <p role={announceAlert && severe === 'capacity' ? 'alert' : 'status'}>
          {status.capacity.state === 'refusing'
            ? 'Audit capacity is full. Ordinary changes are refused until space is released.'
            : 'Audit capacity is under pressure. Review delivery destinations to prevent loss.'}
        </p>
      ) : null}
      {status.restorePending ? (
        <p role={announceAlert && severe === 'restore' ? 'alert' : 'status'}>
          Restore review is pending. Delivery is blocked until an operator confirms the journal.
        </p>
      ) : null}
      {status.health.status !== 'ok' ? (
        <p role={announceAlert && severe === 'health' ? 'alert' : 'status'}>
          Audit delivery needs attention. Review capacity, destinations and recorded incidents.
        </p>
      ) : null}
      <h3 className="font-medium">Delivery destinations</h3>
      {status.sinks.length ? (
        <ul>
          {status.sinks.map((sink, index) => (
            <li key={sink.id}>
              Destination {index + 1}: {sinkLabels[sink.state]}.{' '}
              {sink.activationSource === 'none'
                ? 'Not activated because no destination is configured'
                : `Activated by environment variable ${sink.activationSource}`}
              .{' '}
              {sink.durableAck
                ? 'Pruning requires a durable-storage acknowledgement.'
                : 'Delivery acknowledgements do not confirm durable storage.'}
            </li>
          ))}
        </ul>
      ) : (
        <p>No delivery destinations are configured.</p>
      )}
      <h3 className="font-medium">
        Recorded incidents and changes in the current journal generation
      </h3>
      {status.ledger.some((entry) => entry.count > 0) ? (
        <ul>
          {status.ledger
            .filter((entry) => entry.count > 0)
            .map((entry) => (
              <li key={entry.kind}>
                {incidentLabels[entry.kind] ?? 'Other recorded incidents'}: {entry.count}
              </li>
            ))}
        </ul>
      ) : (
        <p>No incidents or changes recorded in this journal generation.</p>
      )}
      {loss ? (
        <p role={announceAlert && severe === 'loss' ? 'alert' : 'status'}>
          Events are missing from recorded history, including possible capacity loss. Later
          verification does not recover missing events.
        </p>
      ) : null}
    </section>
  );
}

export function AuditView(props: {
  filters: AuditFilters;
  scope: string | null;
  data: AuditList | null;
  head: AuditHead | null;
  error: string | null;
  explanation?: string | null;
  status?: AuditStatus | null;
  loading: boolean;
  projects?: readonly { id: string; name: string }[];
  onNavigate: (filters: AuditFilters) => void;
}) {
  return (
    <section aria-labelledby="page-heading" className="space-y-4">
      <h1 tabIndex={-1} id="page-heading" className="text-2xl font-semibold">
        Audit
      </h1>
      {props.explanation ? <p>{props.explanation}</p> : null}
      {props.status ? (
        <AuditStatusView status={props.status} announceAlert={props.error === null} />
      ) : null}
      {props.head === null ? null : (
        <section className="space-y-2" aria-labelledby="audit-verification-heading">
          <h2 id="audit-verification-heading" className="text-lg font-semibold">
            Audit verification
          </h2>
          <Badge variant="outline">{`Latest event ${props.head.seq}`}</Badge>
          <div>
            {props.head.verification !== null &&
            props.head.verification.fromSeq <= props.head.verification.throughSeq ? (
              <>
                {props.head.verification.bodies === 0 ? (
                  <p>
                    Range {props.head.verification.fromSeq}–{props.head.verification.throughSeq} was
                    checked, but every event body was withheld; no content was verified.
                  </p>
                ) : (
                  <>
                    <p>
                      Verified retained range: {props.head.verification.fromSeq}–
                      {props.head.verification.throughSeq}.
                    </p>
                    <p>
                      {props.head.verification.bodies} event bodies checked;{' '}
                      {props.head.verification.withheld} withheld bodies. Verified{' '}
                      <Time value={props.head.verification.verifiedAt} />.
                    </p>
                  </>
                )}
                <p>
                  Verification covers this retained range only; it does not prove complete
                  historical delivery or verify withheld content.
                </p>
              </>
            ) : (
              <p>No verified retained range is available.</p>
            )}
          </div>
          {props.head.pendingCount > 0 ? (
            <Badge variant="secondary">{`${props.head.pendingCount} ${props.head.pendingCount === 1 ? 'event' : 'events'} not yet sealed`}</Badge>
          ) : null}
        </section>
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
            Try again
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
                {
                  key: 'seq',
                  label: 'Sequence',
                  value: (item) => item.seq,
                  render: (item) =>
                    isWithheld(item) ? (
                      <>
                        {item.seq}
                        <span className="block">
                          {item.reason === 'content'
                            ? 'Content withheld: the stored record differs from its safe form'
                            : 'Record unreadable'}
                        </span>
                      </>
                    ) : (
                      item.seq
                    ),
                },
                {
                  key: 'time',
                  label: 'Time',
                  value: (item) => (isWithheld(item) ? '' : item.createdAt),
                  render: (item) => (isWithheld(item) ? null : <Time value={item.createdAt} />),
                },
                {
                  key: 'action',
                  label: 'Action',
                  value: (item) => (isWithheld(item) ? '' : eventLabel(item.action)),
                },
                {
                  key: 'actor',
                  label: 'Actor',
                  value: (item) => (isWithheld(item) ? '' : (item.actor.id ?? '')),
                  render: (item) =>
                    isWithheld(item) ? null : (
                      <>
                        <span className="block text-xs text-neutral-600">
                          {actorLabels[item.actor.type] ?? 'Actor type unavailable'}
                        </span>
                        <AuditReference id={item.actor.id} label="actor" />
                      </>
                    ),
                },
                {
                  key: 'project',
                  label: 'Project',
                  priority: 2,
                  value: (item) => (isWithheld(item) ? '' : (item.projectId ?? '')),
                  render: (item) =>
                    isWithheld(item) ? null : (
                      <AuditReference
                        id={item.projectId}
                        label="project"
                        name={
                          props.projects?.find((project) => project.id === item.projectId)?.name
                        }
                      />
                    ),
                },
                {
                  key: 'targetType',
                  label: 'Target type',
                  priority: 2,
                  value: (item) => (isWithheld(item) ? '' : eventLabel(item.targetType)),
                },
                {
                  key: 'targetId',
                  label: 'Target',
                  priority: 3,
                  value: (item) => (isWithheld(item) ? '' : (item.targetId ?? '')),
                  render: (item) =>
                    isWithheld(item) ? null : <AuditReference id={item.targetId} label="target" />,
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
                  ? 'No audit events match these filters.'
                  : 'No audit events yet. Create a project or change its settings, then return to see the recorded events.'
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
  const {
    client,
    features,
    organizationAuditor = null,
    projects,
    refreshAuditCapabilities,
  } = useServices();
  const [hash, setHash] = useState(() => window.location.hash);
  const [result, setResult] = useState<Awaited<ReturnType<typeof loadAudit>>>({
    data: null,
    head: null,
    status: null,
    explanation: null,
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
    setResult({ data: null, head: null, status: null, explanation: null, error: null });
    const { filters, scope } = readAuditHash(hash);
    if (features === undefined) return;
    void loadAudit(client, filters, scope, features, organizationAuditor).then((next) => {
      if (live) {
        setResult(next);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [client, features, organizationAuditor, hash, reload]);
  const { filters, scope } = readAuditHash(hash);
  return (
    <AuditView
      {...(features === undefined
        ? { data: null, head: null, status: null, explanation: null, error: null }
        : result)}
      projects={projects ?? []}
      filters={filters}
      scope={scope}
      loading={features === undefined || loading}
      onNavigate={(next) => {
        if (features === null || organizationAuditor === null) void refreshAuditCapabilities?.();
        const target = auditHash(next, scope);
        if (window.location.hash === target) setReload((value) => value + 1);
        else window.location.hash = target;
      }}
    />
  );
}
