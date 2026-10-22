import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
const SOURCE_ID = '01JA0000000000000000000000';

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
    source_id: SOURCE_ID,
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
      expect(record.source_id).toBe(SOURCE_ID);
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

describe('ingest event emitters', () => {
  it('pairs every package_key with source_id', () => {
    const root = new URL('./', import.meta.url);
    let checked = 0;
    for (const file of globSync('**/*.ts', { cwd: fileURLToPath(root) })) {
      if (file.endsWith('.test.ts')) continue;
      const source = ts.createSourceFile(
        file,
        readFileSync(new URL(file, root), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const fields = node.properties.map((property) => {
            const name = property.name;
            return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))
              ? name.text
              : undefined;
          });
          if (fields.includes('package_key')) {
            checked++;
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            expect(fields, `${file}:${line + 1}`).toContain('source_id');
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('package_key projection', () => {
  it('is part of the projected log fields', () => {
    expect(projectLogFields({ package_key: 'vendor/name', source_id: SOURCE_ID, seq: 1 })).toEqual({
      seq: 1,
      package_key: 'vendor/name',
      source_id: SOURCE_ID,
    });
  });
});

describe('package_key length bound', () => {
  it('equals the catalogue key limit', () => {
    expect(PACKAGE_KEY_MAX_LENGTH).toBe(MAX_KEY_LENGTH);
  });
});
