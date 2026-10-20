import { describe, expect, it } from 'vitest';
import { checkCompleteness } from './inventory.js';

const sources = {
  'fixture.ts': 'export function createFixture(): Repository { return repository; }',
};
const key = 'fixture.ts#createFixture';

describe('deferred owner lifecycle', () => {
  for (const status of ['done', 'superseded'] as const) {
    it(`rejects a ${status} packet even with a well formed reason`, () => {
      expect(
        checkCompleteness(
          sources,
          [],
          { [key]: 'DEFERRED: needs a foreign child case; owner T123' },
          { T123: status },
        ),
      ).toEqual([`${key} deferred owner T123 is ${status}; an open packet is required`]);
    });
  }
  it('rejects the completed T782n owner', () => {
    expect(
      checkCompleteness(sources, [], {
        [key]: 'DEFERRED: needs a foreign child case; owner T782n follow-up',
      }),
    ).toEqual([`${key} deferred owner T782n is done; an open packet is required`]);
  });
  it('requires an explicitly open packet and rejects unknown owners', () => {
    const allowlist = { [key]: 'DEFERRED: needs a foreign child case; owner T123' };
    expect(checkCompleteness(sources, [], allowlist, { T123: 'open' })).toEqual([]);
    expect(checkCompleteness(sources, [], allowlist)).toEqual([
      `${key} deferred owner T123 is unknown; an open packet is required`,
    ]);
  });
  it('accepts a reasoned helper exemption and rejects an empty one', () => {
    expect(
      checkCompleteness(sources, [], { [key]: 'NOT_A_MUTATION: wraps supplied SQL unchanged.' }),
    ).toEqual([]);
    expect(checkCompleteness(sources, [], { [key]: 'NOT_A_MUTATION:' })).toHaveLength(1);
  });
});
