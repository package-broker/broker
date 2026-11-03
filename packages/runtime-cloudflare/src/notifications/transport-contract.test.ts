import { describe, expect, it } from 'vitest';
import type {
  NotificationRequest,
  NotificationTransport,
} from '@package-broker/core/runtime/notification-jobs';
import { createWorkersNotificationTransport } from './transport.js';

type Connector = (input: string, init: RequestInit) => Promise<Response>;
type TransportFactory = (options: {
  readonly selfOrigins: readonly string[];
  readonly connector: Connector;
}) => NotificationTransport;
interface RecordedCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly redirect: string | undefined;
  readonly body: Uint8Array;
  readonly headers: Headers;
}
interface TransportMatrix {
  readonly SELF_ORIGIN: string;
  readonly PUBLIC_URL: string;
  readonly BODY: Uint8Array;
  readonly REFUSED_DESTINATIONS: readonly (readonly [label: string, url: string])[];
  readonly REFUSED_HEADERS: readonly (readonly [
    label: string,
    headers: (readonly [name: string, value: string])[],
  ])[];
  notificationRequest(over?: Partial<NotificationRequest>): Promise<NotificationRequest>;
  recordingConnector(respond?: () => Response): {
    readonly connector: Connector;
    readonly calls: RecordedCall[];
  };
  endlessRedirect(): { readonly respond: () => Response; cancelled(): boolean };
}

/** Shared by both runtimes and loaded by URL: packages never import each other's sources. */
const {
  BODY,
  PUBLIC_URL,
  REFUSED_DESTINATIONS,
  REFUSED_HEADERS,
  SELF_ORIGIN,
  endlessRedirect,
  notificationRequest,
  recordingConnector,
} = (await import(
  new URL('../../../core/src/test-support/notification-transport.ts', import.meta.url).href
)) as TransportMatrix;

const RUNTIME = 'cloudflare';
const make: TransportFactory = ({ selfOrigins, connector }) =>
  createWorkersNotificationTransport({
    selfOrigins,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      connector(String(input), init ?? {})) as typeof fetch,
  });

describe(`notification transport contract: ${RUNTIME}`, () => {
  it.each(REFUSED_DESTINATIONS)('refuses %s without a connector call', async (_, url) => {
    const { connector, calls } = recordingConnector();
    const transport = make({ selfOrigins: [SELF_ORIGIN], connector });
    expect(transport.allows(url)).toBe(false);
    expect((await transport.send(await notificationRequest({ url }))).kind).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it.each(REFUSED_HEADERS)('refuses a %s header without a connector call', async (_, headers) => {
    const { connector, calls } = recordingConnector();
    const transport = make({ selfOrigins: [SELF_ORIGIN], connector });
    await expect(transport.send(await notificationRequest({ headers }))).rejects.toThrow(
      'Invalid notification request',
    );
    expect(calls).toHaveLength(0);
  });

  it('cancels the body of a redirect and never follows it', async () => {
    const redirect = endlessRedirect();
    const { connector, calls } = recordingConnector(redirect.respond);
    const result = await make({ selfOrigins: [SELF_ORIGIN], connector }).send(
      await notificationRequest(),
    );
    expect(result).toMatchObject({ kind: 'response', status: 302, retryAfter: null });
    expect(redirect.cancelled()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.redirect).toBe('manual');
  });

  it.each(['POST', 'PUT'] as const)(
    'delivers a public %s control with the exact bytes',
    async (method) => {
      const { connector, calls } = recordingConnector(() => new Response(null, { status: 200 }));
      const result = await make({ selfOrigins: [SELF_ORIGIN], connector }).send(
        await notificationRequest({ method }),
      );
      expect(result).toMatchObject({ kind: 'response', status: 200 });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(PUBLIC_URL);
      expect(calls[0]!.method).toBe(method);
      expect([...calls[0]!.body]).toEqual([...BODY]);
      expect(calls[0]!.headers.get('content-type')).toBe('application/json');
      expect(calls[0]!.headers.get('authorization')).toBe('Bearer SECRET-HEADER');
    },
  );
});
