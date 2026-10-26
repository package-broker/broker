import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { workerSettingsDifferences } from './worker-settings.js';

const real = JSON.parse(
  await readFile(new URL('./fixtures/worker-settings.json', import.meta.url), 'utf8'),
);
const names = real.bindings.map((b: { name: string }) => b.name) as string[];
function declared() {
  const { compatibility_date, compatibility_flags, tags } = real;
  return {
    compatibility_date,
    compatibility_flags,
    tags,
    bindings: real.bindings.map((b: Record<string, unknown>) => {
      const { database_id, ...binding } = b;
      void database_id;
      return binding;
    }),
  };
}

it('R9 compares the exact real settings with only declared upload fields', () => {
  expect(workerSettingsDifferences(real, declared(), names)).toEqual([]);
});
it('R9 ignores version annotations, binding order, D1 aliases and extra binding read-back fields', () => {
  const actual = structuredClone(real);
  actual.annotations = { 'workers/tag': 'FOREIGN_SENTINEL' };
  actual.bindings.reverse();
  actual.tags.reverse();
  for (const binding of actual.bindings) binding.provider_field = 'FOREIGN_SENTINEL';
  delete actual.bindings.find((b: { name: string }) => b.name === 'DB').id;
  expect(workerSettingsDifferences(actual, real, names)).toEqual([]);
});
it('R9 compares compatibility flags as a set', () => {
  const expected = { ...real, compatibility_flags: ['nodejs_compat', 'another_flag'] };
  const actual = { ...real, compatibility_flags: ['another_flag', 'nodejs_compat'] };
  expect(workerSettingsDifferences(actual, expected, names)).toEqual([]);
});
it('R9 never derives diagnostic names from undeclared provider binding names', () => {
  const expected = {
    ...real,
    bindings: [{ name: 'FOREIGN_SENTINEL', type: 'plain_text', text: 'a' }],
  };
  const actual = {
    ...expected,
    bindings: [{ name: 'FOREIGN_SENTINEL', type: 'plain_text', text: 'b' }],
  };
  expect(workerSettingsDifferences(actual, expected, names)).toEqual([
    'worker_settings:binding:unknown:text',
  ]);
});
it.each([
  ['compatibility_date', 'worker_settings:compatibility_date'],
  ['compatibility_flags', 'worker_settings:compatibility_flags'],
  ['tags', 'worker_settings:tags'],
  ['DB:id', 'worker_settings:binding:DB:id'],
  ['DB:database_id', 'worker_settings:binding:DB:id'],
  ['JOBS:queue_name', 'worker_settings:binding:JOBS:queue_name'],
  ['STORAGE:bucket_name', 'worker_settings:binding:STORAGE:bucket_name'],
  ['STORAGE:jurisdiction', 'worker_settings:binding:STORAGE:jurisdiction'],
  ['ANALYTICS:dataset', 'worker_settings:binding:ANALYTICS:dataset'],
  ['PB_PUBLIC_URL:text', 'worker_settings:binding:PB_PUBLIC_URL:text'],
  ['DEPLOYMENT_ID:text', 'worker_settings:binding:DEPLOYMENT_ID:text'],
  ['ASSETS:type', 'worker_settings:binding:ASSETS:type'],
  ['PB_MASTER_KEY:presence', 'worker_settings:binding:PB_MASTER_KEY:presence'],
  ['ASSETS:duplicate', 'worker_settings:binding:ASSETS:presence'],
  ['unexpected', 'worker_settings:bindings:unexpected'],
])('R9 reports only safe names for managed differences: %s', (field, diagnostic) => {
  const actual = structuredClone(real);
  const [name, key] = field.split(':');
  const binding = actual.bindings.find((b: { name: string }) => b.name === name);
  if (key === 'presence') actual.bindings = actual.bindings.filter((b: unknown) => b !== binding);
  else if (key === 'duplicate') actual.bindings.push({ ...binding });
  else if (key) binding[key] = 'FOREIGN_SENTINEL';
  else if (field === 'unexpected')
    actual.bindings.push({ name: 'FOREIGN_SENTINEL', type: 'plain_text', text: 'SECRET_SENTINEL' });
  else actual[field] = field === 'compatibility_date' ? 'FOREIGN_SENTINEL' : ['FOREIGN_SENTINEL'];
  const differences = workerSettingsDifferences(actual, real, names);
  expect(differences).toContain(diagnostic);
  expect(JSON.stringify(differences)).not.toMatch(/FOREIGN_SENTINEL|SECRET_SENTINEL/);
});
it.each(['enabled', 'invocation_logs'])(
  'R9 checks explicitly declared observability %s',
  (field) => {
    const actual = structuredClone(real);
    if (field === 'enabled') actual.observability.enabled = false;
    else actual.observability.logs.invocation_logs = true;
    const expected = {
      ...declared(),
      observability: { enabled: true, logs: { invocation_logs: false } },
    };
    expect(workerSettingsDifferences(actual, expected, names)).toEqual([
      `worker_settings:observability:${field === 'enabled' ? 'enabled' : 'logs:invocation_logs'}`,
    ]);
    expect(workerSettingsDifferences(actual, declared(), names)).toEqual([]);
  },
);

it.each<[string, unknown, unknown]>([
  ['enabled', true, false],
  ['head_sampling_rate', 0.05, 1],
  ['destinations', ['collector'], ['PRIVATE_SENTINEL']],
  ['persist', false, true],
])('compares only declared tracing %s', (field, prior, live) => {
  const expected = { ...declared(), observability: { traces: { [field]: prior } } };
  const actual = { ...declared(), observability: { traces: { [field]: live } } };
  expect(workerSettingsDifferences(actual, expected, names)).toEqual([
    `worker_settings:observability:traces:${field}`,
  ]);
  expect(workerSettingsDifferences(declared(), expected, names)).toEqual([
    `worker_settings:observability:traces:${field}`,
  ]);
  expect(workerSettingsDifferences(expected, expected, names)).toEqual([]);
  expect(workerSettingsDifferences(actual, declared(), names)).toEqual([]);
  expect(
    workerSettingsDifferences(
      actual,
      {
        ...declared(),
        observability: { traces: {} },
      },
      names,
    ),
  ).toEqual([]);
});

it.each([
  ['enabled', true],
  ['head_sampling_rate', 0.05],
  ['persist', false],
])('detects trace %s drift against the real fixture', (field, value) => {
  const actual = structuredClone(real);
  actual.observability.traces[field] = value;
  expect(workerSettingsDifferences(actual, real, names)).toEqual([
    `worker_settings:observability:traces:${field}`,
  ]);
});

it('compares the real fixture when neither side declares trace destinations', () => {
  expect(real.observability.traces).not.toHaveProperty('destinations');
  expect(workerSettingsDifferences(structuredClone(real), real, names)).toEqual([]);
});

it('ignores trace destination order without mutating settings', () => {
  const expected = structuredClone(real);
  expected.observability.traces.destinations = ['first', 'second'];
  const actual = structuredClone(expected);
  actual.observability.traces.destinations.reverse();
  expect(workerSettingsDifferences(actual, expected, names)).toEqual([]);
  expect(actual.observability.traces.destinations).toEqual(['second', 'first']);
  expect(expected.observability.traces.destinations).toEqual(['first', 'second']);
});
