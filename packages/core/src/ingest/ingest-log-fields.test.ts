import { describe, expect, it } from 'vitest';
import { MAX_KEY_LENGTH } from '../catalogue/names.js';
import {
  createObservability,
  PACKAGE_KEY_MAX_LENGTH,
  projectLogFields,
  type ObsRecord,
  type ObsRecordSink,
  type SafeLogRecord,
} from '../platform/observability.js';
import { INGEST_EVENTS, INGEST_REASON_CODES } from './finalize-guard.js';

const REQUEST_ID = '0b8f3a3e-8d0c-4a52-9c1c-2f6f1b3a9e11';

function emitExhausted(packageKey: unknown): SafeLogRecord {
  const records: ObsRecord[] = [];
  const sink: ObsRecordSink = { emit: (record) => void records.push(record) };
  const obs = createObservability(
    sink,
    { deploymentId: 'dep-1', runtime: 'node', requestId: REQUEST_ID },
    { events: INGEST_EVENTS, reasonCodes: INGEST_REASON_CODES, routeTemplates: new Set() },
  );
  obs.log({
    level: 'warn',
    event: 'ingest.budget_exhausted',
    reason_code: 'budget_exhausted',
    package_key: packageKey,
    seq: 7,
  });
  const logs = records.filter((r) => r.kind === 'log');
  expect(logs).toHaveLength(1);
  const [only] = logs;
  if (only?.kind !== 'log') throw new Error('expected a log record');
  return only.record;
}

describe('package_key on ingest log records', () => {
  it.each(['@scope/name', 'vendor/name', 'left-pad', 'a'.repeat(MAX_KEY_LENGTH)])(
    'keeps %s with seq intact',
    (key) => {
      const record = emitExhausted(key);
      expect(record.package_key).toBe(key);
      expect(record.seq).toBe(7);
      expect(record.event).toBe('ingest.budget_exhausted');
    },
  );

  it.each([
    'https://x/y',
    'Acme/Lib',
    'a b',
    'a\u0000b',
    'a:b',
    'a?b',
    'a#b',
    'a\\b',
    'a\tb',
    '',
    'a'.repeat(429),
    42,
    null,
  ])('omits invalid value %j and keeps the rest of the record', (key) => {
    const record = emitExhausted(key);
    expect('package_key' in record).toBe(false);
    expect(record.seq).toBe(7);
    expect(record.reason_code).toBe('budget_exhausted');
  });
});

describe('package_key projection', () => {
  it('is part of the projected log fields', () => {
    expect(projectLogFields({ package_key: 'vendor/name', seq: 1 })).toEqual({
      seq: 1,
      package_key: 'vendor/name',
    });
  });
});

describe('package_key length bound', () => {
  it('equals the catalogue key limit', () => {
    expect(PACKAGE_KEY_MAX_LENGTH).toBe(MAX_KEY_LENGTH);
  });
});
