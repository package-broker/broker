import { describe, expect, it, vi } from 'vitest';
import { catalogueEntry } from '../../test-support/registry-policy-catalogue.js';
import { policyHttp } from '../../test-support/policy-registry-http.js';

const computed = vi.hoisted(() => ({ forms: [] as string[] }));

vi.mock('../conditional.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../conditional.js')>();
  return {
    ...actual,
    representationValidator: async (...args: Parameters<typeof actual.representationValidator>) => {
      computed.forms.push(args[1]);
      return actual.representationValidator(...args);
    },
  };
});

describe('governed npm representation validators', () => {
  it('only a packument computes the representation validator its entity tag extends', async () => {
    const http = policyHttp({ entries: [catalogueEntry(3)] });
    computed.forms.length = 0;
    expect((await http.npmGet('/left-pad/1.0.1')).status).toBe(200);
    expect((await http.npmGet('/left-pad/-/left-pad-1.0.1.tgz')).status).toBe(200);
    expect(computed.forms).toEqual([]);
    expect((await http.npmGet('/left-pad')).status).toBe(200);
    expect(computed.forms).toEqual(['npm-full']);
  });
});
