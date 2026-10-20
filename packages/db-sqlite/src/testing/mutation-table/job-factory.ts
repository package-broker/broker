import { expect } from 'vitest';
import { createJobRepository } from '../../repositories/job.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignAttempt: ContractCase = {
  name: 'job status excludes a foreign attempt child of an own job',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO job (id, org_id, type, idempotency_key) VALUES ('J', ?, 'test:job', 'key')",
      own.orgId,
    );
    await seed(
      "INSERT INTO job_attempt (id, org_id, job_id, attempt, fence, worker, started_at, outcome) VALUES ('A', ?, 'J', 1, 1, 'worker', '2000-01-01T00:00:00.000Z', 'succeeded')",
      foreign.orgId,
    );
    expect(await createJobRepository(executing(context)).status(own, 'J')).toMatchObject({
      history: [],
    });
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry(
    'job',
    'createJobRepository',
    foreignAttempt,
    /(?<=FROM job_attempt\s+WHERE )org_id = \?/,
    [
      {
        locate: /(?<=FROM job WHERE )org_id = \?/,
        reason:
          'This case supplies an own parent control and mutates only the foreign attempt child scope.',
      },
    ],
  ),
];
