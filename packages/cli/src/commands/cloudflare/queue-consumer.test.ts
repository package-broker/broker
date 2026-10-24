import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { normalizeQueueConsumer } from './queue-consumer.js';

const real = JSON.parse(
  await readFile(new URL('./fixtures/queue-consumer.json', import.meta.url), 'utf8'),
);
const expected = {
  consumer_id: 'e'.repeat(32),
  script_name: 'package-broker-production',
  dead_letter_queue: 'package-broker-production-jobs-dlq',
  batch_size: 1,
  max_wait_time_ms: 1000,
  max_retries: 4,
  max_concurrency: 2,
};

it('normalizes the exact real consumer response to the journalled create configuration', () => {
  expect(normalizeQueueConsumer(real)).toEqual(expected);
});
it.each(['read-back', 'create', 'both'] as const)(
  'compares %s aliases in milliseconds with the omitted retry-delay default',
  (shape) => {
    const c = structuredClone(real);
    delete c.settings.retry_delay;
    if (shape !== 'read-back') {
      c.script_name = c.script;
      c.settings.max_batch_size = 1;
      c.settings.max_batch_timeout = 1;
    }
    if (shape === 'create') {
      delete c.script;
      delete c.settings.batch_size;
      delete c.settings.max_wait_time_ms;
    }
    expect(normalizeQueueConsumer(c)).toEqual(expected);
  },
);
it('converts fractional seconds only when they represent whole milliseconds', () => {
  const c = structuredClone(real);
  delete c.settings.max_wait_time_ms;
  c.settings.max_batch_timeout = 0.001;
  expect(normalizeQueueConsumer(c)?.max_wait_time_ms).toBe(1);
  c.settings.max_batch_timeout = 0.0001;
  expect(normalizeQueueConsumer(c)).toBeNull();
});
it.each([
  ['script_name', 'foreign-worker'],
  ['max_batch_size', 2],
  ['max_batch_timeout', 1000],
] as const)('refuses a conflicting simultaneous %s alias', (field, value) => {
  const c = structuredClone(real);
  if (field === 'script_name') c[field] = value;
  else c.settings[field] = value;
  expect(normalizeQueueConsumer(c)).toBeNull();
});
it.each([1, null, '0', -1, 0.5])('refuses a non-default or malformed retry_delay: %s', (delay) => {
  const c = structuredClone(real);
  c.settings.retry_delay = delay;
  expect(normalizeQueueConsumer(c)).toBeNull();
});
it.each(['batch_size', 'max_wait_time_ms', 'max_retries', 'max_concurrency'])(
  'refuses missing, string or negative %s limits',
  (field) => {
    const c = structuredClone(real);
    delete c.settings[field];
    expect(normalizeQueueConsumer(c)).toBeNull();
    c.settings[field] = '1';
    expect(normalizeQueueConsumer(c)).toBeNull();
    c.settings[field] = -1;
    expect(normalizeQueueConsumer(c)).toBeNull();
  },
);
it.each(['script', 'dead_letter_queue', 'consumer_id', 'type', 'settings'])(
  'refuses a consumer without %s',
  (field) => {
    const c = structuredClone(real);
    delete c[field];
    expect(normalizeQueueConsumer(c)).toBeNull();
  },
);
