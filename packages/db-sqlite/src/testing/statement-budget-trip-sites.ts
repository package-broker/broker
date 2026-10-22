import type { Reporter, TestCase } from 'vitest/node';

/**
 * Failing tests that legitimately exceed the per-batch statement budget. Production paths never belong here;
 * an entry may only name a test that seeds fixture rows in bulk, and must say why.
 */
export const statementBudgetTripSites: Readonly<Record<string, string>> = {};

export function checkStatementBudgetTrip(
  site: string,
  allowed: Readonly<Record<string, string>> = statementBudgetTripSites,
): void {
  if (!Object.hasOwn(allowed, site)) {
    throw new Error(`unlisted statement-budget trip: ${site}`);
  }
}

export function createStatementBudgetTripReporter(
  allowed: Readonly<Record<string, string>>,
): Reporter {
  return {
    onTestCaseResult(test: TestCase): void {
      const site = `${test.project.name}/${test.module.relativeModuleId} > ${test.fullName}`;
      const state = test.result().state;
      if (state === 'passed' && Object.hasOwn(allowed, site)) {
        throw new Error(`stale statement-budget trip: ${site}`);
      }
      if (state !== 'failed') return;
      const counts = (test.meta() as { statementBudgetTrips?: unknown }).statementBudgetTrips;
      if (!Array.isArray(counts) || counts.length === 0) return;
      checkStatementBudgetTrip(site, allowed);
      process.stderr.write(`Known statement-budget trip (${counts.join(', ')}): ${site}\n`);
    },
  };
}

export default class StatementBudgetTripReporter implements Reporter {
  private readonly delegate = createStatementBudgetTripReporter(statementBudgetTripSites);

  onTestCaseResult(test: TestCase): void {
    this.delegate.onTestCaseResult?.(test);
  }
}
