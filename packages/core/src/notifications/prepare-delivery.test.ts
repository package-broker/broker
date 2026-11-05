import { describe, expect, it, vi } from 'vitest';
import {
  CREATED,
  DELIVERY,
  LEASE,
  ORG,
  PROJECT,
  deliveryWorld,
  memoryCredentials,
  publishedEvent,
  sealedConfiguration,
} from '../test-support/notification-delivery.js';
import { orgContext } from '../db/port.js';
import { encodeNotificationEvent } from './events.js';
import { NotificationBodyError, cancellation, prepareDelivery } from './prepare-delivery.js';

const allow = { allows: () => true };

async function setup(template: string | null = null) {
  const credentials = memoryCredentials();
  const configuration = await sealedConfiguration(credentials, { template });
  const world = deliveryWorld(credentials, configuration);
  const deps = {
    repository: world.prepare,
    credentials: credentials.credentials,
    bodies: credentials.bodies,
    transport: allow,
  };
  const context = async () => (await world.prepare.context(ORG, DELIVERY))!;
  return { credentials, world, deps, context };
}

describe('notification delivery preparation', () => {
  it.each([1, 2])('rethrows a stored body repository failure (read %i)', async (read) => {
    const { world, deps, context, credentials } = await setup();
    await prepareDelivery(deps, ORG, LEASE, await context());
    const bodyId = world.state.delivery.bodyCredentialId;
    const get = credentials.repository.get.bind(credentials.repository);
    const error = new Error('body repository unavailable');
    let reads = 0;
    vi.spyOn(credentials.repository, 'get').mockImplementation(async (ctx, id) => {
      if (id === bodyId && ++reads === read) throw error;
      return get(ctx, id);
    });
    await expect(prepareDelivery(deps, ORG, LEASE, await context())).rejects.toBe(error);
    expect(world.state.delivery.state).toBe('pending');
    expect(world.state.endpoint?.state).toBe('enabled');
  });

  it('cancels for a detached source, archived project, changed, disabled or deleted endpoint', async () => {
    const { world, deps, context } = await setup();
    const cases: [() => void, string][] = [
      [() => (world.state.admitted = false), 'admission_lost'],
      [() => (world.state.projectActive = false), 'project_inactive'],
      [
        () => (world.state.endpoint = { state: 'enabled', revision: 2, method: 'POST' }),
        'superseded',
      ],
      [
        () => (world.state.endpoint = { state: 'disabled', revision: 2, method: 'POST' }),
        'disabled',
      ],
      [() => (world.state.endpoint = { state: 'deleted', revision: 3, method: 'POST' }), 'deleted'],
      [() => (world.state.endpoint = null), 'deleted'],
    ];
    for (const [change, code] of cases) {
      change();
      expect(await prepareDelivery(deps, ORG, LEASE, await context())).toEqual({
        kind: 'cancel',
        code,
      });
    }
    expect(world.calls.filter((call) => call.kind === 'attachBody')).toEqual([]);
  });

  it('accepts a removal event without the removed version still existing', async () => {
    const { world, deps, context } = await setup();
    world.state.payloadJson = JSON.stringify(
      publishedEvent({
        type: 'npm.package.unpublished',
        package: { ecosystem: 'npm', name: '@acme/widget', version: null },
        data: { removalScope: 'package', removalKind: 'window' },
      } as never),
    );
    const prepared = await prepareDelivery(deps, ORG, LEASE, await context());
    expect(prepared.kind).toBe('ready');
    expect(cancellation(await context())).toBeNull();
  });

  it('renders once, seals the bytes for this delivery and reuses them on retry', async () => {
    const { world, deps, context, credentials } = await setup('{"n":"{{package.name}}"}');
    const first = await prepareDelivery(deps, ORG, LEASE, await context());
    expect(first.kind).toBe('ready');
    const bytes = first.kind === 'ready' ? first.body : new Uint8Array();
    expect(new TextDecoder().decode(bytes)).toBe('{"n":"@acme/widget"}');
    expect(world.state.delivery.bodyCredentialId).not.toBeNull();
    world.state.payloadJson = JSON.stringify(
      publishedEvent({ package: { ecosystem: 'npm', name: '@acme/other', version: '1.0.0' } }),
    );
    const second = await prepareDelivery(deps, ORG, LEASE, await context());
    expect(second.kind === 'ready' ? [...second.body] : null).toEqual([...bytes]);
    expect(world.calls.filter((call) => call.kind === 'attachBody')).toHaveLength(1);
    expect(
      [...credentials.rows.values()].filter((row) => row.kind === 'npm-notification-body'),
    ).toHaveLength(1);
  });

  it('defaults to the canonical envelope bytes', async () => {
    const { deps, context } = await setup();
    const prepared = await prepareDelivery(deps, ORG, LEASE, await context());
    expect(prepared.kind === 'ready' ? [...prepared.body] : null).toEqual([
      ...encodeNotificationEvent(publishedEvent()),
    ]);
  });

  it('refuses a body sealed for another delivery, project or organization', async () => {
    const { credentials } = await setup();
    const sealed = await credentials.bodies.prepare(
      ORG,
      { projectId: PROJECT, deliveryId: DELIVERY },
      new TextEncoder().encode('{}'),
    );
    credentials.commit(sealed.credentialId);
    const open = (over: object, ctx = ORG) =>
      credentials.bodies.open(ctx, {
        projectId: PROJECT,
        deliveryId: DELIVERY,
        credentialId: sealed.credentialId,
        ...over,
      });
    await expect(open({})).resolves.toEqual(new TextEncoder().encode('{}'));
    await expect(
      open({ deliveryId: '1b5f1c8e-2d3a-4c1b-9e7f-1a2b3c4d5e6f' }),
    ).rejects.toBeInstanceOf(NotificationBodyError);
    await expect(open({ projectId: '01J0PR0JECT0000000000000PB' })).rejects.toBeInstanceOf(
      NotificationBodyError,
    );
    await expect(open({}, orgContext('01J00000000000000000000B0B'))).rejects.toBeInstanceOf(
      NotificationBodyError,
    );
    const configuration = [...credentials.rows.values()].find(
      (row) => row.kind === 'npm-notification',
    );
    await expect(open({ credentialId: configuration!.id })).rejects.toBeInstanceOf(
      NotificationBodyError,
    );
  });

  it('fails a delivery whose stored body was sealed for another delivery and disables', async () => {
    const { world, deps, context, credentials } = await setup();
    const foreign = await credentials.bodies.prepare(
      ORG,
      { projectId: PROJECT, deliveryId: '1b5f1c8e-2d3a-4c1b-9e7f-1a2b3c4d5e6f' },
      new TextEncoder().encode('{"stolen":true}'),
    );
    credentials.commit(foreign.credentialId);
    world.state.delivery = { ...world.state.delivery, bodyCredentialId: foreign.credentialId };
    expect(await prepareDelivery(deps, ORG, LEASE, await context())).toEqual({
      kind: 'fail',
      code: 'credentials',
      disable: 'credentials',
    });
  });

  it('fails and disables for an unreadable configuration or a destination the policy refuses', async () => {
    const credentials = memoryCredentials();
    const other = await sealedConfiguration(credentials, {
      endpointId: '01J0EEEEEEEEEEEEEEEEEEEEE9',
    });
    const world = deliveryWorld(credentials, other);
    const deps = {
      repository: world.prepare,
      credentials: credentials.credentials,
      bodies: credentials.bodies,
      transport: allow,
    };
    const context = (await world.prepare.context(ORG, DELIVERY))!;
    expect(await prepareDelivery(deps, ORG, LEASE, context)).toEqual({
      kind: 'fail',
      code: 'credentials',
      disable: 'credentials',
    });
    const own = await setup();
    const allows = vi.fn(() => false);
    expect(
      await prepareDelivery(
        { ...own.deps, transport: { allows } },
        ORG,
        LEASE,
        await own.context(),
      ),
    ).toEqual({ kind: 'fail', code: 'policy', disable: 'policy' });
    expect(allows).toHaveBeenCalledWith(
      'https://hooks.example.com/in/SECRETPATH?token=SECRETQUERY',
    );
  });

  it('fails without disabling when the stored event does not belong to the delivery', async () => {
    const { world, deps, context } = await setup();
    world.state.payloadJson = JSON.stringify(publishedEvent({ id: '01J0EVENT00000000000000002' }));
    expect(await prepareDelivery(deps, ORG, LEASE, await context())).toEqual({
      kind: 'fail',
      code: 'template',
      disable: null,
    });
    world.state.payloadJson = '{"schemaVersion":2}';
    expect((await prepareDelivery(deps, ORG, LEASE, await context())).kind).toBe('fail');
  });

  it('fails without disabling when the template cannot render this event', async () => {
    const { world, deps, context } = await setup('{"v":"{{package.version}}"}');
    world.state.payloadJson = JSON.stringify(
      publishedEvent({ type: 'npm.package.released', data: { releaseCause: 'scan' } } as never),
    );
    expect(await prepareDelivery(deps, ORG, LEASE, await context())).toEqual({
      kind: 'fail',
      code: 'template',
      disable: null,
    });
    expect(world.state.delivery.bodyCredentialId).toBeNull();
  });

  it('reports a stale delivery when the body attach loses its claim', async () => {
    const { world, deps, context } = await setup();
    const read = await context();
    world.state.delivery = { ...world.state.delivery, revision: 2 };
    expect(await prepareDelivery(deps, ORG, LEASE, read)).toEqual({ kind: 'stale' });
    expect(CREATED).toBe(world.state.delivery.createdAt);
  });
});
