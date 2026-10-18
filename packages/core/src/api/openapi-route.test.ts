import { describe, expect, it, vi } from 'vitest';
import { routeApiProblems } from '../kernel/routes.js';
import type { RequestContext } from '../plugin.js';
import { generateOpenApi } from './openapi.js';
import { openApiRoute } from './openapi-route.js';

describe('openApiRoute', () => {
  it('serves the serialized document publicly with no-store', async () => {
    const document = generateOpenApi([], { title: 'Package Broker', version: '2.0.0' });
    const expected = JSON.stringify(document);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const route = openApiRoute(document);
      expect(stringify.mock.calls.filter(([value]) => value === document)).toHaveLength(1);
      expect(route).toMatchObject({
        method: 'GET',
        path: '/_pb/openapi.json',
        permission: null,
        needsOrg: false,
        api: { exempt: 'openapi document' },
      });
      expect(routeApiProblems(route, 'openapi')).toEqual([]);
      document.info.title = 'Changed after construction';
      for (let i = 0; i < 2; i++) {
        const response = await route.handler({} as RequestContext);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/json');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(expected);
      }
      expect(stringify.mock.calls.filter(([value]) => value === document)).toHaveLength(1);
    } finally {
      stringify.mockRestore();
    }
  });
});
