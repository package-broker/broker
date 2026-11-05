import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  mutationFence,
  systemMutationFence,
  type AuthenticatedActor,
  type MutationFence,
} from '../authz/fence.js';
import {
  NotificationRepositoryError,
  type NotificationEndpointSummary,
  type NotificationReadRepository,
  type NotificationWriteRepository,
} from '../db/notifications.js';
import { DbError } from '../db/errors.js';
import { orgContext } from '../db/port.js';
import { ulid } from '../ids.js';
import { NotificationError, createNotificationEndpointService } from './endpoints.js';

const ORG = orgContext('01J00000000000000000000A0A');
const PROJECT = '01J0PR0JECT0000000000000PA';
const KEY = 'A'.repeat(42) + 'A';
const SECRET = {
  url: 'https://hooks.example.com/SENTINELPATH?token=SENTINELQUERY',
  headers: [['Authorization', 'Bearer SENTINELHEADER']],
  signingKey: KEY,
};
const OPTIONS = {
  name: 'Release hook',
  method: 'POST',
  events: ['npm.package.released'],
  packagePattern: '@acme/*',
};
const CALL = {
  audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
};
const fence = mutationFence({ userId: 'U1', sessionId: 'S1' } as AuthenticatedActor, {});

function summary(over: Partial<NotificationEndpointSummary> = {}): NotificationEndpointSummary {
  return {
    id: 'E1',
    projectId: PROJECT,
    name: 'Release hook',
    method: 'POST',
    events: ['npm.package.released'],
    packagePattern: '@acme/*',
    state: 'disabled',
    disabledReason: null,
    failureStreak: 0,
    revision: 3,
    destinationConfigured: true,
    signingConfigured: true,
    headersConfigured: true,
    templateConfigured: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function harness(current = summary(), transportAvailable = true) {
  const ok = async () => ({ changed: true, revision: current.revision + 1 });
  const writes = {
    create: vi.fn(async () => ({ changed: true, revision: 1 })),
    update: vi.fn(ok),
    enable: vi.fn(ok),
    disable: vi.fn(ok),
    delete: vi.fn(ok),
  } satisfies NotificationWriteRepository;
  const reads = {
    getEndpoint: vi.fn(async () => current),
  } as unknown as NotificationReadRepository;
  const prepare = vi.fn(
    async (
      _ctx: unknown,
      _binding: unknown,
      secret: { headers: readonly unknown[]; template: unknown },
    ) => ({
      credentialId: ulid(),
      statement: { sql: 'INSERT INTO credential (id) VALUES (?)', params: [] },
      headersConfigured: secret.headers.length > 0,
      templateConfigured: secret.template !== null,
    }),
  );
  const service = createNotificationEndpointService({
    reads,
    writes,
    credentials: { prepare } as never,
    ids: { ulid: () => ulid() },
    clock: { now: () => new Date('2026-11-02T00:00:00.000Z') },
    selfOrigins: ['https://broker.example.org'],
    transportAvailable,
  });
  return { service, writes, prepare };
}

async function refused(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(NotificationError);
  expect((error as NotificationError).code).toBe(code);
  expect(`${String(error)} ${inspect(error)}`).not.toMatch(/SENTINEL|hooks\.example/);
}

describe('notification endpoint service', () => {
  it('creates a disabled endpoint with sealed configuration and audit without secrets', async () => {
    const h = harness();
    const result = await h.service.create(
      ORG,
      fence,
      PROJECT,
      { ...OPTIONS, secret: SECRET },
      CALL,
    );
    expect(result).toEqual({ id: expect.any(String), revision: 1 });
    expect(JSON.stringify(result)).not.toMatch(/SENTINEL/);
    const [, , input] = h.writes.create.mock.calls[0] as unknown as [
      unknown,
      MutationFence,
      { event: { payloadJson: string; action: string }; configuration: unknown },
    ];
    expect(input.event.action).toBe('notification.create');
    expect(input.event.payloadJson).not.toMatch(/SENTINEL|hooks\.example/);
    expect(JSON.parse(input.event.payloadJson).changes).toMatchObject({
      headers_configured: { new: true },
      template_configured: { new: false },
      events: { new: ['npm.package.released'] },
    });
    expect(h.prepare.mock.calls[0]![2]).toMatchObject({
      url: SECRET.url,
      template: null,
    });
  });

  it.each([
    ['http destination', { ...SECRET, url: 'http://hooks.example.com/x' }],
    ['private destination', { ...SECRET, url: 'https://10.0.0.1/x' }],
    ['self origin', { ...SECRET, url: 'https://broker.example.org/hook' }],
    ['reserved header', { ...SECRET, headers: [['Cookie', 'SENTINEL']] }],
    ['short signing key', { ...SECRET, signingKey: 'SENTINEL' }],
    ['template invalid for the selection', { ...SECRET, template: '{"v":"{{data.tag}}"}' }],
  ])('refuses a %s with a fixed error before sealing', async (_label, secret) => {
    const h = harness();
    await refused(
      h.service.create(ORG, fence, PROJECT, { ...OPTIONS, secret }, CALL),
      'invalid_configuration',
    );
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.writes.create).not.toHaveBeenCalled();
  });

  it('refuses invalid public options', async () => {
    const h = harness();
    for (const change of [
      { name: '' },
      { name: 'a\u0007b' },
      { name: 'pay\u202Elpd' },
      { name: 'zero\u200Bwidth' },
      { name: 'line\u2028break' },
      { name: 'lone\uD800half' },
      { name: 'x'.repeat(81) },
      { method: 'GET' },
      { events: [] },
      { events: ['npm.package.released', 'npm.package.released'] },
      { packagePattern: '/^acme/' },
    ])
      await refused(
        h.service.create(ORG, fence, PROJECT, { ...OPTIONS, ...change, secret: SECRET }, CALL),
        'invalid_configuration',
      );
  });

  it('accepts an 80-character name of astral characters', async () => {
    const h = harness();
    await h.service.create(
      ORG,
      fence,
      PROJECT,
      { ...OPTIONS, name: '\u{1F514}'.repeat(80), secret: SECRET },
      CALL,
    );
    expect(h.writes.create).toHaveBeenCalledTimes(1);
  });

  it('refuses machine fences before any write', async () => {
    const h = harness();
    const machine = systemMutationFence('verifier', { id: 'j', owner: 'o', fence: 1 }, {});
    await refused(
      h.service.enable(ORG, machine as unknown as MutationFence, PROJECT, 'E1', 3, CALL),
      'forbidden',
    );
    expect(h.writes.enable).not.toHaveBeenCalled();
  });

  it('keeps the sealed configuration when only public options change', async () => {
    const h = harness();
    await h.service.update(
      ORG,
      fence,
      PROJECT,
      'E1',
      { expectedRevision: 3, options: { ...OPTIONS, name: 'Renamed' } },
      CALL,
    );
    const [, , input] = h.writes.update.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { configuration?: unknown; event: { action: string; payloadJson: string } },
    ];
    expect(input.configuration).toBeUndefined();
    expect(input.event.action).toBe('notification.update');
    expect(JSON.parse(input.event.payloadJson).changes.changed).toEqual({ new: ['name'] });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('replaces the destination as a unit through the reauthenticated configuration path', async () => {
    const h = harness();
    await h.service.update(
      ORG,
      fence,
      PROJECT,
      'E1',
      { expectedRevision: 3, secret: SECRET },
      CALL,
    );
    const [, , input] = h.writes.update.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { configuration?: unknown; event: { action: string; payloadJson: string } },
    ];
    expect(input.configuration).toBeDefined();
    expect(input.event.action).toBe('notification.credential_set');
    expect(input.event.payloadJson).not.toMatch(/SENTINEL/);
  });

  it('refuses an event selection change that a configured template was not validated for', async () => {
    const h = harness(summary({ templateConfigured: true }));
    await refused(
      h.service.update(
        ORG,
        fence,
        PROJECT,
        'E1',
        {
          expectedRevision: 3,
          options: { ...OPTIONS, events: ['npm.package.released', 'npm.package.published'] },
        },
        CALL,
      ),
      'invalid_configuration',
    );
    expect(h.writes.update).not.toHaveBeenCalled();
    await refused(
      h.service.update(
        ORG,
        fence,
        PROJECT,
        'E1',
        {
          expectedRevision: 3,
          options: { ...OPTIONS, events: ['npm.package.released', 'npm.package.published'] },
          secret: { ...SECRET, template: '{"cause":"{{data.releaseCause}}"}' },
        },
        CALL,
      ),
      'invalid_configuration',
    );
    await h.service.update(
      ORG,
      fence,
      PROJECT,
      'E1',
      {
        expectedRevision: 3,
        options: { ...OPTIONS, events: ['npm.package.released', 'npm.package.published'] },
        secret: { ...SECRET, template: '{"name":"{{package.name}}"}' },
      },
      CALL,
    );
    expect(h.writes.update).toHaveBeenCalledOnce();
  });

  it('enables and disables without a configuration and maps a stale revision to a conflict', async () => {
    const h = harness();
    expect(await h.service.enable(ORG, fence, PROJECT, 'E1', 3, CALL)).toEqual({ revision: 4 });
    expect(await h.service.disable(ORG, fence, PROJECT, 'E1', 3, CALL)).toEqual({ revision: 4 });
    h.writes.disable.mockResolvedValueOnce({ changed: false, revision: 5 });
    await refused(h.service.disable(ORG, fence, PROJECT, 'E1', 3, CALL), 'revision_conflict');
    h.writes.enable.mockRejectedValueOnce(new NotificationRepositoryError('forbidden'));
    await refused(h.service.enable(ORG, fence, PROJECT, 'E1', 3, CALL), 'forbidden');
    const [, , disable] = h.writes.disable.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { event: { payloadJson: string } },
    ];
    expect(JSON.parse(disable.event.payloadJson).changes.reason).toEqual({ new: 'manual' });
  });

  it('refuses enable when the runtime has no notification transport', async () => {
    const h = harness(summary(), false);
    await refused(h.service.enable(ORG, fence, PROJECT, 'E1', 3, CALL), 'transport_unavailable');
    expect(h.writes.enable).not.toHaveBeenCalled();
  });

  it('maps repository refusals to fixed notification errors', async () => {
    const h = harness();
    h.writes.create.mockRejectedValueOnce(new NotificationRepositoryError('endpoint_limit'));
    await refused(
      h.service.create(ORG, fence, PROJECT, { ...OPTIONS, secret: SECRET }, CALL),
      'endpoint_limit',
    );
    h.writes.delete.mockRejectedValueOnce(new Error('SENTINEL https://hooks.example.com'));
    await refused(h.service.delete(ORG, fence, PROJECT, 'E1', 3, CALL), 'unavailable');
  });
});

it.each(['create', 'update', 'enable', 'disable', 'delete'] as const)(
  'preserves backlog_full through notification %s',
  async (operation) => {
    const h = harness();
    const error = new DbError('backlog_full', 'Audit backlog is full');
    h.writes[operation].mockRejectedValueOnce(error);
    const call =
      operation === 'create'
        ? h.service.create(ORG, fence, PROJECT, { ...OPTIONS, secret: SECRET }, CALL)
        : operation === 'update'
          ? h.service.update(
              ORG,
              fence,
              PROJECT,
              'E1',
              { expectedRevision: 3, options: OPTIONS },
              CALL,
            )
          : h.service[operation](ORG, fence, PROJECT, 'E1', 3, CALL);
    await expect(call).rejects.toBe(error);
  },
);
