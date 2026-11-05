import { verifyNotificationSignature } from '../notifications/signature.js';

/**
 * Dual-runtime acceptance for publish notifications. Each runtime test boots its broker with the
 * flag on, routes every outbound request through `Receiver`, and runs these steps in order; they
 * share state, so a later step relies on the commits of the earlier ones.
 */

export const SENTINEL = /SENTINEL/;
const SIGNING_KEY = `SENTINELKEY${'A'.repeat(32)}`;
const ALPHA_URL = 'https://hooks.example.com/SENTINELPATH/alpha?token=SENTINELQUERY';
const BETA_URL = 'https://hooks.example.com/beta';
const TEMPLATE = JSON.stringify({
  marker: 'SENTINELTEMPLATE',
  type: '{{type}}',
  id: '{{id}}',
  name: '{{package.name}}',
  version: '{{package.version}}',
});
const ALL_EVENTS = [
  'npm.package.published',
  'npm.package.released',
  'npm.package.unpublished',
  'npm.package.deprecation_changed',
  'npm.package.dist_tag_changed',
];

export interface ReceivedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly status: number;
}

/** The only reachable outside world: notification receivers answer, anything else is a stray. */
export class Receiver {
  readonly seen: ReceivedRequest[] = [];
  readonly strays: string[] = [];
  private readonly failures: number[] = [];

  failNext(status: number): void {
    this.failures.push(status);
  }

  answer(url: string, method: string, headers: Headers, body: Uint8Array): Response {
    if (!url.startsWith('https://hooks.example.com/')) {
      this.strays.push(new URL(url).origin);
      return new Response('{}', { status: 404 });
    }
    const status = this.failures.shift() ?? 204;
    this.seen.push({ url, method, headers, body: new Uint8Array(body), status });
    return new Response(null, { status });
  }

  at(url: string): ReceivedRequest[] {
    return this.seen.filter((request) => request.url === url);
  }
}

export interface DeliveryRow {
  readonly id: string;
  readonly project_id: string;
  readonly endpoint_id: string;
  readonly event_type: string;
  readonly state: string;
  readonly attempts: number;
  readonly outcome_code: string | null;
}

export interface AcceptanceHarness {
  readonly origin: string;
  readonly world: {
    readonly projects: { readonly alpha: string; readonly beta: string };
    readonly sessionHeaders: Readonly<Record<string, string>>;
    readonly publishToken: string;
  };
  readonly receiver: Receiver;
  fetch(request: Request): Promise<Response>;
  /** Restarts this runtime with capture and delivery disabled. */
  disableNotifications(): Promise<void>;
  /** Runs every runnable job until nothing due remains. */
  drain(): Promise<void>;
  /** Makes a waiting retry due without waiting for its slot. */
  advanceRetry(): Promise<void>;
  deliveries(): Promise<DeliveryRow[]>;
  /** Every stored job, attempt, audit and notification row, serialized. */
  stored(): Promise<string>;
  /** Everything the broker logged, serialized. */
  logs(): string;
}

function fail(label: string, actual: unknown, expected?: unknown): never {
  throw new Error(
    `${label}: got ${JSON.stringify(actual)}${expected === undefined ? '' : `, want ${JSON.stringify(expected)}`}`,
  );
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(label, actual, expected);
}

const decoder = new TextDecoder();
const body = (request: ReceivedRequest) =>
  JSON.parse(decoder.decode(request.body)) as {
    marker: string;
    type: string;
    id: string;
    name: string;
    version: string | null;
  };

function keyBytes(): Uint8Array {
  const binary = atob(`${SIGNING_KEY.replace(/-/g, '+').replace(/_/g, '/')}=`);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice().buffer])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function tarEntry(path: string, text: string): Uint8Array {
  const encoder = new TextEncoder();
  const content = encoder.encode(text);
  const header = new Uint8Array(512);
  const put = (at: number, value: string) => header.set(encoder.encode(value), at);
  put(0, path);
  put(100, '0000644\0');
  put(108, '0000000\0');
  put(116, '0000000\0');
  put(124, `${content.length.toString(8).padStart(11, '0')}\0`);
  put(136, '00000000000\0');
  put(148, '        ');
  put(156, '0');
  put(257, 'ustar\0');
  put(263, '00');
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  const padded = new Uint8Array(512 + Math.ceil(content.length / 512) * 512);
  padded.set(header);
  padded.set(content, 512);
  return padded;
}

async function tarball(name: string, version: string): Promise<Uint8Array> {
  const manifest = JSON.stringify({ name, version, license: 'MIT', main: 'index.js' });
  const parts = [
    tarEntry('package/package.json', manifest),
    tarEntry('package/index.js', 'module.exports = 1;\n'),
    new Uint8Array(1024),
  ];
  const archive = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    archive.set(part, at);
    at += part.length;
  }
  return gzip(archive);
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodedName(name: string): string {
  return name.replace('/', '%2f');
}

/** Builds the ordered acceptance steps for one booted runtime. */
export function notificationAcceptanceSteps(
  h: AcceptanceHarness,
): readonly (readonly [string, () => Promise<void>])[] {
  const endpoints: { alpha?: { id: string; revision: number }; beta?: string } = {};
  const delivered = new Set<string>();

  const session = (path: string, method = 'GET', payload?: unknown, ifMatch?: string) =>
    h.fetch(
      new Request(h.origin + path, {
        method,
        headers: {
          origin: h.origin,
          ...h.world.sessionHeaders,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }),
    );
  const npm = (path: string, method = 'GET', payload?: unknown) => {
    const json = payload === undefined ? undefined : JSON.stringify(payload);
    return h.fetch(
      new Request(`${h.origin}/alpha/npm/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${h.world.publishToken}`,
          ...(json === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(new TextEncoder().encode(json).length),
              }),
        },
        ...(json === undefined ? {} : { body: json }),
      }),
    );
  };
  async function expectStatus(response: Response, status: number, label: string) {
    if (response.status !== status)
      fail(label, `${response.status} ${await response.text()}`, status);
  }
  async function publish(name: string, version: string, status: number) {
    const bytes = await tarball(name, version);
    await expectStatus(
      await npm(encodedName(name), 'PUT', {
        name,
        versions: { [version]: { name, version, license: 'MIT', main: 'index.js' } },
        'dist-tags': { latest: version },
        _attachments: {
          [`${name}-${version}.tgz`]: { data: base64(bytes), length: bytes.length },
        },
      }),
      status,
      `publish ${name}@${version}`,
    );
  }
  async function packument(name: string) {
    const response = await npm(encodedName(name));
    await expectStatus(response.clone(), 200, `read ${name}`);
    return (await response.json()) as {
      _rev: string;
      versions: Record<string, Record<string, unknown>>;
    };
  }
  /** The alpha requests not yet accounted for, in arrival order. */
  function fresh(): ReceivedRequest[] {
    const unseen = h.receiver.at(ALPHA_URL).filter((request) => !delivered.has(key(request)));
    for (const request of unseen) delivered.add(key(request));
    return unseen;
  }
  const key = (request: ReceivedRequest) =>
    `${request.headers.get('x-package-broker-delivery')}|${request.headers.get('x-package-broker-timestamp')}|${request.status}|${h.receiver.seen.indexOf(request)}`;
  const kinds = (requests: readonly ReceivedRequest[]) =>
    requests
      .map((request) => `${body(request).type} ${body(request).name}@${body(request).version}`)
      .sort();
  async function revision(id: string): Promise<number> {
    const response = await session(`/_pb/projects/alpha/notifications/${id}`);
    await expectStatus(response.clone(), 200, 'read endpoint');
    return ((await response.json()) as { revision: number }).revision;
  }

  return [
    [
      'creates disabled endpoints through the API and enables them',
      async () => {
        const created = await session('/_pb/projects/alpha/notifications', 'POST', {
          name: 'Alpha releases',
          method: 'POST',
          events: ALL_EVENTS,
          packagePattern: '*',
          secret: {
            url: ALPHA_URL,
            headers: [{ name: 'Authorization', value: 'Bearer SENTINELHEADER' }],
            signingKey: SIGNING_KEY,
            template: TEMPLATE,
          },
        });
        const text = await created.clone().text();
        await expectStatus(created, 201, 'alpha endpoint creation');
        if (SENTINEL.test(text)) fail('creation response echoes a secret', text);
        const alpha = JSON.parse(text) as { id: string; state: string; revision: number };
        same([alpha.state, alpha.revision], ['disabled', 1], 'alpha endpoint created disabled');
        const enabled = await session(
          `/_pb/projects/alpha/notifications/${alpha.id}/enable`,
          'POST',
          undefined,
          '"r1"',
        );
        await expectStatus(enabled.clone(), 200, 'enable alpha');
        same(((await enabled.json()) as { state: string }).state, 'enabled', 'alpha enabled');
        endpoints.alpha = { id: alpha.id, revision: 2 };

        const beta = await session('/_pb/projects/beta/notifications', 'POST', {
          name: 'Beta releases',
          method: 'PUT',
          events: ALL_EVENTS,
          packagePattern: '*',
          secret: { url: BETA_URL, signingKey: SIGNING_KEY },
        });
        await expectStatus(beta.clone(), 201, 'beta endpoint creation');
        const betaId = ((await beta.json()) as { id: string }).id;
        await expectStatus(
          await session(
            `/_pb/projects/beta/notifications/${betaId}/enable`,
            'POST',
            undefined,
            '"r1"',
          ),
          200,
          'enable beta',
        );
        endpoints.beta = betaId;
      },
    ],
    [
      'delivers an immediate publish once, signed, to the originating project only',
      async () => {
        await publish('@acme/widget', '1.0.0', 201);
        await h.drain();
        same(kinds(fresh()), ['npm.package.published @acme/widget@1.0.0'], 'published delivery');
      },
    ],
    [
      'delivers one released event for an approved held publish and no published event',
      async () => {
        await publish('@held/thing', '1.0.0', 202);
        await h.drain();
        same(kinds(fresh()), [], 'held publish delivers nothing');
        const list = await session('/_pb/publishes');
        await expectStatus(list.clone(), 200, 'list held publishes');
        const items = ((await list.json()) as { items: { id: string }[] }).items;
        same(items.length, 1, 'one held publish');
        const detail = await session(`/_pb/publishes/${items[0]!.id}`);
        await expectStatus(detail.clone(), 200, 'read held publish');
        const approved = await session(
          `/_pb/publishes/${items[0]!.id}/approve`,
          'POST',
          {},
          detail.headers.get('etag') ?? '',
        );
        await expectStatus(approved, 200, 'approve held publish');
        await h.drain();
        same(kinds(fresh()), ['npm.package.released @held/thing@1.0.0'], 'released delivery');
      },
    ],
    [
      'delivers a deprecation change',
      async () => {
        const document = await packument('@acme/widget');
        document.versions['1.0.0']!['deprecated'] = 'use the next major';
        await expectStatus(
          await npm(encodedName('@acme/widget'), 'PUT', document),
          200,
          'deprecate',
        );
        await h.drain();
        same(
          kinds(fresh()),
          ['npm.package.deprecation_changed @acme/widget@1.0.0'],
          'deprecation delivery',
        );
      },
    ],
    [
      'delivers an explicit dist-tag addition',
      async () => {
        await expectStatus(
          await npm(`-/package/${encodedName('@acme/widget')}/dist-tags/beta`, 'PUT', '1.0.0'),
          200,
          'dist-tag add',
        );
        await h.drain();
        same(kinds(fresh()), ['npm.package.dist_tag_changed @acme/widget@1.0.0'], 'tag delivery');
      },
    ],
    [
      'retries a refused delivery at its next slot with the same delivery and bytes, without a burst',
      async () => {
        h.receiver.failNext(503);
        await publish('@acme/widget', '1.0.1', 201);
        await h.drain();
        await h.drain();
        const first = fresh();
        same(
          first.map((request) => request.status),
          [503],
          'first attempt refused, no burst',
        );
        const waiting = (await h.deliveries()).filter((row) => row.state === 'pending');
        same(
          waiting.map((row) => [row.attempts, row.outcome_code]),
          [[1, 'http_retry']],
          'delivery waits for its next slot',
        );
        await h.advanceRetry();
        await h.drain();
        const second = fresh();
        same(
          second.map((request) => request.status),
          [204],
          'retry delivered',
        );
        const [a, b] = [first[0]!, second[0]!];
        same(
          [b.headers.get('x-package-broker-delivery'), b.headers.get('x-package-broker-event')],
          [a.headers.get('x-package-broker-delivery'), a.headers.get('x-package-broker-event')],
          'stable delivery and event ids',
        );
        same(decoder.decode(b.body), decoder.decode(a.body), 'same body bytes');
        const row = (await h.deliveries()).find((delivery) => delivery.id === waiting[0]!.id);
        same([row?.state, row?.attempts], ['delivered', 2], 'delivered on attempt 2');
      },
    ],
    [
      'does not replay events committed while the endpoint was disabled',
      async () => {
        const alpha = endpoints.alpha!;
        const current = await revision(alpha.id);
        await expectStatus(
          await session(
            `/_pb/projects/alpha/notifications/${alpha.id}/disable`,
            'POST',
            undefined,
            `"r${current}"`,
          ),
          200,
          'disable alpha',
        );
        await publish('@acme/widget', '1.0.2', 201);
        await h.drain();
        await expectStatus(
          await session(
            `/_pb/projects/alpha/notifications/${alpha.id}/enable`,
            'POST',
            undefined,
            `"r${current + 1}"`,
          ),
          200,
          're-enable alpha',
        );
        await h.drain();
        same(kinds(fresh()), [], 'nothing replayed after re-enable');
        const rows = (await h.deliveries()).filter((row) => row.endpoint_id === alpha.id);
        same(rows.length, 5, 'no delivery was created while disabled');
      },
    ],
    [
      'delivers an in-window unpublish and the tag move it causes',
      async () => {
        const { _rev } = await packument('@acme/widget');
        await expectStatus(
          await npm(`@acme/widget/-/widget-1.0.2.tgz/-rev/${_rev}`, 'DELETE'),
          200,
          'unpublish 1.0.2',
        );
        await h.drain();
        same(
          kinds(fresh()),
          [
            'npm.package.dist_tag_changed @acme/widget@1.0.1',
            'npm.package.unpublished @acme/widget@1.0.2',
          ],
          'unpublish deliveries',
        );
      },
    ],
    [
      'delivered every event exactly once with a valid signature and nothing elsewhere',
      async () => {
        const requests = h.receiver.at(ALPHA_URL);
        const byDelivery = new Map<string, ReceivedRequest[]>();
        for (const request of requests) {
          const signed = await verifyNotificationSignature({
            key: keyBytes(),
            timestamp: Number(request.headers.get('x-package-broker-timestamp')),
            deliveryId: request.headers.get('x-package-broker-delivery') ?? '',
            eventId: request.headers.get('x-package-broker-event') ?? '',
            method: request.method === 'PUT' ? 'PUT' : 'POST',
            body: request.body,
            signature: request.headers.get('x-package-broker-signature') ?? '',
            now: Math.floor(Date.now() / 1000),
          });
          if (!signed)
            fail('signature does not verify', request.headers.get('x-package-broker-delivery'));
          if (body(request).id !== request.headers.get('x-package-broker-event'))
            fail('event header differs from the rendered event id', body(request).id);
          if (body(request).marker !== 'SENTINELTEMPLATE')
            fail('template not applied', body(request));
          const id = request.headers.get('x-package-broker-delivery') ?? '';
          byDelivery.set(id, [...(byDelivery.get(id) ?? []), request]);
        }
        const delivered = [...byDelivery.values()].map(
          (attempts) => attempts.filter((request) => request.status === 204).length,
        );
        same(
          delivered.every((count) => count === 1),
          true,
          'each delivery accepted exactly once',
        );
        same(byDelivery.size, 7, 'seven events delivered to alpha');
        const events = new Set(
          requests.map((request) => request.headers.get('x-package-broker-event')),
        );
        same(events.size, 7, 'one delivery per event');
        same(h.receiver.at(BETA_URL).length, 0, 'beta received nothing from alpha commits');
        same(h.receiver.strays, [], 'no other outbound request');
        const rows = await h.deliveries();
        same(
          rows.filter((row) => row.project_id === h.world.projects.beta).length,
          0,
          'no delivery row for beta',
        );
        same(
          rows.map((row) => row.state).filter((state) => state !== 'delivered'),
          [],
          'every delivery delivered',
        );
        same(
          kinds(requests.filter((request) => request.status === 204)).filter((kind) =>
            kind.startsWith('npm.package.published @held'),
          ),
          [],
          'no published event for the released version',
        );
      },
    ],
    [
      'never exposes a configured secret in API responses, stored rows or logs',
      async () => {
        const alpha = endpoints.alpha!;
        const texts: string[] = [];
        const read = async (path: string) => {
          const response = await session(path);
          await expectStatus(response.clone(), 200, `read ${path}`);
          texts.push(await response.clone().text(), JSON.stringify([...response.headers]));
          return response;
        };
        await read('/_pb/projects/alpha/notifications');
        await read(`/_pb/projects/alpha/notifications/${alpha.id}`);
        const history = (await (
          await read(`/_pb/projects/alpha/notifications/${alpha.id}/deliveries`)
        ).json()) as { items: { id: string }[] };
        same(history.items.length, 7, 'delivery history lists every delivery');
        for (const item of history.items)
          await read(`/_pb/projects/alpha/notifications/${alpha.id}/deliveries/${item.id}`);
        texts.push(await h.stored(), h.logs());
        const leaked = texts.join('\n').match(/.{0,40}SENTINEL.{0,40}/);
        if (leaked !== null) fail('secret marker leaked', leaked[0]);
      },
    ],
    [
      'keeps endpoint management available with the flag off without capturing or sending',
      async () => {
        await h.disableNotifications();
        await expectStatus(
          await session('/_pb/projects/alpha/notifications'),
          200,
          'flag-off list endpoints',
        );
        await expectStatus(
          await session('/_pb/projects/alpha/notifications', 'POST', {
            secret: { url: ALPHA_URL, headers: [], signingKey: SIGNING_KEY, template: null },
            name: 'Flag-off management',
            method: 'POST',
            events: ['npm.package.published'],
            packagePattern: '*',
          }),
          201,
          'flag-off create endpoint',
        );
        const before = (await h.deliveries()).length;
        const received = h.receiver.seen.length;
        await publish('@acme/flag-off', '1.0.0', 201);
        await h.drain();
        same((await h.deliveries()).length, before, 'flag-off publish creates no delivery');
        same(h.receiver.seen.length, received, 'flag-off publish sends nothing');
      },
    ],
  ];
}
