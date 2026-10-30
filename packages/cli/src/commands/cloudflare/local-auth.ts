import { CloudflareError, type CloudflareApi } from './api.js';
import { inputMessages } from './input-messages.js';
import type { DeploymentAttempt, DeploymentJournal } from './inventory.js';

export type LocalAuthMode = 'enabled' | 'disabled';
type Stage = 'deploy' | 'setup';

function invalid(stage: Stage, reason: string): never {
  const error = new CloudflareError('invalid_input', 2, false, stage);
  error.message = reason;
  inputMessages.set(error, reason);
  throw error;
}

export function isLocalAuthMode(value: unknown): value is LocalAuthMode {
  return value === 'enabled' || value === 'disabled';
}

export function resolveLocalAuth(options: {
  flag?: unknown;
  env?: unknown;
  // null explicitly identifies a fresh installation with no Worker.
  sources: readonly { bindings: readonly unknown[] }[] | null;
  secretNames?: readonly string[];
  verified?: Pick<DeploymentAttempt, 'local_auth'> | null | undefined;
  frozen?: Pick<DeploymentAttempt, 'local_auth'>;
  stage?: Stage;
}): LocalAuthMode {
  const stage = options.stage ?? 'deploy';
  const parse = (value: unknown): LocalAuthMode => {
    if (!isLocalAuthMode(value)) return invalid(stage, 'auth_local_invalid');
    return value;
  };
  const flag = options.flag === undefined ? undefined : parse(options.flag);
  const env = options.env === undefined ? undefined : parse(options.env);
  if (flag !== undefined && env !== undefined && flag !== env)
    return invalid(stage, 'PB_AUTH_LOCAL conflicts with --local-auth');
  const explicit = flag ?? env;
  for (const name of ['PB_AUTH_LOCAL', 'PB_IDP_PROVIDERS'])
    if (options.secretNames?.includes(name))
      return invalid(stage, `Remove the secret first: wrangler secret delete ${name}`);
  const sources = options.sources;
  if (sources !== null && (!Array.isArray(sources) || sources.length === 0))
    return invalid(stage, 'Local auth live state is incomplete');
  const live = (sources === null ? [{ bindings: [] }] : Array.from(sources)).map((source) => {
    if (!source || !Array.isArray(source.bindings))
      return invalid(stage, 'Local auth live state is incomplete');
    const bindings: readonly unknown[] = source.bindings;
    const found = bindings.filter(
      (binding): binding is Record<string, unknown> =>
        binding !== null &&
        typeof binding === 'object' &&
        !Array.isArray(binding) &&
        'name' in binding &&
        binding.name === 'PB_AUTH_LOCAL',
    );
    if (found.some((binding) => binding.type === 'secret_text'))
      return invalid(stage, 'Remove the secret first: wrangler secret delete PB_AUTH_LOCAL');
    if (found.length > 1) return invalid(stage, 'Duplicate PB_AUTH_LOCAL bindings');
    const binding = found[0];
    if (binding && (binding.type !== 'plain_text' || typeof binding.text !== 'string'))
      return invalid(stage, 'Malformed PB_AUTH_LOCAL binding');
    return binding?.text;
  });
  const resolved = (mode: LocalAuthMode): LocalAuthMode => {
    if (
      mode === 'enabled' &&
      flag !== 'enabled' &&
      (live.includes('disabled') || options.verified?.local_auth === 'disabled')
    )
      return invalid(stage, 'Re-enabling local sign-in requires --local-auth enabled');
    return mode;
  };
  if (options.frozen?.local_auth !== undefined) {
    const frozen = parse(options.frozen.local_auth);
    if (explicit !== undefined && explicit !== frozen)
      throw new CloudflareError('configuration_conflict', 8, false, stage, null, null, null, null, [
        'local_auth',
      ]);
    return resolved(frozen);
  }
  if (explicit !== undefined && options.frozen === undefined) return resolved(explicit);
  const modes = live.map((value) => {
    if (value === undefined) return 'enabled';
    if (!isLocalAuthMode(value)) return invalid(stage, 'Invalid live PB_AUTH_LOCAL binding');
    return value;
  });
  if (new Set(modes).size > 1)
    throw new CloudflareError('configuration_conflict', 8, false, stage, null, null, null, null, [
      'local_auth',
    ]);
  const mode = modes[0]!;
  if (explicit !== undefined && explicit !== mode)
    throw new CloudflareError('configuration_conflict', 8, false, stage, null, null, null, null, [
      'local_auth',
    ]);
  return resolved(mode);
}

export function verifiedDeployment(deployment: DeploymentJournal | null | undefined) {
  return deployment?.attempt.phase === 'verified' && deployment.attempt.smoke === 'passed'
    ? deployment.attempt
    : (deployment?.last_verified ?? null);
}

export function frozenLocalAuthAttempt(
  attempt: DeploymentAttempt | undefined,
  stage: Stage,
): DeploymentAttempt | undefined {
  if (
    !attempt ||
    ![
      'preparing_upload',
      'upload_pending',
      'uploaded',
      'configuring',
      'activation_pending',
    ].includes(attempt.phase)
  )
    return undefined;
  if (attempt.local_auth === undefined)
    return invalid(
      stage,
      "This frozen deployment attempt predates local-auth support and cannot be resumed; finish it with the previous release's CLI, then deploy again",
    );
  return attempt;
}

type BindingSource = { bindings: readonly unknown[] };

export async function readLocalAuthSources(options: {
  api: CloudflareApi;
  base: string;
  versions: readonly { version_id: string }[];
  stage: Stage;
  settings?: unknown;
  prior?: Record<string, unknown> | undefined;
}): Promise<BindingSource[]> {
  const conflict = (field: string): never => {
    throw new CloudflareError(
      'configuration_conflict',
      8,
      false,
      options.stage,
      null,
      null,
      null,
      null,
      [field],
    );
  };
  const sources: BindingSource[] = [];
  const versions = options.versions;
  for (const version of versions) {
    const response =
      options.prior ??
      (await options.api.request(`${options.base}/versions/${version.version_id}`)).result;
    if (
      !response ||
      typeof response !== 'object' ||
      Array.isArray(response) ||
      !('id' in response) ||
      response.id !== version.version_id
    )
      return conflict('version_id');
    const resources = ('resources' in response ? response.resources : undefined) as
      BindingSource | undefined;
    if (!resources || !Array.isArray(resources.bindings)) return conflict('providers');
    sources.push(resources);
  }
  if (!versions.length) {
    const settings =
      options.settings ?? (await options.api.request(`${options.base}/settings`)).result;
    if (
      !settings ||
      typeof settings !== 'object' ||
      Array.isArray(settings) ||
      !('bindings' in settings) ||
      !Array.isArray(settings.bindings)
    )
      return conflict('local_auth');
    sources.push({ bindings: settings.bindings });
  }
  for (const source of sources)
    if (
      source.bindings.some(
        (binding) =>
          binding !== null &&
          typeof binding === 'object' &&
          'name' in binding &&
          binding.name === 'PB_IDP_PROVIDERS' &&
          'type' in binding &&
          binding.type === 'secret_text',
      )
    )
      invalid(options.stage, 'Remove the secret first: wrangler secret delete PB_IDP_PROVIDERS');
  return sources;
}

export function liveLocalAuthModes(sources: readonly BindingSource[], stage: Stage) {
  const modes = sources.map((source) => {
    const binding = source.bindings.find(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        'name' in value &&
        value.name === 'PB_AUTH_LOCAL',
    ) as { text?: unknown } | undefined;
    return binding?.text ?? 'enabled';
  });
  if (new Set(modes).size > 1)
    throw new CloudflareError('configuration_conflict', 8, false, stage, null, null, null, null, [
      'local_auth',
    ]);
  return modes;
}
