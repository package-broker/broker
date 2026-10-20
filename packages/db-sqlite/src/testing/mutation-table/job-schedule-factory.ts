import { expect } from 'vitest';
import { createJobScheduleRepository } from '../../repositories/job-schedule.js';

import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { FUTURE } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignRow: ContractCase = {
  name: 'schedule disabling preserves a foreign schedule',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO job_schedule (org_id, name, every_seconds, next_run_at) VALUES (?, 'test:tick:v1', 60, ?)",
      foreign.orgId,
      FUTURE,
    );
    await createJobScheduleRepository(executing(context)).disable(own, 'test:tick:v1');
    expect(
      await context.executor.all({
        sql: "SELECT enabled FROM job_schedule WHERE name = 'test:tick:v1'",
        params: [],
      }),
    ).toEqual([{ enabled: 1 }]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('job-schedule', 'createJobScheduleRepository', foreignRow, /org_id = \?/),
];
