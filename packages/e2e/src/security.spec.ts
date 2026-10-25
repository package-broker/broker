import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocal, until } from './local.js';
import type { Runtime } from './local.js';
import { session } from './evidence.js';
import { buildCorpus } from './fixtures/corpus.js';
import { createFixtureApp } from './fixtures/service.js';
import {
  assertNoSecrets,
  canary,
  HeaderRecorder,
  nodeSecurityTransport,
  pemBodyLines,
  selfHost,
  securityDestination,
  startSecurityFixture,
  startSentinel,
} from './sentinels.js';

const webhookSecret = 'security-fixture-webhook-secret';
const installationToken = 'ghs_securityFixtureInstallationToken';
const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const hash = (body: Uint8Array, algorithm = 'sha1') =>
  createHash(algorithm).update(body).digest('hex');
const corpus = buildCorpus();
const archive = (name: string) => {
  const bytes = corpus.get(name);
  assert(bytes, 'MissingHostileCorpusMember');
  return bytes;
};

const analyticsReason =
  "Miniflare's Analytics Engine binding discards writeDataPoint, so the Worker counter has no local observation point; the status and storage oracles still run on Workers and the counter runs on Node.";

export const runtimeExclusions = [
  {
    runtime: 'cloudflare',
    cases: [
      'dns-loopback',
      'dns-metadata',
      'dns-ipv6',
      'dns-mixed',
      'dns-rebind',
      'http-dns-loopback',
    ],
    reason:
      'Workers fetch exposes no application resolver or socket lookup hook. Local Miniflare outboundService cannot certify provider DNS filtering or rebinding; these cases run on Node.',
  },
  {
    runtime: 'cloudflare',
    cases: ['pb.upstream.requests{kind=archive,outcome=refused} counter increment'],
    reason: analyticsReason,
  },
  {
    runtime: 'cloudflare',
    cases: ['pb.upstream.requests{kind=archive,outcome=body_too_large} counter increment'],
    reason: analyticsReason,
  },
] as const;

export function excluded(runtime: Runtime, id: string): string | undefined {
  return runtimeExclusions.find(
    (entry) => entry.runtime === runtime && (entry.cases as readonly string[]).includes(id),
  )?.reason;
}

export const blobCapBytes = 67_108_864;
export const settleMs = 200;
const upstreamCounter = (output: string, outcome: string): number =>
  output
    .split('\n')
    .filter((line) => line.startsWith('{') && line.includes('"pb.upstream.requests"'))
    .reduce((sum, line) => {
      const record = JSON.parse(line) as {
        kind?: string;
        name?: string;
        labels?: { kind?: string; outcome?: string };
        value?: number;
      };
      return record.kind === 'counter' &&
        record.name === 'pb.upstream.requests' &&
        record.labels?.kind === 'archive' &&
        record.labels?.outcome === outcome
        ? sum + (record.value ?? 0)
        : sum;
    }, 0);

export const ssrfCases = [
  ['literal-loopback', 'https://127.0.0.1/'],
  ['literal-metadata', 'https://169.254.169.254/'],
  ['literal-ipv6', 'https://[::1]/'],
  ['self-origin', 'self'],
  ['dns-loopback', 'https://loopback.security.test/'],
  ['dns-metadata', 'https://metadata.security.test/'],
  ['dns-ipv6', 'https://ipv6.security.test/'],
  ['dns-mixed', 'https://mixed.security.test/'],
  ['dns-rebind', 'https://rebind.security.test/'],
  ['http-literal-loopback', 'http://127.0.0.1/'],
  ['http-dns-loopback', 'http://loopback.security.test/'],
] as const;
export const hostileCases = [
  'zip-bomb.zip',
  'tar-traversal.tgz',
  'symlink-escape.tgz',
  'oversized-manifest.json',
  'oversized-manifest.zip',
  'digest-mismatch.zip',
  'oversized-archive.zip',
  'delta.pack',
  'delta-upload-pack.bin',
] as const;

const servedAsIs = new Set<string>([
  'zip-bomb.zip',
  'tar-traversal.tgz',
  'symlink-escape.tgz',
  'oversized-manifest.zip',
]);
let oversizedArchive: Buffer | undefined;
const hostileBytes = (member: string): Uint8Array =>
  member === 'oversized-archive.zip'
    ? (oversizedArchive ??= Buffer.alloc(blobCapBytes + 1, 0x50))
    : archive(member);

const hostileRepository = (member: string) => 'security/' + member.replace(/\W/g, '-');

interface Plan {
  name: string;
  body: Uint8Array;
  target: string;
  redirect?: string;
  metadataRedirect?: string;
  oversized?: boolean;
  digest?: string;
}

export async function startSecurityScenario(
  runtime: Runtime,
  mutation?: (bundle: string) => string,
) {
  const cleanups: (() => Promise<unknown>)[] = [];
  const close = async () => {
    let failed = false;
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        failed = true;
      }
    }
    assert(!failed, 'SecurityCleanupFailed');
  };
  try {
    const sentinel = await startSentinel();
    cleanups.push(sentinel.close);
    const ipv6 = await startSentinel('::1');
    cleanups.push(ipv6.close);
    await sentinel.positiveControl();
    await ipv6.positiveControl();
    const canaries = new Map([
      ['https://registry.npmjs.org', canary()],
      ['https://npm.pkg.github.com', canary()],
    ]);
    const recorder = new HeaderRecorder(canaries, [
      installationToken,
      webhookSecret,
      ...pemBodyLines(privateKey),
    ]);
    const plans = new Map<string, Plan>();
    const gitFixture = createFixtureApp('https://github.com');
    const githubPackages = new Map<string, string>();
    let gitHostile = 'delta-upload-pack.bin';
    let gitHostileRequests = 0;
    const fixture = await startSecurityFixture(recorder, async (request) => {
      const url = new URL(request.url);
      if (url.hostname === 'rebind.security.test')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://rebind.security.test/second' },
        });
      if (url.hostname === 'api.github.com') {
        const repository = /^\/repos\/(security\/[\w-]+)(\/contents\/composer\.json)?$/.exec(
          url.pathname,
        );
        if (request.method === 'POST' && url.pathname === '/app/installations/123/access_tokens') {
          const grant = (await request.json()) as { permissions: unknown; repositories: string[] };
          return Response.json(
            {
              token: installationToken,
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              permissions: grant.permissions,
              repositories: grant.repositories.map((name) => ({ name })),
            },
            { status: 201 },
          );
        }
        const packageName = repository ? githubPackages.get(repository[1]!) : undefined;
        if (!repository || !packageName) return new Response(null, { status: 404 });
        return Response.json(
          repository[2]
            ? { name: packageName }
            : { archived: false, default_branch: 'main', full_name: repository[1] },
        );
      }
      if (url.hostname === 'github.com') {
        const body = request.method === 'POST' ? await request.clone().text() : '';
        if (body.includes('command=fetch')) {
          gitHostileRequests++;
          return new Response(new Uint8Array(archive(gitHostile)), {
            headers: { 'content-type': 'application/x-git-upload-pack-result' },
          });
        }
        return gitFixture.app.fetch(
          new Request(
            'https://github.com' +
              url.pathname.replace(/^\/security\/[\w-]+\.git/, '/git/lib.git') +
              url.search,
            request,
          ),
        );
      }
      if (url.pathname.startsWith('/archive/')) {
        const plan = plans.get(url.pathname.slice('/archive/'.length));
        assert(plan, 'UnplannedSecurityArchive');
        if (plan.redirect)
          return new Response(null, { status: 302, headers: { location: plan.redirect } });
        return new Response(new Uint8Array(plan.body));
      }
      const npm = url.hostname !== 'repo.packagist.org';
      const name = npm
        ? decodeURIComponent(url.pathname.slice(1))
        : url.pathname.slice('/p2/'.length).replace(/(?:~dev)?\.json$/, '');
      const plan = plans.get(name);
      if (!plan || url.pathname.endsWith('~dev.json'))
        return Response.json(npm ? {} : { packages: { [name]: [] } }, { status: plan ? 200 : 404 });
      if (plan.metadataRedirect)
        return new Response(null, { status: 302, headers: { location: plan.metadataRedirect } });
      if (plan.oversized) return new Response(new Uint8Array(plan.body));
      const dist = npm
        ? { tarball: plan.target, shasum: plan.digest ?? hash(plan.body) }
        : { type: 'zip', url: plan.target, shasum: plan.digest ?? hash(plan.body) };
      const member = {
        name,
        version: '1.0.0',
        version_normalized: '1.0.0.0',
        time: '2026-01-01T00:00:00.000Z',
        dist,
      };
      return Response.json(
        npm
          ? { name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': member } }
          : { packages: { [name]: [member] } },
      );
    });
    cleanups.push(fixture.close);
    const broker = await startLocal(runtime, fixture.origin, {
      nodeTransport: nodeSecurityTransport(fixture.origin, sentinel.origin, ipv6.origin),
      outboundDestination: (url, origin) =>
        securityDestination(url, fixture.origin, sentinel.origin, ipv6.origin, origin),
      ...(mutation ? { patchBundle: mutation } : {}),
      ...(runtime === 'node' ? { publicUrl: `https://${selfHost}` } : {}),
    });
    cleanups.push(broker.close);
    const admin = await session(broker);
    const api = async (
      path: string,
      body?: unknown,
      expected = 204,
      method = 'POST',
    ): Promise<Response> => {
      const response = await admin.request(path, body, method);
      assert(response.status === expected, 'SecuritySetupHTTPFailure');
      return response;
    };
    const organization = await api('/_pb/organization', undefined, 200, 'GET');
    const { id: orgId } = (await organization.json()) as { id: string };
    const project = await api('/_pb/projects', { slug: 'security', name: 'Security' }, 201);
    const { id: projectId } = (await project.json()) as { id: string };
    const source = async (
      name: string,
      ecosystem: string,
      type: string,
      url: string | null,
      config: Record<string, unknown>,
      credential?: { kind: string; material: Record<string, unknown> },
    ) => {
      const response = await api('/_pb/sources', { name, ecosystem, type, url, config }, 201);
      const { id } = (await response.json()) as { id: string };
      await api(
        `/_pb/projects/security/sources/${id}/attachment`,
        { precedence: type === 'vcs' ? 0 : 100 },
        204,
        'PUT',
      );
      if (credential)
        await api(
          `/_pb/sources/${id}/credential`,
          { kind: credential.kind, material: JSON.stringify(credential.material) },
          204,
          'PUT',
        );
      if (type === 'vcs')
        await api(`/_pb/sources/${id}/names`, { pattern: config['packageName'] }, 201);
      if (type === 'npm_registry')
        for (const scope of config['scopes'] as string[])
          await api(`/_pb/sources/${id}/names`, { pattern: scope + '/*' }, 201);
      await api(`/_pb/sources/${id}/${type.endsWith('_proxy') ? 'resume' : 'enable'}`);
      return id;
    };
    const githubSource = async (repository: string, packageName: string) => {
      githubPackages.set(repository, packageName);
      const id = await source(
        repository.replace('/', '-'),
        'composer',
        'vcs',
        null,
        {
          provider: 'github',
          repository,
          installationId: 123,
          packageName,
          refs: { tags: true, branches: [] },
        },
        { kind: 'github_app', material: { appId: '42', privateKeyPem: privateKey, webhookSecret } },
      );
      const [credential] = await broker.read<{ credential_id: string }>(
        // eslint-disable-next-line no-restricted-syntax -- Observe the credential id that addresses the signed webhook.
        'SELECT credential_id FROM source WHERE org_id = ? AND id = ?',
        [orgId, id],
      );
      assert(credential, 'SecuritySourceCredentialMissing');
      const body = JSON.stringify({
        ref: 'refs/tags/1.0.0',
        installation: { id: 123 },
        repository: { full_name: repository },
      });
      const response = await fetch(
        `${broker.origin}/_pb/hooks/github/${credential.credential_id}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'push',
            'x-github-delivery': randomBytes(16).toString('hex'),
            'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        },
      );
      assert(response.status === 202, 'SecurityWebhookRejected');
      return id;
    };
    await source('packagist', 'composer', 'packagist_proxy', 'https://repo.packagist.org', {
      githubToken: false,
    });
    for (const [origin, secret] of canaries) {
      const scope = origin.includes('npmjs') ? '@first' : '@second';
      await source(
        scope.slice(1),
        'npm',
        'npm_registry',
        origin,
        { scopes: [scope], distHosts: ['pkg-npm.githubusercontent.com'] },
        { kind: 'npm_token', material: { token: secret } },
      );
    }
    const issued = await api(
      '/_pb/me/tokens',
      {
        name: 'security-reader',
        scope: 'read',
        readOnly: true,
        projectMode: 'selected',
        projectIds: [projectId],
      },
      201,
    );
    const { token } = (await issued.json()) as { token: string };
    const captured: string[] = [];
    const get = async (path: string): Promise<Response> => {
      const response = await fetch(broker.origin + path, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      captured.push(JSON.stringify([...response.headers]), new TextDecoder().decode(bytes));
      return new Response(bytes, { status: response.status, headers: response.headers });
    };
    const read = <T extends Record<string, unknown>>(
      sql: string,
      params: (string | number)[] = [],
    ) => broker.read<T>(sql, [orgId, ...params]);
    const exercise = async (plan: Plan) => {
      plans.set(plan.name, plan);
      const metadata = await get(
        plan.name.startsWith('@')
          ? '/security/npm/' + plan.name.replace('/', '%2f')
          : `/security/p2/${plan.name}.json`,
      );
      if (metadata.status !== 200) return metadata;
      const body = (await metadata.json()) as {
        packages?: Record<string, { dist: { url: string } }[]>;
        versions?: Record<string, { dist: { tarball: string } }>;
      };
      const dist =
        body.packages?.[plan.name]?.[0]?.dist.url ?? body.versions?.['1.0.0']?.dist.tarball;
      if (!dist) return metadata;
      const url = new URL(dist);
      assert(url.origin === broker.publicOrigin, 'DirectUpstreamBypass');
      return get(url.pathname);
    };
    const upstreamOutcomes = (outcome: string): number | undefined =>
      runtime === 'node' ? upstreamCounter(broker.logs(), outcome) : undefined;
    const evidence = async () => {
      await broker.moduleEvidence();
      fixture.assertHealthy();
      recorder.assertContained([]);
      assertNoSecrets([broker.logs(), ...captured].join('\n'), [
        token,
        broker.setupToken,
        ...canaries.values(),
        privateKey,
        webhookSecret,
        installationToken,
        ...admin.secrets(),
        ...broker.secrets(),
      ]);
    };
    const catalogue = (name: string) =>
      read<{ id: string }>(
        // eslint-disable-next-line no-restricted-syntax -- Observe organization-scoped published catalogue effects.
        "SELECT v.id FROM version v JOIN package p ON p.id = v.package_id AND p.org_id = v.org_id WHERE v.org_id = ? AND p.name = ? AND v.status = 'active'",
        [name],
      );
    return {
      broker,
      fixture,
      sentinel,
      ipv6,
      plans,
      recorder,
      canaries,
      exercise,
      read,
      catalogue,
      upstreamOutcomes,
      get,
      githubSource,
      evidence,
      close,
      git: {
        setHostile: (name: string) => {
          gitHostile = name;
        },
        requests: () => gitHostileRequests,
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type SecurityScenario = Awaited<ReturnType<typeof startSecurityScenario>>;

export async function assertSsrf(
  scenario: SecurityScenario,
  id: string,
  target: string,
  redirect = false,
): Promise<void> {
  const { broker, fixture, sentinel, ipv6 } = scenario;
  fixture.resetDns();
  const before = [sentinel.connections(), ipv6.connections()];
  const refusedBefore = scenario.upstreamOutcomes('refused');
  const name = 'fx/' + id + (redirect ? '-redirect' : '-direct');
  const destination = target === 'self' ? broker.publicOrigin : target;
  const firstHop = id.includes('dns-')
    ? 'https://repo.packagist.org'
    : 'https://codeload.github.com';
  const url = `${firstHop}/archive/${name}`;
  const plan: Plan = {
    name,
    body: archive('lib.zip'),
    target: redirect ? url : destination,
    ...(redirect ? { redirect: destination } : {}),
  };
  const response = await scenario.exercise(plan);
  await delay(settleMs);
  assert(
    sentinel.connections() === before[0] && ipv6.connections() === before[1],
    'SentinelConnectionObserved',
  );
  assert(fixture.count(`https://repo.packagist.org/p2/${name}.json`) > 0, 'SSRFTriggerMissing');
  assert(response.status !== 200, 'SSRFRequestSucceeded');
  assert(response.status === 502, 'SSRFRefusalStatus');
  const problem = (await response.json()) as { code?: string; error?: { code?: string } };
  assert((problem.code ?? problem.error?.code) === 'upstream_refused', 'SSRFRefusalCode');
  if (id.startsWith('dns-')) {
    const host = new URL(destination).hostname;
    assert(fixture.dnsCount(host) >= (id === 'dns-rebind' ? 2 : 1), 'ControlledDNSNotExercised');
  }
  if (refusedBefore !== undefined)
    await until(
      async () => scenario.upstreamOutcomes('refused')! > refusedBefore,
      'refused-upstream-counter',
      5_000,
    );
  await scenario.evidence();
}

export async function assertHostile(
  scenario: SecurityScenario,
  member: (typeof hostileCases)[number],
) {
  const name = member.endsWith('.tgz')
    ? '@first/' + member.replace(/\W/g, '-')
    : 'fx/' + member.replace(/\W/g, '-');
  const bytes = hostileBytes(member);
  const beforeFiles = await scenario.broker.filesystemEntries();
  const beforeKeys = await scenario.broker.storageKeys();
  const overCapBefore = scenario.upstreamOutcomes('body_too_large');
  let sourceId: string | undefined;
  let response: Response | undefined;
  if (member.startsWith('delta')) {
    scenario.git.setHostile(member);
    const before = scenario.git.requests();
    sourceId = await scenario.githubSource(hostileRepository(member), name);
    await until(async () => scenario.git.requests() > before, 'hostile-git-bytes-consumed');
  } else {
    const target = `https://${name.startsWith('@') ? 'registry.npmjs.org' : 'codeload.github.com'}/archive/${name}`;
    response = await scenario.exercise({
      name,
      body: bytes,
      target,
      ...(member === 'oversized-manifest.json' ? { oversized: true } : {}),
      ...(member === 'digest-mismatch.zip' ? { digest: hash(archive('lib.zip')) } : {}),
    });
    assert(
      scenario.fixture.count(
        `https://${name.startsWith('@') ? 'registry.npmjs.org/' : 'repo.packagist.org/p2/'}${name.startsWith('@') ? name.replace('/', '%2f') : name + '.json'}`,
      ) > 0,
      'HostileTriggerMissing',
    );
    if (member !== 'oversized-manifest.json')
      assert(scenario.fixture.count(target) > 0, 'HostileBytesNotConsumed');
  }
  if (sourceId)
    await until(
      async () =>
        (
          await scenario.read<{ id: string }>(
            // eslint-disable-next-line no-restricted-syntax -- A completed hostile request must not leave work running for its source.
            "SELECT id FROM job WHERE org_id = ? AND resource_key = ? AND state IN ('queued', 'running')",
            [`source:${sourceId}`],
          )
        ).length === 0,
      'hostile-job-bounded',
    );
  const files = await scenario.broker.filesystemEntries();
  assert(files.join('\n') === beforeFiles.join('\n'), 'EscapedFilesystemWrite');
  const added = (await scenario.broker.storageKeys()).filter((key) => !beforeKeys.includes(key));
  const blobs = await scenario.read<{ storage_key: string; size_bytes: number }>(
    // eslint-disable-next-line no-restricted-syntax -- Observe the published blob that holds the hostile bytes.
    'SELECT storage_key, size_bytes FROM blob WHERE org_id = ? AND sha256 = ? AND published_at IS NOT NULL',
    [hash(bytes, 'sha256')],
  );
  if (servedAsIs.has(member)) {
    assert(response?.status === 200, 'HostileArchiveNotServed');
    const served = Buffer.from(await response.arrayBuffer());
    assert(served.equals(Buffer.from(bytes)), 'HostileArchiveAltered');
    assert(
      blobs.length === 1 && Number(blobs[0]!.size_bytes) === bytes.length,
      'ArchiveBlobMissing',
    );
    const key = blobs[0]!.storage_key;
    assert(
      added.every((path) => path === key || path === `${key}.media`),
      'HostileArchiveExtracted',
    );
  } else {
    if (response) assert(response.status !== 200, 'HostileRequestSucceeded');
    assert(blobs.length === 0, 'HostileBlobPublished');
    assert(added.length === 0, 'HostileStorageWrite');
    if (member === 'oversized-archive.zip' && overCapBefore !== undefined)
      assert(scenario.upstreamOutcomes('body_too_large')! > overCapBefore, 'SizeCapNotObserved');
    assert((await scenario.catalogue(name)).length === 0, 'HostileCatalogueRowPublished');
    if (member === 'oversized-archive.zip' || member === 'digest-mismatch.zip') {
      assert(response?.status === 502, 'RefusedArchiveStatus');
      const states = await scenario.read<{ status: string; blob_id: string | null }>(
        // eslint-disable-next-line no-restricted-syntax -- Observe the scoped quarantine effect of a refused archive.
        'SELECT v.status, v.blob_id FROM version v JOIN package p ON p.id = v.package_id AND p.org_id = v.org_id WHERE v.org_id = ? AND p.name = ?',
        [name],
      );
      assert(
        states.length === 1 && states[0]!.status === 'quarantined' && states[0]!.blob_id === null,
        'RefusedArchiveNotQuarantined',
      );
    }
  }
  await scenario.evidence();
}

export async function assertCredentialContainment(scenario: SecurityScenario) {
  for (const [origin] of scenario.canaries) {
    const scope = origin.includes('npmjs') ? '@first' : '@second';
    const name = scope + '/credential';
    const target = `${origin}/archive/${name}`;
    scenario.plans.set(name + '-recipient', {
      name: name + '-recipient',
      body: archive('lib.tgz'),
      target,
    });
    const plan: Plan = {
      name,
      body: archive('lib.tgz'),
      target,
      redirect: `https://pkg-npm.githubusercontent.com/archive/${name}-recipient`,
    };
    assert((await scenario.exercise(plan)).status === 200, 'CredentialRedirectLegFailed');
    const unlisted = `${name}-unlisted`;
    scenario.plans.set(unlisted + '-recipient', {
      name: unlisted + '-recipient',
      body: archive('lib.tgz'),
      target,
    });
    const status = (
      await scenario.exercise({
        name: unlisted,
        body: archive('lib.tgz'),
        target: `${origin}/archive/${unlisted}`,
        redirect: `https://codeload.github.com/archive/${unlisted}-recipient`,
      })
    ).status;
    assert(status === 502, 'UnlistedRedirectNotRefused');
    assert(
      scenario.fixture.count(`https://codeload.github.com/archive/${unlisted}-recipient`) === 0,
      'UnlistedRecipientContacted',
    );
  }
  scenario.recorder.assertContained([
    ...scenario.canaries.keys(),
    'https://pkg-npm.githubusercontent.com',
  ]);
  await scenario.evidence();
}
