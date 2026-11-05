import {
  POLICY_LATE_PACKAGE,
  POLICY_NPM_PACKAGE,
  json,
  npmBlock,
  policyWrite,
  type PolicyBroker,
} from './policy-broker.js';

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
  );
}

/** Planted values that must never reach a response, a log line or an audit payload. */
export const POLICY_CANARIES = [
  'pbt_canary0secret0token0value0000000000',
  'canary-cookie-value-9f3a',
  'canary.person@example.invalid',
  'https://canary:password@registry.invalid/x.tgz',
] as const;

/** Overrides, races, holds and diagnostics through the real management API and database. */
export async function policyAdminMatrix(broker: PolicyBroker) {
  const npm = `/${broker.project}/npm`;
  const status = async (path: string) => (await broker.fetch(path)).status;

  await broker.dropReauth();
  const key = 'admin-create-1';
  const created = await policyWrite(broker, '/_pb/policies', 'POST', npmBlock(['2.0.0']), { key });
  const replay = await policyWrite(broker, '/_pb/policies', 'POST', npmBlock(['2.0.0']), { key });
  const id = String(created.body['id']);
  const rule = `/_pb/policies/${id}`;
  const tighten = await policyWrite(
    broker,
    rule,
    'PATCH',
    { members: ['1.0.0', '2.0.0'] },
    { revision: 1 },
  );
  const staleWeaken = await policyWrite(
    broker,
    rule,
    'PATCH',
    { members: ['2.0.0'], overrideReason: 'false_positive' },
    { revision: 2 },
  );
  await broker.reauth();
  const noReason = await policyWrite(
    broker,
    rule,
    'PATCH',
    { members: ['2.0.0'] },
    { revision: 2 },
  );
  const weaken = await policyWrite(
    broker,
    rule,
    'PATCH',
    { members: ['2.0.0'], overrideReason: 'false_positive' },
    { revision: 2 },
  );
  const raceA = await policyWrite(
    broker,
    rule,
    'PATCH',
    { reasonCode: 'malware' },
    { revision: 3 },
  );
  const raceB = await policyWrite(
    broker,
    rule,
    'PATCH',
    { reasonCode: 'compatibility' },
    { revision: 3 },
  );
  const afterOverride = {
    one: await status(`${npm}/${POLICY_NPM_PACKAGE}/1.0.0`),
    two: await status(`${npm}/${POLICY_NPM_PACKAGE}/2.0.0`),
  };

  const late = await policyWrite(
    broker,
    '/_pb/policies',
    'POST',
    npmBlock([], POLICY_LATE_PACKAGE),
  );
  const lateRead = await status(`${npm}/${POLICY_LATE_PACKAGE}`);
  const lateIngested = (await broker.versionStatus(POLICY_LATE_PACKAGE, '1.0.0')) !== null;

  const quarantine = await policyWrite(broker, '/_pb/policies', 'POST', {
    ecosystem: 'npm',
    package: POLICY_NPM_PACKAGE,
    kind: 'quarantine',
    members: ['3.0.0'],
    reasonCode: 'malware',
  });
  await broker.setVersionStatus(POLICY_NPM_PACKAGE, '3.0.0', 'quarantined');
  const release = await policyWrite(
    broker,
    `/_pb/policies/${String(quarantine.body['id'])}`,
    'PATCH',
    { state: 'disabled', reason: 'false_positive' },
    { revision: 1 },
  );
  const afterRelease = {
    status: await status(`${npm}/${POLICY_NPM_PACKAGE}/3.0.0`),
    version: await broker.versionStatus(POLICY_NPM_PACKAGE, '3.0.0'),
    otherRule: await status(`${npm}/${POLICY_NPM_PACKAGE}/2.0.0`),
  };

  const packageId = await broker.packageId(POLICY_NPM_PACKAGE);
  const inspection = await broker.fetch(`/_pb/policies/packages/${packageId ?? ''}`);
  const inspected = (await json(inspection)) as {
    versions?: { version: string; permitted: boolean; reasons: { reason: string }[] }[];
  };

  const canaries = [
    await broker.fetch('/_pb/policies', {
      method: 'POST',
      headers: { 'idempotency-key': 'canary-1', 'user-agent': POLICY_CANARIES[0] },
      body: { ...npmBlock([POLICY_CANARIES[3]]), notes: POLICY_CANARIES[2] },
    }),
    await broker.fetch('/_pb/policies', {
      method: 'POST',
      headers: { 'idempotency-key': 'canary-2' },
      body: { ...npmBlock([]), package: POLICY_CANARIES[2] },
    }),
    await broker.fetch(rule, {
      method: 'PATCH',
      headers: { 'idempotency-key': 'canary-3', 'if-match': '"r4"' },
      body: { state: 'disabled', reason: POLICY_CANARIES[1] },
    }),
    await broker.fetch(`${npm}/${POLICY_NPM_PACKAGE}/2.0.0`, {
      headers: { 'user-agent': `npm/10.0.0 ${POLICY_CANARIES[0]} ${POLICY_CANARIES[1]}` },
    }),
  ];
  const canaryText = [
    ...(await Promise.all(canaries.map(async (response) => response.text()))),
    JSON.stringify(await broker.audits()),
    broker.logs(),
  ].join('\n');

  return {
    created: { status: created.status, revision: created.body['revision'] },
    replay: {
      status: replay.status,
      replayed: replay.replayed,
      same: canonical(replay.body) === canonical(created.body),
    },
    tighten: tighten.status,
    staleWeaken: {
      status: staleWeaken.status,
      code: (staleWeaken.body['error'] as { code?: unknown } | undefined)?.code,
    },
    noReason: noReason.status,
    weaken: { status: weaken.status, members: weaken.body['memberCount'] },
    race: [raceA.status, raceB.status],
    afterOverride,
    late: { status: late.status, read: lateRead, ingested: lateIngested },
    release: { status: release.status, state: release.body['state'], kind: release.body['kind'] },
    afterRelease,
    inspection: {
      status: inspection.status,
      versions: (inspected.versions ?? [])
        .map((entry) => [entry.version, entry.permitted, entry.reasons.map((item) => item.reason)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      urls: JSON.stringify(inspected).includes('://'),
    },
    canaryStatuses: canaries.map((response) => response.status),
    canaryLeaks: POLICY_CANARIES.filter((canary) => canaryText.includes(canary)),
  };
}

export const POLICY_ADMIN_EXPECTED = {
  created: { status: 201, revision: 1 },
  replay: { status: 201, replayed: true, same: true },
  tighten: 200,
  staleWeaken: { status: 403, code: 'reauth_required' },
  noReason: 400,
  weaken: { status: 200, members: 1 },
  race: [200, 412],
  afterOverride: { one: 200, two: 404 },
  late: { status: 201, read: 404, ingested: true },
  release: { status: 200, state: 'disabled', kind: 'quarantine' },
  afterRelease: { status: 404, version: 'quarantined', otherRule: 404 },
  inspection: {
    status: 200,
    versions: [
      ['1.0.0', true, []],
      ['2.0.0', false, ['blocked']],
      ['3.0.0', true, []],
    ],
    urls: false,
  },
  canaryStatuses: [400, 400, 400, 404],
  canaryLeaks: [],
} as const;
