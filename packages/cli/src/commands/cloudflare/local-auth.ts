import { CloudflareError } from './api.js';
import type { DeploymentAttempt } from './inventory.js';

export type LocalAuthMode = 'enabled' | 'disabled';
type Stage = 'deploy' | 'setup';

function invalid(stage: Stage, reason: string): never {
  const error = new CloudflareError('invalid_input', 2, false, stage);
  error.message = reason;
  throw error;
}

export function isLocalAuthMode(value: unknown): value is LocalAuthMode {
  return value === 'enabled' || value === 'disabled';
}

export function resolveLocalAuth(options: {
  flag?: unknown;
  env?: unknown;
  sources?: readonly { bindings: readonly unknown[] }[];
  secretNames?: readonly string[];
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
  if (options.secretNames?.includes('PB_AUTH_LOCAL'))
    return invalid(stage, 'Remove the secret first: wrangler secret delete PB_AUTH_LOCAL');
  const live = (options.sources ?? []).map(({ bindings }) => {
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
  if (options.frozen !== undefined) {
    // Attempts from before this setting used enabled local sign-in.
    const frozen =
      options.frozen.local_auth === undefined ? 'enabled' : parse(options.frozen.local_auth);
    if (explicit !== undefined && explicit !== frozen)
      throw new CloudflareError('configuration_conflict', 8, false, stage, null, null, null, null, [
        'local_auth',
      ]);
    return frozen;
  }
  if (explicit !== undefined) return explicit;
  const modes = live.map((value) => (value === undefined ? 'enabled' : parse(value)));
  if (new Set(modes).size > 1)
    throw new CloudflareError('configuration_conflict', 8, false, stage, null, null, null, null, [
      'local_auth',
    ]);
  return modes[0] ?? 'enabled';
}
