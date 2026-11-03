import {
  NOTIFICATION_CONNECT_TIMEOUT_MS,
  NotificationDestinationRefused,
  createNotificationTransport,
  type NotificationSend,
  type NotificationTransport,
} from '@package-broker/core/runtime/notification-jobs';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import { classifyUrl, createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { DnsGuardError, type DnsGuardReason, type Resolver } from '../sources/dns-guard.js';
import { createGuardedFetch } from '../sources/guarded-fetch.js';

export interface NodeNotificationTransportOptions {
  readonly selfOrigins: readonly string[];
  readonly resolver?: Resolver;
  readonly tls?: { readonly ca?: string | Buffer };
  /** Replaces the guarded connector; tests only. */
  readonly connector?: FetchLike;
  readonly timeoutMs?: number;
}

/** Resolution that failed or timed out is a network outcome to retry, not a policy refusal. */
const NOT_REFUSALS: ReadonlySet<DnsGuardReason> = new Set([
  'no_address',
  'resolution_failed',
  'resolution_timeout',
  'aborted',
]);

function guardRefusal(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause && depth < 4; depth += 1) {
    if (cause instanceof DnsGuardError) return !NOT_REFUSALS.has(cause.reason);
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Node delivery: every attempt resolves the destination through the DNS guard with no
 * private-host exception, and connects to the address that was checked.
 */
export function createNodeNotificationTransport(
  options: NodeNotificationTransportOptions,
): NotificationTransport {
  const policy = createOutboundPolicy({
    allowPrivateHosts: [],
    runtime: 'node',
    selfOrigins: options.selfOrigins,
  });
  const connector =
    options.connector ??
    createGuardedFetch(policy, {
      timeoutMs: NOTIFICATION_CONNECT_TIMEOUT_MS,
      connectTimeoutMs: NOTIFICATION_CONNECT_TIMEOUT_MS,
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      ...(options.tls === undefined ? {} : { tls: options.tls }),
    });
  const send: NotificationSend = async (url, init) => {
    try {
      return await connector(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: 'manual',
        signal: init.signal,
      });
    } catch (error) {
      if (guardRefusal(error)) throw new NotificationDestinationRefused();
      throw error;
    }
  };
  return createNotificationTransport({
    send,
    destination: (url) => classifyUrl(url, policy).ok,
    selfOrigins: policy.selfOrigins,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
