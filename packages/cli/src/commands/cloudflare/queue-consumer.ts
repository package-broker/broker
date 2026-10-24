import type { QueueConsumer } from './inventory.js';

const safeId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);

export function queueConsumerScript(c: Record<string, unknown>): string | null {
  const script = c.script ?? c.script_name;
  if (
    !safeId(script) ||
    (Object.hasOwn(c, 'script') && c.script !== script) ||
    (Object.hasOwn(c, 'script_name') && c.script_name !== script)
  )
    return null;
  return script;
}

function numberSetting(
  settings: Record<string, unknown>,
  field: string,
  alias?: string,
  scale = 1,
): number | null {
  const values: unknown[] = [];
  if (Object.hasOwn(settings, field)) values.push(settings[field]);
  if (alias && Object.hasOwn(settings, alias)) {
    const v = settings[alias];
    values.push(typeof v === 'number' ? v * scale : null);
  }
  if (
    !values.length ||
    values.some((v) => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) ||
    values.some((v) => v !== values[0])
  )
    return null;
  return values[0] as number;
}

export function normalizeQueueConsumer(c: Record<string, unknown>): QueueConsumer | null {
  const script_name = queueConsumerScript(c);
  const settings = c.settings;
  if (
    c.type !== 'worker' ||
    !script_name ||
    !safeId(c.consumer_id) ||
    !safeId(c.dead_letter_queue) ||
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings)
  )
    return null;
  const s = settings as Record<string, unknown>;
  const batch_size = numberSetting(s, 'batch_size', 'max_batch_size');
  const max_wait_time_ms = numberSetting(s, 'max_wait_time_ms', 'max_batch_timeout', 1000);
  const max_retries = numberSetting(s, 'max_retries');
  const max_concurrency = numberSetting(s, 'max_concurrency');
  // The journal's managed consumer implies the provider's zero retry-delay default.
  if (
    batch_size === null ||
    max_wait_time_ms === null ||
    max_retries === null ||
    max_concurrency === null ||
    (Object.hasOwn(s, 'retry_delay') && s.retry_delay !== 0)
  )
    return null;
  return {
    consumer_id: c.consumer_id,
    script_name,
    batch_size,
    max_wait_time_ms,
    max_retries,
    max_concurrency,
    dead_letter_queue: c.dead_letter_queue,
  };
}
