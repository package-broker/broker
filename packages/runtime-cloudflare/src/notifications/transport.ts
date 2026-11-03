import {
  createNotificationTransport,
  type NotificationSend,
  type NotificationTransport,
} from '@package-broker/core/runtime/notification-jobs';
import { classifyUrl, createOutboundPolicy } from '@package-broker/core/sources/url-policy';

export interface WorkersNotificationTransportOptions {
  readonly selfOrigins: readonly string[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Workers delivery through native fetch. URL classification is not DNS pinning: the platform
 * egress boundary refuses private targets, which the live egress gate must prove.
 */
export function createWorkersNotificationTransport(
  options: WorkersNotificationTransportOptions,
): NotificationTransport {
  const policy = createOutboundPolicy({
    allowPrivateHosts: [],
    runtime: 'cloudflare',
    selfOrigins: options.selfOrigins,
  });
  const native = options.fetch ?? ((input, init) => fetch(input, init));
  const send: NotificationSend = (url, init) =>
    native(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: 'manual',
      signal: init.signal,
    });
  return createNotificationTransport({
    send,
    destination: (url) => classifyUrl(url, policy).ok,
    selfOrigins: policy.selfOrigins,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
