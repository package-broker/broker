import { CredentialNotFoundError } from '../secrets/credential-store.js';
import { NotificationConfigError } from './config.js';
import { NotificationRequestError } from './transport.js';
import type {
  NotificationCancelCode,
  NotificationDeliveryContext,
  NotificationDeliveryRecord,
  NotificationMethod,
  NotificationPrepareRepository,
} from '../db/notifications.js';
import type { OrgContext, Statement } from '../db/port.js';
import type { JobGuard } from '../platform/job-repository.js';
import { SecretDecryptError, credentialAad } from '../secrets/cipher.js';
import {
  NotificationCredentialError,
  type NotificationCredentials,
  type NotificationCredentialsDeps,
  type OpenedNotificationConfiguration,
} from './credentials.js';
import { parseNotificationEvent, type NotificationEvent } from './events.js';
import { MAX_RENDERED_BYTES, renderNotificationBody } from './render.js';
import type { NotificationTransport } from './transport.js';

export const NOTIFICATION_BODY_CREDENTIAL_KIND = 'npm-notification-body';
const BODY_KEYS = 'body,deliveryId,projectId,schemaVersion';

export class NotificationBodyError extends Error {
  constructor() {
    super('Notification body is unavailable');
    this.name = 'NotificationBodyError';
  }
}

export function isNotificationDeliveryError(error: unknown): boolean {
  return (
    error instanceof NotificationCredentialError ||
    error instanceof NotificationBodyError ||
    error instanceof NotificationConfigError ||
    error instanceof NotificationRequestError
  );
}

export interface NotificationBodyBinding {
  readonly projectId: string;
  readonly deliveryId: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/**
 * The rendered body, sealed once per delivery and bound to its organization (AAD), project and
 * delivery id (plaintext); every attempt signs and sends exactly these bytes.
 */
export function createNotificationBodies(deps: NotificationCredentialsDeps) {
  return {
    async prepare(
      ctx: OrgContext,
      binding: NotificationBodyBinding,
      body: Uint8Array,
    ): Promise<{ readonly credentialId: string; readonly statement: Statement }> {
      if (body.byteLength > MAX_RENDERED_BYTES) throw new NotificationBodyError();
      const plaintext = encoder.encode(
        JSON.stringify({
          schemaVersion: 1,
          deliveryId: binding.deliveryId,
          projectId: binding.projectId,
          body: base64(body),
        }),
      );
      try {
        const { id, statement } = await deps.store.prepare(ctx, {
          kind: NOTIFICATION_BODY_CREDENTIAL_KIND,
          projectId: binding.projectId,
          plaintext,
        });
        return { credentialId: id, statement };
      } finally {
        plaintext.fill(0);
      }
    },

    async open(
      ctx: OrgContext,
      binding: NotificationBodyBinding & { readonly credentialId: string },
    ): Promise<Uint8Array> {
      const row = await deps.repository.get(ctx, binding.credentialId);
      if (
        row === null ||
        row.kind !== NOTIFICATION_BODY_CREDENTIAL_KIND ||
        row.projectId !== binding.projectId ||
        row.aad !==
          credentialAad({ id: row.id, orgId: ctx.orgId, kind: NOTIFICATION_BODY_CREDENTIAL_KIND })
      )
        throw new NotificationBodyError();
      let plaintext: Uint8Array;
      try {
        plaintext = await deps.store.read(ctx, binding.credentialId);
      } catch (error) {
        if (!(error instanceof SecretDecryptError || error instanceof CredentialNotFoundError))
          throw error;
        throw new NotificationBodyError();
      }
      try {
        const parsed = JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Object.keys(parsed).sort().join() !== BODY_KEYS ||
          parsed.schemaVersion !== 1 ||
          parsed.deliveryId !== binding.deliveryId ||
          parsed.projectId !== binding.projectId ||
          typeof parsed.body !== 'string'
        )
          throw new NotificationBodyError();
        const body = unbase64(parsed.body);
        if (body.byteLength > MAX_RENDERED_BYTES) throw new NotificationBodyError();
        return body;
      } catch {
        throw new NotificationBodyError();
      } finally {
        plaintext.fill(0);
      }
    },
  };
}

export type NotificationBodies = ReturnType<typeof createNotificationBodies>;

export type PreparedDelivery =
  | { readonly kind: 'cancel'; readonly code: NotificationCancelCode }
  | {
      readonly kind: 'fail';
      readonly code: 'credentials' | 'template' | 'policy';
      readonly disable: 'credentials' | 'policy' | null;
    }
  /** The delivery changed under this job; read it again. */
  | { readonly kind: 'stale' }
  | {
      readonly kind: 'ready';
      readonly event: NotificationEvent;
      readonly method: NotificationMethod;
      readonly configuration: OpenedNotificationConfiguration;
      readonly body: Uint8Array;
    };

export interface PrepareDeliveryDeps {
  readonly repository: Pick<NotificationPrepareRepository, 'attachBody'>;
  readonly credentials: Pick<NotificationCredentials, 'open'>;
  readonly bodies: NotificationBodies;
  readonly transport: Pick<NotificationTransport, 'allows'>;
}

/** Why a pending delivery may no longer be sent, or null while everything still accepts it. */
export function cancellation(context: NotificationDeliveryContext): NotificationCancelCode | null {
  const { endpoint, delivery } = context;
  if (endpoint === null || endpoint.state === 'deleted') return 'deleted';
  if (endpoint.state !== 'enabled') return 'disabled';
  if (endpoint.revision !== delivery.endpointRevision) return 'superseded';
  if (!context.projectActive) return 'project_inactive';
  if (!context.admitted) return 'admission_lost';
  return null;
}

async function body(
  deps: PrepareDeliveryDeps,
  ctx: OrgContext,
  lease: JobGuard,
  delivery: NotificationDeliveryRecord,
  configuration: OpenedNotificationConfiguration,
  event: NotificationEvent,
): Promise<Uint8Array | PreparedDelivery> {
  const binding = { projectId: delivery.projectId, deliveryId: delivery.id };
  if (delivery.bodyCredentialId !== null) {
    try {
      return await deps.bodies.open(ctx, { ...binding, credentialId: delivery.bodyCredentialId });
    } catch (error) {
      if (!isNotificationDeliveryError(error)) throw error;
      return { kind: 'fail', code: 'credentials', disable: 'credentials' };
    }
  }
  let rendered: Uint8Array;
  try {
    rendered = renderNotificationBody(configuration.template, event);
  } catch {
    return { kind: 'fail', code: 'template', disable: null };
  }
  const sealed = await deps.bodies.prepare(ctx, binding, rendered);
  const attached = await deps.repository.attachBody(ctx, lease, {
    deliveryId: delivery.id,
    expectedRevision: delivery.revision,
    credentialId: sealed.credentialId,
    statement: sealed.statement,
  });
  return attached ? rendered : { kind: 'stale' };
}

/**
 * Rechecks a pending delivery against the current endpoint, project and source admission, opens
 * its sealed configuration and returns the exact body every attempt sends, sealing it first.
 */
export async function prepareDelivery(
  deps: PrepareDeliveryDeps,
  ctx: OrgContext,
  lease: JobGuard,
  context: NotificationDeliveryContext,
): Promise<PreparedDelivery> {
  const cancel = cancellation(context);
  if (cancel !== null) return { kind: 'cancel', code: cancel };
  const { delivery } = context;
  let event: NotificationEvent;
  try {
    event = parseNotificationEvent(context.payloadJson);
  } catch {
    return { kind: 'fail', code: 'template', disable: null };
  }
  if (event.id !== delivery.eventId || event.projectId !== delivery.projectId)
    return { kind: 'fail', code: 'template', disable: null };
  let configuration: OpenedNotificationConfiguration;
  try {
    configuration = await deps.credentials.open(ctx, {
      credentialId: delivery.configurationCredentialId,
      projectId: delivery.projectId,
      endpointId: delivery.endpointId,
    });
  } catch (error) {
    if (!isNotificationDeliveryError(error)) throw error;
    return { kind: 'fail', code: 'credentials', disable: 'credentials' };
  }
  if (!deps.transport.allows(configuration.url))
    return { kind: 'fail', code: 'policy', disable: 'policy' };
  const bytes = await body(deps, ctx, lease, delivery, configuration, event);
  if (!(bytes instanceof Uint8Array)) return bytes;
  return {
    kind: 'ready',
    event,
    method: context.endpoint!.method,
    configuration,
    body: bytes,
  };
}
