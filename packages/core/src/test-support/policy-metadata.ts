import {
  POLICY_COMPOSER_PACKAGE,
  POLICY_NPM_PACKAGE,
  json,
  npmBlock,
  policyWrite,
  readDenials,
  sortedKeys,
  type PolicyBroker,
} from './policy-broker.js';

/**
 * Warm caches and validators, then real rule writes through the management API, then the same
 * requests again. Every observation is a status, a version set or a header fact, so both runtimes
 * must produce exactly `POLICY_METADATA_EXPECTED`.
 */
export async function policyMetadataMatrix(broker: PolicyBroker) {
  const npm = `/${broker.project}/npm`;
  const packument = (headers: Record<string, string> = {}) =>
    broker.fetch(`${npm}/${POLICY_NPM_PACKAGE}`, { headers });
  const view = async (headers: Record<string, string> = {}) => {
    const response = await packument(headers);
    if (response.status !== 200) return { status: response.status };
    const body = await json(response);
    return {
      status: 200,
      versions: sortedKeys(body['versions']),
      time: sortedKeys(body['time']).filter((key) => key !== 'created' && key !== 'modified'),
      tags: body['dist-tags'],
      publisherText: ((body['versions'] ?? {}) as Record<string, Record<string, unknown>>)[
        '1.0.0'
      ]?.['deprecated'],
      cacheControl: response.headers.get('cache-control'),
      etag: response.headers.get('etag'),
    };
  };
  const strip = (value: Awaited<ReturnType<typeof view>>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'etag'));

  const warm = await view();
  const warmTag = warm.etag ?? '';
  const revalidated = (await packument({ 'if-none-match': warmTag })).status;
  const warmTags = await json(
    await broker.fetch(`${npm}/-/package/${POLICY_NPM_PACKAGE}/dist-tags`),
  );
  const composerPath = `/${broker.project}/p2/${POLICY_COMPOSER_PACKAGE}.json`;
  const composerVersions = async () => {
    const response = await broker.fetch(composerPath);
    if (response.status !== 200) return response.status;
    const body = (await response.json()) as { packages: Record<string, { version: string }[]> };
    return (body.packages[POLICY_COMPOSER_PACKAGE] ?? []).map((entry) => entry.version);
  };
  const composerWarm = await composerVersions();

  const block = await policyWrite(broker, '/_pb/policies', 'POST', npmBlock(['2.0.0']));
  const blocked = await view();
  const blockedTag = blocked.etag ?? '';
  const oldValidator = (await packument({ 'if-none-match': warmTag })).status;
  const sameValidator = (await packument({ 'if-none-match': blockedTag })).status;
  const denied = async (path: string) => {
    const response = await broker.fetch(path);
    return { status: response.status, cacheControl: response.headers.get('cache-control') };
  };
  const direct = {
    deniedVersion: await denied(`${npm}/${POLICY_NPM_PACKAGE}/2.0.0`),
    deniedTag: await denied(`${npm}/${POLICY_NPM_PACKAGE}/latest`),
    allowedVersion: (await broker.fetch(`${npm}/${POLICY_NPM_PACKAGE}/1.0.0`)).status,
    tags: await json(await broker.fetch(`${npm}/-/package/${POLICY_NPM_PACKAGE}/dist-tags`)),
  };
  const evidence = await readDenials(broker);
  const packageId = (await broker.packageId(POLICY_NPM_PACKAGE)) ?? '';
  const projectView = (
    (
      (await json(
        await broker.fetch(`/_pb/projects/${broker.project}/packages/${packageId}/versions`),
      )) as { items?: { version: string }[] }
    ).items ?? []
  )
    .map((item) => item.version)
    .sort();

  await broker.breakReadAudit();
  const outage = {
    collection: strip(await view()),
    direct: await (async () => {
      const response = await broker.fetch(`${npm}/${POLICY_NPM_PACKAGE}/2.0.0`);
      return {
        status: response.status,
        code: ((await json(response)) as { code?: unknown }).code,
        retryAfter: response.headers.get('retry-after'),
        cacheControl: response.headers.get('cache-control'),
      };
    })(),
  };
  await broker.restoreReadAudit();

  const age = await policyWrite(broker, '/_pb/policies', 'POST', {
    ecosystem: 'npm',
    kind: 'min_age',
    minAgeDays: 1,
    reasonCode: 'organization_policy',
  });
  const aged = await view();
  await broker.expireRule(String(age.body['id']));
  const expired = await view();
  const expiredValidator = (await packument({ 'if-none-match': aged.etag ?? '' })).status;

  const floor = await policyWrite(broker, '/_pb/policies', 'POST', {
    ecosystem: 'npm',
    kind: 'client_floor',
    clientFamily: 'npm',
    clientMinVersion: '10.0.0',
    reasonCode: 'compatibility',
  });
  const floorId = String(floor.body['id']);
  const client = async (agent: string | null) =>
    (await packument(agent === null ? {} : { 'user-agent': agent })).status;
  const clients = {
    old: await client('npm/9.1.0 node/v20.0.0 darwin arm64'),
    current: await client('npm/10.2.0 node/v20.0.0 darwin arm64'),
    unknown: await client(null),
    composerToolOnNpm: await client('Composer/2.7.1 (Darwin; 23.0; PHP 8.3.0)'),
  };
  const strict = await policyWrite(
    broker,
    `/_pb/policies/${floorId}`,
    'PATCH',
    { denyUnknown: true },
    { revision: 1 },
  );
  const strictUnknown = await client(null);
  const strictBody = await json(await packument());
  await broker.dropReauth();
  const staleDisable = await policyWrite(
    broker,
    `/_pb/policies/${floorId}`,
    'PATCH',
    { state: 'disabled', reason: 'emergency_compatibility' },
    { revision: 2 },
  );
  await broker.reauth();
  const disable = await policyWrite(
    broker,
    `/_pb/policies/${floorId}`,
    'PATCH',
    { state: 'disabled', reason: 'emergency_compatibility' },
    { revision: 2 },
  );
  const afterDisable = await client(null);

  const composerBlock = await policyWrite(broker, '/_pb/policies', 'POST', {
    ecosystem: 'composer',
    package: POLICY_COMPOSER_PACKAGE,
    kind: 'block',
    members: ['2.0.0.0'],
    reasonCode: 'security_review',
  });
  const composerBlocked = await composerVersions();

  return {
    warm: strip(warm),
    revalidated,
    warmTags,
    composerWarm,
    block: block.status,
    blocked: strip(blocked),
    validatorChanged: warmTag !== blockedTag,
    oldValidator,
    sameValidator,
    direct,
    evidence,
    projectView,
    outage,
    age: age.status,
    aged: strip(aged),
    expired: strip(expired),
    expiredValidator,
    floor: floor.status,
    clients,
    strict: strict.status,
    strictUnknown,
    strictBody: { code: strictBody['code'], error: strictBody['error'] },
    staleDisable: {
      status: staleDisable.status,
      code: (staleDisable.body['error'] as { code?: unknown } | undefined)?.code,
    },
    disable: { status: disable.status, state: disable.body['state'] },
    afterDisable,
    composerBlock: composerBlock.status,
    composerBlocked,
  };
}

const GOVERNED = 'private, no-cache';
/** A direct denial answers like a missing version and is never stored, as dist denials are. */
const DENIED = 'private, no-store';

export const POLICY_METADATA_EXPECTED = {
  warm: {
    status: 200,
    versions: ['1.0.0', '2.0.0', '3.0.0'],
    time: ['1.0.0', '2.0.0', '3.0.0'],
    tags: { latest: '2.0.0', next: '3.0.0' },
    publisherText: 'Use 3.x, publisher wording kept',
    cacheControl: GOVERNED,
  },
  revalidated: 304,
  warmTags: { latest: '2.0.0', next: '3.0.0' },
  composerWarm: ['1.0.0', '2.0.0'],
  block: 201,
  blocked: {
    status: 200,
    versions: ['1.0.0', '3.0.0'],
    time: ['1.0.0', '3.0.0'],
    tags: { next: '3.0.0' },
    publisherText: 'Use 3.x, publisher wording kept',
    cacheControl: GOVERNED,
  },
  validatorChanged: true,
  oldValidator: 200,
  sameValidator: 304,
  direct: {
    deniedVersion: { status: 404, cacheControl: DENIED },
    deniedTag: { status: 404, cacheControl: DENIED },
    allowedVersion: 200,
    tags: { next: '3.0.0' },
  },
  evidence: ['tag', 'version'],
  projectView: ['1.0.0', '3.0.0'],
  outage: {
    collection: {
      status: 200,
      versions: ['1.0.0', '3.0.0'],
      time: ['1.0.0', '3.0.0'],
      tags: { next: '3.0.0' },
      publisherText: 'Use 3.x, publisher wording kept',
      cacheControl: GOVERNED,
    },
    direct: {
      status: 503,
      code: 'policy_unavailable',
      retryAfter: '5',
      cacheControl: 'private, no-store',
    },
  },
  age: 201,
  aged: {
    status: 200,
    versions: ['1.0.0'],
    time: ['1.0.0'],
    tags: {},
    publisherText: 'Use 3.x, publisher wording kept',
    cacheControl: GOVERNED,
  },
  expired: {
    status: 200,
    versions: ['1.0.0', '3.0.0'],
    time: ['1.0.0', '3.0.0'],
    tags: { next: '3.0.0' },
    publisherText: 'Use 3.x, publisher wording kept',
    cacheControl: GOVERNED,
  },
  expiredValidator: 200,
  floor: 201,
  clients: { old: 403, current: 200, unknown: 200, composerToolOnNpm: 200 },
  strict: 200,
  strictUnknown: 403,
  strictBody: { code: 'policy_denied', error: 'Package access denied by policy' },
  staleDisable: { status: 403, code: 'reauth_required' },
  disable: { status: 200, state: 'disabled' },
  afterDisable: 200,
  composerBlock: 201,
  composerBlocked: ['1.0.0'],
} as const;
