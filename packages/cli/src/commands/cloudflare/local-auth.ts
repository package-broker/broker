import { CloudflareError } from './api.js';
import { inputMessages } from './input-messages.js';
import type { DeploymentAttempt } from './inventory.js';

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
  if (options.frozen?.local_auth !== undefined) {
    const frozen = parse(options.frozen.local_auth);
    if (explicit !== undefined && explicit !== frozen)
      throw new CloudflareError('configuration_conflict', 8, false, stage, null, null, null, null, [
        'local_auth',
      ]);
    return frozen;
  }
  if (explicit !== undefined && options.frozen === undefined) return explicit;
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
  return mode;
}
