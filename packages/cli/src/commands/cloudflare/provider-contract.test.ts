import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import ts from 'typescript';
import { CloudflareApi } from './api.js';
import { cloudflareDeployContract, unverifiedDeployContract } from './deploy.js';
import { installIdentity, type Operation, type ResourceKind } from './inventory.js';
import { cloudflareProviderContract, type RemoteResource } from './provision.js';

// Sanitized owner response (queuesEmpty) and recorded documented response shapes; see T969 report.
const fixtures = JSON.parse(
  await readFile(new URL('./fixtures/provider-responses.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>;
const identity = installIdentity({ accountId: 'a'.repeat(32), workerName: 'broker' });
const required = { queues: true, r2: false, analytics: false };
const contract = cloudflareProviderContract;
function harness(responses: { body: unknown; status?: number }[]) {
  let time = Date.parse('2026-10-23T12:00:00Z');
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const api = new CloudflareApi({
    accountId: identity.account_id,
    apiToken: 'token_SENTINEL',
    fetch,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    jitter: () => 0,
  });
  return { api, fetch };
}
it('implements every deploy contract member unless explicitly allowed', async () => {
  const source = ts.createSourceFile(
    'deploy.ts',
    await readFile(new URL('./deploy.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'DeployProviderContract',
  )!;
  const allowedMissing: readonly string[] = [];
  const missing = declaration.members
    .map((member) => member.name!.getText(source))
    .filter((name) => !Object.hasOwn(cloudflareDeployContract, name));
  expect(missing).toEqual(allowedMissing);
});

const previewVersion = '12345678-1234-4234-8234-123456789abc';
const previewResult = fixtures.versionPreview!.result as Record<string, unknown>;
it('reads the exact version and constructs its documented version URL without mutations', async () => {
  const h = harness([
    { body: fixtures.versionPreview },
    { body: fixtures.versionPreviewSubdomain },
  ]);
  expect(await cloudflareDeployContract.preview(h.api, 'broker', previewVersion)).toEqual({
    version_id: previewVersion,
    url: 'https://12345678-broker.broker-account.workers.dev',
    bindings_verified: true,
  });
  expect(h.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    `/client/v4/accounts/${identity.account_id}/workers/scripts/broker/versions/${previewVersion}`,
    `/client/v4/accounts/${identity.account_id}/workers/subdomain`,
  ]);
  expect(h.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});
it('lowercases the preview URL prefix while retaining the exact version ID', async () => {
  const version = 'ABCDEF12-1234-4234-8234-123456789ABC';
  const h = harness([
    { body: { success: true, result: { ...previewResult, id: version } } },
    { body: fixtures.versionPreviewSubdomain },
  ]);
  expect(await cloudflareDeployContract.preview(h.api, 'broker', version)).toEqual({
    version_id: version,
    url: 'https://abcdef12-broker.broker-account.workers.dev',
    bindings_verified: true,
  });
});
it.each([
  ['broker', 'invalid'],
  ['another/worker', previewVersion],
  ['a'.repeat(55), previewVersion],
])('rejects malformed preview input before requests: %s %s', async (script, version) => {
  const h = harness([]);
  await expect(cloudflareDeployContract.preview(h.api, script, version)).rejects.toMatchObject({
    code: 'invalid_input',
    exitCode: 2,
    stage: 'deploy',
  });
  expect(h.fetch).not.toHaveBeenCalled();
});
it.each([
  ['different version', { ...previewResult, id: 'abcdef12-1234-4234-8234-123456789abc' }],
  ['missing bindings', { ...previewResult, resources: {} }],
  ['empty bindings', { ...previewResult, resources: { bindings: [] } }],
  [
    'duplicate bindings',
    {
      ...previewResult,
      resources: {
        bindings: [
          { type: 'assets', name: 'ASSETS' },
          { type: 'assets', name: 'ASSETS' },
        ],
      },
    },
  ],
  [
    'unsupported binding',
    { ...previewResult, resources: { bindings: [{ type: 'unknown', name: 'SENTINEL' }] } },
  ],
  [
    'empty resource identity',
    { ...previewResult, resources: { bindings: [{ type: 'd1', name: 'DB', id: '' }] } },
  ],
  [
    'secret value returned',
    {
      ...previewResult,
      resources: { bindings: [{ type: 'secret_text', name: 'PB_MASTER_KEY', text: 'SENTINEL' }] },
    },
  ],
])('refuses preview evidence with %s', async (_name, result) => {
  const h = harness([{ body: { success: true, result } }]);
  const error: unknown = await cloudflareDeployContract
    .preview(h.api, 'broker', previewVersion)
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'configuration_conflict', fields: ['preview'] });
  expect(String(error)).not.toContain('SENTINEL');
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it.each([
  null,
  [],
  {},
  { ...previewResult, id: 'invalid' },
  { ...previewResult, resources: null },
  { ...previewResult, resources: { bindings: {} } },
  { ...previewResult, resources: { bindings: null } },
  { ...previewResult, resources: { bindings: [null] } },
  { ...previewResult, resources: { bindings: [{ name: 'DB' }] } },
  { ...previewResult, resources: { bindings: [{ type: 'd1', name: 'DB' }] } },
])('fails closed on malformed version responses: %j', async (result) => {
  const h = harness([{ body: { success: true, result } }]);
  await expect(
    cloudflareDeployContract.preview(h.api, 'broker', previewVersion),
  ).rejects.toMatchObject({ code: 'provider_failure', stage: 'deploy' });
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it.each([
  { body: { success: true, result: {} } },
  { body: { success: true, result: { subdomain: 'SENTINEL.invalid' } } },
  { body: { success: false, errors: [], result: null }, status: 404 },
])('refuses preview without a registered valid workers.dev subdomain: %j', async (subdomain) => {
  const h = harness([{ body: fixtures.versionPreview }, subdomain]);
  await expect(
    cloudflareDeployContract.preview(h.api, 'broker', previewVersion),
  ).rejects.toMatchObject({
    code: 'workers_dev_subdomain_missing',
    exitCode: 2,
    stage: 'deploy',
    message: expect.stringContaining('Register a workers.dev subdomain manually'),
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
it('explicitly refuses preview with the unverified contract', async () => {
  const h = harness([]);
  await expect(
    unverifiedDeployContract.preview(h.api, 'broker', previewVersion),
  ).rejects.toMatchObject({ code: 'capability_unknown', exitCode: 1, stage: 'deploy' });
  expect(h.fetch).not.toHaveBeenCalled();
});
it.each([
  [
    'subdomain',
    'packages.example.com',
    ['zonesEmpty', 'zonesApex', 'dnsNsEmpty'],
    [
      '/zones?name=packages.example.com&page=1&per_page=50',
      '/zones?name=example.com&page=1&per_page=50',
      `/zones/${'1'.repeat(32)}/dns_records?type=NS&name=packages.example.com&page=1&per_page=100`,
    ],
  ],
  ['apex', 'example.com', ['zonesApex'], ['/zones?name=example.com&page=1&per_page=50']],
] as const)(
  'resolves the %s through the production deploy contract',
  async (_name, hostname, bodies, candidates) => {
    const h = harness(bodies.map((name) => ({ body: fixtures[name] })));
    expect(await cloudflareDeployContract.domainZone(h.api, hostname)).toBe('1'.repeat(32));
    expect(h.fetch.mock.calls.map(([url]) => String(url))).toEqual(
      candidates.map((path) => `https://api.cloudflare.com/client/v4${path}`),
    );
  },
);
it.each([
  ['other account', 'packages.example.com', ['zonesOtherAccount'], 'domain_zone_not_found', 1],
  ['no zone', 'packages.example.com', ['zonesEmpty', 'zonesEmpty'], 'domain_zone_not_found', 1],
  ['ambiguous', 'example.com', ['zonesAmbiguous'], 'domain_zone_ambiguous', 1],
  ['malformed', 'example.com', ['zonesMalformed'], 'provider_failure', 1],
  ['inconsistent pagination', 'example.com', ['zonesInconsistent'], 'provider_failure', 1],
  ['pending', 'packages.example.com', ['zonesPending'], 'domain_zone_not_found', 1],
] as const)('rejects %s zone responses', async (_name, hostname, bodies, code, exitCode) => {
  const h = harness(bodies.map((name) => ({ body: fixtures[name] })));
  await expect(cloudflareDeployContract.domainZone(h.api, hostname)).rejects.toMatchObject({
    code,
    exitCode,
    stage: 'deploy',
  });
  expect(h.fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('name'))).toEqual(
    bodies.map((_body, index) => (index === 0 ? hostname : 'example.com')),
  );
});
it('rejects a delegated foreign subzone without falling back to our apex', async () => {
  const h = harness([{ body: fixtures.zonesOtherAccount }, { body: fixtures.zonesApex }]);
  await expect(
    cloudflareDeployContract.domainZone(h.api, 'packages.example.com'),
  ).rejects.toMatchObject({
    code: 'domain_zone_not_found',
    stage: 'deploy',
    message: expect.stringContaining('Zone lookup for packages.example.com:'),
  });
  expect(h.fetch.mock.calls.map(([url]) => String(url))).toEqual([
    'https://api.cloudflare.com/client/v4/zones?name=packages.example.com&page=1&per_page=50',
  ]);
});
it('uses our active apex despite a pending duplicate in another account', async () => {
  const h = harness([{ body: fixtures.zonesApexWithForeignPending }]);
  expect(await cloudflareDeployContract.domainZone(h.api, 'example.com')).toBe('1'.repeat(32));
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('ignores a pending foreign subzone and resolves through our apex', async () => {
  const h = harness([
    { body: fixtures.zonesForeignPendingSubzone },
    { body: fixtures.zonesApex },
    { body: fixtures.dnsNsEmpty },
  ]);
  expect(await cloudflareDeployContract.domainZone(h.api, 'pkg.example.com')).toBe('1'.repeat(32));
  expect(h.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/client/v4/zones',
    '/client/v4/zones',
    `/client/v4/zones/${'1'.repeat(32)}/dns_records`,
  ]);
});
it.each([
  ['delegated', 'dnsNsDelegated'],
  ['not delegated', 'dnsNsEmpty'],
] as const)(
  'checks a hostname for NS delegation before accepting its parent zone: %s',
  async (_name, fixture) => {
    const h = harness([
      { body: fixtures.zonesEmpty },
      { body: fixtures.zonesApex },
      { body: fixtures[fixture] },
    ]);
    const result = cloudflareDeployContract.domainZone(h.api, 'pkg.example.com');
    if (fixture === 'dnsNsDelegated')
      await expect(result).rejects.toMatchObject({
        code: 'domain_zone_not_found',
        stage: 'deploy',
        message: expect.stringMatching(/pkg\.example\.com.*delegated away from zone example\.com/),
      });
    else await expect(result).resolves.toBe('1'.repeat(32));
    expect(h.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cloudflare.com/client/v4/zones?name=pkg.example.com&page=1&per_page=50',
      'https://api.cloudflare.com/client/v4/zones?name=example.com&page=1&per_page=50',
      `https://api.cloudflare.com/client/v4/zones/${'1'.repeat(32)}/dns_records?type=NS&name=pkg.example.com&page=1&per_page=100`,
    ]);
  },
);
it('checks every intermediate name and stops on a delegation below the apex', async () => {
  const h = harness([
    { body: fixtures.zonesEmpty },
    { body: fixtures.zonesEmpty },
    { body: fixtures.zonesApex },
    { body: fixtures.dnsNsEmpty },
    { body: fixtures.dnsNsDelegated },
  ]);
  await expect(
    cloudflareDeployContract.domainZone(h.api, 'deep.pkg.example.com'),
  ).rejects.toMatchObject({ code: 'domain_zone_not_found', stage: 'deploy' });
  expect(
    h.fetch.mock.calls.slice(3).map(([url]) => new URL(String(url)).searchParams.get('name')),
  ).toEqual(['deep.pkg.example.com', 'pkg.example.com']);
});
it.each([
  [401, 'permission_denied', false],
  [403, 'domain_zone_not_found', false],
  [503, 'provider_failure', true],
] as const)(
  'preserves DNS read failure details at deploy stage: %s',
  async (status, code, retryable) => {
    const h = harness([
      { body: fixtures.zonesEmpty },
      { body: fixtures.zonesApex },
      ...Array.from({ length: status === 503 ? 5 : 1 }, () => ({
        body: fixtures.forbidden,
        status,
      })),
    ]);
    const error: unknown = await cloudflareDeployContract
      .domainZone(h.api, 'pkg.example.com')
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code, status, retryable, stage: 'deploy' });
    if (status === 403)
      expect(error).toMatchObject({
        message: expect.stringMatching(/pkg\.example\.com.*DNS Read.*DNS Edit/),
      });
  },
);
it('rejects inconsistent DNS listing pagination at deploy stage', async () => {
  const h = harness([
    { body: fixtures.zonesEmpty },
    { body: fixtures.zonesApex },
    { body: { ...fixtures.dnsNsEmpty, result_info: { total_pages: 1, total_count: 1 } } },
  ]);
  await expect(cloudflareDeployContract.domainZone(h.api, 'pkg.example.com')).rejects.toMatchObject(
    { code: 'provider_failure', stage: 'deploy', retryable: false },
  );
});
it('preserves transient zone lookup failure details at deploy stage', async () => {
  const h = harness(Array.from({ length: 5 }, () => ({ body: fixtures.forbidden, status: 503 })));
  await expect(cloudflareDeployContract.domainZone(h.api, 'example.com')).rejects.toMatchObject({
    code: 'provider_failure',
    status: 503,
    retryable: true,
    stage: 'deploy',
  });
});
it('reports a malformed zone account at deploy stage', async () => {
  const zone = (fixtures.zonesApex!.result as Record<string, unknown>[])[0]!;
  const h = harness([{ body: { ...fixtures.zonesApex, result: [{ ...zone, account: null }] } }]);
  await expect(cloudflareDeployContract.domainZone(h.api, 'example.com')).rejects.toMatchObject({
    code: 'provider_failure',
    status: null,
    retryable: false,
    stage: 'deploy',
  });
});
it('never requests a single-label zone candidate', async () => {
  const h = harness([{ body: fixtures.zonesEmpty }]);
  await expect(cloudflareDeployContract.domainZone(h.api, 'example.com')).rejects.toMatchObject({
    code: 'domain_zone_not_found',
  });
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(new URL(String(h.fetch.mock.calls[0]?.[0])).searchParams.get('name')).toBe('example.com');
  const single = harness([]);
  await expect(cloudflareDeployContract.domainZone(single.api, 'com')).rejects.toMatchObject({
    code: 'invalid_input',
    exitCode: 2,
    stage: 'deploy',
  });
  expect(single.fetch).not.toHaveBeenCalled();
});
it('prefers an exact zone for the longest suffix and ignores non-exact names', async () => {
  const zone = (fixtures.zonesApex!.result as Record<string, unknown>[])[0]!;
  const exact = harness([
    { body: { ...fixtures.zonesApex, result: [{ ...zone, name: 'packages.example.com' }] } },
  ]);
  expect(await cloudflareDeployContract.domainZone(exact.api, 'packages.example.com')).toBe(
    zone.id,
  );
  expect(exact.fetch).toHaveBeenCalledTimes(1);
  const parent = harness([
    { body: fixtures.zonesApex },
    { body: fixtures.zonesApex },
    { body: fixtures.dnsNsEmpty },
  ]);
  expect(await cloudflareDeployContract.domainZone(parent.api, 'packages.example.com')).toBe(
    zone.id,
  );
  expect(parent.fetch).toHaveBeenCalledTimes(3);
});
it('checks all pages before accepting an exact zone match', async () => {
  const body = fixtures.zonesApex!;
  const h = harness([
    { body: { ...body, result_info: { page: 1, count: 1, total_pages: 2, total_count: 2 } } },
    { body: { ...body, result_info: { page: 2, count: 1, total_pages: 2, total_count: 2 } } },
  ]);
  await expect(cloudflareDeployContract.domainZone(h.api, 'example.com')).rejects.toMatchObject({
    code: 'domain_zone_ambiguous',
    stage: 'deploy',
    message: expect.stringMatching(/^Zone lookup for example\.com:.*remove the duplicate zone/),
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
it.each(['', 'invalid', 'A'.repeat(32), '1'.repeat(31)])(
  'rejects invalid zone ids: %s',
  async (id) => {
    const zone = (fixtures.zonesApex!.result as Record<string, unknown>[])[0]!;
    const h = harness([{ body: { ...fixtures.zonesApex, result: [{ ...zone, id }] } }]);
    await expect(cloudflareDeployContract.domainZone(h.api, 'example.com')).rejects.toMatchObject({
      code: 'domain_zone_not_found',
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  { result: null },
  { result: [null] },
  { result_info: undefined },
  { result_info: { page: 2, count: 1, total_pages: 1, total_count: 1 } },
  { result_info: { page: 1, count: 0, total_pages: 1, total_count: 1 } },
  { result_info: { total_pages: '1', total_count: 1 } },
])('fails closed on malformed zone response details: %j', async (override) => {
  const h = harness([{ body: { ...fixtures.zonesApex, ...override } }]);
  await expect(cloudflareDeployContract.domainZone(h.api, 'example.com')).rejects.toMatchObject({
    code: 'provider_failure',
  });
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('gives actionable zone guidance for a forbidden lookup', async () => {
  const h = harness([{ body: fixtures.forbidden, status: 403 }]);
  const error: unknown = await cloudflareDeployContract
    .domainZone(h.api, 'example.com')
    .catch((error: unknown) => error);
  expect(error).toMatchObject({
    code: 'domain_zone_not_found',
    exitCode: 1,
    status: 403,
    stage: 'deploy',
    message: expect.stringMatching(
      /^Zone lookup for example\.com:.*Zone Read.*Workers Routes Edit.*DNS Edit/,
    ),
  });
  expect(String(error)).not.toMatch(/SENTINEL|person@example.com|user:password|Workers Paid/);
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('preserves an authentication failure instead of treating it as a missing zone', async () => {
  const h = harness([{ body: fixtures.forbidden, status: 401 }]);
  const error: unknown = await cloudflareDeployContract
    .domainZone(h.api, 'example.com')
    .catch((error: unknown) => error);
  expect(error).toMatchObject({
    code: 'permission_denied',
    status: 401,
    exitCode: 1,
    stage: 'deploy',
    retryable: false,
  });
  expect(String(error)).not.toMatch(/SENTINEL|person@example.com|user:password/);
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('explicitly refuses zone lookup with the unverified contract', async () => {
  const h = harness([]);
  await expect(unverifiedDeployContract.domainZone(h.api, 'example.com')).rejects.toMatchObject({
    code: 'domain_zone_not_supported',
    stage: 'deploy',
  });
  expect(h.fetch).not.toHaveBeenCalled();
});
it('accepts the real empty queues response with null diagnostics and zero pages', async () => {
  const h = harness([{ body: fixtures.queuesEmpty }]);
  expect(await contract.capabilities(h.api, required, identity)).toEqual({
    queues: { supported: true, remaining: 10_000 },
  });
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(String(h.fetch.mock.calls[0]?.[0])).toContain(
    `/accounts/${identity.account_id}/queues?page=1&per_page=100`,
  );
});
it('counts every queue page before calculating remaining capacity', async () => {
  const h = harness([{ body: fixtures.queuesFirstPage }, { body: fixtures.queuesLastPage }]);
  expect(await contract.capabilities(h.api, required, identity)).toEqual({
    queues: { supported: true, remaining: 9998 },
  });
  expect(String(h.fetch.mock.calls[1]?.[0])).toContain('page=2&per_page=100');
});
it.each([200, 403, 429])(
  'treats queue denial or documented plan limit (%s) as unsupported',
  async (status) => {
    const h = harness([
      { body: status === 403 ? fixtures.forbidden : fixtures.queuesPlanLimit, status },
    ]);
    expect(await contract.capabilities(h.api, required, identity)).toEqual({
      queues: { supported: false, remaining: 0 },
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ['missing metadata', undefined],
  ['partial page', { total_pages: 1, total_count: 2 }],
  ['invalid page count', { total_pages: '1', total_count: 0 }],
  ['contradictory zero pages', { total_pages: 0, total_count: 1 }],
  ['incorrect page number', { page: 2, total_pages: 1, total_count: 0 }],
  ['incorrect page count', { count: 1, total_pages: 0, total_count: 0 }],
  ['invalid cursor', { cursor: null, total_count: 0 }],
])('leaves malformed queue pagination unknown: %s', async (_name, result_info) => {
  const h = harness([{ body: { ...fixtures.queuesEmpty, result_info } }]);
  await expect(contract.capabilities(h.api, required, identity)).rejects.toMatchObject({
    code: 'capability_unknown',
    check: 'queues',
  });
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it.each([{ result: null }, { result: {} }, { result: [null] }])(
  'leaves malformed queue results unknown: $result',
  async ({ result }) => {
    const h = harness([{ body: { ...fixtures.queuesEmpty, result } }]);
    await expect(contract.capabilities(h.api, required, identity)).rejects.toMatchObject({
      code: 'capability_unknown',
      check: 'queues',
    });
  },
);
it('rejects changing queue totals between pages', async () => {
  const h = harness([
    { body: fixtures.queuesFirstPage },
    { body: { ...fixtures.queuesLastPage, result_info: { total_pages: 2, total_count: 3 } } },
  ]);
  await expect(contract.capabilities(h.api, required, identity)).rejects.toMatchObject({
    code: 'capability_unknown',
    check: 'queues',
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
it('keeps an authentication failure unknown and excludes provider diagnostics from output', async () => {
  const h = harness([{ body: fixtures.forbidden, status: 401 }]);
  const error: unknown = await contract
    .capabilities(h.api, required, identity)
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'capability_unknown', check: 'queues' });
  expect(String(error)).not.toMatch(/SENTINEL|person@example.com|user:password/);
  expect(JSON.stringify(error)).not.toMatch(/SENTINEL|person@example.com|user:password/);
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('does not accept a denied second queue page as a complete count', async () => {
  const h = harness([
    { body: fixtures.queuesFirstPage },
    { body: fixtures.forbidden, status: 403 },
  ]);
  expect(await contract.capabilities(h.api, required, identity)).toEqual({
    queues: { supported: false, remaining: 0 },
  });
});
it.each([200, 403])('checks R2 in the selected jurisdiction (%s)', async (status) => {
  const h = harness([{ body: status === 200 ? fixtures.r2Empty : fixtures.forbidden, status }]);
  expect(
    await contract.capabilities(h.api, { ...required, queues: false, r2: true }, identity),
  ).toEqual({
    r2: { supported: status === 200 },
  });
  expect(String(h.fetch.mock.calls[0]?.[0])).toContain('/r2/buckets?');
  expect(new Headers(h.fetch.mock.calls[0]?.[1]?.headers).get('cf-r2-jurisdiction')).toBe(
    identity.jurisdiction,
  );
});
it('follows all R2 cursors and refuses incomplete bucket listings', async () => {
  const h = harness([
    { body: { ...fixtures.r2Empty, result_info: { cursor: 'next' } } },
    { body: fixtures.r2Empty },
  ]);
  expect(
    await contract.capabilities(h.api, { ...required, queues: false, r2: true }, identity),
  ).toEqual({ r2: { supported: true } });
  expect(String(h.fetch.mock.calls[1]?.[0])).toContain('cursor=next');
  for (const [, init] of h.fetch.mock.calls)
    expect(new Headers(init?.headers).get('cf-r2-jurisdiction')).toBe('eu');
  const partial = harness([{ body: { ...fixtures.r2Empty, result_info: undefined } }]);
  await expect(
    contract.capabilities(partial.api, { ...required, queues: false, r2: true }, identity),
  ).rejects.toMatchObject({ code: 'capability_unknown', check: 'r2' });
});
it('recognizes required Analytics Engine on a confirmed paid Workers account', async () => {
  const h = harness([{ body: fixtures.workersPaid }]);
  expect(
    await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
  ).toEqual({ analytics: { supported: true, source: 'subscriptions' } });
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(String(h.fetch.mock.calls[0]?.[0])).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${identity.account_id}/subscriptions`,
  );
});
it.each([true, false])(
  'accepts the documented subscription array without pagination metadata (paid: %s)',
  async (paid) => {
    const h = harness([
      {
        body: {
          ...fixtures.workersPaid,
          result: paid ? fixtures.workersPaid!.result : [],
          result_info: undefined,
        },
      },
    ]);
    expect(
      await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
    ).toEqual({ analytics: { supported: paid, source: 'subscriptions' } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ['more pages', { total_pages: 2, total_count: 2 }],
  ['a continuing cursor', { cursor: 'next' }],
  ['a larger total', { total_count: 2 }],
])('uses SQL when the subscription snapshot advertises %s', async (_name, result_info) => {
  const h = harness([
    { body: { ...fixtures.workersPaid, result_info } },
    { body: fixtures.analyticsTablesEmpty },
  ]);
  expect(
    await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
  ).toEqual({ analytics: { supported: true, source: 'analytics_engine_sql' } });
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(String(h.fetch.mock.calls[1]?.[0])).toContain('/analytics_engine/sql');
});
it.each(['workers_paid', 'WORKERS_PAID'])(
  'recognizes paid plan identifier %s without inspecting provider prose',
  async (id) => {
    const h = harness([
      {
        body: {
          ...fixtures.workersPaid,
          result: [{ rate_plan: { id, scope: 'account' }, state: 'Paid' }],
        },
      },
    ]);
    expect(
      await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
    ).toEqual({ analytics: { supported: true, source: 'subscriptions' } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  [[]],
  [[{ rate_plan: { id: 'free', public_name: 'Workers Paid', scope: 'account' }, state: 'Paid' }]],
  [[{ rate_plan: { id: 'WORKERS_PAID', scope: 'account' }, state: 'Cancelled' }]],
  [[{ rate_plan: { id: 'WORKERS_PAID', scope: 'zone' }, state: 'Paid' }]],
])(
  'does not infer Analytics Engine availability from unrelated or inactive subscriptions: %j',
  async (result) => {
    const h = harness([
      { body: { ...fixtures.workersPaid, result, result_info: { total_count: result.length } } },
    ]);
    expect(
      await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
    ).toEqual({ analytics: { supported: false, source: 'subscriptions' } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([403, 200])(
  'accepts the real SQL response when subscription evidence is unavailable (%s)',
  async (status) => {
    const h = harness([
      {
        body:
          status === 403
            ? fixtures.forbidden
            : { ...fixtures.workersPaid, result_info: { total_count: 2 } },
        status,
      },
      { body: fixtures.analyticsTablesEmpty },
    ]);
    expect(
      await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
    ).toEqual({ analytics: { supported: true, source: 'analytics_engine_sql' } });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const [url, init] = h.fetch.mock.calls[1]!;
    expect(String(url)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${identity.account_id}/analytics_engine/sql`,
    );
    expect(init).toMatchObject({ method: 'POST', body: 'SHOW TABLES' });
    expect(new Headers(init?.headers).get('content-type')).toBe('text/plain');
  },
);
it.each([401, 403])('keeps SQL permission denial unknown with a safe hint (%s)', async (status) => {
  const h = harness([
    { body: fixtures.forbidden, status: 403 },
    { body: fixtures.forbidden, status },
  ]);
  const error: unknown = await contract
    .capabilities(h.api, { queues: false, r2: false, analytics: true }, identity)
    .catch((error: unknown) => error);
  expect(error).toMatchObject({
    code: 'capability_unknown',
    check: 'analytics_engine',
    source: 'analytics_engine_sql',
    message: expect.stringMatching(/Analytics Engine.*Read.*permission/),
  });
  expect(String(error)).not.toMatch(/SENTINEL|person@example.com|user:password/);
  expect(JSON.stringify(error)).not.toMatch(/SENTINEL|person@example.com|user:password/);
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
it.each([
  { status: 201, body: fixtures.analyticsTablesEmpty },
  { status: 404, body: fixtures.forbidden },
  { status: 429, body: fixtures.forbidden },
  { status: 500, body: fixtures.forbidden },
  { body: { success: true, result: [] } },
  { body: { ...fixtures.analyticsTablesEmpty, meta: [] } },
  { body: { ...fixtures.analyticsTablesEmpty, meta: [{ name: 'dataset', type: 'Int32' }] } },
  { body: { ...fixtures.analyticsTablesEmpty, data: null } },
  { body: { ...fixtures.analyticsTablesEmpty, data: [null], rows: 1 } },
  { body: { ...fixtures.analyticsTablesEmpty, data: [{ dataset: 1 }], rows: 1 } },
  { body: { ...fixtures.analyticsTablesEmpty, rows: 1 } },
  { body: { ...fixtures.analyticsTablesEmpty, rows: '0' } },
])('keeps other SQL answers unknown: %j', async (response) => {
  const h = harness([{ body: fixtures.forbidden, status: 403 }, response]);
  await expect(
    contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
  ).rejects.toMatchObject({
    code: 'capability_unknown',
    check: 'analytics_engine',
    source: 'analytics_engine_sql',
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
it('accepts an existing dataset in the SQL table listing', async () => {
  const h = harness([
    { body: fixtures.forbidden, status: 403 },
    { body: { ...fixtures.analyticsTablesEmpty, data: [{ dataset: 'broker_metrics' }], rows: 1 } },
  ]);
  expect(
    await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
  ).toEqual({ analytics: { supported: true, source: 'analytics_engine_sql' } });
});
it('does not probe services or Analytics Engine when no binding is required', async () => {
  const h = harness([]);
  expect(
    await contract.capabilities(h.api, { queues: false, r2: false, analytics: false }, identity),
  ).toEqual({});
  expect(h.fetch).not.toHaveBeenCalled();
});
it.each<ResourceKind>(['d1', 'r2', 'queue', 'worker', 'analytics'])(
  'reports documented name uniqueness for %s',
  (kind) => {
    expect(contract.exactNameUnique(kind)).toBe(kind !== 'analytics');
  },
);
it.each<ResourceKind>(['d1', 'r2', 'queue', 'worker', 'analytics'])(
  'never invents a pending-creation window for %s',
  (kind) => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    const resource: RemoteResource = {
      kind,
      id: 'resource',
      name: 'broker',
      jurisdiction: null,
      created_at: new Date(now).toISOString(),
    };
    const operation: Operation = {
      id: 'intent',
      kind,
      name: 'broker',
      spec_sha256: 'a'.repeat(64),
      absence_observed_at: new Date(now - 1000).toISOString(),
      started_at: new Date(now - 1000).toISOString(),
      state: 'pending',
      resolved_id: null,
    };
    expect(contract.pendingCreation(resource, operation, now)).toBe(false);
    expect(contract.pendingCreation(resource, operation, now + 60_000)).toBe(false);
  },
);
