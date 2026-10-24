export function d1BindingId(binding: Record<string, unknown>): string | null {
  const id = binding.database_id ?? binding.id;
  if (
    typeof id !== 'string' ||
    !id ||
    (binding.database_id !== undefined && binding.database_id !== id) ||
    (binding.id !== undefined && binding.id !== id)
  )
    return null;
  return id;
}

const targets: Readonly<Record<string, readonly string[]>> = {
  d1: ['id'],
  plain_text: ['text'],
  r2_bucket: ['bucket_name', 'jurisdiction'],
  queue: ['queue_name'],
  analytics_engine: ['dataset'],
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unordered = (value: unknown) => (Array.isArray(value) ? [...value].sort() : value);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function target(binding: Record<string, unknown>, key: string): unknown {
  if (binding.type === 'd1' && key === 'id') return d1BindingId(binding);
  if (binding.type === 'r2_bucket' && key === 'jurisdiction')
    return binding.jurisdiction ?? 'default';
  return binding[key];
}

/** Compare install-managed fields, excluding provider defaults and version metadata. */
export function workerSettingsDifferences(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  bindingNames: readonly string[],
): string[] {
  const differences: string[] = [];
  for (const key of ['compatibility_date', 'compatibility_flags', 'tags']) {
    const normalize = key === 'compatibility_date' ? (v: unknown) => v : unordered;
    if (!equal(normalize(actual[key]), normalize(expected[key])))
      differences.push(`worker_settings:${key}`);
  }
  if (!Array.isArray(actual.bindings) || !Array.isArray(expected.bindings))
    differences.push('worker_settings:bindings');
  else {
    const live = actual.bindings.map(object);
    const prior = expected.bindings.map(object);
    for (const binding of prior) {
      const name =
        typeof binding.name === 'string' &&
        /^[A-Z][A-Z0-9_]{0,127}$/.test(binding.name) &&
        bindingNames.includes(binding.name)
          ? binding.name
          : 'unknown';
      const field = (key: string) => `worker_settings:binding:${name}:${key}`;
      const matches = live.filter((b) => b.name === binding.name);
      if (matches.length !== 1) {
        differences.push(field('presence'));
        continue;
      }
      const observed = matches[0]!;
      if (observed.type !== binding.type) differences.push(field('type'));
      if (
        observed.type === 'd1' &&
        observed.id !== undefined &&
        observed.database_id !== undefined &&
        observed.id !== observed.database_id
      )
        differences.push(field('id'));
      const keys = Object.hasOwn(targets, String(binding.type))
        ? targets[String(binding.type)]!
        : [];
      for (const key of keys)
        if (!equal(target(observed, key), target(binding, key))) differences.push(field(key));
    }
    if (live.some((b) => !prior.some((p) => p.name === b.name)))
      differences.push('worker_settings:bindings:unexpected');
  }
  // Uploads declare these two fields; other observability fields are account defaults.
  const priorObservability = object(expected.observability);
  const liveObservability = object(actual.observability);
  if (
    Object.hasOwn(priorObservability, 'enabled') &&
    priorObservability.enabled !== liveObservability.enabled
  )
    differences.push('worker_settings:observability:enabled');
  const priorLogs = object(priorObservability.logs);
  if (
    Object.hasOwn(priorLogs, 'invocation_logs') &&
    priorLogs.invocation_logs !== object(liveObservability.logs).invocation_logs
  )
    differences.push('worker_settings:observability:logs:invocation_logs');
  return [...new Set(differences)];
}
