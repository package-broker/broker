import type { ApiResult } from '../api.js';
import type { ShellServices } from '../auth.js';
import { saveNotificationDraft } from './notification-draft.js';
import type { operations } from '../api-types.js';

export type Endpoint =
  operations['getNotificationEndpoint']['responses'][200]['content']['application/json'];
export type Delivery =
  operations['listNotificationDeliveries']['responses'][200]['content']['application/json']['items'][number];
export type DeliveryDetail =
  operations['getNotificationDelivery']['responses'][200]['content']['application/json'];
export type EventType = Endpoint['events'][number];
type CreateBody =
  operations['createNotificationEndpoint']['requestBody']['content']['application/json'];
export type Options = Omit<CreateBody, 'secret'>;
export type Secret = CreateBody['secret'];

export const EVENT_CHOICES: readonly { value: EventType; label: string; help: string }[] = [
  {
    value: 'npm.package.published',
    label: 'Version published',
    help: 'A new local version is available immediately after publishing.',
  },
  {
    value: 'npm.package.released',
    label: 'Held version released',
    help: 'A version held for approval or scanning becomes available.',
  },
  {
    value: 'npm.package.unpublished',
    label: 'Version or package removed',
    help: 'A version or the whole package is unpublished or tombstoned.',
  },
  {
    value: 'npm.package.deprecation_changed',
    label: 'Deprecation changed',
    help: 'A version is deprecated or its deprecation is cleared. The message is not sent.',
  },
  {
    value: 'npm.package.dist_tag_changed',
    label: 'Dist-tag changed',
    help: 'A dist-tag is added, moved or deleted, including moves caused by an unpublish.',
  },
];

export const eventLabel = (type: EventType) =>
  EVENT_CHOICES.find((choice) => choice.value === type)?.label ?? 'Unknown event';

export function stateSentence(endpoint: Pick<Endpoint, 'state' | 'disabledReason'>): string {
  if (endpoint.state === 'enabled') return 'Sending new events.';
  switch (endpoint.disabledReason) {
    case 'configuration_changed':
      return 'Disabled because its delivery settings were replaced. Enable it to resume sending.';
    case 'failures':
      return 'Disabled after 10 deliveries in a row failed. Check the receiver, then enable it.';
    case 'credentials':
      return 'Disabled because the receiver refused the request (401 or 403). Replace the delivery settings, then enable it.';
    case 'policy':
      return 'Disabled because the destination is not allowed. Replace the destination, then enable it.';
    case 'gone':
      return 'Disabled because the receiver reported that it no longer exists (410).';
    case 'manual':
      return 'Disabled. No events are sent until it is enabled.';
    default:
      return 'Not enabled yet. No events are sent until it is enabled.';
  }
}

const OUTCOMES: Readonly<Record<NonNullable<Delivery['outcomeCode']>, string>> = {
  ok: 'Delivered',
  network: 'Could not connect',
  timeout: 'Receiver did not answer in time',
  http_retry: 'Receiver asked to retry',
  http_permanent: 'Receiver refused the event',
  redirect: 'Receiver answered with a redirect, which is not followed',
  policy: 'Destination not allowed',
  credentials: 'Delivery settings could not be used',
  template: 'Body template could not be applied',
  unknown: 'Result unknown; the receiver may have processed it',
  expired: 'Expired after 24 hours',
  attempt_limit: 'Stopped after 8 attempts',
  disabled: 'Cancelled because the endpoint was disabled',
  superseded: 'Cancelled because the endpoint changed',
  project_inactive: 'Cancelled because the project is archived',
  admission_lost: 'Cancelled because the source left the project',
  deleted: 'Cancelled because the endpoint was deleted',
};

export function deliveryOutcome(delivery: Pick<Delivery, 'state' | 'outcomeCode'>): string {
  if (delivery.state === 'pending') return 'Waiting to send';
  if (delivery.state === 'sending') return 'Sending';
  return delivery.outcomeCode === null ? 'Finished' : OUTCOMES[delivery.outcomeCode];
}

export function notice(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  if (result.status === 412 || result.status === 428 || result.code === 'conflict')
    return 'This endpoint changed while you were editing. Reload the latest settings before saving.';
  switch (result.code) {
    case 'invalid_configuration':
      return 'The broker refused these settings. Use an HTTPS address on a public host, a 43-character signing key, permitted headers and a valid template.';
    case 'invalid_request':
      return 'Check the entered values and try again.';
    case 'endpoint_limit':
      return 'This project already has 20 notification endpoints. Remove one before adding another.';
    case 'transport_unavailable':
      return 'This broker cannot send notifications, so the endpoint cannot be enabled.';
    case 'forbidden':
      return 'You do not have permission to change notifications in this project.';
    case 'not_found':
      return 'This endpoint no longer exists. Reload the list.';
    default:
      return 'The request could not be completed. Try again.';
  }
}

const base = (project: string) => ({ params: { project } });
const one = (project: string, endpoint: Pick<Endpoint, 'id' | 'revision'>) => ({
  params: { project, id: endpoint.id },
  headers: { 'If-Match': `"r${endpoint.revision}"` },
});

export type ActionOutcome =
  | { ok: true; endpoint: Endpoint | null; message: string }
  | { ok: false; message: string; stale: boolean; reauth: boolean };

function failed(
  services: ShellServices,
  result: Extract<ApiResult<unknown>, { ok: false }>,
  secret: boolean,
): ActionOutcome {
  if (result.code === 'reauth_required') {
    services.requireReauth(
      secret ? { method: result.request.method, path: result.request.path } : result.request,
      { credential: secret, secretFields: [] },
    );
    return {
      ok: false,
      reauth: true,
      stale: false,
      message: secret
        ? 'Reauthenticate, then enter the delivery settings again. Nothing was saved.'
        : 'Reauthentication is required. Confirm the action again after signing in.',
    };
  }
  return {
    ok: false,
    reauth: false,
    stale: result.status === 412 || result.status === 428 || result.code === 'conflict',
    message: notice(result),
  };
}

const discarded: ActionOutcome = { ok: false, message: '', stale: false, reauth: false };

/** Delivery settings are sent once and never kept: a reauthentication must not replay them. */
export async function createEndpoint(
  services: ShellServices,
  project: string,
  options: Options,
  secret: Secret,
  isCurrent: () => boolean = () => true,
): Promise<ActionOutcome> {
  const result = await services.client.request('post', '/_pb/projects/{project}/notifications', {
    ...base(project),
    body: { ...options, secret },
  });
  if (!isCurrent()) return discarded;
  if (!result.ok) {
    if (result.code === 'reauth_required') saveNotificationDraft(project, null, options);
    return failed(services, result, true);
  }
  return {
    ok: true,
    endpoint: result.data,
    message: 'Endpoint added. It stays disabled until you enable it.',
  };
}

export async function updateEndpoint(
  services: ShellServices,
  project: string,
  endpoint: Pick<Endpoint, 'id' | 'revision'>,
  change: { options?: Options; secret?: Secret },
  isCurrent: () => boolean = () => true,
): Promise<ActionOutcome> {
  const result = await services.client.request(
    'patch',
    '/_pb/projects/{project}/notifications/{id}',
    { ...one(project, endpoint), body: change },
  );
  if (!isCurrent()) return discarded;
  if (!result.ok) {
    if (
      result.code === 'reauth_required' &&
      change.secret !== undefined &&
      change.options !== undefined
    )
      saveNotificationDraft(project, endpoint, change.options);
    return failed(services, result, change.secret !== undefined);
  }
  return {
    ok: true,
    endpoint: result.data,
    message:
      change.secret === undefined
        ? 'Endpoint saved. Waiting deliveries for the previous settings were cancelled.'
        : 'Delivery settings replaced. The endpoint is disabled and waiting deliveries were cancelled; enable it to resume.',
  };
}

export async function setEnabled(
  services: ShellServices,
  project: string,
  endpoint: Pick<Endpoint, 'id' | 'revision'>,
  enabled: boolean,
  isCurrent: () => boolean = () => true,
): Promise<ActionOutcome> {
  const result = await services.client.request(
    'post',
    enabled
      ? '/_pb/projects/{project}/notifications/{id}/enable'
      : '/_pb/projects/{project}/notifications/{id}/disable',
    one(project, endpoint),
  );
  if (!isCurrent()) return discarded;
  if (!result.ok) return failed(services, result, false);
  return {
    ok: true,
    endpoint: result.data,
    message: enabled
      ? 'Endpoint enabled. Only events from now on are sent; earlier events are not replayed.'
      : 'Endpoint disabled. No new events are sent; waiting deliveries are cancelled.',
  };
}

export async function deleteEndpoint(
  services: ShellServices,
  project: string,
  endpoint: Pick<Endpoint, 'id' | 'revision'>,
  isCurrent: () => boolean = () => true,
): Promise<ActionOutcome> {
  const result = await services.client.request(
    'delete',
    '/_pb/projects/{project}/notifications/{id}',
    one(project, endpoint),
  );
  if (!isCurrent()) return discarded;
  if (!result.ok) return failed(services, result, false);
  return {
    ok: true,
    endpoint: null,
    message: 'Endpoint removed. Its waiting deliveries were cancelled.',
  };
}
