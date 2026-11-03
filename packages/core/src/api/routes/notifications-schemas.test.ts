import { describe, expect, it, vi } from 'vitest';
import { toJsonSchema } from '../json-schema.js';
import { validateInput } from '../validate.js';
import {
  ENDPOINT,
  FOREIGN,
  KEY,
  OPTIONS,
  SECRET,
  notificationRouteFixture,
} from '../../test-support/notification-routes.js';
import { NOTIFICATION_API_SPECS, NOTIFICATION_SCHEMAS } from './notifications-schemas.js';

const BASE = '/_pb/projects/demo/notifications';
const SECRET_KEYS = /^(url|headers|signingKey|template|credentialId|.*Credential.*|destination)$/;

function keys(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) schema.forEach((item) => keys(item, found));
  else if (schema !== null && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && value !== null && typeof value === 'object')
        Object.keys(value).forEach((name) => found.add(name));
      keys(value, found);
    }
  }
  return found;
}

describe('notification API schemas', () => {
  it('declares no secret field in any response', () => {
    for (const spec of NOTIFICATION_API_SPECS) {
      for (const schema of Object.values(spec.api.responses)) {
        if (schema === null) continue;
        const names = [...keys(toJsonSchema(schema, 'output'))];
        expect(names.filter((name) => SECRET_KEYS.test(name))).toEqual([]);
      }
    }
  });

  it('puts every route under the project settings authority on the project boundary', () => {
    for (const spec of NOTIFICATION_API_SPECS) {
      expect(spec.path.startsWith('/_pb/projects/:project/notifications')).toBe(true);
      expect(spec.boundary).toBe('project');
      expect(spec.permission).toBe('project:settings:write');
      expect('concurrency' in spec).toBe(
        ['PATCH', 'DELETE'].includes(spec.method) || /\/(enable|disable)$/.test(spec.path),
      );
    }
  });

  it.each([
    ['unknown event', { ...OPTIONS, events: ['npm.package.read'], secret: SECRET }],
    ['empty events', { ...OPTIONS, events: [], secret: SECRET }],
    ['GET method', { ...OPTIONS, method: 'GET', secret: SECRET }],
    ['long pattern', { ...OPTIONS, packagePattern: 'a'.repeat(51), secret: SECRET }],
    ['short key', { ...OPTIONS, secret: { ...SECRET, signingKey: KEY.slice(1) } }],
    ['extra secret field', { ...OPTIONS, secret: { ...SECRET, credentialId: 'x' } }],
    ['missing secret', { ...OPTIONS }],
    ['extra field', { ...OPTIONS, secret: SECRET, projectId: 'other' }],
    [
      'too many headers',
      {
        ...OPTIONS,
        secret: {
          ...SECRET,
          headers: Array.from({ length: 17 }, (_, i) => ({ name: `X-${i}`, value: 'v' })),
        },
      },
    ],
    ['oversized template', { ...OPTIONS, secret: { ...SECRET, template: 'x'.repeat(8193) } }],
  ])('refuses a create body with %s', (_label, body) => {
    expect(validateInput(NOTIFICATION_SCHEMAS.createBody, body).ok).toBe(false);
  });

  it('accepts a create body with only the required secret fields', () => {
    expect(
      validateInput(NOTIFICATION_SCHEMAS.createBody, {
        ...OPTIONS,
        secret: { url: SECRET.url, signingKey: KEY },
      }).ok,
    ).toBe(true);
  });

  it('refuses invalid cursors, limits and states before any read', async () => {
    const f = await notificationRouteFixture(vi);
    for (const query of ['?limit=0', '?limit=51', '?cursor=nope', '?other=1']) {
      expect((await f.request('GET', `${BASE}${query}`)).status).toBe(400);
    }
    for (const query of ['?state=lost', '?cursor=2026-11-01T00:00:00.000Z', '?limit=x']) {
      expect((await f.request('GET', `${BASE}/${ENDPOINT}/deliveries${query}`)).status).toBe(400);
    }
    expect((await f.request('GET', `${BASE}/${ENDPOINT}/deliveries/not-a-uuid`)).status).toBe(400);
    expect(f.reads.listEndpoints).not.toHaveBeenCalled();
    expect(f.reads.listDeliveries).not.toHaveBeenCalled();
  });

  it('requires If-Match on every change of an existing endpoint', async () => {
    const f = await notificationRouteFixture(vi);
    const responses = [
      await f.request('PATCH', `${BASE}/${ENDPOINT}`, { body: { options: OPTIONS } }),
      await f.request('POST', `${BASE}/${ENDPOINT}/enable`),
      await f.request('POST', `${BASE}/${ENDPOINT}/disable`),
      await f.request('DELETE', `${BASE}/${ENDPOINT}`),
    ];
    expect(responses.map((response) => response.status)).toEqual([428, 428, 428, 428]);
    expect(f.writes.update).not.toHaveBeenCalled();
    expect(f.writes.enable).not.toHaveBeenCalled();
  });

  it('answers another project endpoint exactly like a missing one', async () => {
    const f = await notificationRouteFixture(vi);
    const foreign = await f.request('GET', `${BASE}/${FOREIGN}`);
    const missing = await f.request('GET', `${BASE}/01JB0000000000000000000009`);
    expect(foreign.status).toBe(404);
    const strip = async (response: Response) => {
      const body = (await response.json()) as { error: Record<string, unknown> };
      delete body.error.requestId;
      return body;
    };
    expect(await strip(foreign)).toEqual(await strip(missing));
    expect((await f.request('POST', `${BASE}/${FOREIGN}/enable`, { ifMatch: '"r1"' })).status).toBe(
      404,
    );
    expect(f.rows.get(`01JA0000000000000000000002/${FOREIGN}`)?.state).toBe('disabled');
  });
});
