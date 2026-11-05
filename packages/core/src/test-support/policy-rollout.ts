import {
  POLICY_NPM_PACKAGE,
  json,
  npmBlock,
  policyWrite,
  sortedKeys,
  type PolicyBroker,
} from './policy-broker.js';

/** Boots brokers over one database with the policy flag on or off, as an operator would. */
export interface PolicyRollout {
  boot(enabled: boolean): Promise<PolicyBroker>;
  /** Whether booting with the flag fails; the attempt is closed either way. */
  bootFails(enabled: boolean): Promise<boolean>;
  storedRules(): Promise<number>;
  dropPolicySchema(): Promise<void>;
}

async function observe(broker: PolicyBroker) {
  const npm = `/${broker.project}/npm`;
  const packument = await broker.fetch(`${npm}/${POLICY_NPM_PACKAGE}`);
  const body = (await json(packument)) as {
    versions: Record<string, { dist: { tarball: string } }>;
  };
  const tarball = await broker.fetch(new URL(body.versions['1.0.0']!.dist.tarball).pathname);
  await tarball.arrayBuffer();
  return {
    versions: sortedKeys(body.versions),
    policyValidator: packument.headers.get('etag')?.startsWith('W/"p.') ?? false,
    distImmutable: tarball.headers.get('cache-control')?.includes('immutable') ?? false,
    management: (await broker.fetch('/_pb/policies')).status,
  };
}

const ADVERTISED = /polic/i;

/**
 * Every policy operation the broker's own OpenAPI document advertises, called with the flag off:
 * rules are staged and reviewed before anything is enforced (DEC-NPM-50).
 */
async function offManagement(broker: PolicyBroker) {
  const document = (await json(await broker.fetch('/_pb/openapi.json'))) as {
    paths: Record<string, Record<string, { operationId: string }>>;
  };
  const advertised = Object.entries(document.paths)
    .filter(([path]) => ADVERTISED.test(path))
    .flatMap(([, methods]) => Object.values(methods).map((operation) => operation.operationId))
    .sort();
  const packageId = (await broker.packageId(POLICY_NPM_PACKAGE)) ?? '';
  await broker.reauth();
  const project = `/_pb/projects/${broker.project}/policies`;
  const staged = npmBlock(['9.9.9']);
  const answers: Record<string, number> = {};
  const read = async (operationId: string, path: string) => {
    answers[operationId] = (await broker.fetch(path)).status;
  };
  const created = await policyWrite(broker, '/_pb/policies', 'POST', staged);
  answers['createPolicy'] = created.status;
  const id = String(created.body['id']);
  await read('listPolicies', '/_pb/policies');
  await read('getPolicy', `/_pb/policies/${id}`);
  await read('inspectPackagePolicy', `/_pb/policies/packages/${packageId}`);
  answers['updatePolicy'] = (
    await policyWrite(
      broker,
      `/_pb/policies/${id}`,
      'PATCH',
      { state: 'disabled', reason: 'superseded' },
      { revision: 1 },
    )
  ).status;
  const projectCreated = await policyWrite(broker, project, 'POST', staged);
  answers['createProjectPolicy'] = projectCreated.status;
  const projectId = String(projectCreated.body['id']);
  await read('listProjectPolicies', project);
  await read('getProjectPolicy', `${project}/${projectId}`);
  await read('inspectProjectPackagePolicy', `${project}/packages/${packageId}`);
  answers['updateProjectPolicy'] = (
    await policyWrite(
      broker,
      `${project}/${projectId}`,
      'PATCH',
      { state: 'disabled', reason: 'superseded' },
      { revision: 1 },
    )
  ).status;
  return { advertised, answered: Object.keys(answers).sort(), answers };
}

/** Default off, opt-in, flag off with stored rules, re-enable, and the missing-schema boot. */
export async function policyRolloutMatrix(rollout: PolicyRollout) {
  const off = await rollout.boot(false);
  const defaultOff = await observe(off);
  const enabledBroker = await rollout.boot(true);
  const created = await policyWrite(enabledBroker, '/_pb/policies', 'POST', npmBlock(['2.0.0']));
  const enabled = await observe(enabledBroker);
  const disabled = await observe(await rollout.boot(false));
  const kept = await rollout.storedRules();
  const managedOff = await offManagement(await rollout.boot(false));
  const reenabled = await observe(await rollout.boot(true));
  const offBootsWithoutSchema = !(await rollout.bootFails(false));
  await rollout.dropPolicySchema();
  const enabledFailsWithoutSchema = await rollout.bootFails(true);
  const disabledBootsWithoutSchema = !(await rollout.bootFails(false));
  const withoutSchema = await rollout.boot(false);
  const managementWithoutSchema = (await withoutSchema.fetch('/_pb/policies')).status;
  return {
    defaultOff,
    created: created.status,
    enabled,
    disabled,
    kept,
    managedOff,
    reenabled,
    offBootsWithoutSchema,
    enabledFailsWithoutSchema,
    disabledBootsWithoutSchema,
    managementWithoutSchema,
  };
}

/** Serving as before policy existed; management answers because the policy schema exists. */
const LEGACY = {
  versions: ['1.0.0', '2.0.0', '3.0.0'],
  policyValidator: false,
  distImmutable: true,
  management: 200,
};
const MANAGEMENT_OPERATIONS = [
  'createPolicy',
  'createProjectPolicy',
  'getPolicy',
  'getProjectPolicy',
  'inspectPackagePolicy',
  'inspectProjectPackagePolicy',
  'listPolicies',
  'listProjectPolicies',
  'updatePolicy',
  'updateProjectPolicy',
];
const GOVERNED = {
  versions: ['1.0.0', '3.0.0'],
  policyValidator: true,
  distImmutable: false,
  management: 200,
};

export const POLICY_ROLLOUT_EXPECTED = {
  defaultOff: LEGACY,
  created: 201,
  enabled: GOVERNED,
  disabled: LEGACY,
  kept: 1,
  managedOff: {
    advertised: MANAGEMENT_OPERATIONS,
    answered: MANAGEMENT_OPERATIONS,
    answers: {
      createPolicy: 201,
      createProjectPolicy: 201,
      getPolicy: 200,
      getProjectPolicy: 200,
      inspectPackagePolicy: 200,
      inspectProjectPackagePolicy: 200,
      listPolicies: 200,
      listProjectPolicies: 200,
      updatePolicy: 200,
      updateProjectPolicy: 200,
    },
  },
  reenabled: GOVERNED,
  offBootsWithoutSchema: true,
  enabledFailsWithoutSchema: true,
  disabledBootsWithoutSchema: true,
  managementWithoutSchema: 404,
} as const;
