import { describe, expect, it, vi } from 'vitest';
import { NotificationRepositoryError } from '../../db/notifications.js';
import {
  ENDPOINT,
  OPTIONS,
  SECRET,
  SENTINELS,
  notificationRouteFixture,
} from '../../test-support/notification-routes.js';

const BASE = '/_pb/projects/demo/notifications';
const ONE = `${BASE}/${ENDPOINT}`;

async function code(response: Response): Promise<string> {
  const text = await response.text();
  expect(text).not.toMatch(SENTINELS);
  return (JSON.parse(text) as { error: { code: string } }).error.code;
}

describe('notification API writes', () => {
  it('creates a disabled endpoint only after a recent reauthentication', async () => {
    const stale = await notificationRouteFixture(vi, { reauth: false });
    const refused = await stale.request('POST', BASE, { body: { ...OPTIONS, secret: SECRET } });
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe('reauth_required');
    expect(stale.writes.create).not.toHaveBeenCalled();
    expect(stale.prepare).not.toHaveBeenCalled();

    const f = await notificationRouteFixture(vi);
    const created = await f.request('POST', BASE, { body: { ...OPTIONS, secret: SECRET } });
    expect(created.status).toBe(201);
    expect(created.headers.get('etag')).toBe('"r1"');
    const text = await created.text();
    expect(text).not.toMatch(SENTINELS);
    expect(JSON.parse(text)).toMatchObject({ state: 'disabled', name: 'Release hook' });
    expect(f.prepare.mock.calls[0]![2]).toMatchObject({
      url: SECRET.url,
      headers: [['Authorization', 'Bearer SENTINELHEADER']],
    });
  });

  it('refuses a reauthentication of another session', async () => {
    const f = await notificationRouteFixture(vi, { otherSession: true });
    expect(await code(await f.request('DELETE', ONE, { ifMatch: '"r1"' }))).toBe('reauth_required');
    expect(f.writes.delete).not.toHaveBeenCalled();
  });

  it('edits public options without reauthentication', async () => {
    const f = await notificationRouteFixture(vi, { reauth: false });
    const response = await f.request('PATCH', ONE, {
      ifMatch: '"r1"',
      body: { options: { ...OPTIONS, name: 'Renamed hook' } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"r2"');
    expect(f.writes.update.mock.calls[0]![2]).not.toHaveProperty('configuration');
  });

  it('replaces the destination settings only after a recent reauthentication and disables', async () => {
    const stale = await notificationRouteFixture(vi, { reauth: false });
    const refused = await stale.request('PATCH', ONE, {
      ifMatch: '"r1"',
      body: { secret: SECRET },
    });
    expect(await code(refused)).toBe('reauth_required');
    expect(stale.writes.update).not.toHaveBeenCalled();

    const f = await notificationRouteFixture(vi);
    const replaced = await f.request('PATCH', ONE, {
      ifMatch: '"r1"',
      body: { secret: { ...SECRET, template: null } },
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.clone().json()).toMatchObject({
      state: 'disabled',
      disabledReason: 'configuration_changed',
    });
    expect(await replaced.text()).not.toMatch(SENTINELS);
  });

  it('refuses an empty change', async () => {
    const f = await notificationRouteFixture(vi);
    expect(await code(await f.request('PATCH', ONE, { ifMatch: '"r1"', body: {} }))).toBe(
      'invalid_request',
    );
    expect(f.writes.update).not.toHaveBeenCalled();
  });

  it('enables and disables without reauthentication, fenced on the revision', async () => {
    const f = await notificationRouteFixture(vi, { reauth: false });
    const enabled = await f.request('POST', `${ONE}/enable`, { ifMatch: '"r1"' });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ state: 'enabled', revision: 2 });
    const stale = await f.request('POST', `${ONE}/disable`, { ifMatch: '"r1"' });
    expect(stale.status).toBe(412);
    expect((await f.request('POST', `${ONE}/disable`, { ifMatch: '"r2"' })).status).toBe(200);
    expect(f.sessions.isReauthFresh).not.toHaveBeenCalled();
  });

  it('deletes only after a recent reauthentication', async () => {
    const stale = await notificationRouteFixture(vi, { reauth: false });
    expect(await code(await stale.request('DELETE', ONE, { ifMatch: '"r1"' }))).toBe(
      'reauth_required',
    );
    expect(stale.writes.delete).not.toHaveBeenCalled();
    const f = await notificationRouteFixture(vi);
    expect((await f.request('DELETE', ONE, { ifMatch: '"r2"' })).status).toBe(412);
    expect((await f.request('DELETE', ONE, { ifMatch: '"r1"' })).status).toBe(204);
    expect((await f.request('GET', ONE)).status).toBe(404);
  });

  it('refuses a token and a publisher without settings authority before any write', async () => {
    const f = await notificationRouteFixture(vi);
    expect(
      (await f.request('POST', BASE, { auth: 'token', body: { ...OPTIONS, secret: SECRET } }))
        .status,
    ).toBe(403);
    const publisher = await notificationRouteFixture(vi, {
      permissions: ['project:packages:write'],
    });
    expect((await publisher.request('POST', `${ONE}/enable`, { ifMatch: '"r1"' })).status).toBe(
      403,
    );
    expect(f.writes.create).not.toHaveBeenCalled();
    expect(publisher.writes.enable).not.toHaveBeenCalled();
  });

  it('maps a grant revoked at commit to forbidden', async () => {
    const f = await notificationRouteFixture(vi);
    f.writes.enable.mockRejectedValueOnce(new NotificationRepositoryError('forbidden'));
    expect(await code(await f.request('POST', `${ONE}/enable`, { ifMatch: '"r1"' }))).toBe(
      'forbidden',
    );
  });

  it('maps the endpoint cap, a missing transport and invalid configuration to fixed codes', async () => {
    const f = await notificationRouteFixture(vi, { transportAvailable: false });
    f.writes.create.mockRejectedValueOnce(new NotificationRepositoryError('endpoint_limit'));
    const capped = await f.request('POST', BASE, { body: { ...OPTIONS, secret: SECRET } });
    expect(capped.status).toBe(409);
    expect(await code(capped)).toBe('endpoint_limit');
    const unavailable = await f.request('POST', `${ONE}/enable`, { ifMatch: '"r1"' });
    expect(unavailable.status).toBe(503);
    expect(await code(unavailable)).toBe('transport_unavailable');
    const invalid = await f.request('POST', BASE, {
      body: { ...OPTIONS, secret: { ...SECRET, url: 'http://hooks.example.com/SENTINEL' } },
    });
    expect(invalid.status).toBe(400);
    expect(await code(invalid)).toBe('invalid_configuration');
  });
});
