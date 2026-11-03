import { describe, expect, it, vi } from 'vitest';
import * as pluginApi from '../plugin.js';
import { memoryCredentials } from '../test-support/notification-delivery.js';
import {
  NotificationRuntimeConfigError,
  createNotificationTransport,
  notificationRuntime,
  type NotificationRepositories,
} from './notification-jobs.js';

const transport = createNotificationTransport({
  send: async () => new Response(null, { status: 204 }),
  destination: () => true,
  selfOrigins: [],
});

function input(notifications: unknown, withTransport = true) {
  const repositories = vi.fn((): NotificationRepositories => ({}) as NotificationRepositories);
  const credentials = vi.fn(() => {
    const { store, repository } = memoryCredentials();
    return { store, repository };
  });
  return {
    repositories,
    credentials,
    value: {
      notifications: notifications as never,
      transport: withTransport ? transport : null,
      repositories,
      credentials,
      clock: { now: () => new Date() },
      ids: { ulid: () => '01J0000000000000000000000A' },
      wake: async () => undefined,
    },
  };
}

describe('notification runtime registration', () => {
  it('registers nothing and builds no repository while the flag is off', () => {
    for (const config of [undefined, {}, { enabled: false }]) {
      const { value, repositories, credentials } = input(config);
      expect(notificationRuntime(value)).toEqual({ enabled: false, jobs: [] });
      expect(repositories).not.toHaveBeenCalled();
      expect(credentials).not.toHaveBeenCalled();
    }
  });

  it('stays off without a transport even when the flag is on', () => {
    const { value, repositories } = input({ enabled: true }, false);
    expect(notificationRuntime(value)).toEqual({ enabled: false, jobs: [] });
    expect(repositories).not.toHaveBeenCalled();
  });

  it('refuses an invalid notifications block at startup with fixed problems', () => {
    for (const config of [{ enabled: 'true' }, { enabled: true, extra: 1 }, null, []]) {
      const run = () => notificationRuntime(input(config).value);
      expect(run).toThrow(NotificationRuntimeConfigError);
    }
    try {
      notificationRuntime(input({ enabled: 'secret-value' }).value);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret-value');
      expect((error as NotificationRuntimeConfigError).problems).toEqual([
        'notifications.enabled: must be a boolean',
      ]);
    }
  });

  it('registers the dispatch, delivery and hourly retention core jobs with id-only payloads', () => {
    const runtime = notificationRuntime(input({ enabled: true }).value);
    expect(runtime.enabled).toBe(true);
    expect(runtime.jobs.map((job) => job.qualifiedName)).toEqual([
      'core:notification-dispatch:v1',
      'core:notification-deliver:v1',
      'core:notification-retention:v1',
    ]);
    const [dispatch, deliver, retention] = runtime.jobs;
    expect(retention!.definition.schedule).toEqual({ everySeconds: 3600 });
    expect(() =>
      deliver!.definition.validate({
        deliveryId: '0b5f1c8e-2d3a-4c1b-9e7f-1a2b3c4d5e6f',
        url: 'https://hooks.example.com/',
      }),
    ).toThrow();
    expect(() =>
      dispatch!.definition.validate({ operationId: '01J0000000000000000000000A', body: '{}' }),
    ).toThrow();
    expect(runtime.jobs.every((job) => job.plugin === 'core')).toBe(true);
  });

  it('adds nothing to the public plugin API', () => {
    expect(Object.keys(pluginApi).filter((name) => /notif/i.test(name))).toEqual([]);
  });
});
