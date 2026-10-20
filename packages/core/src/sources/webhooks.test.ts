import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { orgContext, type OrgContext } from '../db/port.js';
import type { RequestContext } from '../plugin.js';
import { parseCredentialMaterial, type CredentialMaterial } from './credentials.js';
import type { WebhookVerifier } from './provider.js';
import {
  WEBHOOK_MAX_BODY_BYTES,
  createWebhookIntake,
  type DeliveryOutcome,
  type WebhookDeliveries,
  type WebhookIntakeDeps,
} from './webhooks.js';

const SECRET = 'whsec-correct-horse-battery';
const CRED_A = '01J0CRED0000000000000000A1';
const CRED_B = '01J0CRED0000000000000000B1';
const REPO = 'Acme/Widgets';
const INSTALLATION = 4242;
const SIGNATURE = 'sha256=valid';
const ORG: OrgContext = orgContext('org-a');

const PEM = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n';
const appMaterial = (webhookSecret = SECRET) =>
  parseCredentialMaterial(
    'github_app',
    JSON.stringify({ appId: '1', privateKeyPem: PEM, webhookSecret }),
  );

interface SourceRow {
  readonly id: string;
  readonly credentialId: string;
  readonly installationId: number;
  readonly repository: string;
}

const SOURCES: readonly SourceRow[] = [
  { id: 'src-1', credentialId: CRED_A, installationId: INSTALLATION, repository: REPO },
  { id: 'src-2', credentialId: CRED_A, installationId: INSTALLATION, repository: REPO },
  { id: 'src-other-repo', credentialId: CRED_A, installationId: INSTALLATION, repository: 'a/b' },
  { id: 'src-other-install', credentialId: CRED_A, installationId: 1, repository: REPO },
  { id: 'src-cred-b', credentialId: CRED_B, installationId: INSTALLATION, repository: REPO },
];

function fakeDeliveries(sources: readonly SourceRow[] = SOURCES) {
  const rows = new Map<string, { event: string; outcome: DeliveryOutcome }>();
  const deliveries: WebhookDeliveries = {
    record: vi.fn((_ctx, input) => {
      const existing = rows.get(input.deliveryId);
      if (existing !== undefined) {
        return Promise.resolve({ state: 'duplicate' as const, outcome: existing.outcome });
      }
      rows.set(input.deliveryId, { event: input.event, outcome: 'received' });
      return Promise.resolve({ state: 'new' as const });
    }),
    sourcesFor: vi.fn((_ctx, query) =>
      Promise.resolve(
        sources
          .filter(
            (row) =>
              row.credentialId === query.credentialId &&
              row.installationId === query.installationId &&
              row.repository.toLowerCase() === query.repository.toLowerCase(),
          )
          .map((row) => row.id),
      ),
    ),
    settle: vi.fn((_ctx, input) => {
      const row = rows.get(input.deliveryId);
      if (row?.outcome === 'received') row.outcome = input.outcome;
      return Promise.resolve();
    }),
  };
  return { deliveries, rows };
}

function fakeJobs() {
  const created = new Map<string, { type: string; payload: unknown }>();
  const enqueue = vi.fn(
    (
      _ctx: OrgContext,
      type: string,
      payload: unknown,
      input: { idempotencyKey: string; resourceKey?: string },
    ) => {
      const existing = created.has(input.idempotencyKey);
      if (!existing) created.set(input.idempotencyKey, { type, payload });
      return Promise.resolve({ id: input.idempotencyKey, created: !existing });
    },
  );
  return { enqueue, created };
}

const verifier = (): WebhookVerifier & { verify: ReturnType<typeof vi.fn> } => ({
  verify: vi.fn((secret, headers) =>
    Promise.resolve(secret.token === SECRET && headers.get('x-hub-signature-256') === SIGNATURE),
  ),
});

function setup(overrides: Partial<WebhookIntakeDeps> = {}) {
  const { deliveries, rows } = fakeDeliveries();
  const jobs = fakeJobs();
  const check = verifier();
  const loadCredential = vi.fn((_ctx: OrgContext, id: string) =>
    Promise.resolve<CredentialMaterial | null>(
      id === CRED_A || id === CRED_B ? appMaterial() : null,
    ),
  );
  const route = createWebhookIntake({
    loadCredential,
    verifier: check,
    deliveries,
    jobs,
    ...overrides,
  });
  return { route, deliveries, rows, jobs, check, loadCredential };
}

const push = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ref: 'refs/heads/main',
    repository: { full_name: REPO },
    installation: { id: INSTALLATION },
    ...extra,
  });

async function call(
  route: ReturnType<typeof createWebhookIntake>,
  options: {
    credentialId?: string;
    body?: string;
    event?: string;
    signature?: string | null;
    delivery?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers(options.headers);
  headers.set('x-github-event', options.event ?? 'push');
  headers.set('x-github-delivery', options.delivery ?? 'delivery-1');
  const signature = options.signature === undefined ? SIGNATURE : options.signature;
  if (signature !== null) headers.set('x-hub-signature-256', signature);
  const request = new Request('https://broker.example.test/_pb/hooks/github/x', {
    method: 'POST',
    headers,
    body: options.body ?? push(),
  });
  return await route.handler({
    request,
    org: ORG,
    params: { credentialId: options.credentialId ?? CRED_A },
  } as unknown as RequestContext);
}

async function snapshot(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers].sort(),
    body: await response.text(),
  };
}

describe('route definition', () => {
  it('is a public POST core route with no boundary', () => {
    const { route } = setup();
    expect(route.method).toBe('POST');
    expect(route.path).toBe('/_pb/hooks/github/:credentialId');
    expect(route.permission).toBeNull();
    expect(route.boundary ?? 'none').toBe('none');
  });
});

describe('authentication', () => {
  it('answers a forged signature, a missing header and an unknown credential identically', async () => {
    const { route } = setup();
    const forged = await snapshot(await call(route, { signature: 'sha256=forged' }));
    const missing = await snapshot(await call(route, { signature: null }));
    const unknown = await snapshot(await call(route, { credentialId: 'missing-credential' }));
    expect(forged.status).toBe(401);
    expect(forged.body).toBe('');
    expect(missing).toEqual(forged);
    expect(unknown).toEqual(forged);
  });

  it('runs exactly one verification for every kind of failure', async () => {
    const wrongKind = parseCredentialMaterial(
      'bearer',
      JSON.stringify({ token: 'bearer-token-1' }),
    );
    for (const [load, signature] of [
      [() => Promise.resolve(null), SIGNATURE],
      [() => Promise.resolve(wrongKind), SIGNATURE],
      [() => Promise.resolve(appMaterial()), 'sha256=forged'],
    ] as const) {
      const { route, check, deliveries } = setup({ loadCredential: vi.fn(load) });
      const response = await call(route, { signature });
      expect(response.status).toBe(401);
      expect(check.verify).toHaveBeenCalledTimes(1);
      expect(deliveries.record).not.toHaveBeenCalled();
    }
  });

  it('never accepts a dummy verification as success for an unknown credential', async () => {
    const accepting: WebhookVerifier = { verify: vi.fn(() => Promise.resolve(true)) };
    const { route, deliveries } = setup({
      verifier: accepting,
      loadCredential: () => Promise.resolve(null),
    });
    expect((await call(route)).status).toBe(401);
    expect(accepting.verify).toHaveBeenCalledTimes(1);
    expect(deliveries.record).not.toHaveBeenCalled();
  });

  it('verifies the raw bytes before the body is parsed and hands over a redacted secret', async () => {
    const { route, check } = setup();
    await call(route, { body: '{not json' });
    const [secret, , raw] = check.verify.mock.calls[0] as [{ token: string }, Headers, Uint8Array];
    expect(new TextDecoder().decode(raw)).toBe('{not json');
    expect(secret.token).toBe(SECRET);
    expect(JSON.stringify(secret)).not.toContain(SECRET);
    expect(String(secret)).not.toContain(SECRET);
    expect(inspect(secret)).not.toContain(SECRET);
  });

  it('answers 401 and verifies once when the credential id is missing from the path', async () => {
    const { route, check, loadCredential } = setup();
    const response = await route.handler({
      request: new Request('https://broker.example.test/x', { method: 'POST', body: push() }),
      org: ORG,
      params: {},
    } as unknown as RequestContext);
    expect(response.status).toBe(401);
    expect(check.verify).toHaveBeenCalledTimes(1);
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it('lets a credential loader failure propagate without verifying or recording', async () => {
    const { route, check, deliveries } = setup({
      loadCredential: () => Promise.reject(new Error('credential store unavailable')),
    });
    await expect(call(route)).rejects.toThrow('credential store unavailable');
    expect(check.verify).not.toHaveBeenCalled();
    expect(deliveries.record).not.toHaveBeenCalled();
  });

  it('refuses a verifier that throws without leaking anything', async () => {
    const { route } = setup({
      verifier: { verify: () => Promise.reject(new Error(`boom ${SECRET}`)) },
    });
    const response = await call(route);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
  });
});

describe('body limit', () => {
  it('refuses a 2 MiB body with 413 before the verifier or the credential is touched', async () => {
    const { route, check, loadCredential, deliveries } = setup();
    const response = await call(route, { body: 'x'.repeat(2 * 1024 * 1024) });
    expect(response.status).toBe(413);
    expect(check.verify).not.toHaveBeenCalled();
    expect(loadCredential).not.toHaveBeenCalled();
    expect(deliveries.record).not.toHaveBeenCalled();
  });

  it('refuses an oversized stream that declares no length', async () => {
    const { route, check } = setup();
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 8) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request('https://broker.example.test/x', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    const response = await route.handler({
      request,
      org: ORG,
      params: { credentialId: CRED_A },
    } as unknown as RequestContext);
    expect(response.status).toBe(413);
    expect(check.verify).not.toHaveBeenCalled();
    expect(sent).toBeLessThan(8);
  });

  it('falls back to the streamed cap when content-length is not a number', async () => {
    const { route, check } = setup();
    const small = await call(route, { headers: { 'content-length': 'abc' } });
    expect(small.status).toBe(202);
    const large = await call(route, {
      body: 'x'.repeat(2 * 1024 * 1024),
      headers: { 'content-length': 'abc' },
    });
    expect(large.status).toBe(413);
    expect(check.verify).toHaveBeenCalledTimes(1);
  });

  it('accepts a body of exactly the limit', async () => {
    const { route, check } = setup();
    const response = await call(route, { body: 'y'.repeat(WEBHOOK_MAX_BODY_BYTES) });
    expect(check.verify).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(202);
  });
});

describe('fan-out', () => {
  it('enqueues one idempotent sync per source of the credential, installation and repository', async () => {
    const { route, jobs, rows } = setup();
    const response = await call(route);
    expect(response.status).toBe(202);
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
    const payloads = [...jobs.created.values()].map((job) => job.payload);
    expect(payloads).toEqual([
      { sourceId: 'src-1', reason: 'webhook' },
      { sourceId: 'src-2', reason: 'webhook' },
    ]);
    expect([...jobs.created.values()].every((job) => job.type === 'core:source-sync:v1')).toBe(
      true,
    );
    for (const key of jobs.created.keys()) expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect([...rows.values()].map((row) => row.outcome)).toEqual(['processed']);
  });

  it('keys the jobs on the credential-scoped body digest and the source', async () => {
    const { route, jobs } = setup();
    await call(route);
    const body = new TextEncoder().encode(`push\n${push()}`);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const expected = new Set<string>();
    for (const sourceId of ['src-1', 'src-2']) {
      const text = JSON.stringify([`${CRED_A}:${digest}`, sourceId]);
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
      );
      expected.add([...hash].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
    }
    expect(new Set(jobs.created.keys())).toEqual(expected);
  });

  it('never enqueues a source of another credential', async () => {
    const { route, jobs, deliveries } = setup();
    await call(route, { credentialId: CRED_A });
    const enqueued = [...jobs.created.values()].map(
      (job) => (job.payload as { sourceId: string }).sourceId,
    );
    expect(enqueued).not.toContain('src-cred-b');
    expect(deliveries.sourcesFor).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ credentialId: CRED_A }),
    );
  });

  it('treats a release event as a sync trigger too', async () => {
    const { route, jobs } = setup();
    const body = JSON.stringify({
      action: 'published',
      release: { tag_name: 'v1.0.0' },
      repository: { full_name: REPO },
      installation: { id: INSTALLATION },
    });
    expect((await call(route, { event: 'release', body })).status).toBe(202);
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
  });

  it('records processed without a job when no source matches', async () => {
    const { route, jobs, rows } = setup();
    const body = push({ repository: { full_name: 'nobody/else' } });
    expect((await call(route, { body })).status).toBe(202);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect([...rows.values()][0]?.outcome).toBe('processed');
  });
});

describe('ignored deliveries', () => {
  const cases: readonly [string, string, string][] = [
    ['an unsupported event', 'ping', push()],
    [
      'a push without a ref',
      'push',
      JSON.stringify({ repository: { full_name: REPO }, installation: { id: INSTALLATION } }),
    ],
    [
      'a push without a repository',
      'push',
      JSON.stringify({ ref: 'refs/heads/main', installation: { id: INSTALLATION } }),
    ],
    [
      'a release payload sent as push',
      'push',
      JSON.stringify({
        release: {},
        repository: { full_name: REPO },
        installation: { id: INSTALLATION },
      }),
    ],
    ['a push payload sent as release', 'release', push()],
    [
      'a release without a release object',
      'release',
      JSON.stringify({ repository: { full_name: REPO }, installation: { id: INSTALLATION } }),
    ],
    [
      'a payload without an installation',
      'push',
      JSON.stringify({ ref: 'r', repository: { full_name: REPO } }),
    ],
    ['a non-object payload', 'push', '[]'],
    ['an unparseable payload', 'push', '{nope'],
    [
      'an oversized repository name',
      'push',
      push({ repository: { full_name: 'a/'.padEnd(300, 'b') } }),
    ],
  ];

  for (const [name, event, body] of cases) {
    it(`records ${name} as ignored and enqueues nothing`, async () => {
      const { route, jobs, rows, deliveries } = setup();
      const response = await call(route, { event, body });
      expect(response.status).toBe(202);
      expect(jobs.enqueue).not.toHaveBeenCalled();
      expect(deliveries.sourcesFor).not.toHaveBeenCalled();
      expect([...rows.values()].map((row) => row.outcome)).toEqual(['ignored']);
    });
  }

  it('stores no attacker-chosen event name', async () => {
    const { route, deliveries } = setup();
    await call(route, { event: 'x'.repeat(5000) });
    const input = (deliveries.record as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      event: string;
    };
    expect(input.event).toBe('other');
  });
});

describe('replay and resume', () => {
  it('treats a replayed signed body under a fresh delivery id as a duplicate', async () => {
    const { route, jobs } = setup();
    await call(route, { delivery: 'delivery-1' });
    const before = jobs.enqueue.mock.calls.length;
    const replay = await call(route, { delivery: 'delivery-2' });
    expect(replay.status).toBe(202);
    expect(jobs.enqueue.mock.calls.length).toBe(before);
    expect(jobs.created.size).toBe(2);
  });

  it('does not let a forged event header turn the real delivery into a duplicate', async () => {
    const { route, jobs, rows } = setup();
    expect((await call(route, { event: 'ping' })).status).toBe(202);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect((await call(route, { event: 'push' })).status).toBe(202);
    expect(jobs.created.size).toBe(2);
    expect([...rows.values()].map((row) => row.outcome).sort()).toEqual(['ignored', 'processed']);
  });

  it('does not dedupe the same body across credentials', async () => {
    const { route, deliveries } = setup();
    await call(route, { credentialId: CRED_A });
    await call(route, { credentialId: CRED_B });
    const ids = (deliveries.record as ReturnType<typeof vi.fn>).mock.calls.map(
      (args) => (args[1] as { deliveryId: string }).deliveryId,
    );
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toMatch(new RegExp(`^${CRED_A}:[0-9a-f]{64}$`));
  });

  it('completes the fan-out after a failure following the first enqueue', async () => {
    const { route, jobs, rows } = setup();
    let calls = 0;
    const original = jobs.enqueue.getMockImplementation()!;
    jobs.enqueue.mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('queue unavailable'));
      return original(...args);
    });

    await expect(call(route)).rejects.toThrow();
    expect(jobs.created.size).toBe(1);
    expect([...rows.values()][0]?.outcome).toBe('received');

    const redelivery = await call(route, { delivery: 'delivery-2' });
    expect(redelivery.status).toBe(202);
    expect(jobs.created.size).toBe(2);
    expect([...rows.values()][0]?.outcome).toBe('processed');

    const before = jobs.enqueue.mock.calls.length;
    expect((await call(route, { delivery: 'delivery-3' })).status).toBe(202);
    expect(jobs.enqueue.mock.calls.length).toBe(before);
  });

  it('resumes a delivery whose insert committed but whose source lookup failed', async () => {
    const { route, jobs, deliveries, rows } = setup();
    vi.mocked(deliveries.sourcesFor).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(call(route)).rejects.toThrow();
    expect([...rows.values()][0]?.outcome).toBe('received');
    expect((await call(route)).status).toBe(202);
    expect(jobs.created.size).toBe(2);
  });

  it('does not leak the secret through a failure', async () => {
    const { route, jobs } = setup();
    jobs.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
    const error = await call(route).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain(SECRET);
  });
});
