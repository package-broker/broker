import { brokerNotificationsProblems, notificationsEnabled, type BrokerConfig } from '../config.js';
import type {
  NotificationAttemptRepository,
  NotificationDispatchRepository,
  NotificationPrepareRepository,
  NotificationRetentionRepository,
} from '../db/notifications.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import type { RegisteredCoreJob } from '../kernel/registry.js';
import {
  createNotificationCredentials,
  type NotificationCredentials,
  type NotificationCredentialsDeps,
} from '../notifications/credentials.js';
import { createNotificationDeliverJob } from '../notifications/deliver.js';
import { createNotificationDispatchJob } from '../notifications/dispatch.js';
import {
  createNotificationBodies,
  type NotificationBodies,
} from '../notifications/prepare-delivery.js';
import { createNotificationRetentionJob } from '../notifications/retention.js';
import type { NotificationTransport } from '../notifications/transport.js';
import type { JobDefinition } from '../platform/jobs.js';
import { registerCoreJob } from './core-jobs.js';

export {
  MAX_NOTIFICATION_BODY_BYTES,
  NOTIFICATION_CONNECT_TIMEOUT_MS,
  NOTIFICATION_TIMEOUT_MS,
  NotificationDestinationRefused,
  NotificationRequestError,
  createNotificationTransport,
  type NotificationRequest,
  type NotificationSend,
  type NotificationSendInit,
  type NotificationTransport,
  type NotificationTransportDeps,
  type NotificationTransportResult,
} from '../notifications/transport.js';
export { notificationHeaders, verifyNotificationSignature } from '../notifications/signature.js';
export { createNotificationCredentials } from '../notifications/credentials.js';
export { createNotificationEndpointService } from '../notifications/endpoints.js';
export { notificationsEnabled, brokerNotificationsProblems } from '../config.js';

export interface NotificationRepositories {
  readonly dispatch: NotificationDispatchRepository;
  readonly attempts: NotificationAttemptRepository;
  readonly prepare: NotificationPrepareRepository;
  readonly retention: NotificationRetentionRepository;
}

export interface NotificationRuntimeInput {
  readonly notifications: BrokerConfig['notifications'] | undefined;
  /** Null when this runtime cannot deliver; notifications then stay off. */
  readonly transport: NotificationTransport | null;
  /** Built only when notifications are on. */
  readonly repositories: () => NotificationRepositories;
  /** Resolved on the first delivery, so the keyring may be bound after registration. */
  readonly credentials: () => NotificationCredentialsDeps;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  /** Best-effort wakeup of a committed job; polling and cron recover a lost one. */
  readonly wake: (ctx: OrgContext, jobId: string) => Promise<void>;
}

export interface NotificationRuntime {
  /** Mutation stores capture notification work only when this is true. */
  readonly enabled: boolean;
  readonly jobs: readonly RegisteredCoreJob[];
}

export class NotificationRuntimeConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super('Invalid notifications configuration');
    this.name = 'NotificationRuntimeConfigError';
  }
}

/** Whether notifications are on; an invalid block throws with the fixed build problems. */
export function notificationsSwitch(value: BrokerConfig['notifications'] | undefined): boolean {
  const config = (value === undefined ? {} : { notifications: value }) as BrokerConfig;
  const problems = brokerNotificationsProblems(config);
  if (problems.length > 0) throw new NotificationRuntimeConfigError(problems);
  return notificationsEnabled(config);
}

function register<P>(definition: JobDefinition<P>): RegisteredCoreJob {
  return registerCoreJob({
    ...definition,
    handler: (payload, context) => definition.handler(definition.validate(payload), context),
  });
}

/**
 * The notification jobs a runtime registers. With `notifications.enabled` off, or without a
 * transport, nothing is registered and no store captures work.
 */
export function notificationRuntime(input: NotificationRuntimeInput): NotificationRuntime {
  if (!notificationsSwitch(input.notifications) || input.transport === null)
    return { enabled: false, jobs: [] };
  const repositories = input.repositories();
  let sealed: { credentials: NotificationCredentials; bodies: NotificationBodies } | undefined;
  const opened = () => {
    if (sealed === undefined) {
      const deps = input.credentials();
      sealed = {
        credentials: createNotificationCredentials(deps),
        bodies: createNotificationBodies(deps),
      };
    }
    return sealed;
  };
  const credentials: Pick<NotificationCredentials, 'open'> = {
    open: (...args) => opened().credentials.open(...args),
  };
  const bodies: NotificationBodies = {
    prepare: (...args) => opened().bodies.prepare(...args),
    open: (...args) => opened().bodies.open(...args),
  };
  return {
    enabled: true,
    jobs: [
      register(
        createNotificationDispatchJob({ dispatch: repositories.dispatch, wake: input.wake }),
      ),
      register(
        createNotificationDeliverJob({
          attempts: repositories.attempts,
          prepare: repositories.prepare,
          credentials,
          bodies,
          transport: input.transport,
          clock: input.clock,
          ids: input.ids,
        }),
      ),
      register(
        createNotificationRetentionJob({
          retention: repositories.retention,
          clock: input.clock,
          ids: input.ids,
          wake: input.wake,
        }),
      ),
    ],
  };
}
