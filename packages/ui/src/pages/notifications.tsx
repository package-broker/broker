import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useServices, type ShellServices } from '../auth.js';
import { Button } from '../components/ui/button.js';
import { ConfirmAction } from '../components/ui/confirm-action.js';
import { ListState } from '../components/ui/list-state.js';
import { RowActions } from '../components/ui/row-actions.js';
import { Select } from '../components/ui/select.js';
import { StatusBadge } from '../components/ui/status-badge.js';
import { DataTable } from '../components/ui/table.js';
import { Time } from '../components/ui/time.js';
import {
  createEndpoint,
  deleteEndpoint,
  deliveryOutcome,
  eventLabel,
  setEnabled,
  stateSentence,
  updateEndpoint,
  type ActionOutcome,
  type DeliveryDetail,
  type Endpoint,
} from './notification-actions.js';
import { takeNotificationDraft } from './notification-draft.js';
import type { Options } from './notification-actions.js';
import { NotificationForm } from './notification-form.js';
import {
  createNotificationsController,
  type DeliveryFilter,
  type NotificationsController,
} from './notifications-controller.js';

const MAX_ENDPOINTS = 20;
const FILTERS: readonly { value: DeliveryFilter; label: string }[] = [
  { value: 'all', label: 'All deliveries' },
  { value: 'pending', label: 'Waiting' },
  { value: 'sending', label: 'Sending' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function useProjectSlug(): string | null {
  const hash = useSyncExternalStore(
    (listener) => {
      window.addEventListener('hashchange', listener);
      return () => window.removeEventListener('hashchange', listener);
    },
    () => window.location.hash,
    () => '',
  );
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  const project = query.get('project');
  return project !== null && /^[A-Za-z0-9._-]{1,64}$/.test(project) ? project : null;
}

export function NotificationsView(props: {
  services: ShellServices;
  controller: NotificationsController;
  project: string | null;
  projectName: string | null;
}) {
  const { services, controller, project } = props;
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const [form, setForm] = useState<'new' | Endpoint | null>(null);
  const restoredDraft = useRef<{
    project: string | null;
    value: ReturnType<typeof takeNotificationDraft>;
  } | null>(null);
  const [restored, setRestored] = useState<Options | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Endpoint | null>(null);
  useEffect(() => {
    setForm(null);
    setRestored(null);
    setBusy(null);
    setDeleting(null);
    setMessage(null);
    setFailure(null);
    setStale(false);
    void controller.load(project);
    const isCurrent = controller.mutationScope();
    if (restoredDraft.current?.project !== project)
      restoredDraft.current = {
        project,
        value: project === null ? null : takeNotificationDraft(project),
      };
    const draft = restoredDraft.current.value;
    if (draft !== null) {
      const restore = (endpoint: Endpoint | 'new') => {
        if (!isCurrent()) return;
        setForm(endpoint);
        setRestored(draft.options);
        setMessage(
          'Draft restored. Review it and enter the delivery settings again before saving.',
        );
        if (endpoint !== 'new' && endpoint.revision !== draft.endpoint?.revision) {
          setStale(true);
          setFailure(
            'This endpoint changed while you were editing. Reload the latest settings before saving.',
          );
        }
      };
      if (draft.endpoint === null) restore('new');
      else
        void services.client
          .request('get', '/_pb/projects/{project}/notifications/{id}', {
            params: { project: draft.project, id: draft.endpoint.id },
          })
          .then((result) => {
            if (result.ok) restore(result.data);
            else if (isCurrent())
              setFailure('The draft endpoint could not be loaded. Reload the list.');
          });
    }
    return () => controller.dispose();
  }, [controller, project, services]);
  const projectLabel = props.projectName ?? project ?? '';
  const settle = (id: string | null, outcome: ActionOutcome) => {
    if (outcome.ok) {
      if (outcome.endpoint !== null) controller.replace(outcome.endpoint.id, outcome.endpoint);
      else if (id !== null) controller.replace(id, null);
      setMessage(outcome.message);
      setFailure(null);
      setStale(false);
    } else {
      setMessage(null);
      setFailure(outcome.message);
      setStale(outcome.stale);
    }
    return outcome;
  };
  const act = async (
    endpoint: Endpoint,
    run: (isCurrent: () => boolean) => Promise<ActionOutcome>,
  ) => {
    if (busy !== null || project === null) return;
    const isCurrent = controller.mutationScope();
    setBusy(endpoint.id);
    const outcome = await run(isCurrent);
    if (!isCurrent()) return;
    settle(endpoint.id, outcome);
    setBusy(null);
  };
  const selected = state.items.find((item) => item.id === state.selected) ?? null;

  if (project === null)
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <ListState kind="placeholder" title="Choose a project to manage its notifications.">
          <p>Notification endpoints belong to one project. Pick it in the Scope menu.</p>
        </ListState>
      </section>
    );

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Notifications</h1>
      <p>
        {`Project ${projectLabel} · Send a signed request to your own HTTPS receiver when a package in this project is published, released, removed, deprecated or re-tagged. Delivery is retried for up to 24 hours and is not guaranteed.`}
      </p>
      <div role="status" aria-live="polite">
        {message}
      </div>
      {failure === null ? null : (
        <div role="alert" className="space-y-2 text-red-700">
          <p>{failure}</p>
          {stale ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setStale(false);
                setFailure(null);
                setForm(null);
                void controller.load();
              }}
            >
              Reload latest settings
            </Button>
          ) : null}
        </div>
      )}
      {state.blocked === 'denied' ? (
        <ListState kind="error" title="You cannot manage notifications in this project.">
          <p>Changing project settings in a signed-in session is required.</p>
        </ListState>
      ) : state.blocked === 'unavailable' ? (
        <ListState kind="placeholder" title="Notifications are not available.">
          <p>
            This broker has notifications turned off, or the project is archived or not visible to
            you.
          </p>
        </ListState>
      ) : state.blocked === 'error' ? (
        <ListState kind="error" title="Notification endpoints could not be loaded. Try again.">
          <Button type="button" className="min-h-11" onClick={() => void controller.load()}>
            Try again
          </Button>
        </ListState>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {form === null ? (
              <Button
                type="button"
                className="min-h-11 w-full sm:w-auto"
                disabled={state.loading || state.items.length >= MAX_ENDPOINTS}
                aria-describedby={
                  state.items.length >= MAX_ENDPOINTS ? 'notification-limit' : undefined
                }
                onClick={() => {
                  setMessage(null);
                  setFailure(null);
                  setRestored(null);
                  setForm('new');
                }}
              >
                Add endpoint
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
              disabled={state.loading}
              onClick={() => void controller.load()}
            >
              Reload
            </Button>
          </div>
          {state.items.length >= MAX_ENDPOINTS ? (
            <p id="notification-limit">A project can have at most 20 endpoints.</p>
          ) : null}
          {form === null ? null : (
            <NotificationForm
              key={`${project}/${form === 'new' ? 'new' : form.id}`}
              projectName={projectLabel}
              endpoint={form === 'new' ? null : form}
              disabled={stale}
              {...(restored === null ? {} : { restoredOptions: restored, requireSecret: true })}
              onCancel={() => setForm(null)}
              onSubmit={async (change) => {
                const isCurrent = controller.mutationScope();
                const outcome =
                  form === 'new'
                    ? await createEndpoint(
                        services,
                        project,
                        change.options,
                        change.secret!,
                        isCurrent,
                      )
                    : await updateEndpoint(services, project, form, change, isCurrent);
                if (!isCurrent()) return outcome;
                settle(null, outcome);
                if (outcome.ok) setForm(null);
                return outcome;
              }}
            />
          )}
          {state.loading ? (
            <ListState kind="loading" title="Loading notification endpoints…" />
          ) : state.items.length === 0 ? (
            <ListState
              kind="empty"
              title={
                state.hasPrevious
                  ? 'No endpoints on this page.'
                  : 'No notification endpoints yet. Add one to tell another system about package changes.'
              }
            />
          ) : (
            <DataTable
              label={`Notification endpoints in ${projectLabel}`}
              items={state.items}
              {...(state.selected === null ? {} : { selectedId: state.selected })}
              columns={[
                {
                  key: 'name',
                  label: 'Endpoint',
                  value: (item) => item.name,
                  render: (item) => (
                    <div className="break-words">
                      <strong>{item.name}</strong>
                      <p className="text-sm text-neutral-600">
                        {item.method} · signed
                        {item.headersConfigured ? ' · custom headers' : ''}
                        {item.templateConfigured ? ' · body template' : ''}
                      </p>
                    </div>
                  ),
                },
                {
                  key: 'events',
                  label: 'Events and packages',
                  value: (item) => item.events.length,
                  render: (item) => (
                    <div className="break-words">
                      <p>{item.events.map(eventLabel).join(', ')}</p>
                      <p className="font-mono text-sm">{item.packagePattern}</p>
                    </div>
                  ),
                },
                {
                  key: 'state',
                  label: 'Status',
                  value: (item) => item.state,
                  render: (item) => (
                    <div className="space-y-1">
                      <StatusBadge status={item.state} />
                      <p className="text-sm">{stateSentence(item)}</p>
                      {item.failureStreak > 0 ? (
                        <p className="text-sm">
                          {`${item.failureStreak} failed ${item.failureStreak === 1 ? 'delivery' : 'deliveries'} in a row.`}
                        </p>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: 'updated',
                  label: 'Changed',
                  value: (item) => item.updatedAt,
                  priority: 2,
                  render: (item) => <Time value={item.updatedAt} />,
                },
                {
                  key: 'actions',
                  label: 'Actions',
                  value: () => '',
                  sortable: false,
                  render: (item) => (
                    <RowActions
                      entityLabel={item.name}
                      actions={[
                        {
                          id: 'history',
                          label: 'Delivery history',
                          onSelect: () => void controller.select(item.id),
                        },
                      ]}
                      overflow={[
                        {
                          id: 'edit',
                          label: 'Edit',
                          disabled: busy !== null || stale,
                          onSelect: () => {
                            setMessage(null);
                            setFailure(null);
                            setRestored(null);
                            setForm(item);
                          },
                        },
                        item.state === 'enabled'
                          ? {
                              id: 'disable',
                              label: 'Disable',
                              pending: busy === item.id,
                              disabled: stale,
                              onSelect: () =>
                                void act(item, (isCurrent) =>
                                  setEnabled(services, project, item, false, isCurrent),
                                ),
                            }
                          : {
                              id: 'enable',
                              label: 'Enable',
                              pending: busy === item.id,
                              disabled: stale,
                              onSelect: () =>
                                void act(item, (isCurrent) =>
                                  setEnabled(services, project, item, true, isCurrent),
                                ),
                            },
                        {
                          id: 'delete',
                          label: 'Remove',
                          variant: 'destructive',
                          disabled: busy !== null || stale,
                          onSelect: () => setDeleting(item),
                        },
                      ]}
                    />
                  ),
                },
              ]}
            />
          )}
          <p>
            {`${state.items.length} ${state.items.length === 1 ? 'endpoint' : 'endpoints'} on this page`}
          </p>
          {state.hasPrevious || state.next !== null ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={state.loading || !state.hasPrevious}
                onClick={() => void controller.previousPage()}
              >
                Previous endpoints
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={state.loading || state.next === null}
                onClick={() => void controller.nextPage()}
              >
                Next endpoints
              </Button>
            </div>
          ) : null}
          {deleting === null ? null : (
            <ConfirmAction
              action="Remove endpoint"
              target={deleting.name}
              scope={`Project ${projectLabel}`}
              description="No further events are sent to this receiver and deliveries still waiting are cancelled. A request already on its way cannot be recalled. Removing it needs a recent sign-in and cannot be undone."
              open
              hideTrigger
              onOpenChange={(open) => {
                if (!open) setDeleting(null);
              }}
              onConfirm={() => {
                const target = deleting;
                setDeleting(null);
                void act(target, (isCurrent) =>
                  deleteEndpoint(services, project, target, isCurrent),
                );
              }}
            />
          )}
          {selected === null ? null : <History controller={controller} name={selected.name} />}
        </>
      )}
    </section>
  );
}

function attemptText(attempt: DeliveryDetail['history'][number]): string {
  const outcome =
    attempt.outcome === 'started'
      ? 'started, result not recorded yet'
      : deliveryOutcome({
          state: attempt.outcome === 'delivered' ? 'delivered' : 'failed',
          outcomeCode: attempt.outcomeCode,
        });
  return `${outcome}${attempt.status === null ? '' : ` (HTTP ${attempt.status})`}${attempt.durationMs === null ? '' : `, ${attempt.durationMs} ms`}`;
}

function History({ controller, name }: { controller: NotificationsController; name: string }) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  return (
    <section aria-labelledby="delivery-history" className="space-y-4">
      <h2 id="delivery-history" className="text-lg font-semibold">
        {`Delivery history: ${name}`}
      </h2>
      <p>
        Finished deliveries are kept for seven days. Request and response bodies, addresses and
        headers are never stored.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1">
          Show
          <Select
            value={state.filter}
            onChange={(event) =>
              void controller.filterHistory(event.target.value as DeliveryFilter)
            }
          >
            {FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </Select>
        </label>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={state.deliveriesLoading}
          onClick={() => void controller.reloadHistory()}
        >
          Reload history
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => void controller.select(null)}
        >
          Close history
        </Button>
      </div>
      {state.deliveriesLoading ? (
        <ListState kind="loading" title="Loading deliveries…" />
      ) : state.deliveriesError ? (
        <ListState kind="error" title="Deliveries could not be loaded. Try again.">
          <Button
            type="button"
            className="min-h-11"
            onClick={() => void controller.reloadHistory()}
          >
            Try again
          </Button>
        </ListState>
      ) : state.deliveries.length === 0 ? (
        <ListState
          kind={state.filter === 'all' ? 'empty' : 'filtered-empty'}
          title={
            state.filter === 'all'
              ? 'No deliveries yet. Events committed while the endpoint is enabled appear here.'
              : 'No deliveries match this filter on this page.'
          }
        />
      ) : (
        <DataTable
          label={`Deliveries to ${name}`}
          items={state.deliveries}
          columns={[
            {
              key: 'event',
              label: 'Event',
              value: (item) => item.eventType,
              render: (item) => eventLabel(item.eventType),
            },
            {
              key: 'created',
              label: 'Created',
              value: (item) => item.createdAt,
              render: (item) => <Time value={item.createdAt} />,
            },
            {
              key: 'result',
              label: 'Result',
              value: (item) => item.state,
              render: (item) => (
                <div className="space-y-1">
                  <StatusBadge status={item.state} />
                  <p className="text-sm">
                    {`${deliveryOutcome(item)}${item.lastStatus === null ? '' : ` (HTTP ${item.lastStatus})`}`}
                  </p>
                  {item.nextAttemptAt === null ? null : (
                    <p className="text-sm">
                      Next attempt <Time value={item.nextAttemptAt} />
                    </p>
                  )}
                </div>
              ),
            },
            {
              key: 'attempts',
              label: 'Attempts',
              value: (item) => item.attempts,
              render: (item) => `${item.attempts} of 8`,
            },
            {
              key: 'actions',
              label: 'Actions',
              value: () => '',
              sortable: false,
              render: (item) => (
                <RowActions
                  entityLabel={`${eventLabel(item.eventType)} delivery`}
                  actions={[
                    {
                      id: 'attempts',
                      label: 'Show attempts',
                      onSelect: () => void controller.openDelivery(item.id),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      )}
      {state.deliveriesHasPrevious || state.deliveriesNext !== null ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={state.deliveriesLoading || !state.deliveriesHasPrevious}
            onClick={() => void controller.previousHistory()}
          >
            Newer deliveries
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={state.deliveriesLoading || state.deliveriesNext === null}
            onClick={() => void controller.nextHistory()}
          >
            Older deliveries
          </Button>
        </div>
      ) : null}
      {state.detailError ? (
        <p role="alert">The attempts of this delivery could not be loaded.</p>
      ) : state.detail === null ? null : (
        <section aria-labelledby="delivery-attempts" className="space-y-2">
          <h3 id="delivery-attempts" className="font-semibold">
            {`Attempts for the ${eventLabel(state.detail.eventType)} delivery`}
          </h3>
          {state.detail.history.length === 0 ? (
            <p>No attempt has started.</p>
          ) : (
            <ol className="list-decimal space-y-1 pl-6">
              {state.detail.history.map((attempt) => (
                <li key={attempt.attempt}>
                  <Time value={attempt.startedAt} />
                  {`: ${attemptText(attempt)}`}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </section>
  );
}

export function NotificationsPage() {
  const services = useServices();
  const controller = useMemo(() => createNotificationsController(services), [services]);
  const project = useProjectSlug();
  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    setProjectName(null);
    if (project === null) return;
    let live = true;
    void services.client
      .request('get', '/_pb/projects/{project}', { params: { project } })
      .then((result) => {
        if (live && result.ok) setProjectName(result.data.name);
      });
    return () => {
      live = false;
    };
  }, [services, project]);
  return (
    <NotificationsView
      services={services}
      controller={controller}
      project={project}
      projectName={projectName}
    />
  );
}
