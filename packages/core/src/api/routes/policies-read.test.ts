import { describe, expect, it } from 'vitest';
import { POLICY_RULE_ID, policyRuleRecord } from '../../test-support/policy-manage.js';
import { POLICY_PROJECT, policyRouteFixture } from '../../test-support/policy-routes.js';

const PACKAGE = '01J0PKG0000000000000000001';
const projectRule = policyRuleRecord({
  id: '01J0P0000000000000000000R2',
  projectId: POLICY_PROJECT,
});
const otherProjectRule = policyRuleRecord({
  id: '01J0P0000000000000000000R3',
  projectId: '01J0PR0J000000000000000009',
});
const rules = () => [policyRuleRecord(), projectRule, otherProjectRule];
const FORBIDDEN_KEYS = ['dist', 'tarball', 'readme', 'manifest', 'url', 'sourceId', 'integrity'];

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, into));
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      keysOf(item, into);
    }
  }
  return into;
}

describe('policy read routes', () => {
  it('lists and reads organization rules for a manager, never cached', async () => {
    const f = await policyRouteFixture({ rules: rules() });
    const list = await f.request('/_pb/policies');
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect(await list.json()).toMatchObject({
      items: [{ id: POLICY_RULE_ID, package: 'left-pad' }],
    });
    const detail = await f.request(`/_pb/policies/${POLICY_RULE_ID}`);
    expect(detail.status).toBe(200);
    expect(detail.headers.get('etag')).toBe('"r1"');
    expect(await detail.json()).toMatchObject({ id: POLICY_RULE_ID, members: ['1.0.0'] });
    const filtered = await f.request(`/_pb/policies?project=${POLICY_PROJECT}`);
    expect(await filtered.json()).toMatchObject({ items: [{ id: projectRule.id }] });
  });

  it('refuses ordinary package readers', async () => {
    const f = await policyRouteFixture({
      rules: rules(),
      permissions: ['org:packages:read', 'project:packages:read'],
    });
    for (const path of [
      '/_pb/policies',
      `/_pb/policies/${POLICY_RULE_ID}`,
      `/_pb/policies/packages/${PACKAGE}`,
      '/_pb/projects/demo/policies',
      `/_pb/projects/demo/policies/${projectRule.id}`,
      `/_pb/projects/demo/policies/packages/${PACKAGE}`,
    ]) {
      const response = await f.request(path);
      expect(response.status, path).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(f.audits).toEqual([]);
  });

  it('conceals rules outside a project manager scope', async () => {
    const f = await policyRouteFixture({
      rules: rules(),
      permissions: ['project:packages:read', 'project:packages:manage'],
    });
    expect((await f.request(`/_pb/projects/demo/policies/${POLICY_RULE_ID}`)).status).toBe(404);
    expect((await f.request(`/_pb/projects/demo/policies/${otherProjectRule.id}`)).status).toBe(
      404,
    );
    const own = await f.request(`/_pb/projects/demo/policies/${projectRule.id}`);
    expect(own.status).toBe(200);
    const list = await f.request('/_pb/projects/demo/policies');
    const listed = (await list.json()) as { items: { id: string }[] };
    expect(listed.items.map((item) => item.id)).toEqual([projectRule.id]);
    expect((await f.request('/_pb/policies')).status).toBe(403);
  });

  it('serves manager diagnostics without installable content and audits the inspection', async () => {
    const f = await policyRouteFixture({
      rules: rules(),
      facts: [
        {
          packageId: PACKAGE,
          sourceId: 'https://user:token@registry.invalid/',
          ecosystem: 'npm',
          packageKey: 'left-pad',
          versionId: '01J0VER0000000000000000001',
          version: '1.0.0',
          versionNormalized: '1.0.0',
          revision: 1,
          status: 'active',
          publishedAt: '2026-10-01T00:00:00.000Z',
          publishedAtBasis: 'release_date',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    });
    const response = await f.request(`/_pb/projects/demo/policies/packages/${PACKAGE}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ packageId: PACKAGE, versions: [{ version: '1.0.0' }] });
    for (const key of FORBIDDEN_KEYS) expect(keysOf(body).has(key)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('token');
    expect(f.audits.map((event) => [event.action, event.projectId])).toEqual([
      ['policy.inspect', POLICY_PROJECT],
    ]);
  });

  it('offers no route that returns package content', async () => {
    const f = await policyRouteFixture();
    expect(f.routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [
        'GET /_pb/policies',
        'POST /_pb/policies',
        'GET /_pb/policies/:policy',
        'PATCH /_pb/policies/:policy',
        'GET /_pb/policies/packages/:package',
        'GET /_pb/projects/:project/policies',
        'POST /_pb/projects/:project/policies',
        'GET /_pb/projects/:project/policies/:policy',
        'PATCH /_pb/projects/:project/policies/:policy',
        'GET /_pb/projects/:project/policies/packages/:package',
      ].sort(),
    );
  });
});
