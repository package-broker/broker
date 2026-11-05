import { describe, expect, it } from 'vitest';
import { policyRule } from '../test-support/registry-policy-session.js';
import { composerEntry, policyHttp } from '../test-support/policy-registry-http.js';
import { catalogueEntry } from '../test-support/registry-policy-catalogue.js';

const PACKAGES = 200;
const BLOCK = '01J0P0000000000000000000B1';

/** Each policy read is one batch: one database round trip. */
function roundTrips(http: ReturnType<typeof policyHttp>): number {
  return http.policy.policy.queries.length + http.policy.policy.namespaces.length;
}

describe('policy rule reads per listing request', () => {
  it('a 200-package Composer root listing reads the rules once and seals one epoch', async () => {
    const entries = Array.from({ length: PACKAGES }, (_, n) =>
      composerEntry(2, `acme/lib-${String(n).padStart(3, '0')}`),
    );
    const http = policyHttp({
      entries,
      namespace: true,
      rules: [
        policyRule(BLOCK, { ecosystem: 'composer', packageKey: 'acme/lib-007', members: [] }),
      ],
    });
    const response = await http.composerGet('/packages.json');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { 'available-packages': string[] };
    expect(body['available-packages']).toHaveLength(PACKAGES - 1);
    expect(body['available-packages']).not.toContain('acme/lib-007');
    expect(roundTrips(http)).toBe(2);
  });

  it('an npm search over many packages reads the rules once and seals one epoch', async () => {
    const entries = Array.from({ length: 20 }, (_, n) =>
      catalogueEntry(2, `pad-${String(n).padStart(2, '0')}`),
    );
    const http = policyHttp({ entries, namespace: true });
    const response = await http.npmGet('/-/v1/search?text=pad&size=20');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { objects: unknown[] }).objects).toHaveLength(20);
    expect(roundTrips(http)).toBe(2);
  });
});
