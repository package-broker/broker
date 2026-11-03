import { describe, expect, it, vi } from 'vitest';
import {
  DELIVERY,
  ENDPOINT,
  FOREIGN,
  OPTIONS,
  SECRET,
  SENTINELS,
  notificationRouteFixture,
} from '../../test-support/notification-routes.js';
import { NOTIFICATION_SCHEMAS } from './notifications-schemas.js';

const BASE = '/_pb/projects/demo/notifications';
const READS = [
  BASE,
  `${BASE}/${ENDPOINT}`,
  `${BASE}/${ENDPOINT}/deliveries`,
  `${BASE}/${ENDPOINT}/deliveries/${DELIVERY}`,
];

describe('notification API reads', () => {
  it.each(READS)('refuses a token on %s before any read', async (path) => {
    const f = await notificationRouteFixture(vi);
    const response = await f.request('GET', path, { auth: 'token' });
    expect(response.status).toBe(403);
    expect(f.reads.listEndpoints).not.toHaveBeenCalled();
    expect(f.reads.getEndpoint).not.toHaveBeenCalled();
  });

  it.each(READS)('refuses a publisher without project settings authority on %s', async (path) => {
    const f = await notificationRouteFixture(vi, {
      permissions: ['project:packages:read', 'project:packages:write'],
    });
    expect((await f.request('GET', path)).status).toBe(403);
    expect(f.reads.getEndpoint).not.toHaveBeenCalled();
  });

  it('lists only the endpoints of the project in the path', async () => {
    const f = await notificationRouteFixture(vi);
    const own = (await (await f.request('GET', BASE)).json()) as { items: { id: string }[] };
    const other = (await (await f.request('GET', '/_pb/projects/other/notifications')).json()) as {
      items: { id: string }[];
    };
    expect(own.items.map((item) => item.id)).toEqual([ENDPOINT]);
    expect(other.items.map((item) => item.id)).toEqual([FOREIGN]);
  });

  it('reads detail with its revision as ETag and history with attempts', async () => {
    const f = await notificationRouteFixture(vi);
    const detail = await f.request('GET', `${BASE}/${ENDPOINT}`);
    expect(detail.status).toBe(200);
    expect(detail.headers.get('etag')).toBe('"r1"');
    expect(detail.headers.get('cache-control')).toBe('no-store');
    const history = (await (
      await f.request('GET', `${BASE}/${ENDPOINT}/deliveries?state=failed&limit=10`)
    ).json()) as { items: { id: string }[] };
    expect(history.items.map((item) => item.id)).toEqual([DELIVERY]);
    expect(f.reads.listDeliveries).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      ENDPOINT,
      {
        limit: 10,
        state: 'failed',
      },
    );
    const one = (await (
      await f.request('GET', `${BASE}/${ENDPOINT}/deliveries/${DELIVERY}`)
    ).json()) as { history: unknown[] };
    expect(one.history).toHaveLength(1);
  });

  it('answers with bodies that match the declared strict response schemas', async () => {
    const f = await notificationRouteFixture(vi);
    const pairs = [
      [BASE, NOTIFICATION_SCHEMAS.endpointList],
      [`${BASE}/${ENDPOINT}`, NOTIFICATION_SCHEMAS.endpoint],
      [`${BASE}/${ENDPOINT}/deliveries`, NOTIFICATION_SCHEMAS.deliveryList],
      [`${BASE}/${ENDPOINT}/deliveries/${DELIVERY}`, NOTIFICATION_SCHEMAS.deliveryDetail],
    ] as const;
    for (const [path, schema] of pairs) {
      expect(schema.safeParse(await (await f.request('GET', path)).json()).success).toBe(true);
    }
  });

  it('answers delivery history of another project endpoint as not found', async () => {
    const f = await notificationRouteFixture(vi);
    expect((await f.request('GET', `${BASE}/${FOREIGN}/deliveries`)).status).toBe(404);
    expect((await f.request('GET', `${BASE}/${FOREIGN}/deliveries/${DELIVERY}`)).status).toBe(404);
    expect(f.reads.listDeliveries).toHaveBeenCalledTimes(1);
  });

  it('keeps history available after deletion only in the owning project', async () => {
    const f = await notificationRouteFixture(vi);
    const removed = await f.request('DELETE', `${BASE}/${ENDPOINT}`, { ifMatch: '"r1"' });
    expect(removed.status).toBe(204);
    expect((await f.request('GET', `${BASE}/${ENDPOINT}`)).status).toBe(404);
    const history = await f.request('GET', `${BASE}/${ENDPOINT}/deliveries`);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ items: [{ id: DELIVERY }] });
    expect(
      (await f.request('GET', `/_pb/projects/other/notifications/${ENDPOINT}/deliveries`)).status,
    ).toBe(404);
    expect((await f.request('GET', `${BASE}/01JB0000000000000000000099/deliveries`)).status).toBe(
      404,
    );
  });

  it('never returns a submitted secret in list, detail or history', async () => {
    const f = await notificationRouteFixture(vi);
    const created = await f.request('POST', BASE, { body: { ...OPTIONS, secret: SECRET } });
    expect(created.status).toBe(201);
    expect(JSON.stringify(f.sealed)).toMatch(SENTINELS);
    const { id } = (await created.clone().json()) as { id: string };
    const texts = [await created.text()];
    for (const path of [...READS, `${BASE}/${id}`, `${BASE}/${id}/deliveries`]) {
      const response = await f.request('GET', path);
      texts.push(await response.text(), JSON.stringify([...response.headers]));
    }
    expect(texts.join('\n')).not.toMatch(SENTINELS);
    expect(texts.join('\n')).not.toMatch(/"(url|signingKey|template|headers)"/);
  });
});
