import { describe, expect, it } from 'vitest';
import type { LoginPlan } from './users.js';

type WithoutAutoJoin = Omit<LoginPlan, 'autoJoin'>;

describe('LoginPlan', () => {
  it('requires autoJoin', () => {
    // @ts-expect-error a plan without autoJoin is not a LoginPlan
    const plan: LoginPlan = {} as WithoutAutoJoin;
    expect(plan).toBeDefined();
  });
});
