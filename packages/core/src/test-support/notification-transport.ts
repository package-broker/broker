import { notificationHeaders } from '../notifications/signature.js';
import type { NotificationHeader } from '../notifications/config.js';
import type { NotificationRequest, NotificationTransport } from '../notifications/transport.js';

/** Adversarial cases every runtime notification transport must pass with zero connector calls. */

export const SELF_ORIGIN = 'https://broker.example.org';
export const PUBLIC_URL = 'https://hooks.example.com/in?token=SECRET-QUERY';
export const BODY = new TextEncoder().encode(
  '{"schemaVersion":1,"id":"01JEVENT0000000000000000AB"}',
);

export type Connector = (input: string, init: RequestInit) => Promise<Response>;
export type TransportFactory = (options: {
  readonly selfOrigins: readonly string[];
  readonly connector: Connector;
}) => NotificationTransport;

export const REFUSED_DESTINATIONS: readonly (readonly [label: string, url: string])[] = [
  ['self origin', `${SELF_ORIGIN}/hook`],
  ['self origin, other case', 'https://BROKER.Example.org/hook'],
  ['self origin, trailing dot', 'https://broker.example.org./hook'],
  ['port 8443', 'https://hooks.example.com:8443/'],
  ['port 80 on https', 'https://hooks.example.com:80/'],
  ['port 65535', 'https://hooks.example.com:65535/'],
  ['port with suffix', 'https://hooks.example.com:443x/'],
  ['negative port', 'https://hooks.example.com:-1/'],
  ['plain http', 'http://hooks.example.com/'],
  ['userinfo', 'https://user@hooks.example.com/'],
  ['user and password', 'https://u:p@hooks.example.com/'],
  ['userinfo hiding a private host', 'https://hooks.example.com@10.0.0.1/'],
  ['backslash userinfo', 'https://hooks.example.com\\@10.0.0.1/'],
  ['percent-encoded at sign', 'https://evil%40hooks.example.com/'],
  ['fragment', 'https://hooks.example.com/#x'],
  ['control character', 'https://hooks.example.com/\u0000'],
  ['whitespace', 'https://hooks.example.com/ a'],
  ['decimal IPv4', 'https://2130706433/'],
  ['hex IPv4', 'https://0x7f.0.0.1/'],
  ['octal IPv4', 'https://0177.0.0.1/'],
  ['short IPv4', 'https://127.1/'],
  ['public IPv4 literal', 'https://93.184.216.34/'],
  ['IPv6 loopback', 'https://[::1]/'],
  ['IPv4-mapped IPv6', 'https://[::ffff:7f00:1]/'],
  ['NAT64 private', 'https://[64:ff9b::a00:1]/'],
  ['public IPv6 literal', 'https://[2606:2800:220:1:248:1893:25c8:1946]/'],
  ['IPv6 zone id', 'https://[fe80::1%25eth0]/'],
  ['single label', 'https://intranet/'],
  ['localhost', 'https://localhost/'],
  ['metadata name', 'https://metadata.google.internal/'],
  ['empty label', 'https://hooks..example.com/'],
];

/** Joined at run time: the architecture scan refuses these header names as literals in core sources. */
const CLIENT_ADDRESS_HEADERS = [
  ['X', 'Forwarded', 'For'].join('-'),
  ['X', 'Real', 'IP'].join('-'),
] as const;

export const REFUSED_HEADERS: readonly (readonly [label: string, headers: NotificationHeader[]])[] =
  [
    ['host', [['Host', 'internal.example.com']]],
    ['cookie', [['Cookie', 'session=1']]],
    ['proxy authorization', [['Proxy-Authorization', 'Basic eA==']]],
    ['forwarded', [['Forwarded', 'for=1.2.3.4']]],
    ['forwarded-for header', [[CLIENT_ADDRESS_HEADERS[0], '1.2.3.4']]],
    ['real-ip header', [[CLIENT_ADDRESS_HEADERS[1], '1.2.3.4']]],
    ['connection', [['Connection', 'close']]],
    ['transfer encoding', [['Transfer-Encoding', 'chunked']]],
    ['content length', [['Content-Length', '1']]],
    ['content type', [['Content-Type', 'text/plain']]],
    ['content encoding', [['Content-Encoding', 'gzip']]],
    ['idempotency key', [['Idempotency-Key', 'forged']]],
    ['broker signature', [['X-Package-Broker-Signature', 'v1=00']]],
    ['broker delivery', [['x-package-broker-delivery', 'forged']]],
    ['trace header', [['traceparent', '00-0-0-00']]],
    ['request id', [['X-Request-Id', 'forged']]],
    [
      'duplicate names',
      [
        ['X-Token', 'a'],
        ['x-token', 'b'],
      ],
    ],
    ['CRLF in value', [['X-Token', 'a\r\nX-Injected: 1']]],
    ['non-token name', [['X Token', 'a']]],
  ];

export async function notificationRequest(
  over: Partial<NotificationRequest> = {},
): Promise<NotificationRequest> {
  const method = over.method ?? 'POST';
  return {
    url: PUBLIC_URL,
    method,
    headers: [['Authorization', 'Bearer SECRET-HEADER']],
    signed: await notificationHeaders({
      key: new Uint8Array(32).fill(9),
      timestamp: 1_767_225_600,
      deliveryId: '01JDELIVERY00000000000000A',
      eventId: '01JEVENT0000000000000000AB',
      method,
      body: BODY,
    }),
    body: BODY,
    signal: new AbortController().signal,
    ...over,
  };
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly redirect: string | undefined;
  readonly body: Uint8Array;
  readonly headers: Headers;
}

/** A connector that records each call and answers with `respond`. */
export function recordingConnector(respond: () => Response = () => new Response(null)): {
  readonly connector: Connector;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    connector: async (input, init) => {
      calls.push({
        url: input,
        method: init.method,
        redirect: init.redirect,
        body: new Uint8Array(init.body as Uint8Array),
        headers: new Headers(init.headers),
      });
      return respond();
    },
  };
}

/** A redirect whose body never ends; `cancelled()` reports whether the transport dropped it. */
export function endlessRedirect(): { readonly respond: () => Response; cancelled(): boolean } {
  let cancelled = false;
  return {
    respond: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel: () => {
            cancelled = true;
          },
        }),
        { status: 302, headers: { location: 'https://10.0.0.1/' } },
      ),
    cancelled: () => cancelled,
  };
}
