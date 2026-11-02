import { describe, expect, it } from 'vitest';
import type { PolicyRule } from '../../db/registry-policy.js';
import {
  catalogueEntry,
  type CatalogueEntry,
} from '../../test-support/registry-policy-catalogue.js';
import { policyRule } from '../../test-support/registry-policy-session.js';
import { policyHttp } from '../../test-support/policy-registry-http.js';

const BLOCK = '01J0P0000000000000000000B1';
const AGE = '01J0P0000000000000000000A1';
const DAY = 86_400_000;

function block(members: string[], packageKey = 'left-pad'): PolicyRule {
  return policyRule(BLOCK, { packageKey, members });
}

function entries(): CatalogueEntry[] {
  const pad = catalogueEntry(5);
  pad.tags = { latest: 'V0004', beta: 'V0003' };
  pad.pkg = { ...pad.pkg, projectId: 'P' };
  const other = catalogueEntry(2, 'right-pad');
  other.description = 'pads right';
  return [pad, other];
}

const versionsOf = async (response: Response) =>
  Object.keys(((await response.json()) as { versions: Record<string, unknown> }).versions);

describe('npm routes with registry policy', () => {
  it('with the flag off, stored rules are ignored, no policy is read and the legacy validator is kept', async () => {
    const http = policyHttp({ entries: entries(), rules: [block([])], policy: false });
    const response = await http.npmGet('/left-pad');
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{16}"$/);
    expect(await versionsOf(response)).toHaveLength(5);
    expect((await http.npmGet('/left-pad/1.0.4')).status).toBe(200);
    expect(http.policy.policy.queries).toEqual([]);
  });

  it('serves the filtered packument with revalidation and a policy ETag', async () => {
    const http = policyHttp({ entries: entries(), rules: [block(['1.0.4'])] });
    const response = await http.npmGet('/left-pad');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(response.headers.get('etag')).toMatch(/^W\/"p\./);
    expect(await versionsOf(response)).toEqual(['1.0.0', '1.0.1', '1.0.2', '1.0.3']);
  });

  it('an unchanged allowed packument still answers 304 after evaluation', async () => {
    const http = policyHttp({ entries: entries(), rules: [block(['1.0.4'])] });
    const etag = (await http.npmGet('/left-pad')).headers.get('etag')!;
    const cached = await http.npmGet('/left-pad', { 'if-none-match': etag });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('cache-control')).toBe('private, no-cache');
    expect(http.policy.policy.queries.length).toBeGreaterThan(0);
  });

  it('an old ETag after a block returns the changed body, never a 304', async () => {
    const http = policyHttp({ entries: entries() });
    const etag = (await http.npmGet('/left-pad')).headers.get('etag')!;
    http.policy.policy.commit([block(['1.0.4'])]);
    const after = await http.npmGet('/left-pad', { 'if-none-match': etag });
    expect(after.status).toBe(200);
    expect(await versionsOf(after)).not.toContain('1.0.4');
  });

  it('an age transition without any write changes the ETag and the body', async () => {
    const recent = entries();
    recent[0]!.versions[4] = {
      ...recent[0]!.versions[4]!,
      publishedAt: '2026-10-30T00:00:00.000Z',
    };
    const http = policyHttp({
      entries: recent,
      rules: [policyRule(AGE, { kind: 'min_age', packageKey: null, minAgeSeconds: 7 * 86_400 })],
    });
    const before = await http.npmGet('/left-pad');
    const etag = before.headers.get('etag')!;
    expect(await versionsOf(before)).not.toContain('1.0.4');
    http.policy.time.advance(4 * DAY);
    expect((await http.npmGet('/left-pad', { 'if-none-match': etag })).status).toBe(304);
    http.policy.time.advance(DAY);
    const aged = await http.npmGet('/left-pad', { 'if-none-match': etag });
    expect(aged.status).toBe(200);
    expect(await versionsOf(aged)).toContain('1.0.4');
  });

  it('a different client family is a different representation', async () => {
    const http = policyHttp({ entries: entries() });
    const npm = (await http.npmGet('/left-pad')).headers.get('etag')!;
    const pnpm = await http.npmGet('/left-pad', {
      'user-agent': 'pnpm/9.1.0 npm/? node/v20.11.0 linux x64',
      'if-none-match': npm,
    });
    expect(pnpm.status).toBe(200);
    expect(pnpm.headers.get('etag')).not.toBe(npm);
  });

  it('If-None-Match: * is answered only after existence and evaluation', async () => {
    const allowed = policyHttp({ entries: entries() });
    expect((await allowed.npmGet('/left-pad', { 'if-none-match': '*' })).status).toBe(304);
    const denied = policyHttp({ entries: entries(), rules: [block([])] });
    const response = await denied.npmGet('/left-pad', { 'if-none-match': '*' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'not_found', error: 'Route not found' });
  });

  it('a date-only conditional and an unfiltered ETag never produce a 304', async () => {
    const legacy = policyHttp({ entries: entries(), policy: false });
    const unfiltered = (await legacy.npmGet('/left-pad')).headers.get('etag')!;
    const http = policyHttp({ entries: entries() });
    expect(
      (await http.npmGet('/left-pad', { 'if-modified-since': 'Wed, 01 Jan 2031 00:00:00 GMT' }))
        .status,
    ).toBe(200);
    expect((await http.npmGet('/left-pad', { 'if-none-match': unfiltered })).status).toBe(200);
  });

  it('a request-wide denial is the fixed 403 before any fill is scheduled', async () => {
    const http = policyHttp({
      entries: entries(),
      hooks: [
        (input) => (input.phase === 'request' ? { deny: true, reason: 'restricted' } : undefined),
      ],
    });
    for (const path of ['/left-pad', '/left-pad/1.0.1', '/left-pad/-/left-pad-1.0.1.tgz']) {
      const response = await http.npmGet(path);
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ code: 'policy_denied' });
    }
    expect(http.fills).toEqual([]);
  });

  it('a policy failure is the fixed 503 on every governed path', async () => {
    const http = policyHttp({ entries: entries() });
    http.policy.policy.state.fail = true;
    for (const path of [
      '/left-pad',
      '/left-pad/1.0.1',
      '/-/package/left-pad/dist-tags',
      '/-/v1/search?text=pad',
      '/left-pad/-/left-pad-1.0.1.tgz',
    ]) {
      const response = await http.npmGet(path);
      expect(response.status, path).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.json()).toMatchObject({ code: 'policy_unavailable' });
    }
  });

  it('a denied version or tag target is the uniform 404 with durable evidence', async () => {
    const http = policyHttp({ entries: entries(), rules: [block(['1.0.4'])] });
    for (const path of ['/left-pad/1.0.4', '/left-pad/latest']) {
      const response = await http.npmGet(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'not_found', error: 'Route not found' });
    }
    expect(http.policy.audit.events.map((event) => event.action)).toEqual([
      'policy.read_denied',
      'policy.read_denied',
    ]);
    expect((await http.npmGet('/left-pad/beta')).status).toBe(200);
  });

  it('dist-tags keep only surviving targets; no eligible version is a 404', async () => {
    const http = policyHttp({ entries: entries(), rules: [block(['1.0.4'])] });
    const tags = await http.npmGet('/-/package/left-pad/dist-tags');
    expect(await tags.json()).toEqual({ beta: '1.0.3' });
    const none = policyHttp({ entries: entries(), rules: [block([])] });
    expect((await none.npmGet('/-/package/left-pad/dist-tags')).status).toBe(404);
  });

  it('search returns only proved packages and counts only what it returns', async () => {
    const http = policyHttp({ entries: entries(), rules: [block([], 'right-pad')] });
    const body = (await (await http.npmGet('/-/v1/search?text=pad')).json()) as {
      objects: Array<{ package: { name: string } }>;
      total: number;
    };
    expect(body.objects.map((item) => item.package.name)).toEqual(['left-pad']);
    expect(body.total).toBe(1);
  });

  it('a denied tarball is a 404 with dist evidence, and no bytes are served', async () => {
    const http = policyHttp({ entries: entries(), rules: [block(['1.0.4'])] });
    const response = await http.npmGet('/left-pad/-/left-pad-1.0.4.tgz');
    expect(response.status).toBe(404);
    expect(http.served).toEqual([]);
    expect(JSON.parse(http.policy.audit.events[0]!.payloadJson)).toMatchObject({
      changes: { read_kind: { new: 'dist' } },
    });
    expect((await http.npmGet('/left-pad/-/left-pad-1.0.3.tgz')).status).toBe(200);
    expect(http.served).toEqual(['V0003']);
  });
});
