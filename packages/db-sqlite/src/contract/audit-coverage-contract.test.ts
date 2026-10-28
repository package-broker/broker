import { readdirSync, readFileSync } from 'node:fs';
import { AUDIT_ACTIONS } from '@package-broker/core/audit/actions';
import { describe, expect, it } from 'vitest';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import {
  AUDIT_COVERAGE,
  AUDIT_INJECTED_STATEMENTS,
  AUDIT_SECURITY_ATTEMPTS,
  AUDIT_UNCAPTURED,
  describeAuditCoverageContract,
} from './audit-coverage-contract.js';

const packages = new URL('../../../', import.meta.url);
const repositories = new URL('../repositories/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, packages), 'utf8');

describe('audit coverage inventory', () => {
  it('accounts for every declared action, including declared actions without a producer', () => {
    const captured = new Set([
      ...AUDIT_COVERAGE.flatMap((entry) => entry.actions),
      ...AUDIT_INJECTED_STATEMENTS.flatMap((entry) => entry.actions),
    ]);
    const uncaptured = AUDIT_UNCAPTURED.map((entry) => entry.action);
    expect(uncaptured.every((action) => !captured.has(action))).toBe(true);
    expect([...captured, ...uncaptured].sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it('pins all direct staging sites so new repository paths and calls require inventory review', () => {
    const actual = readdirSync(repositories)
      .filter(
        (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'audit-pending.ts',
      )
      .map((name) => ({
        repository: name.slice(0, -3),
        stagingCalls: [
          ...readFileSync(new URL(name, repositories), 'utf8').matchAll(
            /\bauditPendingStatement\s*\(/g,
          ),
        ].length,
      }))
      .filter((entry) => entry.stagingCalls > 0)
      .sort((a, b) => a.repository.localeCompare(b.repository));
    expect(actual).toEqual(
      AUDIT_COVERAGE.map(({ repository, stagingCalls }) => ({ repository, stagingCalls })).sort(
        (a, b) => a.repository.localeCompare(b.repository),
      ),
    );
  });

  it('keeps caller, repository, batch guard and cardinality references reviewable', () => {
    for (const entry of AUDIT_COVERAGE) {
      expect(entry.actions.length).toBeGreaterThan(0);
      expect(entry.callers.length).toBeGreaterThan(0);
      for (const caller of entry.callers) expect(read(caller).length).toBeGreaterThan(0);
      expect(read(`db-sqlite/src/repositories/${entry.repository}.ts`)).toContain(
        'auditPendingStatement',
      );
      expect(entry.batchGuard.length).toBeGreaterThan(0);
      expect(entry.cardinality.length).toBeGreaterThan(0);
    }
    for (const entry of AUDIT_INJECTED_STATEMENTS) {
      expect(read(entry.caller)).toContain('audit');
      expect(read(entry.service)).toContain('audit:');
      expect(read(entry.wiring)).toContain('auditStatement: auditPendingStatement');
      expect(read(entry.repository)).toContain('input.audit');
    }
  });

  it('records the current absence of failed security-attempt capture without claiming coverage', () => {
    expect(AUDIT_SECURITY_ATTEMPTS.filter(({ captured }) => captured)).toEqual([]);
    expect(AUDIT_SECURITY_ATTEMPTS.map(({ attempt }) => attempt)).toEqual([
      'failed login',
      'authorization denial',
      'failed reauthentication',
      'logout without active session',
      'logout sanitizer refusal',
    ]);
    const producerSources = ['core/src/', 'db-sqlite/src/repositories/'].flatMap((root) =>
      readdirSync(new URL(root, packages), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .filter((file) => `${root}${file}` !== 'core/src/audit/actions.ts')
        .map((file) => ({ path: `${root}${file}`, source: read(`${root}${file}`) })),
    );
    for (const { action } of AUDIT_UNCAPTURED) {
      expect(AUDIT_ACTIONS).toContain(action);
      expect(
        producerSources
          .filter(({ source }) => source.includes(`'${action}'`) || source.includes(`"${action}"`))
          .map(({ path }) => path),
      ).toEqual([]);
    }
  });
});

describeAuditCoverageContract(async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  return {
    executor: database.executor,
    ctx: database.orgs.a,
    foreign: database.orgs.b,
    close: () => database.close(),
  };
});
