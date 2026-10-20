import type { SqlExecutor } from '@package-broker/core/db/port';
import type { CaseContext, ContractCase, MutationEntry } from './harness.js';
import { NOT_NULL } from './fixtures.js';

export function executing(context: CaseContext): SqlExecutor {
  return {
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  };
}

export function factoryEntry(
  file: string,
  builder: string,
  contractCase: ContractCase,
  locate: RegExp,
  waivers: MutationEntry['waivers'] = [],
  neutral = NOT_NULL,
  copies = 1,
): MutationEntry {
  return {
    file: `repositories/${file}.ts`,
    builder,
    cases: [contractCase],
    predicates: [{ name: contractCase.name, caseName: contractCase.name, locate, neutral, copies }],
    waivers,
  };
}

export const winnerWaivers: NonNullable<MutationEntry['waivers']> = [
  {
    locate: /"?guard_\w+"?\."?org_id"? = /,
    reason:
      'Delegated catalogue-predicates guards have independent foreign attachment, source, project, shadow and pattern registrations.',
  },
  {
    locate: /"?(?:pkg|src|ps|bp|bpp|bs|bps)"?\."?org_id"? = /,
    reason:
      'visibleWinner and catalogue-predicates registrations cover the delegated package, source, attachment and competing-winner scopes.',
  },
];
