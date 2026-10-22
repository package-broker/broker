import { describe, expect, it } from 'vitest';
import type { TestCase } from 'vitest/node';
import {
  createStatementBudgetTripReporter,
  checkStatementBudgetTrip,
  statementBudgetTripSites,
} from './statement-budget-trip-sites.js';

function event(site: string, state: 'passed' | 'failed', counts: number[]): TestCase {
  const [file, ...names] = site.split(' > ');
  const [project, ...path] = file!.split('/');
  return {
    project: { name: project },
    module: { relativeModuleId: path.join('/') },
    fullName: names.join(' > '),
    result: () => ({ state }),
    meta: () => ({ statementBudgetTrips: counts }),
  } as unknown as TestCase;
}

const listed = 'db-sqlite/src/repositories/bulk-seed.test.ts > seeds a large fixture';
const allowed = {
  [listed]: 'Seeds three hundred fixture rows in one setup batch; no production write is involved.',
};

describe('statement budget trip-site inventory', () => {
  it('lists no production path: every entry is a test file site with a reason', () => {
    for (const [site, reason] of Object.entries(statementBudgetTripSites)) {
      expect(site).toMatch(/\.test\.ts > /);
      expect(site).not.toMatch(/^[^/]+\/src\/(?!.*\.test\.ts)/);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it('accepts a listed site and rejects any other test, even in the same file', () => {
    expect(() => checkStatementBudgetTrip(listed, allowed)).not.toThrow();
    expect(() => checkStatementBudgetTrip(`${listed} again`, allowed)).toThrow(
      'unlisted statement-budget trip',
    );
  });
});

describe('statement budget trip reporter', () => {
  it('fails on a new site that tripped the guard', () => {
    const reporter = createStatementBudgetTripReporter({});
    const site = 'db-sqlite/src/repositories/new-writer.test.ts > writes a large batch';
    expect(() => reporter.onTestCaseResult?.(event(site, 'failed', [201]))).toThrow(
      'unlisted statement-budget trip',
    );
  });

  it('detects the trip even when the repository replaced the DbError with a conflict', () => {
    const reporter = createStatementBudgetTripReporter({});
    const site = 'db-sqlite/src/repositories/new-writer.test.ts > writes a large batch';
    expect(() => reporter.onTestCaseResult?.(event(site, 'failed', [350, 201]))).toThrow(
      'unlisted statement-budget trip',
    );
  });

  it('ignores failures without a trip and passing tests that assert the rejection', () => {
    const reporter = createStatementBudgetTripReporter({});
    const site = 'db-sqlite/src/repositories/new-writer.test.ts > writes a large batch';
    expect(() => reporter.onTestCaseResult?.(event(site, 'failed', []))).not.toThrow();
    expect(() => reporter.onTestCaseResult?.(event(site, 'passed', [201]))).not.toThrow();
  });

  it('tolerates a listed failing site and rejects it once it passes', () => {
    const reporter = createStatementBudgetTripReporter(allowed);
    expect(() => reporter.onTestCaseResult?.(event(listed, 'failed', [300]))).not.toThrow();
    expect(() => reporter.onTestCaseResult?.(event(listed, 'passed', []))).toThrow(
      'stale statement-budget trip',
    );
  });
});
