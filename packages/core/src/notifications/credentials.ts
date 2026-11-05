import { CredentialNotFoundError } from '../secrets/credential-store.js';
import type { CredentialRepository } from '../db/credentials.js';
import type { NotificationSealedConfiguration } from '../db/notifications.js';
import type { OrgContext } from '../db/port.js';
import { SecretDecryptError, credentialAad } from '../secrets/cipher.js';
import type { CredentialStore } from '../secrets/credential-store.js';
import type { NotificationEventType } from './events.js';
import {
  TEMPLATE_FORMAT,
  parseNotificationTemplate,
  type NotificationTemplate,
} from './template-schema.js';

export const NOTIFICATION_CREDENTIAL_KIND = 'npm-notification';
const MAX_CONFIGURATION_BYTES = 32_768;

/** json-v1 source text and the event selection it was validated for. */
export interface NotificationTemplateSource {
  readonly text: string;
  readonly events: readonly NotificationEventType[];
}

export interface NotificationSecretConfiguration {
  readonly url: string;
  readonly headers: readonly (readonly [name: string, value: string])[];
  readonly signingKey: string;
  /** Null for the canonical envelope. */
  readonly template: NotificationTemplateSource | null;
}

export interface NotificationCredentialBinding {
  readonly credentialId: string;
  readonly projectId: string;
  readonly endpointId: string;
}

/** Decrypted configuration; never serializes or prints its contents. */
export interface OpenedNotificationConfiguration extends Omit<
  NotificationSecretConfiguration,
  'template'
> {
  /** Re-validated against the sealed selection; render only through it. */
  readonly template: NotificationTemplate | null;
  toJSON(): { readonly configured: true };
}

interface SealedTemplate {
  readonly format: typeof TEMPLATE_FORMAT;
  readonly events: readonly NotificationEventType[];
  readonly text: string;
}

export class NotificationCredentialError extends Error {
  constructor() {
    super('Notification configuration is unavailable');
    this.name = 'NotificationCredentialError';
  }
}

export interface NotificationCredentialsDeps {
  readonly store: CredentialStore;
  readonly repository: CredentialRepository;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function shaped(value: unknown): value is NotificationSecretConfiguration {
  return (
    isPlainObject(value) &&
    typeof value.url === 'string' &&
    typeof value.signingKey === 'string' &&
    Array.isArray(value.headers) &&
    value.headers.length <= 16 &&
    value.headers.every(
      (header) =>
        Array.isArray(header) &&
        header.length === 2 &&
        typeof header[0] === 'string' &&
        typeof header[1] === 'string',
    ) &&
    (value.template === null || isPlainObject(value.template))
  );
}

/** The template as sealed: its own validated selection travels with the text. */
function parsedTemplate(value: unknown): NotificationTemplate | null {
  if (value === null) return null;
  if (!isPlainObject(value) || typeof value.text !== 'string' || !Array.isArray(value.events))
    throw new NotificationCredentialError();
  if ('format' in value && value.format !== TEMPLATE_FORMAT)
    throw new NotificationCredentialError();
  try {
    return parseNotificationTemplate(value.text, value.events as NotificationEventType[]);
  } catch {
    throw new NotificationCredentialError();
  }
}

function sealedTemplate(source: NotificationTemplateSource | null): SealedTemplate | null {
  const template = parsedTemplate(source);
  return template === null || source === null
    ? null
    : { format: TEMPLATE_FORMAT, events: template.events, text: source.text };
}

function opened(secret: NotificationSecretConfiguration): OpenedNotificationConfiguration {
  const hidden = {
    url: secret.url,
    headers: secret.headers.map(([name, value]) => [name, value] as const),
    signingKey: secret.signingKey,
    template: parsedTemplate(secret.template),
  };
  const result = {} as OpenedNotificationConfiguration;
  for (const [key, value] of Object.entries(hidden))
    Object.defineProperty(result, key, { value, enumerable: false });
  Object.defineProperty(result, 'toJSON', {
    value: () => ({ configured: true }) as const,
    enumerable: false,
  });
  Object.defineProperty(result, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => '[NotificationConfiguration]',
    enumerable: false,
  });
  return Object.freeze(result);
}

/**
 * Seals the complete endpoint configuration as one immutable credential row for the owning
 * project; the endpoint and project identities travel inside the sealed plaintext.
 */
export function createNotificationCredentials(deps: NotificationCredentialsDeps) {
  return {
    async prepare(
      ctx: OrgContext,
      binding: Omit<NotificationCredentialBinding, 'credentialId'>,
      secret: NotificationSecretConfiguration,
    ): Promise<NotificationSealedConfiguration> {
      if (!shaped(secret)) throw new NotificationCredentialError();
      const template = sealedTemplate(secret.template);
      const plaintext = encoder.encode(
        JSON.stringify({
          schemaVersion: 1,
          endpointId: binding.endpointId,
          projectId: binding.projectId,
          url: secret.url,
          headers: secret.headers,
          signingKey: secret.signingKey,
          template,
        }),
      );
      try {
        if (plaintext.byteLength > MAX_CONFIGURATION_BYTES) throw new NotificationCredentialError();
        const { id, statement } = await deps.store.prepare(ctx, {
          kind: NOTIFICATION_CREDENTIAL_KIND,
          projectId: binding.projectId,
          plaintext,
        });
        return {
          credentialId: id,
          statement,
          headersConfigured: secret.headers.length > 0,
          templateConfigured: template !== null,
        };
      } finally {
        plaintext.fill(0);
      }
    },

    /** Checks organization, project, kind and AAD before decrypting, then the embedded identities. */
    async open(
      ctx: OrgContext,
      binding: NotificationCredentialBinding,
    ): Promise<OpenedNotificationConfiguration> {
      const row = await deps.repository.get(ctx, binding.credentialId);
      if (
        row === null ||
        row.kind !== NOTIFICATION_CREDENTIAL_KIND ||
        row.projectId !== binding.projectId ||
        row.aad !==
          credentialAad({ id: row.id, orgId: ctx.orgId, kind: NOTIFICATION_CREDENTIAL_KIND })
      )
        throw new NotificationCredentialError();
      let plaintext: Uint8Array;
      try {
        plaintext = await deps.store.read(ctx, binding.credentialId);
      } catch (error) {
        if (!(error instanceof SecretDecryptError || error instanceof CredentialNotFoundError))
          throw error;
        throw new NotificationCredentialError();
      }
      try {
        const parsed: unknown = JSON.parse(decoder.decode(plaintext));
        if (
          !isPlainObject(parsed) ||
          Object.keys(parsed).sort().join() !==
            'endpointId,headers,projectId,schemaVersion,signingKey,template,url' ||
          parsed.schemaVersion !== 1 ||
          parsed.endpointId !== binding.endpointId ||
          parsed.projectId !== binding.projectId ||
          !shaped(parsed)
        )
          throw new NotificationCredentialError();
        return opened(parsed);
      } catch {
        throw new NotificationCredentialError();
      } finally {
        plaintext.fill(0);
      }
    },
  };
}

export type NotificationCredentials = ReturnType<typeof createNotificationCredentials>;
