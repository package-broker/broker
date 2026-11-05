import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellServices } from '../auth.js';
import { takeNotificationDraft } from './notification-draft.js';
import { createNotificationsController } from './notifications-controller.js';
import {
  createEndpoint,
  deleteEndpoint,
  notice,
  setEnabled,
  updateEndpoint,
} from './notification-actions.js';

const SECRET = {
  url: 'https://hooks.example.com/SENTINEL?token=SENTINEL',
  signingKey: 'S'.repeat(42) + 'A',
  headers: [{ name: 'Authorization', value: 'Bearer SENTINEL' }],
  template: null,
};
const OPTIONS = {
  name: 'Release hook',
  method: 'POST' as const,
  events: ['npm.package.published' as const],
  packagePattern: '*',
};
const ENDPOINT = { id: '01JB0000000000000000000001', revision: 3 };

function fixture(result: unknown) {
  const request = vi.fn().mockResolvedValue(result);
  const requireReauth = vi.fn();
  return {
    request,
    requireReauth,
    services: { client: { request }, requireReauth } as unknown as ShellServices,
  };
}
const reauth = (method: string, path: string, body?: unknown) => ({
  ok: false,
  status: 403,
  code: 'reauth_required',
  details: [],
  request: {
    method,
    path,
    ...(body === undefined ? {} : { body }),
    headers: { 'If-Match': '"r3"' },
  },
});

afterEach(() => vi.unstubAllGlobals());

describe('notification actions', () => {
  it.each(['create', 'replace'] as const)(
    'persists only the non-secret %s draft before reauthentication navigates away',
    async (action) => {
      const stored = new Map<string, string>();
      vi.stubGlobal('sessionStorage', {
        setItem: (key: string, value: string) => stored.set(key, value),
        getItem: (key: string) => stored.get(key) ?? null,
        removeItem: (key: string) => stored.delete(key),
      });
      const f = fixture(reauth('POST', '/_pb/projects/demo/notifications', { secret: SECRET }));
      f.requireReauth.mockImplementation(() => {
        expect([...stored.values()].join()).toContain('Release hook');
        expect([...stored.values()].join()).not.toContain('SENTINEL');
      });
      if (action === 'create') await createEndpoint(f.services, 'demo', OPTIONS, SECRET);
      else await updateEndpoint(f.services, 'demo', ENDPOINT, { options: OPTIONS, secret: SECRET });
      expect(stored.size).toBe(1);
      expect(JSON.parse([...stored.values()][0]!)).toMatchObject({
        project: 'demo',
        options: OPTIONS,
      });
      expect(takeNotificationDraft('demo')).toMatchObject({
        endpoint: action === 'create' ? null : ENDPOINT,
        options: OPTIONS,
      });
      expect(stored.size).toBe(0);
    },
  );

  it.each(['create', 'update', 'enable', 'delete'] as const)(
    'ignores a late %s reauthentication after leaving and returning to the project',
    async (action) => {
      const setItem = vi.fn();
      vi.stubGlobal('sessionStorage', { setItem });
      const f = fixture(reauth('POST', '/_pb/projects/demo/notifications', { secret: SECRET }));
      const controller = createNotificationsController(f.services);
      await controller.load('demo');
      const isCurrent = controller.mutationScope();
      let finish!: (result: unknown) => void;
      f.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending =
        action === 'create'
          ? createEndpoint(f.services, 'demo', OPTIONS, SECRET, isCurrent)
          : action === 'update'
            ? updateEndpoint(
                f.services,
                'demo',
                ENDPOINT,
                { options: OPTIONS, secret: SECRET },
                isCurrent,
              )
            : action === 'enable'
              ? setEnabled(f.services, 'demo', ENDPOINT, true, isCurrent)
              : deleteEndpoint(f.services, 'demo', ENDPOINT, isCurrent);
      await controller.load('other');
      await controller.load('demo');
      finish(reauth('POST', '/_pb/projects/demo/notifications', { secret: SECRET }));
      await pending;
      expect(f.requireReauth).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
    },
  );

  it('never keeps delivery settings for replay after reauthentication on create', async () => {
    const f = fixture(reauth('POST', '/_pb/projects/demo/notifications', { secret: SECRET }));
    const outcome = await createEndpoint(f.services, 'demo', OPTIONS, SECRET);
    expect(outcome).toMatchObject({ ok: false, reauth: true });
    expect(f.requireReauth).toHaveBeenCalledWith(
      { method: 'POST', path: '/_pb/projects/demo/notifications' },
      { credential: true, secretFields: [] },
    );
    expect(JSON.stringify(f.requireReauth.mock.calls)).not.toContain('SENTINEL');
  });

  it('requires reauthentication with re-entry for a settings replacement', async () => {
    const f = fixture(reauth('PATCH', '/_pb/projects/demo/notifications/x', { secret: SECRET }));
    await updateEndpoint(f.services, 'demo', ENDPOINT, { options: OPTIONS, secret: SECRET });
    expect(f.requireReauth.mock.calls[0]![1]).toEqual({ credential: true, secretFields: [] });
    expect(JSON.stringify(f.requireReauth.mock.calls)).not.toContain('SENTINEL');
  });

  it('replays a delete after reauthentication with its revision', async () => {
    const failed = reauth('DELETE', '/_pb/projects/demo/notifications/x');
    const f = fixture(failed);
    const outcome = await deleteEndpoint(f.services, 'demo', ENDPOINT);
    expect(f.request).toHaveBeenCalledWith('delete', '/_pb/projects/{project}/notifications/{id}', {
      params: { project: 'demo', id: ENDPOINT.id },
      headers: { 'If-Match': '"r3"' },
    });
    expect(f.requireReauth).toHaveBeenCalledWith(failed.request, {
      credential: false,
      secretFields: [],
    });
    expect(outcome).toMatchObject({ ok: false, reauth: true });
  });

  it('enables and disables without asking for reauthentication', async () => {
    const f = fixture({ ok: true, status: 200, data: { ...ENDPOINT, state: 'enabled' } });
    const enabled = await setEnabled(f.services, 'demo', ENDPOINT, true);
    expect(f.request).toHaveBeenCalledWith(
      'post',
      '/_pb/projects/{project}/notifications/{id}/enable',
      { params: { project: 'demo', id: ENDPOINT.id }, headers: { 'If-Match': '"r3"' } },
    );
    expect(enabled.ok && enabled.message).toContain('earlier events are not replayed');
    await setEnabled(f.services, 'demo', ENDPOINT, false);
    expect(f.request.mock.calls[1]![1]).toBe('/_pb/projects/{project}/notifications/{id}/disable');
    expect(f.requireReauth).not.toHaveBeenCalled();
  });

  it('marks a stale revision so the draft is kept for review, without reauthentication', async () => {
    const f = fixture({
      ok: false,
      status: 412,
      code: 'precondition_failed',
      details: [],
      request: {},
    });
    const outcome = await updateEndpoint(f.services, 'demo', ENDPOINT, { options: OPTIONS });
    expect(outcome).toEqual({
      ok: false,
      reauth: false,
      stale: true,
      message:
        'This endpoint changed while you were editing. Reload the latest settings before saving.',
    });
    expect(f.requireReauth).not.toHaveBeenCalled();
  });

  it('explains the consequence of replacing settings and of each refusal', async () => {
    const f = fixture({ ok: true, status: 200, data: ENDPOINT });
    const replaced = await updateEndpoint(f.services, 'demo', ENDPOINT, { secret: SECRET });
    expect(replaced.ok && replaced.message).toContain(
      'disabled and waiting deliveries were cancelled',
    );
    for (const code of [
      'endpoint_limit',
      'transport_unavailable',
      'invalid_configuration',
    ] as const) {
      const text = notice({
        ok: false,
        status: 400,
        code,
        details: [],
        request: { method: 'POST', path: '/' },
      });
      expect(text).not.toContain(code);
      expect(text.length).toBeGreaterThan(20);
    }
  });
});
