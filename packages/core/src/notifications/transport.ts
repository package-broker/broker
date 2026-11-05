import {
  NotificationConfigError,
  validateNotificationDestination,
  validateNotificationHeaders,
  type NotificationHeader,
  type NotificationMethod,
} from './config.js';

export const NOTIFICATION_TIMEOUT_MS = 10_000;
/** DNS, connection and TLS budget where the runtime can enforce it separately (Node). */
export const NOTIFICATION_CONNECT_TIMEOUT_MS = 3_000;
export const MAX_NOTIFICATION_BODY_BYTES = 16_384;
const MAX_RETRY_AFTER_LENGTH = 64;

/** The broker headers `notificationHeaders` produces, in that order. */
export const SIGNED_HEADER_NAMES = [
  'content-type',
  'x-package-broker-timestamp',
  'x-package-broker-signature',
  'x-package-broker-delivery',
  'idempotency-key',
  'x-package-broker-event',
] as const;

export interface NotificationRequest {
  readonly url: string;
  readonly method: NotificationMethod;
  /** Administrator headers from the sealed configuration; validated again here. */
  readonly headers: readonly NotificationHeader[];
  /** Broker headers from `notificationHeaders`. */
  readonly signed: readonly NotificationHeader[];
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
}

/**
 * The only facts that leave the transport: a status and a bounded Retry-After, or a fixed kind.
 * `refused` means the destination policy stopped the attempt; no receiver saw a byte.
 */
export type NotificationTransportResult =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly retryAfter: string | null;
      readonly durationMs: number;
    }
  | { readonly kind: 'refused' | 'network' | 'timeout' | 'aborted'; readonly durationMs: number };

export interface NotificationSendInit {
  readonly method: NotificationMethod;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly redirect: 'manual';
  readonly signal: AbortSignal;
}

/** The runtime connection; it must never follow redirects or add ambient credentials. */
export type NotificationSend = (url: string, init: NotificationSendInit) => Promise<Response>;

/** A runtime connector throws this when its own address check refuses the destination. */
export class NotificationDestinationRefused extends Error {
  constructor() {
    super('Notification destination refused');
    this.name = 'NotificationDestinationRefused';
  }
}

export class NotificationRequestError extends Error {
  constructor() {
    super('Invalid notification request');
    this.name = 'NotificationRequestError';
  }
}

export interface NotificationTransport {
  /** Runtime classification of a destination; the same check runs before every attempt. */
  allows(url: string): boolean;
  send(request: NotificationRequest): Promise<NotificationTransportResult>;
}

export interface NotificationTransportDeps {
  readonly send: NotificationSend;
  /** Runtime classification run immediately before every attempt; false refuses without a call. */
  readonly destination: (url: string) => boolean;
  readonly selfOrigins: readonly string[];
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

function invalid(): never {
  throw new NotificationRequestError();
}

function signedHeaders(value: readonly NotificationHeader[]): readonly NotificationHeader[] {
  if (!Array.isArray(value) || value.length !== SIGNED_HEADER_NAMES.length) invalid();
  value.forEach((header, index) => {
    if (
      !Array.isArray(header) ||
      header.length !== 2 ||
      typeof header[0] !== 'string' ||
      typeof header[1] !== 'string' ||
      header[0].toLowerCase() !== SIGNED_HEADER_NAMES[index] ||
      !/^[\x21-\x7e]{1,256}$/.test(header[1])
    )
      invalid();
  });
  if (value[0]![1] !== 'application/json') invalid();
  return value;
}

function retryAfterOf(response: Response): string | null {
  const value = response.headers.get('retry-after');
  return value !== null && value.length <= MAX_RETRY_AFTER_LENGTH && /^[\x20-\x7e]*$/.test(value)
    ? value
    : null;
}

export function createNotificationTransport(
  deps: NotificationTransportDeps,
): NotificationTransport {
  const timeoutMs = deps.timeoutMs ?? NOTIFICATION_TIMEOUT_MS;
  const now = deps.now ?? (() => performance.now());
  const send = deps.send;
  const destination = deps.destination;

  function allows(url: string): boolean {
    try {
      validateNotificationDestination(url, { selfOrigins: deps.selfOrigins });
    } catch (error) {
      if (error instanceof NotificationConfigError) return false;
      throw error;
    }
    return destination(url);
  }

  return {
    allows,
    async send(request) {
      if (request.method !== 'POST' && request.method !== 'PUT') invalid();
      if (
        !(request.body instanceof Uint8Array) ||
        request.body.byteLength > MAX_NOTIFICATION_BODY_BYTES
      )
        invalid();
      if (!(request.signal instanceof AbortSignal)) invalid();
      let custom: readonly NotificationHeader[];
      try {
        custom = validateNotificationHeaders(request.headers);
      } catch {
        return invalid();
      }
      const signed = signedHeaders(request.signed);
      const started = now();
      const elapsed = () => Math.max(0, Math.round(now() - started));
      if (request.signal.aborted) return { kind: 'aborted', durationMs: 0 };
      if (!allows(request.url)) return { kind: 'refused', durationMs: 0 };

      const headers = new Headers();
      for (const [name, value] of custom) headers.set(name, value);
      for (const [name, value] of signed) headers.set(name, value);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('timeout'));
      }, timeoutMs);
      const onAbort = () => controller.abort(new Error('aborted'));
      request.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await send(request.url, {
          method: request.method,
          headers,
          body: request.body.slice(),
          redirect: 'manual',
          signal: controller.signal,
        });
        const result: NotificationTransportResult = {
          kind: 'response',
          status: response.status,
          retryAfter: retryAfterOf(response),
          durationMs: elapsed(),
        };
        response.body?.cancel().catch(() => undefined);
        return result;
      } catch (error) {
        const durationMs = elapsed();
        if (request.signal.aborted) return { kind: 'aborted', durationMs };
        if (timedOut) return { kind: 'timeout', durationMs };
        if (error instanceof NotificationDestinationRefused) return { kind: 'refused', durationMs };
        return { kind: 'network', durationMs };
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
        controller.abort(new Error('settled'));
      }
    },
  };
}
