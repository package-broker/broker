import { auditEvent, type AuditContext, type AuditEvent } from '../audit/actions.js';
import { fenceKind, type MutationFence } from '../authz/fence.js';
import {
  NotificationRepositoryError,
  isNotificationEndpointName,
  notificationEventSelection,
  type NotificationEndpointSummary,
  type NotificationPublicOptions,
  type NotificationReadRepository,
  type NotificationSealedConfiguration,
  type NotificationWriteRepository,
} from '../db/notifications.js';
import type { OrgContext } from '../db/port.js';
import {
  validateNotificationDestination,
  validateNotificationHeaders,
  validateNotificationMethod,
  validateSigningKey,
} from './config.js';
import type { NotificationCredentials } from './credentials.js';
import type { NotificationEventType } from './events.js';
import { isNotificationPattern } from './filter.js';
import { parseNotificationTemplate } from './template-schema.js';

export type NotificationErrorCode =
  | 'invalid_configuration'
  | 'endpoint_limit'
  | 'transport_unavailable'
  | 'revision_conflict'
  | 'forbidden'
  | 'not_found'
  | 'unavailable';

const MESSAGES: Readonly<Record<NotificationErrorCode, string>> = {
  invalid_configuration: 'Invalid notification configuration',
  endpoint_limit: 'Notification endpoint limit reached',
  transport_unavailable: 'Notification delivery is unavailable',
  revision_conflict: 'Notification configuration changed',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  unavailable: 'Service unavailable',
};

/** Stable code, fixed message: never URL, header, template, key or receiver text. */
export class NotificationError extends Error {
  constructor(readonly code: NotificationErrorCode) {
    super(MESSAGES[code]);
    this.name = 'NotificationError';
  }
}

export interface NotificationSecretInput {
  readonly url: unknown;
  readonly headers?: unknown;
  readonly signingKey: unknown;
  /** json-v1 source text; null or absent for the canonical envelope. */
  readonly template?: unknown;
}

export interface NotificationOptionsInput {
  readonly name: unknown;
  readonly method: unknown;
  readonly events: unknown;
  readonly packagePattern: unknown;
}

export interface NotificationCall {
  readonly audit: AuditContext;
}

export interface NotificationEndpointServiceDeps {
  readonly reads: NotificationReadRepository;
  readonly writes: NotificationWriteRepository;
  readonly credentials: Pick<NotificationCredentials, 'prepare'>;
  readonly ids: { ulid(): string };
  readonly clock: { now(): Date };
  readonly selfOrigins: readonly string[];
  /** False when this runtime has no notification transport; enabling is then refused. */
  readonly transportAvailable: boolean;
}

function invalid(): never {
  throw new NotificationError('invalid_configuration');
}

function options(input: NotificationOptionsInput): NotificationPublicOptions {
  if (!isNotificationEndpointName(input.name)) invalid();
  if (!isNotificationPattern(input.packagePattern)) invalid();
  let events: readonly NotificationEventType[];
  try {
    events = notificationEventSelection(input.events);
  } catch {
    return invalid();
  }
  return {
    name: input.name,
    method: guard(() => validateNotificationMethod(input.method)),
    events,
    packagePattern: input.packagePattern,
  };
}

function guard<T>(run: () => T): T {
  try {
    return run();
  } catch {
    return invalid();
  }
}

function failure(error: unknown): never {
  if (error instanceof NotificationError) throw error;
  if (error instanceof NotificationRepositoryError) {
    switch (error.code) {
      case 'forbidden':
      case 'not_found':
      case 'endpoint_limit':
      case 'unavailable':
        throw new NotificationError(error.code);
      case 'conflict':
        throw new NotificationError('revision_conflict');
      case 'invalid_request':
        throw new NotificationError('invalid_configuration');
    }
  }
  throw new NotificationError('unavailable');
}

/** Human project settings management; the repository fences authority and reauthentication. */
export function createNotificationEndpointService(deps: NotificationEndpointServiceDeps) {
  function human(fence: MutationFence): void {
    if (fenceKind(fence) !== 'session') throw new NotificationError('forbidden');
  }

  function event(
    action: AuditEvent['action'],
    fence: MutationFence,
    projectId: string,
    endpointId: string,
    call: NotificationCall,
    changes: NonNullable<Parameters<typeof auditEvent>[0]['changes']>,
  ): AuditEvent {
    const result = auditEvent({
      id: deps.ids.ulid(),
      now: deps.clock.now().toISOString(),
      action,
      actor: { type: 'user', id: fence.userId },
      target: { type: 'notification_endpoint', id: endpointId },
      projectId,
      context: call.audit,
      changes,
    });
    return result.ok ? result.event : invalid();
  }

  async function seal(
    ctx: OrgContext,
    projectId: string,
    endpointId: string,
    events: readonly NotificationEventType[],
    secret: NotificationSecretInput,
  ): Promise<NotificationSealedConfiguration> {
    const url = guard(() =>
      validateNotificationDestination(secret.url as string, { selfOrigins: deps.selfOrigins }),
    );
    const headers = guard(() => validateNotificationHeaders(secret.headers ?? []));
    guard(() => validateSigningKey(secret.signingKey));
    const text = secret.template ?? null;
    if (text !== null && typeof text !== 'string') invalid();
    if (text !== null) guard(() => parseNotificationTemplate(text, events));
    try {
      return await deps.credentials.prepare(
        ctx,
        { projectId, endpointId },
        {
          url,
          headers,
          signingKey: secret.signingKey as string,
          template: text === null ? null : { text, events },
        },
      );
    } catch {
      return invalid();
    }
  }

  async function current(
    ctx: OrgContext,
    projectId: string,
    endpointId: string,
  ): Promise<NotificationEndpointSummary> {
    const found = await deps.reads.getEndpoint(ctx, projectId, endpointId).catch(failure);
    if (found === null) throw new NotificationError('not_found');
    return found;
  }

  function settled(result: { changed: boolean; revision: number }) {
    if (!result.changed) throw new NotificationError('revision_conflict');
    return { revision: result.revision };
  }

  return {
    /** Creates a disabled endpoint; returns only its id and revision. */
    async create(
      ctx: OrgContext,
      fence: MutationFence,
      projectId: string,
      input: NotificationOptionsInput & { readonly secret: NotificationSecretInput },
      call: NotificationCall,
    ): Promise<{ readonly id: string; readonly revision: number }> {
      human(fence);
      const opts = options(input);
      const id = deps.ids.ulid();
      const configuration = await seal(ctx, projectId, id, opts.events, input.secret);
      const audit = event('notification.create', fence, projectId, id, call, {
        revision: { new: 1 },
        method: { new: opts.method },
        events: { new: [...opts.events] },
        pattern: { new: opts.packagePattern },
        headers_configured: { new: configuration.headersConfigured },
        template_configured: { new: configuration.templateConfigured },
      });
      const result = await deps.writes
        .create(ctx, fence, {
          id,
          projectId,
          now: deps.clock.now().toISOString(),
          options: opts,
          configuration,
          event: audit,
        })
        .catch(failure);
      return { id, revision: result.revision };
    },

    /**
     * Replaces public options and/or the sealed configuration as a unit; an omitted secret keeps
     * the sealed one. A configured template was validated for the stored event selection, so a
     * selection change must bring a configuration that is validated again.
     */
    async update(
      ctx: OrgContext,
      fence: MutationFence,
      projectId: string,
      endpointId: string,
      input: {
        readonly expectedRevision: number;
        readonly options?: NotificationOptionsInput;
        readonly secret?: NotificationSecretInput;
      },
      call: NotificationCall,
    ): Promise<{ readonly revision: number }> {
      human(fence);
      if (input.options === undefined && input.secret === undefined) invalid();
      const before = await current(ctx, projectId, endpointId);
      const opts = input.options === undefined ? undefined : options(input.options);
      const events = opts?.events ?? before.events;
      const eventsChanged = events.join() !== before.events.join();
      if (eventsChanged && before.templateConfigured && input.secret === undefined) invalid();
      const configuration =
        input.secret === undefined
          ? undefined
          : await seal(ctx, projectId, endpointId, events, input.secret);
      const changed = [
        ...(opts === undefined
          ? []
          : [
              ...(opts.name !== before.name ? ['name'] : []),
              ...(opts.method !== before.method ? ['method'] : []),
              ...(eventsChanged ? ['events'] : []),
              ...(opts.packagePattern !== before.packagePattern ? ['package_pattern'] : []),
            ]),
        ...(configuration === undefined
          ? []
          : [
              'destination',
              'signing_key',
              ...(configuration.headersConfigured || before.headersConfigured ? ['headers'] : []),
              ...(configuration.templateConfigured || before.templateConfigured
                ? ['template']
                : []),
            ]),
      ];
      const audit = event(
        configuration === undefined ? 'notification.update' : 'notification.credential_set',
        fence,
        projectId,
        endpointId,
        call,
        {
          revision: { old: input.expectedRevision, new: input.expectedRevision + 1 },
          method: { new: opts?.method ?? before.method },
          events: { new: [...events] },
          pattern: { new: opts?.packagePattern ?? before.packagePattern },
          changed: { new: changed },
          headers_configured: {
            new: configuration?.headersConfigured ?? before.headersConfigured,
          },
          template_configured: {
            new: configuration?.templateConfigured ?? before.templateConfigured,
          },
        },
      );
      return settled(
        await deps.writes
          .update(ctx, fence, {
            id: endpointId,
            projectId,
            expectedRevision: input.expectedRevision,
            now: deps.clock.now().toISOString(),
            event: audit,
            ...(opts === undefined ? {} : { options: opts }),
            ...(configuration === undefined ? {} : { configuration }),
          })
          .catch(failure),
      );
    },

    async enable(
      ctx: OrgContext,
      fence: MutationFence,
      projectId: string,
      endpointId: string,
      expectedRevision: number,
      call: NotificationCall,
    ) {
      human(fence);
      if (!deps.transportAvailable) throw new NotificationError('transport_unavailable');
      return transition('enable', ctx, fence, projectId, endpointId, expectedRevision, call);
    },
    async disable(
      ctx: OrgContext,
      fence: MutationFence,
      projectId: string,
      endpointId: string,
      expectedRevision: number,
      call: NotificationCall,
    ) {
      human(fence);
      return transition('disable', ctx, fence, projectId, endpointId, expectedRevision, call);
    },
    async delete(
      ctx: OrgContext,
      fence: MutationFence,
      projectId: string,
      endpointId: string,
      expectedRevision: number,
      call: NotificationCall,
    ) {
      human(fence);
      return transition('delete', ctx, fence, projectId, endpointId, expectedRevision, call);
    },
  };

  async function transition(
    kind: 'enable' | 'disable' | 'delete',
    ctx: OrgContext,
    fence: MutationFence,
    projectId: string,
    endpointId: string,
    expectedRevision: number,
    call: NotificationCall,
  ): Promise<{ readonly revision: number }> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalid();
    const audit = event(`notification.${kind}`, fence, projectId, endpointId, call, {
      revision: { old: expectedRevision, new: expectedRevision + 1 },
      ...(kind === 'enable' ? {} : { reason: { new: kind === 'delete' ? 'deleted' : 'manual' } }),
    });
    const input = {
      id: endpointId,
      projectId,
      expectedRevision,
      now: deps.clock.now().toISOString(),
      event: audit,
    };
    const write =
      kind === 'enable'
        ? deps.writes.enable(ctx, fence, input)
        : kind === 'disable'
          ? deps.writes.disable(ctx, fence, input)
          : deps.writes.delete(ctx, fence, input);
    return settled(await write.catch(failure));
  }
}

export type NotificationEndpointService = ReturnType<typeof createNotificationEndpointService>;
