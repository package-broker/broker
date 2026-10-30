import type { OrgContext } from '../db/port.js';
import type { CoreJobs as Jobs } from '../platform/jobs.js';
import type { RequestContext, RouteDefinition } from '../plugin.js';
import type { BearerMaterial, CredentialMaterial } from './credentials.js';
import type { WebhookVerifier } from './provider.js';

export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

const PROVIDER = 'github';
const SOURCE_SYNC = 'core:source-sync:v1';
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REDACTED = '[redacted]';
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const MAX_REPOSITORY_LENGTH = 256;
const DUMMY_SECRET = 'dummy-webhook-secret-for-unknown-credentials';

export type DeliveryOutcome = 'received' | 'processed' | 'ignored' | 'failed';
export type WebhookEvent = 'push' | 'release' | 'other';

export interface WebhookTarget {
  readonly credentialId: string;
  readonly installationId: number;
  readonly repository: string;
}

export interface WebhookDeliveries {
  /** `duplicate` carries the stored outcome; a delivery that cannot be stored or read back throws. */
  record(
    ctx: OrgContext,
    input: { readonly provider: string; readonly deliveryId: string; readonly event: WebhookEvent },
  ): Promise<
    { readonly state: 'new' } | { readonly state: 'duplicate'; readonly outcome: DeliveryOutcome }
  >;
  /**
   * Non-paused sources of the credential whose installation and repository match, at most 100 in
   * id order; sources beyond the cap are not enqueued for this delivery.
   */
  sourcesFor(ctx: OrgContext, target: WebhookTarget): Promise<readonly string[]>;
  /** Moves a delivery out of `received` only. */
  settle(
    ctx: OrgContext,
    input: {
      readonly provider: string;
      readonly deliveryId: string;
      readonly outcome: 'processed' | 'ignored';
    },
  ): Promise<void>;
}

export interface WebhookIntakeDeps {
  /** Null for an unknown credential or one that cannot be opened. */
  readonly loadCredential: (ctx: OrgContext, id: string) => Promise<CredentialMaterial | null>;
  readonly verifier: WebhookVerifier;
  readonly deliveries: WebhookDeliveries;
  readonly jobs: Pick<Jobs, 'enqueue'>;
}

interface Classified {
  readonly event: WebhookEvent;
  readonly target: { readonly installationId: number; readonly repository: string } | null;
}

function unauthorized(): Response {
  return new Response(null, { status: 401 });
}

function accepted(): Response {
  return new Response(null, { status: 202 });
}

function tooLarge(): Response {
  return new Response(null, { status: 413 });
}

function bearerOf(token: string): BearerMaterial {
  const redact = (): string => REDACTED;
  const material = { kind: 'bearer' as const };
  Object.defineProperties(material, {
    token: { enumerable: false, get: () => token },
    toJSON: { enumerable: false, value: redact },
    toString: { enumerable: false, value: redact },
    [INSPECT]: { enumerable: false, value: redact },
  });
  return Object.freeze(material) as BearerMaterial;
}

async function readBounded(request: Request): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > WEBHOOK_MAX_BODY_BYTES) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > WEBHOOK_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classify(header: string | null, raw: Uint8Array): Classified {
  const event: WebhookEvent = header === 'push' || header === 'release' ? header : 'other';
  if (event === 'other') return { event, target: null };
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return { event, target: null };
  }
  if (!isRecord(payload)) return { event, target: null };
  const required = event === 'push' ? payload.ref : payload.release;
  const repository = isRecord(payload.repository) ? payload.repository.full_name : undefined;
  const installation = isRecord(payload.installation) ? payload.installation.id : undefined;
  const valid =
    (event === 'push' ? typeof required === 'string' : isRecord(required)) &&
    typeof repository === 'string' &&
    repository !== '' &&
    repository.length <= MAX_REPOSITORY_LENGTH &&
    typeof installation === 'number' &&
    Number.isSafeInteger(installation) &&
    installation > 0;
  return valid
    ? { event, target: { installationId: installation, repository } }
    : { event, target: null };
}

async function verified(
  deps: WebhookIntakeDeps,
  ctx: OrgContext,
  credentialId: string | undefined,
  request: Request,
  raw: Uint8Array,
): Promise<boolean> {
  let secret = DUMMY_SECRET;
  let known = false;
  if (credentialId !== undefined && CREDENTIAL_ID.test(credentialId)) {
    const material = await deps.loadCredential(ctx, credentialId);
    if (material !== null && material.kind === 'github_app') {
      secret = material.webhookSecret;
      known = true;
    }
  }
  let valid: boolean;
  try {
    valid = await deps.verifier.verify(bearerOf(secret), request.headers, raw);
  } catch {
    return false;
  }
  return known && valid;
}

export function createWebhookIntake(deps: WebhookIntakeDeps): RouteDefinition {
  async function handler(context: RequestContext): Promise<Response> {
    const { request, org, params } = context;
    if (org === null) return unauthorized();
    const raw = await readBounded(request);
    if (raw === null) return tooLarge();
    const credentialId = params.credentialId;
    if (!(await verified(deps, org, credentialId, request, raw)) || credentialId === undefined) {
      return unauthorized();
    }

    const { event, target } = classify(request.headers.get('x-github-event'), raw);
    const eventHeader = new TextEncoder().encode(
      `${request.headers.get('x-github-event') ?? ''}\n`,
    );
    const keyed = new Uint8Array(eventHeader.byteLength + raw.byteLength);
    keyed.set(eventHeader);
    keyed.set(raw, eventHeader.byteLength);
    const deliveryId = `${credentialId}:${await sha256HexOf(keyed)}`;
    const recorded = await deps.deliveries.record(org, { provider: PROVIDER, deliveryId, event });
    if (recorded.state === 'duplicate' && recorded.outcome !== 'received') return accepted();

    if (target === null) {
      await deps.deliveries.settle(org, { provider: PROVIDER, deliveryId, outcome: 'ignored' });
      return accepted();
    }

    const sourceIds = await deps.deliveries.sourcesFor(org, { credentialId, ...target });
    for (const sourceId of sourceIds) {
      await deps.jobs.enqueue(
        org,
        SOURCE_SYNC,
        { sourceId, reason: 'webhook' },
        {
          idempotencyKey: await sha256HexOf(
            new TextEncoder().encode(JSON.stringify([deliveryId, sourceId])),
          ),
          resourceKey: `source:${sourceId}`,
        },
      );
    }
    await deps.deliveries.settle(org, { provider: PROVIDER, deliveryId, outcome: 'processed' });
    return accepted();
  }

  return Object.freeze({
    method: 'POST',
    path: '/_pb/hooks/github/:credentialId',
    permission: null,
    handler,
  });
}
