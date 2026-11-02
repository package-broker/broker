import { describe, expect, it } from 'vitest';
import { MAX_PACKAGE_CANDIDATES } from '../../catalogue/policy-access.js';
import type { PolicyRule } from '../../db/registry-policy.js';
import {
  composerEntry,
  composerVersionId,
  policyHttp,
} from '../../test-support/policy-registry-http.js';
import { policyRule } from '../../test-support/registry-policy-session.js';

const BLOCK = '01J0P0000000000000000000B1';
const AGE = '01J0P0000000000000000000A1';
const FLOOR = '01J0P0000000000000000000F1';
const DAY = 86_400_000;

function block(members: string[], packageKey = 'acme/lib'): PolicyRule {
  return policyRule(BLOCK, { ecosystem: 'composer', packageKey, members });
}

const entries = () => [composerEntry(3, 'acme/lib'), composerEntry(2, 'acme/other')];

describe('Composer routes with registry policy', () => {
  it('with the flag off, rules are ignored and the date validator is kept', async () => {
    const http = policyHttp({ entries: entries(), rules: [block([])], policy: false });
    const response = await http.composerGet('/p2/acme/lib.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('last-modified')).not.toBeNull();
    expect(response.headers.get('etag')).toBeNull();
    expect(http.clockCalls).toEqual(['composer-p2']);
    expect(http.policy.policy.queries).toEqual([]);
  });

  it('the root omits an all-denied package and keeps permitted ones', async () => {
    const http = policyHttp({ entries: entries(), rules: [block([], 'acme/other')] });
    const response = await http.composerGet('/packages.json');
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>)['available-packages']).toEqual([
      'acme/lib',
    ]);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('an open namespace stays without an enumeration', async () => {
    const http = policyHttp({ entries: entries(), openNamespace: true });
    expect(await (await http.composerGet('/packages.json')).json()).not.toHaveProperty(
      'available-packages',
    );
  });

  it('omits the enumeration rather than fail when the candidate bound is reached', async () => {
    const many = Array.from({ length: MAX_PACKAGE_CANDIDATES + 1 }, (_, n) =>
      composerEntry(1, `acme/p${String(n).padStart(5, '0')}`),
    );
    const http = policyHttp({ entries: many });
    const response = await http.composerGet('/packages.json');
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('available-packages');
  });

  it('an unchanged allowed P2 document answers 304 after evaluation', async () => {
    const http = policyHttp({ entries: entries(), rules: [block(['1.0.1.0'])] });
    const etag = (await http.composerGet('/p2/acme/lib.json')).headers.get('etag')!;
    const cached = await http.composerGet('/p2/acme/lib.json', { 'if-none-match': etag });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('a changed filter, an age transition or another client never reuse an old response', async () => {
    const lib = composerEntry(3);
    lib.versions[2] = { ...lib.versions[2]!, publishedAt: '2026-10-30T00:00:00.000Z' };
    const http = policyHttp({
      entries: [lib],
      rules: [
        policyRule(AGE, {
          ecosystem: 'composer',
          kind: 'min_age',
          packageKey: null,
          minAgeSeconds: 7 * 86_400,
        }),
      ],
    });
    const etag = (await http.composerGet('/p2/acme/lib.json')).headers.get('etag')!;
    http.policy.time.advance(5 * DAY);
    expect((await http.composerGet('/p2/acme/lib.json', { 'if-none-match': etag })).status).toBe(
      200,
    );
    const aged = (await http.composerGet('/p2/acme/lib.json')).headers.get('etag')!;
    const other = await http.composerGet('/p2/acme/lib.json', {
      'if-none-match': aged,
      'user-agent': 'curl/8.4.0',
    });
    expect(other.status).toBe(200);
    http.policy.policy.commit([block(['1.0.0.0'])]);
    expect((await http.composerGet('/p2/acme/lib.json', { 'if-none-match': aged })).status).toBe(
      200,
    );
  });

  it('If-None-Match: * on a package with no eligible version is the uniform 404', async () => {
    const http = policyHttp({ entries: entries(), rules: [block([])] });
    const response = await http.composerGet('/p2/acme/lib.json', { 'if-none-match': '*' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('Composer 1 is still refused with 406 before any policy is read', async () => {
    const http = policyHttp({ entries: entries() });
    const response = await http.composerGet('/packages.json', { 'user-agent': 'Composer/1.10.0' });
    expect(response.status).toBe(406);
    expect(http.policy.policy.queries).toEqual([]);
  });

  it('a client floor is the fixed 403 before any fill, and an unknown client passes by default', async () => {
    const floor = policyRule(FLOOR, {
      ecosystem: 'composer',
      kind: 'client_floor',
      packageKey: null,
      clientFamily: 'composer',
      clientMinVersion: '2.8.0',
    });
    const http = policyHttp({ entries: entries(), rules: [floor] });
    const refused = await http.composerGet('/p2/acme/lib.json');
    expect(refused.status).toBe(403);
    expect(refused.headers.get('cache-control')).toBe('private, no-store');
    expect(await refused.json()).toMatchObject({
      error: { code: 'policy_denied', message: 'Package access denied by policy' },
    });
    expect(http.fills).toEqual([]);
    expect(
      (await http.composerGet('/p2/acme/lib.json', { 'user-agent': 'Composer/2.8.1' })).status,
    ).toBe(200);
    expect(
      (await http.composerGet('/p2/acme/lib.json', { 'user-agent': 'curl/8.4.0' })).status,
    ).toBe(200);
  });

  it('a denied dist is a 404 with durable evidence; an allowed dist is served', async () => {
    const http = policyHttp({ entries: entries(), rules: [block(['1.0.1.0'])] });
    const denied = await http.composerGet(`/dist/acme/lib/${composerVersionId(1)}.1.zip`);
    expect(denied.status).toBe(404);
    expect(http.policy.audit.events).toHaveLength(1);
    expect(http.served).toEqual([]);
    const allowed = await http.composerGet(`/dist/acme/lib/${composerVersionId(2)}.1.zip`);
    expect(allowed.status).toBe(200);
  });

  it('a dist audit failure is the fixed 503 with no bytes', async () => {
    const http = policyHttp({ entries: entries(), rules: [block(['1.0.1.0'])], auditFails: true });
    const response = await http.composerGet(`/dist/acme/lib/${composerVersionId(1)}.1.zip`);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(http.served).toEqual([]);
  });
});
