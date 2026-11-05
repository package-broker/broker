import { expect, it } from 'vitest';
import { fixedClock, ulid } from '../ids.js';
import { orgContext } from '../db/port.js';
import type { RouteDefinition } from '../plugin.js';
import { KernelConfigError } from './registry.js';
import { createKernel } from './kernel.js';
const route: RouteDefinition = {
  method: 'POST',
  path: '/-/npm/v1/oidc/token/exchange/package/:name',
  permission: null,
  boundary: 'none',
  needsOrg: false,
  handler: (ctx) => new Response(ctx.params['name']),
};
function kernel(candidate: RouteDefinition, core = false) {
  return createKernel({
    platform: 'node',
    plugins: [],
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-31T00:00:00.000Z'),
      ids: { ulid },
    },
    resolveOrg: async () => orgContext('org'),
    health: async () => true,
    log: () => undefined,
    ...(core ? { coreRoutes: [candidate] } : { ecosystemRoutes: [candidate] }),
  });
}
it('registers the exact host-root POST exchange and decodes an escaped scoped package', async () => {
  const app = await kernel(route);
  const result = await app.fetch(
    new Request('https://broker.test/-/npm/v1/oidc/token/exchange/package/%40scope%2Ftest', {
      method: 'POST',
    }),
  );
  expect(result.status).toBe(200);
  expect(await result.text()).toBe('@scope/test');
});
it.each([
  { method: 'GET' as const },
  { path: '/-/npm/v1/other/:name' },
  { path: '/-/npm/v1/oidc/token/exchange/package/:other' },
  { permission: 'org:read', boundary: 'organization' as const, needsOrg: true },
])('keeps host-route registration restricted for %j', async (patch) => {
  await expect(kernel({ ...route, ...patch })).rejects.toBeInstanceOf(KernelConfigError);
});
it('keeps the admin core route prefix required', async () => {
  await expect(kernel(route, true)).rejects.toBeInstanceOf(KernelConfigError);
});
